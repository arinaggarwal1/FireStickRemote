import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { randomUUID } from "crypto";

import { getAdbKeycodeForAction } from "../utils/firetvActions.js";
import { getAdbTargetHost } from "../utils/hostNormalization.js";
import { createTransportError } from "../utils/transportErrors.js";

const LEANBACK_LAUNCHER_PACKAGES = new Set(["com.amazon.firebat"]);
const PACKAGE_NAME_PATTERN = /[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g;
const SHELL_COMMAND_TIMEOUT_MS = 6000;

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function getLauncherCategory(packageName) {
  return LEANBACK_LAUNCHER_PACKAGES.has(packageName)
    ? "android.intent.category.LEANBACK_LAUNCHER"
    : "android.intent.category.LAUNCHER";
}

function extractPackagesFromOutput(output) {
  const found = new Set();

  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("package:")) {
      found.add(line.replace(/^package:/, "").trim());
      continue;
    }

    const packageNameMatch = line.match(/packageName=([A-Za-z][A-Za-z0-9_.]+)/);
    if (packageNameMatch) {
      found.add(packageNameMatch[1]);
      continue;
    }

    const componentMatch = line.match(/([A-Za-z][A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/);
    if (componentMatch) {
      found.add(componentMatch[1]);
      continue;
    }

    const packageLikeMatches = line.match(PACKAGE_NAME_PATTERN) || [];
    for (const match of packageLikeMatches) {
      if (match.startsWith("android.") || match.includes("intent.") || match.endsWith(".permission")) {
        continue;
      }
      found.add(match);
    }
  }

  return [...found];
}

export class AdbTransport {
  constructor({ logger = console } = {}) {
    this.shellSessions = new Map();
    this.logger = logger;
  }

  getAdbCandidates() {
    const candidates = [];
    const fromEnv = process.env.ADB_PATH && process.env.ADB_PATH.trim();
    const homeDir = process.env.HOME || "";
    const sdkRoots = [
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      homeDir ? path.join(homeDir, "Library", "Android", "sdk") : "",
    ].filter(Boolean);

    if (fromEnv) candidates.push(fromEnv);
    sdkRoots.forEach((sdkRoot) => {
      candidates.push(path.join(sdkRoot, "platform-tools", "adb"));
    });
    candidates.push("/opt/homebrew/bin/adb", "/usr/local/bin/adb", "/usr/bin/adb", "adb");
    return [...new Set(candidates)];
  }

  resolveAdbBinary() {
    for (const candidate of this.getAdbCandidates()) {
      if (candidate === "adb") return candidate;
      if (fs.existsSync(candidate)) return candidate;
    }
    return "adb";
  }

  getAvailability() {
    const adbBin = this.resolveAdbBinary();
    const adbAvailable = adbBin === "adb" || fs.existsSync(adbBin);
    return {
      adbAvailable,
      adbBinary: adbBin,
    };
  }

  runAdb(args, onData) {
    return new Promise((resolve) => {
      const adbBin = this.resolveAdbBinary();
      let proc;
      try {
        proc = spawn(adbBin, args);
      } catch (error) {
        resolve({ code: 127, stdout: "", stderr: String(error?.message || error) });
        return;
      }

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (onData) onData(text);
      });
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (error) => {
        stderr += error?.message || String(error);
      });
      proc.on("close", (code) => {
        resolve({ code, stdout, stderr });
      });
    });
  }

  runTargetedAdb(host, args) {
    return this.runAdb(["-s", getAdbTargetHost(host), ...args]);
  }

  getOrCreateShellSession(host) {
    const adbHost = getAdbTargetHost(host);
    const existing = this.shellSessions.get(adbHost);
    if (existing && !existing.closed) return existing;

    const adbBin = this.resolveAdbBinary();
    const proc = spawn(adbBin, ["-s", adbHost, "shell"]);
    const session = {
      host: adbHost,
      proc,
      queue: [],
      current: null,
      idleBuffer: "",
      closed: false,
    };

    const settleCurrentCommand = () => {
      const current = session.current;
      if (!current) return;

      const markerPattern = new RegExp(`${current.marker}(\\d+)`);
      const match = markerPattern.exec(current.stdout);
      if (!match) return;

      const markerIndex = match.index;
      const markerEnd = markerIndex + match[0].length;
      const beforeMarker = current.stdout.slice(0, markerIndex).replace(/\r?\n$/, "");
      const afterMarker = current.stdout.slice(markerEnd).replace(/^\r?\n/, "");
      const exitCode = Number(match[1]);

      clearTimeout(current.timer);
      session.current = null;
      session.idleBuffer = afterMarker;
      current.resolve({
        code: Number.isFinite(exitCode) ? exitCode : 1,
        stdout: beforeMarker,
        stderr: current.stderr,
      });
      this.dispatchShellCommand(session);
    };

    const closeSession = (errorMessage) => {
      if (session.closed) return;
      session.closed = true;
      this.shellSessions.delete(adbHost);

      const current = session.current;
      session.current = null;
      if (current) {
        clearTimeout(current.timer);
        current.reject(new Error(errorMessage || "Persistent ADB shell closed unexpectedly."));
      }

      while (session.queue.length > 0) {
        const queued = session.queue.shift();
        queued.reject(new Error(errorMessage || "Persistent ADB shell closed unexpectedly."));
      }
    };

    proc.stdout.on("data", (chunk) => {
      if (!session.current) {
        session.idleBuffer += chunk.toString();
        return;
      }

      session.current.stdout += chunk.toString();
      settleCurrentCommand();
    });

    proc.stderr.on("data", (chunk) => {
      if (!session.current) return;
      session.current.stderr += chunk.toString();
    });

    proc.on("error", (error) => {
      closeSession(error?.message || "Persistent ADB shell failed.");
    });

    proc.on("close", (code, signal) => {
      closeSession(`Persistent ADB shell closed (code: ${code ?? "null"}, signal: ${signal ?? "none"}).`);
    });

    this.shellSessions.set(adbHost, session);
    return session;
  }

  dispatchShellCommand(session) {
    if (session.closed || session.current || session.queue.length === 0) return;

    const next = session.queue.shift();
    session.current = {
      ...next,
      stdout: session.idleBuffer,
      stderr: "",
      timer: setTimeout(() => {
        const current = session.current;
        if (!current || current.marker !== next.marker) return;

        session.current = null;
        current.reject(new Error("Persistent ADB shell command timed out."));
        try {
          session.proc.kill("SIGTERM");
        } catch (_) {}
      }, SHELL_COMMAND_TIMEOUT_MS),
    };
    session.idleBuffer = "";

    const shellLine = `${next.command}; echo ${next.marker}$?\n`;
    session.proc.stdin.write(shellLine, (error) => {
      if (!error) return;

      const current = session.current;
      session.current = null;
      if (current) clearTimeout(current.timer);
      current?.reject(error);
      this.dispatchShellCommand(session);
    });
  }

  runPersistentShellCommand(host, command) {
    const session = this.getOrCreateShellSession(host);

    return new Promise((resolve, reject) => {
      session.queue.push({
        command,
        marker: `__FTRM_${randomUUID()}__`,
        resolve,
        reject,
      });
      this.dispatchShellCommand(session);
    });
  }

  async closeShellSession(deviceOrHost) {
    const adbHost = getAdbTargetHost(typeof deviceOrHost === "string" ? deviceOrHost : deviceOrHost?.host);
    const session = this.shellSessions.get(adbHost);
    if (!session) return;

    this.shellSessions.delete(adbHost);
    session.closed = true;
    session.proc.kill("SIGTERM");
  }

  async closeAllShellSessions() {
    const hosts = [...this.shellSessions.keys()];
    await Promise.all(hosts.map((host) => this.closeShellSession(host)));
  }

  async probe(device) {
    const { adbAvailable, adbBinary } = this.getAvailability();

    if (!adbAvailable) {
      return { adbAvailable: false, adbConnected: false, adbHost: getAdbTargetHost(device.host) };
    }

    const devicesResult = await this.runAdb(["devices"]);
    const adbHost = getAdbTargetHost(device.host);
    const lines = `${devicesResult.stdout || ""}\n${devicesResult.stderr || ""}`.split(/\r?\n/);
    const adbConnected = lines.some((line) => line.trim().startsWith(`${adbHost}\tdevice`));

    return {
      adbAvailable: true,
      adbConnected,
      adbHost,
      adbBinary,
      devicesResult,
    };
  }

  async connect(device) {
    const adbHost = getAdbTargetHost(device.host);
    const result = await this.runAdb(["connect", adbHost]);
    const output = `${result.stdout || ""} ${result.stderr || ""}`;
    const ok = result.code === 0 && /connected to|already connected/i.test(output);
    return {
      ok,
      transportUsed: "adb",
      adbHost,
      result,
    };
  }

  async disconnect(device) {
    if (device?.host) {
      await this.closeShellSession(device.host);
      const adbHost = getAdbTargetHost(device.host);
      const result = await this.runAdb(["disconnect", adbHost]);
      return { ok: result.code === 0, transportUsed: "adb", adbHost, result };
    }

    await this.closeAllShellSessions();
    const result = await this.runAdb(["disconnect"]);
    return { ok: result.code === 0, transportUsed: "adb", adbHost: null, result };
  }

  async repair(device) {
    const adbHost = device?.host ? getAdbTargetHost(device.host) : null;
    await this.closeAllShellSessions();

    const disconnectResult = adbHost
      ? await this.runAdb(["disconnect", adbHost])
      : { code: 0, stdout: "", stderr: "" };
    const killResult = await this.runAdb(["kill-server"]);
    const startResult = await this.runAdb(["start-server"]);
    const devicesResult = await this.runAdb(["devices"]);

    const ok = [disconnectResult, killResult, startResult, devicesResult].every((result) => result.code === 0);

    return {
      ok,
      transportUsed: "adb",
      adbHost,
      details: {
        disconnect: disconnectResult,
        killServer: killResult,
        startServer: startResult,
        devices: devicesResult,
      },
    };
  }

  async sendRemoteAction(device, action) {
    const keycode = getAdbKeycodeForAction(action);
    if (keycode == null) {
      throw createTransportError("UNSUPPORTED_ACTION", `ADB does not support remote action "${action}".`, { status: 400 });
    }

    const result = await this.runPersistentShellCommand(device.host, `input keyevent ${String(keycode)}`);
    if (result.code !== 0) {
      throw createTransportError("ADB_REMOTE_FAILED", result.stderr || result.stdout || "ADB remote command failed.", {
        details: result,
      });
    }

    return { ok: true, transportUsed: "adb", result };
  }

  async sendText(device, text) {
    const encoded = String(text || "").replace(/\r?\n/g, " ").replace(/ /g, "%s");
    const result = await this.runPersistentShellCommand(device.host, `input text ${shellEscape(encoded)}`);
    if (result.code !== 0) {
      throw createTransportError("ADB_TEXT_FAILED", result.stderr || result.stdout || "ADB text input failed.", {
        details: result,
      });
    }

    return { ok: true, transportUsed: "adb", result };
  }

  async listApps(device) {
    const discovered = new Set();
    const errors = [];

    const commands = [
      ["shell", "pm", "list", "packages", "-3"],
      ["shell", "cmd", "package", "query-intent-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LEANBACK_LAUNCHER"],
      ["shell", "cmd", "package", "query-intent-activities", "-a", "android.intent.action.MAIN", "-c", "android.intent.category.LAUNCHER"],
    ];

    for (const command of commands) {
      const result = await this.runTargetedAdb(device.host, command);
      if (result.code !== 0) {
        errors.push(result.stderr || result.stdout || "Unknown ADB error");
        continue;
      }

      for (const pkg of extractPackagesFromOutput(result.stdout)) {
        discovered.add(pkg);
      }
    }

    if (discovered.size === 0) {
      const fallbackResult = await this.runTargetedAdb(device.host, ["shell", "pm", "list", "packages"]);
      if (fallbackResult.code === 0) {
        for (const pkg of extractPackagesFromOutput(fallbackResult.stdout)) {
          discovered.add(pkg);
        }
      } else {
        errors.push(fallbackResult.stderr || fallbackResult.stdout || "Unknown ADB error");
      }
    }

    if (discovered.size === 0 && errors.length > 0) {
      throw createTransportError("ADB_APPS_FAILED", errors.join(" | "), { details: errors });
    }

    return [...discovered]
      .sort((a, b) => a.localeCompare(b))
      .map((pkg) => ({
        id: pkg,
        name: pkg,
        sourceTransport: "adb",
      }));
  }

  async launchApp(device, appId) {
    const primaryCategory = getLauncherCategory(appId);
    let result = await this.runPersistentShellCommand(
      device.host,
      `monkey -p ${shellEscape(appId)} -c ${shellEscape(primaryCategory)} 1`,
    );

    if (result.code !== 0 && primaryCategory !== "android.intent.category.LEANBACK_LAUNCHER") {
      result = await this.runPersistentShellCommand(
        device.host,
        `monkey -p ${shellEscape(appId)} -c 'android.intent.category.LEANBACK_LAUNCHER' 1`,
      );
    }

    if (result.code !== 0) {
      throw createTransportError("ADB_APP_LAUNCH_FAILED", result.stderr || result.stdout || "ADB app launch failed.", {
        details: result,
      });
    }

    return { ok: true, transportUsed: "adb", result };
  }

  async installApk(device, filePath, replaceExisting) {
    const installArgs = replaceExisting ? ["install", "-r", filePath] : ["install", filePath];
    const result = await this.runTargetedAdb(device.host, installArgs);
    const output = `${result.stdout || ""} ${result.stderr || ""}`;
    if (result.code !== 0 || /Failure/i.test(output)) {
      throw createTransportError("ADB_INSTALL_FAILED", result.stderr || result.stdout || "ADB APK install failed.", {
        details: result,
      });
    }

    return { ok: true, transportUsed: "adb", result };
  }

  async swipe(device, gesture) {
    const { x1, y1, x2, y2, durationMs } = gesture;
    const duration = typeof durationMs === "number" ? durationMs : 150;
    const result = await this.runPersistentShellCommand(
      device.host,
      `input swipe ${String(x1)} ${String(y1)} ${String(x2)} ${String(y2)} ${String(duration)}`,
    );

    if (result.code !== 0) {
      throw createTransportError("ADB_SWIPE_FAILED", result.stderr || result.stdout || "ADB swipe failed.", {
        details: result,
      });
    }

    return { ok: true, transportUsed: "adb", result };
  }
}

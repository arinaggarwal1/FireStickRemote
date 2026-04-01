import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import yaml from "js-yaml";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 9090);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(process.cwd(), "data");
const DEVICES_FILE = path.resolve(DATA_DIR, "devices.json");
const LEGACY_CONFIG_FILE = path.resolve(process.cwd(), "config.yml");
const LEANBACK_LAUNCHER_PACKAGES = new Set(["com.amazon.firebat"]);
const PACKAGE_NAME_PATTERN = /[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+/g;

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public"), {
  etag: false,
  lastModified: false,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  },
}));

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeHost(host) {
  const raw = String(host || "").trim();
  if (!raw) return "";
  return raw.includes(":") ? raw : `${raw}:5555`;
}

function sanitizeDevice(device) {
  const host = normalizeHost(device && device.host);
  const name = String((device && device.name) || "").trim();

  if (!host || !name) return null;

  return {
    id: String((device && device.id) || randomUUID()),
    name,
    host,
  };
}

function readLegacyDevices() {
  try {
    const raw = fs.readFileSync(LEGACY_CONFIG_FILE, "utf8");
    const parsed = yaml.load(raw);
    const devices = Array.isArray(parsed && parsed.devices) ? parsed.devices : [];

    return devices
      .map((device) =>
        sanitizeDevice({
          id: randomUUID(),
          name: device.name,
          host: `${device.host}:${device.port || 5555}`,
        }),
      )
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function writeDevices(devices) {
  ensureDataDir();
  fs.writeFileSync(DEVICES_FILE, JSON.stringify({ devices }, null, 2));
}

function readDevices() {
  ensureDataDir();

  try {
    const raw = fs.readFileSync(DEVICES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    const devices = Array.isArray(parsed) ? parsed : parsed.devices;
    return Array.isArray(devices) ? devices.map(sanitizeDevice).filter(Boolean) : [];
  } catch (e) {
    const seededDevices = readLegacyDevices();
    if (seededDevices.length > 0) {
      writeDevices(seededDevices);
    }
    return seededDevices;
  }
}

function validateDevicePayload(body) {
  const name = String((body && body.name) || "").trim();
  const host = normalizeHost(body && body.host);

  if (!name || !host) return null;

  return { name, host };
}

function getTargetHost(body) {
  return normalizeHost(body && body.host);
}

function getAdbCandidates() {
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

  candidates.push(
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    "/usr/bin/adb",
    "adb",
  );

  return [...new Set(candidates)];
}

function resolveAdbBinary() {
  for (const candidate of getAdbCandidates()) {
    if (candidate === "adb") return candidate;
    if (fs.existsSync(candidate)) return candidate;
  }

  return "adb";
}

function runAdb(args, onData) {
  return new Promise((resolve) => {
    const adbBin = resolveAdbBinary();
    let proc;
    try {
      proc = spawn(adbBin, args);
    } catch (err) {
      return resolve({ code: 127, stdout: "", stderr: String(err && err.message || err) });
    }
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      if (onData) onData(s);
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("error", (e) => {
      // Commonly ENOENT when adb is not found
      stderr += (e && e.message) || String(e);
    });
    proc.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runTargetedAdb(host, args) {
  return runAdb(["-s", host, ...args]);
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
      if (
        match.startsWith("android.") ||
        match.includes("intent.") ||
        match.endsWith(".permission")
      ) {
        continue;
      }
      found.add(match);
    }
  }

  return [...found];
}

async function discoverInstalledPackages(host) {
  const discovered = new Set();
  const errors = [];

  const commands = [
    ["shell", "pm", "list", "packages", "-3"],
    [
      "shell",
      "cmd",
      "package",
      "query-intent-activities",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LEANBACK_LAUNCHER",
    ],
    [
      "shell",
      "cmd",
      "package",
      "query-intent-activities",
      "-a",
      "android.intent.action.MAIN",
      "-c",
      "android.intent.category.LAUNCHER",
    ],
  ];

  for (const command of commands) {
    const result = await runTargetedAdb(host, command);
    if (result.code !== 0) {
      errors.push(result.stderr || result.stdout || "Unknown ADB error");
      continue;
    }

    for (const pkg of extractPackagesFromOutput(result.stdout)) {
      discovered.add(pkg);
    }
  }

  if (discovered.size > 0) {
    return { packages: [...discovered].sort((a, b) => a.localeCompare(b)), error: null };
  }

  const fallbackResult = await runTargetedAdb(host, ["shell", "pm", "list", "packages"]);
  if (fallbackResult.code === 0) {
    for (const pkg of extractPackagesFromOutput(fallbackResult.stdout)) {
      discovered.add(pkg);
    }
  } else {
    errors.push(fallbackResult.stderr || fallbackResult.stdout || "Unknown ADB error");
  }

  return {
    packages: [...discovered].sort((a, b) => a.localeCompare(b)),
    error: errors.filter(Boolean).join(" | ") || null,
  };
}

app.get("/api/devices", (req, res) => {
  res.json({ devices: readDevices() });
});

app.post("/api/devices", (req, res) => {
  const payload = validateDevicePayload(req.body);
  if (!payload) {
    return res.status(400).json({ error: "name and host are required" });
  }

  const devices = readDevices();
  const device = {
    id: randomUUID(),
    ...payload,
  };

  devices.push(device);
  writeDevices(devices);

  res.status(201).json({ device });
});

app.put("/api/devices/:id", (req, res) => {
  const payload = validateDevicePayload(req.body);
  if (!payload) {
    return res.status(400).json({ error: "name and host are required" });
  }

  const devices = readDevices();
  const index = devices.findIndex((device) => device.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Device not found" });
  }

  const updatedDevice = {
    ...devices[index],
    ...payload,
  };

  devices[index] = updatedDevice;
  writeDevices(devices);

  res.json({ device: updatedDevice });
});

app.delete("/api/devices/:id", (req, res) => {
  const devices = readDevices();
  const nextDevices = devices.filter((device) => device.id !== req.params.id);

  if (nextDevices.length === devices.length) {
    return res.status(404).json({ error: "Device not found" });
  }

  writeDevices(nextDevices);
  res.json({ deleted: true });
});

app.get("/api/apps", async (req, res) => {
  const host = normalizeHost(req.query.host);
  if (!host) {
    return res.status(400).json({ error: "host is required" });
  }

  const { packages, error } = await discoverInstalledPackages(host);
  if (packages.length === 0 && error) {
    return res.status(502).json({ error: error || "Failed to list installed apps." });
  }

  res.json({ packages });
});

app.post("/api/connect", async (req, res) => {
  const deviceHost = getTargetHost(req.body);

  if (!deviceHost) {
    return res.status(400).json({ error: "host is required" });
  }

  const result = await runAdb(["connect", deviceHost]);
  res.json({ ...result, host: deviceHost });
});

app.post("/api/disconnect", async (req, res) => {
  const deviceHost = getTargetHost(req.body);
  const result = deviceHost
    ? await runAdb(["disconnect", deviceHost])
    : await runAdb(["disconnect"]);
  res.json({ ...result, host: deviceHost || null });
});

app.post("/api/pair", async (req, res) => {
  const { host, code } = req.body || {};
  if (!host || !code) {
    return res.status(400).json({ error: "host and code are required" });
  }
  // adb pair host:port code
  const result = await runAdb(["pair", normalizeHost(host), String(code)]);
  res.json(result);
});

app.post("/api/key", async (req, res) => {
  const { code } = req.body || {};
  const host = getTargetHost(req.body);
  if (!code) return res.status(400).json({ error: "Missing key code" });
  if (!host) return res.status(400).json({ error: "host is required" });
  const result = await runTargetedAdb(host, ["shell", "input", "keyevent", String(code)]);
  res.json(result);
});

app.post("/api/text", async (req, res) => {
  const { text } = req.body || {};
  const host = getTargetHost(req.body);
  if (typeof text !== "string")
    return res.status(400).json({ error: "Missing text" });
  if (!host) return res.status(400).json({ error: "host is required" });

  const encoded = text.replace(/\r?\n/g, " ").replace(/ /g, "%s");
  const result = await runTargetedAdb(host, ["shell", "input", "text", encoded]);
  res.json(result);
});

app.post("/api/swipe", async (req, res) => {
  const { x1, y1, x2, y2, durationMs } = req.body || {};
  const host = getTargetHost(req.body);
  if ([x1, y1, x2, y2].some((v) => typeof v !== "number")) {
    return res.status(400).json({ error: "x1,y1,x2,y2 must be numbers" });
  }
  if (!host) return res.status(400).json({ error: "host is required" });
  const dur = typeof durationMs === "number" ? durationMs : 150;
  const result = await runTargetedAdb(host, [
    "shell",
    "input",
    "swipe",
    String(x1),
    String(y1),
    String(x2),
    String(y2),
    String(dur),
  ]);
  res.json(result);
});

app.post("/api/app", async (req, res) => {
  const { package: packageName } = req.body || {};
  const host = getTargetHost(req.body);
  if (!packageName) {
    return res.status(400).json({ error: "Missing package name" });
  }
  if (!host) return res.status(400).json({ error: "host is required" });
  
  const primaryCategory = getLauncherCategory(packageName);
  
  // Use adb shell monkey to launch the app
  let result = await runTargetedAdb(host, [
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    primaryCategory,
    "1"
  ]);

  if (result.code !== 0 && primaryCategory !== "android.intent.category.LEANBACK_LAUNCHER") {
    result = await runTargetedAdb(host, [
      "shell",
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LEANBACK_LAUNCHER",
      "1"
    ]);
  }
  
  res.json(result);
});

app.listen(PORT, HOST, function onListen() {
  const address = this.address();
  const resolvedPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`Server listening on http://${HOST}:${resolvedPort}`);
});

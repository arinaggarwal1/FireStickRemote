import { app, BrowserWindow, dialog, nativeImage } from "electron";
import { execFile, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const serverEntry = path.join(projectRoot, "server", "index.js");
const appIcon = path.join(projectRoot, "public", "favicon_io", "remote_icon_rounded.png");
const APP_DISPLAY_NAME = "Fire TV Remote";
const commonBinaryDirs = [
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

let mainWindow = null;
let serverProcess = null;
let serverUrl = "";
let isCleaningUp = false;
let cleanupCompleted = false;
let allowQuit = false;
let cleanupPromise = null;

app.commandLine.appendSwitch("disable-http-cache");

function logServerChunk(streamName, chunk) {
  const output = chunk.toString();
  if (!output.trim()) return;

  const lines = output.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const writer = streamName === "stderr" ? console.error : console.log;
    writer(`[firetv-server:${streamName}] ${line}`);
  }
}

app.setName(APP_DISPLAY_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_DISPLAY_NAME));

function waitForServerUrl(childProcess) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out while starting the local Fire TV server."));
    }, 15000);

    function cleanup() {
      clearTimeout(timeout);
      childProcess.stdout?.off("data", onStdout);
      childProcess.stderr?.off("data", onStderr);
      childProcess.off("exit", onExit);
      childProcess.off("error", onError);
    }

    function onStdout(chunk) {
      const output = chunk.toString();
      const match = output.match(/Server listening on (http:\/\/[^\s]+)/);
      if (!match) return;

      cleanup();
      resolve(match[1]);
    }

    function onStderr(chunk) {
      const output = chunk.toString();
      if (!output.trim()) return;
      console.error("[firetv-server]", output.trim());
    }

    function onExit(code, signal) {
      cleanup();
      reject(new Error(`Local Fire TV server exited early (code: ${code ?? "null"}, signal: ${signal ?? "none"}).`));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    childProcess.stdout?.on("data", onStdout);
    childProcess.stderr?.on("data", onStderr);
    childProcess.once("exit", onExit);
    childProcess.once("error", onError);
  });
}

function startLocalServer() {
  const runtimePath = [...new Set([...commonBinaryDirs, ...(process.env.PATH || "").split(path.delimiter).filter(Boolean)])]
    .join(path.delimiter);

  const child = spawn(process.execPath, [serverEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      APP_DATA_DIR: app.getPath("userData"),
      HOST: "127.0.0.1",
      PORT: "0",
      PATH: runtimePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProcess = child;
  child.once("exit", () => {
    if (serverProcess === child) {
      serverProcess = null;
    }
  });
  child.stdout?.on("data", (chunk) => logServerChunk("stdout", chunk));
  child.stderr?.on("data", (chunk) => logServerChunk("stderr", chunk));
  return waitForServerUrl(child);
}

function getShortcutDescriptor(input) {
  if (input.type !== "keyDown" || input.isAutoRepeat) return null;

  if (!input.meta || input.control || input.alt) return null;

  if (input.key === "ArrowLeft") return "rewind";
  if (input.key === "ArrowRight") return "fast_forward";
  if (String(input.key).toLowerCase() === "h") return "home";
  if (String(input.key).toLowerCase() === "p") return "play_pause";
  if (/^[1-9]$/.test(String(input.key))) {
    return `quick_launch_${input.key}`;
  }

  return null;
}

function wireNativeShortcuts(window) {
  window.webContents.on("before-input-event", (event, input) => {
    const descriptor = getShortcutDescriptor(input);
    if (!descriptor) return;

    event.preventDefault();
    void window.webContents.executeJavaScript(
      `window.__fireTvHandleShortcut?.(${JSON.stringify(descriptor)});`,
      true,
    ).catch((error) => {
      console.error("Failed to dispatch native shortcut to renderer:", error);
    });
  });
}

async function createMainWindow() {
  serverUrl = await startLocalServer();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    minWidth: 1180,
    minHeight: 780,
    backgroundColor: "#08121c",
    autoHideMenuBar: true,
    title: APP_DISPLAY_NAME,
    icon: appIcon,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.removeMenu();
  wireNativeShortcuts(mainWindow);
  await mainWindow.webContents.session.clearCache();
  await mainWindow.loadURL(serverUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopLocalServer() {
  if (!serverProcess || serverProcess.killed) return Promise.resolve(false);
  serverProcess.kill("SIGTERM");
  return Promise.resolve(true);
}

function resolveAdbBinary() {
  const candidates = [
    process.env.ADB_PATH,
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    "/usr/bin/adb",
    "adb",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "adb") return candidate;
    try {
      if (candidate && path.isAbsolute(candidate)) {
        return candidate;
      }
    } catch (_) {}
  }

  return "adb";
}

function execAsync(command, args = [], options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: options.timeout ?? 4000,
      windowsHide: true,
      env: options.env ?? process.env,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
    }, (error, stdout = "", stderr = "") => {
      resolve({
        ok: !error,
        code: typeof error?.code === "number" ? error.code : 0,
        error,
        stdout: String(stdout || ""),
        stderr: String(stderr || error?.message || ""),
      });
    });
  });
}

async function waitForChildExit(childProcess, timeoutMs = 4000) {
  if (!childProcess) return true;
  if (childProcess.exitCode != null || childProcess.killed) return true;

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    childProcess.once("exit", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function requestServerShutdown(timeoutMs = 4500) {
  if (!serverUrl) {
    return { ok: false, skipped: true, reason: "missing_server_url" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(new URL("/api/internal/shutdown", serverUrl), {
      method: "POST",
      signal: controller.signal,
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function disconnectAdbFallback() {
  const adbBinary = resolveAdbBinary();
  const devicesResult = await execAsync(adbBinary, ["devices"]);
  const deviceLines = `${devicesResult.stdout}\n${devicesResult.stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\t(?:device|offline|unauthorized)$/.test(line));
  const hosts = deviceLines.map((line) => line.split("\t")[0]).filter(Boolean);

  const disconnectResults = [];
  for (const host of hosts) {
    disconnectResults.push({ host, ...(await execAsync(adbBinary, ["disconnect", host])) });
  }

  const disconnectAllResult = await execAsync(adbBinary, ["disconnect"]);
  const killServerResult = await execAsync(adbBinary, ["kill-server"]);

  console.log("[electron] ADB fallback cleanup complete.", {
    hostsDisconnected: hosts.length,
    disconnectResults: disconnectResults.map((result) => ({
      host: result.host,
      ok: result.ok,
      code: result.code,
    })),
    disconnectAllOk: disconnectAllResult.ok,
    killServerOk: killServerResult.ok,
  });
}

async function cleanupAndExit(reason = "unknown") {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  isCleaningUp = true;
  cleanupPromise = (async () => {
    console.log("[electron] Starting cleanup before exit.", {
      reason,
      serverRunning: Boolean(serverProcess),
    });

    try {
      const shutdownResult = await requestServerShutdown();
      console.log("[electron] Requested local server shutdown.", shutdownResult);
    } catch (error) {
      console.error("[electron] Failed to request local server shutdown:", error);
    }

    try {
      let exited = await waitForChildExit(serverProcess, 5000);
      if (!exited && serverProcess) {
        console.warn("[electron] Local server did not exit after shutdown request; sending SIGTERM.");
        await stopLocalServer();
        exited = await waitForChildExit(serverProcess, 2500);
      }

      if (!exited && serverProcess) {
        console.warn("[electron] Local server still alive after SIGTERM; sending SIGKILL.");
        serverProcess.kill("SIGKILL");
        await waitForChildExit(serverProcess, 1000);
      }
    } catch (error) {
      console.error("[electron] Error while stopping local server process:", error);
    }

    try {
      await disconnectAdbFallback();
    } catch (error) {
      console.error("[electron] Error while running fallback ADB cleanup:", error);
    }

    cleanupCompleted = true;
    console.log("[electron] Cleanup complete.");
  })().finally(() => {
    isCleaningUp = false;
  });

  return cleanupPromise;
}

app.whenReady().then(async () => {
  try {
    if (process.platform === "darwin") {
      const dockIcon = nativeImage.createFromPath(appIcon);
      if (!dockIcon.isEmpty()) {
        app.dock.setIcon(dockIcon);
      }
    }

    await createMainWindow();
  } catch (error) {
    console.error(error);
    await dialog.showErrorBox(APP_DISPLAY_NAME, String(error?.message || error));
    allowQuit = true;
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (allowQuit || cleanupCompleted) return;

  event.preventDefault();
  if (isCleaningUp) return;

  void cleanupAndExit("before-quit").finally(() => {
    allowQuit = true;
    app.quit();
  });
});

app.on("will-quit", () => {
  if (!cleanupCompleted && !isCleaningUp) {
    void cleanupAndExit("will-quit");
  }
});

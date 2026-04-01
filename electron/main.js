import { app, BrowserWindow, dialog, nativeImage } from "electron";
import { spawn } from "child_process";
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
let shuttingDown = false;

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
  return waitForServerUrl(child);
}

async function createMainWindow() {
  const serverUrl = await startLocalServer();

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
  await mainWindow.loadURL(serverUrl);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function stopLocalServer() {
  if (!serverProcess || serverProcess.killed) return;

  shuttingDown = true;
  serverProcess.kill("SIGTERM");
  setTimeout(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill("SIGKILL");
    }
  }, 2500).unref();
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
    app.quit();
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0 && !mainWindow) {
      await createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  stopLocalServer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (shuttingDown) return;
  stopLocalServer();
});

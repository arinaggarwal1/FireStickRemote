import express from "express";
import cors from "cors";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import yaml from "js-yaml";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 9090;
const CONFIG_FILE = path.resolve(process.cwd(), "config.yml");

app.use(cors());
app.use(express.json());
app.use(express.static(path.resolve(process.cwd(), "public")));

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, "utf8");
    return yaml.load(raw);
  } catch (e) {
    return { devices: [] };
  }
}

function getDefaultDevice() {
  const config = readConfig();
  if (!config.devices) return null;
  return config.devices.find(d => d.default) || config.devices[0];
}

function resolveAdbBinary() {
  const fromEnv = process.env.ADB_PATH && process.env.ADB_PATH.trim();
  if (fromEnv) return fromEnv;
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

app.get("/api/config", (req, res) => {
  res.json(readConfig());
});

app.post("/api/connect", async (req, res) => {
  const { deviceIndex, manualHost } = req.body || {};
  
  let deviceHost;
  
  if (manualHost) {
    // Manual host input
    deviceHost = manualHost;
  } else {
    // Use configured device
    const config = readConfig();
    const device = config.devices && config.devices[deviceIndex] || getDefaultDevice();
    
    if (!device) {
      return res.status(400).json({ error: "No device configured" });
    }
    
    deviceHost = `${device.host}:${device.port}`;
  }
  
  const result = await runAdb(["connect", deviceHost]);
  res.json(result);
});

app.post("/api/disconnect", async (req, res) => {
  const result = await runAdb(["disconnect"]);
  res.json(result);
});

app.post("/api/pair", async (req, res) => {
  const { host, code } = req.body || {};
  if (!host || !code) {
    return res.status(400).json({ error: "host and code are required" });
  }
  // adb pair host:port code
  const result = await runAdb(["pair", host, String(code)]);
  res.json(result);
});

app.post("/api/key", async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: "Missing key code" });
  const result = await runAdb(["shell", "input", "keyevent", String(code)]);
  res.json(result);
});

app.post("/api/text", async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== "string")
    return res.status(400).json({ error: "Missing text" });
  const encoded = text.replace(/ /g, "%s");
  const result = await runAdb(["shell", "input", "text", encoded]);
  res.json(result);
});

app.post("/api/swipe", async (req, res) => {
  const { x1, y1, x2, y2, durationMs } = req.body || {};
  if ([x1, y1, x2, y2].some((v) => typeof v !== "number")) {
    return res.status(400).json({ error: "x1,y1,x2,y2 must be numbers" });
  }
  const dur = typeof durationMs === "number" ? durationMs : 150;
  const result = await runAdb([
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
  const { app, package: packageName } = req.body || {};
  if (!packageName) {
    return res.status(400).json({ error: "Missing package name" });
  }
  
  // Some Fire TV apps require LEANBACK_LAUNCHER instead of LAUNCHER
  const category = app === "prime" 
    ? "android.intent.category.LEANBACK_LAUNCHER" 
    : "android.intent.category.LAUNCHER";
  
  // Use adb shell monkey to launch the app
  const result = await runAdb([
    "shell",
    "monkey",
    "-p",
    packageName,
    "-c",
    category,
    "1"
  ]);
  
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

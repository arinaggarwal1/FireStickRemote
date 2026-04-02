import express from "express";
import cors from "cors";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import multer from "multer";

import { createDevicesStore } from "./models/devicesStore.js";
import { DeviceSessionManager } from "./sessions/deviceSessionManager.js";
import { AdbTransport } from "./transports/adbTransport.js";
import { FireTvHttpsTransport } from "./transports/firetvHttpsTransport.js";
import { HybridTransport } from "./transports/hybridTransport.js";
import { createDebugLogger } from "./utils/debugLogger.js";
import { createFireTvRequest } from "./utils/fireTvRequest.js";
import { normalizeDeviceHost } from "./utils/hostNormalization.js";
import { normalizeRemoteAction } from "./utils/firetvActions.js";
import { asTransportError } from "./utils/transportErrors.js";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 9090);
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(process.cwd(), "data");
const LEGACY_CONFIG_FILE = path.resolve(process.cwd(), "config.yml");
const UPLOAD_DIR = path.resolve(DATA_DIR, "uploads");
const DEFAULT_FRIENDLY_NAME = "Fire TV Remote Desktop";
const debugLogger = createDebugLogger("firetv");

const devicesStore = createDevicesStore({
  dataDir: DATA_DIR,
  legacyConfigFile: LEGACY_CONFIG_FILE,
});
const adbTransport = new AdbTransport({ logger: debugLogger });
const fireTvRequest = createFireTvRequest({ devicesStore, logger: debugLogger });
const fireTvHttpsTransport = new FireTvHttpsTransport({ fireTvRequest });
const hybridTransport = new HybridTransport({
  fireTvHttpsTransport,
  adbTransport,
  logger: debugLogger,
});
const sessionManager = new DeviceSessionManager({
  devicesStore,
  hybridTransport,
  adbTransport,
  fireTvHttpsTransport,
  logger: debugLogger,
});

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

function ensureUploadDir() {
  ensureDataDir();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

async function removeFileIfPresent(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch (_) {}
}

const sideloadUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      ensureUploadDir();
      cb(null, UPLOAD_DIR);
    },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".apk";
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    },
  }),
  limits: {
    fileSize: 1024 * 1024 * 1024,
  },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (ext !== ".apk") {
      cb(new Error("Only .apk files can be sideloaded."));
      return;
    }
    cb(null, true);
  },
});

function sendSuccess(res, payload = {}, status = 200) {
  res.status(status).json({
    ok: true,
    ...payload,
  });
}

function sendError(res, error, extra = {}) {
  const normalized = asTransportError(error, extra.code || "REQUEST_FAILED", extra.message);
  res.status(extra.status || normalized.status || 500).json({
    ok: false,
    error: normalized.message,
    code: normalized.code,
    details: normalized.details || undefined,
    ...extra.payload,
  });
}

function validateDevicePayload(body) {
  const name = String(body?.name || "").trim();
  const host = normalizeDeviceHost(body?.host);
  if (!name || !host) return null;
  return { name, host };
}

function getDeviceInput(body = {}, query = {}) {
  return {
    host: normalizeDeviceHost(body.host ?? query.host),
    deviceId: body.deviceId ?? query.deviceId ?? null,
    name: body.name ?? query.name ?? "",
    token: typeof (body.token ?? query.token) === "string" ? (body.token ?? query.token) : undefined,
    friendlyName: body.friendlyName ?? query.friendlyName ?? DEFAULT_FRIENDLY_NAME,
  };
}

app.get("/api/devices", (req, res) => {
  sendSuccess(res, { devices: devicesStore.listDevices() });
});

app.post("/api/devices", (req, res) => {
  try {
    const payload = validateDevicePayload(req.body);
    if (!payload) {
      return sendError(res, new Error("name and host are required"), { status: 400, code: "INVALID_DEVICE" });
    }

    const device = devicesStore.createDevice(payload);
    sendSuccess(res, { device }, 201);
  } catch (error) {
    sendError(res, error, { status: 400, code: "INVALID_DEVICE" });
  }
});

app.put("/api/devices/:id", (req, res) => {
  try {
    const payload = validateDevicePayload(req.body);
    if (!payload) {
      return sendError(res, new Error("name and host are required"), { status: 400, code: "INVALID_DEVICE" });
    }

    const device = devicesStore.updateDevice(req.params.id, payload);
    if (!device) {
      return sendError(res, new Error("Device not found"), { status: 404, code: "DEVICE_NOT_FOUND" });
    }

    sendSuccess(res, { device });
  } catch (error) {
    sendError(res, error, { status: 400, code: "INVALID_DEVICE" });
  }
});

app.delete("/api/devices/:id", (req, res) => {
  const deleted = devicesStore.deleteDevice(req.params.id);
  if (!deleted) {
    return sendError(res, new Error("Device not found"), { status: 404, code: "DEVICE_NOT_FOUND" });
  }

  sendSuccess(res, { deleted: true });
});

app.post("/api/devices/:id/default", (req, res) => {
  const device = devicesStore.setDefaultDevice(req.params.id);
  if (!device) {
    return sendError(res, new Error("Device not found"), { status: 404, code: "DEVICE_NOT_FOUND" });
  }

  sendSuccess(res, { device });
});

app.delete("/api/devices/:id/default", (req, res) => {
  const cleared = devicesStore.clearDefaultDevice(req.params.id);
  if (!cleared) {
    return sendError(res, new Error("Default device not found"), { status: 404, code: "DEVICE_NOT_FOUND" });
  }

  sendSuccess(res, { cleared: true });
});

app.get("/api/session", async (req, res) => {
  try {
    const deviceInput = getDeviceInput({}, req.query);
    const { device, session } = await sessionManager.refresh(deviceInput);
    sendSuccess(res, { device, session });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/connect", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const { device, session, result } = await sessionManager.connect(deviceInput);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/disconnect", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const { device, session } = await sessionManager.disconnect(deviceInput);
    sendSuccess(res, { device, session, result: { disconnected: true } });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/pair/start", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const { device, session, result } = await sessionManager.pairStart(deviceInput, deviceInput.friendlyName);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/pair/display", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const { device, session, result } = await sessionManager.pairStart(deviceInput, deviceInput.friendlyName);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/pair/verify", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const pin = String(req.body?.pin || "").trim();
    if (!pin) {
      return sendError(res, new Error("pin is required"), { status: 400, code: "INVALID_PIN" });
    }

    const { device, session, result } = await sessionManager.pairVerify(deviceInput, pin, deviceInput.friendlyName);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/pair", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const pin = String(req.body?.pin || req.body?.code || "").trim();
    if (!pin) {
      return sendError(res, new Error("host and code are required"), { status: 400, code: "INVALID_PIN" });
    }

    const { device, session, result } = await sessionManager.pairVerify(deviceInput, pin, deviceInput.friendlyName);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/remote", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const action = normalizeRemoteAction(req.body?.action);
    if (!action) {
      return sendError(res, new Error("action is required"), { status: 400, code: "INVALID_ACTION" });
    }

    const { device, session, result } = await sessionManager.sendRemoteAction(deviceInput, action);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/key", async (req, res) => {
  try {
    const action = normalizeRemoteAction(req.body?.code);
    if (!action) {
      return sendError(res, new Error("Missing key code"), { status: 400, code: "INVALID_ACTION" });
    }

    const deviceInput = getDeviceInput(req.body);
    const { device, session, result } = await sessionManager.sendRemoteAction(deviceInput, action);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/text", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const text = req.body?.text;
    if (typeof text !== "string") {
      return sendError(res, new Error("Missing text"), { status: 400, code: "INVALID_TEXT" });
    }

    const { device, session, result } = await sessionManager.sendText(deviceInput, text);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.get("/api/apps", async (req, res) => {
  try {
    const deviceInput = getDeviceInput({}, req.query);
    const { device, session, apps, result } = await sessionManager.listApps(deviceInput);
    sendSuccess(res, {
      device,
      session,
      apps,
      packages: apps.map((appEntry) => appEntry.id),
      result,
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/app", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const appId = String(req.body?.appId || req.body?.package || "").trim();
    if (!appId) {
      return sendError(res, new Error("Missing app id"), { status: 400, code: "INVALID_APP" });
    }

    const { device, session, result } = await sessionManager.launchApp(deviceInput, appId);
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/swipe", async (req, res) => {
  try {
    const { x1, y1, x2, y2, durationMs } = req.body || {};
    if ([x1, y1, x2, y2].some((value) => typeof value !== "number")) {
      return sendError(res, new Error("x1,y1,x2,y2 must be numbers"), { status: 400, code: "INVALID_SWIPE" });
    }

    const deviceInput = getDeviceInput(req.body);
    const { device, session, result } = await sessionManager.swipe(deviceInput, {
      x1,
      y1,
      x2,
      y2,
      durationMs,
    });
    sendSuccess(res, { device, session, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/adb/repair", async (req, res) => {
  try {
    const deviceInput = getDeviceInput(req.body);
    const { device, result } = await sessionManager.repairAdb(deviceInput);
    sendSuccess(res, { device, result });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/sideload", (req, res) => {
  sideloadUpload.single("apk")(req, res, async (uploadError) => {
    if (uploadError) {
      return sendError(res, uploadError, { status: 400, code: "UPLOAD_FAILED" });
    }

    const uploadedFile = req.file;
    const replaceExisting = String(req.body?.replaceExisting || "false") === "true";

    try {
      const deviceInput = getDeviceInput(req.body);
      if (!uploadedFile) {
        return sendError(res, new Error("APK file is required"), { status: 400, code: "APK_REQUIRED" });
      }

      const { device, session, result } = await sessionManager.installApk(
        deviceInput,
        uploadedFile.path,
        replaceExisting,
      );

      sendSuccess(res, {
        device,
        session,
        result: {
          ...result,
          fileName: uploadedFile.originalname,
          replaceExisting,
        },
      });
    } catch (error) {
      sendError(res, error);
    } finally {
      await removeFileIfPresent(uploadedFile?.path);
    }
  });
});

app.listen(PORT, HOST, function onListen() {
  const address = this.address();
  const resolvedPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`Server listening on http://${HOST}:${resolvedPort}`);
});

process.on("exit", () => {
  sessionManager.shutdown().catch(() => {});
});

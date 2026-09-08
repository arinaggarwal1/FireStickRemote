import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "fs";
import https from "https";
import os from "os";
import path from "path";

import {
  getAdbTargetHost,
  getDialBaseUrl,
  getHttpsBaseUrl,
  normalizeDeviceHost,
  stripPort,
} from "../utils/hostNormalization.js";
import {
  getAdbKeycodeForAction,
  getSemanticActionFromLegacyKeycode,
  normalizeRemoteAction,
} from "../utils/firetvActions.js";
import { deriveCapabilities } from "../utils/capabilityMatrix.js";
import { createDevicesStore } from "../models/devicesStore.js";
import { createPreferencesStore } from "../models/preferencesStore.js";
import { AdbTransport } from "../transports/adbTransport.js";
import { HybridTransport } from "../transports/hybridTransport.js";
import { FireTvHttpsTransport } from "../transports/firetvHttpsTransport.js";
import { createFireTvRequest } from "../utils/fireTvRequest.js";
import { createTransportError } from "../utils/transportErrors.js";

test("host normalization keeps device host user-facing and derives ADB target separately", () => {
  assert.equal(normalizeDeviceHost(" https://10.0.0.8:5555/ "), "10.0.0.8:5555");
  assert.equal(stripPort("10.0.0.8:5555"), "10.0.0.8");
  assert.equal(getHttpsBaseUrl("10.0.0.8:5555"), "https://10.0.0.8:8080");
  assert.equal(getDialBaseUrl("10.0.0.8"), "http://10.0.0.8:8009");
  assert.equal(getAdbTargetHost("10.0.0.8"), "10.0.0.8:5555");
  assert.equal(getAdbTargetHost("10.0.0.8:5556"), "10.0.0.8:5556");
});

test("semantic remote actions preserve legacy keycode compatibility", () => {
  assert.equal(normalizeRemoteAction("home"), "home");
  assert.equal(getSemanticActionFromLegacyKeycode(3), "home");
  assert.equal(normalizeRemoteAction(85), "play_pause");
  assert.equal(getAdbKeycodeForAction("mute"), 164);
});

test("capability matrix prefers HTTPS where authenticated and keeps adb-backed launch available", () => {
  const { capabilities, preferredTransports } = deriveCapabilities({
    authenticated: true,
    adbAvailable: true,
    adbConnected: false,
    httpsTextAvailable: true,
    httpsAppListAvailable: true,
    httpsAppLaunchAvailable: false,
  });

  assert.equal(capabilities.remoteControl, true);
  assert.equal(capabilities.textInput, true);
  assert.equal(capabilities.appList, true);
  assert.equal(capabilities.appLaunch, true);
  assert.equal(capabilities.sideload, true);
  assert.equal(preferredTransports.remoteControl, "https");
  assert.equal(preferredTransports.textInput, "https");
  assert.equal(preferredTransports.appList, "https");
  assert.equal(preferredTransports.appLaunch, "adb");
  assert.equal(preferredTransports.installApk, "adb");
});

test("devices store migrates legacy devices into the versioned schema", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-store-"));
  const legacyConfigFile = path.join(tempDir, "config.yml");
  fs.writeFileSync(legacyConfigFile, "devices:\n  - name: Dorm TV\n    host: 10.0.0.9\n    port: 5555\n");

  const store = createDevicesStore({
    dataDir: tempDir,
    legacyConfigFile,
  });

  const devices = store.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, "Dorm TV");
  assert.equal(devices[0].host, "10.0.0.9:5555");
  assert.equal(devices[0].token, "");
  assert.equal(devices[0].transportPolicy, "hybrid");
  assert.equal(devices[0].isDefault, false);
  assert.ok(typeof devices[0].id === "string" && devices[0].id.length > 0);

  const storedJson = JSON.parse(fs.readFileSync(path.join(tempDir, "devices.json"), "utf8"));
  assert.equal(storedJson.version, 3);
  assert.equal(storedJson.defaultDeviceId, null);
  assert.equal(storedJson.devices.length, 1);
});

test("devices store can persist and clear a default device", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-store-default-"));
  const store = createDevicesStore({
    dataDir: tempDir,
    legacyConfigFile: path.join(tempDir, "config.yml"),
  });

  const livingRoom = store.createDevice({ name: "Living Room", host: "10.0.0.21" });
  const bedroom = store.createDevice({ name: "Bedroom", host: "10.0.0.22" });

  const defaultDevice = store.setDefaultDevice(bedroom.id);
  assert.equal(defaultDevice?.id, bedroom.id);
  assert.equal(store.getDefaultDevice()?.id, bedroom.id);

  const listedDevices = store.listDevices();
  assert.equal(listedDevices.find((device) => device.id === livingRoom.id)?.isDefault, false);
  assert.equal(listedDevices.find((device) => device.id === bedroom.id)?.isDefault, true);

  assert.equal(store.clearDefaultDevice(bedroom.id), true);
  assert.equal(store.getDefaultDevice(), null);
});

test("preferences store persists quick launch selections", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-prefs-"));
  const store = createPreferencesStore({ dataDir: tempDir });

  assert.deepEqual(store.getQuickLaunchApps(), []);

  const saved = store.setQuickLaunchApps(["com.netflix.ninja", "com.hulu.plus", "", null]);
  assert.deepEqual(saved, ["com.netflix.ninja", "com.hulu.plus"]);
  assert.deepEqual(store.getQuickLaunchApps(), ["com.netflix.ninja", "com.hulu.plus"]);
});

test("preferences store persists theme mode and sanitizes invalid values", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-prefs-theme-"));
  const store = createPreferencesStore({ dataDir: tempDir });

  assert.equal(store.getThemeMode(), "dark");
  assert.equal(store.setThemeMode("light"), "light");
  assert.equal(store.getThemeMode(), "light");
  assert.equal(store.setThemeMode("sepia"), "dark");
  assert.equal(store.getThemeMode(), "dark");
});

test("preferences store persists custom app display names", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-prefs-app-names-"));
  const store = createPreferencesStore({ dataDir: tempDir });

  const names = store.setAppDisplayNames({
    "com.netflix.ninja": "Netflix Living Room",
    "": "Ignored",
    "com.amazon.firebat": "",
  });

  assert.deepEqual(names, {
    "com.netflix.ninja": "Netflix Living Room",
  });
  assert.deepEqual(store.getAppDisplayNames(), {
    "com.netflix.ninja": "Netflix Living Room",
  });
});

test("fireTvRequest rejects authenticated calls when the device token is missing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-request-"));
  const store = createDevicesStore({
    dataDir: tempDir,
    legacyConfigFile: path.join(tempDir, "config.yml"),
  });

  store.createDevice({ name: "Dorm TV", host: "10.0.0.15" });
  const fireTvRequest = createFireTvRequest({ devicesStore: store, logger: { info() {} } });

  await assert.rejects(
    () => fireTvRequest("10.0.0.15", "/v1/FireTV?action=home", { method: "POST" }),
    /missing client token/i,
  );
});

test("fireTvRequest maps socket timeouts to REQUEST_TIMEOUT", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-request-timeout-"));
  const store = createDevicesStore({
    dataDir: tempDir,
    legacyConfigFile: path.join(tempDir, "config.yml"),
  });
  const fireTvRequest = createFireTvRequest({ devicesStore: store, logger: { info() {}, warn() {}, error() {} } });
  const originalRequest = https.request;

  https.request = () => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.end = () => {
      queueMicrotask(() => {
        const error = new Error("connect ETIMEDOUT 10.0.0.123:8080");
        error.code = "ETIMEDOUT";
        req.emit("error", error);
      });
    };
    return req;
  };

  try {
    await assert.rejects(
      async () => {
        await fireTvRequest("10.0.0.123", "/v1/FireTV/status", { method: "GET", authRequired: false });
      },
      (error) => error?.code === "REQUEST_TIMEOUT",
    );
  } finally {
    https.request = originalRequest;
  }
});

test("devices store persists a host-only token record for manually paired devices", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "firetv-store-manual-"));
  const store = createDevicesStore({
    dataDir: tempDir,
    legacyConfigFile: path.join(tempDir, "config.yml"),
  });

  const saved = store.saveConnectionMetadata({
    id: null,
    host: "10.0.0.16",
    token: "abcd1234",
    lastKnownCapabilities: {},
    lastConnection: {},
  });

  assert.equal(saved.host, "10.0.0.16");
  assert.equal(saved.token, "abcd1234");
  assert.equal(store.findDeviceByHost("10.0.0.16")?.token, "abcd1234");
});

test("adb transport retries once when the persistent shell closes unexpectedly", async () => {
  const transport = new AdbTransport({ logger: { warn() {} } });
  let attempts = 0;
  let closedHosts = [];

  transport.runPersistentShellCommand = async (_host, command) => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("Persistent ADB shell closed (code: 1, signal: none).");
    }
    return { code: 0, stdout: command, stderr: "" };
  };

  transport.closeShellSession = async (host) => {
    closedHosts.push(host);
  };

  const result = await transport.sendRemoteAction({ host: "10.0.0.44" }, "home");
  assert.equal(result.ok, true);
  assert.equal(attempts, 2);
  assert.deepEqual(closedHosts, ["10.0.0.44"]);
});

test("adb transport connect treats offline as disconnected and clears stale sessions first", async () => {
  const transport = new AdbTransport({ logger: { warn() {} } });
  const commands = [];
  let probeCount = 0;

  transport.closeShellSession = async () => {};
  transport.runAdb = async (args) => {
    commands.push(args.join(" "));
    return { code: 0, stdout: "ok", stderr: "" };
  };
  transport.probe = async () => {
    probeCount += 1;
    if (probeCount === 1) {
      return { adbAvailable: true, adbConnected: false, adbState: "offline", adbHost: "10.0.0.50:5555" };
    }
    return { adbAvailable: true, adbConnected: true, adbState: "device", adbHost: "10.0.0.50:5555" };
  };

  const result = await transport.connect({ host: "10.0.0.50" });

  assert.equal(result.ok, true);
  assert.equal(commands[0], "disconnect 10.0.0.50:5555");
  assert.equal(commands[1], "connect 10.0.0.50:5555");
});

test("hybrid transport connect prefers HTTPS auth but still records ADB readiness", async () => {
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async probe() {
        return {
          httpsReachable: true,
          tlsReady: true,
          apiKeyAccepted: true,
          pairingRequired: false,
          tokenValid: true,
          authenticated: true,
        };
      },
    },
    adbTransport: {
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {} },
  });

  const outcome = await hybrid.connect({ host: "10.0.0.10", token: "abc" });
  assert.equal(outcome.session.authenticated, true);
  assert.equal(outcome.session.capabilities.remoteControl, true);
  assert.equal(outcome.session.preferredTransports.remoteControl, "https");
  assert.equal(outcome.session.adbAvailable, true);
  assert.equal(outcome.session.adbConnected, false);
  assert.equal(outcome.result.transportUsed, "https");
});

test("hybrid transport wakes and retries HTTPS before settling for ADB fallback", async () => {
  let probeCount = 0;
  let wakeCount = 0;
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async probe() {
        probeCount += 1;
        if (probeCount === 1) {
          return {
            httpsReachable: false,
            tlsReady: true,
            apiKeyAccepted: false,
            pairingRequired: false,
            tokenValid: false,
            authenticated: false,
          };
        }

        return {
          httpsReachable: true,
          tlsReady: true,
          apiKeyAccepted: true,
          pairingRequired: false,
          tokenValid: true,
          authenticated: true,
        };
      },
      async wake() {
        wakeCount += 1;
        return { ok: true, transportUsed: "dial" };
      },
    },
    adbTransport: {
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {}, warn() {} },
  });

  const outcome = await hybrid.connect({ host: "10.0.0.10", token: "abc" });
  assert.equal(wakeCount, 1);
  assert.equal(probeCount, 2);
  assert.equal(outcome.session.authenticated, true);
  assert.equal(outcome.result.transportUsed, "https");
});

test("hybrid transport falls back to ADB text when HTTPS keyboard is not active", async () => {
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async getKeyboardState() {
        return { ready: false };
      },
    },
    adbTransport: {
      async sendText() {
        return { ok: true, transportUsed: "adb" };
      },
      async connect() {
        return { ok: true, transportUsed: "adb" };
      },
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {} },
  });

  const outcome = await hybrid.sendText(
    { host: "10.0.0.12", token: "abc" },
    {
      authenticated: true,
      tokenValid: true,
      adbAvailable: true,
      adbConnected: true,
    },
    "hello world",
  );

  assert.equal(outcome.result.transportUsed, "adb");
  assert.match(outcome.result.reason, /keyboard/i);
});

test("hybrid transport merges HTTPS and ADB app discovery when both are available", async () => {
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async listApps() {
        return [
          { id: "com.netflix.ninja", name: "Netflix", sourceTransport: "https" },
        ];
      },
    },
    adbTransport: {
      async listApps() {
        return [
          { id: "com.netflix.ninja", name: "com.netflix.ninja", sourceTransport: "adb" },
          { id: "com.stremio.one", name: "com.stremio.one", sourceTransport: "adb" },
        ];
      },
      async connect() {
        return { ok: true, transportUsed: "adb" };
      },
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {}, warn() {} },
  });

  const outcome = await hybrid.listApps(
    { host: "10.0.0.20", token: "abc" },
    {
      authenticated: true,
      adbAvailable: true,
      adbConnected: true,
      httpsAppListAvailable: true,
    },
  );

  assert.equal(outcome.result.transportUsed, "hybrid");
  assert.deepEqual(
    outcome.result.apps.map((app) => app.id).sort(),
    ["com.netflix.ninja", "com.stremio.one"],
  );
});

test("hybrid transport prefers HTTPS app discovery without forcing an ADB reconnect", async () => {
  let adbConnectCalls = 0;
  let adbListCalls = 0;
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async listApps() {
        return [
          { id: "com.netflix.ninja", name: "Netflix", sourceTransport: "https" },
        ];
      },
    },
    adbTransport: {
      async listApps() {
        adbListCalls += 1;
        return [];
      },
      async connect() {
        adbConnectCalls += 1;
        return { ok: true, transportUsed: "adb" };
      },
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {}, warn() {} },
  });

  const outcome = await hybrid.listApps(
    { host: "10.0.0.21", token: "abc" },
    {
      authenticated: true,
      adbAvailable: true,
      adbConnected: false,
      httpsAppListAvailable: true,
    },
  );

  assert.equal(outcome.result.transportUsed, "https");
  assert.equal(adbConnectCalls, 0);
  assert.equal(adbListCalls, 0);
});

test("https transport maps media actions to the verified media API shapes", async () => {
  const requests = [];
  const transport = new FireTvHttpsTransport({
    fireTvRequest: async (_device, path, options = {}) => {
      requests.push({
        path,
        body: options.body ?? null,
      });
      return {
        statusCode: 200,
        bodyText: "{}",
        data: {},
      };
    },
  });

  await transport.sendRemoteAction({ host: "10.0.0.30", token: "abc" }, "play_pause");
  await transport.sendRemoteAction({ host: "10.0.0.30", token: "abc" }, "rewind");
  await transport.sendRemoteAction({ host: "10.0.0.30", token: "abc" }, "fast_forward");
  await transport.sendRemoteAction({ host: "10.0.0.30", token: "abc" }, "home");

  assert.deepEqual(requests[0], {
    path: "/v1/media?action=play",
    body: null,
  });
  assert.deepEqual(requests[1], {
    path: "/v1/media?action=scan",
    body: {
      direction: "backward",
      durationInSeconds: "10",
      speed: "1",
    },
  });
  assert.deepEqual(requests[2], {
    path: "/v1/media?action=scan",
    body: {
      direction: "forward",
      durationInSeconds: "10",
      speed: "1",
    },
  });
  assert.deepEqual(requests[3], {
    path: "/v1/FireTV?action=home",
    body: {},
  });
});

test("hybrid transport falls back to ADB when HTTPS remote action fails", async () => {
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {
      async sendRemoteAction() {
        throw createTransportError("REMOTE_ACTION_FAILED", "HTTPS action failed", { status: 502 });
      },
    },
    adbTransport: {
      async sendRemoteAction(_device, action) {
        return { ok: true, transportUsed: "adb", action };
      },
      async connect() {
        return { ok: true, transportUsed: "adb" };
      },
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {}, warn() {} },
  });

  const outcome = await hybrid.sendRemoteAction(
    { host: "10.0.0.31", token: "abc" },
    {
      authenticated: true,
      tokenValid: true,
      adbAvailable: true,
      adbConnected: false,
    },
    "volume_up",
  );

  assert.equal(outcome.result.transportUsed, "adb");
  assert.equal(outcome.session.adbConnected, true);
});

test("hybrid transport re-probes stale ADB state before launching an app", async () => {
  let probeCount = 0;
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {},
    adbTransport: {
      async probe() {
        probeCount += 1;
        if (probeCount === 1) {
          return { adbAvailable: true, adbConnected: false, adbHost: "10.0.0.40:5555" };
        }
        return { adbAvailable: true, adbConnected: true, adbHost: "10.0.0.40:5555" };
      },
      async connect() {
        return { ok: true, transportUsed: "adb", adbHost: "10.0.0.40:5555" };
      },
      async launchApp(_device, appId) {
        return { ok: true, transportUsed: "adb", appId };
      },
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {} },
  });

  const outcome = await hybrid.launchApp(
    { host: "10.0.0.40" },
    {
      adbAvailable: true,
      adbConnected: true,
    },
    "com.netflix.ninja",
  );

  assert.equal(outcome.result.transportUsed, "adb");
  assert.equal(outcome.session.adbConnected, true);
  assert.equal(probeCount, 2);
});

test("hybrid transport repairs offline ADB before giving up on app launch", async () => {
  let probeCount = 0;
  let repairCount = 0;
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {},
    adbTransport: {
      async probe() {
        probeCount += 1;
        if (probeCount === 1) {
          return { adbAvailable: true, adbConnected: false, adbState: "offline", adbHost: "10.0.0.41:5555" };
        }
        return { adbAvailable: true, adbConnected: false, adbState: "offline", adbHost: "10.0.0.41:5555" };
      },
      async connect() {
        return { ok: false, transportUsed: "adb", adbHost: "10.0.0.41:5555" };
      },
      async repair() {
        repairCount += 1;
        return {
          ok: true,
          transportUsed: "adb",
          probe: { adbAvailable: true, adbConnected: true, adbState: "device", adbHost: "10.0.0.41:5555" },
        };
      },
      async launchApp(_device, appId) {
        return { ok: true, transportUsed: "adb", appId };
      },
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {}, warn() {} },
  });

  const outcome = await hybrid.launchApp(
    { host: "10.0.0.41" },
    {
      adbAvailable: true,
      adbConnected: false,
    },
    "com.netflix.ninja",
  );

  assert.equal(outcome.result.transportUsed, "adb");
  assert.equal(outcome.session.adbConnected, true);
  assert.equal(repairCount, 1);
});

test("hybrid transport surfaces an explicit offline ADB error for app launch", async () => {
  const hybrid = new HybridTransport({
    fireTvHttpsTransport: {},
    adbTransport: {
      async probe() {
        return { adbAvailable: true, adbConnected: false, adbState: "offline", adbHost: "10.0.0.42:5555" };
      },
      async connect() {
        return { ok: false, transportUsed: "adb", adbHost: "10.0.0.42:5555" };
      },
      async repair() {
        return {
          ok: false,
          transportUsed: "adb",
          probe: { adbAvailable: true, adbConnected: false, adbState: "offline", adbHost: "10.0.0.42:5555" },
        };
      },
      getAvailability() {
        return { adbAvailable: true, adbBinary: "adb" };
      },
    },
    logger: { info() {}, warn() {} },
  });

  await assert.rejects(
    () => hybrid.launchApp(
      { host: "10.0.0.42" },
      { adbAvailable: true, adbConnected: false, adbState: "offline" },
      "com.netflix.ninja",
    ),
    (error) => error?.code === "ADB_OFFLINE",
  );
});

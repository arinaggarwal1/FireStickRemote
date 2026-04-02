import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
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
import { HybridTransport } from "../transports/hybridTransport.js";
import { createFireTvRequest } from "../utils/fireTvRequest.js";

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
      adbConnected: false,
      httpsAppListAvailable: true,
    },
  );

  assert.equal(outcome.result.transportUsed, "hybrid");
  assert.deepEqual(
    outcome.result.apps.map((app) => app.id).sort(),
    ["com.netflix.ninja", "com.stremio.one"],
  );
});

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import yaml from "js-yaml";

import { getAdbTargetHost, normalizeDeviceHost } from "../utils/hostNormalization.js";

function sanitizeStoredDevice(device) {
  const host = normalizeDeviceHost(device?.host);
  const name = String(device?.name || "").trim();
  if (!host || !name) return null;

  const token = typeof device?.token === "string"
    ? device.token
    : typeof device?.clientToken === "string"
    ? device.clientToken
    : "";

  return {
    id: String(device?.id || randomUUID()),
    name,
    host,
    adbHost: normalizeDeviceHost(device?.adbHost) || getAdbTargetHost(host),
    transportPolicy: String(device?.transportPolicy || "hybrid"),
    token,
    clientToken: token,
    lastKnownCapabilities: device?.lastKnownCapabilities && typeof device.lastKnownCapabilities === "object"
      ? device.lastKnownCapabilities
      : {},
    lastConnection: device?.lastConnection && typeof device.lastConnection === "object"
      ? device.lastConnection
      : {},
  };
}

export function createDevicesStore({ dataDir, legacyConfigFile }) {
  const devicesFile = path.resolve(dataDir, "devices.json");
  const STORE_VERSION = 3;

  function ensureDataDir() {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  function prepareDeviceForWrite(device) {
    return {
      id: device.id,
      name: device.name,
      host: device.host,
      adbHost: device.adbHost,
      transportPolicy: device.transportPolicy,
      token: device.token || "",
      lastKnownCapabilities: device.lastKnownCapabilities || {},
      lastConnection: device.lastConnection || {},
    };
  }

  function readLegacyDevices() {
    try {
      const raw = fs.readFileSync(legacyConfigFile, "utf8");
      const parsed = yaml.load(raw);
      const devices = Array.isArray(parsed?.devices) ? parsed.devices : [];
      return devices
        .map((device) =>
          sanitizeStoredDevice({
            id: randomUUID(),
            name: device?.name,
            host: device?.port ? `${device.host}:${device.port}` : device?.host,
          }),
        )
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  function writeStore(devices, defaultDeviceId = null) {
    ensureDataDir();
    fs.writeFileSync(
      devicesFile,
      JSON.stringify(
        {
          version: STORE_VERSION,
          defaultDeviceId: defaultDeviceId || null,
          devices: devices.map(prepareDeviceForWrite),
        },
        null,
        2,
      ),
    );
  }

  function readStore() {
    ensureDataDir();

    try {
      const raw = fs.readFileSync(devicesFile, "utf8");
      const parsed = JSON.parse(raw);
      const sourceDevices = Array.isArray(parsed) ? parsed : parsed?.devices;
      const devices = Array.isArray(sourceDevices)
        ? sourceDevices.map(sanitizeStoredDevice).filter(Boolean)
        : [];
      const defaultDeviceId = typeof parsed?.defaultDeviceId === "string"
        && devices.some((device) => device.id === parsed.defaultDeviceId)
        ? parsed.defaultDeviceId
        : null;

      if ((parsed?.version || 1) !== STORE_VERSION) {
        writeStore(devices, defaultDeviceId);
      }

      return { devices, defaultDeviceId };
    } catch (_) {
      const seededDevices = readLegacyDevices();
      if (seededDevices.length > 0) {
        writeStore(seededDevices, null);
      }
      return { devices: seededDevices, defaultDeviceId: null };
    }
  }

  function listDevices() {
    const { devices, defaultDeviceId } = readStore();
    return devices.map((device) => ({
      ...device,
      isDefault: device.id === defaultDeviceId,
    }));
  }

  function getDeviceById(id) {
    const { devices, defaultDeviceId } = readStore();
    const device = devices.find((entry) => entry.id === id) || null;
    if (!device) return null;
    return { ...device, isDefault: device.id === defaultDeviceId };
  }

  function findDeviceByHost(host) {
    const normalizedHost = normalizeDeviceHost(host);
    if (!normalizedHost) return null;
    const { devices, defaultDeviceId } = readStore();
    const device = devices.find((entry) => normalizeDeviceHost(entry.host) === normalizedHost) || null;
    if (!device) return null;
    return { ...device, isDefault: device.id === defaultDeviceId };
  }

  function getDefaultDevice() {
    const { devices, defaultDeviceId } = readStore();
    if (!defaultDeviceId) return null;
    const device = devices.find((entry) => entry.id === defaultDeviceId) || null;
    if (!device) return null;
    return { ...device, isDefault: true };
  }

  function createDevice(payload) {
    const device = sanitizeStoredDevice({
      id: randomUUID(),
      ...payload,
    });

    if (!device) {
      throw new Error("name and host are required");
    }

    const { devices, defaultDeviceId } = readStore();
    devices.push(device);
    const nextDefaultDeviceId = payload?.isDefault ? device.id : defaultDeviceId;
    writeStore(devices, nextDefaultDeviceId);
    return { ...device, isDefault: device.id === nextDefaultDeviceId };
  }

  function updateDevice(id, payload) {
    const { devices, defaultDeviceId } = readStore();
    const index = devices.findIndex((device) => device.id === id);
    if (index === -1) return null;

    const updatedDevice = sanitizeStoredDevice({
      ...devices[index],
      ...payload,
      id,
    });

    if (!updatedDevice) {
      throw new Error("name and host are required");
    }

    devices[index] = updatedDevice;
    writeStore(devices, defaultDeviceId);
    return { ...updatedDevice, isDefault: updatedDevice.id === defaultDeviceId };
  }

  function deleteDevice(id) {
    const { devices, defaultDeviceId } = readStore();
    const nextDevices = devices.filter((device) => device.id !== id);
    if (nextDevices.length === devices.length) return false;
    const nextDefaultDeviceId = defaultDeviceId === id ? null : defaultDeviceId;
    writeStore(nextDevices, nextDefaultDeviceId);
    return true;
  }

  function setDefaultDevice(id) {
    const { devices } = readStore();
    const device = devices.find((entry) => entry.id === id) || null;
    if (!device) return null;
    writeStore(devices, id);
    return { ...device, isDefault: true };
  }

  function clearDefaultDevice(id = null) {
    const { devices, defaultDeviceId } = readStore();
    if (!defaultDeviceId) return false;
    if (id && defaultDeviceId !== id) return false;
    writeStore(devices, null);
    return true;
  }

  function saveConnectionMetadata({ id, host, token, lastKnownCapabilities, lastConnection }) {
    const { devices, defaultDeviceId } = readStore();
    const index = devices.findIndex((device) => device.id === id || normalizeDeviceHost(device.host) === normalizeDeviceHost(host));

    if (index === -1) {
      const createdDevice = sanitizeStoredDevice({
        id: id || randomUUID(),
        name: normalizeDeviceHost(host),
        host,
        token,
        lastKnownCapabilities,
        lastConnection,
      });

      if (!createdDevice) return null;
      devices.push(createdDevice);
      writeStore(devices, defaultDeviceId);
      return { ...createdDevice, isDefault: createdDevice.id === defaultDeviceId };
    }

    const nextDevice = sanitizeStoredDevice({
      ...devices[index],
      token: typeof token === "string" ? token : devices[index].token,
      lastKnownCapabilities: lastKnownCapabilities || devices[index].lastKnownCapabilities,
      lastConnection: lastConnection || devices[index].lastConnection,
    });

    devices[index] = nextDevice;
    writeStore(devices, defaultDeviceId);
    return { ...nextDevice, isDefault: nextDevice.id === defaultDeviceId };
  }

  return {
    devicesFile,
    listDevices,
    getDeviceById,
    findDeviceByHost,
    getDefaultDevice,
    createDevice,
    updateDevice,
    deleteDevice,
    setDefaultDevice,
    clearDefaultDevice,
    saveConnectionMetadata,
  };
}

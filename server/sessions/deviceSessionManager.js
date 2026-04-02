import { normalizeDeviceHost } from "../utils/hostNormalization.js";
import { deriveCapabilities, deriveStatusLabel } from "../utils/capabilityMatrix.js";
import { createTransportError } from "../utils/transportErrors.js";

export class DeviceSessionManager {
  constructor({ devicesStore, hybridTransport, adbTransport, fireTvHttpsTransport, logger = console }) {
    this.devicesStore = devicesStore;
    this.hybridTransport = hybridTransport;
    this.adbTransport = adbTransport;
    this.fireTvHttpsTransport = fireTvHttpsTransport;
    this.logger = logger;
    this.sessions = new Map();
  }

  resolveDevice(deviceInput = {}) {
    const host = normalizeDeviceHost(deviceInput.host);
    const byId = deviceInput.deviceId ? this.devicesStore.getDeviceById(deviceInput.deviceId) : null;
    const byHost = host ? this.devicesStore.findDeviceByHost(host) : null;
    const storedDevice = byId || byHost;
    const resolvedHost = host || storedDevice?.host || "";

    if (!resolvedHost) {
      throw createTransportError("INVALID_HOST", "host is required", { status: 400 });
    }

    this.logger.info?.("Resolved device for session request.", {
      requestedHost: host,
      requestedDeviceId: deviceInput.deviceId || null,
      matchedStoredDevice: storedDevice
        ? {
            id: storedDevice.id,
            name: storedDevice.name,
            host: storedDevice.host,
            tokenExists: Boolean(storedDevice.token || storedDevice.clientToken),
          }
        : null,
    });

    return {
      id: storedDevice?.id || deviceInput.deviceId || null,
      name: storedDevice?.name || String(deviceInput.name || "").trim() || resolvedHost,
      host: resolvedHost,
      adbHost: storedDevice?.adbHost || null,
      token: typeof deviceInput.token === "string"
        ? deviceInput.token
        : typeof deviceInput.clientToken === "string"
        ? deviceInput.clientToken
        : storedDevice?.token || storedDevice?.clientToken || "",
      transportPolicy: storedDevice?.transportPolicy || "hybrid",
      persisted: Boolean(storedDevice),
    };
  }

  summarizeSession(session) {
    const derived = deriveCapabilities(session);
    const next = {
      ...session,
      capabilities: derived.capabilities,
      preferredTransports: derived.preferredTransports,
      statusLabel: session?.statusLabel || deriveStatusLabel(session),
      transportAvailability: {
        https: {
          reachable: Boolean(session?.httpsReachable),
          authenticated: Boolean(session?.authenticated),
        },
        adb: {
          available: Boolean(session?.adbAvailable),
          connected: Boolean(session?.adbConnected),
        },
      },
      auth: {
        pairingRequired: Boolean(session?.pairingRequired),
        tokenPresent: Boolean(session?.tokenPresent),
        tokenValid: Boolean(session?.tokenValid),
        authenticated: Boolean(session?.authenticated),
      },
    };
    return next;
  }

  storeSession(device, session) {
    const summarized = this.summarizeSession(session);
    this.sessions.set(normalizeDeviceHost(device.host), summarized);
    this.persistConnectionMetadata(device, summarized);
    return summarized;
  }

  persistConnectionMetadata(device, session) {
    this.logger.info?.("Persisting device connection metadata.", {
      host: device?.host || null,
      deviceId: device?.id || null,
      persisted: Boolean(device?.persisted),
      tokenExists: Boolean(device?.token),
      tokenPreview: device?.token ? `${device.token.slice(0, 4)}...` : "(missing)",
    });

    const savedDevice = this.devicesStore.saveConnectionMetadata({
      id: device.id,
      host: device.host,
      token: device.token,
      lastKnownCapabilities: session.capabilities,
      lastConnection: {
        dialReachable: Boolean(session.dialReachable),
        httpsReachable: Boolean(session.httpsReachable),
        tlsReady: Boolean(session.tlsReady),
        apiKeyAccepted: Boolean(session.apiKeyAccepted),
        pairingRequired: Boolean(session.pairingRequired),
        tokenPresent: Boolean(session.tokenPresent),
        tokenValid: Boolean(session.tokenValid),
        authenticated: Boolean(session.authenticated),
        adbAvailable: Boolean(session.adbAvailable),
        adbConnected: Boolean(session.adbConnected),
        statusLabel: session.statusLabel,
        updatedAt: session.lastUpdatedAt,
      },
    });

    if (savedDevice) {
      device.id = savedDevice.id;
      device.name = savedDevice.name;
      device.persisted = true;
      this.logger.info?.("Persisted device metadata successfully.", {
        host: savedDevice.host,
        deviceId: savedDevice.id,
        tokenExists: Boolean(savedDevice.token),
        tokenPreview: savedDevice.token ? `${savedDevice.token.slice(0, 4)}...` : "(missing)",
      });
    } else {
      this.logger.warn?.("Persisting device metadata returned no saved device.", {
        host: device?.host || null,
        deviceId: device?.id || null,
      });
    }
  }

  getSession(deviceInput = {}) {
    const device = this.resolveDevice(deviceInput);
    const existing = this.sessions.get(normalizeDeviceHost(device.host));
    if (existing) return { device, session: this.summarizeSession(existing) };

    const session = this.summarizeSession({
      host: device.host,
      tokenPresent: Boolean(device.token),
      tokenValid: Boolean(device.token),
      authenticated: false,
      pairingRequired: false,
      adbAvailable: false,
      adbConnected: false,
      messages: [],
      lastUpdatedAt: new Date().toISOString(),
    });
    return { device, session };
  }

  async connect(deviceInput = {}) {
    const device = this.resolveDevice(deviceInput);
    this.logger.info?.("Connecting device session.", {
      host: device.host,
      deviceId: device.id,
      tokenExists: Boolean(device.token),
      tokenPreview: device.token ? `${device.token.slice(0, 4)}...` : "(missing)",
    });
    const previousSession = this.getSession(device).session;
    const { session, result } = await this.hybridTransport.connect(device, previousSession);
    return {
      device,
      session: this.storeSession(device, {
        ...session,
        messages: session.pairingRequired
          ? ["Pair this Fire TV to unlock HTTPS remote control."]
          : session.authenticated
          ? ["Remote ready."]
          : session.adbConnected
          ? ["HTTPS remote unavailable, using ADB fallback."]
          : [],
      }),
      result,
    };
  }

  async refresh(deviceInput = {}) {
    const { device, session } = this.getSession(deviceInput);
    const refreshedSession = await this.hybridTransport.refresh(device, session);
    return {
      device,
      session: this.storeSession(device, refreshedSession),
    };
  }

  async disconnect(deviceInput = {}) {
    if (deviceInput.host || deviceInput.deviceId) {
      const device = this.resolveDevice(deviceInput);
      await this.adbTransport.disconnect(device);
      this.sessions.delete(normalizeDeviceHost(device.host));
      return { device, session: null };
    }

    await this.adbTransport.disconnect();
    this.sessions.clear();
    return { device: null, session: null };
  }

  async pairStart(deviceInput = {}, friendlyName) {
    const { device, session } = this.getSession(deviceInput);
    this.logger.info?.("Starting Fire TV pairing display.", {
      host: device.host,
      deviceId: device.id,
      friendlyName,
      existingToken: Boolean(device.token),
    });
    const result = await this.fireTvHttpsTransport.pairStart(device, friendlyName);
    const nextSession = this.storeSession(device, {
      ...session,
      pairingRequired: true,
      httpsReachable: true,
      tlsReady: true,
      apiKeyAccepted: true,
      tokenPresent: Boolean(device.token),
      tokenValid: false,
      authenticated: false,
      messages: ["Enter the PIN shown on your Fire TV."],
    });
    return { device, session: nextSession, result };
  }

  async pairVerify(deviceInput = {}, pin, friendlyName) {
    const device = this.resolveDevice(deviceInput);
    this.logger.info?.("Verifying Fire TV pairing PIN.", {
      host: device.host,
      deviceId: device.id,
      friendlyName,
      pinLength: String(pin || "").length,
      existingToken: Boolean(device.token),
    });
    const verified = await this.fireTvHttpsTransport.pairVerify(device, pin, friendlyName);
    this.logger.info?.("Received Fire TV client token from pairing verify.", {
      host: device.host,
      deviceId: device.id,
      tokenExists: Boolean(verified.token),
      tokenPreview: verified.token ? `${verified.token.slice(0, 4)}...` : "(missing)",
    });
    device.token = verified.token;
    const connected = await this.connect({
      ...deviceInput,
      host: device.host,
      token: verified.token,
    });
    return {
      ...connected,
      device: {
        ...connected.device,
        token: verified.token,
        clientToken: verified.token,
      },
      result: {
        ...connected.result,
        paired: true,
        transportUsed: "https",
      },
    };
  }

  async sendRemoteAction(deviceInput = {}, action) {
    const { device, session } = this.getSession(deviceInput);
    const outcome = await this.hybridTransport.sendRemoteAction(device, session, action);
    return {
      device,
      session: this.storeSession(device, outcome.session),
      result: outcome.result,
    };
  }

  async sendText(deviceInput = {}, text) {
    const { device, session } = this.getSession(deviceInput);
    const outcome = await this.hybridTransport.sendText(device, session, text);
    return {
      device,
      session: this.storeSession(device, outcome.session),
      result: outcome.result,
    };
  }

  async listApps(deviceInput = {}) {
    const { device, session } = this.getSession(deviceInput);
    const outcome = await this.hybridTransport.listApps(device, session);
    return {
      device,
      session: this.storeSession(device, outcome.session),
      apps: outcome.result.apps,
      result: outcome.result,
    };
  }

  async launchApp(deviceInput = {}, appId) {
    const { device, session } = this.getSession(deviceInput);
    const outcome = await this.hybridTransport.launchApp(device, session, appId);
    return {
      device,
      session: this.storeSession(device, outcome.session),
      result: outcome.result,
    };
  }

  async installApk(deviceInput = {}, filePath, replaceExisting) {
    const { device, session } = this.getSession(deviceInput);
    const outcome = await this.hybridTransport.installApk(device, session, filePath, replaceExisting);
    return {
      device,
      session: this.storeSession(device, outcome.session),
      result: outcome.result,
    };
  }

  async swipe(deviceInput = {}, gesture) {
    const { device, session } = this.getSession(deviceInput);
    const outcome = await this.hybridTransport.swipe(device, session, gesture);
    return {
      device,
      session: this.storeSession(device, outcome.session),
      result: outcome.result,
    };
  }

  async repairAdb(deviceInput = {}) {
    const device = deviceInput.host || deviceInput.deviceId ? this.resolveDevice(deviceInput) : null;
    const result = await this.adbTransport.repair(device);
    if (device) {
      this.sessions.delete(normalizeDeviceHost(device.host));
    } else {
      this.sessions.clear();
    }
    return { device, result };
  }

  async shutdown() {
    await this.adbTransport.closeAllShellSessions();
    this.sessions.clear();
  }
}

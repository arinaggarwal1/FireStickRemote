import { deriveCapabilities, deriveStatusLabel } from "../utils/capabilityMatrix.js";
import { createTransportError } from "../utils/transportErrors.js";

function mergeSessionState(base, updates) {
  const session = {
    ...base,
    ...updates,
  };
  const derived = deriveCapabilities(session);
  session.capabilities = derived.capabilities;
  session.preferredTransports = derived.preferredTransports;
  session.statusLabel = deriveStatusLabel(session);
  session.transportAvailability = {
    https: {
      reachable: Boolean(session.httpsReachable),
      authenticated: Boolean(session.authenticated),
    },
    adb: {
      available: Boolean(session.adbAvailable),
      connected: Boolean(session.adbConnected),
    },
  };
  session.auth = {
    pairingRequired: Boolean(session.pairingRequired),
    tokenPresent: Boolean(session.tokenPresent),
    tokenValid: Boolean(session.tokenValid),
    authenticated: Boolean(session.authenticated),
  };
  session.lastUpdatedAt = new Date().toISOString();
  return session;
}

function mergeDiscoveredApps(...appLists) {
  const merged = new Map();

  appLists.flat().forEach((app) => {
    if (!app?.id) return;
    const existing = merged.get(app.id);
    if (!existing) {
      merged.set(app.id, { ...app });
      return;
    }

    merged.set(app.id, {
      ...existing,
      ...app,
      name: app?.name && app.name !== app.id ? app.name : existing.name,
      sourceTransport:
        existing.sourceTransport && existing.sourceTransport !== app.sourceTransport
          ? "hybrid"
          : (app.sourceTransport || existing.sourceTransport),
    });
  });

  return [...merged.values()].sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
}

export class HybridTransport {
  constructor({ fireTvHttpsTransport, adbTransport, logger = console }) {
    this.fireTvHttpsTransport = fireTvHttpsTransport;
    this.adbTransport = adbTransport;
    this.logger = logger;
  }

  async ensureAdbConnected(device, session, reason) {
    let nextSession = session;
    const availability = this.adbTransport.getAvailability();
    nextSession = mergeSessionState(nextSession, {
      adbAvailable: Boolean(availability.adbAvailable),
    });

    this.logger.info?.("ADB fallback evaluation.", {
      host: device.host,
      reason,
      adbAvailable: Boolean(availability.adbAvailable),
      adbConnected: Boolean(nextSession?.adbConnected),
    });

    if (!availability.adbAvailable) {
      return nextSession;
    }

    if (!nextSession?.adbConnected) {
      const adbConnect = await this.adbTransport.connect(device);
      this.logger.info?.("ADB fallback connect attempt.", {
        host: device.host,
        reason,
        ok: Boolean(adbConnect.ok),
        adbHost: adbConnect.adbHost,
      });
      nextSession = mergeSessionState(nextSession, { adbConnected: Boolean(adbConnect.ok) });
    }

    return nextSession;
  }

  async connect(device, previousSession = {}) {
    const httpsState = await this.fireTvHttpsTransport.probe(device);
    const adbState = this.adbTransport.getAvailability();

    this.logger.info?.("Hybrid connect decision.", {
      host: device.host,
      httpsReachable: Boolean(httpsState.httpsReachable),
      authenticated: Boolean(httpsState.authenticated),
      pairingRequired: Boolean(httpsState.pairingRequired),
      adbAvailable: Boolean(adbState.adbAvailable),
      eagerAdbConnect: false,
    });

    return {
      session: mergeSessionState(previousSession, {
        host: device.host,
        dialReachable: previousSession?.dialReachable ?? false,
        httpsReachable: Boolean(httpsState.httpsReachable),
        tlsReady: Boolean(httpsState.tlsReady),
        apiKeyAccepted: Boolean(httpsState.apiKeyAccepted),
        pairingRequired: Boolean(httpsState.pairingRequired),
        tokenPresent: Boolean(device.token),
        tokenValid: Boolean(httpsState.tokenValid),
        authenticated: Boolean(httpsState.authenticated),
        httpsTextAvailable: httpsState.authenticated,
        httpsAppListAvailable: httpsState.authenticated,
        httpsAppLaunchAvailable: false,
        adbAvailable: Boolean(adbState.adbAvailable),
        adbConnected: Boolean(previousSession?.adbConnected),
      }),
      result: {
        transportUsed: httpsState.authenticated ? "https" : null,
        https: httpsState,
        adb: adbState,
      },
    };
  }

  async refresh(device, previousSession = {}) {
    const httpsState = await this.fireTvHttpsTransport.probe(device);
    const adbState = this.adbTransport.getAvailability();

    return mergeSessionState(previousSession, {
      host: device.host,
      httpsReachable: Boolean(httpsState.httpsReachable),
      tlsReady: Boolean(httpsState.tlsReady),
      apiKeyAccepted: Boolean(httpsState.apiKeyAccepted),
      pairingRequired: Boolean(httpsState.pairingRequired),
      tokenPresent: Boolean(device.token),
      tokenValid: Boolean(httpsState.tokenValid),
      authenticated: Boolean(httpsState.authenticated),
      httpsTextAvailable: httpsState.authenticated,
      httpsAppListAvailable: httpsState.authenticated,
      httpsAppLaunchAvailable: false,
      adbAvailable: Boolean(adbState.adbAvailable),
      adbConnected: Boolean(previousSession?.adbConnected),
    });
  }

  async sendRemoteAction(device, session, action) {
    if (session?.authenticated) {
      try {
        const result = await this.fireTvHttpsTransport.sendRemoteAction(device, action);
        return {
          result,
          session: mergeSessionState(session, { authenticated: true, tokenValid: true, pairingRequired: false }),
        };
      } catch (error) {
        if (error?.code === "TOKEN_INVALID") {
          session = mergeSessionState(session, {
            authenticated: false,
            tokenValid: false,
            pairingRequired: true,
          });
        } else if (error?.code === "FIRETV_BACKEND_NPE") {
          this.logger.warn?.("Fire TV HTTPS remote action returned a backend exception after the request was accepted; suppressing ADB fallback to avoid duplicate input.", {
            host: device.host,
            action,
            message: error.message,
          });
          return {
            result: {
              ok: true,
              transportUsed: "https",
              assumedDelivered: true,
              warningCode: "FIRETV_BACKEND_NPE",
              warning: error.message,
            },
            session: mergeSessionState(session, {
              authenticated: true,
              tokenValid: true,
              pairingRequired: false,
            }),
          };
        } else {
          throw error;
        }
      }
    }

    session = await this.ensureAdbConnected(device, session, `remote:${action}`);

    if (session?.adbConnected) {
      const result = await this.adbTransport.sendRemoteAction(device, action);
      return { result, session };
    }

    throw createTransportError("REMOTE_UNAVAILABLE", "Remote control is unavailable until pairing completes or ADB connects.", {
      status: 409,
    });
  }

  async sendText(device, session, text) {
    if (session?.authenticated) {
      try {
        const keyboardState = await this.fireTvHttpsTransport.getKeyboardState(device);
        if (keyboardState.ready === true || keyboardState.ready === null) {
          const result = await this.fireTvHttpsTransport.sendText(device, text);
          return {
            result: {
              ...result,
              keyboardState,
            },
            session: mergeSessionState(session, { authenticated: true, tokenValid: true }),
          };
        }

        session = await this.ensureAdbConnected(device, session, "text:keyboard-fallback");

        if (session?.adbConnected) {
          const result = await this.adbTransport.sendText(device, text);
          return {
            result: {
              ...result,
              reason: "Fire TV keyboard is not active, so ADB text fallback was used.",
              keyboardState,
            },
            session,
          };
        }

        throw createTransportError(
          "TEXT_INPUT_UNAVAILABLE",
          "Open a text field on the Fire TV or connect ADB to send text.",
          { status: 409, details: keyboardState },
        );
      } catch (error) {
        if (error?.code === "TOKEN_INVALID") {
          session = mergeSessionState(session, {
            authenticated: false,
            tokenValid: false,
            pairingRequired: true,
          });
        } else if (
          error?.code !== "TEXT_FAILED" &&
          error?.code !== "KEYBOARD_STATE_FAILED" &&
          error?.code !== "FIRETV_BACKEND_NPE"
        ) {
          throw error;
        } else if (error?.code === "FIRETV_BACKEND_NPE") {
          this.logger.warn?.("Fire TV HTTPS text path failed with backend exception; evaluating ADB fallback.", {
            host: device.host,
            message: error.message,
          });
        }
      }
    }

    session = await this.ensureAdbConnected(device, session, "text:adb-fallback");

    if (session?.adbConnected) {
      const result = await this.adbTransport.sendText(device, text);
      return { result, session };
    }

    throw createTransportError("TEXT_INPUT_UNAVAILABLE", "Text input is unavailable until pairing completes or ADB connects.", {
      status: 409,
    });
  }

  async listApps(device, session) {
    let nextSession = session;
    let httpsApps = [];
    let adbApps = [];
    let httpsError = null;

    if (session?.authenticated) {
      try {
        httpsApps = await this.fireTvHttpsTransport.listApps(device);
      } catch (error) {
        httpsError = error;
        this.logger.warn?.("Fire TV HTTPS app listing failed; evaluating ADB fallback.", {
          host: device.host,
          code: error?.code || null,
          message: error?.message || "Unknown Fire TV app listing error.",
        });
      }
    }

    if (nextSession?.adbAvailable) {
      nextSession = await this.ensureAdbConnected(
        device,
        nextSession,
        httpsApps.length > 0 ? "apps:merge" : "apps:list-fallback",
      );
    }

    if (nextSession?.adbConnected) {
      try {
        adbApps = await this.adbTransport.listApps(device);
      } catch (error) {
        this.logger.warn?.("ADB app listing failed.", {
          host: device.host,
          code: error?.code || null,
          message: error?.message || "Unknown ADB app listing error.",
        });
        if (httpsApps.length === 0) {
          throw error;
        }
      }
    }

    const apps = mergeDiscoveredApps(httpsApps, adbApps);
    if (apps.length > 0) {
      return {
        result: {
          transportUsed: httpsApps.length > 0 && adbApps.length > 0
            ? "hybrid"
            : httpsApps.length > 0
            ? "https"
            : "adb",
          apps,
          sourceBreakdown: {
            https: httpsApps.length,
            adb: adbApps.length,
          },
        },
        session: nextSession,
      };
    }

    if (httpsError) {
      throw httpsError;
    }

    throw createTransportError("APP_LIST_UNAVAILABLE", "Installed app discovery is unavailable for this Fire TV.", {
      status: 409,
    });
  }

  async launchApp(device, session, appId) {
    session = await this.ensureAdbConnected(device, session, "app:launch");

    if (session?.adbConnected) {
      const result = await this.adbTransport.launchApp(device, appId);
      return { result, session };
    }

    throw createTransportError("APP_LAUNCH_UNAVAILABLE", "App launch currently requires an ADB connection.", {
      status: 409,
    });
  }

  async installApk(device, session, filePath, replaceExisting) {
    session = await this.ensureAdbConnected(device, session, "apk:install");

    if (session?.adbConnected) {
      const result = await this.adbTransport.installApk(device, filePath, replaceExisting);
      return { result, session };
    }

    throw createTransportError("SIDELOAD_UNAVAILABLE", "ADB is required for APK sideloading.", { status: 409 });
  }

  async swipe(device, session, gesture) {
    session = await this.ensureAdbConnected(device, session, "swipe");

    if (session?.adbConnected) {
      const result = await this.adbTransport.swipe(device, gesture);
      return { result, session };
    }

    throw createTransportError("SWIPE_UNAVAILABLE", "Swipe controls require an ADB connection.", { status: 409 });
  }
}

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
      state: session.adbState || "unknown",
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
    this.httpsRecovery = new Map();
  }

  async probeHttps(device) {
    let httpsState = await this.fireTvHttpsTransport.probe(device);

    if (httpsState?.httpsReachable === false) {
      try {
        await this.fireTvHttpsTransport.wake(device);
        const retriedState = await this.fireTvHttpsTransport.probe(device);
        httpsState = {
          ...retriedState,
          wakeAttempted: true,
          wakeSucceeded: true,
        };
      } catch (error) {
        this.logger.warn?.("Fire TV wake-and-retry probe failed.", {
          host: device.host,
          code: error?.code || "UNKNOWN",
          message: error?.message || "Unknown wake failure.",
        });
        httpsState = {
          ...httpsState,
          wakeAttempted: true,
          wakeSucceeded: false,
          wakeErrorCode: error?.code || null,
        };
      }
    }

    return httpsState;
  }

  async recoverHttps(device, session) {
    if (session?.authenticated || !device.token) return session;
    const key = device.host;
    const previous = this.httpsRecovery.get(key);
    if (previous && previous.token === device.token && Date.now() - previous.checkedAt < 3000) {
      return mergeSessionState(session, previous.pending ? await previous.pending : previous.updates);
    }
    const recovery = { checkedAt: Date.now(), token: device.token, pending: null, updates: {} };
    recovery.pending = (async () => {
      try {
        // Only check status; never replay the user's previous command or pair
        // automatically. A temporary outage must not pin the session to ADB.
        // Use the same wake-and-retry path as an explicit connect. A Fire TV
        // can close its control listener while idle even though it remains on
        // the network; a plain status probe would otherwise keep the app on
        // ADB until the user manually reconnects.
        const probe = await this.probeHttps(device);
        this.logger.info?.("HTTPS recovery probe completed.", {
          host: device.host, authenticated: Boolean(probe.authenticated),
          errorCode: probe.errorCode || null,
        });
        return {
          ...probe,
          httpsTextAvailable: Boolean(probe.authenticated),
          httpsAppListAvailable: Boolean(probe.authenticated),
          lastHttpsError: probe.authenticated ? null : probe.errorCode || null,
        };
      } catch (error) {
        this.logger.warn?.("HTTPS recovery probe failed.", { host: device.host, code: error.code });
        return { lastHttpsError: error.code || "HTTPS_PROBE_FAILED" };
      }
    })();
    this.httpsRecovery.set(key, recovery);
    const updates = await recovery.pending;
    recovery.updates = updates;
    recovery.pending = null;
    // Bound this cache for long-running standalone servers.
    if (this.httpsRecovery.size > 100) this.httpsRecovery.delete(this.httpsRecovery.keys().next().value);
    return mergeSessionState(session, updates);
  }

  markHttpsUnavailable(session, error) {
    const unavailableCodes = new Set([
      "HTTPS_UNREACHABLE",
      "TLS_FAILED",
      "REQUEST_TIMEOUT",
      "HTTPS_RESPONSE_INTERRUPTED",
      "HTTPS_REQUEST_FAILED",
    ]);
    if (!unavailableCodes.has(error?.code)) return session;
    return mergeSessionState(session, {
      httpsReachable: false,
      tlsReady: error.code !== "TLS_FAILED",
      apiKeyAccepted: false,
      authenticated: false,
      tokenValid: false,
      pairingRequired: false,
      httpsTextAvailable: false,
      httpsAppListAvailable: false,
      lastHttpsError: error.code,
    });
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

    if (typeof this.adbTransport.probe === "function") {
      const adbProbe = await this.adbTransport.probe(device);
      nextSession = mergeSessionState(nextSession, {
        adbAvailable: Boolean(adbProbe.adbAvailable),
        adbConnected: Boolean(adbProbe.adbConnected),
        adbState: adbProbe.adbState || "unknown",
      });

      if (adbProbe.adbConnected) {
        return nextSession;
      }
    } else if (nextSession?.adbConnected) {
      return nextSession;
    }

    const adbConnect = await this.adbTransport.connect(device);
    this.logger.info?.("ADB fallback connect attempt.", {
      host: device.host,
      reason,
      ok: Boolean(adbConnect.ok),
      adbHost: adbConnect.adbHost,
    });

    if (typeof this.adbTransport.probe === "function") {
      const postConnectProbe = await this.adbTransport.probe(device);
      nextSession = mergeSessionState(nextSession, {
        adbAvailable: Boolean(postConnectProbe.adbAvailable),
        adbConnected: Boolean(postConnectProbe.adbConnected),
        adbState: postConnectProbe.adbState || "unknown",
      });

      if (!postConnectProbe.adbConnected && postConnectProbe.adbState === "offline") {
        this.logger.warn?.("ADB remained offline after reconnect; running repair flow.", {
          host: device.host,
          reason,
          adbHost: postConnectProbe.adbHost,
        });
        const repairResult = await this.adbTransport.repair(device);
        nextSession = mergeSessionState(nextSession, {
          adbAvailable: true,
          adbConnected: Boolean(repairResult?.probe?.adbConnected),
          adbState: repairResult?.probe?.adbState || "unknown",
        });
      }
    } else {
      nextSession = mergeSessionState(nextSession, { adbConnected: Boolean(adbConnect.ok) });
    }

    return nextSession;
  }

  async connect(device, previousSession = {}) {
    this.httpsRecovery.delete(device.host);
    const httpsState = await this.probeHttps(device);
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
      adbState: previousSession?.adbState || "disconnected",
    }),
      result: {
        transportUsed: httpsState.authenticated ? "https" : null,
        https: httpsState,
        adb: adbState,
      },
    };
  }

  async refresh(device, previousSession = {}) {
    const httpsState = await this.probeHttps(device);
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
      adbState: previousSession?.adbState || "disconnected",
    });
  }

  async sendRemoteAction(device, session, action) {
    session = await this.recoverHttps(device, session);
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
          session = this.markHttpsUnavailable(session, error);
          this.logger.warn?.("Fire TV HTTPS remote action failed; evaluating ADB fallback.", {
            host: device.host,
            action,
            code: error?.code || "UNKNOWN",
            message: error?.message || "Unknown HTTPS remote failure.",
          });
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
    session = await this.recoverHttps(device, session);
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
        } else if (error?.code === "FIRETV_BACKEND_NPE") {
          this.logger.warn?.("Fire TV HTTPS text path failed with backend exception; evaluating ADB fallback.", {
            host: device.host,
            message: error.message,
          });
        } else if (
          error?.code === "TEXT_FAILED" ||
          error?.code === "KEYBOARD_STATE_FAILED" ||
          ["HTTPS_UNREACHABLE", "TLS_FAILED", "REQUEST_TIMEOUT", "HTTPS_RESPONSE_INTERRUPTED", "HTTPS_REQUEST_FAILED"].includes(error?.code)
        ) {
          session = this.markHttpsUnavailable(session, error);
        } else {
          throw error;
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
    session = await this.recoverHttps(device, session);
    let nextSession = session;
    let httpsApps = [];
    let adbApps = [];
    let httpsError = null;

    if (session?.authenticated) {
      try {
        httpsApps = await this.fireTvHttpsTransport.listApps(device);
      } catch (error) {
        httpsError = error;
        nextSession = this.markHttpsUnavailable(nextSession, error);
        this.logger.warn?.("Fire TV HTTPS app listing failed; evaluating ADB fallback.", {
          host: device.host,
          code: error?.code || null,
          message: error?.message || "Unknown Fire TV app listing error.",
        });
      }
    }

    const shouldAttemptAdbMerge = httpsApps.length === 0
      ? Boolean(nextSession?.adbAvailable)
      : Boolean(nextSession?.adbConnected);

    if (shouldAttemptAdbMerge) {
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
        nextSession = mergeSessionState(nextSession, { adbConnected: false });
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

    if (session?.adbState === "offline") {
      throw createTransportError(
        "ADB_OFFLINE",
        "ADB on this Fire TV is offline. Restart ADB debugging on the Fire TV, then press Repair ADB and Connect again.",
        { status: 409 },
      );
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

    if (session?.adbState === "offline") {
      throw createTransportError(
        "ADB_OFFLINE",
        "ADB on this Fire TV is offline. Restart ADB debugging on the Fire TV, then press Repair ADB and Connect again.",
        { status: 409 },
      );
    }

    throw createTransportError("SIDELOAD_UNAVAILABLE", "ADB is required for APK sideloading.", { status: 409 });
  }

  async swipe(device, session, gesture) {
    session = await this.ensureAdbConnected(device, session, "swipe");

    if (session?.adbConnected) {
      const result = await this.adbTransport.swipe(device, gesture);
      return { result, session };
    }

    if (session?.adbState === "offline") {
      throw createTransportError(
        "ADB_OFFLINE",
        "ADB on this Fire TV is offline. Restart ADB debugging on the Fire TV, then press Repair ADB and Connect again.",
        { status: 409 },
      );
    }

    throw createTransportError("SWIPE_UNAVAILABLE", "Swipe controls require an ADB connection.", { status: 409 });
  }
}

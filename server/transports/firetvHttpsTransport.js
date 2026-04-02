import http from "http";

import { getDialBaseUrl } from "../utils/hostNormalization.js";
import { createTransportError } from "../utils/transportErrors.js";

function parseJsonBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (_) {
    return null;
  }
}

function containsBackendNullPointer(bodyText) {
  return /java\.lang\.NullPointerException/i.test(String(bodyText || ""));
}

function createEndpointError(code, defaultMessage, response, endpointPath, extra = {}) {
  const backendNullPointer = containsBackendNullPointer(response?.bodyText);
  const message = backendNullPointer
    ? `Fire TV backend exception on ${endpointPath}: ${response.bodyText || defaultMessage}`
    : response?.bodyText || defaultMessage;

  return createTransportError(
    backendNullPointer ? "FIRETV_BACKEND_NPE" : code,
    message,
    {
      status: backendNullPointer ? 502 : (response?.statusCode || 502),
      details: {
        endpointPath,
        backendNullPointer,
        response,
        ...extra,
      },
    },
  );
}

function buildUnauthorizedState(bodyText, hasToken) {
  const lower = String(bodyText || "").toLowerCase();
  const missingToken = lower.includes("missing client token");
  const invalidToken = lower.includes("invalid") || lower.includes("expired");

  return {
    httpsReachable: true,
    tlsReady: true,
    apiKeyAccepted: true,
    pairingRequired: missingToken || !hasToken,
    tokenPresent: hasToken,
    tokenValid: hasToken ? !invalidToken && !missingToken : false,
    authenticated: false,
  };
}

function inferKeyboardReady(data) {
  if (!data || typeof data !== "object") return null;
  const candidates = [
    data?.keyboardVisible,
    data?.isKeyboardVisible,
    data?.visible,
    data?.isVisible,
    data?.focused,
    data?.isFocused,
    data?.enabled,
    data?.isEnabled,
    data?.acceptingInput,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "boolean") return candidate;
  }

  return null;
}

function normalizeAppsResponse(data) {
  if (Array.isArray(data)) {
    return data.map((app) => {
      const id = String(app?.appId || app?.packageName || app?.id || app?.package || "").trim();
      if (!id) return null;
      return {
        id,
        name: String(app?.name || app?.title || id),
        sourceTransport: "https",
      };
    }).filter(Boolean);
  }

  const appArrays = [
    data?.apps,
    data?.applications,
    data?.items,
    data?.value,
  ];

  const found = appArrays.find(Array.isArray);
  return found ? normalizeAppsResponse(found) : [];
}

export class FireTvHttpsTransport {
  constructor({ fireTvRequest }) {
    this.fireTvRequest = fireTvRequest;
    this.httpAgent = new http.Agent({
      keepAlive: true,
    });
  }

  async request(device, { method = "GET", path = "/", body = null, authRequired = false, useDial = false, disableKeepAlive = false }) {
    if (useDial) {
      const baseUrl = getDialBaseUrl(device.host);
      const url = new URL(path, `${baseUrl}/`);

      return new Promise((resolve, reject) => {
        const req = http.request(url, {
          method,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": body == null ? 0 : Buffer.byteLength(JSON.stringify(body)),
          },
          agent: this.httpAgent,
        }, (res) => {
          let raw = "";
          res.on("data", (chunk) => {
            raw += chunk.toString();
          });
          res.on("end", () => {
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              bodyText: raw,
              data: parseJsonBody(raw),
            });
          });
        });

        req.on("error", (error) => {
          reject(createTransportError("DIAL_REQUEST_FAILED", error?.message || "DIAL request failed.", { details: error }));
        });

        req.end(body == null ? "" : JSON.stringify(body));
      });
    }

    return this.fireTvRequest(device, path, {
      method,
      body,
      authRequired,
      disableKeepAlive,
      token: device.token,
    });
  }

  async probe(device) {
    try {
      const response = await this.request(device, {
        method: "GET",
        path: "/v1/FireTV/status",
      });

      if (response.statusCode === 200) {
        return {
          httpsReachable: true,
          tlsReady: true,
          apiKeyAccepted: true,
          pairingRequired: false,
          tokenPresent: Boolean(device.token),
          tokenValid: Boolean(device.token),
          authenticated: true,
          status: response.data || null,
        };
      }

      if (response.statusCode === 401 || response.statusCode === 403) {
        return buildUnauthorizedState(response.bodyText, Boolean(device.token));
      }

      throw createTransportError(
        "HTTPS_PROBE_FAILED",
        response.bodyText || "Failed to probe the Fire TV HTTPS service.",
        { details: response },
      );
    } catch (error) {
      if (error?.code === "HTTPS_UNREACHABLE" || error?.code === "TLS_FAILED" || error?.code === "REQUEST_TIMEOUT") {
        return {
          httpsReachable: false,
          tlsReady: error.code !== "TLS_FAILED",
          apiKeyAccepted: false,
          pairingRequired: false,
          tokenPresent: Boolean(device.token),
          tokenValid: false,
          authenticated: false,
          errorCode: error.code,
        };
      }
      throw error;
    }
  }

  async wake(device) {
    const response = await this.request(device, {
      method: "POST",
      path: "/apps/FireTVRemote",
      useDial: true,
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, statusCode: response.statusCode, transportUsed: "dial" };
    }

    throw createTransportError("DIAL_WAKE_FAILED", response.bodyText || "Failed to wake Fire TV remote service.", {
      details: response,
    });
  }

  async pairStart(device, friendlyName) {
    const response = await this.request(device, {
      method: "POST",
      path: "/v1/FireTV/pin/display",
      body: { friendlyName },
      disableKeepAlive: true,
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, transportUsed: "https", data: response.data || null };
    }

    throw createTransportError("PAIR_START_FAILED", response.bodyText || "Failed to start Fire TV pairing.", {
      status: response.statusCode || 502,
      details: response,
    });
  }

  async pairVerify(device, pin) {
    const response = await this.request(device, {
      method: "POST",
      path: "/v1/FireTV/pin/verify",
      body: { pin: String(pin || "") },
      disableKeepAlive: true,
    });

    if (response.statusCode >= 200 && response.statusCode < 300 && response.data?.description) {
      return {
        ok: true,
        transportUsed: "https",
        token: String(response.data.description),
        data: response.data,
      };
    }

    throw createTransportError("PAIR_VERIFY_FAILED", response.bodyText || "Failed to verify the Fire TV PIN.", {
      status: response.statusCode || 502,
      details: response,
    });
  }

  async getStatus(device) {
    const response = await this.request(device, {
      method: "GET",
      path: "/v1/FireTV/status",
      authRequired: true,
    });

    if (response.statusCode === 200) {
      return response.data || null;
    }

    if (response.statusCode === 401 || response.statusCode === 403) {
      throw createTransportError("TOKEN_INVALID", "The Fire TV client token is invalid or expired.", { status: 401 });
    }

    throw createTransportError("STATUS_FAILED", response.bodyText || "Failed to fetch Fire TV status.", {
      details: response,
    });
  }

  async getProperties(device) {
    const response = await this.request(device, {
      method: "GET",
      path: "/v1/FireTV/properties",
      authRequired: true,
    });

    if (response.statusCode === 200) {
      return response.data || null;
    }

    throw createTransportError("PROPERTIES_FAILED", response.bodyText || "Failed to fetch Fire TV properties.", {
      details: response,
    });
  }

  async getKeyboardState(device) {
    const endpointPath = "/v1/FireTV/keyboard";
    const response = await this.request(device, {
      method: "GET",
      path: endpointPath,
      authRequired: true,
    });

    if (response.statusCode === 200) {
      return {
        raw: response.data || null,
        ready: inferKeyboardReady(response.data),
      };
    }

    throw createEndpointError("KEYBOARD_STATE_FAILED", "Failed to fetch Fire TV keyboard state.", response, endpointPath);
  }

  async sendRemoteAction(device, action) {
    const endpointPath = `/v1/FireTV?action=${encodeURIComponent(action)}`;
    const response = await this.request(device, {
      method: "POST",
      path: endpointPath,
      body: {},
      authRequired: true,
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, transportUsed: "https", data: response.data || null };
    }

    if (response.statusCode === 401 || response.statusCode === 403) {
      throw createTransportError("TOKEN_INVALID", "The Fire TV client token is invalid or expired.", { status: 401 });
    }

    throw createEndpointError(
      "REMOTE_ACTION_FAILED",
      `Failed to send Fire TV action "${action}".`,
      response,
      endpointPath,
      { action },
    );
  }

  async sendText(device, text) {
    const endpointPath = "/v1/FireTV/text";
    const response = await this.request(device, {
      method: "POST",
      path: endpointPath,
      body: { text },
      authRequired: true,
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { ok: true, transportUsed: "https", data: response.data || null };
    }

    throw createEndpointError("TEXT_FAILED", "Failed to send text to Fire TV.", response, endpointPath);
  }

  async listApps(device) {
    const endpointPath = "/v1/FireTV/appsV2";
    const response = await this.request(device, {
      method: "GET",
      path: endpointPath,
      authRequired: true,
    });

    if (response.statusCode === 200) {
      return normalizeAppsResponse(response.data);
    }

    throw createEndpointError("APPS_FAILED", "Failed to list Fire TV apps.", response, endpointPath);
  }
}

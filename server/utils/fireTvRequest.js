import https from "https";
import { randomUUID } from "crypto";

import { getHttpsBaseUrl } from "./hostNormalization.js";
import { createTransportError } from "./transportErrors.js";

const FIRETV_API_KEY = "0987654321";
const REQUEST_TIMEOUT_MS = 4000;

function parseJsonBody(body) {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch (_) {
    return null;
  }
}

function getTokenPreview(token) {
  if (!token) return "(missing)";
  return `${token.slice(0, 4)}...`;
}

function getBodyPreview(bodyText) {
  const text = String(bodyText || "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

export function createFireTvRequest({ devicesStore, logger = console }) {
  const httpsAgent = new https.Agent({
    keepAlive: true,
    rejectUnauthorized: false,
  });
  const nonKeepAliveAgent = new https.Agent({
    keepAlive: false,
    rejectUnauthorized: false,
  });
  const hostQueues = new Map();

  async function enqueue(host, work) {
    const key = String(host || "");
    const previous = hostQueues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    hostQueues.set(key, next.finally(() => {
      if (hostQueues.get(key) === next) {
        hostQueues.delete(key);
      }
    }));
    return next;
  }

  return async function fireTvRequest(hostOrDevice, requestPath, options = {}) {
    const requestId = randomUUID().slice(0, 8);
    const explicitDevice = hostOrDevice && typeof hostOrDevice === "object" ? hostOrDevice : null;
    const normalizedHost = String(explicitDevice?.host || hostOrDevice || "").trim();
    const persistedDevice = devicesStore.findDeviceByHost(normalizedHost);
    const device = explicitDevice || persistedDevice;
    const knownDevices = devicesStore.listDevices();
    const token = options.token || device?.token || device?.clientToken || "";
    const authRequired = options.authRequired !== false;

    if (!normalizedHost) {
      throw createTransportError("INVALID_HOST", "A valid Fire TV host is required.", { status: 400 });
    }

    if (authRequired && !token) {
      logger.warn?.("Missing client token before Fire TV request.", {
        requestId,
        host: normalizedHost,
        path: requestPath,
        authRequired,
        matchedDevice: persistedDevice
          ? {
              id: persistedDevice.id,
              name: persistedDevice.name,
              host: persistedDevice.host,
              tokenExists: Boolean(persistedDevice.token || persistedDevice.clientToken),
            }
          : null,
        explicitDevice: explicitDevice
          ? {
              id: explicitDevice.id || null,
              name: explicitDevice.name || null,
              host: explicitDevice.host,
              tokenExists: Boolean(explicitDevice.token || explicitDevice.clientToken || options.token),
            }
          : null,
        knownHosts: knownDevices.slice(0, 10).map((entry) => ({
          id: entry.id,
          name: entry.name,
          host: entry.host,
          tokenExists: Boolean(entry.token || entry.clientToken),
        })),
      });
      throw createTransportError("MISSING_CLIENT_TOKEN", "Device not paired: missing client token", {
        status: 401,
        details: {
          requestId,
          host: normalizedHost,
          matchedDevice: persistedDevice ? { id: persistedDevice.id, name: persistedDevice.name, host: persistedDevice.host } : null,
          explicitDevice: explicitDevice ? { host: explicitDevice.host, id: explicitDevice.id || null } : null,
        },
      });
    }

    const baseUrl = getHttpsBaseUrl(normalizedHost);
    const url = new URL(requestPath, `${baseUrl}/`);
    const bodyText = options.body == null ? "" : JSON.stringify(options.body);
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(bodyText),
      "x-api-key": FIRETV_API_KEY,
      ...options.headers,
    };

    if (token) {
      headers["x-client-token"] = token;
    }

    if (options.disableKeepAlive) {
      headers.Connection = "close";
    }

    logger.info?.("Sending Fire TV HTTPS request.", {
      requestId,
      host: normalizedHost,
      path: requestPath,
      method: options.method || "GET",
      authRequired,
      matchedDevice: persistedDevice
        ? {
            id: persistedDevice.id,
            name: persistedDevice.name,
            host: persistedDevice.host,
          }
        : null,
      explicitDevice: explicitDevice
        ? {
            id: explicitDevice.id || null,
            name: explicitDevice.name || null,
            host: explicitDevice.host,
          }
        : null,
      tokenExists: Boolean(token),
      tokenPreview: getTokenPreview(token),
      headerSummary: {
        hasApiKey: Boolean(headers["x-api-key"]),
        hasClientToken: Boolean(headers["x-client-token"]),
        contentLength: headers["Content-Length"],
      },
    });

    async function attemptRequest(attemptOptions) {
      return new Promise((resolve, reject) => {
        const req = https.request(url, {
          method: options.method || "GET",
          headers: {
            ...headers,
            ...(attemptOptions.disableKeepAlive ? { Connection: "close" } : {}),
          },
          agent: attemptOptions.disableKeepAlive ? nonKeepAliveAgent : httpsAgent,
        }, (res) => {
          let raw = "";
          res.on("data", (chunk) => {
            raw += chunk.toString();
          });
          res.on("end", () => {
            logger.info?.("Received Fire TV HTTPS response.", {
              requestId,
              host: normalizedHost,
              path: requestPath,
              method: options.method || "GET",
              statusCode: res.statusCode || 0,
              tokenExists: Boolean(token),
              responsePreview: getBodyPreview(raw),
              disableKeepAlive: attemptOptions.disableKeepAlive,
            });
            resolve({
              statusCode: res.statusCode || 0,
              headers: res.headers,
              bodyText: raw,
              data: parseJsonBody(raw),
            });
          });
        });

        req.setTimeout(options.timeoutMs || REQUEST_TIMEOUT_MS, () => {
          req.destroy(createTransportError("REQUEST_TIMEOUT", "The Fire TV request timed out.", { status: 504 }));
        });

        req.on("error", async (error) => {
          logger.error?.("Fire TV HTTPS request failed.", {
            requestId,
            host: normalizedHost,
            path: requestPath,
            method: options.method || "GET",
            tokenExists: Boolean(token),
            tokenPreview: getTokenPreview(token),
            errorCode: error?.code || null,
            errorMessage: error?.message || String(error),
            disableKeepAlive: attemptOptions.disableKeepAlive,
          });

          if (
            error?.code === "ECONNRESET" &&
            !attemptOptions.disableKeepAlive &&
            attemptOptions.retryOnConnectionReset !== false
          ) {
            logger.warn?.("Retrying Fire TV HTTPS request with keep-alive disabled after connection reset.", {
              requestId,
              host: normalizedHost,
              path: requestPath,
            });
            try {
              const retryResult = await attemptRequest({
                ...attemptOptions,
                disableKeepAlive: true,
                retryOnConnectionReset: false,
              });
              resolve(retryResult);
            } catch (retryError) {
              reject(retryError);
            }
            return;
          }

          if (error?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || error?.code === "SELF_SIGNED_CERT_IN_CHAIN") {
            reject(createTransportError("TLS_FAILED", "The Fire TV TLS session could not be established.", { details: error }));
            return;
          }

          if (error?.code === "ECONNRESET" || error?.code === "ECONNREFUSED" || error?.code === "EHOSTUNREACH") {
            reject(createTransportError("HTTPS_UNREACHABLE", "The Fire TV HTTPS remote service is unreachable.", { details: error }));
            return;
          }

          if (error?.code === "REQUEST_TIMEOUT") {
            reject(error);
            return;
          }

          reject(createTransportError("HTTPS_REQUEST_FAILED", error?.message || "Fire TV HTTPS request failed.", {
            details: error,
          }));
        });

        req.end(bodyText);
      });
    }

    return enqueue(normalizedHost, () => attemptRequest({
      disableKeepAlive: Boolean(options.disableKeepAlive),
      retryOnConnectionReset: options.retryOnConnectionReset !== false,
    }));
  };
}

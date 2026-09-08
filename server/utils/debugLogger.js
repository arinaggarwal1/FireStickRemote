import fs from "node:fs";
import path from "node:path";

function shouldLog(level) {
  const enabled = String(process.env.FIRETV_DEBUG || "").trim().toLowerCase();
  if (!enabled) return level !== "debug";
  if (["1", "true", "all", "debug"].includes(enabled)) return true;
  if (enabled === "info") return level !== "debug";
  return level === "warn" || level === "error";
}

// A small, bounded transport trace survives desktop restarts. Deliberately
// exclude tokens, response bodies, pairing PINs, text, and app launch payloads.
const diagnosticFields = ["host", "path", "method", "statusCode", "errorCode", "code", "reason", "action", "reusedSocket", "disableKeepAlive", "authenticated", "httpsReachable", "pairingRequired"];
function persistDiagnostic(level, scope, message, details) {
  if (!process.env.APP_DATA_DIR || !/HTTPS|fallback|Hybrid connect/.test(message)) return;
  try {
    const directory = path.join(process.env.APP_DATA_DIR, "logs");
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "connection.log");
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) {
      fs.renameSync(file, `${file}.previous`);
    }
    const safeDetails = Object.fromEntries(diagnosticFields
      .filter(key => details?.[key] !== undefined)
      .map(key => [key, details[key]]));
    fs.appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), level, scope, message, ...safeDetails })}\n`, { mode: 0o600 });
  } catch (_) { /* Diagnostic I/O must never interrupt remote control. */ }
}

function emit(level, scope, message, details) {
  persistDiagnostic(level, scope, message, details);
  if (!shouldLog(level)) return;
  const prefix = `[${new Date().toISOString()}] [${scope}] ${message}`;
  const writer = console[level] || console.log;
  if (details === undefined) writer(prefix);
  else writer(prefix, details);
}

export function createDebugLogger(scope) {
  return Object.fromEntries(["debug", "info", "warn", "error"].map(level => [level,
    (message, details) => emit(level, scope, message, details),
  ]));
}

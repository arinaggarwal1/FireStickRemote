function shouldLog(level) {
  const enabled = String(process.env.FIRETV_DEBUG || "").trim().toLowerCase();
  if (!enabled) return level !== "debug";
  if (enabled === "1" || enabled === "true" || enabled === "all") return true;
  if (enabled === "debug") return true;
  if (enabled === "info") return level !== "debug";
  return level === "warn" || level === "error";
}

function emit(level, scope, message, details) {
  if (!shouldLog(level)) return;
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${scope}]`;
  if (details === undefined) {
    console[level]?.(`${prefix} ${message}`) ?? console.log(`${prefix} ${message}`);
    return;
  }

  console[level]?.(`${prefix} ${message}`, details) ?? console.log(`${prefix} ${message}`, details);
}

export function createDebugLogger(scope) {
  return {
    debug(message, details) {
      emit("debug", scope, message, details);
    },
    info(message, details) {
      emit("info", scope, message, details);
    },
    warn(message, details) {
      emit("warn", scope, message, details);
    },
    error(message, details) {
      emit("error", scope, message, details);
    },
  };
}

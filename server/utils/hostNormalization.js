function stripScheme(value) {
  return String(value || "").trim().replace(/^https?:\/\//i, "");
}

export function stripPort(input) {
  const raw = stripScheme(input);
  if (!raw) return "";

  if (raw.startsWith("[") && raw.includes("]")) {
    const end = raw.indexOf("]");
    return raw.slice(1, end);
  }

  const colonCount = (raw.match(/:/g) || []).length;
  if (colonCount > 1) return raw;

  return raw.replace(/:\d+$/, "");
}

export function normalizeDeviceHost(input) {
  const raw = stripScheme(input).replace(/\/+$/, "");
  if (!raw) return "";

  if (raw.startsWith("[") && raw.includes("]")) {
    return raw;
  }

  return raw;
}

export function getHttpsBaseUrl(host) {
  const bareHost = stripPort(host);
  return bareHost ? `https://${bareHost}:8080` : "";
}

export function getDialBaseUrl(host) {
  const bareHost = stripPort(host);
  return bareHost ? `http://${bareHost}:8009` : "";
}

export function getAdbTargetHost(host, fallbackPort = 5555) {
  const normalized = normalizeDeviceHost(host);
  if (!normalized) return "";

  if (normalized.startsWith("[") && normalized.includes("]")) {
    const remainder = normalized.slice(normalized.indexOf("]") + 1);
    return remainder.startsWith(":") ? normalized : `${normalized}:${fallbackPort}`;
  }

  const colonCount = (normalized.match(/:/g) || []).length;
  if (colonCount === 0) {
    return `${normalized}:${fallbackPort}`;
  }

  if (colonCount === 1 && /:\d+$/.test(normalized)) {
    return normalized;
  }

  return `${normalized}:${fallbackPort}`;
}

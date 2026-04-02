export class TransportError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.status = options.status ?? 502;
    this.details = options.details ?? null;
  }
}

export function createTransportError(code, message, options) {
  return new TransportError(code, message, options);
}

export function asTransportError(error, fallbackCode = "TRANSPORT_ERROR", fallbackMessage = "Transport request failed.") {
  if (error instanceof TransportError) return error;
  return new TransportError(
    fallbackCode,
    error?.message || fallbackMessage,
    { details: error && typeof error === "object" ? error : null },
  );
}

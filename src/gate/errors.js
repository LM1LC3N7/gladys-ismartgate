// -----------------------------------------------------------------------------
// The failures of a request to the gateway, by kind. Messages are our own
// words only: never an address, a path (it carries the sealed credentials), a
// header, a user name, a password or a body.
// -----------------------------------------------------------------------------

/**
 * - timeout:     no complete answer in time
 * - unreachable: no connection, or a connection lost
 * - late:        a command could not leave before its deadline (nothing sent)
 * - busy:        HTTP 429 or 5xx, the gateway asks for a pause
 * - http:        another HTTP status
 * - invalid:     not an answer of the gateway (not sealed with this key, not XML...)
 * - tooLarge:    the answer exceeds the size cap
 * - auth:        the API refused the user name or the password
 * - api:         another error of the API (`code`, `reason`: apiCode, door, option...)
 * - notDone:     an activation answered without "OK"
 */
export class GateError extends Error {
  constructor(kind, { status, code, reason, sent = false, retryAfter } = {}) {
    super(
      status ? `${kind} (HTTP ${status})` : code !== undefined ? `${kind} (code ${code})` : kind,
    );
    this.name = 'GateError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.reason = reason;
    this.sent = sent;
    this.retryAfter = retryAfter;
  }
}

/** A short reason for the logs and the user: the kind, and the status or code if any. */
export const reasonOf = (err) => (err instanceof GateError ? err.message : 'unexpected error');

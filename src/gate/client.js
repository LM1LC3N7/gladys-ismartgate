// -----------------------------------------------------------------------------
// The local API of the ismartgate and GogoGate2 gateways, after the
// ismartgate library (MIT, the one Home Assistant uses): one `GET /api.php`
// per call, two options:
//   - `info`: the gateway and its three doors (state, mode, sensors, and the
//     activation code each command needs);
//   - `activate`: ONE PULSE on the relay of a door. The gateway has no
//     "open" nor "close": a pulse while the door moves may stop or reverse
//     it. src/app.js decides when a pulse may go.
// This API is not documented by the maker: every answer is size-capped,
// parsed once, and anything unexpected is "invalid".
// -----------------------------------------------------------------------------

import { randomInt } from 'node:crypto';
import { API_ERRORS, DEVICE_TYPES, LIMITS, TIMINGS } from '../constants.js';
import { keyOf, pythonJson, seal, tokenOf, unseal } from './cipher.js';
import { GateError } from './errors.js';
import { httpGet } from './http.js';
import { activatedOf, errorOf, parseInfo } from './parse.js';
import { parseXml } from './xml.js';

/** Retry-After in ms (seconds or an HTTP date), or undefined. */
export function retryAfterOf(header, now = Date.now()) {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.length > 64) {
    return undefined;
  }
  if (/^\s*\d{1,9}\s*$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export class GateClient {
  constructor({ request = httpGet, timeout = TIMINGS.readTimeout, now = Date.now } = {}) {
    this.request = request;
    this.timeout = timeout;
    this.now = now;
  }

  /**
   * One call. `gateway`: `{ type, address: { host, port }, auth: { username, password } }`.
   * @param {object} [options]
   * @param {number} [options.timeout] ms for the whole exchange
   * @param {number} [options.sendWithin] ms to start, else not sent ('late')
   * @param {() => void} [options.beforeSend]
   * @returns {Promise<object>} the root element of the answer
   */
  async call(gateway, option, args, { timeout, sendWithin, beforeSend } = {}) {
    const { type, address, auth } = gateway;
    const key = keyOf(type, auth.username, auth.password);
    const sealed = seal(
      key,
      pythonJson([auth.username, auth.password, option, args[0] ?? '', args[1] ?? '']),
    );
    let path = `/api.php?data=${encodeURIComponent(sealed)}`;
    if (type === DEVICE_TYPES.ISMARTGATE) {
      path += `&t=${randomInt(1, 100_000_001)}&token=${tokenOf(auth.username)}`;
    }
    const answer = await this.request({
      host: address.host,
      port: address.port,
      path,
      timeout: timeout ?? this.timeout,
      sendWithin,
      maxBytes: LIMITS.responseBytes,
      beforeSend,
    });
    const { status } = answer;
    if (status === 429 || (status >= 500 && status <= 599)) {
      throw new GateError('busy', {
        status,
        sent: true,
        retryAfter: retryAfterOf(answer.headers?.['retry-after'], this.now()),
      });
    }
    if (status < 200 || status > 299) {
      throw new GateError('http', { status, sent: true });
    }
    const raw = answer.body.toString('utf8');
    let text;
    const plain = raw.trimStart().startsWith('<');
    if (plain) {
      // The errors come back in clear (checked below: nothing else may).
      text = raw;
    } else {
      try {
        text = unseal(key, raw.trim());
      } catch {
        // Not sealed with this key: on an ismartgate, the user name and the
        // password give the key, so wrong credentials may end here too.
        throw new GateError('invalid', { sent: true });
      }
    }
    let root;
    try {
      root = parseXml(text);
    } catch {
      throw new GateError('invalid', { sent: true });
    }
    const error = errorOf(root);
    if (plain && !error) {
      // An answer in clear that is not an error: not sealed with the key of
      // these credentials, so not the gateway's (anything else at the
      // address could forge a state or an identity).
      throw new GateError('invalid', { sent: true });
    }
    if (error) {
      const reason = API_ERRORS[type][error.code] ?? 'other';
      throw new GateError(reason === 'auth' ? 'auth' : 'api', {
        code: error.code,
        reason,
        sent: true,
      });
    }
    return root;
  }

  /** The gateway and its doors; `withCodes` keeps the activation codes (commands only). */
  async info(gateway, { withCodes = false, ...options } = {}) {
    const root = await this.call(gateway, 'info', [], options);
    try {
      return parseInfo(gateway.type, root, { withCodes });
    } catch {
      throw new GateError('invalid', { sent: true });
    }
  }

  /** One pulse on the relay of a door. Resolves when the gateway answered "OK". */
  async activate(gateway, doorId, apiCode, options) {
    const root = await this.call(gateway, 'activate', [String(doorId), apiCode], options);
    if (!activatedOf(root)) {
      throw new GateError('notDone', { sent: true });
    }
  }
}

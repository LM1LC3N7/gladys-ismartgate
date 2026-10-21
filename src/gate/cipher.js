// -----------------------------------------------------------------------------
// The envelope of the gateway's local API, ported from the ismartgate library
// (MIT, bdraco and vangorra, the one Home Assistant uses): every request is
// `GET /api.php?data=<sealed>` where <sealed> is the JSON array
// [user, password, option, arg1, arg2] put through AES-128-CBC with PKCS#7
// padding, written as 16 initialisation characters followed by the base64 of
// the result; the answer comes back the same way (errors in clear).
//
//   - ismartgate: the key is taken from SHA-1(lower(user) + password), and
//     `token` = SHA-1(lower(user) + "@ismartgate") goes with every request;
//   - GogoGate2: the key is a fixed value, the same on every unit, published
//     in that library. Anyone who captures the traffic on the local network
//     can read the user name and the password: the docs say so.
//
// Not a protection Gladys relies on: the credentials are what the gateway
// asks for. Nothing here is logged.
// -----------------------------------------------------------------------------

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { DEVICE_TYPES, GOGOGATE2_SHARED_KEY } from '../constants.js';

const sha1 = (text) => createHash('sha1').update(text, 'utf8').digest('hex');

/** The 16-byte key of a gateway (ismartgate ApiCipher subclasses). */
export function keyOf(type, username, password) {
  if (type === DEVICE_TYPES.GOGOGATE2) {
    return Buffer.from(GOGOGATE2_SHARED_KEY, 'utf8');
  }
  const h = sha1(username.toLowerCase() + password);
  return Buffer.from(
    `${h.slice(32, 36)}a${h.slice(7, 10)}!${h.slice(18, 21)}*#${h.slice(24, 26)}`,
    'utf8',
  );
}

/** The `token` parameter of an ismartgate request. */
export const tokenOf = (username) => sha1(`${username.toLowerCase()}@ismartgate`);

/**
 * The JSON array of a request as Python's `json.dumps` writes it (what the
 * library sends): ", " between the items and every character above 0x7f
 * escaped as \uXXXX (ensure_ascii), so the text is plain ASCII.
 */
export function pythonJson(items) {
  return `[${items.map((item) => JSON.stringify(String(item))).join(', ')}]`.replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Seals a request: 16 initialisation characters (hexadecimal), then the base64. */
export function seal(key, text, iv = randomBytes(8).toString('hex')) {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.from(iv, 'ascii'));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv}${body.toString('base64')}`;
}

/**
 * Opens an answer. Throws on anything that is not a sealed text of this key
 * (bad characters, bad length, bad padding): the caller says "invalid".
 */
export function unseal(key, text) {
  if (typeof text !== 'string' || text.length < 16 + 24 || !/^[\x21-\x7e]{16}/.test(text)) {
    throw new Error('not sealed');
  }
  // Python's b64decode drops the line breaks a PHP answer may end with.
  const base64 = text.slice(16).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
    throw new Error('not sealed');
  }
  const body = Buffer.from(base64, 'base64');
  if (body.length === 0 || body.length % 16 !== 0) {
    throw new Error('not sealed');
  }
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.from(text.slice(0, 16), 'ascii'));
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The user name and
// the password are kept here only: never logged, never in /data (only the
// salted fingerprint of a pair the gateway REFUSED, see src/store.js), never
// in a status or an error.
// -----------------------------------------------------------------------------

import { DEVICE_TYPES, POLL_INTERVAL, TRAVEL_TIME } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  device_type: DEVICE_TYPES.ISMARTGATE,
  host: '',
  poll_interval: POLL_INTERVAL.default,
  allow_open: false,
  travel_time: TRAVEL_TIME.default,
  language: 'fr',
};

/** The optional fields without a default in the manifest (the password is a secret). */
const OPTIONAL = { username: '', password: '' };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** No control character; the gateway's web interface accepts the rest. */
const CREDENTIAL = {
  test: (text) => [...text].every((c) => c.codePointAt(0) >= 0x20 && c.codePointAt(0) !== 0x7f),
};

/** A text read from the gateway, without control characters, trimmed and cut. */
export function cleanText(value, max) {
  if (typeof value !== 'string') {
    return '';
  }
  let out = '';
  for (const char of value.slice(0, max * 2)) {
    const code = char.codePointAt(0);
    if (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f)) {
      out += char;
    }
  }
  return out.trim().slice(0, max);
}

/**
 * The address typed by the user: an IPv4 address or a host name, with an
 * optional port. A pasted URL ("http://192.168.1.30/index.php") is reduced to
 * its host. Credentials in it ("user:pass@host") are refused and never shown.
 * @returns {{ address?: { host: string, port: number }, invalid?: string, credentials?: boolean }}
 */
export function parseHost(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return {};
  }
  if (text.includes('@')) {
    return { credentials: true };
  }
  if (text.length > 260) {
    return { invalid: `${text.slice(0, 40)}…` };
  }
  const shown = text.slice(0, 60);
  text = text.replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '');
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(text.toLowerCase());
  if (!match) {
    return { invalid: shown };
  }
  const [, host, portText] = match;
  const port = portText === undefined ? 80 : Number(portText);
  if (port < 1 || port > 65535 || host.length > 253) {
    return { invalid: shown };
  }
  const valid =
    IPV4.test(host) || (!/^[\d.]+$/.test(host) && host.split('.').every((l) => LABEL.test(l)));
  return valid ? { address: { host, port } } : { invalid: shown };
}

/** `host` or `host:port` (port 80 left out): the key of the gateway in /data. */
export const addressKey = (address) =>
  address ? (address.port === 80 ? address.host : `${address.host}:${address.port}`) : '';

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
export function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d{1,6}(\.\d{1,6})?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

const bounded = (value, { default: fallback, min, max }) => {
  const number = numberOf(value);
  return number === undefined ? fallback : Math.min(max, Math.max(min, Math.round(number)));
};

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, ...OPTIONAL };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (Object.hasOwn(c, key) && value != null) {
      c[key] = value;
    }
  }
  const host = parseHost(c.host);
  const username = typeof c.username === 'string' ? c.username.trim() : '';
  const password = typeof c.password === 'string' ? c.password : '';
  let badAuth;
  if (username === '' || password === '') {
    badAuth = 'missing';
  } else if (
    username.length > 64 ||
    password.length > 128 ||
    !CREDENTIAL.test(username) ||
    !CREDENTIAL.test(password)
  ) {
    badAuth = 'invalid';
  }
  return {
    type:
      c.device_type === DEVICE_TYPES.GOGOGATE2 ? DEVICE_TYPES.GOGOGATE2 : DEVICE_TYPES.ISMARTGATE,
    address: host.address,
    invalidHost: host.invalid,
    credentialsInHost: Boolean(host.credentials),
    /** `{ username, password }`, or undefined (missing or unusable: said in the status). */
    auth: badAuth ? undefined : { username, password },
    badAuth,
    allowOpen: strictTrue(c.allow_open),
    pollInterval: bounded(c.poll_interval, POLL_INTERVAL),
    travelTime: bounded(c.travel_time, TRAVEL_TIME),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What the credentials are, with the family (compared in memory only, never stored). */
export const credentialsKey = (config) =>
  JSON.stringify([config.type, config.auth?.username ?? '', config.auth?.password ?? '']);

/** What a read depends on: a change of any of these starts over (a new gateway, maybe). */
export const connectionKey = (config) =>
  JSON.stringify([
    addressKey(config.address),
    config.invalidHost ?? null,
    config.credentialsInHost,
    config.badAuth ?? null,
    credentialsKey(config),
  ]);

// -----------------------------------------------------------------------------
// A fake ismartgate / GogoGate2 gateway behind the client's `request`: it
// opens the sealed request with the key of its own credentials, checks the
// token, the user name, the password and the activation code, and answers the
// XML the ismartgate library's test server answers (sealed; errors in clear).
// A clock the tests drive: connecting and answering take the time they say.
// -----------------------------------------------------------------------------

import { DEVICE_TYPES } from '../../src/constants.js';
import { keyOf, seal, tokenOf, unseal } from '../../src/gate/cipher.js';
import { GateError } from '../../src/gate/errors.js';
import { gatewayIdOf } from '../../src/gate/parse.js';

export const REMOTE = 'abcdefg12345.isgaccess.com';
export const GATEWAY_ID = gatewayIdOf(REMOTE);
export const OTHER_REMOTE = 'zzzzzz99999.isgaccess.com';
export const OTHER_ID = gatewayIdOf(OTHER_REMOTE);
export const USER = 'Admin';
export const PASSWORD = 'pa$$ wörd';
export const API_CODE = 'apicode-1';

export function fakeClock(start = 1_800_000_000_000) {
  const clock = { t: start };
  clock.now = () => clock.t;
  clock.advance = (ms) => {
    clock.t += ms;
  };
  return clock;
}

const xml = (tag, body) => `<${tag}>${body}</${tag}>`;
const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function doorXml(type, door) {
  if (!door) {
    // An ismartgate Mini: no apicode for the doors it does not have.
    return xml('door', '<permission>yes</permission><name></name><status>undefined</status>');
  }
  const fields = {
    permission: door.permission ?? 'yes',
    name: door.name ?? '',
    gate: door.gate ? 'yes' : 'no',
    mode: door.mode ?? 'garage',
    status: door.status ?? 'closed',
    sensor: door.sensor ?? 'yes',
    sensorid: door.sensorid ?? 'sensor123',
    camera: 'no',
    events: '',
    temperature: door.temperature ?? '-100000',
    voltage: door.voltage ?? '-100000',
  };
  if (type === DEVICE_TYPES.ISMARTGATE) {
    Object.assign(fields, { enabled: 'yes', apicode: door.apicode ?? API_CODE, customimage: 'no' });
  }
  return Object.entries(fields)
    .map(([k, v]) => xml(k, escape(v)))
    .join('');
}

/**
 * @param {object} [options]
 * @param {string} [options.type]
 * @param {object} [options.clock]
 */
export function fakeGateway({ type = DEVICE_TYPES.ISMARTGATE, clock = fakeClock() } = {}) {
  const gw = {
    type,
    clock,
    username: USER,
    password: PASSWORD,
    remote: REMOTE,
    name: 'Home',
    doors: {
      1: { name: 'Garage', status: 'closed', temperature: '16.3', voltage: '40' },
      2: { name: 'Portail', gate: true, status: 'opened', sensorid: 'WIRE' },
      3: { name: '', status: 'undefined' },
    },
    /** Every request: { option, args, path } (args[1] is the activation code). */
    calls: [],
    /** ms to connect, ms to answer. */
    connectDelay: 10,
    answerDelay: 10,
    /** 'down' (no connection), 'silent' (connected, no answer), or undefined. */
    failure: undefined,
    /** An HTTP status to answer instead (429, 500...), and its headers. */
    httpStatus: undefined,
    headers: {},
    /** An API error code to answer instead, per option: { info: 11 }. */
    apiError: {},
    /** Answers this text as is (not sealed). */
    raw: undefined,
    /** A pulse flips the door at once (the sensor of a door that moved). */
    moveOnPulse: false,
    /** Called once the request has left (beforeSend passed): (call) => void. */
    onSent: undefined,
  };

  const respond = (body, { sealed = true } = {}) => ({
    status: 200,
    headers: {},
    body: Buffer.from(sealed ? seal(keyOf(type, gw.username, gw.password), body) : body, 'utf8'),
  });
  const error = (code) =>
    respond(
      xml('response', xml('error', `<errorcode>${code}</errorcode><errormsg>Error</errormsg>`)),
      { sealed: false },
    );

  gw.infoXml = () => {
    const nameTag = type === DEVICE_TYPES.GOGOGATE2 ? 'gogogatename' : 'ismartgatename';
    const extra =
      type === DEVICE_TYPES.GOGOGATE2
        ? `<apicode>${API_CODE}</apicode>`
        : '<pin>1234</pin><lang>en</lang><newfirmware>no</newfirmware>';
    return `<?xml version="1.0" ?>\n${xml(
      'response',
      `<user>${escape(gw.username)}</user><${nameTag}>${escape(gw.name)}</${nameTag}>` +
        `<model>${type === DEVICE_TYPES.GOGOGATE2 ? 'GG2' : 'ismartgatePRO'}</model>` +
        `<apiversion>1</apiversion><remoteaccessenabled>no</remoteaccessenabled>` +
        `<remoteaccess>${escape(gw.remote)}</remoteaccess><firmwareversion>1.7.3</firmwareversion>` +
        extra +
        [1, 2, 3]
          .map((n) => xml(`door${n}`, doorXml(type, gw.doors[n]).replace(/^<door>|<\/door>$/g, '')))
          .join('') +
        '<network><ip>192.168.1.30</ip></network><wifi><SSID>x</SSID></wifi>',
    )}\n`;
  };

  gw.request = async ({ path, timeout, sendWithin, beforeSend }) => {
    const call = { path };
    if (gw.failure === 'down') {
      clock.advance(gw.connectDelay);
      gw.calls.push(call);
      throw new GateError('unreachable');
    }
    clock.advance(gw.connectDelay);
    if (sendWithin !== undefined && gw.connectDelay > sendWithin) {
      throw new GateError('late');
    }
    if (beforeSend) {
      try {
        beforeSend();
      } catch (err) {
        err.beforeSend = true;
        err.sent = false;
        throw err;
      }
    }
    // Decoded as the gateway would.
    const url = new URL(`http://gateway${path}`);
    const key = keyOf(type, gw.username, gw.password);
    let payload;
    try {
      payload = JSON.parse(unseal(key, url.searchParams.get('data')));
    } catch {
      payload = undefined;
    }
    call.option = payload?.[2];
    call.args = payload ? [payload[3], payload[4]] : [];
    call.json = payload ? unseal(key, url.searchParams.get('data')) : undefined;
    call.query = [...url.searchParams.keys()];
    gw.calls.push(call);
    gw.onSent?.(call);
    if (gw.connectDelay + gw.answerDelay > timeout) {
      // The deadline of the request: it may have been received.
      clock.advance(Math.max(0, timeout - gw.connectDelay));
      throw new GateError('timeout', { sent: true });
    }
    clock.advance(gw.answerDelay);
    if (gw.failure === 'silent') {
      throw new GateError('timeout', { sent: true });
    }
    if (gw.httpStatus) {
      return { status: gw.httpStatus, headers: gw.headers, body: Buffer.from('') };
    }
    if (gw.raw !== undefined) {
      return { status: 200, headers: {}, body: Buffer.from(gw.raw) };
    }
    if (!payload) {
      // Not opened with its key: "corrupted data" on a GogoGate2, "credentials" on an ismartgate.
      return error(11);
    }
    if (
      type === DEVICE_TYPES.ISMARTGATE &&
      url.searchParams.get('token') !== tokenOf(gw.username)
    ) {
      return error(11);
    }
    if (payload[0] !== gw.username || payload[1] !== gw.password) {
      return error(type === DEVICE_TYPES.GOGOGATE2 ? 1 : 11);
    }
    if (gw.apiError[call.option] !== undefined) {
      return error(gw.apiError[call.option]);
    }
    if (call.option === 'info') {
      return respond(gw.infoXml());
    }
    if (call.option === 'activate') {
      const door = gw.doors[payload[3]];
      if (payload[4] !== (door?.apicode ?? API_CODE)) {
        return error(type === DEVICE_TYPES.GOGOGATE2 ? 18 : 10);
      }
      if (gw.moveOnPulse && door) {
        door.status = door.status === 'closed' ? 'opened' : 'closed';
      }
      return respond(xml('response', '<result>OK</result>'));
    }
    return error(9);
  };

  gw.pulses = () => gw.calls.filter((c) => c.option === 'activate');
  gw.reads = () => gw.calls.filter((c) => c.option === 'info');
  return gw;
}

// -----------------------------------------------------------------------------
// The answers of the gateway -> plain objects (pure), after the ismartgate
// library (common.py): `element_to_ismartgate_info_response`,
// `element_to_gogogate2_info_response`, the door fields and the error
// element. Every value is checked; a value missing or not understood is
// `undefined`, never a guess.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { cleanText } from '../config.js';
import {
  DEVICE_TYPES,
  DOOR_IDS,
  DOOR_MODES,
  DOOR_STATUS,
  LIMITS,
  NONE_VALUE,
  NO_RADIO_SENSOR,
} from '../constants.js';
import { child, childText } from './xml.js';

const yes = (text) =>
  typeof text === 'string'
    ? text.toLowerCase() === 'yes'
      ? true
      : text.toLowerCase() === 'no'
        ? false
        : undefined
    : undefined;

/** A decimal written by the gateway, or undefined. */
function decimal(text) {
  if (typeof text !== 'string' || !/^-?\d{1,7}(\.\d{1,6})?$/.test(text)) {
    return undefined;
  }
  return Number(text);
}

/**
 * The id of the gateway: the name of its remote access host (`remoteaccess`,
 * "abcdefg12345.isgaccess.com", the part before the first dot, as Home
 * Assistant takes it), hashed: the external ids never show the address of
 * the remote access. Undefined when it cannot be read ("unreadable", never
 * "another gateway").
 */
export function gatewayIdOf(remoteaccess) {
  if (typeof remoteaccess !== 'string') {
    return undefined;
  }
  const name = remoteaccess.trim().toLowerCase().replace(/\..*$/, '');
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    return undefined;
  }
  return createHash('sha256').update(`ismartgate:${name}`).digest('hex').slice(0, 16);
}

/** One door (`<door1>`...), or undefined when the gateway has no such door (ismartgate Mini). */
function doorOf(type, id, node, { withCodes }) {
  if (!node) {
    return undefined;
  }
  const apiCode = childText(node, 'apicode');
  if (type === DEVICE_TYPES.ISMARTGATE && apiCode === undefined) {
    // ismartgate_door_or_empty: no apicode, a door this model does not have.
    return undefined;
  }
  const name = cleanText(childText(node, 'name') ?? '', LIMITS.name);
  const status = childText(node, 'status');
  const mode = childText(node, 'mode');
  const sensorId = cleanText(childText(node, 'sensorid') ?? '', 32);
  const radio = !NO_RADIO_SENSOR.has(sensorId.toUpperCase());
  const temperature = decimal(childText(node, 'temperature'));
  const battery = decimal(childText(node, 'voltage'));
  const door = {
    id,
    // A door without a name is not set up (get_configured_doors).
    configured: name !== '',
    name,
    status: Object.values(DOOR_STATUS).includes(status) ? status : undefined,
    mode: Object.values(DOOR_MODES).includes(mode) ? mode : undefined,
    gate: yes(childText(node, 'gate')) === true,
    permission: yes(childText(node, 'permission')),
    radio,
    temperature:
      radio &&
      temperature !== undefined &&
      temperature > NONE_VALUE &&
      temperature >= -40 &&
      temperature <= 85
        ? Math.round(temperature * 10) / 10
        : undefined,
    // `voltage` is a percentage, not volts (Home Assistant's battery sensor).
    battery:
      radio && battery !== undefined && battery > NONE_VALUE && battery >= 0 && battery <= 100
        ? Math.round(battery)
        : undefined,
  };
  if (withCodes && type === DEVICE_TYPES.ISMARTGATE) {
    door.apiCode = apiCode;
  }
  return door;
}

/**
 * The `info` answer. `withCodes`: keep the activation codes (`apicode`), only
 * for the read of a command; a poll never keeps them.
 * @returns {{ id?: string, name: string, model: string, firmware: string,
 *   doors: object[], apiCode?: string }}
 */
export function parseInfo(type, root, { withCodes = false } = {}) {
  if (root?.name !== 'response') {
    throw new Error('not an info answer');
  }
  const doors = [];
  for (const id of DOOR_IDS) {
    const door = doorOf(type, id, child(root, `door${id}`), { withCodes });
    if (door) {
      doors.push(door);
    }
  }
  if (doors.length === 0) {
    throw new Error('no door element');
  }
  const info = {
    id: gatewayIdOf(childText(root, 'remoteaccess')),
    name: cleanText(
      childText(root, type === DEVICE_TYPES.GOGOGATE2 ? 'gogogatename' : 'ismartgatename') ?? '',
      LIMITS.name,
    ),
    model: cleanText(childText(root, 'model') ?? '', LIMITS.name),
    firmware: cleanText(childText(root, 'firmwareversion') ?? '', 32),
    doors,
  };
  if (withCodes && type === DEVICE_TYPES.GOGOGATE2) {
    info.apiCode = childText(root, 'apicode');
  }
  return info;
}

/** The `<error>` of an answer: `{ code, message }`, or undefined. */
export function errorOf(root) {
  const error = child(root, 'error');
  if (!error) {
    return undefined;
  }
  const codeText = childText(error, 'errorcode');
  return {
    code: /^\d{1,4}$/.test(codeText ?? '') ? Number(codeText) : undefined,
  };
}

/** The `activate` answer: `<result>OK</result>`. */
export const activatedOf = (root) => (childText(root, 'result') ?? '').toLowerCase() === 'ok';

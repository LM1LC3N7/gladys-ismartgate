// -----------------------------------------------------------------------------
// The doors of the gateway -> Gladys devices and states (pure).
//
// One Gladys device per door set up on the gateway (a door with a name):
// `gladys.externalIds('ismartgate', '<gateway id>-<door>')`, the gateway id
// being the hash of its remote access name (src/gate/parse.js), the door 1, 2
// or 3. Feature keys are frozen:
//
//   state        opening-sensor / binary, READ ONLY (0 open, 1 closed)
//   open, close  button / push, only on a door in garage or pulse mode
//   temperature  temperature-sensor / decimal, °C (wireless sensor only)
//   battery      battery / integer, % (wireless sensor only)
//
// A door is never a `switch` nor a commandable `binary`: a "turn everything
// off/on" (voice assistants, HomeKit, scenes on switches) must never reach it.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  DOOR_MODES,
  DOOR_STATUS,
  EXTERNAL_ID_TYPE,
  FEATURES,
  OPENING_SENSOR_STATE,
} from './constants.js';
import { FEATURE_NAMES, word } from './i18n.js';

/** The external ids of one door. */
export const doorIds = (gladys, gatewayId, doorId) =>
  gladys.externalIds(EXTERNAL_ID_TYPE, `${gatewayId}-${doorId}`);

/**
 * `{ gatewayId, doorId, key? }` of one of our device or feature external ids,
 * checked against the ids the SDK builds; undefined otherwise.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:([0-9a-f]{16})-([1-3])(?::([a-z]+))?$/.exec(externalId);
  if (!match) {
    return undefined;
  }
  const [, gatewayId, door, key] = match;
  const ids = doorIds(gladys, gatewayId, Number(door));
  const expected = key === undefined ? ids.device : ids.feature(key);
  return expected === externalId ? { gatewayId, doorId: Number(door), key } : undefined;
}

/** Whether a pulse drives a door in this mode (an on/off output is something else). */
export const drivesADoor = (mode) => mode === DOOR_MODES.GARAGE || mode === DOOR_MODES.PULSE;

const sensor = (category, type, min, max, unit) => ({
  category,
  type,
  min,
  max,
  ...(unit ? { unit } : {}),
  read_only: true,
  has_feedback: false,
  keep_history: true,
});
const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

/** The features of a door: `[{ key, spec, name, measure? }]`, in a stable order. */
export function featuresOf(door) {
  const out = [
    {
      key: FEATURES.STATE,
      spec: sensor(C.OPENING_SENSOR, T.SENSOR.BINARY, 0, 1),
      name: FEATURE_NAMES.state(door.gate),
    },
  ];
  if (drivesADoor(door.mode)) {
    out.push(
      { key: FEATURES.OPEN, spec: button(), name: FEATURE_NAMES.open(door.gate) },
      { key: FEATURES.CLOSE, spec: button(), name: FEATURE_NAMES.close(door.gate) },
    );
  }
  if (door.radio) {
    out.push(
      {
        key: FEATURES.TEMPERATURE,
        spec: sensor(C.TEMPERATURE_SENSOR, T.SENSOR.DECIMAL, -40, 85, U.CELSIUS),
        name: FEATURE_NAMES.temperature,
        measure: true,
      },
      {
        key: FEATURES.BATTERY,
        spec: sensor(C.BATTERY, T.BATTERY.INTEGER, 0, 100, U.PERCENT),
        name: FEATURE_NAMES.battery,
        measure: true,
      },
    );
  }
  return out;
}

export const doorName = (door) => (door.name || `ismartgate ${door.id}`).slice(0, 100);

/** The Gladys device of a door of the gateway `info`. */
export function buildDevice(gladys, info, door, { language, host }) {
  const ids = doorIds(gladys, info.id, door.id);
  const features = featuresOf(door).map(({ key, spec, name }) => ({
    name: word(name, language).slice(0, 100),
    external_id: ids.feature(key),
    ...spec,
  }));
  const params = [
    { name: 'IP_ADDRESS', value: host ?? '' },
    { name: 'DOOR', value: String(door.id) },
    { name: 'MODEL', value: info.model },
    { name: 'FIRMWARE', value: info.firmware },
  ].filter((param) => param.value !== '');
  return {
    name: doorName(door),
    external_id: ids.device,
    features,
    params,
    should_poll: false,
  };
}

/** `[{ key, value }]` of a door read: only defined, finite values. */
export function valuesOf(door) {
  const out = [];
  const add = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      out.push({ key, value });
    }
  };
  if (door.status === DOOR_STATUS.OPENED) {
    add(FEATURES.STATE, OPENING_SENSOR_STATE.OPEN);
  } else if (door.status === DOOR_STATUS.CLOSED) {
    add(FEATURES.STATE, OPENING_SENSOR_STATE.CLOSE);
  }
  add(FEATURES.TEMPERATURE, door.temperature);
  add(FEATURES.BATTERY, door.battery);
  return out;
}

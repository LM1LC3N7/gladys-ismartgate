// -----------------------------------------------------------------------------
// Fixed values: manifest keys (frozen: users store them in their scenes and
// configuration), the Gladys core value enums the SDK does not export, the
// values of the gateway's local API, limits and timings.
// -----------------------------------------------------------------------------

/** The external id type: `gladys.externalIds('ismartgate', '<gateway>-<door>')`. Frozen. */
export const EXTERNAL_ID_TYPE = 'ismartgate';

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};

/** The two families of gateways (the `device_type` select of the manifest). */
export const DEVICE_TYPES = {
  ISMARTGATE: 'ismartgate',
  GOGOGATE2: 'gogogate2',
};

/** Feature keys of a door. Frozen. */
export const FEATURES = {
  STATE: 'state',
  OPEN: 'open',
  CLOSE: 'close',
  TEMPERATURE: 'temperature',
  BATTERY: 'battery',
};

/** The keys a user can press. */
export const COMMAND_KEYS = [FEATURES.OPEN, FEATURES.CLOSE];

// Gladys core enums (server/utils/constants.js), not exported by the SDK.
export const OPENING_SENSOR_STATE = { OPEN: 0, CLOSE: 1 };
export const BUTTON_PUSH = { PRESSED: 1 };

/** `<status>` of a door (ismartgate DoorStatus). */
export const DOOR_STATUS = { OPENED: 'opened', CLOSED: 'closed', UNDEFINED: 'undefined' };
/** `<mode>` of a door (ismartgate DoorMode): only garage and pulse drive a door. */
export const DOOR_MODES = { GARAGE: 'garage', PULSE: 'pulse', ON_OFF: 'onoff' };
/** The doors of a gateway: door1, door2, door3. */
export const DOOR_IDS = [1, 2, 3];
/** A temperature or a battery level at or below this means "none" (ismartgate NONE_INT). */
export const NONE_VALUE = -100000;
/** `<sensorid>` of a wired sensor (no battery, no temperature), as Home Assistant reads it. */
export const NO_RADIO_SENSOR = new Set(['', '0', 'WIRE']);

/**
 * The error codes of the API (ismartgate const.py): the same numbers do not
 * mean the same thing on the two families (11 is "credentials refused" on an
 * ismartgate, "corrupted data" on a GogoGate2).
 */
export const API_ERRORS = {
  [DEVICE_TYPES.ISMARTGATE]: {
    11: 'auth',
    22: 'auth',
    21: 'token',
    9: 'option',
    10: 'apiCode',
    8: 'door',
  },
  [DEVICE_TYPES.GOGOGATE2]: {
    1: 'auth',
    2: 'auth',
    9: 'option',
    11: 'corrupted',
    18: 'apiCode',
    8: 'door',
    5: 'door',
  },
};

/** The fixed key of the GogoGate2 API (ismartgate GogoGate2ApiCipher.SHARED_SECRET). */
export const GOGOGATE2_SHARED_KEY = '0e3b7%i1X9@54cAf';

export const LIMITS = {
  /** Gladys accepts 300 states per minute: keep a margin. */
  statesPerMinute: 250,
  /** Body of an answer of the gateway (an info answer is about 2 KB). */
  responseBytes: 64 * 1024,
  /** XML: elements, depth, characters of one text. */
  xmlElements: 400,
  xmlDepth: 6,
  xmlText: 512,
  /** Texts from the gateway shown in Gladys (door names, model). */
  name: 60,
};

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const TIMINGS = {
  /** One read of the polling (the gateway is a small Linux box, sometimes slow). */
  readTimeout: 10 * SECOND,
  /** The pending states are sent at this pace. */
  flushInterval: SECOND,
  /** Temperature and battery of a door are spaced by this much. */
  measureInterval: MINUTE,
  /** An unchanged value is re-sent this often, so it stays recently dated in Gladys. */
  stateHeartbeat: 30 * MINUTE,
  /**
   * A command leaves within this many ms of its arrival, or is refused
   * unsent: Gladys gives up waiting for the ack after 5 s.
   */
  commandSendBy: 3500,
  /** The ack is given by then: past it, "sent, without confirmation". */
  commandAnswerBy: 4300,
  /** The fresh read of a command leaves at least this much for the pulse itself. */
  commandSendMargin: 300,
  /** Reads after a pulse (a door moves for a while); the last one at travel time + 5 s. */
  followUps: [2 * SECOND, 8 * SECOND],
  /** After a pulse, no other one until the door is seen elsewhere, or travel time + this. */
  guardMargin: 5 * SECOND,
  /** Transient failures: the next reads, never sooner than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** Credentials refused: the next tries, then every 24 h. */
  authRetries: [15 * MINUTE, HOUR, 6 * HOUR, 24 * HOUR],
  /** HTTP 429 or 5xx: a pause within these bounds. */
  pauseMin: MINUTE,
  pauseMax: 6 * HOUR,
  /** The time of the last read is written to /data at most this often. */
  attemptPersistEvery: MINUTE,
};

/** Configuration bounds (mirrored by the manifest). */
export const POLL_INTERVAL = { default: 10, min: 5, max: 300 };
/** How long a door takes to open or close, in seconds (the guard after a pulse). */
export const TRAVEL_TIME = { default: 30, min: 10, max: 120 };

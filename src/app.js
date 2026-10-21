// -----------------------------------------------------------------------------
// The integration: the ismartgate or GogoGate2 gateway typed in the
// configuration (one IP address, the user name and password of its app), one
// `info` read of it every poll interval, one Gladys device per door, the
// transport badge, the "Test the connection" button, and the two commands of
// a door (open, close). index.js only wires the SDK handlers to it.
//
// The gateway only knows ONE command: a pulse on the relay of a door, the
// same for opening and closing (a pulse while the door moves may stop it or
// send it back). So, as gladys-blebox (approved) does for its gates:
//   - a door is never a switch: a read-only opening sensor and two buttons;
//   - every pulse is decided on the state read just now (never on memory):
//     "open" only from a door read closed, "close" only from a door read
//     open, nothing on an unknown state; the gateway read just now must be
//     this one (its id), the door set up, in garage or pulse mode;
//   - opening is refused unless "Allow opening" is on, checked on arrival,
//     after the fresh read and right before the request leaves (beforeSend);
//   - closing is never held back by the option, by the queue of the openings
//     nor by a 429/5xx pause or a refused-credentials stop (one try), and it
//     cancels at once every opening of that door not sent yet;
//   - one pulse at a time per door, and after each pulse that may have left
//     a guard: no other pulse on that door until it is read elsewhere than
//     where the pulse found it (never lifted on an unknown or equal state),
//     or until the travel time has passed;
//   - sent within 3.5 s of the click or refused unsent; answered by 4.3 s; a
//     pulse that may have reached the gateway is never answered "not sent":
//     "sent, without confirmation", then reads; never retried;
//   - the ack never waits for a publication to Gladys.
//
// Reads: never sooner than the interval (the test button, a scan, a
// reconnection, a configuration saved unchanged, a restart: the time of the
// last read is kept in /data); one read at a time, a read begun before a
// pulse left is not applied; a read or an answer of an older configuration
// publishes nothing (generation checked after every await).
// Failures: credentials refused -> a stop persisted (15 min, 1 h, 6 h, then
// 24 h; other credentials lift it at once); 429/5xx -> a pause of 1 min to
// 6 h persisted; anything else -> 30 s, 1, 2, 5 min, never sooner than the
// interval. A reconnection to Gladys clears none of them.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, connectionKey, credentialsKey, normalizeConfig } from './config.js';
import { COMMAND_KEYS, DEVICE_TYPES, DOOR_STATUS, FEATURES, SECOND, TIMINGS } from './constants.js';
import {
  buildDevice,
  doorIds,
  drivesADoor,
  featuresOf,
  parseExternalId,
  valuesOf,
} from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { fileStore, fingerprintOf, normalizeMemory } from './store.js';
import { GateClient } from './gate/client.js';
import { reasonOf } from './gate/errors.js';

const KNOWN_STATUS = new Set([DOOR_STATUS.OPENED, DOOR_STATUS.CLOSED]);

/** The fields kept from a feature created in Gladys, when it is published again as it is. */
const KEPT_FIELDS = [
  'name',
  'external_id',
  'category',
  'type',
  'min',
  'max',
  'unit',
  'read_only',
  'has_feedback',
  'keep_history',
];

/** An info read without the activation codes (a command's read keeps them: never stored). */
const withoutCodes = (info) => {
  const { apiCode: _apiCode, ...rest } = info;
  return {
    ...rest,
    doors: info.doors.map(({ apiCode: _code, ...door }) => door),
  };
};

const freshGateway = () => ({
  /** The id of the gateway at the address: read, or kept in /data (undefined: unknown). */
  id: undefined,
  /** The last info read (no activation code), or undefined. */
  info: undefined,
  /** undefined: not read yet since the start; true: answered; false: failing. */
  online: undefined,
  failures: 0,
  nextRetryAt: -Infinity,
  wait: undefined,
  error: undefined,
  /** A read answered since the start (the orphans are only named after one). */
  readSinceStart: false,
});

export class IsmartgateApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'ismartgate' }),
    client = new GateClient(),
    store = fileStore(),
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.client = client;
    this.store = store;
    this.now = now;
    this.timers = timers;
    this.publisher = new StatePublisher({ gladys, logger, now, timers });
    this.config = normalizeConfig();
    this.connKey = undefined;
    this.memory = undefined;
    this.generation = 0;
    this.started = false;
    this.gw = freshGateway();
    /** When the gateway was last asked by this process (exact). */
    this.lastAttemptAt = -Infinity;
    this.timer = undefined;
    this.running = undefined;
    this.followUps = new Set();
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** The openings, one at a time (closing never waits here). */
    this.queue = Promise.resolve();
    /** door -> tickets of the openings not sent yet (a close cancels them). */
    this.tickets = new Map();
    /** door -> the pulse between its plan and its answer. */
    this.flights = new Map();
    /** door -> { from, until }: after a pulse, until the door is read elsewhere. */
    this.guards = new Map();
    /** When the last pulse left: a read begun before it is not applied. */
    this.lastSentAt = -Infinity;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = this.generation;
    if (!this.memory) {
      this.memory = normalizeMemory(await this.store.load().catch(() => null), this.now());
      // Written at most once a minute: the real last read may be up to a
      // minute later than the one kept.
      if (this.memory.lastAttemptAt > 0) {
        this.lastAttemptAt = Math.min(
          this.now(),
          this.memory.lastAttemptAt + TIMINGS.attemptPersistEvery,
        );
      }
    }
    if (generation !== this.generation) {
      return;
    }
    const previousKey = this.connKey;
    this.config = normalizeConfig(raw);
    this.connKey = connectionKey(this.config);
    await this.forgetOtherAddress();
    await this.liftBlockOnOtherCredentials();
    this.gw = freshGateway();
    // The gateway last read at this address: "Close" works before the first read.
    const kept = this.memory.gateway;
    if (this.config.address && kept?.address === addressKey(this.config.address)) {
      this.gw.id = kept.id;
    }
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.address || this.config.auth === undefined) {
      // The devices already created are shown unreachable.
      await this.publishAll();
      return;
    }
    await this.updateStatus();
    // A new address or new credentials: read at once (a pause or a block
    // still holds). Otherwise never sooner than the interval.
    const changed = previousKey !== undefined && previousKey !== this.connKey;
    this.schedule(changed ? Math.max(0, this.holdUntil() - this.now()) : undefined);
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.followUps.clear();
    this.publisher.stop();
    if (this.memory && this.lastAttemptAt > this.memory.lastAttemptAt) {
      this.memory.lastAttemptAt = this.lastAttemptAt;
      return this.saveMemory();
    }
    return Promise.resolve();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection,
   * resend what Gladys keeps in memory only (status, Discovery tab, badge)
   * and the last states, without reading the gateway again. Pauses, blocks
   * and guards stay.
   */
  async connected(raw = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    await this.configUpdated(raw, { republish: true });
  }

  /**
   * A configuration saved. A new address, family or credentials start over;
   * anything else (interval, option, travel time, language) applies at once,
   * without a read.
   */
  async configUpdated(raw = {}, { republish = false } = {}) {
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    const next = normalizeConfig(raw);
    if (connectionKey(next) !== this.connKey) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = next;
    if (previous.allowOpen !== next.allowOpen) {
      this.logger.info(`Opening ${next.allowOpen ? 'allowed' : 'disabled'}`);
    }
    if (previous.pollInterval !== next.pollInterval && this.timer && !this.running) {
      this.schedule();
    }
    if (republish) {
      this.published = undefined;
      this.badge = undefined;
      this.lastStatus = undefined;
    } else if (previous.language !== next.language) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async saveMemory() {
    await this.store
      .save(this.memory)
      .catch((err) => this.logger.warn(`Saving the state to /data failed: ${err.message}`));
  }

  /** A pause or a block kept for another address does not hold this one. */
  async forgetOtherAddress() {
    const address = addressKey(this.config.address);
    let changed = false;
    for (const key of ['pause', 'block']) {
      if (this.memory[key] && this.memory[key].address !== address) {
        this.memory[key] = null;
        changed = true;
      }
    }
    if (changed) {
      await this.saveMemory();
    }
  }

  /** Other credentials than the refused ones (even typed while stopped) lift the block. */
  async liftBlockOnOtherCredentials() {
    const block = this.memory.block;
    if (block && block.fp !== fingerprintOf(this.memory.salt, credentialsKey(this.config))) {
      this.memory.block = null;
      await this.saveMemory();
    }
  }

  // --- Pauses and blocks -----------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  get paused() {
    return Boolean(this.memory?.pause) && this.now() < this.memory.pause.until;
  }

  get blocked() {
    return Boolean(this.memory?.block) && this.now() < this.memory.block.until;
  }

  /** The end of a pause or a block, or now. */
  holdUntil() {
    return Math.max(
      this.now(),
      this.paused ? this.memory.pause.until : 0,
      this.blocked ? this.memory.block.until : 0,
    );
  }

  /** The earliest periodic read: the interval after the last one, a pause, a block. */
  earliestRead() {
    return Math.max(this.lastAttemptAt + this.interval, this.holdUntil());
  }

  /** 429 or 5xx: every read and every opening waits, kept in /data. */
  async pause(err) {
    const failures = (this.memory.pause?.failures ?? 0) + 1;
    const asked = err.retryAfter ?? TIMINGS.pauseMin * 2 ** Math.min(failures - 1, 10);
    const wait = Math.min(TIMINGS.pauseMax, Math.max(TIMINGS.pauseMin, asked));
    this.memory.pause = {
      until: this.now() + wait,
      failures,
      address: addressKey(this.config.address),
    };
    await this.saveMemory();
    this.logger.warn(`Gateway: ${reasonOf(err)}, paused for ${age(wait)}`);
  }

  /** Credentials refused: the next tries spaced, kept in /data with the refused pair's fingerprint. */
  async block() {
    const failures = (this.memory.block?.failures ?? 0) + 1;
    const wait = TIMINGS.authRetries[Math.min(failures, TIMINGS.authRetries.length) - 1];
    this.memory.block = {
      until: this.now() + wait,
      failures,
      fp: fingerprintOf(this.memory.salt, credentialsKey(this.config)),
      address: addressKey(this.config.address),
    };
    await this.saveMemory();
    this.logger.warn(`Gateway: credentials refused; next try in ${age(wait)}`);
  }

  // --- Polling ---------------------------------------------------------------

  /** The connection of the gateway (the credentials are only handed to the client). */
  connection() {
    return { type: this.config.type, address: this.config.address, auth: this.config.auth };
  }

  /** The next read: the interval, a pause, a block or the backoff, whichever is later. */
  schedule(delay) {
    this.clearTimer();
    let at = this.earliestRead();
    if (this.gw.online === false) {
      at = Math.max(at, this.gw.nextRetryAt);
    }
    const wait = delay ?? at - this.now();
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick({ scheduled: true }).catch(() => this.logger.error('Refresh failed'));
        }
      },
      Math.max(0, wait),
    );
  }

  /**
   * One read at a time: a tick during a read joins it (a reconnection never
   * starts a second one). `force`: a read after a pulse, sooner than the
   * interval, never through a pause, a block nor a backoff. `scheduled`: the
   * timer, or a start after a new address or new credentials.
   */
  tick(options = {}) {
    if (!this.running) {
      this.running = this.run(options).finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run({ force = false, scheduled = false } = {}) {
    const generation = this.generation;
    if (!this.config.address || this.config.auth === undefined) {
      return;
    }
    const now = this.now();
    const early = !force && !scheduled && now < this.earliestRead();
    const backingOff = this.gw.online === false && now < this.gw.nextRetryAt;
    if (this.paused || this.blocked || early || backingOff) {
      await this.updateStatus();
      if (generation === this.generation && !this.timer) {
        this.schedule();
      }
      return;
    }
    await this.noteAttempt(now);
    const startedAt = this.now();
    try {
      const info = await this.client.info(this.connection(), { timeout: TIMINGS.readTimeout });
      if (generation !== this.generation) {
        return;
      }
      this.gw.online = true;
      this.gw.failures = 0;
      this.gw.wait = undefined;
      this.gw.error = undefined;
      if (startedAt <= this.lastSentAt) {
        // Begun before a pulse left: it may show the door before it.
        this.logger.debug('Read begun before a pulse, not applied');
      } else {
        await this.applyRead(info);
      }
      if (this.memory.block || this.memory.pause) {
        this.memory.block = null;
        this.memory.pause = null;
        await this.saveMemory();
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  /** The time of a read: exact in memory, in /data at most once a minute. */
  async noteAttempt(now) {
    this.lastAttemptAt = now;
    if (now - this.memory.lastAttemptAt >= TIMINGS.attemptPersistEvery) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  /**
   * An info read: the identity first (a DHCP lease may give the address to
   * another gateway; an id that cannot be read is not "another gateway"),
   * then the doors and the guards they lift.
   */
  async applyRead(info) {
    if (!info.id) {
      this.gw.error = 'noId';
      return;
    }
    if (this.gw.id && this.gw.id !== info.id) {
      this.logger.warn('Another gateway answers at this address: its doors replace the others');
      this.guards.clear();
    }
    this.gw.id = info.id;
    this.gw.info = withoutCodes(info);
    this.gw.readSinceStart = true;
    for (const door of info.doors) {
      this.observeGuard(door);
    }
    const address = addressKey(this.config.address);
    const kept = this.memory.gateway;
    if (kept?.address !== address || kept.id !== info.id) {
      this.memory.gateway = { address, id: info.id };
      await this.saveMemory();
    }
  }

  /** A failed read. */
  async failed(err) {
    const gw = this.gw;
    if (err.kind === 'auth') {
      gw.online = false;
      gw.error = 'auth';
      await this.block();
      return;
    }
    if (err.kind === 'busy') {
      // The gateway answers: the status shows the pause.
      await this.pause(err);
      return;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(gw.failures, TIMINGS.backoff.length - 1)],
    );
    gw.failures += 1;
    gw.online = false;
    gw.wait = wait;
    gw.nextRetryAt = this.now() + wait;
    gw.error = err.kind ?? 'error';
    this.logger.warn(`Gateway: ${reasonOf(err)}; next try in ${age(wait)}`);
  }

  // --- Guards ----------------------------------------------------------------

  /** After a pulse that may have left: no other pulse on that door until it is seen elsewhere. */
  guard(doorId, from) {
    this.guards.set(doorId, {
      from,
      until: this.now() + this.config.travelTime * SECOND + TIMINGS.guardMargin,
    });
  }

  /** A door read: the guard lifts when the door is read in another known state. */
  observeGuard(door) {
    const guard = this.guards.get(door.id);
    if (!guard) {
      return;
    }
    if (
      this.now() >= guard.until ||
      (KNOWN_STATUS.has(door.status) && door.status !== guard.from)
    ) {
      this.guards.delete(door.id);
    }
  }

  guardActive(doorId) {
    const guard = this.guards.get(doorId);
    if (guard && this.now() >= guard.until) {
      this.guards.delete(doorId);
      return false;
    }
    return Boolean(guard);
  }

  // --- Status ----------------------------------------------------------------

  /** The doors set up on the gateway read, if it was read. */
  doors() {
    return (this.gw.info?.doors ?? []).filter((door) => door.configured);
  }

  /** `[connected, message]`. */
  status() {
    const gw = this.gw;
    const config = this.config;
    if (!config.address) {
      if (config.credentialsInHost) {
        return [false, T.hostCredentials];
      }
      return [false, config.invalidHost ? T.invalidHost(config.invalidHost) : T.noHost];
    }
    if (config.badAuth) {
      return [false, config.badAuth === 'invalid' ? T.invalidCredentials : T.missingCredentials];
    }
    if (this.paused) {
      return [false, T.paused(age(this.memory.pause.until - this.now()))];
    }
    if (this.blocked) {
      return [false, T.authRefused(age(this.memory.block.until - this.now()))];
    }
    if (gw.online === false) {
      const wait = age(gw.wait ?? this.interval);
      return [
        false,
        gw.error === 'unreachable' || gw.error === 'timeout' || gw.error === 'late'
          ? T.unreachable(addressKey(config.address), wait)
          : T.failing(gw.error ?? 'error', wait),
      ];
    }
    if (gw.online === undefined) {
      return [false, T.connecting];
    }
    if (gw.error === 'noId' || !gw.info) {
      return [false, T.noId];
    }
    const doors = this.doors();
    if (doors.length === 0) {
      return [true, join(T.connected(T.noDoor), T.opening(config.allowOpen))];
    }
    const summary = T.summary(gw.info.name, gw.info.model, doors);
    return [true, join(T.connected(summary), T.opening(config.allowOpen))];
  }

  /** The connection status of the configuration screen. */
  async updateStatus() {
    let [connected, message] = this.status();
    const orphans = this.config.address && this.config.auth !== undefined ? this.orphans() : [];
    if (orphans.length > 0) {
      const names = orphans
        .map((device) =>
          typeof device.name === 'string' && device.name !== ''
            ? device.name.slice(0, 60)
            : device.external_id.split(':').at(-1),
        )
        .join(', ');
      connected = false;
      message = join(message, T.otherGateway(names));
    }
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Gladys ----------------------------------------------------------------

  /**
   * The created devices of this integration that are not doors of the gateway
   * at the address: with an address, only once a read named the gateway
   * there (a gateway down is not "another gateway"); without one, all.
   */
  orphans() {
    const configured = this.config.address && this.config.auth !== undefined;
    if (configured && !this.gw.readSinceStart) {
      return [];
    }
    return (this.gladys.devices ?? []).filter((device) => {
      const target = parseExternalId(this.gladys, device?.external_id);
      return target && target.key === undefined && (!configured || target.gatewayId !== this.gw.id);
    });
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /**
   * The Discovery tab: one device per door set up. A created device never
   * loses a feature: the features it has that the door no longer gives (a
   * door switched to on/off mode, a sensor removed) are published as they
   * are (Gladys would otherwise mark it changed, and "Update" would drop their
   * history).
   */
  async publishDevices() {
    const info = this.gw.info;
    if (!info?.id || this.gw.id !== info.id) {
      return;
    }
    const created = new Map((this.gladys.devices ?? []).map((d) => [d.external_id, d]));
    const measures = new Set();
    const devices = [];
    for (const door of this.doors()) {
      const device = buildDevice(this.gladys, info, door, {
        language: this.config.language,
        host: this.config.address?.host,
      });
      const ids = doorIds(this.gladys, info.id, door.id);
      for (const { key, measure } of featuresOf(door)) {
        if (measure) {
          measures.add(ids.feature(key));
        }
      }
      const published = new Set(device.features.map((f) => f.external_id));
      for (const feature of created.get(device.external_id)?.features ?? []) {
        if (!published.has(feature.external_id)) {
          const kept = {};
          for (const field of KEPT_FIELDS) {
            if (feature[field] !== undefined && feature[field] !== null) {
              kept[field] = feature[field];
            }
          }
          device.features.push(kept);
        }
      }
      devices.push(device);
    }
    this.publisher.configure({ throttled: measures, events: new Set() });
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** The last values of the doors, for the created features only (the ack never waits for it). */
  queueStates(created = this.createdFeatures()) {
    const info = this.gw.info;
    if (!info?.id || this.gw.id !== info.id) {
      return;
    }
    for (const door of this.doors()) {
      const ids = doorIds(this.gladys, info.id, door.id);
      for (const { key, value } of valuesOf(door)) {
        const id = ids.feature(key);
        if (created.has(id)) {
          this.publisher.push(id, { state: value });
        }
      }
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const info = this.gw.info;
    if (info?.id && this.gw.id === info.id && this.gw.online !== undefined) {
      const online = this.gw.online === true && !this.blocked;
      for (const door of this.doors()) {
        const id = doorIds(this.gladys, info.id, door.id).device;
        if (created.has(id)) {
          entries.push({
            external_id: id,
            transport: online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
          });
        }
      }
    }
    for (const device of this.orphans()) {
      entries.push({ external_id: device.external_id, transport: DEVICE_TRANSPORTS.UNREACHABLE });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values and its badge at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const feature of device?.features ?? []) {
      created.add(feature.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
    await this.updateStatus();
  }

  /** The Discovery tab asks for a scan: the doors of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button --------------------------------------------------

  /**
   * "Test the connection": a read now, unless one was made less than an
   * interval ago (then its result). Refused credentials are tried once more
   * (the user asks); a pause asked by the gateway holds.
   */
  async testConnection() {
    if (!this.config.address || this.config.auth === undefined || this.paused) {
      return this.status()[1];
    }
    const now = this.now();
    if (now < this.lastAttemptAt + this.interval) {
      await this.updateStatus();
      const last = JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status()[1];
      return join(T.test.recent(age(this.lastAttemptAt + this.interval - now)), last);
    }
    if (this.memory.block) {
      this.memory.block = { ...this.memory.block, until: now };
      await this.saveMemory();
    }
    await this.tick({ scheduled: true });
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status()[1];
  }

  // --- Commands --------------------------------------------------------------

  refusal(text) {
    const error = new Error(word(text, this.config.language));
    error.refusal = true;
    return error;
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.now();
    const target = parseExternalId(this.gladys, feature?.external_id);
    if (!target || !COMMAND_KEYS.includes(target.key)) {
      throw this.refusal(ERRORS.readOnly);
    }
    if (value !== 1 && value !== '1') {
      throw this.refusal(ERRORS.badValue);
    }
    if (!this.memory || !this.config.address || this.config.auth === undefined) {
      throw this.refusal(ERRORS.notConfigured);
    }
    if (target.gatewayId !== this.gw.id) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    const open = target.key === FEATURES.OPEN;
    if (open && !this.config.allowOpen) {
      throw this.refusal(ERRORS.openDisabled);
    }
    const ticket = {
      doorId: target.doorId,
      open,
      generation: this.generation,
      cancelled: false,
      sent: false,
    };
    if (!open) {
      // Every opening of this door not sent yet is cancelled at once, the
      // queued ones included; cancelling never sends anything. Never behind
      // the queue.
      for (const pending of this.tickets.get(target.doorId) ?? []) {
        if (!pending.sent) {
          pending.cancelled = true;
        }
      }
      return this.command(target, ticket, received);
    }
    if (!this.tickets.has(target.doorId)) {
      this.tickets.set(target.doorId, new Set());
    }
    this.tickets.get(target.doorId).add(ticket);
    const run = this.queue.then(() => this.command(target, ticket, received));
    this.queue = run.catch(() => {});
    try {
      return await run;
    } finally {
      this.tickets.get(target.doorId)?.delete(ticket);
    }
  }

  /** The checks of a command, on the latest configuration: on arrival, after the read, before sending. */
  checkCommand(target, ticket, sendBy) {
    if (ticket.cancelled) {
      throw this.refusal(ERRORS.cancelled);
    }
    if (
      ticket.generation !== this.generation ||
      !this.config.address ||
      this.config.auth === undefined
    ) {
      // A new address or new credentials since: nothing for the old ones.
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (target.gatewayId !== this.gw.id) {
      throw this.refusal(ERRORS.unknownDevice);
    }
    if (ticket.open) {
      if (!this.config.allowOpen) {
        throw this.refusal(ERRORS.openDisabled);
      }
      // Closing ignores both (one try): opening never.
      if (this.blocked) {
        throw this.refusal(ERRORS.blocked);
      }
      if (this.paused) {
        throw this.refusal(ERRORS.paused(age(this.memory.pause.until - this.now())));
      }
    }
    if (this.now() > sendBy) {
      throw this.refusal(ERRORS.tooSlow);
    }
  }

  /** One command: the fresh read (identity, door, state), the decision, the pulse. */
  async command(target, ticket, received) {
    const sendBy = received + TIMINGS.commandSendBy;
    const answerBy = received + TIMINGS.commandAnswerBy;
    const check = () => this.checkCommand(target, ticket, sendBy);
    check();
    const connection = this.connection();
    const left = () => sendBy - TIMINGS.commandSendMargin - this.now();
    if (left() <= 0) {
      throw this.refusal(ERRORS.tooSlow);
    }
    // The state just before acting, never the one in memory.
    const readStart = this.now();
    let info;
    try {
      info = await this.client.info(connection, { withCodes: true, timeout: left() });
    } catch (err) {
      if (ticket.generation !== this.generation) {
        throw this.refusal(ERRORS.unknownDevice);
      }
      if (err.kind === 'busy') {
        await this.pause(err);
      } else if (err.kind === 'auth') {
        await this.block();
      }
      this.updateStatus().catch(() => {});
      if (err.kind === 'timeout' && left() <= 0) {
        throw this.refusal(ERRORS.tooSlow);
      }
      throw this.refusal(ERRORS.unknownState(reasonOf(err)));
    }
    // Cancelled, no longer allowed or another configuration while it read.
    check();
    if (!info.id || info.id !== target.gatewayId) {
      throw this.refusal(ERRORS.identity);
    }
    // A pulse that left during this read: the read may show the door before
    // it, so it lifts no guard (the guard or the flight of that pulse holds).
    const fresh = readStart > this.lastSentAt;
    if (fresh) {
      // Shown in the background: the ack never waits for Gladys.
      this.applyRead(info)
        .then(() => this.publishAll())
        .catch((err) => this.logger.warn(`Publishing failed: ${err.message}`));
    }
    const door = info.doors.find((d) => d.id === target.doorId);
    if (!door?.configured) {
      throw this.refusal(ERRORS.doorUnknown);
    }
    if (door.permission === false) {
      throw this.refusal(ERRORS.noPermission);
    }
    if (!drivesADoor(door.mode)) {
      throw this.refusal(ERRORS.unsupportedMode);
    }
    if (!KNOWN_STATUS.has(door.status)) {
      throw this.refusal(ERRORS.statusUnknown);
    }
    if (fresh) {
      this.observeGuard(door);
    }
    const flying = this.flights.get(door.id);
    if (this.guardActive(door.id) || (flying && flying !== ticket)) {
      throw this.refusal(ERRORS.justCommanded);
    }
    // A pulse only from the other end: "open" from closed, "close" from open.
    const from = ticket.open ? DOOR_STATUS.CLOSED : DOOR_STATUS.OPENED;
    if (door.status !== from) {
      // Already so: nothing sent.
      return;
    }
    const code = this.config.type === DEVICE_TYPES.ISMARTGATE ? door.apiCode : info.apiCode;
    if (typeof code !== 'string' || code === '' || code.length > 64) {
      throw this.refusal(ERRORS.missingCode);
    }
    this.flights.set(door.id, ticket);
    try {
      await this.pulse(door, from, ticket, { connection, code, sendBy, answerBy, check });
    } finally {
      if (this.flights.get(door.id) === ticket) {
        this.flights.delete(door.id);
      }
    }
  }

  async pulse(door, from, ticket, { connection, code, sendBy, answerBy, check }) {
    check();
    const name = `door ${door.id}: ${ticket.open ? 'open' : 'close'} pulse`;
    this.logger.info(name);
    try {
      await this.client.activate(connection, door.id, code, {
        timeout: Math.max(200, answerBy - this.now()),
        sendWithin: sendBy - this.now(),
        // The very last check, right before the request leaves.
        beforeSend: () => {
          check();
          ticket.sent = true;
          this.lastSentAt = this.now();
        },
      });
    } catch (err) {
      if (err.beforeSend) {
        throw err;
      }
      const reason = reasonOf(err);
      if (!err.sent) {
        this.logger.warn(`${name} NOT sent (${reason})`);
        throw this.refusal(err.kind === 'late' ? ERRORS.tooSlow : ERRORS.notSent(reason));
      }
      const answered =
        err.kind === 'api' ||
        err.kind === 'auth' ||
        (err.kind === 'http' && err.status >= 400 && err.status <= 499) ||
        (err.kind === 'busy' && err.status === 429);
      if (err.kind === 'busy') {
        await this.pause(err);
      }
      this.followUp();
      if (answered) {
        // The gateway answered with a refusal: no pulse. Never a credentials
        // block from a command (the reads decide that).
        this.logger.warn(`${name} refused (${reason})`);
        throw this.refusal(ERRORS.refused(reason));
      }
      // A silence, a dropped connection, a 5xx, an answer not understood: the
      // pulse may have been given.
      this.guard(door.id, from);
      this.logger.warn(`${name} sent, NOT confirmed (${reason})`);
      throw this.refusal(ERRORS.sentUnconfirmed(reason));
    }
    this.guard(door.id, from);
    this.followUp();
  }

  /**
   * Reads after a pulse, spaced, the last one when the door should have
   * arrived. One series: a new pulse replaces the reads of the previous one.
   */
  followUp() {
    const generation = this.generation;
    for (const handle of this.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.followUps.clear();
    const delays = [...TIMINGS.followUps, this.config.travelTime * SECOND + TIMINGS.guardMargin];
    for (const delay of delays) {
      const handle = this.timers.setTimeout(() => {
        this.followUps.delete(handle);
        if (generation === this.generation) {
          // A read under way began before the pulse: wait for it, then read again.
          Promise.resolve(this.running)
            .then(() => this.tick({ force: true }))
            .catch(() => this.logger.error('Refresh failed'));
        }
      }, delay);
      this.followUps.add(handle);
    }
  }
}

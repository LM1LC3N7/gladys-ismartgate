// -----------------------------------------------------------------------------
// IsmartgateApp with the SDK's fake Gladys, the exact handlers of the
// container (src/handlers.js), a fake gateway behind the client's `request`,
// a fake clock and a memory store. No network; the timers are recorded, never
// fired by themselves.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IsmartgateApp } from '../src/app.js';
import { TIMINGS } from '../src/constants.js';
import { GateClient } from '../src/gate/client.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import {
  API_CODE,
  GATEWAY_ID,
  OTHER_REMOTE,
  PASSWORD,
  REMOTE,
  USER,
  fakeClock,
  fakeGateway,
} from './helpers/fakeGateway.js';

const SELECTOR = 'ismartgate';
const id = (door, key) => `ext:${SELECTOR}:ismartgate:${GATEWAY_ID}-${door}${key ? `:${key}` : ''}`;
const BASE = { host: '192.168.1.30', username: USER, password: PASSWORD };

async function setup(
  t,
  {
    config = {},
    clock = fakeClock(),
    gw = fakeGateway({ type: config.device_type, clock }),
    store = memoryStore(),
    devices = [],
    read = true,
  } = {},
) {
  const gladys = createFakeGladys({ selector: SELECTOR, config: { ...BASE, ...config }, devices });
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  const timeouts = [];
  const timers = {
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, at: clock.now() });
      return timeouts.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
  const app = new IsmartgateApp({
    gladys,
    logger,
    client: new GateClient({ request: gw.request, now: clock.now }),
    store,
    now: clock.now,
    timers,
  });
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  if (read) {
    // The first read, as the timer set by the start would run it.
    await app.tick({ scheduled: true });
  }
  t.after(() => app.stop());
  return { gladys, app, gw, logs, store, clock, timeouts };
}

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

const deviceOf = (gladys, door) =>
  gladys.fake.discoveredDevices.find((d) => d.external_id === id(door)) ??
  gladys.fake.devices.find((d) => d.external_id === id(door));
const featureOf = (device, key) => device.features.find((f) => f.external_id.endsWith(`:${key}`));

async function press(gladys, door, key, value = 1) {
  const device = deviceOf(gladys, door);
  return gladys.fake.setValue(device, featureOf(device, key), value);
}

const status = (gladys) => gladys.fake.connectionStatus;

test('the doors set up become the devices of the Discovery tab; the status says it', async (t) => {
  const { gladys } = await setup(t);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.name, d.external_id]),
    [
      ['Garage', id(1)],
      ['Portail', id(2)],
    ],
  );
  assert.equal(status(gladys).connected, true);
  assert.match(
    status(gladys).message.fr,
    /Home \(ismartgatePRO\)\. Garage : fermée|Garage: fermée/,
  );
  assert.match(status(gladys).message.fr, /Ouverture et fermeture désactivées/);
  assert.match(status(gladys).message.en, /Garage: closed, Portail: open/);
  const gate = deviceOf(gladys, 2);
  assert.deepEqual(
    gate.features.map((f) => f.external_id.split(':').at(-1)),
    ['state', 'open', 'close'],
    'a wired sensor: no temperature nor battery',
  );
  assert.equal(featureOf(gate, 'state').name, 'Portail');
});

test('states: only for the created devices, sent once they are created', async (t) => {
  const { gladys, app } = await setup(t);
  await app.publisher.flush();
  assert.equal(gladys.fake.states.length, 0);
  await createAll(gladys);
  await app.publisher.flush();
  assert.equal(gladys.fake.lastState(id(1, 'state')), 1, 'closed');
  assert.equal(gladys.fake.lastState(id(1, 'temperature')), 16.3);
  assert.equal(gladys.fake.lastState(id(1, 'battery')), 40);
  assert.equal(gladys.fake.lastState(id(2, 'state')), 0, 'open');
  const badge = (door) =>
    gladys.fake.transports.filter((e) => e.device_external_id === id(door)).at(-1)?.transport;
  assert.equal(badge(1), 'local');
  assert.equal(badge(2), 'local');
});

test('opening is refused by default: nothing read, nothing sent', async (t) => {
  const { gladys, gw } = await setup(t);
  await createAll(gladys);
  const reads = gw.reads().length;
  const ack = await press(gladys, 1, 'open');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Autoriser l'ouverture/);
  assert.equal(gw.pulses().length, 0);
  assert.equal(gw.reads().length, reads);
});

test('opening once allowed: a fresh read, one pulse with the code of the door, then a guard', async (t) => {
  const { gladys, gw, logs, timeouts } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  const reads = gw.reads().length;
  const ack = await press(gladys, 1, 'open');
  assert.equal(ack.success, true, ack.error);
  assert.equal(gw.reads().length, reads + 1, 'the state read just before');
  assert.deepEqual(
    gw.pulses().map((c) => c.args),
    [['1', API_CODE]],
  );
  assert.ok(logs.some((l) => /door 1: open pulse/.test(l)));
  assert.ok(
    timeouts.some((h) => h.ms === TIMINGS.followUps[0]),
    'reads after the pulse',
  );
  // The door is still read closed: a second pulse would stop it or send it back.
  const again = await press(gladys, 1, 'open');
  assert.equal(again.success, false);
  assert.match(again.error, /vient d'être commandée/);
  assert.equal(gw.pulses().length, 1);
});

test('the guard lifts when the door is read elsewhere, or after the travel time', async (t) => {
  const { gladys, app, gw, clock } = await setup(t, {
    config: { allow_open: true, travel_time: 20 },
  });
  await createAll(gladys);
  assert.equal((await press(gladys, 1, 'open')).success, true);
  // Read open: lifted, closing is possible (it would stop or reverse an opening).
  gw.doors[1].status = 'opened';
  clock.advance(1000);
  await app.tick({ force: true });
  assert.equal(app.guards.size, 0);
  assert.equal((await press(gladys, 1, 'close')).success, true);
  assert.equal(gw.pulses().length, 2);
  // The close pulse: guarded until read closed; an equal state lifts nothing.
  clock.advance(1000);
  await app.tick({ force: true });
  assert.equal(app.guards.size, 1);
  assert.match((await press(gladys, 1, 'close')).error, /vient d'être commandée/);
  // The travel time (20 s) + 5 s later: lifted, a new close may go.
  clock.advance(25_000);
  assert.equal((await press(gladys, 1, 'close')).success, true);
  assert.equal(gw.pulses().length, 3);
});

test('a pulse only from the other end: "already so" sends nothing; an unknown state refuses', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  assert.equal((await press(gladys, 1, 'close')).success, true, 'already closed');
  assert.equal((await press(gladys, 2, 'open')).success, true, 'already open');
  assert.equal(gw.pulses().length, 0);
  gw.doors[1].status = 'undefined';
  for (const key of ['open', 'close']) {
    const ack = await press(gladys, 1, key);
    assert.equal(ack.success, false);
    assert.match(ack.error, /ne donne pas d'état/);
  }
  assert.equal(gw.pulses().length, 0);
});

test('I1: closing needs the option too: refused unsent, without a read', async (t) => {
  const { gladys, gw } = await setup(t);
  await createAll(gladys);
  const calls = gw.calls.length;
  const ack = await press(gladys, 2, 'close');
  assert.equal(ack.success, false);
  assert.match(ack.error, /même impulsion qu'ouvrir/);
  assert.equal(gw.calls.length, calls, 'nothing read, nothing sent');
  assert.equal(gw.pulses().length, 0);
});

test('I1: the option withdrawn while a close reads the door: refused before sending', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.onSent = (call) => {
    if (call.option === 'info') {
      gw.onSent = undefined;
      gladys.fake.configUpdated({ ...BASE, allow_open: false });
    }
  };
  const ack = await press(gladys, 2, 'close');
  assert.match(ack.error, /même impulsion qu'ouvrir/);
  assert.equal(gw.pulses().length, 0);
});

test('I1: a close refused for the option still cancels the opening waiting', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  let closing;
  gw.onSent = (call) => {
    if (call.option === 'info') {
      gw.onSent = undefined;
      // The option goes off, then a close arrives while the opening reads.
      gladys.fake.configUpdated({ ...BASE, allow_open: false });
      closing = press(gladys, 1, 'close');
    }
  };
  const open = await press(gladys, 1, 'open');
  assert.equal(open.success, false);
  assert.match(
    open.error,
    /Annulée par une commande de fermeture/,
    'cancelled by the refused close',
  );
  assert.match((await closing).error, /même impulsion qu'ouvrir/);
  assert.equal(gw.pulses().length, 0);
});

test('an allowed close goes through a 429/5xx pause (one try); opening waits', async (t) => {
  const { gladys, app, gw, clock, store } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.httpStatus = 503;
  clock.advance(10_000);
  await app.tick();
  assert.ok(store.data.pause, 'pause persisted');
  assert.match(status(gladys).message.fr, /demandé d'attendre/);
  gw.httpStatus = undefined;
  const ack = await press(gladys, 2, 'close');
  assert.equal(ack.success, true, ack.error);
  assert.equal(gw.pulses().length, 1);
  gw.doors[1].status = 'closed';
  const open = await press(gladys, 1, 'open');
  assert.match(open.error, /demandé d'attendre/);
  assert.equal(gw.pulses().length, 1);
});

test('closing goes through a refused-credentials stop (one try), opening never', async (t) => {
  const { gladys, app, gw, clock, store } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.password = 'changed on the gateway';
  clock.advance(10_000);
  await app.tick();
  assert.ok(store.data.block, 'block persisted');
  assert.match(status(gladys).message.fr, /refusé l'identifiant ou le mot de passe/);
  const reads = gw.calls.length;
  assert.match((await press(gladys, 1, 'open')).error, /refusé l'identifiant/);
  assert.equal(gw.calls.length, reads, 'opening: nothing asked');
  const close = await press(gladys, 2, 'close');
  assert.equal(close.success, false);
  assert.equal(gw.calls.length, reads + 1, 'closing: one try');
  assert.equal(gw.pulses().length, 0);
});

test('a close cancels at once an opening of that door not sent yet', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  let closing;
  gw.onSent = (call) => {
    if (call.option === 'info') {
      gw.onSent = undefined;
      // The close arrives while the opening reads the door.
      closing = press(gladys, 1, 'close');
    }
  };
  const open = await press(gladys, 1, 'open');
  assert.equal(open.success, false);
  assert.match(open.error, /Annulée par une commande de fermeture/);
  const close = await closing;
  assert.equal(close.success, true, close.error);
  assert.equal(gw.pulses().length, 0);
});

test('the option is checked again after the read and right before sending', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.onSent = (call) => {
    if (call.option === 'info') {
      gladys.fake.configUpdated({ ...BASE, allow_open: false });
    }
  };
  const ack = await press(gladys, 1, 'open');
  assert.match(ack.error, /Autoriser l'ouverture/);
  assert.equal(gw.pulses().length, 0);
});

test('a slow gateway: refused unsent past 3.5 s; a pulse with no answer is "sent, without confirmation"', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.answerDelay = 3400;
  const slow = await press(gladys, 1, 'open');
  assert.equal(slow.success, false);
  assert.match(slow.error, /à temps|n'a pas pu être lu/);
  assert.equal(gw.pulses().length, 0);
  gw.answerDelay = 10;
  gw.onSent = (call) => {
    if (call.option === 'activate') {
      gw.failure = 'silent';
    }
  };
  const silent = await press(gladys, 1, 'open');
  assert.match(silent.error, /envoyée, sans confirmation/);
  assert.equal(gw.pulses().length, 1);
  gw.failure = undefined;
  gw.onSent = undefined;
  // Guarded: the door still reads closed, a new pulse could stop it.
  assert.match((await press(gladys, 1, 'open')).error, /vient d'être commandée/);
});

test('a pulse refused by the gateway (wrong code, 429): no pulse, no guard; a 5xx: unconfirmed', async (t) => {
  const { gladys, app, gw, store } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  // The code changes between the read and the pulse.
  gw.onSent = (call) => {
    if (call.option === 'activate') gw.doors[1].apicode = 'rotated';
  };
  const wrong = await press(gladys, 1, 'open');
  assert.match(wrong.error, /refusé la commande/);
  assert.equal(app.guards.size, 0);
  assert.ok(!store.data?.block, 'a refused command never blocks the reads');
  gw.doors[1].apicode = undefined;
  gw.onSent = (call) => {
    if (call.option === 'activate') gw.httpStatus = 500;
  };
  const busy = await press(gladys, 1, 'open');
  assert.match(busy.error, /sans confirmation/);
  assert.equal(app.guards.size, 1);
  assert.ok(store.data.pause);
});

test('the gateway at the address must be this one: another one refuses, its doors are shown', async (t) => {
  const { gladys, app, gw, clock } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.remote = OTHER_REMOTE;
  const ack = await press(gladys, 2, 'close');
  assert.equal(ack.success, false);
  assert.match(ack.error, /reconnue/);
  assert.equal(gw.pulses().length, 0);
  clock.advance(10_000);
  await app.tick();
  assert.equal(status(gladys).connected, false);
  assert.match(
    status(gladys).message.en,
    /Another gateway answers at this address: Garage, Portail/,
  );
  assert.match((await press(gladys, 2, 'close')).error, /n'est plus celle/);
  // An id that cannot be read is not "another gateway".
  gw.remote = REMOTE;
  clock.advance(10_000);
  await app.tick();
  gw.remote = '';
  clock.advance(10_000);
  await app.tick();
  assert.match(status(gladys).message.en, /remote access name/);
  assert.equal(app.gw.id, GATEWAY_ID);
});

test('a door in on/off mode, without permission, or no longer set up: refused', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.doors[1].mode = 'onoff';
  assert.match((await press(gladys, 1, 'open')).error, /marche\/arrêt/);
  gw.doors[1].mode = 'pulse';
  gw.doors[1].permission = 'no';
  assert.match((await press(gladys, 1, 'open')).error, /pas de droit/);
  gw.doors[1].permission = 'yes';
  gw.doors[1].name = '';
  assert.match((await press(gladys, 1, 'open')).error, /plus configurée/);
  assert.equal(gw.pulses().length, 0);
});

test('a created feature is never lost: a door switched to on/off keeps its buttons (refused)', async (t) => {
  const { gladys, app, gw, clock } = await setup(t);
  await createAll(gladys);
  gw.doors[1].mode = 'onoff';
  clock.advance(10_000);
  await app.tick();
  const door = gladys.fake.discoveredDevices.find((d) => d.external_id === id(1));
  assert.deepEqual(
    door.features.map((f) => f.external_id.split(':').at(-1)),
    ['state', 'temperature', 'battery', 'open', 'close'],
  );
});

test('never read sooner than the interval: reconnection, scan, test button, unchanged config', async (t) => {
  const { gladys, app, gw, clock } = await setup(t);
  await createAll(gladys);
  const reads = gw.reads().length;
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.discoveredDevices.length;
  await gladys.connect();
  assert.equal(gw.reads().length, reads, 'a reconnection reads nothing');
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'the status is sent again');
  assert.ok(gladys.fake.discoveredDevices.length >= discoveries);
  await gladys.fake.scanRequest();
  await gladys.fake.configUpdated({ ...BASE });
  await app.tick();
  const test1 = await gladys.fake.action('test_connection');
  assert.match(test1.data.message.fr, /il y a moins d'un intervalle/);
  assert.equal(gw.reads().length, reads);
  clock.advance(10_000);
  const test2 = await gladys.fake.action('test_connection');
  assert.match(test2.data.message.fr, /Connecté/);
  assert.equal(gw.reads().length, reads + 1);
});

test('a restart: the last read kept in /data delays the first one; close works before it', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const config = { allow_open: true };
  const first = await setup(t, { clock, store, config });
  await createAll(first.gladys);
  await first.app.stop();
  const devices = first.gladys.fake.devices;
  clock.advance(3000);
  const gw = fakeGateway({ clock });
  const second = await setup(t, { clock, store, gw, devices, read: false, config });
  const timer = second.timeouts.at(-1);
  assert.ok(timer.ms >= 10_000 - 3000, `first read in ${timer.ms} ms`);
  await second.app.tick();
  assert.equal(gw.reads().length, 0, 'not before the interval');
  // The gateway id kept in /data: close is possible before any read.
  const ack = await press(second.gladys, 2, 'close');
  assert.equal(ack.success, true, ack.error);
  assert.equal(gw.pulses().length, 1);
});

test('refused credentials: a stop kept across restarts, lifted by other credentials only', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const gw = fakeGateway({ clock });
  gw.password = 'other';
  const first = await setup(t, { clock, store, gw });
  assert.ok(store.data.block);
  assert.ok(!JSON.stringify(store.data).includes(PASSWORD), 'no password in /data');
  await first.app.stop();
  clock.advance(60_000);
  assert.equal(gw.calls.length, 1);
  const second = await setup(t, { clock, store, gw, read: false });
  await second.app.tick({ scheduled: true });
  assert.equal(gw.calls.length, 1, 'the same credentials: still stopped');
  assert.match(status(second.gladys).message.fr, /refusé/);
  gw.password = 'typed again';
  await second.gladys.fake.configUpdated({ ...BASE, password: 'typed again' });
  await second.app.tick({ scheduled: true });
  assert.equal(gw.calls.length, 2, 'other credentials: read at once');
  assert.equal(store.data.block, null, 'cleared at the first success');
  assert.equal(status(second.gladys).connected, true);
});

test('a read or an answer of an older configuration publishes nothing', async (t) => {
  const { gladys, app, gw } = await setup(t, { read: false });
  gw.onSent = (call) => {
    if (call.option === 'info') {
      gw.onSent = undefined;
      // New credentials while the read is under way.
      gladys.fake.configUpdated({ ...BASE, username: 'other' });
    }
  };
  await app.tick({ scheduled: true });
  assert.equal(app.gw.info, undefined);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('a read begun before a pulse left is not applied', async (t) => {
  const { gladys, app, gw, clock } = await setup(t);
  await createAll(gladys);
  gw.onSent = (call) => {
    if (call.option === 'info') {
      app.lastSentAt = clock.now();
      gw.doors[1].status = 'opened';
    }
  };
  clock.advance(10_000);
  await app.tick();
  assert.equal(app.gw.info.doors[0].status, 'closed');
});

test('no secret in the logs, the statuses nor /data', async (t) => {
  const { gladys, app, gw, logs, store, clock } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  await press(gladys, 1, 'open');
  gw.failure = 'silent';
  clock.advance(60_000);
  await app.tick();
  gw.failure = undefined;
  gw.password = 'x';
  clock.advance(600_000);
  await app.tick();
  const everything = JSON.stringify([
    logs,
    store.data,
    gladys.fake.connectionStatuses,
    gladys.fake.requests,
  ]);
  for (const secret of [PASSWORD, `"${USER}"`, API_CODE, 'abcdefg12345', 'data=']) {
    assert.ok(!everything.includes(secret), secret);
  }
});

test('GogoGate2: no token, the gateway code for every door', async (t) => {
  const { gladys, gw } = await setup(t, { config: { device_type: 'gogogate2', allow_open: true } });
  await createAll(gladys);
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  assert.equal((await press(gladys, 1, 'open')).success, true);
  assert.deepEqual(gw.pulses()[0].args, ['1', API_CODE]);
  assert.deepEqual(gw.pulses()[0].query, ['data']);
});

test('not configured: a status, no read, created devices unreachable', async (t) => {
  const gw = fakeGateway();
  const { gladys } = await setup(t, {
    gw,
    config: { host: '', username: '', password: '' },
    devices: [{ name: 'Garage', external_id: id(1), features: [] }],
    read: false,
  });
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.fr, /adresse IP/);
  assert.equal(gw.calls.length, 0);
  assert.deepEqual(gladys.fake.transports.at(-1), {
    device_external_id: id(1),
    transport: 'unreachable',
  });
  const ack = await gladys.fake.setValue(
    { external_id: id(1) },
    { external_id: id(1, 'close') },
    1,
  );
  assert.match(ack.error, /pas configurée/);
});

test('a bad command value or a read-only feature: refused', async (t) => {
  const { gladys, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  for (const value of [0, 2, '', null, true]) {
    assert.match((await press(gladys, 1, 'open', value)).error, /Valeur invalide/);
  }
  const device = deviceOf(gladys, 1);
  assert.match(
    (await gladys.fake.setValue(device, featureOf(device, 'state'), 1)).error,
    /ne se commande pas/,
  );
  assert.equal(gw.pulses().length, 0);
});

test('B1: a door read "undefined": the status says unknown, the reads go on, no state', async (t) => {
  const { gladys, app, gw, clock, timeouts } = await setup(t);
  await createAll(gladys);
  await app.publisher.flush();
  const states = gladys.fake.states.filter((s) => s.device_feature_external_id === id(1, 'state'));
  gw.doors[1].status = 'undefined';
  clock.advance(10_000);
  const before = timeouts.length;
  await app.tick();
  assert.ok(app.timer, 'the next read is scheduled');
  assert.ok(timeouts.length > before);
  assert.match(status(gladys).message.fr, /Garage: inconnu/);
  assert.match(status(gladys).message.en, /Garage: unknown/);
  await app.publisher.flush();
  assert.equal(
    gladys.fake.states.filter((s) => s.device_feature_external_id === id(1, 'state')).length,
    states.length,
    'no state published for it',
  );
  // A test, a reconnection and a creation still work.
  clock.advance(10_000);
  assert.match((await gladys.fake.action('test_connection')).data.message.fr, /inconnu/);
  await gladys.connect();
  await gladys.fake.deviceCreated(deviceOf(gladys, 1));
});

test('B1: a status that throws never stops the polling', async (t) => {
  const { app, clock } = await setup(t);
  app.status = () => {
    throw new Error('boom');
  };
  clock.advance(10_000);
  await app.tick();
  assert.ok(app.timer, 'the next read is scheduled');
});

test('M1: the guard after a pulse survives a restart', async (t) => {
  const clock = fakeClock();
  const store = memoryStore();
  const config = { allow_open: true };
  const first = await setup(t, { clock, store, config });
  await createAll(first.gladys);
  assert.equal((await press(first.gladys, 2, 'close')).success, true);
  assert.equal(store.data.guards.length, 1);
  await first.app.stop();
  clock.advance(5000);
  const gw = fakeGateway({ clock });
  const second = await setup(t, {
    clock,
    store,
    gw,
    config,
    devices: first.gladys.fake.devices,
    read: false,
  });
  const ack = await press(second.gladys, 2, 'close');
  assert.match(ack.error, /vient d'être commandée/);
  assert.equal(gw.pulses().length, 0, 'no second pulse on a moving door');
  // After the travel time, a close may go again.
  clock.advance(31_000);
  assert.equal((await press(second.gladys, 2, 'close')).success, true);
});

test('M2: an answer in clear that is not an error is refused', async (t) => {
  const { gladys, app, gw, clock } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.raw = gw.infoXml();
  clock.advance(10_000);
  await app.tick();
  assert.equal(status(gladys).connected, false);
  assert.match(status(gladys).message.en, /invalid/);
  gw.raw = undefined;
  clock.advance(60_000);
  await app.tick();
  gw.onSent = (call) => {
    if (call.option === 'activate') gw.raw = '<response><result>OK</result></response>';
  };
  const ack = await press(gladys, 1, 'open');
  assert.match(ack.error, /sans confirmation \(invalid\)/, 'a forged "OK" is not a confirmation');
});

test('M3: one queue per door: an opening of door 2 does not wait for door 1', async (t) => {
  const { gladys, app, gw } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.doors[2].status = 'closed';
  let second;
  gw.onSent = (call) => {
    if (call.option === 'info') {
      gw.onSent = undefined;
      second = press(gladys, 2, 'open');
    }
  };
  const first = await press(gladys, 1, 'open');
  assert.equal(first.success, true, first.error);
  assert.equal((await second).success, true);
  assert.equal(gw.pulses().length, 2);
  assert.equal(app.queues.size, 0);
  const options = gw.calls.slice(-4).map((c) => c.option);
  assert.ok(
    options.indexOf('info', 1) < options.lastIndexOf('activate'),
    `door 2 read before door 1 finished: ${options}`,
  );
});

test('M4: a door removed from the gateway is an orphan: unreachable, named', async (t) => {
  const { gladys, app, gw, clock } = await setup(t);
  await createAll(gladys);
  gw.doors[1].name = '';
  clock.advance(10_000);
  await app.tick();
  const badge = gladys.fake.transports.filter((e) => e.device_external_id === id(1)).at(-1);
  assert.equal(badge.transport, 'unreachable');
  assert.match(status(gladys).message.fr, /Plus configurée sur la passerelle : Garage/);
  assert.equal(status(gladys).connected, true, 'the gateway itself answers');
});

test('M5: a door without a sensor has no state: no state, every pulse refused', async (t) => {
  const { gladys, app, gw, clock } = await setup(t, { config: { allow_open: true } });
  await createAll(gladys);
  gw.doors[2].sensor = 'no';
  clock.advance(10_000);
  await app.tick();
  assert.match(status(gladys).message.en, /Portail: unknown/);
  const ack = await press(gladys, 2, 'close');
  assert.match(ack.error, /ne donne pas d'état/);
  gw.doors[2].status = 'closed';
  assert.match((await press(gladys, 2, 'open')).error, /ne donne pas d'état/);
  assert.equal(gw.pulses().length, 0);
});

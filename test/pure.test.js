// -----------------------------------------------------------------------------
// The pure parts: the envelope of the API, the XML scanner, the answers, the
// configuration, the /data state and the Gladys devices.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseHost } from '../src/config.js';
import { DEVICE_TYPES, TIMINGS } from '../src/constants.js';
import { buildDevice, featuresOf, parseExternalId, valuesOf } from '../src/devices.js';
import { keyOf, pythonJson, seal, tokenOf, unseal } from '../src/gate/cipher.js';
import { GateClient } from '../src/gate/client.js';
import { errorOf, gatewayIdOf, parseInfo } from '../src/gate/parse.js';
import { parseXml } from '../src/gate/xml.js';
import { fingerprintOf, normalizeMemory } from '../src/store.js';
import { API_CODE, PASSWORD, USER, fakeGateway } from './helpers/fakeGateway.js';

const ismartgate = { type: DEVICE_TYPES.ISMARTGATE, address: { host: '192.168.1.30', port: 80 } };

test('the key and the token are the ones of the ismartgate library', () => {
  // Computed with Python's hashlib as ISmartGateApiCipher does.
  assert.equal(keyOf('ismartgate', 'Admin', 'pa$$ wörd').toString('utf8'), '6e91a5e1!97c*#8c');
  assert.equal(tokenOf('Admin'), 'f7001ecfe4d09ea0e58cb09058ba11ffe3ea36f0');
  assert.equal(keyOf('gogogate2', 'x', 'y').toString('utf8'), '0e3b7%i1X9@54cAf');
  assert.equal(keyOf('ismartgate', 'a', 'b').length, 16);
});

test('the request text is the one of json.dumps (", ", ensure_ascii)', () => {
  assert.equal(
    pythonJson(['Admin', 'pa$$ wörd', 'info', '', '']),
    '["Admin", "pa$$ w\\u00f6rd", "info", "", ""]',
  );
  assert.equal(pythonJson(['a"b\\c', '€', '😀']), '["a\\"b\\\\c", "\\u20ac", "\\ud83d\\ude00"]');
});

test('seal and unseal: 16 initialisation characters, then base64; a wrong key fails', () => {
  const key = keyOf('ismartgate', USER, PASSWORD);
  const sealed = seal(key, '<response><result>OK</result></response>', '0123456789abcdef');
  assert.ok(sealed.startsWith('0123456789abcdef'));
  assert.match(sealed.slice(16), /^[A-Za-z0-9+/]+=*$/);
  assert.equal(unseal(key, sealed), '<response><result>OK</result></response>');
  assert.equal(
    unseal(key, `${sealed}\n`.replace(/(.{40})/, '$1\r\n')),
    '<response><result>OK</result></response>',
  );
  // A wrong key fails, or (padding valid by chance) gives garbage the XML scanner refuses.
  let opened;
  try {
    opened = unseal(keyOf('ismartgate', USER, 'other'), sealed);
  } catch {
    opened = undefined;
  }
  assert.notEqual(opened, '<response><result>OK</result></response>');
  assert.throws(() => unseal(key, 'short'));
  assert.throws(() => unseal(key, `${sealed.slice(0, 16)}!!!!${sealed.slice(20)}`));
  const random = seal(key, 'x');
  assert.match(random.slice(0, 16), /^[0-9a-f]{16}$/);
});

test('the XML scanner: elements, entities, CDATA, comments; DOCTYPE and junk refused', () => {
  const root = parseXml(
    '﻿<?xml version="1.0"?><!-- c --><response a="x>y"><name>A &amp; B &#233;</name><e/><c><![CDATA[<raw>]]></c></response>\n',
  );
  assert.equal(root.name, 'response');
  assert.deepEqual(
    root.children.map((c) => [c.name, c.text]),
    [
      ['name', 'A & B é'],
      ['e', ''],
      ['c', '<raw>'],
    ],
  );
  for (const bad of [
    '<!DOCTYPE x [<!ENTITY a "b">]><response/>',
    'not xml',
    '<a><b></a>',
    '<a></a><b></b>',
    '<a>',
    '<1a></1a>',
    'x<a></a>',
  ]) {
    assert.throws(() => parseXml(bad), bad);
  }
});

test('the XML scanner is bounded: depth, elements, text length; a name never becomes a key', () => {
  assert.throws(() => parseXml('<a><b><c><d><e><f><g></g></f></e></d></c></b></a>'));
  assert.throws(() => parseXml(`<a>${'<b/>'.repeat(500)}</a>`));
  const long = parseXml(`<a>${'x'.repeat(100_000)}</a>`);
  assert.equal(long.text.length, 512);
  const proto = parseXml(
    '<response><__proto__>1</__proto__><constructor>2</constructor></response>',
  );
  assert.equal({}.polluted, undefined);
  assert.equal(proto.children[0].name, '__proto__');
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  // Linear: a large flat answer is read quickly.
  const started = Date.now();
  parseXml(`<a>${'<b>&amp;</b>'.repeat(399)}</a>`);
  parseXml(`<a>${'&amp;'.repeat(12_000)}</a>`);
  assert.ok(Date.now() - started < 500);
});

test('an info answer: doors set up, states, sensors, the hashed id; codes only on demand', () => {
  const gw = fakeGateway();
  const root = parseXml(gw.infoXml());
  const info = parseInfo('ismartgate', root);
  assert.equal(info.id, gatewayIdOf('abcdefg12345.isgaccess.com'));
  assert.match(info.id, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(info).includes('abcdefg12345'), 'the remote access name is hashed');
  assert.equal(info.name, 'Home');
  assert.deepEqual(
    info.doors.map((d) => [
      d.id,
      d.configured,
      d.status,
      d.gate,
      d.radio,
      d.temperature,
      d.battery,
    ]),
    [
      [1, true, 'closed', false, true, 16.3, 40],
      [2, true, 'opened', true, false, undefined, undefined],
      [3, false, undefined, false, true, undefined, undefined],
    ],
  );
  assert.ok(!JSON.stringify(info).includes(API_CODE), 'no activation code by default');
  assert.equal(parseInfo('ismartgate', root, { withCodes: true }).doors[0].apiCode, API_CODE);
  // ismartgate Mini: the doors without apicode are not there.
  gw.doors[2] = undefined;
  gw.doors[3] = undefined;
  assert.deepEqual(
    parseInfo('ismartgate', parseXml(gw.infoXml())).doors.map((d) => d.id),
    [1],
  );
  // GogoGate2: one code for the gateway.
  const gg2 = fakeGateway({ type: 'gogogate2' });
  const parsed = parseInfo('gogogate2', parseXml(gg2.infoXml()), { withCodes: true });
  assert.equal(parsed.apiCode, API_CODE);
  assert.equal(parsed.doors.length, 3);
  assert.equal(gatewayIdOf(''), undefined);
  assert.equal(gatewayIdOf('../x'), undefined);
  assert.equal(gatewayIdOf('ABCDEFG12345.other.net'), info.id, 'case and domain do not matter');
});

test('door values: odd numbers and the "none" value are left out', () => {
  const gw = fakeGateway();
  Object.assign(gw.doors[1], { temperature: '1e9', voltage: '140', status: 'moving' });
  const [door] = parseInfo('ismartgate', parseXml(gw.infoXml())).doors;
  assert.deepEqual(
    [door.status, door.temperature, door.battery],
    [undefined, undefined, undefined],
  );
  assert.deepEqual(valuesOf(door), []);
  assert.deepEqual(valuesOf({ status: 'closed', temperature: 12.5, battery: 80 }), [
    { key: 'state', value: 1 },
    { key: 'temperature', value: 12.5 },
    { key: 'battery', value: 80 },
  ]);
  assert.deepEqual(valuesOf({ status: 'opened' }), [{ key: 'state', value: 0 }]);
});

test('an error answer: its code', () => {
  assert.deepEqual(
    errorOf(
      parseXml(
        '<response><error><errorcode>11</errorcode><errormsg>x</errormsg></error></response>',
      ),
    ),
    { code: 11 },
  );
  assert.equal(errorOf(parseXml('<response><result>OK</result></response>')), undefined);
});

test('the client: request shape, errors by family, answers not understood', async () => {
  const gw = fakeGateway();
  const client = new GateClient({ request: gw.request, now: gw.clock.now });
  const connection = { ...ismartgate, auth: { username: USER, password: PASSWORD } };
  const info = await client.info(connection);
  assert.equal(info.doors.length, 3);
  const [call] = gw.calls;
  assert.deepEqual(call.query, ['data', 't', 'token']);
  assert.equal(call.json, '["Admin", "pa$$ w\\u00f6rd", "info", "", ""]');
  assert.ok(!call.path.includes(USER) && !call.path.includes('pa$$'), 'never in clear');
  await client.activate(connection, 1, API_CODE);
  assert.deepEqual(gw.calls.at(-1).args, ['1', API_CODE]);
  await assert.rejects(client.activate(connection, 1, 'wrong'), { kind: 'api', reason: 'apiCode' });
  await assert.rejects(
    client.info({ ...connection, auth: { username: USER, password: 'wrong' } }),
    { kind: 'auth' },
  );
  gw.httpStatus = 503;
  gw.headers = { 'retry-after': '120' };
  await assert.rejects(client.info(connection), { kind: 'busy', retryAfter: 120_000 });
  gw.httpStatus = 404;
  await assert.rejects(client.info(connection), { kind: 'http', status: 404 });
  gw.httpStatus = undefined;
  gw.raw = 'garbage';
  await assert.rejects(client.info(connection), { kind: 'invalid' });
  gw.raw = '<html>login</html>';
  await assert.rejects(client.info(connection), { kind: 'invalid' });
  // GogoGate2: no token, code 1 is "credentials", 11 "corrupted".
  const gg2 = fakeGateway({ type: 'gogogate2' });
  const c2 = new GateClient({ request: gg2.request });
  const conn2 = { ...connection, type: 'gogogate2' };
  await c2.info(conn2);
  assert.deepEqual(gg2.calls[0].query, ['data']);
  await assert.rejects(c2.info({ ...conn2, auth: { username: USER, password: 'x' } }), {
    kind: 'auth',
  });
  gg2.apiError.info = 11;
  await assert.rejects(c2.info(conn2), { kind: 'api', reason: 'corrupted' });
});

test('the configuration: address, credentials, bounds, the option strictly true', () => {
  assert.deepEqual(parseHost('http://192.168.1.30/index.php'), {
    address: { host: '192.168.1.30', port: 80 },
  });
  assert.deepEqual(parseHost('gate.local:8080'), { address: { host: 'gate.local', port: 8080 } });
  assert.deepEqual(parseHost('admin:secret@192.168.1.30'), { credentials: true });
  assert.equal(parseHost('999.1.1.1').address, undefined);
  const config = normalizeConfig({
    host: '192.168.1.30',
    username: ' Admin ',
    password: 'x',
    poll_interval: '1',
    travel_time: 999,
    allow_open: 'yes',
  });
  assert.deepEqual(config.auth, { username: 'Admin', password: 'x' });
  assert.equal(config.pollInterval, 5);
  assert.equal(config.travelTime, 120);
  assert.equal(config.allowOpen, false, 'only true allows');
  assert.equal(normalizeConfig({ allow_open: true }).allowOpen, true);
  assert.equal(normalizeConfig({ username: 'a' }).badAuth, 'missing');
  assert.equal(normalizeConfig({ username: 'a', password: 'b\u0000' }).badAuth, 'invalid');
  assert.equal(normalizeConfig({ device_type: 'gogogate2' }).type, 'gogogate2');
  assert.equal(normalizeConfig({ device_type: 'other' }).type, 'ismartgate');
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 10);
});

test('/data: bounded when read back, no secret, the refused pair only as a salted fingerprint', () => {
  const now = 1_800_000_000_000;
  const memory = normalizeMemory(
    {
      salt: '0'.repeat(32),
      pause: { until: now + 100 * 3600_000, failures: 3, address: '192.168.1.30' },
      block: { until: now + 1e12, failures: 2, fp: 'a'.repeat(32), address: '192.168.1.30' },
      gateway: { address: '192.168.1.30', id: '0123456789abcdef' },
      lastAttemptAt: now + 1e9,
    },
    now,
  );
  assert.equal(memory.pause.until, now + TIMINGS.pauseMax);
  assert.equal(memory.block.until, now + TIMINGS.authRetries.at(-1));
  assert.equal(memory.lastAttemptAt, now);
  assert.deepEqual(memory.gateway, { address: '192.168.1.30', id: '0123456789abcdef' });
  assert.equal(normalizeMemory({ gateway: { address: 'x', id: 'not hex' } }, now).gateway, null);
  assert.equal(normalizeMemory({ block: { until: now + 1, fp: 'short' } }, now).block, null);
  assert.equal(normalizeMemory(null, now).pause, null);
  assert.match(normalizeMemory(null, now).salt, /^[0-9a-f]{32}$/);
  const fp = fingerprintOf('0'.repeat(32), '["ismartgate","Admin","secret"]');
  assert.match(fp, /^[0-9a-f]{32}$/);
  assert.notEqual(fp, fingerprintOf('1'.repeat(32), '["ismartgate","Admin","secret"]'));
});

test('a door is never a switch: a read-only opening sensor and buttons', () => {
  const gladys = createFakeGladys({ selector: 'ismartgate' });
  const info = { id: '0123456789abcdef', model: 'ismartgatePRO', firmware: '1.7.3' };
  const door = { id: 1, name: 'Garage', mode: 'garage', status: 'closed', radio: true };
  const device = buildDevice(gladys, info, door, { language: 'fr', host: '192.168.1.30' });
  assert.equal(device.external_id, 'ext:ismartgate:ismartgate:0123456789abcdef-1');
  assert.deepEqual(
    device.features.map((f) => [
      f.external_id.split(':').at(-1),
      f.category,
      f.type,
      f.read_only,
      f.unit,
    ]),
    [
      ['state', 'opening-sensor', 'binary', true, undefined],
      ['open', 'button', 'push', false, undefined],
      ['close', 'button', 'push', false, undefined],
      ['temperature', 'temperature-sensor', 'decimal', true, 'celsius'],
      ['battery', 'battery', 'integer', true, 'percent'],
    ],
  );
  for (const feature of device.features) {
    assert.notEqual(feature.category, 'switch');
    assert.ok(feature.read_only || feature.type !== 'binary');
  }
  assert.equal(device.features[1].name, 'Ouvrir la porte');
  // An on/off output: no button.
  assert.deepEqual(
    featuresOf({ ...door, mode: 'onoff', radio: false }).map((f) => f.key),
    ['state'],
  );
  assert.deepEqual(parseExternalId(gladys, device.features[1].external_id), {
    gatewayId: '0123456789abcdef',
    doorId: 1,
    key: 'open',
  });
  assert.equal(parseExternalId(gladys, 'ext:other:ismartgate:0123456789abcdef-1:open'), undefined);
  assert.equal(
    parseExternalId(gladys, 'ext:ismartgate:ismartgate:0123456789abcdef-4:open'),
    undefined,
  );
});

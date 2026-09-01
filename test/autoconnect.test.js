// Unit tests for autoconnect planning, run with `npm test` (node:test).
//
// The scenario that drives most of these: a phone is paired once, then wireless
// debugging is toggled off and on. The pairing key survives, but Android hands
// out a brand-new connect port — so a plan that only ever tried the remembered
// port would silently stop working and look like the pairing had been lost.

const test = require('node:test');
const assert = require('node:assert');
const {
  STALE_MS,
  serialFromInstance,
  listAdvertised,
  isWirelessSerial,
  rememberDevice,
  forgetKnownDevice,
  pruneKnown,
  planReconnect,
} = require('../src/autoconnect');

// Real `adb mdns services` output: a header line, then one row per endpoint. The
// pairing endpoint is advertised alongside the connect one and must not be used.
const MDNS = `List of discovered mdns services
adb-39041FDJH00BQZ-vWLnDS	_adb-tls-connect._tcp.	192.168.1.23:37123
adb-39041FDJH00BQZ-vWLnDS	_adb-tls-pairing._tcp.	192.168.1.23:44011
adb-R5CT10ABCDE-Kq2mLp	_adb-tls-connect._tcp.	192.168.1.44:41999
`;

const NOW = Date.UTC(2026, 7, 31);

test('an mDNS instance name yields the device serial that outlives its address', () => {
  assert.strictEqual(serialFromInstance('adb-39041FDJH00BQZ-vWLnDS'), '39041FDJH00BQZ');
  assert.strictEqual(serialFromInstance('not-an-adb-name'), null);
  assert.strictEqual(serialFromInstance(''), null);
  assert.strictEqual(serialFromInstance(null), null);
});

test('only the connect endpoint is advertised as connectable', () => {
  const ads = listAdvertised(MDNS);
  assert.strictEqual(ads.length, 2, 'the pairing endpoint is not a connect target');
  assert.deepStrictEqual(ads[0], {
    instance: 'adb-39041FDJH00BQZ-vWLnDS',
    deviceSerial: '39041FDJH00BQZ',
    target: '192.168.1.23:37123',
    host: '192.168.1.23',
    port: '37123',
  });
  assert.strictEqual(ads[1].target, '192.168.1.44:41999');
  assert.deepStrictEqual(listAdvertised(''), []);
  assert.deepStrictEqual(listAdvertised(null), []);
});

test('a wireless serial is told apart from a USB one', () => {
  assert.strictEqual(isWirelessSerial('192.168.1.23:37123'), true);
  assert.strictEqual(isWirelessSerial('[fe80::1]:5555'), true);
  assert.strictEqual(isWirelessSerial('39041FDJH00BQZ'), false, 'a USB serial cannot be connected to');
  assert.strictEqual(isWirelessSerial(''), false);
});

test('a reconnect at a new port updates the entry instead of adding one', () => {
  // This is the whole point of keying on the device serial: the phone below is
  // the same phone at a new port, not a second device.
  let known = rememberDevice([], { target: '192.168.1.23:37123', deviceSerial: 'ABC' }, NOW);
  known = rememberDevice(known, { target: '192.168.1.23:41000', deviceSerial: 'ABC' }, NOW + 1000);
  assert.strictEqual(known.length, 1);
  assert.strictEqual(known[0].port, '41000');
  assert.strictEqual(known[0].lastSeen, NOW + 1000);
});

test('a device with no known serial is keyed by host so the IP is still remembered', () => {
  let known = rememberDevice([], { target: '192.168.1.23:37123' }, NOW);
  known = rememberDevice(known, { target: '192.168.1.23:41000' }, NOW);
  assert.strictEqual(known.length, 1);
  assert.strictEqual(known[0].deviceSerial, null);
  assert.strictEqual(known[0].port, '41000');
  // A different host is a different device.
  known = rememberDevice(known, { target: '192.168.1.44:41999' }, NOW);
  assert.strictEqual(known.length, 2);
});

test('a label survives a later reconnect that does not carry one', () => {
  let known = rememberDevice([], { target: '192.168.1.23:1', deviceSerial: 'ABC', label: 'Pixel 8' }, NOW);
  known = rememberDevice(known, { target: '192.168.1.23:2', deviceSerial: 'ABC' }, NOW);
  assert.strictEqual(known[0].label, 'Pixel 8');
});

test('a target with no host is not remembered', () => {
  assert.deepStrictEqual(rememberDevice([], { target: '' }), []);
  assert.deepStrictEqual(rememberDevice(null, { target: '' }), []);
});

test('forgetting works by either serial or address', () => {
  const known = [
    { deviceSerial: 'ABC', host: '192.168.1.23', port: '1', lastSeen: NOW },
    { deviceSerial: null, host: '192.168.1.44', port: '2', lastSeen: NOW },
  ];
  assert.strictEqual(forgetKnownDevice(known, 'ABC').length, 1);
  assert.strictEqual(forgetKnownDevice(known, '192.168.1.44').length, 1);
  assert.strictEqual(forgetKnownDevice(known, '192.168.1.44:2').length, 1, 'a full serial resolves to its host');
  assert.strictEqual(forgetKnownDevice(known, 'nothing').length, 2);
});

test('a device not seen for months is dropped', () => {
  const known = [
    { deviceSerial: 'FRESH', host: '10.0.0.1', lastSeen: NOW - 1000 },
    { deviceSerial: 'STALE', host: '10.0.0.2', lastSeen: NOW - STALE_MS - 1 },
    { deviceSerial: 'NOHOST', lastSeen: NOW },
  ];
  assert.deepStrictEqual(pruneKnown(known, NOW).map((k) => k.deviceSerial), ['FRESH']);
  assert.deepStrictEqual(pruneKnown(null, NOW), []);
});

test('the advertised port beats the remembered one for the same device', () => {
  // The remembered port is stale — the phone is listening on 37123 now.
  const plan = planReconnect({
    known: [{ deviceSerial: '39041FDJH00BQZ', host: '192.168.1.23', port: '5555', lastSeen: NOW }],
    mdns: MDNS,
  });
  assert.strictEqual(plan[0].target, '192.168.1.23:37123');
  assert.strictEqual(plan[0].reason, 'discovered');
  // The stale port is still tried, in case mDNS is being blocked or wrong.
  assert.deepStrictEqual(plan.map((p) => p.target), ['192.168.1.23:37123', '192.168.1.23:5555']);
});

test('a device recognised only by its old IP is still matched', () => {
  const plan = planReconnect({
    known: [{ deviceSerial: null, host: '192.168.1.44', port: '41999', lastSeen: NOW }],
    mdns: MDNS,
  });
  assert.strictEqual(plan.length, 1, 'the advertised and remembered targets are the same address');
  assert.strictEqual(plan[0].target, '192.168.1.44:41999');
});

test('an unrecognised phone on the network is not connected to by default', () => {
  const plan = planReconnect({ known: [], mdns: MDNS });
  assert.deepStrictEqual(plan, [], 'auto-attaching to a stranger\'s device would be a privacy problem');

  const opted = planReconnect({ known: [], mdns: MDNS, includeNew: true });
  assert.deepStrictEqual(opted.map((p) => p.reason), ['new', 'new']);
});

test('a device already attached is not connected to again', () => {
  const plan = planReconnect({
    known: [{ deviceSerial: '39041FDJH00BQZ', host: '192.168.1.23', port: '37123', lastSeen: NOW }],
    mdns: MDNS,
    connected: ['192.168.1.23:37123'],
  });
  assert.deepStrictEqual(plan, []);
});

test('the most recently used device is tried first when mDNS is silent', () => {
  const plan = planReconnect({
    known: [
      { deviceSerial: 'OLD', host: '10.0.0.1', port: '5555', lastSeen: NOW - 10000 },
      { deviceSerial: 'NEW', host: '10.0.0.2', port: '5555', lastSeen: NOW },
    ],
    mdns: '',
  });
  assert.deepStrictEqual(plan.map((p) => p.deviceSerial), ['NEW', 'OLD']);
  assert.ok(plan.every((p) => p.reason === 'remembered'));
});

test('a remembered device with no port is skipped rather than guessed at', () => {
  // Connecting to a made-up port would either fail or, worse, hit some unrelated
  // service on the phone.
  const plan = planReconnect({ known: [{ deviceSerial: 'ABC', host: '10.0.0.1', lastSeen: NOW }], mdns: '' });
  assert.deepStrictEqual(plan, []);
});

test('planning with nothing known and nothing advertised is empty, not an error', () => {
  assert.deepStrictEqual(planReconnect(), []);
  assert.deepStrictEqual(planReconnect({ known: null, mdns: null, connected: null }), []);
});

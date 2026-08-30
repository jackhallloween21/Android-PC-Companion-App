// Tests for the wireless-debugging helpers. The mDNS fixture is shaped like real
// `adb mdns services` output, which advertises both a pairing and a connect
// service — connecting to the pairing one is the mistake that leaves a phone
// showing "paired" while the app lists no devices.

const test = require('node:test');
const assert = require('node:assert');
const {
  splitHostPort,
  isPaired,
  isConnected,
  pickConnectTarget,
  connectCandidates,
} = require('../src/wireless');

const MDNS = `List of discovered mdns services
adb-39041FDJH00BQZ-vWLnDS	_adb-tls-pairing._tcp.	192.168.1.23:41235
adb-39041FDJH00BQZ-vWLnDS	_adb-tls-connect._tcp.	192.168.1.23:37123
adb-OTHERDEVICE-aBcDeF	_adb-tls-connect._tcp.	192.168.1.44:45001
`;

test('host and port split apart, including IPv6 and bare hosts', () => {
  assert.deepStrictEqual(splitHostPort('192.168.1.23:41235'), { host: '192.168.1.23', port: '41235' });
  assert.deepStrictEqual(splitHostPort('  192.168.1.23:41235  '), { host: '192.168.1.23', port: '41235' });
  assert.deepStrictEqual(splitHostPort('adb://192.168.1.23:5555'), { host: '192.168.1.23', port: '5555' });
  assert.deepStrictEqual(splitHostPort('192.168.1.23'), { host: '192.168.1.23', port: null });
  assert.deepStrictEqual(splitHostPort('[fe80::1]:5555'), { host: '[fe80::1]', port: '5555' });
  assert.deepStrictEqual(splitHostPort(''), { host: '', port: null });
  assert.deepStrictEqual(splitHostPort(undefined), { host: '', port: null });
});

test('pair and connect outcomes are read from the output text', () => {
  // adb exits 0 for most of these, so the text is the only signal.
  assert.strictEqual(isPaired('Successfully paired to 192.168.1.23:41235 [guid=adb-39041FDJ]'), true);
  assert.strictEqual(isPaired('Failed: Wrong password'), false);
  assert.strictEqual(isPaired('failed to connect to 192.168.1.23:41235'), false);
  assert.strictEqual(isPaired(''), false);

  assert.strictEqual(isConnected('connected to 192.168.1.23:37123'), true);
  assert.strictEqual(isConnected('already connected to 192.168.1.23:37123'), true);
  assert.strictEqual(isConnected('failed to connect to 192.168.1.23:37123: Connection refused'), false);
  assert.strictEqual(isConnected('cannot connect to 192.168.1.23:37123'), false);
  assert.strictEqual(isConnected(''), false);
});

test('mDNS discovery picks the connect service, never the pairing one', () => {
  assert.strictEqual(pickConnectTarget(MDNS, '192.168.1.23'), '192.168.1.23:37123');
  assert.strictEqual(pickConnectTarget(MDNS, '192.168.1.44'), '192.168.1.44:45001');
  assert.strictEqual(pickConnectTarget(MDNS), '192.168.1.23:37123', 'first connect entry when unfiltered');
  assert.strictEqual(pickConnectTarget(MDNS, '10.0.0.9'), null, 'a host that is not advertising');
  assert.strictEqual(pickConnectTarget('List of discovered mdns services\n'), null);
  assert.strictEqual(pickConnectTarget(''), null);
});

test('an explicit connect port is tried before mDNS discovery', () => {
  assert.deepStrictEqual(
    connectCandidates('192.168.1.23', '37123', MDNS),
    ['192.168.1.23:37123'],
    'the discovered target is the same one, so it is not duplicated'
  );
  assert.deepStrictEqual(
    connectCandidates('192.168.1.23', '5555', MDNS),
    ['192.168.1.23:5555', '192.168.1.23:37123'],
    'user value first, discovery as the fallback'
  );
  assert.deepStrictEqual(
    connectCandidates('192.168.1.23', '', MDNS),
    ['192.168.1.23:37123'],
    'blank field falls back to discovery alone'
  );
  assert.deepStrictEqual(
    connectCandidates('192.168.1.23', null, ''),
    [],
    'nothing to try when the port is unknown and mDNS is silent'
  );
});

const test = require('node:test');
const assert = require('node:assert');
const {
  buildPairingPayload,
  newPairingSession,
  findPairingEndpoint,
  mdnsUnavailable,
} = require('../src/pairing');

// A counter instead of real randomness, so names and passwords are predictable.
const fakeRandom = (n) => Buffer.from(Array.from({ length: n }, (_, i) => i * 7 + 1));

test('the payload uses the format the phone camera expects', () => {
  assert.strictEqual(
    buildPairingPayload('companion-abc123', 'Sw3rTy9pQz'),
    'WIFI:T:ADB;S:companion-abc123;P:Sw3rTy9pQz;;'
  );
});

test('a ";" in a field is rejected rather than corrupting the payload', () => {
  assert.throws(() => buildPairingPayload('bad;name', 'pw'), /must not contain/);
  assert.throws(() => buildPairingPayload('name', 'pw;'), /must not contain/);
  assert.throws(() => buildPairingPayload('', 'pw'), /must not be empty/);
});

test('a session produces a hex-suffixed name and a printable password', () => {
  const session = newPairingSession(fakeRandom);
  assert.match(session.name, /^companion-[0-9a-f]{6}$/);
  assert.strictEqual(session.password.length, 10);
  assert.match(session.password, /^[A-Za-z0-9]+$/);
  assert.strictEqual(session.payload, `WIFI:T:ADB;S:${session.name};P:${session.password};;`);
});

test('the password avoids visually ambiguous characters', () => {
  // The user may have to compare it against the phone's screen.
  for (let i = 0; i < 64; i += 1) {
    const { password } = newPairingSession((n) => Buffer.from(Array.from({ length: n }, () => i)));
    assert.doesNotMatch(password, /[01OIl]/);
  }
});

const MDNS_OUTPUT = [
  'List of discovered mdns services',
  'adb-39041FDJH00BQZ-vWLnDS\t_adb-tls-connect._tcp.\t192.168.1.23:37123',
  'companion-3f9a2c\t_adb-tls-pairing._tcp.\t192.168.1.23:41235',
].join('\n');

test('the pairing endpoint is found by service name', () => {
  const found = findPairingEndpoint(MDNS_OUTPUT, 'companion-3f9a2c');
  assert.strictEqual(found.target, '192.168.1.23:41235');
  assert.strictEqual(found.port, '41235');
});

test('the connect service is never mistaken for the pairing service', () => {
  const connectOnly = 'adb-XYZ\t_adb-tls-connect._tcp.\t192.168.1.23:37123';
  assert.strictEqual(findPairingEndpoint(connectOnly, 'companion-3f9a2c'), null);
});

test('a pairing service under an unexpected name is still used, if it is the only one', () => {
  // Some ROMs advertise the pairing endpoint under their own instance name; the
  // alternative is telling the user nothing happened when it actually did.
  const renamed = 'adb-39041FDJH00BQZ-abcdef\t_adb-tls-pairing._tcp.\t192.168.1.9:44001';
  const found = findPairingEndpoint(renamed, 'companion-3f9a2c');
  assert.strictEqual(found.target, '192.168.1.9:44001');
});

test('the rename fallback can be withheld', () => {
  // Early in a session, a stray pairing row is much more likely to be someone
  // else's phone with its own pairing dialog open than ours having renamed the
  // service — and firing our password at it burns their pairing attempt.
  const renamed = 'adb-39041FDJH00BQZ-abcdef\t_adb-tls-pairing._tcp.\t192.168.1.9:44001';
  assert.strictEqual(
    findPairingEndpoint(renamed, 'companion-3f9a2c', { allowRename: false }),
    null
  );
});

test('an ambiguous rename is never guessed at', () => {
  // Two unrecognised pairing endpoints: there is no way to tell which one scanned
  // our code, so neither is used.
  const two = [
    'adb-AAAA-aaaa\t_adb-tls-pairing._tcp.\t192.168.1.9:44001',
    'adb-BBBB-bbbb\t_adb-tls-pairing._tcp.\t192.168.1.10:44002',
  ].join('\n');
  assert.strictEqual(findPairingEndpoint(two, 'companion-3f9a2c'), null);
  // …but our own name still wins when it is present alongside them.
  const withOurs = `${two}\ncompanion-3f9a2c\t_adb-tls-pairing._tcp.\t192.168.1.23:41235`;
  assert.strictEqual(findPairingEndpoint(withOurs, 'companion-3f9a2c').target, '192.168.1.23:41235');
});

test('an exact name match wins over an unrelated pairing row', () => {
  const both = [
    'someone-else\t_adb-tls-pairing._tcp.\t192.168.1.50:40000',
    'companion-3f9a2c\t_adb-tls-pairing._tcp.\t192.168.1.23:41235',
  ].join('\n');
  assert.strictEqual(findPairingEndpoint(both, 'companion-3f9a2c').target, '192.168.1.23:41235');
});

test('IPv6 pairing endpoints are parsed', () => {
  const v6 = 'companion-3f9a2c\t_adb-tls-pairing._tcp.\t[fe80::1c2b:3d4e]:41235';
  assert.strictEqual(findPairingEndpoint(v6, 'companion-3f9a2c').target, '[fe80::1c2b:3d4e]:41235');
});

test('empty or header-only output yields nothing', () => {
  assert.strictEqual(findPairingEndpoint('', 'x'), null);
  assert.strictEqual(findPairingEndpoint('List of discovered mdns services', 'x'), null);
});

test('a broken mDNS backend is recognised', () => {
  // These are `adb mdns check` outputs, not `adb mdns services`: with a dead
  // daemon, `services` prints only its header and no error at all.
  assert.ok(mdnsUnavailable('ERROR: mdns daemon unavailable'));
  assert.ok(mdnsUnavailable('mdns backend not running'));
  assert.ok(mdnsUnavailable('adb: unable to connect to mdns daemon'));
  assert.ok(!mdnsUnavailable('mdns daemon version [10102438]'));
  assert.ok(!mdnsUnavailable(MDNS_OUTPUT));
  // No output is not evidence of a fault; pairing should still be attempted.
  assert.ok(!mdnsUnavailable(''));
});

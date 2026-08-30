// Tests for the key and status-bar argv builders. A wrong keycode is silent —
// `input keyevent` dispatches any valid code without complaint — so the exact
// numbers are pinned here against the Android KeyEvent constants.

const test = require('node:test');
const assert = require('node:assert');
const {
  KEYCODES,
  keyEventArgs,
  statusBarArgs,
  describeStatusBarFailure,
} = require('../src/keys');

test('the navigation keycodes are the KeyEvent constants', () => {
  assert.strictEqual(KEYCODES.back, 4);
  assert.strictEqual(KEYCODES.home, 3);
  assert.strictEqual(KEYCODES.recents, 187, 'KEYCODE_APP_SWITCH, not 82 (MENU)');
  assert.strictEqual(KEYCODES.power, 26);
  assert.strictEqual(KEYCODES.volumeUp, 24);
  assert.strictEqual(KEYCODES.volumeDown, 25);
});

test('keyEventArgs builds a serial-scoped keyevent', () => {
  assert.deepStrictEqual(
    keyEventArgs('R5CW10', 'back'),
    ['-s', 'R5CW10', 'shell', 'input', 'keyevent', '4']
  );
  assert.deepStrictEqual(
    keyEventArgs('R5CW10', 'power', { longPress: true }),
    ['-s', 'R5CW10', 'shell', 'input', 'keyevent', '--longpress', '26'],
    '--longpress goes before the code'
  );
});

test('an unknown action or missing serial is rejected rather than sent', () => {
  assert.throws(() => keyEventArgs('R5CW10', 'homescreen'), /Unknown key action/);
  assert.throws(() => keyEventArgs('', 'home'), /No device selected/);
  assert.throws(() => keyEventArgs(undefined, 'home'), /No device selected/);
});

test('the shade is opened with cmd statusbar, which has no keyevent equivalent', () => {
  assert.deepStrictEqual(
    statusBarArgs('R5CW10', 'notifications'),
    ['-s', 'R5CW10', 'shell', 'cmd', 'statusbar', 'expand-notifications']
  );
  assert.deepStrictEqual(
    statusBarArgs('R5CW10', 'quickSettings'),
    ['-s', 'R5CW10', 'shell', 'cmd', 'statusbar', 'expand-settings']
  );
  assert.deepStrictEqual(
    statusBarArgs('R5CW10', 'collapse'),
    ['-s', 'R5CW10', 'shell', 'cmd', 'statusbar', 'collapse']
  );
  assert.throws(() => statusBarArgs('R5CW10', 'expand'), /Unknown status bar panel/);
  assert.throws(() => statusBarArgs(null, 'notifications'), /No device selected/);
});

test('a missing statusbar service is explained, not echoed raw', () => {
  const msg = describeStatusBarFailure("cmd: Can't find service: statusbar");
  assert.match(msg, /Android 7/);
  assert.strictEqual(
    describeStatusBarFailure('device offline'),
    'device offline',
    'unrelated failures pass through unchanged'
  );
  assert.match(describeStatusBarFailure(''), /Could not open/);
});

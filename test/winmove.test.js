// Tests for the in-place window mover. Nothing here spawns PowerShell — what is
// worth pinning is the argv/env contract, because the window title carries a
// device serial and must never end up interpolated into script text.

const test = require('node:test');
const assert = require('node:assert');
const {
  MOVE_SCRIPT,
  RECT_SCRIPT,
  encodeCommand,
  moveWindowArgs,
  findWindowEnv,
  moveWindowEnv,
  canMoveWindows,
  classifyMoveResult,
  parseRectOutput,
} = require('../src/winmove');

test('the script is encoded as base64 UTF-16LE, which is what -EncodedCommand expects', () => {
  const encoded = encodeCommand('Write-Output "hi"');
  assert.strictEqual(Buffer.from(encoded, 'base64').toString('utf16le'), 'Write-Output "hi"');
  assert.match(encoded, /^[A-Za-z0-9+/=]+$/, 'no characters a shell could reinterpret');
});

test('argv disables the profile and passes the script encoded rather than inline', () => {
  const args = moveWindowArgs(MOVE_SCRIPT);
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  const i = args.indexOf('-EncodedCommand');
  assert.notStrictEqual(i, -1);
  assert.strictEqual(
    Buffer.from(args[i + 1], 'base64').toString('utf16le'),
    MOVE_SCRIPT,
    'the payload round-trips to the exact script'
  );
  assert.ok(!args.some((a) => a.includes('MoveWindow')), 'no raw script text on the command line');
});

test('both scripts share the pid-first lookup, so a resize and a rect read agree', () => {
  for (const script of [MOVE_SCRIPT, RECT_SCRIPT]) {
    assert.match(script, /COMPANION_WIN_PID/, 'pid is tried first');
    assert.match(script, /COMPANION_WIN_TITLE/, 'title is the backstop');
    assert.match(script, /NOTFOUND/, 'a missing window is reported, not treated as success');
  }
});

test('the target rect and window identity travel through the environment, rounded to whole pixels', () => {
  const env = moveWindowEnv({ pid: 4321, title: 'Mirror — R5CW10' },
    { x: 700.4, y: 40.6, width: 420.2, height: 934.8 });
  assert.deepStrictEqual(env, {
    COMPANION_WIN_PID: '4321',
    COMPANION_WIN_TITLE: 'Mirror — R5CW10',
    COMPANION_WIN_X: '700',
    COMPANION_WIN_Y: '41',
    COMPANION_WIN_W: '420',
    COMPANION_WIN_H: '935',
  });
  Object.values(env).forEach((v) => assert.strictEqual(typeof v, 'string',
    'execFile rejects non-string env values'));
});

test('a pid alone is enough, and a bare title string is still accepted', () => {
  assert.deepStrictEqual(findWindowEnv({ pid: 900 }), { COMPANION_WIN_PID: '900' });
  const env = moveWindowEnv('Mirror — X', { x: 0, y: 0, width: 10, height: 20 });
  assert.strictEqual(env.COMPANION_WIN_TITLE, 'Mirror — X');
  assert.strictEqual(env.COMPANION_WIN_PID, undefined);
});

test('no window identity, or a zero-size rect, is refused instead of moving something else', () => {
  assert.throws(() => moveWindowEnv({}, { x: 0, y: 0, width: 10, height: 10 }), /pid or a title/i);
  assert.throws(() => moveWindowEnv({ pid: 1 }, null), /rectangle/i);
  assert.throws(() => moveWindowEnv({ pid: 1 }, { x: 0, y: 0, width: 0, height: 10 }), /rectangle/i);
});

test('the window rect is parsed back into x/y/width/height', () => {
  assert.deepStrictEqual(parseRectOutput('RECT 100 40 420 934\r\n'),
    { x: 100, y: 40, width: 420, height: 934 });
  assert.deepStrictEqual(parseRectOutput('RECT -1920 -30 800 600'),
    { x: -1920, y: -30, width: 800, height: 600 }, 'a monitor left of the primary has negative x');
  assert.strictEqual(parseRectOutput('NOTFOUND'), null);
  assert.strictEqual(parseRectOutput('RECT 0 0 0 0'), null, 'a minimised window is not a usable rect');
  assert.strictEqual(parseRectOutput(''), null);
});

test('only Windows can be moved in place; elsewhere the caller must relaunch', () => {
  assert.strictEqual(canMoveWindows('win32'), true);
  assert.strictEqual(canMoveWindows('darwin'), false);
  assert.strictEqual(canMoveWindows('linux'), false);
});

test('the three outcomes are distinguished, because only "notfound" means "relaunch"', () => {
  assert.strictEqual(classifyMoveResult('OK\r\n'), 'ok');
  assert.strictEqual(classifyMoveResult('NOTFOUND'), 'notfound');
  assert.strictEqual(classifyMoveResult('FAILED'), 'failed');
  assert.strictEqual(classifyMoveResult(''), 'failed', 'no output is a failure, not a success');
  assert.strictEqual(classifyMoveResult(undefined), 'failed');
});

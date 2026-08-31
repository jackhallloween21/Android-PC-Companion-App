// Tests for scrcpy CLI feature detection. The fixtures are trimmed --help text
// from three generations; the 4.x case is the one that produced
//   "unknown option -- video-bitrate=8M"
// when the flag name was guessed from the version number instead of read here.

const test = require('node:test');
const assert = require('node:assert');
const {
  supportsFlag,
  pickFlag,
  buildMirrorArgs,
  hasAudio,
  hasAudioSource,
  hasCameraSource,
} = require('../src/scrcpy');

const HELP_1X = `
Usage: scrcpy [options]

Options:
    -b, --bit-rate value
        Encode the video at the given bit-rate.
    -m, --max-size value
    --max-fps value
    -w, --stay-awake
    -S, --turn-screen-off
    -t, --show-touches
    --window-title=text
`;

const HELP_MODERN = `
Usage: scrcpy [options]

Options:
    --audio-bit-rate=value
        Encode the audio at the given bit rate.
    --audio-source=source
        Select the audio source (output, playback, mic).
    -b, --video-bit-rate=value
        Encode the video at the given bit-rate, expressed in bits/s.
    -m, --max-size=value
    --max-fps=value
    --no-audio
    --video-source=source
    --camera-facing=facing
    -w, --stay-awake
    -S, --turn-screen-off
    -t, --show-touches
    --window-title=text
`;

const INFO_1X = { version: 'scrcpy 1.25', major: 1, minor: 25, help: HELP_1X };
const INFO_41 = { version: 'scrcpy 4.1', major: 4, minor: 1, help: HELP_MODERN };
const INFO_BLIND = { version: 'scrcpy 4.1', major: 4, minor: 1, help: null };

const OPTS = {
  maxSize: 0, bitrate: 8, maxFps: 60, stayAwake: true,
  turnScreenOff: false, showTouches: false, forwardAudio: true,
};

test('flag detection respects word boundaries', () => {
  // The trap: "--bit-rate" is a substring of both "--video-bit-rate" and
  // "--audio-bit-rate", which are the only two a modern build actually accepts.
  assert.strictEqual(supportsFlag(HELP_MODERN, '--video-bit-rate'), true);
  assert.strictEqual(supportsFlag(HELP_MODERN, '--bit-rate'), false);
  assert.strictEqual(supportsFlag(HELP_1X, '--bit-rate'), true);
  assert.strictEqual(supportsFlag(HELP_1X, '--video-bit-rate'), false);
  // The misspelling that caused the crash exists in no generation.
  assert.strictEqual(supportsFlag(HELP_MODERN, '--video-bitrate'), false);
  assert.strictEqual(supportsFlag(HELP_1X, '--video-bitrate'), false);
});

test('unreadable help is reported as unknown, not as unsupported', () => {
  assert.strictEqual(supportsFlag(null, '--no-audio'), null);
  assert.strictEqual(supportsFlag('', '--no-audio'), null);
});

test('the newest spelling a build accepts is the one picked', () => {
  assert.strictEqual(pickFlag(HELP_MODERN, ['--video-bit-rate', '--bit-rate']), '--video-bit-rate');
  assert.strictEqual(pickFlag(HELP_1X, ['--video-bit-rate', '--bit-rate']), '--bit-rate');
  assert.strictEqual(pickFlag(HELP_MODERN, ['--nonexistent']), null,
    'a flag no generation has is dropped rather than passed');
  assert.strictEqual(pickFlag(null, ['--video-bit-rate', '--bit-rate']), '--video-bit-rate',
    'with no help text, assume the modern spelling');
});

test('scrcpy 4.1 gets --video-bit-rate, never --video-bitrate', () => {
  const args = buildMirrorArgs('R5CW10', OPTS, INFO_41);
  assert.ok(args.includes('--video-bit-rate=8M'));
  assert.ok(!args.some((a) => a.startsWith('--video-bitrate')), 'the flag that 4.1 rejects');
  assert.ok(!args.some((a) => a.startsWith('--bit-rate')));
  assert.deepStrictEqual(args.slice(0, 3), ['-s', 'R5CW10', '--window-title=Mirror — R5CW10']);
});

test('scrcpy 1.x gets the old flag and no audio options', () => {
  const args = buildMirrorArgs('R5CW10', { ...OPTS, forwardAudio: false }, INFO_1X);
  assert.ok(args.includes('--bit-rate=8M'));
  assert.ok(!args.includes('--no-audio'), '1.x has no audio support at all');
});

test('unchecked options are omitted and checked ones are passed', () => {
  const args = buildMirrorArgs('R5CW10', {
    maxSize: 1080, bitrate: 4, maxFps: 30,
    stayAwake: true, turnScreenOff: true, showTouches: true, forwardAudio: false,
  }, INFO_41);
  assert.ok(args.includes('--max-size=1080'));
  assert.ok(args.includes('--max-fps=30'));
  assert.ok(args.includes('--stay-awake'));
  assert.ok(args.includes('--turn-screen-off'));
  assert.ok(args.includes('--show-touches'));
  assert.ok(args.includes('--no-audio'));

  const minimal = buildMirrorArgs('R5CW10', { forwardAudio: true }, INFO_41);
  assert.deepStrictEqual(minimal, ['-s', 'R5CW10', '--window-title=Mirror — R5CW10']);
});

test('a flag the build does not advertise is dropped, not passed', () => {
  // A hypothetical future build that removed --show-touches and --window-title.
  const stripped = { version: 'scrcpy 9.0', major: 9, minor: 0, help: '    -b, --video-bit-rate=value\n    --no-audio\n' };
  const args = buildMirrorArgs('R5CW10', { bitrate: 8, showTouches: true, forwardAudio: false }, stripped);
  assert.deepStrictEqual(args, ['-s', 'R5CW10', '--video-bit-rate=8M', '--no-audio']);
});

test('audio forwarding suppresses --no-audio', () => {
  assert.ok(!buildMirrorArgs('x', { forwardAudio: true }, INFO_41).includes('--no-audio'));
  assert.ok(buildMirrorArgs('x', { forwardAudio: false }, INFO_41).includes('--no-audio'));
});

test('with no help text the version number is the fallback', () => {
  const args = buildMirrorArgs('x', OPTS, INFO_BLIND);
  assert.ok(args.includes('--video-bit-rate=8M'));
  assert.strictEqual(hasAudio(INFO_BLIND), true);
  assert.strictEqual(hasAudio({ major: 1, minor: 25, help: null }), false);
  assert.strictEqual(hasAudioSource({ major: 2, minor: 1, help: null }), false);
  assert.strictEqual(hasAudioSource({ major: 2, minor: 2, help: null }), true);
  assert.strictEqual(hasCameraSource({ major: 2, minor: 1, help: null }), false);
  assert.strictEqual(hasCameraSource({ major: 3, minor: 0, help: null }), true);
});

test('capability checks prefer help text over the version number', () => {
  assert.strictEqual(hasAudio(INFO_41), true);
  assert.strictEqual(hasAudioSource(INFO_41), true);
  assert.strictEqual(hasCameraSource(INFO_41), true);
  assert.strictEqual(hasAudio(INFO_1X), false);
  assert.strictEqual(hasAudioSource(INFO_1X), false);
  assert.strictEqual(hasCameraSource(INFO_1X), false);
});

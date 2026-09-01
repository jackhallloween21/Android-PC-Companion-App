// Tests for camera capability parsing and camera argv. The parser is pinned
// against real `scrcpy --list-camera-sizes` output shapes, because the resolution
// picker is only trustworthy if it offers sizes the sensor actually reports —
// asking for anything else makes scrcpy exit rather than fall back.

const test = require('node:test');
const assert = require('node:assert');
const {
  parseCameraList,
  describeCamera,
  buildCameraArgs,
  supportsMic,
  supportsV4l2,
  parseEncoderLimits,
  sizeFitsEncoder,
  annotateSizes,
  describeCameraFailure,
  torchArgs,
  parseQsTiles,
  hasTorchTile,
  parseTorchStatus,
  describeTorchFailure,
  describeBridge,
  TORCH_TILES,
} = require('../src/camera');

// Captured from scrcpy 4.1 --list-camera-sizes, log prefixes included.
const LIST = `
INFO: List of cameras:
    --camera-id=0    (back, 4000x3000, fps=[15, 20, 24, 30])
        - 1920x1080
        - 4000x3000
        - 1280x720
      High speed capture (--camera-high-speed):
        - 1280x720 (fps=[120, 240])
    --camera-id=1    (front, 3264x2448, fps=[30])
        - 3264x2448
`;

const HELP_MODERN = `
    --video-source=value
    --camera-id=value
    --camera-facing=value
    --camera-size=value
    --camera-fps=value
    --camera-high-speed
    --audio-source=value
        Select the audio source. Possible values are "output", "mic" and "playback".
    --no-audio
    --window-title=text
`;

const HELP_LINUX = `${HELP_MODERN}
    --v4l2-sink=/dev/videoN
`;

const HELP_OLD = `
Options:
    -b, --bit-rate value
    -m, --max-size value
`;

test('cameras, their native size, fps list and megapixels are read from the list', () => {
  const cams = parseCameraList(LIST);
  assert.strictEqual(cams.length, 2);
  assert.strictEqual(cams[0].id, '0');
  assert.strictEqual(cams[0].facing, 'back');
  assert.strictEqual(cams[0].maxSize, '4000x3000');
  assert.strictEqual(cams[0].megapixels, 12, '4000x3000 pixels is 12 MP');
});

test('megapixels are a one-decimal figure, not a raw pixel count', () => {
  const [cam] = parseCameraList('--camera-id=0    (back, 3264x2448, fps=[30])');
  assert.strictEqual(cam.megapixels, 8, '3264x2448 rounds to 8.0 MP');
});

test('sizes are sorted biggest first, which is the order a picker wants', () => {
  const [rear] = parseCameraList(LIST);
  assert.deepStrictEqual(rear.sizes.map((s) => s.size), ['4000x3000', '1920x1080', '1280x720'],
    'scrcpy lists sensor order, which is not always descending');
});

test('high-speed sizes are kept apart, because they need their own flag', () => {
  const [rear] = parseCameraList(LIST);
  assert.deepStrictEqual(rear.highSpeedSizes.map((s) => s.size), ['1280x720']);
  assert.deepStrictEqual(rear.highSpeedSizes[0].fps, [120, 240]);
  assert.ok(!rear.sizes.some((s) => s.fps && s.fps.includes(240)),
    'a 240fps mode must not leak into the normal list where it would fail to start');
});

test('per-camera fps comes from the header line', () => {
  const cams = parseCameraList(LIST);
  assert.deepStrictEqual(cams[0].fps, [15, 20, 24, 30]);
  assert.deepStrictEqual(cams[1].fps, [30]);
  assert.strictEqual(cams[1].facing, 'front');
});

test('the second camera does not inherit the first camera sizes', () => {
  const cams = parseCameraList(LIST);
  assert.deepStrictEqual(cams[1].sizes.map((s) => s.size), ['3264x2448']);
});

test('unusable output yields no cameras rather than a guess', () => {
  assert.deepStrictEqual(parseCameraList(''), []);
  assert.deepStrictEqual(parseCameraList(undefined), []);
  assert.deepStrictEqual(parseCameraList('ERROR: Could not connect'), []);
});

test('an unknown facing value is preserved instead of being mislabelled', () => {
  const [cam] = parseCameraList('--camera-id=9    (weird, 640x480, fps=[30])');
  assert.strictEqual(cam.facing, 'weird');
  assert.match(describeCamera(cam), /Camera \(id 9\)/, 'no label means the generic word, not "Rear"');
});

test('describeCamera reads as one human line', () => {
  const [rear, front] = parseCameraList(LIST);
  assert.strictEqual(describeCamera(rear), 'Rear (id 0) · 12 MP · 4000x3000');
  assert.match(describeCamera(front), /^Front \(id 1\)/);
  assert.strictEqual(describeCamera(null), '');
});

// ---- argv ------------------------------------------------------------------

test('a camera stream selects the camera source and silences audio by default', () => {
  const args = buildCameraArgs('SER1', {}, HELP_MODERN);
  assert.deepStrictEqual(args, [
    '-s', 'SER1', '--video-source=camera', '--no-audio', '--window-title=Camera — SER1',
  ]);
});

test('id wins over facing, because passing both is an error in scrcpy', () => {
  const args = buildCameraArgs('SER1', { cameraId: '1', facing: 'back' }, HELP_MODERN);
  assert.ok(args.includes('--camera-id=1'));
  assert.ok(!args.some((a) => a.startsWith('--camera-facing')));
  const byFacing = buildCameraArgs('SER1', { facing: 'front' }, HELP_MODERN);
  assert.ok(byFacing.includes('--camera-facing=front'));
});

test('camera id 0 is not mistaken for "no id given"', () => {
  const args = buildCameraArgs('SER1', { cameraId: '0', facing: 'front' }, HELP_MODERN);
  assert.ok(args.includes('--camera-id=0'));
  assert.ok(!args.some((a) => a.startsWith('--camera-facing')));
});

test('resolution, fps and high speed are passed as chosen', () => {
  const args = buildCameraArgs('SER1',
    { cameraId: '0', size: '1920x1080', fps: 60, highSpeed: true }, HELP_MODERN);
  assert.ok(args.includes('--camera-size=1920x1080'));
  assert.ok(args.includes('--camera-fps=60'));
  assert.ok(args.includes('--camera-high-speed'));
});

test('the microphone replaces the silence, and only when the build offers it', () => {
  const withMic = buildCameraArgs('SER1', { mic: true }, HELP_MODERN);
  assert.ok(withMic.includes('--audio-source=mic'));
  assert.ok(!withMic.includes('--no-audio'), 'asking for audio and disabling it is contradictory');

  const noMicBuild = buildCameraArgs('SER1', { mic: true }, `
    --audio-source=value
        Possible values are "output" and "playback".
    --no-audio
    --video-source=value
  `);
  assert.ok(noMicBuild.includes('--no-audio'), 'a build without mic support falls back to silence');
});

test('the v4l2 sink is only offered where the build has it', () => {
  const args = buildCameraArgs('SER1', { v4l2Device: '/dev/video9' }, HELP_LINUX);
  assert.ok(args.includes('--v4l2-sink=/dev/video9'));
  assert.throws(() => buildCameraArgs('SER1', { v4l2Device: '/dev/video9' }, HELP_MODERN),
    /v4l2-sink/, 'passing an unknown option would be fatal, so it is refused up front');
  assert.strictEqual(supportsV4l2(HELP_LINUX), true);
  assert.strictEqual(supportsV4l2(HELP_MODERN), false);
});

test('an old build is refused with a version, not an unknown-option crash', () => {
  assert.throws(() => buildCameraArgs('SER1', {}, HELP_OLD), /2\.2 or newer/);
  assert.throws(() => buildCameraArgs('', {}, HELP_MODERN), /No device/);
});

test('camera window title is formatted with serial', () => {
  const { cameraWindowTitle } = require('../src/camera');
  assert.strictEqual(cameraWindowTitle('ABC123XYZ'), 'Camera — ABC123XYZ');
});

test('bitrate, maxFps, orientation, and record are passed when supported', () => {
  const HELP_EXTRA = `${HELP_MODERN}
    --video-bit-rate=value
    --max-fps=value
    --capture-orientation=value
    --record=file.mp4
  `;
  const args = buildCameraArgs('SER1', {
    bitrate: 8,
    maxFps: 60,
    orientation: 90,
    record: 'C:\\Videos\\cam.mp4',
  }, HELP_EXTRA);
  assert.ok(args.includes('--video-bit-rate=8M'));
  assert.ok(args.includes('--max-fps=60'));
  assert.ok(args.includes('--capture-orientation=90'));
  assert.ok(args.includes('--record=C:\\Videos\\cam.mp4'));
});

test('unreadable help falls back to the modern spelling rather than doing nothing', () => {
  const args = buildCameraArgs('SER1', { size: '1280x720' }, null);
  assert.ok(args.includes('--video-source=camera'));
  assert.ok(args.includes('--camera-size=1280x720'));
  assert.strictEqual(supportsMic(null), true);
});

// ---- torch -----------------------------------------------------------------

test('the torch is toggled through the quick-settings tile', () => {
  assert.deepStrictEqual(torchArgs('SER1'),
    ['-s', 'SER1', 'shell', 'cmd', 'statusbar', 'click-tile', TORCH_TILES[0]]);
  assert.ok(torchArgs('SER1', TORCH_TILES[1]).includes(TORCH_TILES[1]),
    'the fully-qualified tile name is accepted for ROMs that need it');
  assert.throws(() => torchArgs(''), /No device/);
});

test('a torch failure is explained in terms of what to do about it', () => {
  assert.match(describeTorchFailure('cmd: Unknown command: click-tile'), /Android 11 or newer/);
  assert.match(describeTorchFailure('java.lang.SecurityException: nope'), /blocks adb/);
  assert.match(describeTorchFailure("can't find service statusbar"), /blocks adb/);
  assert.match(describeTorchFailure('Invalid tile'), /flashlight quick-settings tile/);
  assert.match(describeTorchFailure(''), /Could not toggle/);
});

// ---- virtual camera bridge -------------------------------------------------
// The point of these is honesty: the UI must not show a green light on Windows,
// where nothing we can install from here makes the phone a selectable camera.

test('Linux with a loopback device is the one fully-working route', () => {
  const b = describeBridge({ platform: 'linux', help: HELP_LINUX, v4l2Devices: ['/dev/video9'] });
  assert.strictEqual(b.mode, 'v4l2');
  assert.strictEqual(b.ready, true);
  assert.match(b.hint, /\/dev\/video9/);
});

test('Linux without the module loaded says how to load it', () => {
  const b = describeBridge({ platform: 'linux', help: HELP_LINUX, v4l2Devices: [] });
  assert.strictEqual(b.mode, 'v4l2');
  assert.strictEqual(b.ready, false);
  assert.match(b.hint, /modprobe v4l2loopback/);
});

test('a Linux scrcpy built without v4l2 support is reported as such', () => {
  const b = describeBridge({ platform: 'linux', help: HELP_MODERN, v4l2Devices: ['/dev/video9'] });
  assert.strictEqual(b.mode, 'none');
  assert.strictEqual(b.ready, false);
  assert.match(b.hint, /--v4l2-sink/);
});

test('Windows is honest: no driver means not ready, and OBS is the only route', () => {
  const bare = describeBridge({ platform: 'win32', help: HELP_MODERN });
  assert.strictEqual(bare.mode, 'none');
  assert.strictEqual(bare.ready, false);
  assert.match(bare.hint, /OBS Studio/);
  assert.match(bare.label, /No virtual camera driver/);

  const obs = describeBridge({ platform: 'win32', help: HELP_MODERN, obsInstalled: true });
  assert.strictEqual(obs.mode, 'obs');
  assert.strictEqual(obs.ready, true);
  assert.match(obs.hint, /Virtual Camera/);
});

test('macOS follows the same OBS route as Windows', () => {
  assert.strictEqual(describeBridge({ platform: 'darwin', help: HELP_MODERN }).mode, 'none');
  assert.strictEqual(describeBridge({ platform: 'darwin', help: HELP_MODERN, obsInstalled: true }).mode, 'obs');
});

// ---------------------------------------------------------------------------
// Encoder limits. This is the half of the story --list-camera-sizes does not
// tell: the sensor offers 4064x3048, the AVC encoder stops at 4096x2176, and
// MediaCodec.configure throws rather than negotiating.
// ---------------------------------------------------------------------------

// Trimmed from a Qualcomm media_codecs_performance/vendor pair, keeping the
// shapes that matter: a decoder that is larger than the encoder, two encoders
// for the same type, and an alignment limit.
const CODECS_XML = `
<MediaCodecs>
  <Decoders>
    <MediaCodec name="c2.qti.avc.decoder" type="video/avc">
      <Limit name="size" min="96x96" max="5120x4096" />
    </MediaCodec>
  </Decoders>
  <Encoders>
    <MediaCodec name="c2.android.avc.encoder" type="video/avc">
      <Limit name="size" min="96x96" max="1920x1088" />
    </MediaCodec>
    <MediaCodec name="c2.qti.avc.encoder" type="video/avc">
      <Limit name="size" min="128x128" max="4096x2176" />
      <Limit name="alignment" value="2x2" />
    </MediaCodec>
    <MediaCodec name="c2.qti.hevc.encoder" type="video/hevc">
      <Limit name="size" min="128x128" max="4096x2176" />
    </MediaCodec>
  </Encoders>
</MediaCodecs>
`;

test('encoder limits come from the Encoders block, never the decoders', () => {
  const limits = parseEncoderLimits(CODECS_XML);
  // 5120x4096 is a decoder limit and must not leak into the answer.
  assert.strictEqual(limits.maxWidth, 4096);
  assert.strictEqual(limits.maxHeight, 2176);
  assert.deepStrictEqual(limits.codecs['video/avc'].alignment, { width: 2, height: 2 });
});

test('the most capable encoder of a type wins', () => {
  // Both a software 1920x1088 and a hardware 4096x2176 AVC encoder are listed.
  assert.strictEqual(parseEncoderLimits(CODECS_XML).codecs['video/avc'].maxWidth, 4096);
});

test('unreadable XML yields no limits rather than a guess', () => {
  const limits = parseEncoderLimits('');
  assert.strictEqual(limits.maxWidth, null);
  assert.strictEqual(limits.maxHeight, null);
});

test('the sizes that broke the stream are the ones reported unencodable', () => {
  const limits = parseEncoderLimits(CODECS_XML);
  // From the user's device: offered by the sensor, refused by the encoder.
  assert.strictEqual(sizeFitsEncoder('4064x3048', limits), false);
  assert.strictEqual(sizeFitsEncoder('2944x2944', limits), false);
  assert.strictEqual(sizeFitsEncoder('3840x2160', limits), true);
  assert.strictEqual(sizeFitsEncoder('1920x1080', limits), true);
});

test('portrait frames are allowed against a landscape limit', () => {
  const limits = parseEncoderLimits(CODECS_XML);
  assert.strictEqual(sizeFitsEncoder('2176x4096', limits), true);
});

test('unknown limits let every size through, so the device decides', () => {
  assert.strictEqual(sizeFitsEncoder('4064x3048', null), true);
  assert.strictEqual(sizeFitsEncoder('4064x3048', { maxWidth: null, maxHeight: null }), true);
});

test('annotateSizes marks rather than removes: the sensor really does offer them', () => {
  const limits = parseEncoderLimits(CODECS_XML);
  const annotated = annotateSizes(
    [{ size: '4064x3048', width: 4064, height: 3048 }, { size: '1920x1080', width: 1920, height: 1080 }],
    limits,
  );
  assert.strictEqual(annotated.length, 2);
  assert.strictEqual(annotated[0].encodable, false);
  assert.strictEqual(annotated[1].encodable, true);
});

test('a MediaCodec stack becomes a sentence naming the size and the limit', () => {
  const STACK = `
    at android.media.MediaCodec.configure(MediaCodec.java:2248)
    at com.genymobile.scrcpy.video.SurfaceEncoder.streamCapture(SurfaceEncoder.java:127)
ERROR: Demuxer error
Killed`;
  const msg = describeCameraFailure(STACK, {
    size: '2944x2944',
    limits: parseEncoderLimits(CODECS_XML),
  });
  assert.match(msg, /2944x2944/);
  assert.match(msg, /4096x2176/);
  assert.doesNotMatch(msg, /MediaCodec|java:/);
});

test('a demuxer error without a stack still points at the resolution', () => {
  const msg = describeCameraFailure('ERROR: Demuxer error\nKilled', {});
  assert.match(msg, /smaller resolution/);
});

test('a busy camera is reported as busy, not as an encoder problem', () => {
  const msg = describeCameraFailure('ERROR: CameraAccessException: camera is in use', {});
  assert.match(msg, /already in use/);
});

test('an unrecognised failure falls back to scrcpy\'s own last words', () => {
  assert.match(describeCameraFailure('ERROR: something odd happened', {}), /something odd/);
  assert.match(describeCameraFailure('', {}), /without saying why/);
});

// ---------------------------------------------------------------------------
// Torch verification. click-tile prints nothing whether it worked or not, so
// the tile list and a state read-back are the only evidence available.
// ---------------------------------------------------------------------------

test('the shade tile list is parsed, and null means "not set"', () => {
  const specs = parseQsTiles('wifi,bt,flashlight,rotation,battery');
  assert.deepStrictEqual(specs.slice(0, 3), ['wifi', 'bt', 'flashlight']);
  assert.strictEqual(hasTorchTile(specs), true);
  assert.deepStrictEqual(parseQsTiles('null'), []);
  assert.deepStrictEqual(parseQsTiles(''), []);
});

test('a shade with no flashlight tile is detected as such', () => {
  assert.strictEqual(hasTorchTile(parseQsTiles('wifi,bt,cell,airplane')), false);
  // Vendor naming varies, so "torch" counts too.
  assert.strictEqual(hasTorchTile(['custom(com.x/.TorchTile)']), true);
});

test('torch state is read back when the camera service reports it', () => {
  assert.strictEqual(parseTorchStatus('Torch mode status: available_on'), 'on');
  assert.strictEqual(parseTorchStatus('  torch status = OFF'), 'off');
  assert.strictEqual(parseTorchStatus('Camera 0 status: present'), null);
  assert.strictEqual(parseTorchStatus(''), null);
});

// Tests for the softcam webcam bridge module. Only the pure builders and the
// frame splitter run here — process spawning needs real binaries + a device.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildScrcpyCameraArgs,
  buildFfmpegArgs,
  frameHeader,
  createFrameSplitter,
  createPipeName,
  resolveWebcamBin,
} = require('../src/webcam');

test('camera scrcpy args are headless, video-only, and record into the pipe', () => {
  const args = buildScrcpyCameraArgs('ABC123', {
    facing: 'back', size: '1280x720', fps: 30, bitrate: 8, recordTarget: '\\\\.\\pipe\\x',
  }, null);
  assert.deepStrictEqual(args, [
    '-s', 'ABC123',
    '--video-source=camera',
    '--no-window',
    '--no-control',
    '--no-audio',
    '--camera-facing=back',
    '--camera-size=1280x720',
    '--camera-fps=30',
    '--video-bit-rate=8M',
    '--record=\\\\.\\pipe\\x',
    '--record-format=mkv',
  ]);
});

test('camera fps uses --camera-fps, never --max-fps', () => {
  const args = buildScrcpyCameraArgs('S', { size: '640x480', fps: 60, recordTarget: 'p' }, null);
  assert.ok(args.includes('--camera-fps=60'));
  assert.ok(!args.some((a) => a.startsWith('--max-fps')), 'display fps flag must not appear');
});

test('camera id wins over facing, like the preview path', () => {
  const args = buildScrcpyCameraArgs('S', { cameraId: '1', facing: 'back', recordTarget: 'p' }, null);
  assert.ok(args.includes('--camera-id=1'));
  assert.ok(!args.some((a) => a.startsWith('--camera-facing')));
});

test('missing serial, record target, or camera support is refused up front', () => {
  assert.throws(() => buildScrcpyCameraArgs('', { recordTarget: 'p' }, null), /No device/);
  assert.throws(() => buildScrcpyCameraArgs('S', {}, null), /record target/);
  assert.throws(
    () => buildScrcpyCameraArgs('S', { recordTarget: 'p' }, '--no-window --record=x'),
    /cannot use the camera/,
  );
});

test('ffmpeg args demux stdin mkv to bgr24 stdout, video stream only', () => {
  assert.deepStrictEqual(buildFfmpegArgs({ width: 1280, height: 720, fps: 30 }), [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-vf', 'scale=1280:720',
    '-vsync', '0',
    '-f', 'rawvideo',
    '-pix_fmt', 'bgr24',
    'pipe:1',
  ]);
  // -fps_mode is ffmpeg >= 5.1 only; must use the portable -vsync spelling so
  // 4.x builds don't exit immediately (crash code 3221225477 on Windows).
  const a = buildFfmpegArgs({ width: 640, height: 480, fps: 30 });
  assert.ok(!a.includes('-fps_mode'), 'must not emit -fps_mode (breaks ffmpeg 4.x)');
  // nobuffer/low_delay destabilised this pipeline (mid-stream fault); keep off.
  assert.ok(!a.includes('nobuffer') && !a.includes('low_delay'),
    'must not emit nobuffer/low_delay decode flags');
  assert.throws(() => buildFfmpegArgs({ width: 0, height: 720, fps: 30 }), /frame size/);
  assert.throws(() => buildFfmpegArgs({ width: 640, height: 480, fps: 0 }), /fps/);
});

test('frame header is u32le width + u32le height', () => {
  assert.deepStrictEqual(frameHeader(1280, 720), Buffer.from([0x00, 0x05, 0x00, 0x00, 0xD0, 0x02, 0x00, 0x00]));
});

test('splitter reassembles frames split across chunks', () => {
  const split = createFrameSplitter(6);
  assert.deepStrictEqual(split.push(Buffer.from([1, 2, 3])), []);
  const out = split.push(Buffer.from([4, 5, 6, 7, 8]));
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual(out[0], Buffer.from([1, 2, 3, 4, 5, 6]));
  assert.strictEqual(split.pendingBytes(), 2);
});

test('splitter emits several frames from one chunk and keeps the tail', () => {
  const split = createFrameSplitter(4);
  const out = split.push(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out[1], Buffer.from([5, 6, 7, 8]));
  assert.strictEqual(split.pendingBytes(), 1);
});

test('splitter copies frames out instead of pinning parent chunks', () => {
  const split = createFrameSplitter(3);
  const parent = Buffer.from([9, 9, 9, 1]);
  const [frame] = split.push(parent);
  parent.fill(0);
  assert.deepStrictEqual(frame, Buffer.from([9, 9, 9]), 'must survive parent reuse');
  assert.deepStrictEqual(split.push(Buffer.alloc(0)), []);
  assert.throws(() => createFrameSplitter(0), /positive/);
});

test('pipe names are unique Windows pipe paths', () => {
  const a = createPipeName();
  const b = createPipeName();
  assert.ok(a.startsWith('\\\\.\\pipe\\apc-webcam-'), a);
  assert.notStrictEqual(a, b);
});

test('binary resolution takes the first hit and null otherwise', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apc-webcam-'));
  const exe = path.join(dir, 'ffmpeg.exe');
  fs.writeFileSync(exe, 'x');
  try {
    assert.strictEqual(resolveWebcamBin('ffmpeg.exe', [null, '/nope', dir]), exe);
    assert.strictEqual(resolveWebcamBin('missing.exe', [dir]), null);
    assert.strictEqual(resolveWebcamBin('ffmpeg.exe', []), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

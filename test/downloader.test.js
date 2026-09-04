// Tests for the scrcpy download/resolution helpers. src/downloader.js pulls in
// `electron`, `extract-zip` and `tar`, none of which are needed by the two pure
// helpers under test, so they are stubbed through the module loader first.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const STUBS = {
  electron: { app: { getPath: () => os.tmpdir() } },
  'extract-zip': async () => {},
  tar: { x: async () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return realLoad(request, parent, isMain);
};

const { pickScrcpyAsset, pickFfmpegAsset, findExecutable } = require('../src/downloader');

Module._load = realLoad;

// A trimmed copy of a real scrcpy release asset list.
const ASSETS = [
  { name: 'scrcpy-linux-aarch64-v3.3.tar.gz' },
  { name: 'scrcpy-linux-x86_64-v3.3.tar.gz' },
  { name: 'scrcpy-macos-aarch64-v3.3.tar.gz' },
  { name: 'scrcpy-macos-x86_64-v3.3.tar.gz' },
  { name: 'scrcpy-server-v3.3' },
  { name: 'scrcpy-win32-v3.3.zip' },
  { name: 'scrcpy-win64-v3.3.zip' },
  { name: 'SHA256SUMS' },
];

function asPlatform(platform, arch, fn) {
  const origP = process.platform;
  const origA = process.arch;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
  try { return fn(); } finally {
    Object.defineProperty(process, 'platform', { value: origP, configurable: true });
    Object.defineProperty(process, 'arch', { value: origA, configurable: true });
  }
}

test('the right release archive is chosen per platform and arch', () => {
  assert.strictEqual(
    asPlatform('win32', 'x64', () => pickScrcpyAsset(ASSETS)).name,
    'scrcpy-win64-v3.3.zip'
  );
  assert.strictEqual(
    asPlatform('darwin', 'arm64', () => pickScrcpyAsset(ASSETS)).name,
    'scrcpy-macos-aarch64-v3.3.tar.gz'
  );
  assert.strictEqual(
    asPlatform('darwin', 'x64', () => pickScrcpyAsset(ASSETS)).name,
    'scrcpy-macos-x86_64-v3.3.tar.gz'
  );
  assert.strictEqual(
    asPlatform('linux', 'arm64', () => pickScrcpyAsset(ASSETS)).name,
    'scrcpy-linux-aarch64-v3.3.tar.gz'
  );
  assert.strictEqual(
    asPlatform('linux', 'x64', () => pickScrcpyAsset(ASSETS)).name,
    'scrcpy-linux-x86_64-v3.3.tar.gz'
  );
});

test('non-archive assets are never selected', () => {
  const only = [{ name: 'scrcpy-server-v3.3' }, { name: 'SHA256SUMS' }];
  assert.strictEqual(asPlatform('win32', 'x64', () => pickScrcpyAsset(only)), null);
});

test('the executable is found inside the nested versioned folder', () => {
  // This is the shape the zip actually extracts to, and the reason the old
  // hardcoded <dir>/scrcpy.exe path never resolved.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrcpy-test-'));
  const nested = path.join(root, 'scrcpy-win64-v3.3');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'scrcpy.exe'), '');
  fs.writeFileSync(path.join(nested, 'adb.exe'), '');

  assert.strictEqual(findExecutable(root, 'scrcpy.exe'), path.join(nested, 'scrcpy.exe'));
  assert.strictEqual(findExecutable(root, 'SCRCPY.EXE'), path.join(nested, 'scrcpy.exe'),
    'the match is case-insensitive');
  assert.strictEqual(findExecutable(root, 'fastboot.exe'), null);

  fs.rmSync(root, { recursive: true, force: true });
});

test('a missing directory returns null instead of throwing', () => {
  assert.strictEqual(findExecutable(path.join(os.tmpdir(), 'definitely-not-here'), 'scrcpy'), null);
});

// A trimmed copy of a real BtbN/FFmpeg-Builds release asset list. Both gpl and
// lgpl, shared and static, across platforms.
const FF_ASSETS = [
  { name: 'ffmpeg-master-latest-win64-gpl.zip' },
  { name: 'ffmpeg-master-latest-win64-gpl-shared.zip' },
  { name: 'ffmpeg-master-latest-win64-lgpl.zip' },
  { name: 'ffmpeg-master-latest-win64-lgpl-shared.zip' },
  { name: 'ffmpeg-master-latest-winarm64-lgpl-shared.zip' },
  { name: 'ffmpeg-master-latest-linux64-gpl.tar.xz' },
  { name: 'ffmpeg-master-latest-linux64-lgpl.tar.xz' },
  { name: 'ffmpeg-master-latest-linux64-lgpl-shared.tar.xz' },
  { name: 'ffmpeg-master-latest-linuxarm64-lgpl-shared.tar.xz' },
];

test('ffmpeg picker takes the LGPL shared build for the platform/arch', () => {
  assert.strictEqual(
    asPlatform('win32', 'x64', () => pickFfmpegAsset(FF_ASSETS)).name,
    'ffmpeg-master-latest-win64-lgpl-shared.zip'
  );
  assert.strictEqual(
    asPlatform('win32', 'arm64', () => pickFfmpegAsset(FF_ASSETS)).name,
    'ffmpeg-master-latest-winarm64-lgpl-shared.zip'
  );
  assert.strictEqual(
    asPlatform('linux', 'x64', () => pickFfmpegAsset(FF_ASSETS)).name,
    'ffmpeg-master-latest-linux64-lgpl-shared.tar.xz'
  );
  assert.strictEqual(
    asPlatform('linux', 'arm64', () => pickFfmpegAsset(FF_ASSETS)).name,
    'ffmpeg-master-latest-linuxarm64-lgpl-shared.tar.xz'
  );
});

test('ffmpeg picker NEVER selects a GPL build (license safety)', () => {
  // The whole point: bundling a -gpl- build would contaminate this MIT app.
  for (const plat of ['win32', 'linux']) {
    const chosen = asPlatform(plat, 'x64', () => pickFfmpegAsset(FF_ASSETS));
    assert.ok(chosen, `expected a build for ${plat}`);
    assert.ok(/lgpl/i.test(chosen.name), `${chosen.name} must be lgpl`);
    assert.ok(!/(^|-)gpl(-|\.)/i.test(chosen.name), `${chosen.name} must not be a plain gpl build`);
  }
  // If ONLY gpl builds exist, pick nothing rather than contaminate.
  const gplOnly = [
    { name: 'ffmpeg-master-latest-win64-gpl.zip' },
    { name: 'ffmpeg-master-latest-win64-gpl-shared.zip' },
  ];
  assert.strictEqual(asPlatform('win32', 'x64', () => pickFfmpegAsset(gplOnly)), null);
});

test('ffmpeg picker falls back to a static LGPL build when no shared one exists', () => {
  const noShared = [
    { name: 'ffmpeg-master-latest-win64-gpl.zip' },
    { name: 'ffmpeg-master-latest-win64-lgpl.zip' },
  ];
  assert.strictEqual(
    asPlatform('win32', 'x64', () => pickFfmpegAsset(noShared)).name,
    'ffmpeg-master-latest-win64-lgpl.zip'
  );
});

test('the recursion depth is bounded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scrcpy-deep-'));
  const deep = path.join(root, 'a', 'b', 'c', 'd', 'e', 'f');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'scrcpy'), '');
  assert.strictEqual(findExecutable(root, 'scrcpy'), null, 'buried past the depth limit');
  fs.rmSync(root, { recursive: true, force: true });
});

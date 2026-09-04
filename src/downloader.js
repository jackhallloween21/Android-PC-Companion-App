const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const extract = require('extract-zip');
const tar = require('tar');

function binDir() {
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Node 18+/Electron ships a global fetch — no extra HTTP dependency needed.
// The abort timer guards against a *stalled* connection: it is reset on every
// chunk, so a slow-but-progressing download (ffmpeg is ~40 MB) is not killed
// mid-flight — only a connection that goes silent for `idleMs` is aborted.
async function download(url, destFile, onProgress, idleMs = 30000) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), idleMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), idleMs); };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'android-pc-companion' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    const fileStream = fs.createWriteStream(destFile);
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bump(); // progress resets the stall timer
      received += value.length;
      fileStream.write(Buffer.from(value));
      if (onProgress && total) onProgress(received / total);
    }
    await new Promise((resolve, reject) => fileStream.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    throw new Error(`Download failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Android platform-tools (adb + fastboot ship together in one official zip)
// ---------------------------------------------------------------------------

function platformToolsAssetName() {
  if (process.platform === 'win32') return 'platform-tools-latest-windows.zip';
  if (process.platform === 'darwin') return 'platform-tools-latest-darwin.zip';
  return 'platform-tools-latest-linux.zip';
}

async function ensurePlatformTools(onProgress) {
  const dir = binDir();
  const ptDir = path.join(dir, 'platform-tools');
  const adbName = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const fastbootName = process.platform === 'win32' ? 'fastboot.exe' : 'fastboot';
  const adbPath = path.join(ptDir, adbName);
  const fastbootPath = path.join(ptDir, fastbootName);

  if (fs.existsSync(adbPath) && fs.existsSync(fastbootPath)) {
    return { adbPath, fastbootPath };
  }

  const url = `https://dl.google.com/android/repository/${platformToolsAssetName()}`;
  const zipPath = path.join(dir, 'platform-tools.zip');
  await download(url, zipPath, onProgress);
  await extract(zipPath, { dir }); // zip already contains a top-level platform-tools/ folder
  fs.unlinkSync(zipPath);

  if (process.platform !== 'win32') {
    fs.chmodSync(adbPath, 0o755);
    fs.chmodSync(fastbootPath, 0o755);
  }
  return { adbPath, fastbootPath };
}

// ---------------------------------------------------------------------------
// scrcpy — fetched from its latest GitHub release
// ---------------------------------------------------------------------------

// Release asset names have drifted between scrcpy majors (scrcpy-win64-v3.3.zip,
// scrcpy-macos-aarch64-v3.3.tar.gz, …), so match loosely on the platform/arch
// keywords rather than pinning an exact filename shape. Falls back to a second,
// even looser pass so a future rename doesn't hard-fail the download.
function pickScrcpyAsset(assets) {
  const names = assets.filter((a) => /\.(zip|tar(\.gz)?)$/i.test(a.name));
  const arm = process.arch === 'arm64';

  const tiers = {
    win32: [/win.*(64|x86_64)/i, /win/i],
    darwin: arm ? [/macos.*(aarch64|arm64)/i, /macos/i] : [/macos.*x86_64/i, /macos/i],
    linux: arm ? [/linux.*(aarch64|arm64)/i, /linux/i] : [/linux.*(x86_64|x64)/i, /linux/i],
  };

  for (const re of tiers[process.platform] || tiers.linux) {
    const hit = names.find((a) => re.test(a.name));
    if (hit) return hit;
  }
  return null;
}

async function latestScrcpyAsset() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch('https://api.github.com/repos/Genymobile/scrcpy/releases/latest', {
      headers: { 'User-Agent': 'android-pc-companion' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Could not check the latest scrcpy release (HTTP ${res.status})`);
    const data = await res.json();
    const asset = pickScrcpyAsset(data.assets || []);
    if (!asset) {
      throw new Error(`No scrcpy release asset matched ${process.platform}/${process.arch}`);
    }
    return asset;
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Could not check the latest scrcpy release: ${err.message}`);
  }
}

// The archives contain a top-level versioned directory (scrcpy-win64-v3.3/…),
// so the executable is never directly at the root of the extraction folder.
// Walk the tree to find it instead of assuming a fixed path — this was the
// reason mirroring silently failed: tools.scrcpy pointed at a file that
// did not exist.
function findExecutable(root, exeName, depth = 4) {
  if (depth < 0) return null;
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }

  const direct = entries.find((e) => e.isFile() && e.name.toLowerCase() === exeName.toLowerCase());
  if (direct) return path.join(root, direct.name);

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findExecutable(path.join(root, entry.name), exeName, depth - 1);
    if (found) return found;
  }
  return null;
}

async function ensureScrcpy(onProgress) {
  const dir = binDir();
  const scDir = path.join(dir, 'scrcpy');
  const exeName = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';

  const cached = findExecutable(scDir, exeName);
  if (cached) return cached;

  const asset = await latestScrcpyAsset();
  const archivePath = path.join(dir, asset.name);
  await download(asset.browser_download_url, archivePath, onProgress);
  fs.mkdirSync(scDir, { recursive: true });

  if (/\.zip$/i.test(asset.name)) {
    await extract(archivePath, { dir: scDir });
  } else {
    await tar.x({ file: archivePath, cwd: scDir });
  }
  fs.unlinkSync(archivePath);

  const exePath = findExecutable(scDir, exeName);
  if (!exePath) {
    throw new Error(`Extracted ${asset.name} but could not find ${exeName} inside it`);
  }

  if (process.platform !== 'win32') {
    // The tarballs don't always preserve the exec bit, and scrcpy shells out to
    // its own bundled adb, so make that runnable too.
    try { fs.chmodSync(exePath, 0o755); } catch { /* best effort */ }
    const bundledAdb = findExecutable(path.dirname(exePath), 'adb');
    if (bundledAdb) { try { fs.chmodSync(bundledAdb, 0o755); } catch { /* best effort */ } }
  }
  return exePath;
}

// ---------------------------------------------------------------------------
// ffmpeg — needed only by the softcam virtual-webcam pipeline. Fetched from
// BtbN/FFmpeg-Builds, which publishes per-commit release archives with an
// API to enumerate them.
//
// LICENSE (do not relax): this app is MIT, so we must fetch an **LGPL** build.
// BtbN ships both -gpl and -lgpl variants; the -gpl one links x264/x265 (GPL)
// and would contaminate the app if we redistributed it. We only ever match
// assets whose name contains "lgpl", and pick the *shared* variant (ffmpeg.exe
// beside its avcodec/avformat DLLs) which is smaller and all we need to decode.
// The archive is extracted whole so those sibling DLLs land next to the exe.
//
// BtbN asset name shape (Windows): ffmpeg-master-latest-win64-lgpl-shared.zip
// (linux/arm variants exist too). Match loosely on platform/arch + lgpl +
// shared so a naming drift doesn't hard-fail.
// ---------------------------------------------------------------------------

function pickFfmpegAsset(assets) {
  const archives = assets.filter((a) => /\.(zip|tar\.xz|tar\.gz)$/i.test(a.name));
  // LGPL only — never a plain -gpl- build (links x264/x265, GPL) which would
  // contaminate this MIT app on redistribution. "lgpl" is BtbN's exact token
  // for the LGPL variant, so matching it is both necessary and sufficient.
  const lgpl = archives.filter((a) => /lgpl/i.test(a.name));
  const arm = process.arch === 'arm64';

  const platformRe = {
    win32: /win64|winarm64/i,
    darwin: /(macos|osx|darwin)/i, // BtbN does not ship macOS; kept for symmetry
    linux: arm ? /linuxarm64|linux.*arm64/i : /linux64|linux.*(x86_64|x64)/i,
  }[process.platform] || /linux64/i;

  const archRe = process.platform === 'win32'
    ? (arm ? /winarm64/i : /win64/i)
    : platformRe;

  // Prefer the shared build (exe + DLLs); accept a static one as a fallback.
  const tiers = [
    (a) => archRe.test(a.name) && /shared/i.test(a.name),
    (a) => archRe.test(a.name),
    (a) => platformRe.test(a.name),
  ];
  for (const match of tiers) {
    const hit = lgpl.find(match);
    if (hit) return hit;
  }
  return null;
}

async function latestFfmpegAsset() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch('https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest', {
      headers: { 'User-Agent': 'android-pc-companion' },
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Could not check the latest ffmpeg release (HTTP ${res.status})`);
    const data = await res.json();
    const asset = pickFfmpegAsset(data.assets || []);
    if (!asset) {
      throw new Error(`No LGPL ffmpeg build matched ${process.platform}/${process.arch}`);
    }
    return asset;
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Could not check the latest ffmpeg release: ${err.message}`);
  }
}

async function ensureFfmpeg(onProgress) {
  const dir = binDir();
  // Kept in its own softcam/ subfolder so it sits beside the native binaries
  // the webcam bridge also resolves from (WEBCAM_BIN_DIR in main.js).
  const ffDir = path.join(dir, 'softcam');
  const exeName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  // A shared ffmpeg needs its sibling DLLs; the extracted build keeps the exe
  // in a bin/ subdir alongside them, so resolve wherever the walk finds it.
  const cached = findExecutable(ffDir, exeName);
  if (cached) return cached;

  const asset = await latestFfmpegAsset();
  const archivePath = path.join(dir, asset.name);
  await download(asset.browser_download_url, archivePath, onProgress, 60000);
  fs.mkdirSync(ffDir, { recursive: true });

  if (/\.zip$/i.test(asset.name)) {
    await extract(archivePath, { dir: ffDir });
  } else {
    await tar.x({ file: archivePath, cwd: ffDir }); // tar handles .tar.xz/.tar.gz
  }
  fs.unlinkSync(archivePath);

  const exePath = findExecutable(ffDir, exeName);
  if (!exePath) {
    throw new Error(`Extracted ${asset.name} but could not find ${exeName} inside it`);
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(exePath, 0o755); } catch { /* best effort */ }
  }
  return exePath;
}

module.exports = {
  ensurePlatformTools,
  ensureScrcpy,
  ensureFfmpeg,
  findExecutable,
  pickScrcpyAsset,
  pickFfmpegAsset,
};

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
async function download(url, destFile, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': 'android-pc-companion' } });
  if (!res.ok) throw new Error(`Download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  const fileStream = fs.createWriteStream(destFile);
  const reader = res.body.getReader();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    fileStream.write(Buffer.from(value));
    if (onProgress && total) onProgress(received / total);
  }
  await new Promise((resolve, reject) => fileStream.end((err) => (err ? reject(err) : resolve())));
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

// scrcpy archives wrap everything in a single top-level folder
// (e.g. scrcpy-win64-v3.1/), so the binary lands one level deeper than the
// extract target. Recursively locate it so we don't assume a flat layout.
function findBinary(dir, exeName) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === exeName) return full;
    }
  }
  return null;
}

async function latestScrcpyAsset() {
  const res = await fetch('https://api.github.com/repos/Genymobile/scrcpy/releases/latest', {
    headers: { 'User-Agent': 'android-pc-companion' },
  });
  if (!res.ok) throw new Error('Could not check the latest scrcpy release');
  const data = await res.json();

  const patterns = {
    win32: /^scrcpy-win64-v?[\d.]+\.zip$/,
    darwin: /^scrcpy-macos-(x86_64|aarch64)-v?[\d.]+\.tar(\.gz)?$/,
    linux: /^scrcpy-linux-(x86_64|x64)-v?[\d.]+\.tar(\.gz)?$/,
  };
  const re = patterns[process.platform] || patterns.linux;
  const asset = data.assets.find((a) => re.test(a.name));
  if (!asset) throw new Error(`No matching scrcpy release asset found for ${process.platform}`);
  return asset;
}

async function ensureScrcpy(onProgress) {
  const dir = binDir();
  const scDir = path.join(dir, 'scrcpy');
  const exeName = process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy';

  // The archive extracts into a nested folder, so resolve the real binary path.
  const existing = findBinary(scDir, exeName);
  if (existing) return existing;

  const asset = await latestScrcpyAsset();
  const archivePath = path.join(dir, asset.name);
  await download(asset.browser_download_url, archivePath, onProgress);
  fs.mkdirSync(scDir, { recursive: true });

  if (asset.name.endsWith('.zip')) {
    await extract(archivePath, { dir: scDir });
  } else {
    await tar.x({ file: archivePath, cwd: scDir });
  }
  fs.unlinkSync(archivePath);

  const exePath = findBinary(scDir, exeName);
  if (!exePath) throw new Error('scrcpy executable not found after extraction');
  if (process.platform !== 'win32') {
    fs.chmodSync(exePath, 0o755);
  }
  return exePath;
}

module.exports = { ensurePlatformTools, ensureScrcpy };

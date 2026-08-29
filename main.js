const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { ensurePlatformTools, ensureScrcpy } = require('./src/downloader');

// Resolved binary paths — start as bare names (PATH lookup) and get replaced
// with absolute paths to downloaded copies in initTools() if not found.
const tools = { adb: 'adb', fastboot: 'fastboot', scrcpy: 'scrcpy' };

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1220,
    height: 780,
    minWidth: 920,
    minHeight: 600,
    frame: false,
    show: false,
    backgroundColor: process.platform === 'linux' ? '#0a0e14' : '#00000000',
    transparent: process.platform !== 'linux', // Linux compositors vary too much to rely on this
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
    // Windows 11 22H2+ only; silently ignored on older Windows/other platforms
    backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

// ---------------------------------------------------------------------------
// First-run tool resolution: use adb/fastboot/scrcpy on PATH if present,
// otherwise download Android platform-tools + the latest scrcpy release into
// this app's userData folder. Progress is streamed to the renderer so it can
// show a setup screen instead of a blank/broken UI on first launch.
// ---------------------------------------------------------------------------

async function checkOnPath(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['version'], (err) => resolve(!err));
  });
}

async function initTools(win) {
  const send = (payload) => win.webContents.send('setup:progress', payload);

  send({ step: 'adb', status: 'checking' });
  if (!(await checkOnPath('adb'))) {
    try {
      send({ step: 'adb', status: 'downloading', progress: 0 });
      const { adbPath, fastbootPath } = await ensurePlatformTools((p) => send({ step: 'adb', status: 'downloading', progress: p }));
      tools.adb = adbPath;
      tools.fastboot = fastbootPath;
    } catch (err) {
      send({ step: 'adb', status: 'error', message: err.message });
      return; // no point continuing setup without adb
    }
  }
  send({ step: 'adb', status: 'done' });

  send({ step: 'scrcpy', status: 'checking' });
  if (!(await checkOnPath('scrcpy'))) {
    try {
      send({ step: 'scrcpy', status: 'downloading', progress: 0 });
      tools.scrcpy = await ensureScrcpy((p) => send({ step: 'scrcpy', status: 'downloading', progress: p }));
    } catch (err) {
      // Mirroring just won't work until the user installs scrcpy themselves —
      // everything else (files, apps, battery, bootloader) is unaffected.
      send({ step: 'scrcpy', status: 'error', message: err.message });
      send({ step: 'all', status: 'ready' });
      return;
    }
  }
  send({ step: 'scrcpy', status: 'done' });
  send({ step: 'all', status: 'ready' });
}

app.whenReady().then(() => {
  const win = createWindow();
  win.webContents.once('did-finish-load', () => initTools(win));
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// adb / fastboot / scrcpy process helpers
//
// MVP shells out to binaries on PATH. For a real build, bundle platform
// binaries under resources/<platform>/ and resolve via process.resourcesPath
// instead of relying on the user's PATH. Swapping this section for a proper
// ADB-protocol client (e.g. adbkit) later is a drop-in replacement for the
// functions below — nothing in the IPC layer needs to change.
// ---------------------------------------------------------------------------

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 32, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

const adb = (args) => run(tools.adb, args);
const fastboot = (args) => run(tools.fastboot, args);

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

ipcMain.handle('devices:list', async () => {
  const out = await adb(['devices', '-l']);
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      const serial = parts[0];
      const state = parts[1];
      const model = (parts.find((p) => p.startsWith('model:')) || '').split(':')[1] || null;
      return { serial, state, model };
    });
});

ipcMain.handle('device:info', async (_e, serial) => {
  const props = [
    'ro.product.model',
    'ro.product.manufacturer',
    'ro.build.version.release',
    'ro.build.version.sdk',
    'ro.product.cpu.abi',
    'ro.boot.serialno',
  ];
  const info = {};
  for (const prop of props) {
    try {
      info[prop] = (await adb(['-s', serial, 'shell', 'getprop', prop])).trim();
    } catch {
      info[prop] = null;
    }
  }
  return info;
});

// ---------------------------------------------------------------------------
// Battery — parse the raw `dumpsys battery` map into human-readable values:
// decode status/health enums, scale temperature (tenths °C) / voltage (mV) /
// charge counter (µAh) into display units, and collapse the four "* POWERED"
// booleans into a single power source.
// ---------------------------------------------------------------------------

const BATTERY_STATUS = { 1: 'Unknown', 2: 'Charging', 3: 'Discharging', 4: 'Not charging', 5: 'Full' };
const BATTERY_HEALTH = {
  1: 'Unknown',
  2: 'Good',
  3: 'Overheat',
  4: 'Dead',
  5: 'Over voltage',
  6: 'Unspecified failure',
  7: 'Cold',
};

function parseBattery(raw) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const statusCode = num(raw.status);
  const healthCode = num(raw.health);
  const level = num(raw.level);
  const scale = num(raw.scale) || 100;
  const tempRaw = num(raw.temperature);
  let voltRaw = num(raw.voltage);
  if (voltRaw == null && raw['voltage_now'] != null) {
    const vn = num(raw['voltage_now']); // sysfs reports µV
    if (vn != null) voltRaw = vn / 1000;
  }
  const counterRaw = num(raw['Charge counter'] ?? raw.charge_counter);
  let currentRaw = num(raw['current now'] ?? raw.current_now); // µA, + = charging on most devices
  if (currentRaw == null && raw['current_now'] != null) currentRaw = num(raw['current_now']);

  const charging = statusCode === 2 || statusCode === 5;
  const percentage = level != null ? Math.round((level / scale) * 100) : null;
  const tempC = tempRaw != null ? tempRaw / 10 : null;
  const tempF = tempC != null ? (tempC * 9) / 5 + 32 : null;
  const voltV = voltRaw != null ? voltRaw / 1000 : null;
  const counterMah = counterRaw != null ? counterRaw / 1000 : null;
  const currentA = currentRaw != null ? currentRaw / 1e6 : null; // signed amps
  const currentMa = currentRaw != null ? currentRaw / 1000 : null; // signed milliamps
  const powerW = currentA != null && voltV != null ? Math.abs(currentA) * voltV : null;

  let powerSource = 'Battery';
  if (raw['AC powered'] === 'true') powerSource = 'AC adapter';
  else if (raw['USB powered'] === 'true') powerSource = 'USB-C';
  else if (raw['Wireless powered'] === 'true') powerSource = 'Wireless';
  else if (raw['Dock powered'] === 'true') powerSource = 'Dock';

  return {
    percentage,
    level,
    scale,
    statusCode,
    statusLabel: BATTERY_STATUS[statusCode] || (statusCode != null ? `Code ${statusCode}` : 'Unknown'),
    healthCode,
    healthLabel: BATTERY_HEALTH[healthCode] || (healthCode != null ? `Code ${healthCode}` : 'Unknown'),
    temperatureC: tempC,
    temperatureF: tempF,
    voltageV: voltV,
    chargeCounterMah: counterMah,
    currentNowMa: currentMa,
    currentNowA: currentA,
    powerWatts: powerW,
    technology: raw.technology || null,
    powerSource,
    charging,
  };
}

ipcMain.handle('device:battery', async (_e, serial) => {
  const out = await adb(['-s', serial, 'shell', 'dumpsys', 'battery']);
  const raw = {};
  out.split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) raw[key] = value;
  });

  // dumpsys battery often omits a live current reading; fall back to sysfs.
  // current_now is in µA (positive while charging on most kernels), voltage_now in µV.
  if (raw['current now'] == null || raw['current now'] === '' || Number(raw['current now']) === 0) {
    try {
      const c = (await adb(['-s', serial, 'shell', 'cat', '/sys/class/power_supply/battery/current_now'])).trim();
      if (Number.isFinite(Number(c))) raw['current now'] = c;
    } catch {
      /* not all devices expose this node */
    }
  }
  if (raw['voltage_now'] == null || raw['voltage_now'] === '') {
    try {
      const v = (await adb(['-s', serial, 'shell', 'cat', '/sys/class/power_supply/battery/voltage_now'])).trim();
      if (Number.isFinite(Number(v))) raw['voltage_now'] = v;
    } catch {
      /* not all devices expose this node */
    }
  }

  return parseBattery(raw);
});

ipcMain.handle('device:rebootBootloader', (_e, serial) => adb(['-s', serial, 'reboot', 'bootloader']));
ipcMain.handle('device:rebootSystem', (_e, serial) => fastboot(['-s', serial, 'reboot']));

// ---------------------------------------------------------------------------
// Wireless pairing (Android 11+ native wireless debugging, and legacy tcpip)
// ---------------------------------------------------------------------------

ipcMain.handle('wireless:pair', (_e, { hostPort, code }) => adb(['pair', hostPort, code]));
ipcMain.handle('wireless:connect', (_e, hostPort) => adb(['connect', hostPort]));
ipcMain.handle('wireless:enableTcpip', (_e, { serial, port }) => adb(['-s', serial, 'tcpip', String(port || 5555)]));

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

ipcMain.handle('files:list', async (_e, { serial, remotePath }) => {
  const out = await adb(['-s', serial, 'shell', 'ls', '-la', remotePath]);
  return out.split('\n').filter(Boolean);
});

ipcMain.handle('files:pull', async (_e, { serial, remotePath }) => {
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: path.basename(remotePath) });
  if (canceled || !filePath) return null;
  await adb(['-s', serial, 'pull', remotePath, filePath]);
  return filePath;
});

ipcMain.handle('files:push', async (_e, { serial, remoteDir }) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
  if (canceled || !filePaths.length) return null;
  await adb(['-s', serial, 'push', filePaths[0], remoteDir]);
  return filePaths[0];
});

ipcMain.handle('files:delete', (_e, { serial, remotePath }) => adb(['-s', serial, 'shell', 'rm', '-rf', remotePath]));

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

ipcMain.handle('apps:list', async (_e, serial) => {
  const out = await adb(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3']);
  return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
});

ipcMain.handle('apps:install', async (_e, serial) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'APK', extensions: ['apk'] }],
  });
  if (canceled || !filePaths.length) return null;
  await adb(['-s', serial, 'install', '-r', filePaths[0]]);
  return filePaths[0];
});

ipcMain.handle('apps:uninstall', (_e, { serial, pkg }) => adb(['-s', serial, 'uninstall', pkg]));
ipcMain.handle('apps:disable', (_e, { serial, pkg }) => adb(['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', pkg]));
ipcMain.handle('apps:enable', (_e, { serial, pkg }) => adb(['-s', serial, 'shell', 'pm', 'enable', pkg]));

// ---------------------------------------------------------------------------
// Mirroring (spawns scrcpy as its own window for the MVP — see README)
// ---------------------------------------------------------------------------

ipcMain.handle('scrcpy:launch', (_e, serial) => {
  const child = spawn(tools.scrcpy, ['-s', serial, '--window-title', `Mirror — ${serial}`], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return true;
});

// ---------------------------------------------------------------------------
// Fastboot / bootloader
// ---------------------------------------------------------------------------

ipcMain.handle('fastboot:devices', async () => {
  const out = await fastboot(['devices']);
  return out.split('\n').filter(Boolean);
});

ipcMain.handle('fastboot:unlock', (_e, serial) => fastboot(['-s', serial, 'flashing', 'unlock']));

// ---------------------------------------------------------------------------
// Audio forwarding (device speaker/media audio -> PC speakers) via scrcpy.
// Flag name for the audio source has changed across scrcpy versions
// (older: --audio-source=output, newer: --audio-source=playback) — if this
// fails on your scrcpy version, run `scrcpy --help` and adjust AUDIO_SOURCE.
// ---------------------------------------------------------------------------

const AUDIO_SOURCE = 'output';
let audioProcess = null;

ipcMain.handle('audio:start', (_e, serial) => {
  if (audioProcess) return true;
  audioProcess = spawn(
    tools.scrcpy,
    ['-s', serial, '--no-video', '--no-control', `--audio-source=${AUDIO_SOURCE}`],
    { stdio: 'ignore' }
  );
  audioProcess.on('exit', () => { audioProcess = null; });
  audioProcess.on('error', () => { audioProcess = null; });
  return true;
});

ipcMain.handle('audio:stop', () => {
  if (audioProcess) {
    audioProcess.kill();
    audioProcess = null;
  }
  return true;
});

ipcMain.handle('audio:status', () => !!audioProcess);

// ---------------------------------------------------------------------------
// Media transport controls — standard Android media keycodes via adb, works
// against whatever app currently holds the active media session.
// ---------------------------------------------------------------------------

const MEDIA_KEYCODES = { playPause: 85, next: 87, previous: 88 };

ipcMain.handle('media:key', (_e, { serial, action }) => {
  const code = MEDIA_KEYCODES[action];
  if (!code) throw new Error(`Unknown media action: ${action}`);
  return adb(['-s', serial, 'shell', 'input', 'keyevent', String(code)]);
});

// ---------------------------------------------------------------------------
// Device hardware-key controls — sent to the device via `adb shell input
// keyevent` so they work whether or not mirroring (scrcpy) is active. Android
// keycodes: POWER=26, VOLUME_UP=24, VOLUME_DOWN=25, HOME=3, BACK=4,
// APP_SWITCH (recents)=187.
// ---------------------------------------------------------------------------

ipcMain.handle('device:key', (_e, { serial, keycode }) => {
  if (!serial || !keycode) throw new Error('device:key requires serial and keycode');
  return adb(['-s', serial, 'shell', 'input', 'keyevent', String(keycode)]);
});

ipcMain.handle('media:nowPlaying', async (_e, serial) => {
  // dumpsys media_session's text format isn't a stable API and varies by
  // Android version/OEM — this is best-effort scraping, not guaranteed.
  const out = await adb(['-s', serial, 'shell', 'dumpsys', 'media_session']);
  const descMatch = out.match(/description=([^,\n]+)/);
  return { description: descMatch ? descMatch[1].trim() : null };
});

// ---------------------------------------------------------------------------
// Backup — pulls shared storage folders and/or installed APKs. This is NOT a
// full system/app-data backup (adb backup is unreliable on modern Android
// and most apps opt out of it); it only reaches what's accessible without
// root: shared storage and APK files.
// ---------------------------------------------------------------------------

const BACKUP_PATHS = {
  dcim: '/sdcard/DCIM',
  pictures: '/sdcard/Pictures',
  downloads: '/sdcard/Download',
  music: '/sdcard/Music',
  documents: '/sdcard/Documents',
};

ipcMain.handle('backup:chooseDestination', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return canceled || !filePaths.length ? null : filePaths[0];
});

ipcMain.handle('backup:run', async (event, { serial, categories, destDir, includeApks }) => {
  const send = (line) => event.sender.send('backup:progress', line);

  for (const cat of categories) {
    const remote = BACKUP_PATHS[cat];
    if (!remote) continue;
    const localDir = path.join(destDir, cat);
    fs.mkdirSync(localDir, { recursive: true });
    send(`Pulling ${remote} …`);
    try {
      await adb(['-s', serial, 'pull', remote, localDir]);
      send(`Done: ${cat}`);
    } catch (err) {
      send(`Skipped ${cat}: ${err.message}`);
    }
  }

  if (includeApks) {
    send('Listing installed apps…');
    const pkgOut = await adb(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3']);
    const pkgs = pkgOut.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
    const apkDir = path.join(destDir, 'apks');
    fs.mkdirSync(apkDir, { recursive: true });
    for (const pkg of pkgs) {
      try {
        const pathOut = await adb(['-s', serial, 'shell', 'pm', 'path', pkg]);
        const remoteApk = pathOut.split('\n')[0].replace('package:', '').trim();
        if (!remoteApk) continue;
        await adb(['-s', serial, 'pull', remoteApk, path.join(apkDir, `${pkg}.apk`)]);
        send(`APK saved: ${pkg}`);
      } catch (err) {
        send(`APK failed (${pkg}): ${err.message}`);
      }
    }
  }

  send('Backup complete.');
  return true;
});

// ---------------------------------------------------------------------------
// Camera preview (phone camera -> its own window, via scrcpy's camera video
// source). This is the video half of a "use phone as webcam" feature. Making
// that video available to other apps as an actual webcam device needs a
// signed virtual-camera driver per OS — out of scope here; see README.
// ---------------------------------------------------------------------------

ipcMain.handle('webcam:launchPreview', (_e, { serial, facing }) => {
  const args = ['-s', serial, '--video-source=camera', '--no-audio', '--window-title', `Camera — ${serial}`];
  if (facing) args.push(`--camera-facing=${facing}`);
  const child = spawn(tools.scrcpy, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
});

// ---------------------------------------------------------------------------
// Custom titlebar window controls (frameless window has no native ones)
// ---------------------------------------------------------------------------

ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

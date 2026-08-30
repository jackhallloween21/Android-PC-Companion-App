const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { ensurePlatformTools, ensureScrcpy } = require('./src/downloader');

const tools = { adb: 'adb', fastboot: 'fastboot', scrcpy: 'scrcpy' };

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    show: false,
    icon: path.join(__dirname, 'smartphone.png'),
    backgroundColor: process.platform === 'linux' ? '#0a0e14' : '#00000000',
    transparent: process.platform !== 'linux',
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: process.platform === 'darwin' ? 'active' : undefined,
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

async function checkOnPath(bin) {
  return new Promise((resolve) => execFile(bin, ['version'], (err) => resolve(!err)));
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
      return;
    }
  }
  send({ step: 'adb', status: 'done' });

  send({ step: 'scrcpy', status: 'checking' });
  if (!(await checkOnPath('scrcpy'))) {
    try {
      send({ step: 'scrcpy', status: 'downloading', progress: 0 });
      tools.scrcpy = await ensureScrcpy((p) => send({ step: 'scrcpy', status: 'downloading', progress: p }));
    } catch (err) {
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
// Process helpers
// ---------------------------------------------------------------------------

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 32, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString().trim() || err.message));
      resolve(stdout);
    });
  });
}

function runBuffer(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 64, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString().trim() || err.message));
      resolve(stdout);
    });
  });
}

const adb = (args) => run(tools.adb, args);
const fastboot = (args) => run(tools.fastboot, args);
const adbBuffer = (args) => runBuffer(tools.adb, args);

function prop(map, key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;
}

// ---------------------------------------------------------------------------
// Devices / dashboard telemetry
// ---------------------------------------------------------------------------

ipcMain.handle('devices:list', async () => {
  const out = await adb(['devices', '-l']);
  return out
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
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
    'ro.build.version.security_patch',
    'ro.product.cpu.abi',
    'ro.board.platform',
    'ro.hardware',
    'ro.boot.serialno',
  ];
  const info = {};
  for (const p of props) {
    try { info[p] = (await adb(['-s', serial, 'shell', 'getprop', p])).trim(); }
    catch { info[p] = null; }
  }
  try { info.bootloaderLocked = (await adb(['-s', serial, 'shell', 'getprop', 'ro.boot.flash.locked'])).trim(); }
  catch { info.bootloaderLocked = null; }
  try { info.ip = (await adb(['-s', serial, 'shell', 'ip', 'route'])).match(/src (\S+)/)?.[1] || null; }
  catch { info.ip = null; }
  return info;
});

ipcMain.handle('device:battery', async (_e, serial) => {
  const out = await adb(['-s', serial, 'shell', 'dumpsys', 'battery']);
  const info = {};
  out.split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) info[key] = value;
  });
  try {
    info['cycle count'] = (await adb(['-s', serial, 'shell', 'cat', '/sys/class/power_supply/battery/cycle_count'])).trim();
  } catch { /* not exposed on this device without root */ }
  return info;
});

ipcMain.handle('device:hardware', async (_e, serial) => {
  const result = {};
  try {
    const wmSize = await adb(['-s', serial, 'shell', 'wm', 'size']);
    result.resolution = wmSize.match(/Physical size:\s*(\S+)/)?.[1] || null;
  } catch { result.resolution = null; }
  try {
    const wmDensity = await adb(['-s', serial, 'shell', 'wm', 'density']);
    result.density = wmDensity.match(/Physical density:\s*(\S+)/)?.[1] || null;
  } catch { result.density = null; }
  try {
    const meminfo = await adb(['-s', serial, 'shell', 'cat', '/proc/meminfo']);
    const totalKb = Number(meminfo.match(/MemTotal:\s*(\d+)/)?.[1] || 0);
    const availKb = Number(meminfo.match(/MemAvailable:\s*(\d+)/)?.[1] || 0);
    result.ramTotalGb = totalKb ? (totalKb / 1048576).toFixed(1) : null;
    result.ramUsedGb = totalKb ? ((totalKb - availKb) / 1048576).toFixed(1) : null;
  } catch { result.ramTotalGb = null; result.ramUsedGb = null; }
  try {
    const df = await adb(['-s', serial, 'shell', 'df', '/sdcard']);
    const line = df.trim().split('\n').pop();
    const cols = line.split(/\s+/); // Filesystem 1K-blocks Used Available Use% Mounted
    result.storageTotalGb = (Number(cols[1]) / 1048576).toFixed(1);
    result.storageUsedGb = (Number(cols[2]) / 1048576).toFixed(1);
  } catch { result.storageTotalGb = null; result.storageUsedGb = null; }
  return result;
});

ipcMain.handle('device:performance', async (_e, serial) => {
  const result = {};
  try {
    const loadavg = await adb(['-s', serial, 'shell', 'cat', '/proc/loadavg']);
    result.loadavg = loadavg.trim().split(/\s+/).slice(0, 3).join(' / ');
  } catch { result.loadavg = null; }
  try {
    const ps = await adb(['-s', serial, 'shell', 'ps', '-A']);
    result.processCount = ps.trim().split('\n').length - 1;
  } catch { result.processCount = null; }
  return result;
});

ipcMain.handle('device:storageBreakdown', async (_e, serial) => {
  const folders = {
    photos: '/sdcard/DCIM',
    pictures: '/sdcard/Pictures',
    videos: '/sdcard/Movies',
    music: '/sdcard/Music',
    downloads: '/sdcard/Download',
    documents: '/sdcard/Documents',
  };
  const result = {};
  for (const [key, remote] of Object.entries(folders)) {
    try {
      const out = await adb(['-s', serial, 'shell', 'du', '-sh', remote]);
      result[key] = out.trim().split(/\s+/)[0] || null;
    } catch {
      result[key] = null;
    }
  }
  return result;
});

ipcMain.handle('device:rebootBootloader', (_e, serial) => adb(['-s', serial, 'reboot', 'bootloader']));
ipcMain.handle('device:rebootSystem', (_e, serial) => fastboot(['-s', serial, 'reboot']));

// ---------------------------------------------------------------------------
// Side-channel device controls — work independently of whether a scrcpy
// mirror window is open, since they go straight over adb.
// ---------------------------------------------------------------------------

ipcMain.handle('control:volumeUp', (_e, serial) => adb(['-s', serial, 'shell', 'input', 'keyevent', '24']));
ipcMain.handle('control:volumeDown', (_e, serial) => adb(['-s', serial, 'shell', 'input', 'keyevent', '25']));
ipcMain.handle('control:powerLongPress', (_e, serial) => adb(['-s', serial, 'shell', 'input', 'keyevent', '--longpress', '26']));

ipcMain.handle('control:rotate', async (_e, { serial, rotation }) => {
  // rotation: 0=0°, 1=90°, 2=180°, 3=270°. Disables auto-rotate first so the
  // requested orientation actually sticks.
  await adb(['-s', serial, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0']);
  return adb(['-s', serial, 'shell', 'settings', 'put', 'system', 'user_rotation', String(rotation)]);
});

ipcMain.handle('control:screenshot', async (_e, serial) => {
  const buf = await adbBuffer(['-s', serial, 'exec-out', 'screencap', '-p']);
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: `screenshot-${Date.now()}.png` });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, buf);
  return filePath;
});

let recordProcess = null;
const REMOTE_RECORD_PATH = '/sdcard/companion_record.mp4';

ipcMain.handle('control:recordStart', (_e, serial) => {
  if (recordProcess) return true;
  recordProcess = spawn(tools.adb, ['-s', serial, 'shell', 'screenrecord', REMOTE_RECORD_PATH]);
  recordProcess.on('exit', () => { recordProcess = null; });
  return true;
});

ipcMain.handle('control:recordStop', async (_e, serial) => {
  if (!recordProcess) return null;
  // screenrecord finalizes the file cleanly on SIGINT; give it a moment
  // before pulling.
  recordProcess.kill('SIGINT');
  recordProcess = null;
  await new Promise((r) => setTimeout(r, 1200));
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: `recording-${Date.now()}.mp4` });
  if (canceled || !filePath) return null;
  await adb(['-s', serial, 'pull', REMOTE_RECORD_PATH, filePath]);
  await adb(['-s', serial, 'shell', 'rm', '-f', REMOTE_RECORD_PATH]);
  return filePath;
});

ipcMain.handle('control:recordStatus', () => !!recordProcess);

// ---------------------------------------------------------------------------
// Raw ADB / fastboot console (Power Tools tab) — runs a command the user
// typed or picked from a quick-command shortcut. Naive whitespace split, so
// arguments needing quoting won't work perfectly; good enough for the common
// adb/fastboot invocations this tool is meant for.
// ---------------------------------------------------------------------------

ipcMain.handle('console:run', async (_e, { serial, command }) => {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const parts = trimmed.split(/\s+/);
  const head = parts[0];
  const rest = parts.slice(1);

  if (head === 'adb') {
    const args = rest[0] === '-s' ? rest : ['-s', serial, ...rest];
    return adb(args);
  }
  if (head === 'fastboot') {
    const args = rest[0] === '-s' ? rest : ['-s', serial, ...rest];
    return fastboot(args);
  }
  throw new Error('Command must start with "adb" or "fastboot"');
});

// ---------------------------------------------------------------------------
// Wireless pairing
// ---------------------------------------------------------------------------

ipcMain.handle('wireless:pair', (_e, { hostPort, code }) => adb(['pair', hostPort, code]));
ipcMain.handle('wireless:connect', (_e, hostPort) => adb(['connect', hostPort]));
ipcMain.handle('wireless:enableTcpip', (_e, { serial, port }) => adb(['-s', serial, 'tcpip', String(port || 5555)]));

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

ipcMain.handle('files:list', async (_e, { serial, remotePath }) => {
  const out = await adb(['-s', serial, 'shell', 'ls', '-la', remotePath]);
  return out.split('\n').filter(Boolean);
});

ipcMain.handle('files:preview', async (_e, { serial, remotePath }) => {
  if (!IMAGE_EXT.test(remotePath)) return null;
  const buf = await adbBuffer(['-s', serial, 'exec-out', 'cat', remotePath]);
  return `data:image/*;base64,${buf.toString('base64')}`;
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

async function listPackageSet(serial, flag) {
  const out = await adb(['-s', serial, 'shell', 'pm', 'list', 'packages', '--user', '0', flag]);
  return new Set(out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean));
}

ipcMain.handle('apps:listDetailed', async (_e, serial) => {
  const [thirdParty, system, disabled] = await Promise.all([
    listPackageSet(serial, '-3'),
    listPackageSet(serial, '-s'),
    listPackageSet(serial, '-d'),
  ]);
  const all = new Set([...thirdParty, ...system]);
  return Array.from(all).map((pkg) => ({
    pkg,
    type: thirdParty.has(pkg) ? 'user' : 'system',
    status: disabled.has(pkg) ? 'disabled' : 'active',
  }));
});

ipcMain.handle('apps:detail', async (_e, { serial, pkg }) => {
  let sizeBytes = null;
  try {
    const pathOut = await adb(['-s', serial, 'shell', 'pm', 'path', pkg]);
    const apkPath = pathOut.split('\n')[0].replace('package:', '').trim();
    if (apkPath) {
      const stat = await adb(['-s', serial, 'shell', 'stat', '-c%s', apkPath]);
      sizeBytes = Number(stat.trim()) || null;
    }
  } catch { /* ignore */ }

  let permissions = [];
  try {
    const dump = await adb(['-s', serial, 'shell', 'dumpsys', 'package', pkg]);
    const block = dump.split('requested permissions:')[1]?.split(/\n\s*\n/)[0] || '';
    permissions = block.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('android.permission') || l.includes('.permission.'));
  } catch { /* ignore */ }

  return { sizeBytes, permissions };
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
ipcMain.handle('apps:clearData', (_e, { serial, pkg }) => adb(['-s', serial, 'shell', 'pm', 'clear', pkg]));

// ---------------------------------------------------------------------------
// Backup
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
// Mirror (configurable stream parameters)
// ---------------------------------------------------------------------------

ipcMain.handle('scrcpy:launch', (_e, { serial, maxSize, bitrate, maxFps, stayAwake, turnScreenOff, showTouches, forwardAudio }) => {
  const args = ['-s', serial, '--window-title', `Mirror — ${serial}`];
  if (maxSize) args.push(`--max-size=${maxSize}`);
  if (bitrate) args.push(`--video-bitrate=${bitrate}M`);
  if (maxFps) args.push(`--max-fps=${maxFps}`);
  if (stayAwake) args.push('--stay-awake');
  if (turnScreenOff) args.push('--turn-screen-off');
  if (showTouches) args.push('--show-touches');
  if (!forwardAudio) args.push('--no-audio');

  const child = spawn(tools.scrcpy, args, { detached: true, stdio: 'ignore' });
  child.unref();
  return true;
});

// ---------------------------------------------------------------------------
// Audio forwarding + media controls
// ---------------------------------------------------------------------------

const AUDIO_SOURCE = 'output'; // some scrcpy versions use "playback" instead — see README
let audioProcess = null;

ipcMain.handle('audio:start', (_e, serial) => {
  if (audioProcess) return true;
  audioProcess = spawn(tools.scrcpy, ['-s', serial, '--no-video', '--no-control', `--audio-source=${AUDIO_SOURCE}`], { stdio: 'ignore' });
  audioProcess.on('exit', () => { audioProcess = null; });
  audioProcess.on('error', () => { audioProcess = null; });
  return true;
});

ipcMain.handle('audio:stop', () => {
  if (audioProcess) { audioProcess.kill(); audioProcess = null; }
  return true;
});

ipcMain.handle('audio:status', () => !!audioProcess);

const MEDIA_KEYCODES = { playPause: 85, next: 87, previous: 88 };

ipcMain.handle('media:key', (_e, { serial, action }) => {
  const code = MEDIA_KEYCODES[action];
  if (!code) throw new Error(`Unknown media action: ${action}`);
  return adb(['-s', serial, 'shell', 'input', 'keyevent', String(code)]);
});

ipcMain.handle('media:nowPlaying', async (_e, serial) => {
  const out = await adb(['-s', serial, 'shell', 'dumpsys', 'media_session']);
  const descMatch = out.match(/description=([^,\n]+)/);
  return { description: descMatch ? descMatch[1].trim() : null };
});

// ---------------------------------------------------------------------------
// Camera preview
// ---------------------------------------------------------------------------

ipcMain.handle('webcam:launchPreview', (_e, { serial, facing }) => {
  const args = ['-s', serial, '--video-source=camera', '--no-audio', '--window-title', `Camera — ${serial}`];
  if (facing) args.push(`--camera-facing=${facing}`);
  const child = spawn(tools.scrcpy, args, { detached: true, stdio: 'ignore' });
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

ipcMain.handle('fastboot:flashPartition', async (_e, serial) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Image', extensions: ['img'] }],
  });
  if (canceled || !filePaths.length) return null;
  return { filePath: filePaths[0] };
});

ipcMain.handle('fastboot:flashPartitionConfirm', (_e, { serial, partition, filePath }) =>
  fastboot(['-s', serial, 'flash', partition, filePath])
);

// ---------------------------------------------------------------------------
// Tool status (Binaries & Drivers panel)
// ---------------------------------------------------------------------------

ipcMain.handle('tools:status', async () => {
  const results = [];
  for (const [name, bin] of [['adb', tools.adb], ['fastboot', tools.fastboot], ['scrcpy', tools.scrcpy]]) {
    let version = null;
    try {
      const out = await run(bin, ['--version']).catch(() => run(bin, ['version']));
      version = out.split('\n')[0].trim();
    } catch { /* leave null */ }
    let size = null;
    try { size = fs.statSync(bin).size; } catch { /* on PATH, no absolute stat available */ }
    results.push({ name, path: bin, version, size });
  }
  return results;
});

// ---------------------------------------------------------------------------
// Custom titlebar window controls
// ---------------------------------------------------------------------------

ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

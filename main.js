const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
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
  return info;
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
// Custom titlebar window controls (frameless window has no native ones)
// ---------------------------------------------------------------------------

ipcMain.on('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('window:maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
});
ipcMain.on('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());

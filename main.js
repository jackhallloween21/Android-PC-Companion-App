const { app, BrowserWindow, ipcMain, dialog, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { ensurePlatformTools, ensureScrcpy } = require('./src/downloader');
const {
  POWER_SCRIPT,
  parsePowerDump,
  parseDumpsysBattery,
  buildPowerReport,
  parseCpuTopology,
  formatClusters,
} = require('./src/power');
const {
  buildMirrorArgs: buildScrcpyMirrorArgs,
  hasAudio,
  hasAudioSource,
  hasCameraSource,
} = require('./src/scrcpy');
const {
  splitHostPort,
  isPaired,
  isConnected,
  listConnectTargets,
  pickConnectTarget,
  connectCandidates,
} = require('./src/wireless');
// QR pairing lives here, not in preload.js: the preload runs sandboxed, where
// `require` is a polyfill that only resolves `electron` and a couple of node
// builtins. Requiring a third-party module (or a relative file) there throws,
// the whole preload is discarded, and the renderer is left with no window.api.
const crypto = require('crypto');
const { newPairingSession, findPairingEndpoint, mdnsUnavailable } = require('./src/pairing');
const { encodeQR } = require('./src/qrencode');
const {
  DEFAULTS: DOCK_DEFAULTS,
  ZOOM_MIN,
  ZOOM_MAX,
  stepZoom,
  parseWmSize,
  parseRotation,
  computeDockLayout,
  barBelow,
  buildWindowArgs,
  supportsPlacement,
} = require('./src/dock');
const {
  MOVE_SCRIPT,
  RECT_SCRIPT,
  mirrorWindowTitle,
  moveWindowArgs,
  findWindowEnv,
  moveWindowEnv,
  canMoveWindows,
  classifyMoveResult,
  parseRectOutput,
} = require('./src/winmove');
const {
  keyEventArgs,
  statusBarArgs,
  describeStatusBarFailure,
} = require('./src/keys');
const {
  TORCH_TILES,
  parseCameraList,
  buildCameraArgs,
  supportsMic,
  supportsV4l2,
  parseEncoderLimits,
  annotateSizes,
  describeCameraFailure,
  torchArgs,
  parseQsTiles,
  hasTorchTile,
  parseTorchStatus,
  describeTorchFailure,
  describeBridge,
} = require('./src/camera');
const {
  parseNowPlaying,
  parseAllSessions,
  describeTrack,
} = require('./src/media');

const tools = { adb: 'adb', fastboot: 'fastboot', scrcpy: 'scrcpy' };

// scrcpy's CLI changed shape across majors, so every launch path has to know
// which generation it is talking to. `help` holds the raw `--help` text, which
// is what we actually feature-detect against — option names have been renamed
// more than once (--bit-rate -> --video-bit-rate in 2.0), and guessing them
// from the version number turns a cosmetic rename into a fatal launch error.
const scrcpyInfo = { version: null, major: 0, minor: 0, help: null };

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
  // A broken preload is otherwise completely silent: the window loads, the
  // renderer has no window.api, and the setup overlay never moves.
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    console.error(`[preload] failed to load ${preloadPath}: ${error && error.message}`);
  });
  // A reload does not destroy the window, so without this an in-flight QR pairing
  // session survives it and keeps driving the *new* renderer's UI — popping modals
  // open on its own. Ctrl+R is a live accelerator via the default menu, so this is
  // reachable by accident.
  win.webContents.on('did-start-navigation', () => qrPairing.cancel());
  win.on('closed', () => qrPairing.cancel());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  return win;
}

// `adb version` works but `scrcpy version` does not — scrcpy only accepts
// `--version`, so probing every binary with the same argument made the scrcpy
// check always fail and pushed us down the download path (and then silently
// left tools.scrcpy pointing at a missing file).
const VERSION_ARGS = { adb: ['version'], fastboot: ['--version'], scrcpy: ['--version'] };

function probeVersion(bin, args) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill('SIGKILL'); } catch {}
        resolve(null);
      }
    }, 8000);
    const child = spawn(bin, args, { windowsHide: true });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(null); }
    });
    child.on('exit', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        const text = `${stdout}\n${stderr}`.trim();
        resolve(text || null);
      }
    });
  });
}

async function checkOnPath(name) {
  return (await probeVersion(name, VERSION_ARGS[name] || ['--version'])) !== null;
}

/**
 * Absolute path of a binary that lives on PATH.
 *
 * Needed because scrcpy shells out to adb itself, and Windows' CreateProcess
 * searches the *application directory and the cwd before PATH*. With cwd set to
 * scrcpy's own folder, a bare "adb" resolved by scrcpy can land on a different
 * (or unrunnable) file than the one we use — which surfaces as
 * "CreateProcessW() error 5 / Could not start adb server". Handing scrcpy an
 * absolute ADB removes the lookup entirely.
 */
function resolveOnPath(name) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve) => {
    execFile(finder, [name], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      // `where` can print several hits; the first is the one that would be used.
      const first = String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
      resolve(first && path.isAbsolute(first) && fs.existsSync(first) ? first : null);
    });
  });
}

async function probeScrcpyVersion() {
  const text = await probeVersion(tools.scrcpy, ['--version']);
  scrcpyInfo.version = text ? text.split('\n')[0].trim() : null;
  const m = text && text.match(/(\d+)\.(\d+)/);
  scrcpyInfo.major = m ? Number(m[1]) : 0;
  scrcpyInfo.minor = m ? Number(m[2]) : 0;
  // `--help` is the authoritative list of what this build accepts.
  scrcpyInfo.help = scrcpyInfo.version ? await probeVersion(tools.scrcpy, ['--help']) : null;
  return scrcpyInfo;
}

// Note: there is no local scrcpySupports() helper any more. Every flag decision
// now lives in the src/* module that builds the argv and takes `help` as an
// argument, which is what makes those builders unit-testable.

async function initTools(win) {
  const send = (payload) => win.webContents.send('setup:progress', payload);

  // Hard timeout: always complete setup within 20 seconds so the UI never hangs.
  let completed = false;
  const completeSetup = () => {
    if (!completed) {
      completed = true;
      send({ step: 'all', status: 'ready' });
    }
  };
  const safetyTimer = setTimeout(() => {
    send({ step: 'adb', status: 'error', message: 'Setup timed out. Click Continue without it to use the app.' });
    completeSetup();
  }, 20000);

  try {
    send({ step: 'adb', status: 'checking' });
    if (!(await checkOnPath('adb'))) {
      try {
        send({ step: 'adb', status: 'downloading', progress: 0 });
        const { adbPath, fastbootPath } = await ensurePlatformTools((p) => send({ step: 'adb', status: 'downloading', progress: p }));
        tools.adb = adbPath;
        tools.fastboot = fastbootPath;
      } catch (err) {
        send({ step: 'adb', status: 'error', message: err.message });
        completeSetup();
        return;
      }
    } else {
      tools.adb = 'adb';
      tools.fastboot = 'fastboot';
      Promise.all([resolveOnPath('adb'), resolveOnPath('fastboot')]).then(([adbPath, fastbootPath]) => {
        if (adbPath) tools.adb = adbPath;
        if (fastbootPath) tools.fastboot = fastbootPath;
      }).catch(() => {});
    }
    send({ step: 'adb', status: 'done' });

    send({ step: 'scrcpy', status: 'checking' });
    if (!(await checkOnPath('scrcpy'))) {
      try {
        send({ step: 'scrcpy', status: 'downloading', progress: 0 });
        tools.scrcpy = await ensureScrcpy((p) => send({ step: 'scrcpy', status: 'downloading', progress: p }));
      } catch (err) {
        send({ step: 'scrcpy', status: 'error', message: err.message });
        completeSetup();
        return;
      }
    } else {
      tools.scrcpy = 'scrcpy';
      resolveOnPath('scrcpy').then((scrcpyPath) => {
        if (scrcpyPath) tools.scrcpy = scrcpyPath;
      }).catch(() => {});
    }

    await probeScrcpyVersion();
    if (!scrcpyInfo.version) {
      send({ step: 'scrcpy', status: 'error', message: `scrcpy at ${tools.scrcpy} did not respond to --version` });
      completeSetup();
      return;
    }
    send({ step: 'scrcpy', status: 'done', message: scrcpyInfo.version });
    completeSetup();
  } finally {
    clearTimeout(safetyTimer);
    completeSetup();
  }
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'videoCapture' || permission === 'audioCapture') {
      callback(true);
      return;
    }
    callback(false);
  });

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

/**
 * Turns a failed execFile into a message that is safe to show.
 *
 * stderr is what we want when there is any, and execFile's own message is what is
 * left otherwise — but that message is "Command failed: <bin> <args…>", which puts
 * the entire argv in front of the user and into the logs. On `adb pair` that argv
 * ends with the pairing code, so the line gets dropped.
 */
function failureMessage(err, stderr) {
  const text = stderr && stderr.toString().trim();
  // `killed` is set for a `timeout` kill and *not* for a maxBuffer overrun or an
  // ENOENT, so it is a clean timeout signal — and it has to be checked before
  // stderr, because adb's routine "* daemon not running; starting now" chatter goes
  // to stderr and would otherwise be reported as the reason for the failure.
  if (err && err.killed) return `the command timed out${text ? `: ${text}` : ''}`;
  if (text) return text;
  const rest = String((err && err.message) || '')
    .split('\n')
    .filter((line) => !/^Command failed:/.test(line.trim()))
    .join('\n')
    .trim();
  if (rest) return rest;
  const code = err && (err.code ?? err.signal);
  return `command failed${code == null ? '' : ` (${code})`}`;
}

function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 32, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(failureMessage(err, stderr)));
      resolve(stdout);
    });
  });
}

function runBuffer(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 1024 * 1024 * 64, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) return reject(new Error(failureMessage(err, stderr)));
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

// ---------------------------------------------------------------------------
// Power telemetry & SoC details
//
// Parsing/normalisation lives in src/power.js so it can be unit-tested against
// captured device output without booting Electron.
// ---------------------------------------------------------------------------

ipcMain.handle('device:power', async (_e, serial) => {
  // dumpsys is the reliable floor; the sysfs sweep is the detail layer.
  let dump = {};
  try {
    dump = parseDumpsysBattery(await adb(['-s', serial, 'shell', 'dumpsys', 'battery']));
  } catch { /* keep going — sysfs may still work */ }

  let supplies = {};
  let zones = [];
  try {
    ({ supplies, zones } = parsePowerDump(await adb(['-s', serial, 'shell', POWER_SCRIPT])));
  } catch { /* power-supply nodes unreadable on this device */ }

  if (!Object.keys(dump).length && !Object.keys(supplies).length) {
    throw new Error('Neither "dumpsys battery" nor /sys/class/power_supply could be read.');
  }

  return buildPowerReport({ dump, supplies, zones });
});

ipcMain.handle('device:soc', async (_e, serial) => {
  const getprop = async (key) => {
    try { return (await adb(['-s', serial, 'shell', 'getprop', key])).trim() || null; }
    catch { return null; }
  };

  const [socModel, socMfr, platform, hardware, abi, ddrType, ufsProp] = await Promise.all([
    getprop('ro.soc.model'),
    getprop('ro.soc.manufacturer'),
    getprop('ro.board.platform'),
    getprop('ro.hardware'),
    getprop('ro.product.cpu.abi'),
    getprop('ro.boot.ddr_type'),
    getprop('ro.boot.hardware.ufs'),
  ]);

  let topology = { coreCount: null, clusters: [], maxGhz: null };
  try {
    const [cpuinfo, freqs] = await Promise.all([
      adb(['-s', serial, 'shell', 'cat', '/proc/cpuinfo']),
      adb(['-s', serial, 'shell', 'grep . /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq 2>/dev/null']),
    ]);
    topology = parseCpuTopology(cpuinfo, freqs);
  } catch { /* cpufreq is restricted on some builds */ }

  // Flash chip identity, when the block device exposes it.
  let storageModel = null;
  try {
    const out = await adb(['-s', serial, 'shell', 'cat /sys/block/sd*/device/model 2>/dev/null']);
    storageModel = out.split('\n').map((l) => l.trim()).find(Boolean) || null;
  } catch { /* not exposed */ }

  return {
    socName: [socMfr, socModel].filter(Boolean).join(' ') || platform || hardware || null,
    socModel,
    socManufacturer: socMfr,
    platform,
    hardware,
    abi,
    coreCount: topology.coreCount,
    clusters: topology.clusters,
    clusterSummary: formatClusters(topology.clusters),
    maxGhz: topology.maxGhz,
    ddrType: ddrType || null,
    storageModel: storageModel || ufsProp || null,
  };
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

// Navigation keys (Back / Home / Recents) and the notification shade. The
// keycodes and the `cmd statusbar` verbs live in src/keys.js so they can be
// tested — a wrong keycode is silent, since `input keyevent` dispatches any
// valid code without complaint.
ipcMain.handle('control:navKey', (_e, { serial, action }) => adb(keyEventArgs(serial, action)));

ipcMain.handle('control:statusBar', async (_e, { serial, panel }) => {
  try {
    return await adb(statusBarArgs(serial, panel));
  } catch (err) {
    throw new Error(describeStatusBarFailure(err.message));
  }
});

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
//
// Pairing and connecting are two separate steps on two different ports — see
// src/wireless.js for the details and for the output classification, since both
// commands report failure on stdout and frequently still exit 0.
// ---------------------------------------------------------------------------

/** Runs an adb subcommand that signals failure through its output, not its exit code. */
async function adbText(args, opts = {}) {
  try {
    return (await run(tools.adb, args, opts)).trim();
  } catch (err) {
    return String(err.message || '').trim();
  }
}

async function adbConnect(target, opts = {}) {
  const out = await adbText(['connect', target], opts);
  if (isConnected(out)) return out || `connected to ${target}`;
  throw new Error(out || `Could not connect to ${target}.`);
}

ipcMain.handle('wireless:pair', async (_e, { hostPort, code, connectPort }) => {
  const paired = await adbText(['pair', hostPort, code]);
  if (!isPaired(paired)) {
    throw new Error(paired
      || 'adb pair returned no output. Check the host:port and that the pairing dialog is still open.');
  }

  const { host } = splitHostPort(hostPort);
  // mDNS discovery is unreliable on some Windows setups, so it is best-effort
  // and only used when the user did not supply the connect port.
  const targets = connectCandidates(host, connectPort, await adbText(['mdns', 'services']));

  const attempts = [];
  for (const target of targets) {
    try {
      return { paired, connected: true, target, message: await adbConnect(target) };
    } catch (err) {
      attempts.push(`${target}: ${err.message}`);
    }
  }

  // Paired but not reachable — reported as a partial success so the user knows
  // not to redo the pairing (the code is single-use), only to supply the port.
  return {
    paired,
    connected: false,
    target: null,
    message: attempts.length
      ? `Paired, but could not connect.\n${attempts.join('\n')}`
      : 'Paired. Now enter the port from the "IP address & port" line on the phone\'s '
        + 'Wireless debugging screen — not the one from the pairing dialog.',
  };
});

ipcMain.handle('wireless:connect', async (_e, hostPort) => {
  const { host, port } = splitHostPort(hostPort);
  return adbConnect(`${host}:${port || 5555}`);
});

ipcMain.handle('wireless:discover', async () => pickConnectTarget(await adbText(['mdns', 'services'])));

ipcMain.handle('wireless:enableTcpip', async (_e, { serial, port }) => {
  const out = await adbText(['-s', serial, 'tcpip', String(port || 5555)]);
  if (/error|failed/i.test(out)) throw new Error(out);
  return out;
});

// ---------------------------------------------------------------------------
// QR pairing session
//
// Only one can be live at a time. The phone does the scanning, so after the code
// is on screen there is nothing to do but watch mDNS for the pairing endpoint
// the phone starts advertising the moment it accepts the code.
// ---------------------------------------------------------------------------

const QR_POLL_MS = 1000;
const QR_TIMEOUT_MS = 120000; // the phone's pairing screen gives up around 2 min
const QR_RENAME_GRACE_MS = 15000; // how long to insist on our own service name
const QR_CONNECT_ATTEMPTS = 10;
const QR_ADB_TIMEOUT_MS = 15000; // a wedged adb server can block indefinitely

const qrPairing = {
  token: 0,
  timer: null,
  wake: null,

  cancel() {
    this.token++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Wake any pending backoff so its loop can notice the token changed and
    // return, instead of leaving a suspended async frame around forever.
    if (this.wake) {
      const wake = this.wake;
      this.wake = null;
      wake();
    }
  },

  /**
   * A cancellable sleep: cancel() clears the timer *and* resolves the promise.
   *
   * `timer`/`wake` are single shared slots, so a superseded session's loop can
   * clobber a live session's handle here. That is only harmless because every
   * resume point re-checks `alive()` — do not remove those checks.
   */
  sleep(ms) {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.timer = setTimeout(() => {
        this.wake = null;
        this.timer = null;
        resolve();
      }, ms);
    });
  },

  start(session, win) {
    this.cancel();
    const token = ++this.token;
    const alive = () => token === this.token && win && !win.isDestroyed();
    const send = (payload) => {
      if (alive()) win.webContents.send('wireless:qrPairProgress', payload);
    };
    // Every adb call here is bounded: cancel() can stop the loop but not a child
    // process it is already waiting on, and a hung `adb pair` would otherwise
    // outlive the modal that started it.
    const adbQr = (args) => adbText(args, { timeout: QR_ADB_TIMEOUT_MS });

    const started = Date.now();
    let strangerTarget = null; // the unrecognised endpoint currently being waited out
    let strangerSeenAt = null; // …and when it first showed up
    let renameTried = false; // an unrecognised endpoint has already been tried once

    const poll = async () => {
      if (!alive()) return;
      // Bounding the whole session here, rather than only in the "nothing found"
      // branch, is what keeps every reschedule path finite — including the ones that
      // re-poll after a pairing attempt against the wrong endpoint.
      if (Date.now() - started > QR_TIMEOUT_MS) {
        send({ phase: 'error', message: 'Timed out waiting for the phone to scan the code.' });
        return;
      }

      const mdns = await adbQr(['mdns', 'services']);
      if (!alive()) return;

      // An unrecognised pairing row is the ambiguous case: it may be our phone
      // under a ROM-specific service name, or a *different* phone with its own
      // pairing dialog open — including the "Pair with code" dialog this app's own
      // instructions tell people to open. Give our own name a chance to appear
      // first, timed from when that endpoint was first seen rather than from the
      // start of the session: the user needs half a minute just to walk through the
      // phone's menus, so a clock started at session time would always have expired
      // by the time anything was advertised at all.
      const candidate = findPairingEndpoint(mdns, session.name, { allowRename: !renameTried });
      let endpoint = null;
      if (candidate && candidate.name === session.name) {
        endpoint = candidate;
      } else if (candidate) {
        // Keyed to the endpoint, so a *different* stranger appearing later starts its
        // own grace period instead of inheriting an expired one.
        if (strangerTarget !== candidate.target) {
          strangerTarget = candidate.target;
          strangerSeenAt = Date.now();
        }
        if (Date.now() - strangerSeenAt > QR_RENAME_GRACE_MS) endpoint = candidate;
      }

      if (!endpoint) {
        reschedule();
        return;
      }

      const ours = endpoint.name === session.name;
      send({ phase: 'pairing', message: `Phone found at ${endpoint.target}. Pairing…` });
      const paired = await adbQr(['pair', endpoint.target, session.password]);
      if (!alive()) return;
      if (!isPaired(paired)) {
        const timedOut = /timed out/i.test(paired);
        if (!ours) {
          // That endpoint was not advertised under our service name and it did not
          // accept our password, so it was someone else's pairing dialog. Not a
          // reason to end a session the user's phone may still be about to join —
          // just stop trying that endpoint. A timeout is not evidence either way, so
          // it does not disqualify a genuinely renamed ROM.
          if (!timedOut) renameTried = true;
          send({
            phase: 'waiting',
            message: timedOut
              ? 'adb did not answer in time. Still waiting for the scan…'
              : 'Found a different phone pairing, not this code. Still waiting for the scan…',
          });
          reschedule();
          return;
        }
        send({ phase: 'error', message: paired || 'adb pair failed without saying why.' });
        return;
      }

      // Pairing is only the key exchange; the device shows up in `adb devices`
      // only after a connect on the separate _adb-tls-connect port. That record
      // usually lags the pairing one by a second or two, hence the retries.
      send({ phase: 'connecting', message: 'Paired. Connecting…' });
      const elsewhere = new Set();
      let refused = null;
      for (let attempt = 0; attempt < QR_CONNECT_ATTEMPTS; attempt++) {
        if (!alive()) return;
        // One snapshot per attempt, filtered to the host we just paired with.
        // Accepting any advertised connect port would let the app connect to a
        // second phone on the network and report it as a success, while the phone
        // the user actually paired never shows up.
        const advertised = listConnectTargets(await adbQr(['mdns', 'services']));
        if (!alive()) return;
        const match = advertised.find((entry) => entry.host === endpoint.host);
        for (const entry of advertised) {
          if (entry.host !== endpoint.host) elsewhere.add(entry.target);
        }
        if (match) {
          refused = match.target;
          try {
            const message = await adbConnect(match.target, { timeout: QR_ADB_TIMEOUT_MS });
            if (!alive()) return;
            send({ phase: 'connected', message, target: match.target });
            return;
          } catch (err) {
            send({ phase: 'connecting', message: `${match.target}: ${err.message} — retrying…` });
          }
        }
        await this.sleep(QR_POLL_MS);
      }

      send({
        phase: 'paired',
        host: endpoint.host,
        // Two different failures, and telling them apart matters: a port that was
        // never advertised is something the user can supply by hand, while a port
        // that refused the connection is not.
        message: refused
          ? `Paired with ${endpoint.host}, but ${refused} kept refusing the connection. `
            + 'Check the "IP address & port" line on the phone\'s Wireless debugging screen.'
          : `Paired with ${endpoint.host}, but no connect port was advertised for it. Enter the port `
            + 'from the "IP address & port" line on the phone\'s Wireless debugging screen — not the '
            + 'one from the pairing dialog.'
            // Worth saying out loud: refusing these is deliberate (they belong to
            // some other device), but going silent looks like nothing was found.
            + (elsewhere.size ? ` Ignored ports at other addresses: ${[...elsewhere].join(', ')}.` : ''),
      });
    };

    // Each poll re-arms itself, which detaches it from runSession()'s catch — so the
    // catch has to be re-attached every time or a rejection becomes an unhandled one
    // in the main process and the modal just waits forever.
    const reschedule = () => {
      this.timer = setTimeout(() => {
        poll().catch((err) => send({ phase: 'error', message: err.message }));
      }, QR_POLL_MS);
    };

    const runSession = async () => {
      // `adb mdns check` is the only subcommand that reports on the backend;
      // `mdns services` stays quiet when the daemon is dead, so checking it would
      // just turn a broken adb into a two-minute timeout blaming the phone.
      const check = await adbQr(['mdns', 'check']);
      if (!alive()) return;
      if (mdnsUnavailable(check)) {
        // Deliberately vague about the cause: a dead daemon, an unreachable adb
        // server and a timed-out check all land here, and all have the same remedy.
        send({
          phase: 'error',
          message: "adb's mDNS service is not responding, so the phone cannot be found after it "
            + 'scans. Use "Pair with code" instead, or restart the adb server.',
        });
        return;
      }
      await poll();
    };

    runSession().catch((err) => send({ phase: 'error', message: err.message }));
  },
};

// QR pairing runs here, in main: the renderer only receives a matrix of dark/
// light modules to draw. The phone is the scanner — see src/pairing.js for the
// handshake — so the app needs an encoder, not jsqr's decoder.
ipcMain.handle('wireless:qrPairStart', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // Without a window there is nowhere to send progress to, and the session would
  // sit there invisibly until it timed out. Fail the call instead.
  if (!win) throw new Error('Lost the window that asked for pairing.');
  qrPairing.cancel();

  const session = newPairingSession(crypto.randomBytes);
  const qr = encodeQR(session.payload, { ecc: 'M' });
  qrPairing.start(session, win);

  // The password stays in main. It is inside the rendered matrix by necessity,
  // but there is no reason to hand the renderer a copy in plain text as well.
  return { size: qr.size, modules: qr.modules, name: session.name };
});

ipcMain.handle('wireless:qrPairCancel', async () => {
  qrPairing.cancel();
  return true;
});

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
// scrcpy process launcher
//
// Previously every scrcpy invocation was `spawn(..., { detached: true,
// stdio: 'ignore' })` with no error handling, so any failure — missing binary,
// unauthorized device, version-mismatched adb server, encoder error — produced
// exactly nothing in the UI. Now stderr is captured and an early exit is
// reported back to the renderer.
// ---------------------------------------------------------------------------

function scrcpyEnv() {
  const env = { ...process.env };
  // scrcpy shells out to adb. If it picks a different adb than we use, the two
  // servers fight (one kills the other) and the mirror dies on connect. Point
  // scrcpy at the exact same binary.
  if (path.isAbsolute(tools.adb)) env.ADB = tools.adb;

  // For the portable/extracted builds, scrcpy-server sits next to the exe.
  if (path.isAbsolute(tools.scrcpy)) {
    const serverPath = path.join(path.dirname(tools.scrcpy), 'scrcpy-server');
    if (fs.existsSync(serverPath)) env.SCRCPY_SERVER_PATH = serverPath;
  }
  return env;
}

async function assertDeviceReady(serial) {
  if (!serial) throw new Error('No device selected.');
  let state;
  try {
    state = (await adb(['-s', serial, 'get-state'])).trim();
  } catch (err) {
    throw new Error(`Device ${serial} is not reachable over adb: ${err.message}`);
  }
  if (state !== 'device') {
    throw new Error(
      state === 'unauthorized'
        ? `Device ${serial} has not authorized this computer — accept the "Allow USB debugging" prompt on the phone.`
        : `Device ${serial} is in "${state}" state, not ready for mirroring.`
    );
  }
}

/**
 * Spawns scrcpy and waits briefly to see whether it survives startup.
 * Resolves once the window is up (or the process is still alive); rejects with
 * scrcpy's own stderr if it bails out immediately.
 *
 * `onSpawn`/`onExit` let the caller follow the process past that grace window —
 * the docked control bar uses them to tie its own lifetime to the video window.
 */
function spawnScrcpy(args, { graceMs = 2500, onSpawn, onExit } = {}) {
  return new Promise((resolve, reject) => {
    if (!scrcpyInfo.version) {
      reject(new Error('scrcpy is not available. Re-run tool setup from "Binaries & Drivers".'));
      return;
    }

    let child;
    try {
      child = spawn(tools.scrcpy, args, {
        cwd: path.isAbsolute(tools.scrcpy) ? path.dirname(tools.scrcpy) : undefined,
        env: scrcpyEnv(),
        windowsHide: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`Could not start scrcpy (${tools.scrcpy}): ${err.message}`));
      return;
    }

    if (onSpawn) onSpawn(child);

    let log = '';
    const collect = (buf) => { log = (log + buf.toString()).slice(-4000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    child.on('error', (err) => finish(reject, new Error(`Could not start scrcpy: ${err.message}`)));
    child.on('exit', (code) => {
      if (onExit) onExit(code);
      if (code === 0) return finish(resolve, { ok: true, log: log.trim() });
      const detail = log.trim().split('\n').filter(Boolean).slice(-6).join('\n');
      // Options are feature-detected from `scrcpy --help`, so this should not
      // happen; if it does, the probed help text was stale or truncated.
      const hint = /unknown option|unrecognized option/i.test(log)
        ? '\n\nThis build rejected one of the options we passed. Re-run detection from '
          + '"Binaries & Drivers" to re-read its option list.'
        : '';
      finish(reject, new Error((detail || `scrcpy exited with code ${code}`) + hint));
    });

    // Still running after the grace window means the mirror window opened.
    const timer = setTimeout(() => finish(resolve, { ok: true, pid: child.pid }), graceMs);
  });
}

// ---------------------------------------------------------------------------
// Mirror (configurable stream parameters), optionally with a docked control bar
//
// scrcpy draws into its own SDL window, so the controls cannot literally live
// inside the app's Mirror view without native window reparenting. Docking gets
// the same result: scrcpy is launched borderless at a rectangle we choose, and a
// frameless always-on-top strip is placed directly underneath it. Borderless
// also means the video window has no title bar to drag, so the pair cannot drift
// apart mid-session.
// ---------------------------------------------------------------------------

function buildMirrorArgs(serial, opts) {
  return buildScrcpyMirrorArgs(serial, opts, scrcpyInfo);
}

/** Live docked session: the scrcpy process, its control bar, and the layout. */
let mirrorSession = null;

/** Device resolution and rotation, for sizing the video window to the stream. */
async function readDisplayGeometry(serial) {
  const size = parseWmSize(await adb(['-s', serial, 'shell', 'wm', 'size']).catch(() => ''));
  const rotation = parseRotation(
    await adb(['-s', serial, 'shell', 'dumpsys', 'window', 'displays']).catch(() => '')
  );
  return { size, rotation };
}

function controlBarWindow(bar, serial) {
  const win = new BrowserWindow({
    x: bar.x,
    y: bar.y,
    width: bar.width,
    height: bar.height,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    // Matches the main window's treatment: the strip's own rounded border is
    // drawn in CSS, so the frame behind it has to be transparent or the corners
    // show up as dark squares.
    transparent: process.platform !== 'linux',
    backgroundColor: process.platform === 'linux' ? '#0d1220' : '#00000000',
    icon: path.join(__dirname, 'smartphone.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Above scrcpy's own window, which SDL may itself raise on focus.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.once('ready-to-show', () => win.showInactive());
  win.loadFile(path.join(__dirname, 'renderer', 'controlbar.html'), {
    query: { serial },
  });
  return win;
}

function closeMirrorSession({ killScrcpy = false } = {}) {
  const session = mirrorSession;
  mirrorSession = null;
  if (!session) return;
  if (session.bar && !session.bar.isDestroyed()) session.bar.destroy();
  if (killScrcpy && session.child && session.child.exitCode === null) {
    try { session.child.kill(); } catch { /* already gone */ }
  }
}

function clampZoom(zoom) {
  const n = Number(zoom);
  if (!Number.isFinite(n)) return ZOOM_MAX;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

/**
 * Runs one of the PowerShell window helpers against the live session.
 * Resolves to the raw output text, or null when it could not be run at all.
 */
function runWindowScript(script, env) {
  if (!canMoveWindows()) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        'powershell.exe',
        moveWindowArgs(script),
        { timeout: 8000, windowsHide: true, env: { ...process.env, ...env } },
        // A non-zero exit is expected for NOTFOUND, so the text is what matters.
        (_err, stdout, stderr) => resolve(`${stdout || ''}\n${stderr || ''}`)
      );
    } catch {
      resolve(null);
      return;
    }
    child.on('error', () => resolve(null));
  });
}

/** How the live scrcpy window is identified: by pid first, title as a backstop. */
function windowTarget(session) {
  return {
    pid: session.child && session.child.exitCode === null ? session.child.pid : undefined,
    title: mirrorWindowTitle(session.serial),
  };
}

/**
 * Moves scrcpy's window in place via user32!MoveWindow, driven by the
 * PowerShell that ships with Windows so this costs no npm dependency.
 * Resolves to 'ok' | 'notfound' | 'failed' | 'unsupported'.
 *
 * The alternative — relaunching scrcpy at the new size — restarts the stream,
 * which is a visible black flash on every click of a zoom button.
 */
async function moveScrcpyWindow(session, rect) {
  if (!canMoveWindows()) return 'unsupported';
  const text = await runWindowScript(MOVE_SCRIPT, moveWindowEnv(windowTarget(session), rect));
  return text === null ? 'failed' : classifyMoveResult(text);
}

/** Where the video window actually is now — it may have been dragged since. */
async function readScrcpyWindowRect(session) {
  if (!canMoveWindows()) return null;
  const text = await runWindowScript(RECT_SCRIPT, findWindowEnv(windowTarget(session)));
  return text === null ? null : parseRectOutput(text);
}

/** Puts the strip at `bar` and re-asserts that it sits above the video. */
function placeBar(session, bar) {
  if (!session.bar || session.bar.isDestroyed()) return false;
  session.bar.setBounds({
    x: Math.round(bar.x), y: Math.round(bar.y),
    width: Math.round(bar.width), height: Math.round(bar.height),
  });
  session.bar.setAlwaysOnTop(true, 'screen-saver');
  return true;
}

/** Re-lays out a live docked session at `zoom`, moving both windows. */
async function applyMirrorZoom(zoom) {
  const session = mirrorSession;
  if (!session) throw new Error('Nothing is being mirrored.');

  const next = clampZoom(zoom);
  const workArea = screen.getPrimaryDisplay().workArea;
  const layout = computeDockLayout({ ...session.geometry, zoom: next, workArea });

  const moved = await moveScrcpyWindow(session, layout.video);

  // The window could not be found or moved: fall back to relaunching at the new
  // geometry, which always works but restarts the stream.
  if (moved !== 'ok') {
    const args = [
      ...session.args,
      ...buildWindowArgs(layout.video, scrcpyInfo.help, { borderless: session.borderless }),
    ];
    if (session.child && session.child.exitCode === null) {
      // Its exit handler would otherwise tear the bar down mid-resize.
      session.child.removeAllListeners('exit');
      try { session.child.kill(); } catch { /* already gone */ }
    }
    await spawnScrcpy(args, {
      graceMs: 1800,
      onSpawn: (child) => { session.child = child; },
      onExit: () => { if (mirrorSession === session) closeMirrorSession(); },
    });
  }

  session.zoom = next;
  session.layout = layout;
  placeBar(session, layout.bar);

  return { zoom: next, relaunched: moved !== 'ok', reason: moved, layout };
}

ipcMain.handle('scrcpy:launch', async (_e, { serial, dock, ...opts }) => {
  await assertDeviceReady(serial);
  closeMirrorSession({ killScrcpy: true });

  const args = buildMirrorArgs(serial, opts);

  // A build that cannot be told where to open its window can still be mirrored;
  // it just cannot be docked, and saying so beats silently ignoring the setting.
  if (!dock || !supportsPlacement(scrcpyInfo.help)) {
    const result = await spawnScrcpy(args);
    return {
      ...result,
      docked: false,
      note: dock && !supportsPlacement(scrcpyInfo.help)
        ? `This scrcpy build (${scrcpyInfo.version || 'unknown'}) has no --window-x/--window-y, `
          + 'so the controls stay in the app window.'
        : undefined,
    };
  }

  const { size, rotation } = await readDisplayGeometry(serial);
  // Kept so a later resize can recompute the layout without re-probing the
  // device or reopening the window.
  const geometry = {
    deviceWidth: size && size.width,
    deviceHeight: size && size.height,
    rotation,
    maxSize: opts.maxSize,
  };
  const zoom = clampZoom(opts.zoom);
  const layout = computeDockLayout({
    ...geometry,
    zoom,
    workArea: screen.getPrimaryDisplay().workArea,
  });

  const dockArgs = [
    ...args,
    ...buildWindowArgs(layout.video, scrcpyInfo.help, { borderless: !!opts.borderless }),
  ];
  const session = {
    child: null, bar: null, layout, serial, geometry, zoom, opts, args,
    borderless: !!opts.borderless,
  };

  const result = await spawnScrcpy(dockArgs, {
    onSpawn: (child) => { session.child = child; },
    // scrcpy closing (its own X, or Ctrl+C, or the device going away) must take
    // the bar with it, otherwise a dead strip is left floating on top of
    // everything with no video under it.
    onExit: () => { if (mirrorSession === session) closeMirrorSession(); },
  });

  // The grace timer resolving means the window is up; if scrcpy exited cleanly
  // in that window there is nothing to dock to.
  if (!session.child || session.child.exitCode !== null) return { ...result, docked: false };

  session.bar = controlBarWindow(layout.bar, serial);
  session.bar.on('closed', () => {
    // Closing the strip is the user's "stop mirroring" gesture.
    if (mirrorSession === session) closeMirrorSession({ killScrcpy: true });
  });
  mirrorSession = session;

  return { ...result, docked: true, layout, zoom };
});

ipcMain.handle('scrcpy:dockState', () => ({
  docked: !!mirrorSession,
  serial: mirrorSession ? mirrorSession.serial : null,
  zoom: mirrorSession ? mirrorSession.zoom : null,
  canResizeInPlace: canMoveWindows(),
  zoomRange: { min: ZOOM_MIN, max: ZOOM_MAX },
}));

ipcMain.handle('scrcpy:setZoom', (_e, zoom) => applyMirrorZoom(zoom));

ipcMain.handle('scrcpy:nudgeZoom', (_e, direction) => {
  if (!mirrorSession) throw new Error('Nothing is being mirrored.');
  return applyMirrorZoom(stepZoom(mirrorSession.zoom, direction));
});

/**
 * Snap the strip back under the video.
 *
 * The video window keeps its title bar now, so it can be dragged and resized
 * freely — which means the launch-time layout is only a guess about where it is.
 * Ask Windows where it actually is and lay the strip out under that; only if the
 * window cannot be read do we fall back to the remembered rectangle.
 */
ipcMain.handle('scrcpy:redock', async () => {
  const session = mirrorSession;
  if (!session || !session.bar || session.bar.isDestroyed()) return false;
  const live = await readScrcpyWindowRect(session);
  if (!live) return placeBar(session, session.layout.bar);
  session.layout = { ...session.layout, video: live };
  return placeBar(session, barBelow(live, screen.getPrimaryDisplay().workArea));
});

ipcMain.handle('scrcpy:stop', () => {
  const wasOpen = !!mirrorSession;
  closeMirrorSession({ killScrcpy: true });
  return wasOpen;
});

app.on('before-quit', () => closeMirrorSession({ killScrcpy: true }));

ipcMain.handle('scrcpy:info', async () => {
  if (!scrcpyInfo.version) await probeScrcpyVersion();
  return {
    ...scrcpyInfo,
    path: tools.scrcpy,
    adbPath: tools.adb,
    canDock: supportsPlacement(scrcpyInfo.help),
    barHeight: DOCK_DEFAULTS.barHeight,
  };
});

// ---------------------------------------------------------------------------
// Audio forwarding + media controls
// ---------------------------------------------------------------------------

// scrcpy 2.0 added audio; the selectable --audio-source landed in 2.2, where
// "output" means the device's own playback stream.
let audioProcess = null;

ipcMain.handle('audio:start', async (_e, serial) => {
  if (audioProcess) return true;
  await assertDeviceReady(serial);
  const hasAudioSupport = hasAudio(scrcpyInfo);
  if (!hasAudioSupport) {
    throw new Error(`Audio forwarding needs scrcpy 2.0 or newer (found ${scrcpyInfo.version || 'none'}).`);
  }

  const args = ['-s', serial, '--no-video', '--no-control'];
  if (hasAudioSource(scrcpyInfo)) args.push('--audio-source=output');

  const child = spawn(tools.scrcpy, args, {
    cwd: path.isAbsolute(tools.scrcpy) ? path.dirname(tools.scrcpy) : undefined,
    env: scrcpyEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let log = '';
  const collect = (b) => { log = (log + b.toString()).slice(-2000); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  audioProcess = child;

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(true); } }, 2500);
    child.on('exit', (code) => {
      audioProcess = null;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) return resolve(true);
      reject(new Error(log.trim().split('\n').filter(Boolean).slice(-4).join('\n') || `scrcpy audio exited with code ${code}`));
    });
    child.on('error', (err) => {
      audioProcess = null;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start audio forwarding: ${err.message}`));
    });
  });
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
  const track = parseNowPlaying(out);
  return {
    track,
    // When the snapshot was taken. The renderer advances `position` from this so
    // the elapsed time moves between polls instead of jumping every few seconds.
    readAt: Date.now(),
    // Kept so older callers (and the one-line status) keep working.
    description: describeTrack(track),
    sessions: parseAllSessions(out).length,
  };
});

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

// One camera stream at a time: two scrcpy processes reading the same sensor is
// refused by Android anyway, and a second window would be indistinguishable.
let cameraSession = null;

/** Runs scrcpy for its text output, with the same cwd/env a stream would get. */
function runScrcpyText(args) {
  return new Promise((resolve) => {
    execFile(tools.scrcpy, args, {
      cwd: path.isAbsolute(tools.scrcpy) ? path.dirname(tools.scrcpy) : undefined,
      env: scrcpyEnv(),
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      // Listing exits non-zero on some builds after printing the list, so the
      // text is what matters, not the exit code.
      resolve(`${stdout || ''}\n${stderr || ''}`);
    });
  });
}

function assertCameraSupport() {
  if (!hasCameraSource(scrcpyInfo)) {
    throw new Error(`Camera streaming needs scrcpy 2.2 or newer (found ${scrcpyInfo.version || 'none'}).`);
  }
}

/**
 * The sensors this phone will actually hand over, with the sizes each one
 * offers. Asked of scrcpy rather than inferred: a resolution the camera2 API
 * does not list makes scrcpy exit, so the picker must be built from this.
 */
ipcMain.handle('camera:list', async (_e, serial) => {
  await assertDeviceReady(serial);
  assertCameraSupport();
  const out = await runScrcpyText(['-s', serial, '--list-camera-sizes']);
  const cameras = parseCameraList(out);
  if (!cameras.length) {
    throw new Error(cleanScrcpyLog(out) || 'scrcpy listed no cameras for this device.');
  }

  // The sensor list is only half the answer: the frames still have to go through
  // the phone's hardware H.264 encoder, which has its own maximum and rejects
  // anything larger with a MediaCodec stack trace. Read that maximum off the
  // device so oversized modes can be marked instead of failing at launch.
  const limits = await readEncoderLimits(serial);
  for (const cam of cameras) {
    cam.sizes = annotateSizes(cam.sizes, limits);
    cam.highSpeedSizes = annotateSizes(cam.highSpeedSizes, limits);
  }

  return {
    cameras,
    limits,
    mic: supportsMic(scrcpyInfo.help),
    v4l2: supportsV4l2(scrcpyInfo.help),
  };
});

/**
 * Encoder limits, straight from the device's own codec declarations.
 *
 * Both directories are read because vendors split the files, and a failure is
 * not fatal: with no limits every size stays enabled and the device gets to
 * refuse for itself, which is the pre-existing behaviour rather than a regression.
 */
async function readEncoderLimits(serial) {
  try {
    const out = await adb([
      '-s', serial, 'shell',
      'cat /vendor/etc/media_codecs*.xml /system/etc/media_codecs*.xml 2>/dev/null',
    ]);
    return parseEncoderLimits(out);
  } catch {
    return { codecs: {}, maxWidth: null, maxHeight: null };
  }
}

/** Last few meaningful lines of scrcpy output, for an error the user can act on. */
function cleanScrcpyLog(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^INFO:/i.test(l))
    .slice(-4)
    .join('\n');
}

ipcMain.handle('camera:start', async (_e, opts = {}) => {
  const { serial } = opts;
  await assertDeviceReady(serial);
  assertCameraSupport();
  if (cameraSession && cameraSession.child && cameraSession.child.exitCode === null) {
    throw new Error('A camera stream is already running. Stop it before starting another.');
  }

  const args = buildCameraArgs(serial, {
    cameraId: opts.cameraId,
    facing: opts.facing,
    size: opts.size,
    fps: opts.fps,
    highSpeed: opts.highSpeed,
    mic: opts.mic,
    v4l2Device: opts.v4l2Device,
  }, scrcpyInfo.help);

  const session = { serial, child: null, opts };
  try {
    await spawnScrcpy(args, {
      graceMs: 2500,
      onSpawn: (child) => { session.child = child; cameraSession = session; },
      onExit: () => { if (cameraSession === session) cameraSession = null; },
    });
  } catch (err) {
    // scrcpy reports an encoder rejection as a Java stack trace, which is not
    // something a user can act on. Name the size and the device's own limit
    // instead; the limit is re-read here because a start can follow a detect
    // from an earlier session.
    const limits = await readEncoderLimits(serial);
    throw new Error(describeCameraFailure(err.message, { size: opts.size, limits }));
  }
  return { running: true, size: opts.size || null, mic: !!opts.mic };
});

ipcMain.handle('camera:stop', () => {
  if (cameraSession && cameraSession.child) {
    try { cameraSession.child.kill(); } catch { /* already gone */ }
  }
  cameraSession = null;
  return true;
});

ipcMain.handle('camera:status', () => ({
  running: !!(cameraSession && cameraSession.child && cameraSession.child.exitCode === null),
  serial: cameraSession ? cameraSession.serial : null,
  size: cameraSession ? (cameraSession.opts.size || null) : null,
  mic: cameraSession ? !!cameraSession.opts.mic : false,
}));

/**
 * Flashlight.
 *
 * There is no torch command in adb — camera2's torch API is not exposed to the
 * shell — so this clicks the quick-settings tile, which is a toggle rather than a
 * settable state. The catch is that `cmd statusbar click-tile` prints nothing
 * whether it toggled a real tile or silently did nothing, so a bare success from
 * adb means only "the command ran". Two checks make the reply honest:
 * the shade's tile list, and a torch-state read-back from the camera service.
 * When the state cannot be read the reply says so rather than claiming a change.
 */
ipcMain.handle('camera:torch', async (_e, serial) => {
  if (!serial) throw new Error('No device selected.');

  const tiles = parseQsTiles(await adbQuiet([
    '-s', serial, 'shell', 'settings', 'get', 'secure', 'sysui_qs_tiles',
  ]));
  if (tiles.length && !hasTorchTile(tiles)) {
    throw new Error('This phone\'s quick-settings shade has no flashlight tile, and adb has no other way to reach the torch. Add the Flashlight tile in the notification shade\'s edit screen, then try again.');
  }

  const before = parseTorchStatus(await adbQuiet(['-s', serial, 'shell', 'dumpsys', 'media.camera']));

  let last = '';
  let clicked = null;
  for (const tile of TORCH_TILES) {
    try {
      await adb(torchArgs(serial, tile));
      clicked = tile;
      break;
    } catch (err) {
      last = err.message;
      if (/Android 11/.test(describeTorchFailure(last))) break; // no point trying tile 2
    }
  }
  if (!clicked) throw new Error(describeTorchFailure(last));

  const after = parseTorchStatus(await adbQuiet(['-s', serial, 'shell', 'dumpsys', 'media.camera']));
  if (after && before !== after) return { toggled: true, state: after, tile: clicked };
  if (after && before === after) {
    throw new Error(`The flashlight tile was clicked but the torch is still ${after}. This ROM is ignoring adb tile clicks — toggle it from the phone's shade instead.`);
  }
  // No read-back on this build: report the click, not a state we cannot see.
  return { toggled: true, state: null, tile: clicked };
});

/** adb whose failure is data, not an exception — for probes that may not exist. */
async function adbQuiet(args) {
  try {
    return await adb(args);
  } catch (err) {
    return err && err.message ? err.message : '';
  }
}

/**
 * Whether other PC apps can select this phone as a camera, and what it would
 * take. Reported honestly per platform rather than as a status light that is
 * always green — on Windows nothing we can do from here creates a real camera
 * device; OBS's signed driver is the only widely available route.
 */
ipcMain.handle('camera:bridge', async () => {
  if (!scrcpyInfo.version) await probeScrcpyVersion();
  return describeBridge({
    platform: process.platform,
    help: scrcpyInfo.help,
    v4l2Devices: listV4l2Devices(),
    obsInstalled: hasObsVirtualCamera(),
  });
});

/** Loopback sinks scrcpy could write into (Linux only). */
function listV4l2Devices() {
  if (process.platform !== 'linux') return [];
  try {
    return fs.readdirSync('/dev')
      .filter((n) => /^video\d+$/.test(n))
      .map((n) => `/dev/${n}`)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Whether OBS is installed. Only its presence is checked, not that the virtual
 * camera has been started — that is the user's move, and claiming otherwise
 * would be the same dishonesty as a permanently green status light.
 */
function hasObsVirtualCamera() {
  const candidates = process.platform === 'win32'
    ? [
      path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'obs-studio'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'obs-studio'),
    ]
    : process.platform === 'darwin'
      ? ['/Applications/OBS.app']
      : ['/usr/bin/obs', '/usr/local/bin/obs'];
  return candidates.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
}

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
  for (const name of ['adb', 'fastboot', 'scrcpy']) {
    const bin = tools[name];
    const text = await probeVersion(bin, VERSION_ARGS[name]);
    const version = text ? text.split('\n')[0].trim() : null;
    let size = null;
    try { size = fs.statSync(bin).size; } catch { /* resolved via PATH, no absolute path to stat */ }
    results.push({ name, path: bin, version, size });
  }
  return results;
});

// Lets the renderer re-run detection after the user installs a tool manually
// or a download previously failed, without restarting the app.
ipcMain.handle('tools:reinit', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (win) await initTools(win);
  return { ...scrcpyInfo, scrcpyPath: tools.scrcpy, adbPath: tools.adb };
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

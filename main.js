const { app, BrowserWindow, ipcMain, dialog, screen, session, desktopCapturer, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { ensurePlatformTools, ensureScrcpy } = require('./src/downloader');
const { sanitizeSettings } = require('./src/theme');
const {
  POWER_SCRIPT,
  parsePowerDump,
  parseDumpsysBattery,
  buildPowerReport,
  parseCpuTopology,
  formatClusters,
  HEALTH_SOURCES,
  parseHealthDump,
  healthDumpUseful,
  explainMissing,
} = require('./src/power');
const {
  PERF_SCRIPT,
  parsePerfDump,
  parseDumpsysMeminfo,
  buildPerfReport,
} = require('./src/perf');
const {
  STORAGE_SCRIPT,
  parseStorageDump,
  buildStorageReport,
} = require('./src/storage');
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
const {
  listAdvertised,
  isWirelessSerial,
  rememberDevice,
  forgetKnownDevice,
  pruneKnown,
  planReconnect,
} = require('./src/autoconnect');
const {
  APPS_SCRIPT,
  parseAppsDump,
  buildAppList,
  parsePackageDump,
  buildAppDetail,
  parseDuBytes,
  isInstallable,
  parseInstallResult,
  parseIconDump,
} = require('./src/apps');
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
  cameraWindowTitle,
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
  buildScrcpyCameraArgs,
  startWebcamBridge,
} = require('./src/webcam');
const {
  parseNowPlaying,
  parseAllSessions,
  describeTrack,
  collectArtUris,
  parseAudioVolume,
} = require('./src/media');
const {
  RECORD_STOP_TIMEOUT_MS,
  RECORD_FLUSH_SETTLE_MS,
  RECORD_MIN_BYTES,
  RECORD_TAIL_SCAN_BYTES,
  RECORD_HEAD_SCAN_BYTES,
  assessRecording,
  repairMkvTimestamps,
  repairMp4Edits,
} = require('./src/recording');

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
  // When the OS light/dark preference flips, tell the renderer so an "Auto"
  // theme follows it live. Bound to this window and torn down with it.
  const onNativeThemeUpdated = () => {
    if (!win.isDestroyed()) win.webContents.send('theme:osUpdated', nativeTheme.shouldUseDarkColors);
  };
  nativeTheme.on('updated', onNativeThemeUpdated);
  win.on('closed', () => nativeTheme.removeListener('updated', onNativeThemeUpdated));
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

  // Auto-detect connected devices after tools are ready
  try {
    const out = await run(tools.adb, ['devices', '-l']);
    const devices = out.trim().split('\n').slice(1)
      .map(l => l.trim().split(/\s+/))
      .filter(p => p[0] && p[1] === 'device')
      .map(p => {
        const serial = p[0];
        const ip = serial.includes(':') ? serial.split(':')[0] : null;
        const hasUsb = p.some(x => x.startsWith('usb:'));
        return {
          serial,
          model: (p.find(x => x.startsWith('model:')) || '').split(':')[1] || serial,
          transport: ip ? 'Wi-Fi' : 'USB',
          ip,
        };
      });
    if (devices.length === 1) {
      win.webContents.send('device:auto-selected', devices[0]);
    } else if (devices.length > 1) {
      win.webContents.send('device:choose', devices);
    }
  } catch {}

  // Silently reconnect previously paired wireless devices
  try {
    await runAutoconnect({ includeNew: false });
  } catch {}
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
      const hasUsb = parts.some((p) => p.startsWith('usb:'));
      const isMdns = serial.startsWith('adb-') || serial.includes('._tcp') || serial.includes('_adb');
      const isIpPort = /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(serial);
      const isWireless = isIpPort || isMdns || isWirelessSerial(serial);
      const cachedIp = infoCache.get(serial)?.ip || null;
      const ip = isIpPort ? serial.split(':')[0] : cachedIp;
      const transport = isWireless ? 'Wi-Fi' : (hasUsb ? 'USB' : 'USB');
      const product = (parts.find((p) => p.startsWith('product:')) || '').split(':')[1] || null;
      return { serial, state, model, transport, ip, product };
    });
});

// Static device properties, cached per serial. None of these can change while
// the device stays connected, and reading them was costing nine sequential adb
// round trips on every dashboard refresh. The cache is dropped when a device
// disconnects (see forgetDevice).
const infoCache = new Map();
const meminfoCache = new Map();

function getMeminfoRaw(serial) {
  const cached = meminfoCache.get(serial);
  const now = Date.now();
  if (!cached || (!cached.inFlight && now - cached.timestamp > 30000)) {
    const entry = cached || { data: null, timestamp: 0, inFlight: false };
    entry.inFlight = true;
    meminfoCache.set(serial, entry);
    adb(['-s', serial, 'shell', 'dumpsys', 'meminfo'])
      .then((raw) => {
        entry.data = raw;
        entry.timestamp = Date.now();
        entry.inFlight = false;
      })
      .catch(() => {
        entry.inFlight = false;
      });
  }
  return cached ? cached.data : null;
}

ipcMain.handle('device:info', async (_e, serial) => {
  const cached = infoCache.get(serial);
  if (cached) return cached;

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
    'ro.boot.flash.locked',
  ];
  // One `getprop` with no argument dumps every property at once, which is a
  // single round trip instead of ten. The per-prop reads stay as a fallback for
  // builds where the bulk dump is truncated or unreadable.
  const info = {};
  let bulk = null;
  try { bulk = await adb(['-s', serial, 'shell', 'getprop']); } catch { /* fall back below */ }
  if (bulk) {
    const map = new Map();
    // Lines look like: [ro.product.model]: [Pixel 8]
    for (const line of bulk.split('\n')) {
      const m = line.match(/^\[([^\]]+)\]:\s*\[(.*)\]\s*$/);
      if (m) map.set(m[1], m[2]);
    }
    for (const p of props) info[p] = map.has(p) ? (map.get(p) || null) : null;
  }
  const missing = props.filter((p) => !info[p]);
  if (missing.length === props.length) {
    await Promise.all(missing.map(async (p) => {
      try { info[p] = (await adb(['-s', serial, 'shell', 'getprop', p])).trim() || null; }
      catch { info[p] = null; }
    }));
  }
  info.bootloaderLocked = info['ro.boot.flash.locked'] ?? null;
  // `getenforce` is not a property, so it needs its own read. Batched with the
  // route lookup because both are single-line shell commands.
  const [route, selinux] = await Promise.all([
    adb(['-s', serial, 'shell', 'ip', 'route']).catch(() => null),
    adb(['-s', serial, 'shell', 'getenforce']).catch(() => null),
  ]);
  info.ip = route ? (route.match(/src (\S+)/)?.[1] || null) : null;
  info.selinux = selinux ? selinux.trim() || null : null;

  infoCache.set(serial, info);
  return info;
});

/** Drops every per-serial cache, so a reconnected device is re-read. */
function forgetDevice(serial) {
  infoCache.delete(serial);
  socCache.delete(serial);
  healthSourceCache.delete(serial);
  meminfoCache.delete(serial);
}

// ---------------------------------------------------------------------------
// Autoconnect
//
// `adb pair` writes a key the phone keeps until it is revoked, so a device only
// ever needs pairing once. What it needs every time is `adb connect`, at an
// address Android changes whenever wireless debugging is toggled. Remembering
// the device lets that second step happen without the user opening the pairing
// screen again — see src/autoconnect.js for how the address is re-found.
// ---------------------------------------------------------------------------

const KNOWN_FILE = () => path.join(app.getPath('userData'), 'known-devices.json');

function loadKnown() {
  try {
    const parsed = JSON.parse(fs.readFileSync(KNOWN_FILE(), 'utf8'));
    return pruneKnown(Array.isArray(parsed) ? parsed : parsed.devices);
  } catch {
    // Absent on first run, and a corrupt file must not stop the app booting.
    return [];
  }
}

function saveKnown(list) {
  try { fs.writeFileSync(KNOWN_FILE(), JSON.stringify(pruneKnown(list), null, 2)); }
  catch { /* a read-only profile is not worth failing a connection over */ }
}

// --------------------------------------------------------------- theme settings
// Persisted exactly like known-devices: a small JSON file in userData.
// sanitizeSettings (shared with the renderer through src/theme) guarantees a
// valid { mode, accent } even when the file is absent, hand-edited, or corrupt,
// so a bad settings.json can never stop the app painting.
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')));
  } catch {
    return sanitizeSettings(null);
  }
}

// Merges a partial patch ({ mode } or { accent }) over what is on disk, so the
// renderer can save one field without clobbering the other, then re-sanitizes.
function saveSettings(patch) {
  const merged = { ...loadSettings(), ...(patch && typeof patch === 'object' ? patch : {}) };
  const next = sanitizeSettings(merged);
  try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(next, null, 2)); }
  catch { /* read-only profile: the sanitized value still applies for this run */ }
  return next;
}

// osPrefersDark rides along so the renderer can resolve "auto" without a second
// round-trip; nativeTheme is only valid after app is ready, which holds here
// because these fire in response to the loaded renderer.
ipcMain.handle('settings:get', async () => ({
  ...loadSettings(),
  osPrefersDark: nativeTheme.shouldUseDarkColors,
}));

ipcMain.handle('settings:set', async (_e, patch) => ({
  ...saveSettings(patch),
  osPrefersDark: nativeTheme.shouldUseDarkColors,
}));

/** Serials adb currently has attached. */
async function attachedSerials() {
  try {
    const out = await adb(['devices']);
    return out.split('\n').slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => p[0] && p[1] === 'device')
      .map((p) => p[0]);
  } catch { return []; }
}

/**
 * Records a device we just connected to wirelessly. The mDNS instance name is
 * consulted for the device serial, because that — not the address — is what
 * identifies the phone again after its IP or port changes.
 */
async function rememberConnected(target, label = null) {
  let deviceSerial = null;
  try {
    const { host } = splitHostPort(target);
    const ad = listAdvertised(await adbText(['mdns', 'services'])).find((a) => a.host === host);
    deviceSerial = ad ? ad.deviceSerial : null;
  } catch { /* mDNS is often blocked; the host:port alone is still worth keeping */ }
  saveKnown(rememberDevice(loadKnown(), { target, deviceSerial, label }));
}

let autoconnectRun = null;

/**
 * Tries the remembered devices once. Attempts run sequentially rather than in
 * parallel: `adb connect` to a host that is not listening blocks for the TCP
 * timeout, and firing several at once makes the adb server queue them anyway.
 */
async function runAutoconnect({ includeNew = false } = {}) {
  const known = loadKnown();
  if (!known.length && !includeNew) return { attempted: [], connected: [] };

  const mdns = await adbText(['mdns', 'services']).catch(() => '');
  const plan = planReconnect({ known, mdns, connected: await attachedSerials(), includeNew });

  const attempted = [];
  const connected = [];
  for (const step of plan) {
    // Once a device is attached there is no point trying its other addresses.
    if (step.deviceSerial && connected.some((c) => c.deviceSerial === step.deviceSerial)) continue;
    let out = null;
    try { out = await adbText(['connect', step.target]); } catch { /* treated as a failure below */ }
    attempted.push({ ...step, ok: isConnected(out) });
    if (!isConnected(out)) continue;
    connected.push(step);
    await rememberConnected(step.target);
  }
  return { attempted, connected };
}

ipcMain.handle('devices:known', async () => loadKnown());

ipcMain.handle('devices:autoconnect', async (_e, opts) => {
  // A single shared promise, so a renderer reload during startup cannot start a
  // second sweep and race the first one's writes to known-devices.json.
  if (!autoconnectRun) {
    autoconnectRun = runAutoconnect(opts || {}).finally(() => { autoconnectRun = null; });
  }
  return autoconnectRun;
});

ipcMain.handle('devices:forget', async (_e, hostOrSerial) => {
  forgetDevice(hostOrSerial);
  saveKnown(forgetKnownDevice(loadKnown(), hostOrSerial));
  return loadKnown();
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

// Which HEALTH_SOURCES entry answered for a given serial, so the probe only
// happens once per device rather than on every 1 s poll. `null` means "probed
// and none of them answered"; `undefined` means "not probed yet".
const healthSourceCache = new Map();

/**
 * Reads the battery values the kernel is withholding, via the health HAL.
 *
 * On many devices (MediaTek especially) SELinux denies the `shell` user
 * /sys/class/power_supply even though the DAC permission bits look fine — which
 * is why the `[ -r ]` guards in POWER_SCRIPT pass and then `cat` returns
 * nothing. The health HAL itself runs privileged and prints the same counters,
 * and the shell user *is* allowed to ask it for a debug dump. That is the only
 * non-root route to current draw, charge_full and cycle count on such a device.
 */
async function readHealthHal(serial) {
  const cached = healthSourceCache.get(serial);

  // Re-run only the source that worked last time.
  if (cached) {
    try {
      const parsed = parseHealthDump(await adb(['-s', serial, 'shell', cached.command]));
      if (healthDumpUseful(parsed)) return { health: parsed, healthSource: cached.label };
    } catch { /* fall through and re-probe: the HAL may have been restarted */ }
    healthSourceCache.delete(serial);
  } else if (cached === null) {
    return { health: {}, healthSource: null };
  }

  for (const source of HEALTH_SOURCES) {
    let parsed;
    try {
      parsed = parseHealthDump(await adb(['-s', serial, 'shell', source.command]));
    } catch { continue; }
    if (!healthDumpUseful(parsed)) continue;
    healthSourceCache.set(serial, source);
    return { health: parsed, healthSource: source.label };
  }

  // Remember the failure too, so a device with no health HAL does not pay for
  // four dumpsys round trips on every single poll.
  healthSourceCache.set(serial, null);
  return { health: {}, healthSource: null };
}

// The fields the UI shows a dash for, each with a sentence explaining *why* it
// is missing. This matters because the two reasons need different responses: an
// unreadable node is an access problem, while a gauge that never counts cycles
// is a hardware fact the user cannot do anything about.
const EXPLAINED_FIELDS = ['current', 'watts', 'cycleCount', 'chargeFullMah', 'chargeNowMah', 'socTemp'];

function withNotes(report) {
  const notes = {};
  for (const field of EXPLAINED_FIELDS) {
    const note = explainMissing(report, field);
    if (note) notes[field] = note;
  }
  return { ...report, notes };
}

ipcMain.handle('device:power', async (_e, serial) => {
  // Three sources, fetched concurrently because each is a separate adb round
  // trip and the poll interval is 1 s: dumpsys is the reliable floor, the sysfs
  // sweep is the detail layer, and the health HAL covers what sysfs withholds.
  const settle = (p) => p.then((v) => v, () => null);
  const [dumpRaw, sweep, hal] = await Promise.all([
    settle(adb(['-s', serial, 'shell', 'dumpsys', 'battery'])),
    settle(adb(['-s', serial, 'shell', POWER_SCRIPT])),
    settle(readHealthHal(serial)),
  ]);

  const dump = dumpRaw ? parseDumpsysBattery(dumpRaw) : {};
  const { supplies, zones } = sweep ? parsePowerDump(sweep) : { supplies: {}, zones: [] };
  const { health, healthSource } = hal || { health: {}, healthSource: null };

  if (!Object.keys(dump).length && !Object.keys(supplies).length && !Object.keys(health).length) {
    throw new Error('Neither "dumpsys battery", /sys/class/power_supply nor the health HAL could be read.');
  }

  return withNotes(buildPowerReport({ dump, supplies, zones, health, healthSource }));
});

// SoC identity and CPU topology never change either, so this is cached as well.
const socCache = new Map();

ipcMain.handle('device:soc', async (_e, serial) => {
  const cached = socCache.get(serial);
  if (cached) return cached;

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

  const soc = {
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
  socCache.set(serial, soc);
  return soc;
});

// ---------------------------------------------------------------------------
// Live telemetry: one handler, one poll, everything that actually changes.
//
// The old dashboard polled `device:power`, `device:hardware`, `device:info` and
// `device:soc` separately every 3 s. `device:info` alone is nine sequential
// `getprop` calls, and none of what it returns can change while the phone is
// plugged in — so most of the perceived lag was the UI waiting on static data.
// Here the live reads are batched into as few round trips as possible and run
// concurrently, and the static specs are cached per serial (see device:specs).
// ---------------------------------------------------------------------------

const settled = (p) => p.then((v) => v, () => null);

ipcMain.handle('device:telemetry', async (_e, serial) => {
  const meminfoRaw = getMeminfoRaw(serial);
  const [perfRaw, psRaw, sweep, dumpRaw, hal] = await Promise.all([
    settled(adb(['-s', serial, 'shell', PERF_SCRIPT])),
    settled(adb(['-s', serial, 'shell', 'ps -A -o PID 2>/dev/null | wc -l'])),
    settled(adb(['-s', serial, 'shell', POWER_SCRIPT])),
    settled(adb(['-s', serial, 'shell', 'dumpsys', 'battery'])),
    settled(readHealthHal(serial)),
  ]);

  const { supplies, zones } = sweep ? parsePowerDump(sweep) : { supplies: {}, zones: [] };
  const { health, healthSource } = hal || { health: {}, healthSource: null };

  // `wc -l` counts the header row too.
  const processCount = psRaw ? Math.max(0, Number(String(psRaw).trim()) - 1) || null : null;

  return {
    perf: buildPerfReport({
      perf: perfRaw ? parsePerfDump(perfRaw) : null,
      dumpsys: meminfoRaw ? parseDumpsysMeminfo(meminfoRaw) : null,
      processCount,
      zones,
    }),
    power: withNotes(buildPowerReport({
      dump: dumpRaw ? parseDumpsysBattery(dumpRaw) : {},
      supplies,
      zones,
      health,
      healthSource,
    })),
  };
});

ipcMain.handle('device:storage', async (_e, serial) => {
  const raw = await adb(['-s', serial, 'shell', STORAGE_SCRIPT]);
  return buildStorageReport(parseStorageDump(raw));
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
let recordSerial = null;
const REMOTE_RECORD_PATH = '/sdcard/companion_record.mp4';

ipcMain.handle('control:recordStart', async (_e, serial) => {
  if (recordProcess) return true;
  recordSerial = serial;
  try { await adb(['-s', serial, 'shell', 'rm', '-f', REMOTE_RECORD_PATH]); } catch { /* ignore */ }
  recordProcess = spawn(tools.adb, ['-s', serial, 'shell', 'screenrecord', REMOTE_RECORD_PATH]);
  recordProcess.on('exit', () => { recordProcess = null; });
  return true;
});

ipcMain.handle('control:recordStop', async (_e, serial) => {
  const targetSerial = serial || recordSerial;
  if (!recordProcess && !targetSerial) return null;

  // Signal remote screenrecord process via SIGINT (signal 2) so Android cleanly
  // flushes the encoder and writes the MP4 moov atom / trailer.
  if (targetSerial) {
    try {
      await adb(['-s', targetSerial, 'shell', 'pkill -2 screenrecord || killall -2 screenrecord || kill -2 $(pidof screenrecord)']);
    } catch { /* ignore */ }
  }
  if (recordProcess) {
    try { recordProcess.kill(); } catch { /* ignore */ }
    recordProcess = null;
  }
  recordSerial = null;

  // Give screenrecord a brief moment to finish writing the file to storage
  await new Promise((r) => setTimeout(r, 1500));

  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: `recording-${Date.now()}.mp4`,
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePath) {
    if (targetSerial) {
      try { await adb(['-s', targetSerial, 'shell', 'rm', '-f', REMOTE_RECORD_PATH]); } catch { /* ignore */ }
    }
    return null;
  }

  if (targetSerial) {
    await adb(['-s', targetSerial, 'pull', REMOTE_RECORD_PATH, filePath]);
    await adb(['-s', targetSerial, 'shell', 'rm', '-f', REMOTE_RECORD_PATH]);
  }
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
      const message = await adbConnect(target);
      // Remembered here rather than in the renderer, so the device is on the
      // autoconnect list from the moment the pairing succeeds — that is what
      // makes the next launch skip the pairing screen entirely.
      await rememberConnected(target);
      return { paired, connected: true, target, message };
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
  const target = `${host}:${port || 5555}`;
  const message = await adbConnect(target);
  await rememberConnected(target);
  return message;
});

ipcMain.handle('wireless:discover', async () => pickConnectTarget(await adbText(['mdns', 'services'])));

// Drops a device. A wireless serial is `host:port` or mDNS name, which adb can genuinely
// disconnect; a physical USB serial cannot be detached from this end, so the caches are
// cleared and the renderer just deselects it.
ipcMain.handle('device:disconnect', async (_e, serial) => {
  forgetDevice(serial);
  // The device stays on the autoconnect list: disconnecting is temporary, and
  // the pairing key on the phone is untouched. Use devices:forget to drop it.
  if (isWirelessSerial(serial)) {
    const msg = await adbText(['disconnect', serial]);
    return { disconnected: true, message: msg || 'Disconnected' };
  }
  try {
    const msg = await adbText(['disconnect', serial]);
    if (/disconnected/i.test(msg)) {
      return { disconnected: true, message: msg };
    }
  } catch { /* ignore */ }

  return {
    disconnected: false,
    message: 'USB devices stay attached until the cable is unplugged — unplug it, '
      + 'or turn off USB debugging on the phone.',
  };
});

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
            // A QR pairing is exactly the case autoconnect exists for: the user
            // will not want to re-scan a code on every launch.
            await rememberConnected(match.target);
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
const TEXT_EXT = /\.(txt|md|json|xml|csv|log|ini|cfg|conf|yaml|yml|toml|sh|bat|ps1|py|js|ts|html|css|java|kt|c|cpp|h|rs)$/i;
const VIDEO_EXT = /\.(mp4|mkv|avi|mov|webm|3gp|m4v)$/i;
const PDF_EXT = /\.pdf$/i;

ipcMain.handle('files:list', async (_e, { serial, remotePath }) => {
  const out = await adb(['-s', serial, 'shell', 'ls -la ' + JSON.stringify(remotePath)]);
  return out.split('\n').filter(Boolean);
});

function streamMax(bin, args, maxBytes) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    const chunks = [];
    let total = 0;
    let truncated = false;
    proc.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total <= maxBytes) {
        chunks.push(chunk);
      } else if (!truncated) {
        truncated = true;
        const remaining = maxBytes - (total - chunk.length);
        if (remaining > 0) chunks.push(chunk.slice(0, remaining));
        proc.kill();
      }
    });
    proc.on('close', (code) => {
      if (code !== 0 && truncated) return resolve(Buffer.concat(chunks));
      if (code !== 0) return reject(new Error('adb exited ' + code));
      resolve(Buffer.concat(chunks));
    });
    proc.on('error', reject);
  });
}

const PREVIEW_MAX = 20 * 1024 * 1024;

ipcMain.handle('files:preview', async (_e, { serial, remotePath }) => {
  if (IMAGE_EXT.test(remotePath)) {
    const buf = await streamMax(tools.adb, ['-s', serial, 'exec-out', 'cat', remotePath], PREVIEW_MAX);
    return { kind: 'image', data: `data:image/*;base64,${buf.toString('base64')}` };
  }
  if (TEXT_EXT.test(remotePath)) {
    const out = await adb(['-s', serial, 'shell', 'head -c 50000 ' + JSON.stringify(remotePath)]);
    return { kind: 'text', data: out };
  }
  if (VIDEO_EXT.test(remotePath)) {
    const buf = await streamMax(tools.adb, ['-s', serial, 'exec-out', 'cat', remotePath], PREVIEW_MAX);
    if (buf.length < PREVIEW_MAX) {
      return { kind: 'video', data: `data:video/*;base64,${buf.toString('base64')}` };
    }
    return null;
  }
  if (PDF_EXT.test(remotePath)) {
    const buf = await streamMax(tools.adb, ['-s', serial, 'exec-out', 'cat', remotePath], PREVIEW_MAX);
    return { kind: 'pdf', data: `data:application/pdf;base64,${buf.toString('base64')}` };
  }
  return null;
});

// Live transfers: every pull/push runs under a client-supplied id so progress
// events can be matched to the right transfer (no cross-talk when transfers
// overlap) and so the UI's Stop button can abort mid-flight. Each scope tracks
// its child processes for killing; execFile-based calls are short and finish
// on their own, while loops check the flag between entries.
let transferSeq = 0;
const liveTransfers = new Map();
function transferScope(transferId) {
  const id = (typeof transferId === 'string' && transferId) || `tc-${Date.now().toString(36)}-${(transferSeq += 1)}`;
  let scope = liveTransfers.get(id);
  if (!scope) { scope = { id, cancelled: false, procs: new Set() }; liveTransfers.set(id, scope); }
  return scope;
}
function endTransferScope(scope) { if (scope) liveTransfers.delete(scope.id); }
function xferCancelled(scope) { return !!(scope && scope.cancelled); }
function trackProc(scope, proc) {
  if (!scope || !proc) return proc;
  scope.procs.add(proc);
  const drop = () => scope.procs.delete(proc);
  proc.once('close', drop);
  proc.once('error', drop);
  if (scope.cancelled) { try { proc.kill(); } catch {} }
  return proc;
}
function emitXfer(sender, channel, scope, payload) {
  try { sender.send(channel, { ...payload, transferId: scope ? scope.id : null }); } catch {}
}
ipcMain.handle('files:cancelTransfer', async (_e, { transferId }) => {
  const scope = transferId && liveTransfers.get(transferId);
  if (!scope) return false;
  scope.cancelled = true;
  for (const proc of [...scope.procs]) { try { proc.kill(); } catch {} }
  return true;
});

/** Remote file size in bytes (null when unreadable — e.g. no stat applet). */
async function remoteFileSize(serial, remotePath) {
  try {
    const out = await adb(['-s', serial, 'shell', 'stat', '-c', '%s', remotePath]);
    const n = parseInt(String(out).trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
}

ipcMain.handle('files:pull', async (e, { serial, remotePath, sizeHint, transferId }) => {
  const scope = transferScope(transferId);
  const emit = (payload) => emitXfer(e.sender, 'files:pullProgress', scope, payload);
  try {
    const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: path.basename(remotePath) });
    if (canceled || !filePath) return null;
    if (xferCancelled(scope)) return null;
    emit({ index: 0, total: 1, name: path.basename(remotePath), percent: 0 });
    try {
      let totalBytes = await remoteFileSize(serial, remotePath);
      if (!(totalBytes > 0)) totalBytes = Number(sizeHint) > 0 ? Number(sizeHint) : 0;
      const proc = trackProc(scope, spawn(tools.adb, ['-s', serial, 'exec-out', 'cat', remotePath]));
      let bytesRead = 0;
      const ws = fs.createWriteStream(filePath);
      await new Promise((resolve, reject) => {
        proc.stdout.on('data', (chunk) => {
          bytesRead += chunk.length;
          ws.write(chunk);
          if (totalBytes > 0) {
            const pct = Math.min(99, Math.round((bytesRead / totalBytes) * 100));
            emit({ index: 0, total: 1, name: path.basename(remotePath), percent: pct, bytes: bytesRead, totalBytes });
          } else {
            emit({ index: 0, total: 1, name: path.basename(remotePath), percent: -1, bytes: bytesRead, totalBytes: 0 });
          }
        });
        proc.on('close', (code) => {
          ws.end(() => {
            if (xferCancelled(scope)) return reject(new Error('Transfer cancelled'));
            if (code === 0) resolve();
            else reject(new Error('adb exited with code ' + code));
          });
        });
        proc.on('error', (err) => { ws.end(); reject(err); });
      });
      emit({ index: 0, total: 1, name: path.basename(remotePath), percent: 100, bytes: bytesRead, totalBytes: bytesRead });
      return filePath;
    } catch (err) {
      if (xferCancelled(scope)) return null;
      try { await adb(['-s', serial, 'pull', remotePath, filePath]); } catch (fallbackErr) { throw fallbackErr; }
      emit({ index: 0, total: 1, name: path.basename(remotePath), percent: 100 });
      return filePath;
    }
  } finally {
    endTransferScope(scope);
  }
});

/**
 * Recursively lists files under a remote directory (paths relative to it),
 * so a selected folder downloads as a tree instead of being skipped. Uses
 * NUL separation to survive spaces, quotes, and newlines in names; throws
 * when the device has no find(1), and the caller falls back to a whole-dir
 * `adb pull` instead.
 */
async function listRemoteFilesRecursive(serial, remoteDir) {
  const dir = String(remoteDir).replace(/\/?$/, '');
  const out = await adb(['-s', serial, 'shell', 'find ' + JSON.stringify(dir) + ' -type f -print0']);
  return String(out || '')
    .split('\0')
    .map((p) => p.replace(/\r$/, ''))
    .filter((p) => p.startsWith(dir + '/'))
    .map((p) => p.slice(dir.length + 1))
    .filter(Boolean);
}

/**
 * `adb pull` as a tracked child process (killable for Stop, with a readable
 * error). The shared adb() helper buffers and cannot be aborted mid-flight.
 */
async function adbPullTracked({ serial, remotePath, localPath, scope }) {
  const proc = trackProc(scope, spawn(tools.adb, ['-s', serial, 'pull', remotePath, localPath]));
  proc.stdout.resume();
  let stderr = '';
  proc.stderr.on('data', (b) => { stderr = (stderr + b.toString()).slice(-2000); });
  const code = await new Promise((resolve) => {
    proc.once('error', () => resolve(null));
    proc.once('close', (c) => resolve(c));
  });
  if (xferCancelled(scope)) throw new Error('Transfer cancelled');
  if (code !== 0) {
    const detail = stderr.trim().split('\n').filter(Boolean).pop();
    throw new Error(detail || `adb pull exited with code ${code}`);
  }
}

ipcMain.handle('files:pullBatch', async (e, { serial, files, destDir, transferId }) => {
  const scope = transferScope(transferId);
  const emit = (payload) => emitXfer(e.sender, 'files:pullProgress', scope, payload);
  try {
    if (!destDir) {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'], title: 'Select download folder' });
      if (result.canceled || !result.filePaths.length) return null;
      destDir = result.filePaths[0];
    }
    if (xferCancelled(scope)) return null;
    // Expand selected folders into their contained files with structure
    // preserved (destDir/<folder>/<relative path>), keeping per-file progress.
    // A folder that walks empty — genuinely empty, or a device without find —
    // stays a single whole-directory entry pulled natively below.
    const queue = [];
    for (const f of files) {
      if (xferCancelled(scope)) break;
      if (!f.isDir) { queue.push({ ...f, localRel: f.name }); continue; }
      let rels = null;
      try { rels = await listRemoteFilesRecursive(serial, f.path); } catch { rels = null; }
      if (!rels || !rels.length) { queue.push({ ...f, isDir: true, localRel: f.name }); continue; }
      const base = String(f.path).replace(/\/?$/, '');
      for (const rel of rels) {
        queue.push({ path: base + '/' + rel, name: f.name + '/' + rel, localRel: path.join(f.name, rel) });
      }
    }
    const results = [];
    for (let i = 0; i < queue.length; i++) {
      if (xferCancelled(scope)) break;
      const f = queue[i];
      const sizeHint = Number(f.sizeHint) > 0 ? Number(f.sizeHint) : 0;
      emit({ index: i, total: queue.length, name: f.name, percent: 0, bytes: 0, totalBytes: sizeHint });
      const localPath = path.join(destDir, f.localRel);
      if (f.isDir) {
        // Whole-directory fallback: `adb pull` recurses natively. destDir
        // exists, so the folder lands as destDir/<name>/… — indeterminate
        // progress while it runs, since adb reports no per-file signal.
        // Pre-creating the target also preserves genuinely empty folders,
        // which `adb pull` alone would silently skip.
        try {
          fs.mkdirSync(path.join(destDir, f.name), { recursive: true });
          await adbPullTracked({ serial, remotePath: f.path, localPath: destDir, scope });
          results.push({ name: f.name, ok: true, path: path.join(destDir, f.name) });
        } catch (err) {
          results.push({ name: f.name, ok: false, error: err.message });
          if (xferCancelled(scope)) break;
        }
        emit({ index: i, total: queue.length, name: f.name, percent: 100 });
        continue;
      }
      try { fs.mkdirSync(path.dirname(localPath), { recursive: true }); } catch { /* ignore */ }
      try {
        let totalBytes = await remoteFileSize(serial, f.path);
        if (!(totalBytes > 0)) totalBytes = sizeHint;
        const proc = trackProc(scope, spawn(tools.adb, ['-s', serial, 'exec-out', 'cat', f.path]));
        let bytesRead = 0;
        const ws = fs.createWriteStream(localPath);
        await new Promise((resolve, reject) => {
          proc.stdout.on('data', (chunk) => {
            bytesRead += chunk.length;
            ws.write(chunk);
            const pct = totalBytes > 0 ? Math.min(99, Math.round((bytesRead / totalBytes) * 100)) : -1;
            emit({ index: i, total: queue.length, name: f.name, percent: pct, bytes: bytesRead, totalBytes });
          });
          proc.on('close', (code) => {
            ws.end(() => {
              if (xferCancelled(scope)) return reject(new Error('Transfer cancelled'));
              if (code === 0) resolve();
              else reject(new Error('exit ' + code));
            });
          });
          proc.on('error', (err) => { ws.end(); reject(err); });
        });
        emit({ index: i, total: queue.length, name: f.name, percent: 100, bytes: bytesRead, totalBytes: bytesRead });
        results.push({ name: f.name, ok: true, path: localPath });
      } catch (err) {
        if (xferCancelled(scope)) { results.push({ name: f.name, ok: false, error: 'Transfer cancelled' }); break; }
        try {
          await adbPullTracked({ serial, remotePath: f.path, localPath, scope });
          results.push({ name: f.name, ok: true, path: localPath });
        } catch (pullErr) {
          results.push({ name: f.name, ok: false, error: pullErr.message });
          if (xferCancelled(scope)) break;
        }
        emit({ index: i, total: queue.length, name: f.name, percent: 100 });
      }
    }
    const cancelled = xferCancelled(scope);
    return { destDir, results, cancelled };
  } finally {
    endTransferScope(scope);
  }
});

/**
 * `adb push` as a tracked child process with live byte progress. adb itself
 * reports nothing until it finishes, so the remote size is polled while it
 * runs — the UI shows real MBs instead of a stuck indeterminate bar. Single
 * poll failures (and devices without stat) degrade silently to the old
 * start/finish events. Resolves on success; throws on failure or user cancel.
 */
async function adbPushTracked({ serial, localPath, targetPath, totalBytes, scope, onEvent }) {
  const proc = trackProc(scope, spawn(tools.adb, ['-s', serial, 'push', localPath, targetPath]));
  proc.stdout.resume();
  proc.stderr.resume();
  let finished = false;
  let spawnErr = null;
  proc.once('error', (err) => { spawnErr = err; });
  const done = new Promise((resolve) => proc.once('close', (code) => { finished = true; resolve(code); }));
  if (xferCancelled(scope)) { try { proc.kill(); } catch {} }
  const t0 = Date.now();
  while (!finished) {
    await new Promise((r) => setTimeout(r, 500));
    if (finished || xferCancelled(scope)) break;
    if (Date.now() - t0 < 800) continue; // let the transfer actually start
    try {
      const bytes = await remoteFileSize(serial, targetPath);
      if (bytes !== null && bytes >= 0) onEvent(Math.min(bytes, totalBytes || bytes));
    } catch { /* single poll failures are fine */ }
  }
  const exitCode = await done;
  if (xferCancelled(scope)) throw new Error('Transfer cancelled');
  if (spawnErr && (exitCode === null || exitCode === undefined)) throw spawnErr;
  if (exitCode !== 0) throw new Error('adb push exited with code ' + exitCode);
}

ipcMain.handle('files:push', async (e, { serial, remoteDir, transferId }) => {
  const scope = transferScope(transferId);
  const emit = (payload) => emitXfer(e.sender, 'files:pushProgress', scope, payload);
  const report = (index, total, name, percent, bytes, totalBytes) => {
    emit({ index, total, name, percent, bytes: bytes || 0, totalBytes: totalBytes || 0 });
  };
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (canceled || !filePaths.length) return null;
    if (xferCancelled(scope)) return null;
    const localPath = filePaths[0];
    const name = path.basename(localPath);
    const remotePath = remoteDir.replace(/\/?$/, '/') + name;
    const totalBytes = fs.statSync(localPath).size;
    const tick = (bytes) => report(0, 1, name,
      totalBytes > 0 ? Math.min(99, Math.round((bytes / totalBytes) * 100)) : -1, bytes, totalBytes);
    report(0, 1, name, -1, 0, totalBytes);
    try {
      const tmpPath = '/data/local/tmp/_push_' + Date.now() + '_' + name.replace(/[^a-zA-Z0-9._-]/g, '_');
      await adbPushTracked({ serial, localPath, targetPath: tmpPath, totalBytes, scope, onEvent: tick });
      if (xferCancelled(scope)) {
        try { await adb(['-s', serial, 'shell', 'rm', '-f', tmpPath]); } catch {}
        return null;
      }
      await adb(['-s', serial, 'shell', 'mv', tmpPath, remotePath]);
    } catch (err) {
      if (xferCancelled(scope)) return null;
      await adbPushTracked({
        serial, localPath, targetPath: remoteDir, totalBytes, scope,
        onEvent: (bytes) => report(0, 1, name,
          totalBytes > 0 ? Math.min(99, Math.round((bytes / totalBytes) * 100)) : -1, bytes, totalBytes),
      });
    }
    if (xferCancelled(scope)) return null;
    report(0, 1, name, 100, totalBytes, totalBytes);
    return localPath;
  } finally {
    endTransferScope(scope);
  }
});

ipcMain.handle('files:pushBatch', async (e, { serial, remoteDir, transferId }) => {
  const scope = transferScope(transferId);
  const emit = (payload) => emitXfer(e.sender, 'files:pushProgress', scope, payload);
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: 'Select files to upload',
    });
    if (canceled || !filePaths.length) return null;
    const results = [];
    for (let i = 0; i < filePaths.length; i++) {
      if (xferCancelled(scope)) break;
      const lp = filePaths[i];
      const name = path.basename(lp);
      let totalBytes = 0;
      try { totalBytes = fs.statSync(lp).size; } catch { /* ignore */ }
      const target = remoteDir.replace(/\/?$/, '/') + name;
      emit({ index: i, total: filePaths.length, name, percent: -1, bytes: 0, totalBytes });
      try {
        await adbPushTracked({
          serial, localPath: lp, targetPath: target, totalBytes, scope,
          onEvent: (bytes) => emit({
            index: i, total: filePaths.length, name,
            percent: totalBytes > 0 ? Math.min(99, Math.round((bytes / totalBytes) * 100)) : -1,
            bytes, totalBytes,
          }),
        });
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, error: xferCancelled(scope) ? 'Transfer cancelled' : err.message });
        if (xferCancelled(scope)) break;
      }
      emit({ index: i, total: filePaths.length, name, percent: 100, bytes: totalBytes, totalBytes });
    }
    const cancelled = xferCancelled(scope);
    return { results, cancelled };
  } finally {
    endTransferScope(scope);
  }
});

ipcMain.handle('files:pushBatchFiles', async (e, { serial, remoteDir, filePaths, transferId }) => {
  const scope = transferScope(transferId);
  const emit = (payload) => emitXfer(e.sender, 'files:pushProgress', scope, payload);
  try {
    if (!filePaths || !filePaths.length) return { results: [], cancelled: xferCancelled(scope) };
    const results = [];
    for (let i = 0; i < filePaths.length; i++) {
      if (xferCancelled(scope)) break;
      const lp = filePaths[i];
      const name = path.basename(lp);
      let totalBytes = 0;
      try { totalBytes = fs.statSync(lp).size; } catch { /* ignore */ }
      const target = remoteDir.replace(/\/?$/, '/') + name;
      emit({ index: i, total: filePaths.length, name, percent: -1, bytes: 0, totalBytes });
      try {
        await adbPushTracked({
          serial, localPath: lp, targetPath: target, totalBytes, scope,
          onEvent: (bytes) => emit({
            index: i, total: filePaths.length, name,
            percent: totalBytes > 0 ? Math.min(99, Math.round((bytes / totalBytes) * 100)) : -1,
            bytes, totalBytes,
          }),
        });
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, error: xferCancelled(scope) ? 'Transfer cancelled' : err.message });
        if (xferCancelled(scope)) break;
      }
      emit({ index: i, total: filePaths.length, name, percent: 100, bytes: totalBytes, totalBytes });
    }
    const cancelled = xferCancelled(scope);
    return { results, cancelled };
  } finally {
    endTransferScope(scope);
  }
});

ipcMain.handle('files:delete', (_e, { serial, remotePath }) => adb(['-s', serial, 'shell', 'rm -rf ' + JSON.stringify(remotePath)]));

// ---------------------------------------------------------------------------
// Apps
//
// The inventory is one shell round trip (src/apps.js explains the script and why
// the label has to be layered). Doing it per-app would be ~1200 adb invocations
// on a phone with 300 packages, which takes minutes.
// ---------------------------------------------------------------------------

// A package id only ever contains letters, digits, dots and underscores. Every
// id that reaches a shell string is checked against this, so a crafted name
// cannot smuggle a `;` into the batched script.
const PKG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/;

function assertPackage(pkg) {
  const id = String(pkg || '').trim();
  if (!PKG_RE.test(id)) throw new Error(`Not a package name: ${pkg}`);
  return id;
}

ipcMain.handle('apps:listDetailed', async (_e, serial) => {
  const raw = await adb(['-s', serial, 'shell', APPS_SCRIPT]);
  return buildAppList(parseAppsDump(raw));
});

/**
 * Everything the inspector shows, in one round trip.
 *
 * The two `du` attempts are both expected to fail on a normal device: /data/data
 * is unreadable from the adb shell, and `run-as` only works for a debuggable
 * app. They are still worth making — when one does succeed the panel shows real
 * numbers instead of "unavailable" — and when both fail the parse returns null,
 * which is what the UI renders as a dash.
 */
function detailScript(pkg) {
  const dataDir = `/data/data/${pkg}`;
  return [
    'echo "@@DUMP@@";', `dumpsys package ${pkg} 2>/dev/null;`,
    'echo "@@DATA@@";', `du -sk ${dataDir} 2>/dev/null;`,
    `run-as ${pkg} du -sk ${dataDir} 2>/dev/null;`,
    'echo "@@CACHE@@";', `du -sk ${dataDir}/cache 2>/dev/null;`,
    `run-as ${pkg} du -sk ${dataDir}/cache 2>/dev/null;`,
    'exit 0',
  ].join(' ');
}

function splitDetail(raw) {
  const out = { dump: '', data: '', cache: '' };
  let current = null;
  for (const line of String(raw || '').split('\n')) {
    const text = line.replace(/\r$/, '').trim();
    if (text === '@@DUMP@@') { current = 'dump'; continue; }
    if (text === '@@DATA@@') { current = 'data'; continue; }
    if (text === '@@CACHE@@') { current = 'cache'; continue; }
    if (current) out[current] += `${line.replace(/\r$/, '')}\n`;
  }
  return out;
}

ipcMain.handle('apps:detail', async (_e, { serial, pkg, app = null }) => {
  const id = assertPackage(pkg);
  const raw = await adb(['-s', serial, 'shell', detailScript(id)]);
  const { dump, data, cache } = splitDetail(raw);
  return buildAppDetail({
    app: app || { pkg: id },
    dump: parsePackageDump(dump),
    apkBytes: app ? app.apkBytes : null,
    dataBytes: parseDuBytes(data),
    cacheBytes: parseDuBytes(cache),
  });
});

/**
 * Installs one or more APKs, reporting per file.
 *
 * `adb install` announces failure on stdout and, depending on the version, still
 * exits 0 — the same trap as `adb pair` — so the output is classified rather
 * than the exit status trusted. Files are installed one at a time: a batch that
 * stopped at the first failure would leave the user guessing which of five
 * dropped APKs actually landed.
 */
async function installApks(serial, filePaths) {
  const results = [];
  for (const filePath of (Array.isArray(filePaths) ? filePaths : []).filter(Boolean)) {
    const name = path.basename(filePath);
    if (!isInstallable(filePath)) {
      results.push({
        file: name,
        ok: false,
        code: null,
        message: 'Only a single .apk can be installed over adb. Split bundles (.apks/.xapk) need their own installer.',
      });
      continue;
    }
    const out = await adbText(['-s', serial, 'install', '-r', filePath]);
    results.push({ file: name, ...parseInstallResult(out) });
  }
  return results;
}

ipcMain.handle('apps:install', async (_e, serial) => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: 'Choose APKs to sideload',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Android package', extensions: ['apk'] }],
  });
  if (canceled || !filePaths.length) return null;
  return installApks(serial, filePaths);
});

// Drag-and-drop hands over paths the renderer already resolved, so there is no
// dialog to show.
ipcMain.handle('apps:installFiles', async (_e, { serial, filePaths }) => installApks(serial, filePaths));

ipcMain.handle('apps:uninstall', (_e, { serial, pkg }) => adb(['-s', serial, 'uninstall', assertPackage(pkg)]));
ipcMain.handle('apps:disable', (_e, { serial, pkg }) => adb(['-s', serial, 'shell', 'pm', 'disable-user', '--user', '0', assertPackage(pkg)]));
ipcMain.handle('apps:enable', (_e, { serial, pkg }) => adb(['-s', serial, 'shell', 'pm', 'enable', assertPackage(pkg)]));
ipcMain.handle('apps:clearData', (_e, { serial, pkg }) => adb(['-s', serial, 'shell', 'pm', 'clear', assertPackage(pkg)]));

// ---------------------------------------------------------------------------
// App icons
//
// adb exposes no launcher icon: `pm`/`dumpsys` print a numeric resource id, and
// the bitmap itself only exists inside the APK. Pulling every APK to unzip one
// PNG would move gigabytes. Instead a ~4 KB dex helper is pushed once and run
// with `app_process`, exactly as scrcpy runs its server: that gives it a real
// PackageManager, from which getApplicationIcon() renders each icon to a PNG we
// read straight off stdout. It runs as the shell user, so a handful of apps
// with locked-down icons simply do not answer — the UI keeps its monogram tile
// for those, and for any device where app_process is not lettable at all.
// ---------------------------------------------------------------------------

const ICON_DEX_REMOTE = '/data/local/tmp/companion-icons.dex';

// Bundled next to smartphone.png. When packaged the app runs from inside
// app.asar, which the external adb binary cannot read, so the dex is unpacked
// (see "asarUnpack" in package.json) and reached through app.asar.unpacked.
//
// Order matters: Electron patches fs so existsSync() returns true for the path
// *inside* app.asar, but adb — an external process — cannot stat that virtual
// path, so pushing it would fail and every icon would fall back to a monogram
// in the packaged .exe. We therefore try the unpacked copy first. In dev there
// is no "app.asar" segment, so the replace is a no-op and both entries are the
// same real path.
function iconDexPath() {
  const inApp = path.join(__dirname, 'assets', 'classes.dex');
  const unpacked = inApp.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  for (const candidate of [unpacked, inApp]) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return inApp;
}

// The push is done once per serial and shared between the renderer's batched
// calls; a failure clears the cache so a later attempt can retry rather than
// being stuck behind a rejected promise.
const iconDexPushes = new Map();
function ensureIconDex(serial) {
  if (!iconDexPushes.has(serial)) {
    const dex = iconDexPath();
    const push = adb(['-s', serial, 'push', dex, ICON_DEX_REMOTE])
      .then(() => true)
      .catch((err) => { iconDexPushes.delete(serial); throw err; });
    iconDexPushes.set(serial, push);
  }
  return iconDexPushes.get(serial);
}

ipcMain.handle('apps:icons', async (_e, { serial, pkgs }) => {
  const list = (Array.isArray(pkgs) ? pkgs : [])
    .map((p) => String(p || '').trim())
    .filter((p) => PKG_RE.test(p));
  if (!serial || !list.length) return {};
  try {
    if (!fs.existsSync(iconDexPath())) return {};
    await ensureIconDex(serial);
    // Every id is PKG_RE-checked above, so none can smuggle a shell token into
    // the app_process command line.
    const out = await adb([
      '-s', serial, 'shell',
      `CLASSPATH=${ICON_DEX_REMOTE}`, 'app_process', '/system/bin',
      'com.companion.IconExtractor', ...list,
    ]);
    return parseIconDump(out);
  } catch {
    // No icons is not an error the user needs to see — the monograms stand in.
    return {};
  }
});

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
    // `--user 0`: bare `pm list` aborts on devices with a broken/parallel
    // user (seen: "Shell does not have permission to access user 999").
    const pkgOut = await adb(['-s', serial, 'shell', 'pm', 'list', 'packages', '-3', '--user', '0']);
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

function controlBarWindow(bar, serial, { type = 'mirror' } = {}) {
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
    query: { serial, type },
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
    title: session.title || (session.type === 'camera' ? cameraWindowTitle(session.serial) : mirrorWindowTitle(session.serial)),
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

app.on('before-quit', () => {
  closeMirrorSession({ killScrcpy: true });
  closeCameraSession({ killScrcpy: true });
  stopWebcamBridge();
});

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
  if (audioProcess) {
    try { audioProcess.kill(); } catch { /* ignore */ }
    audioProcess = null;
  }
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

// Reads the device's MUSIC stream level. `cmd audio get-volume` exists on
// Android 10+; older devices only answer via `dumpsys audio`, whose format
// varies, so parseAudioVolume() tries several shapes. Returns the level the
// slider needs to position itself honestly after a set or a poll.
async function readMusicVolume(serial) {
  try {
    const volOut = await adb(['-s', serial, 'shell', 'cmd', 'audio', 'get-volume', 'music']);
    const m = volOut.match(/(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* fall through */ }
  try {
    const volOut2 = await adb(['-s', serial, 'shell', 'cmd', 'audio', 'get-volume', 'STREAM_MUSIC']);
    const m2 = volOut2.match(/(\d+)/);
    if (m2) return Number(m2[1]);
  } catch { /* fall through */ }
  try {
    const dump = await adb(['-s', serial, 'shell', 'dumpsys', 'audio']);
    const { index } = parseAudioVolume(dump);
    if (Number.isFinite(index)) return index;
  } catch { /* fall through */ }
  return null;
}

ipcMain.handle('audio:getVolume', async (_e, serial) => {
  if (!serial) return { level: null, max: 15 };
  const level = await readMusicVolume(serial);
  return { level, max: 15 };
});

// Set the device's media volume to a 0-15 level (Android's 16-step scale).
// Uses `cmd audio` on Android 10+ and falls back to `media volume --set` for
// older devices, then reports back the actual level so the slider can correct.
ipcMain.handle('audio:setVolume', async (_e, { serial, level }) => {
  const clamped = Math.max(0, Math.min(15, Math.round(Number(level) || 0)));
  // Try `cmd audio set-volume music <level>` (Android 10+).
  try {
    await adb(['-s', serial, 'shell', 'cmd', 'audio', 'set-volume', 'music', String(clamped)]);
  } catch {
    // Fallback: `media volume --set <level>` (Android 5-9).
    try {
      await adb(['-s', serial, 'shell', 'media', 'volume', '--set', String(clamped), '--stream', '3']);
    } catch (err2) {
      throw new Error(`Failed to set volume: ${err2.message}`);
    }
  }
  // Read back actual level so the UI snaps to truth, not to the request.
  const actual = await readMusicVolume(serial);
  return Number.isFinite(actual) ? actual : clamped;
});

const MEDIA_KEYCODES = { play: 126, pause: 127, playPause: 85, next: 87, previous: 88 };
const MEDIA_DISPATCH_VERBS = {
  play: 'play', pause: 'pause', playPause: 'play-pause', next: 'next', previous: 'previous',
};
// Package ids are allow-listed so none can smuggle a shell token into the
// `media dispatch` command line.
const MEDIA_PKG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/;

ipcMain.handle('media:key', async (_e, { serial, action, package: pkg }) => {
  const code = MEDIA_KEYCODES[action];
  if (!code) throw new Error(`Unknown media action: ${action}`);
  // Targeted dispatch reaches the right player when several sessions exist;
  // a global keyevent goes to whichever session the system prefers, which is
  // one reason the phone can pause while the UI still shows "playing".
  const cleanPkg = pkg && MEDIA_PKG_RE.test(String(pkg).trim()) ? String(pkg).trim() : null;
  if (cleanPkg && MEDIA_DISPATCH_VERBS[action]) {
    const verb = MEDIA_DISPATCH_VERBS[action];
    // `media dispatch` (Android 8-12) moved under `cmd media_session`
    // (Android 13+); try both before falling back to the global keyevent.
    try {
      await adb(['-s', serial, 'shell', 'media', 'dispatch', verb, cleanPkg]);
      return 'dispatch';
    } catch { /* try cmd form */ }
    try {
      await adb(['-s', serial, 'shell', 'cmd', 'media_session', 'dispatch', verb, cleanPkg]);
      return 'dispatch';
    } catch { /* fall through to the global keyevent */ }
  }
  await adb(['-s', serial, 'shell', 'input', 'keyevent', String(code)]);
  return 'keyevent';
});

ipcMain.handle('media:nowPlaying', async (_e, serial) => {
  const out = await adb(['-s', serial, 'shell', 'dumpsys', 'media_session']);
  const track = parseNowPlaying(out);
  // Every art URI in the dump, primary first: the artwork fetcher tries them
  // in order because the first is occasionally a stale placeholder.
  let artUris = [];
  try {
    const all = collectArtUris(out);
    if (track && track.artUri) artUris = [track.artUri, ...all.filter((u) => u !== track.artUri)];
    else artUris = all;
  } catch { artUris = track && track.artUri ? [track.artUri] : []; }
  return {
    track,
    artUris: artUris.slice(0, 4),
    // When the snapshot was taken. The renderer advances `position` from this so
    // the elapsed time moves between polls instead of jumping every few seconds.
    readAt: Date.now(),
    // Kept so older callers (and the one-line status) keep working.
    description: describeTrack(track),
    sessions: parseAllSessions(out).length,
  };
});

// Album artwork, fetched the same way launcher icons are: adb cannot hand back
// the bitmap (dumpsys prints only a content:// URI, and `content read` mangles
// binary over the shell channel), so the bytes are resolved on-device.
// Order: (1) MediaArtFetcher dex via ContentResolver (downsamples to 512px,
// JPEG, base64 — the reliable path, same pattern as IconExtractor);
// (2) on-device base64 pipe (`content read --uri … | base64`), which avoids
// the shell binary mangling without needing the dex; (3) legacy raw
// `content read` for very old devices. Returns a data URL or null.
function sniffArtMime(b64) {
  if (/^\/9j\//.test(b64)) return 'image/jpeg';
  if (/^iVBOR/.test(b64)) return 'image/png';
  if (/^UklGR/.test(b64)) return 'image/webp';
  if (/^R0lGOD/.test(b64)) return 'image/gif';
  return 'image/jpeg';
}

function parseArtDump(stdout, count) {
  // `ART:<index>:<base64>` lines; indices match the requested URI order.
  const arts = new Array(count).fill(null);
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('ART:')) continue;
    const body = line.slice(4);
    const sep = body.indexOf(':');
    if (sep <= 0) continue;
    const idx = Number(body.slice(0, sep));
    const b64 = body.slice(sep + 1).trim();
    if (!Number.isInteger(idx) || idx < 0 || idx >= count) continue;
    if (b64.length < 32 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
    arts[idx] = `${sniffArtMime(b64) === 'image/png' ? 'data:image/png' : sniffArtMime(b64) === 'image/webp' ? 'data:image/webp' : sniffArtMime(b64) === 'image/gif' ? 'data:image/gif' : 'data:image/jpeg'};base64,${b64}`;
  }
  return arts;
}

async function fetchArtViaDex(serial, uris) {
  if (!fs.existsSync(iconDexPath())) return new Array(uris.length).fill(null);
  await ensureIconDex(serial);
  const clean = uris.map((u) => String(u || '').trim()).filter(Boolean);
  if (!clean.length) return new Array(uris.length).fill(null);
  const out = await adb([
    '-s', serial, 'shell',
    `CLASSPATH=${ICON_DEX_REMOTE}`, 'app_process', '/system/bin',
    'com.companion.MediaArtFetcher', ...clean,
  ]);
  return parseArtDump(out, clean.length);
}

async function fetchArtViaBase64Pipe(serial, uri) {
  // Base64 is encoded ON the device, so the shell channel only ever carries
  // text. `tr -d` joins the 76-char wrap lines into one payload. Some providers
  // need an explicit `--user 0`; retry with it when the plain read is empty.
  const q = JSON.stringify(uri);
  const cmds = [
    `content read --uri ${q} 2>/dev/null | base64 2>/dev/null | tr -d '\\n\\r '`,
    `content read --uri ${q} --user 0 2>/dev/null | base64 2>/dev/null | tr -d '\\n\\r '`,
  ];
  for (const cmd of cmds) {
    let out = '';
    try {
      // eslint-disable-next-line no-await-in-loop
      out = await adb(['-s', serial, 'shell', cmd]);
    } catch { continue; }
    const b64 = String(out || '').replace(/\s+/g, '');
    if (!b64 || b64.includes('Noresult') || b64.includes('Permissiondenied') || b64.length < 100) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) continue;
    const mime = sniffArtMime(b64);
    return `data:${mime};base64,${b64}`;
  }
  return null;
}

ipcMain.handle('media:artworkBatch', async (_e, { serial, uris }) => {
  const list = (Array.isArray(uris) ? uris : [])
    .map((u) => String(u || '').trim())
    .filter((u) => u.startsWith('content://'));
  if (!serial || !list.length) return [];
  // 1) Dex helper (one app_process run for the whole batch).
  try {
    const arts = await fetchArtViaDex(serial, list);
    if (arts.some(Boolean)) return arts;
  } catch { /* fall through */ }
  // 2) On-device base64 pipe, per URI.
  const out = [];
  for (const uri of list) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const url = await fetchArtViaBase64Pipe(serial, uri);
      out.push(url);
    } catch { out.push(null); }
  }
  return out;
});

ipcMain.handle('media:artwork', async (_e, { serial, uri }) => {
  if (!serial || !uri) return null;
  try {
    const arts = await fetchArtViaDex(serial, [uri]);
    if (arts[0]) return arts[0];
  } catch { /* fall through */ }
  try {
    const url = await fetchArtViaBase64Pipe(serial, uri);
    if (url) return url;
  } catch { /* fall through to legacy */ }
  try {
    // Legacy: raw `content read`. Binary is frequently mangled here, so this
    // is strictly a last resort for devices where `base64` is missing.
    const buf = await adb(['-s', serial, 'shell', 'content', 'read', '--uri', uri]);
    if (!buf || !buf.length) return null;
    const raw = buf.replace(/[\r\n]+$/g, '');
    if (!raw || raw.includes('No result') || raw.includes('Permission denied')) return null;
    const b64 = Buffer.from(raw, 'binary').toString('base64');
    if (b64.length < 100) return null;
    return `data:${sniffArtMime(b64)};base64,${b64}`;
  } catch { return null; }
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
    mic: supportsMic(scrcpyInfo.help, scrcpyInfo),
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

function closeCameraSession({ killScrcpy = false } = {}) {
  const session = cameraSession;
  cameraSession = null;
  if (!session) return;
  if (session.bar && !session.bar.isDestroyed()) session.bar.destroy();
  if (killScrcpy && session.child && session.child.exitCode === null) {
    try { session.child.kill(); } catch { /* already gone */ }
  }
}

async function startCameraSession(opts = {}) {
  const { serial } = opts;
  await assertDeviceReady(serial);
  assertCameraSupport();
  // If a recording is in flight and this restart would abandon it (mic toggle,
  // camera switch, rotate, …), finalize the file first instead of corrupting it
  // with the hard kill below. Best-effort: the restart itself must not fail
  // because of a recording; the file stays valid on disk either way.
  if (cameraRecordingFile && opts.record !== cameraRecordingFile) {
    try { await finalizeCameraRecording(); } catch { cameraRecordingFile = null; }
  }
  closeCameraSession({ killScrcpy: true });
  if (audioProcess) {
    try { audioProcess.kill(); } catch { /* ignore */ }
    audioProcess = null;
  }

  const dock = opts.dock !== false;
  const canDock = dock && supportsPlacement(scrcpyInfo.help);

  let camW = 1920;
  let camH = 1080;
  if (opts.size && /^\d+x\d+$/.test(opts.size)) {
    const [w, h] = opts.size.split('x').map(Number);
    if (w && h) { camW = w; camH = h; }
  }

  const rotation = opts.orientation ? Math.round(((opts.orientation % 360) / 90)) : 0;
  const zoom = clampZoom(opts.zoom);
  const geometry = {
    deviceWidth: camW,
    deviceHeight: camH,
    rotation,
    maxSize: opts.maxSize,
  };

  const layout = computeDockLayout({
    ...geometry,
    zoom,
    workArea: screen.getPrimaryDisplay().workArea,
  });

  const baseArgs = buildCameraArgs(serial, {
    cameraId: opts.cameraId,
    facing: opts.facing,
    size: opts.size || (opts.maxSize ? undefined : '1920x1080'),
    fps: opts.fps,
    maxFps: opts.maxFps || 60,
    bitrate: opts.bitrate || 8,
    maxSize: opts.maxSize,
    highSpeed: opts.highSpeed,
    mic: opts.mic,
    v4l2Device: opts.v4l2Device,
    orientation: opts.orientation,
    record: opts.record,
    stayAwake: true,
  }, scrcpyInfo.help, scrcpyInfo);

  const args = canDock
    ? [...baseArgs, ...buildWindowArgs(layout.video, scrcpyInfo.help, { borderless: !!opts.borderless })]
    : baseArgs;

  const session = {
    serial,
    child: null,
    bar: null,
    layout,
    geometry,
    zoom,
    opts,
    args: baseArgs,
    type: 'camera',
    title: cameraWindowTitle(serial),
    borderless: !!opts.borderless,
    micActive: baseArgs.some((a) => /--audio-source=mic/.test(a)),
  };

  try {
    await spawnScrcpy(args, {
      graceMs: 2200,
      onSpawn: (child) => { session.child = child; },
      onExit: () => { if (cameraSession === session) closeCameraSession(); },
    });
  } catch (err) {
    const limits = await readEncoderLimits(serial);
    throw new Error(describeCameraFailure(err.message, { size: opts.size, limits }));
  }

  if (canDock && session.child && session.child.exitCode === null) {
    session.bar = controlBarWindow(layout.bar, serial, { type: 'camera' });
    session.bar.on('closed', () => {
      if (cameraSession === session) closeCameraSession({ killScrcpy: true });
    });
  }

  cameraSession = session;
  return { running: true, docked: canDock, size: opts.size || `${camW}x${camH}`, mic: !!opts.mic, layout, zoom };
}

async function applyCameraZoom(zoom) {
  const session = cameraSession;
  if (!session) throw new Error('No camera stream running.');

  const next = clampZoom(zoom);
  const workArea = screen.getPrimaryDisplay().workArea;
  const layout = computeDockLayout({ ...session.geometry, zoom: next, workArea });

  const moved = await moveScrcpyWindow(session, layout.video);

  if (moved !== 'ok') {
    const args = [
      ...session.args,
      ...buildWindowArgs(layout.video, scrcpyInfo.help, { borderless: session.borderless }),
    ];
    if (session.child && session.child.exitCode === null) {
      session.child.removeAllListeners('exit');
      try { session.child.kill(); } catch { /* already gone */ }
    }
    await spawnScrcpy(args, {
      graceMs: 1800,
      onSpawn: (child) => { session.child = child; },
      onExit: () => { if (cameraSession === session) closeCameraSession(); },
    });
  }

  session.zoom = next;
  session.layout = layout;
  placeBar(session, layout.bar);

  return { zoom: next, relaunched: moved !== 'ok', reason: moved, layout };
}

ipcMain.handle('camera:start', async (_e, opts = {}) => startCameraSession(opts));

ipcMain.handle('camera:stop', async () => {
  const wasOpen = !!cameraSession || !!cameraRecordingFile;
  // Stopping mid-record must finalize the file, not corrupt it: without this
  // the recorder is hard-killed and the MP4 never gets its moov index.
  // Never throws for a bad recording — the stream still stops; the outcome
  // rides along for the UI to report.
  let recording = null;
  let recordError = null;
  if (cameraRecordingFile) {
    try { recording = await finalizeCameraRecording(); }
    catch (err) { recordError = err.message; }
  }
  closeCameraSession({ killScrcpy: true });
  return { stopped: wasOpen, recording, recordError };
});

ipcMain.handle('camera:status', () => ({
  running: !!(cameraSession && cameraSession.child && cameraSession.child.exitCode === null),
  serial: cameraSession ? cameraSession.serial : null,
  size: cameraSession ? (cameraSession.opts.size || null) : null,
  mic: cameraSession ? !!cameraSession.micActive : false,
  docked: !!(cameraSession && cameraSession.bar),
  zoom: cameraSession ? cameraSession.zoom : 1,
  recording: !!cameraRecordingFile,
}));

ipcMain.handle('camera:setZoom', (_e, zoom) => applyCameraZoom(zoom));

ipcMain.handle('camera:nudgeZoom', (_e, direction) => {
  if (!cameraSession) throw new Error('No camera stream running.');
  return applyCameraZoom(stepZoom(cameraSession.zoom, direction));
});

ipcMain.handle('camera:redock', async () => {
  const session = cameraSession;
  if (!session || !session.bar || session.bar.isDestroyed()) return false;
  const live = await readScrcpyWindowRect(session);
  if (!live) return placeBar(session, session.layout.bar);
  session.layout = { ...session.layout, video: live };
  return placeBar(session, barBelow(live, screen.getPrimaryDisplay().workArea));
});

ipcMain.handle('camera:switch', async (_e, serial) => {
  if (!cameraSession) throw new Error('No camera stream running.');
  const currOpts = { ...cameraSession.opts };
  const targetSerial = serial || cameraSession.serial;
  let cameras = [];
  try {
    const out = await runScrcpyText(['-s', targetSerial, '--list-camera-sizes']);
    cameras = parseCameraList(out);
  } catch { /* ignore */ }

  if (cameras.length > 1) {
    const currId = currOpts.cameraId;
    const currIdx = cameras.findIndex((c) => (currId !== undefined && c.id === currId) || c.facing === currOpts.facing);
    const nextCam = cameras[(currIdx + 1) % cameras.length];
    currOpts.cameraId = nextCam.id;
    currOpts.facing = nextCam.facing;
    if (nextCam.sizes && nextCam.sizes.length) {
      const preferred = nextCam.sizes.find((s) => s.size === '1920x1080') || nextCam.sizes.find((s) => s.size === '1280x720') || nextCam.sizes[0];
      currOpts.size = preferred.size;
    }
  } else {
    currOpts.facing = currOpts.facing === 'front' ? 'back' : 'front';
    delete currOpts.cameraId;
  }

  return startCameraSession(currOpts);
});

ipcMain.handle('camera:rotate', async (_e, serial) => {
  if (!cameraSession) throw new Error('No camera stream running.');
  const currOpts = { ...cameraSession.opts };
  currOpts.orientation = ((currOpts.orientation || 0) + 90) % 360;
  return startCameraSession(currOpts);
});

ipcMain.handle('camera:toggleMic', async (_e, serial) => {
  if (!cameraSession) throw new Error('No camera stream running.');
  const currOpts = { ...cameraSession.opts };
  currOpts.mic = !currOpts.mic;
  return startCameraSession(currOpts);
});

function cropWindowChrome(nativeImg, isBorderless) {
  if (!nativeImg || nativeImg.isEmpty() || isBorderless) return nativeImg;
  const size = nativeImg.getSize();
  if (size.width < 120 || size.height < 120) return nativeImg;
  const topBar = Math.min(Math.max(Math.round(size.height * 0.035), 30), 45);
  const sideMargin = Math.min(Math.max(Math.round(size.width * 0.006), 2), 8);
  const cropW = Math.max(size.width - sideMargin * 2, 10);
  const cropH = Math.max(size.height - topBar - sideMargin, 10);
  try {
    return nativeImg.crop({ x: sideMargin, y: topBar, width: cropW, height: cropH });
  } catch {
    return nativeImg;
  }
}

/**
 * Camera frame: captures the scrcpy camera window via desktopCapturer while a
 * camera stream is running, else null (the renderer shows its standby
 * placeholder). Deliberately no screencap fallback: showing the phone screen
 * inside the camera preview — notably right after Stop — lies about what the
 * camera sees, which is exactly the confusion it caused.
 */
ipcMain.handle('camera:frame', async (_e, serial) => {
  if (!serial) return null;

  if (cameraSession && cameraSession.child && cameraSession.child.exitCode === null) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 960, height: 540 },
      });
      const camTitle = cameraWindowTitle(serial);
      const src = sources.find((s) => s.name.includes(camTitle) || s.name.startsWith('Camera'));
      if (src && src.thumbnail && !src.thumbnail.isEmpty()) {
        const cropped = cropWindowChrome(src.thumbnail, !!cameraSession?.borderless);
        return `data:image/png;base64,${cropped.toPNG().toString('base64')}`;
      }
    } catch { /* no frame this tick */ }
  }
  return null;
});

/**
 * Camera photo capture: captures the high-res camera frame directly from the
 * scrcpy camera stream window.
 */
ipcMain.handle('camera:capturePhoto', async (_e, serial) => {
  const targetSerial = serial || cameraSession?.serial;
  if (!targetSerial) throw new Error('No device selected.');

  let buf = null;
  if (cameraSession && cameraSession.child && cameraSession.child.exitCode === null) {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 3840, height: 2160 },
      });
      const camTitle = cameraWindowTitle(targetSerial);
      const src = sources.find((s) => s.name.includes(camTitle) || s.name.startsWith('Camera'));
      if (src && src.thumbnail && !src.thumbnail.isEmpty()) {
        const cropped = cropWindowChrome(src.thumbnail, !!cameraSession?.borderless);
        buf = cropped.toPNG();
      }
    } catch { /* fall through */ }
  }

  if (!buf || !buf.length) {
    try {
      buf = await adbBuffer(['-s', targetSerial, 'exec-out', 'screencap', '-p']);
    } catch { /* ignore */ }
  }

  if (!buf || !buf.length) throw new Error('Failed to capture photo from camera.');

  const defaultName = `camera-capture-${Date.now()}.png`;
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'PNG Image', extensions: ['png'] }, { name: 'All Files', extensions: ['*'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, buf);
  return filePath;
});

let cameraRecordingFile = null;

/**
 * Stops an scrcpy child the way its recorder needs: a graceful close lets it
 * flush the encoder and write the MP4 moov trailer; a hard kill leaves video
 * bytes with no index — a file that exists but no player will open.
 *
 * Windows has no SIGINT for child processes (Node's kill() is TerminateProcess),
 * but the camera scrcpy runs with a real window (windowsHide: false), so plain
 * `taskkill /PID` delivers WM_CLOSE → SDL_QUIT → clean recorder shutdown.
 * POSIX gets SIGINT. Anything still alive after the grace window is force-killed.
 *
 * Returns 'exited' | 'force-killed' | 'already-exited'.
 */
async function stopScrcpyGracefully(child, { timeoutMs = RECORD_STOP_TIMEOUT_MS } = {}) {
  if (!child || child.exitCode !== null) return 'already-exited';
  const exited = new Promise((resolve) => { child.once('exit', () => resolve(true)); });
  // The exit may already have happened between the check above and the
  // listener attach (for a process that died on its own): don't hang then.
  if (child.exitCode !== null) return 'exited';
  let signaled = false;
  if (process.platform === 'win32' && child.pid) {
    try { await run('taskkill', ['/PID', String(child.pid)]); signaled = true; }
    catch { /* window already gone: fall through to kill */ }
  } else {
    try { child.kill('SIGINT'); signaled = true; }
    catch { /* fall through */ }
  }
  if (!signaled) { try { child.kill(); } catch {} }
  const winner = await Promise.race([
    exited.then(() => 'exited'),
    new Promise((r) => setTimeout(() => r('timeout'), timeoutMs)),
  ]);
  if (winner === 'timeout') {
    try {
      if (process.platform === 'win32' && child.pid) await run('taskkill', ['/F', '/PID', String(child.pid)]);
      else child.kill('SIGKILL');
    } catch {}
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
    return 'force-killed';
  }
  return 'exited';
}

/**
 * Repairs a skewed recording in place when possible: some devices emit video
 * timestamps minutes after the audio's (frozen frame + phantom duration),
 * with perfect deltas — shifting the late track back fixes the file. Reads
 * the whole file (recordings are tens of MB); skips absurd sizes. Returns
 * true only when the file was rewritten AND the rewritten bytes re-verify.
 */
function repairRecordingFileInPlace(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.mkv' && ext !== '.webm' && ext !== '.mp4' && ext !== '.m4v' && ext !== '.mov') return false;
  let st;
  try { st = fs.statSync(filePath); } catch { return false; }
  if (!st.isFile() || st.size < RECORD_MIN_BYTES || st.size > 1024 * 1024 * 1024) return false;
  let buf;
  try { buf = fs.readFileSync(filePath); } catch { return false; }
  let fixed = null;
  try {
    fixed = (ext === '.mp4' || ext === '.m4v' || ext === '.mov') ? repairMp4Edits(buf) : repairMkvTimestamps(buf);
  } catch { return false; }
  if (!fixed || fixed === buf) return false;
  try {
    const headSize = Math.min(fixed.length, RECORD_HEAD_SCAN_BYTES);
    const head = fixed.subarray(0, headSize);
    const tailSize = Math.min(fixed.length, RECORD_TAIL_SCAN_BYTES);
    const tail = fixed.subarray(fixed.length - tailSize);
    if (!assessRecording({ head, tail, size: fixed.length, ext }).ok) return false;
  } catch { return false; }
  try { fs.writeFileSync(filePath, fixed); } catch { return false; }
  return true;
}

/** Reads a finished recording off disk and judges it playable (see src/recording). */
function verifyRecordingFile(filePath) {
  let st;
  try { st = fs.statSync(filePath); }
  catch { return { ok: false, reason: 'no file was written', bytes: 0 }; }
  if (!st.isFile() || st.size < RECORD_MIN_BYTES) {
    return { ok: false, reason: 'file is empty', bytes: st.isFile() ? st.size : 0 };
  }
  const ext = path.extname(filePath).toLowerCase();
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      // The MKV Info block (with Duration) sits in the first bytes; give the
      // EBML scan room, while MP4 only needs its 12-byte ftyp.
      const headSize = Math.min(st.size, RECORD_HEAD_SCAN_BYTES);
      const head = Buffer.alloc(headSize);
      fs.readSync(fd, head, 0, headSize, 0);
      const tailSize = Math.min(st.size, RECORD_TAIL_SCAN_BYTES);
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, st.size - tailSize);
      const res = assessRecording({ head, tail, size: st.size, ext });
      return { ...res, bytes: st.size };
    } finally { fs.closeSync(fd); }
  } catch (err) {
    return { ok: false, reason: err.message, bytes: st.size };
  }
}

/**
 * Ends the in-flight camera recording and returns the verified file path.
 * Detaches the session first (without killing) so the recorder's exit cannot
 * tear down fresh state, stops it gracefully, lets the file flush, then
 * verifies playability. Throws an honest error for a dead file instead of
 * handing back a path no player will open. The live preview session is left
 * for the caller to restart or stop.
 */
async function finalizeCameraRecording() {
  const filePath = cameraRecordingFile;
  cameraRecordingFile = null;
  if (!filePath) return null;
  const recChild = cameraSession && cameraSession.child ? cameraSession.child : null;
  // Detach without killing: the exit handler below becomes a no-op for it.
  closeCameraSession({ killScrcpy: false });
  if (recChild) await stopScrcpyGracefully(recChild);
  // Let the OS flush the last muxed bytes before inspecting.
  await new Promise((r) => setTimeout(r, RECORD_FLUSH_SETTLE_MS));
  // Repair skewed A/V timelines (device timestamp quirk) before verifying.
  try { repairRecordingFileInPlace(filePath); } catch { /* fall through to verify */ }
  const check = verifyRecordingFile(filePath);
  if (!check.ok) {
    const hint = path.extname(filePath).toLowerCase() === '.mp4'
      ? 'Try again, ideally saving as .mkv.'
      : 'The recorder did not shut down cleanly — try recording again and stop with the Record button.';
    throw new Error(`Recording did not finalize (${check.reason}). ${hint}`);
  }
  return filePath;
}

/**
 * Camera video record: records the pristine hardware-encoded camera stream
 * directly to a local file on the PC using scrcpy's native --record.
 * MKV is the default because it stays playable even if the recorder dies
 * mid-stream; MP4 remains selectable but needs the clean shutdown below.
 */
ipcMain.handle('camera:recordStart', async (_e, serial) => {
  const targetSerial = serial || cameraSession?.serial;
  if (!targetSerial) throw new Error('No device selected.');
  if (!cameraSession || !cameraSession.child || cameraSession.child.exitCode !== null) {
    throw new Error('Camera stream is not running. Start the camera first.');
  }
  if (cameraRecordingFile) throw new Error('Already recording — stop the current recording first.');

  const defaultName = `camera-record-${Date.now()}.mkv`;
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: defaultName,
    filters: [{ name: 'MKV Video', extensions: ['mkv'] }, { name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (canceled || !filePath) return null;

  cameraRecordingFile = filePath;
  const currOpts = { ...cameraSession.opts, record: filePath };
  try {
    await startCameraSession(currOpts);
  } catch (err) {
    cameraRecordingFile = null;
    throw err;
  }
  return filePath;
});

ipcMain.handle('camera:recordStop', async () => {
  if (!cameraRecordingFile) return null;
  const recSession = cameraSession;
  const recSerial = recSession ? recSession.serial : null;
  const recOpts = recSession ? { ...recSession.opts } : null;
  // Finalize first (verifies playability). The preview restart below runs
  // either way so a bad file never also kills the live view — but a corrupt
  // file is still reported, not hidden behind the restart.
  let filePath = null;
  let finalizeErr = null;
  try { filePath = await finalizeCameraRecording(); }
  catch (err) { finalizeErr = err; }
  if (recOpts) {
    delete recOpts.record;
    if (!recOpts.serial && recSerial) recOpts.serial = recSerial;
    try { await startCameraSession(recOpts); }
    catch (err) { if (!finalizeErr) throw err; }
  }
  if (finalizeErr) throw finalizeErr;
  return filePath;
});

ipcMain.handle('camera:recordStatus', () => !!cameraRecordingFile);

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
    throw new Error('No flashlight tile in quick settings. Add the Flashlight tile via the notification shade edit screen, then try again.');
  }

  const before = parseTorchStatus(await adbQuiet(['-s', serial, 'shell', 'dumpsys', 'media.camera']));

  let last = '';
  let clicked = null;

  // Try each known tile variant
  for (const tile of TORCH_TILES) {
    try {
      await adb(torchArgs(serial, tile));
      clicked = tile;
      break;
    } catch (err) {
      last = err.message;
    }
  }

  // Fallback: try expand-settings then click-tile on the first tile
  if (!clicked) {
    try {
      await adb(torchFallbackArgs(serial));
      for (const tile of TORCH_TILES) {
        try {
          await adb(torchArgs(serial, tile));
          clicked = tile;
          break;
        } catch (err) { last = err.message; }
      }
    } catch { /* ignore */ }
  }

  // Final fallback: use input keyevent for flashlight (some devices support this)
  if (!clicked) {
    try {
      await adb(['-s', serial, 'shell', 'input', 'keyevent', '224']);
      clicked = 'keyevent';
    } catch (err) { last = err.message; }
  }

  if (!clicked) throw new Error('Flashlight toggle failed. ' + describeTorchFailure(last));

  const after = parseTorchStatus(await adbQuiet(['-s', serial, 'shell', 'dumpsys', 'media.camera']));
  if (after && before !== after) return { toggled: true, state: after, tile: clicked };
  if (after && before === after) {
    return { toggled: true, state: after, tile: clicked, note: 'State unchanged — toggle from the phone shade if the light did not change.' };
  }
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

// ---------------------------------------------------------------------------
// Native virtual webcam (Windows, tshino/softcam).
//
// Unlike the OBS route (which captures the visible preview window), this feeds
// the phone camera straight into a self-registered DirectShow device, so Zoom
// / Meet / Teams list it directly with no extra app to install or configure.
// The driver + bridge binaries are resolved like the icon dex: bundled copies
// first (assets/softcam is asarUnpacked, so external processes can run them),
// then userData/bin (future auto-download), then PATH.
//
// softcam is Windows-only; macOS keeps the OBS route and Linux the v4l2 route
// reported by camera:bridge above.
// ---------------------------------------------------------------------------

const WEBCAM_BIN_DIR = 'softcam';
const WEBCAM_REGISTERED_FILE = 'webcam-registered.json';

/** Unpacked-aware path into bundled assets (same pattern as iconDexPath). */
function bundledAsset(...parts) {
  const inApp = path.join(__dirname, 'assets', ...parts);
  const unpacked = inApp.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  for (const candidate of [unpacked, inApp]) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* keep looking */ }
  }
  return inApp;
}

function userBinPath(name) {
  try {
    return path.join(app.getPath('userData'), 'bin', WEBCAM_BIN_DIR, name);
  } catch { return null; }
}

function resolveWebcamPaths() {
  const exe = process.platform === 'win32' ? '.exe' : '';
  const find = (name) => {
    const bundled = bundledAsset('softcam', name);
    const candidates = [bundled, userBinPath(name)];
    if (process.platform === 'win32') {
      // No PATH lookup for our own binaries: they must be the exact build we
      // ship, not whatever happens to share the name.
      for (const c of candidates) {
        try { if (c && fs.existsSync(c)) return c; } catch { /* keep looking */ }
      }
      return null;
    }
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return c; } catch { /* keep looking */ }
    }
    return null;
  };
  // ffmpeg is the exception: it is a third-party LGPL build the user provides
  // (bundling a GPL build would contaminate this MIT app), so an explicit
  // override, userData, and PATH (e.g. a winget install) are all legitimate.
  let ffmpeg = process.env.APC_FFMPEG_PATH || null;
  if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    ffmpeg = userBinPath(`ffmpeg${exe}`);
    if (!ffmpeg || !fs.existsSync(ffmpeg)) ffmpeg = null;
  }
  return {
    bridge: find(`softcam-bridge${exe}`),
    installer: find(`softcam_installer${exe}`),
    dll: find(`softcam${process.platform === 'win32' ? '.dll' : '.so'}`),
    ffmpeg,
  };
}

/** ffmpeg with a PATH fallback (covers winget installs). Async: PATH lookup shells out. */
async function resolveFfmpegPath() {
  const paths = resolveWebcamPaths();
  if (paths.ffmpeg) return paths.ffmpeg;
  if (process.platform === 'win32') {
    try {
      const onPath = await resolveOnPath('ffmpeg');
      if (onPath) return onPath;
    } catch { /* not on PATH */
    }
  }
  return null;
}

function webcamRegisteredMarker() {
  try {
    return path.join(app.getPath('userData'), WEBCAM_REGISTERED_FILE);
  } catch { return null; }
}

function isWebcamRegistered() {
  const marker = webcamRegisteredMarker();
  if (!marker) return false;
  try {
    const data = JSON.parse(fs.readFileSync(marker, 'utf8'));
    return !!(data && data.registered && data.dll && fs.existsSync(data.dll));
  } catch { return false; }
}

let webcamHandle = null;
const webcamLog = [];
function webcamLogLine(msg) {
  webcamLog.push(`[${new Date().toISOString()}] ${String(msg).trim()}`);
  if (webcamLog.length > 40) webcamLog.splice(0, webcamLog.length - 40);
}

function stopWebcamBridge() {
  if (webcamHandle) {
    try { webcamHandle.stop(); } catch { /* already gone */ }
    webcamHandle = null;
  }
}

ipcMain.handle('webcam:status', async () => {
  if (!scrcpyInfo.version) await probeScrcpyVersion().catch(() => {});
  const paths = resolveWebcamPaths();
  return {
    supported: process.platform === 'win32',
    running: !!(webcamHandle && webcamHandle.running),
    bridgePresent: !!paths.bridge,
    ffmpegPresent: !!(await resolveFfmpegPath()),
    installerPresent: !!paths.installer,
    dllPresent: !!paths.dll,
    registered: isWebcamRegistered(),
    scrcpyOk: !!scrcpyInfo.version,
    log: webcamLog.slice(-20),
  };
});

ipcMain.handle('webcam:start', async (_e, opts = {}) => {
  if (process.platform !== 'win32') {
    throw new Error('The native virtual webcam is Windows-only; use the OBS route on macOS or v4l2 loopback on Linux (see camera:bridge).');
  }
  if (webcamHandle && webcamHandle.running) stopWebcamBridge();
  const { serial } = opts;
  await assertDeviceReady(serial);
  if (!scrcpyInfo.version) await probeScrcpyVersion();
  if (!scrcpyInfo.version) throw new Error('scrcpy is not available. Re-run tool setup from "Binaries & Drivers".');
  const paths = resolveWebcamPaths();
  if (!paths.bridge) {
    throw new Error('softcam-bridge.exe is not bundled yet — the native bridge ships with a future release. Use the OBS route meanwhile.');
  }
  const ffmpegPath = await resolveFfmpegPath();
  if (!ffmpegPath) {
    throw new Error('ffmpeg not found. Install an LGPL build (`winget install -e --id BtbN.FFmpeg.LGPL.Shared.8.1`) or point APC_FFMPEG_PATH at ffmpeg.exe (bundling a GPL build would contaminate this MIT app).');
  }
  if (!isWebcamRegistered()) {
    throw new Error('Virtual camera is not registered yet. Press "Register virtual camera" first (one UAC prompt).');
  }
  const size = String(opts.size || '1280x720');
  const m = size.match(/^(\d+)x(\d+)$/);
  if (!m) throw new Error(`Invalid size "${size}" — expected WIDTHxHEIGHT.`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  const fps = Math.max(1, Math.min(60, Math.round(Number(opts.fps) || 30)));
  const bitrate = Math.max(1, Math.min(32, Math.round(Number(opts.bitrate) || 8)));
  // Validate the argv shape (flag spellings, required pieces) before spawning.
  buildScrcpyCameraArgs(serial, {
    cameraId: opts.cameraId,
    facing: opts.facing,
    size: `${width}x${height}`,
    fps,
    bitrate,
    recordTarget: 'probe',
  }, scrcpyInfo.help);
  webcamLogLine(`starting bridge ${width}x${height}@${fps} for ${serial}`);
  webcamHandle = startWebcamBridge({
    serial,
    scrcpyPath: tools.scrcpy,
    ffmpegPath,
    bridgePath: paths.bridge,
    cameraId: opts.cameraId,
    facing: opts.facing,
    size: { width, height },
    fps,
    bitrate,
    help: scrcpyInfo.help,
    onLog: webcamLogLine,
    onExit: ({ code, origin }) => webcamLogLine(`pipeline ended via ${origin} (code ${code})`),
  });
  // Grace window: a DOA pipeline (bad camera id, missing provider) exits
  // immediately; surfacing that now beats a silent dead toggle.
  await new Promise((r) => setTimeout(r, 2500));
  if (!webcamHandle || !webcamHandle.running) {
    const tail = webcamLog.slice(-4).join('\n');
    stopWebcamBridge();
    throw new Error(`Virtual webcam failed to start.${tail ? `\n${tail}` : ''}`);
  }
  return { running: true, width, height, fps };
});

ipcMain.handle('webcam:stop', async () => {
  const wasRunning = !!(webcamHandle && webcamHandle.running);
  stopWebcamBridge();
  webcamLogLine('bridge stopped by user');
  return wasRunning;
});

ipcMain.handle('webcam:register', async () => {
  if (process.platform !== 'win32') throw new Error('Driver registration only applies on Windows.');
  const paths = resolveWebcamPaths();
  if (!paths.installer || !paths.dll) {
    throw new Error('Installer or softcam.dll not bundled yet — registration ships with a future release.');
  }
  // The installer writes the DLL path to the registry and needs elevation.
  // PowerShell Start-Process -Verb RunAs raises the UAC prompt; -Wait blocks
  // until the user answers, so a declined prompt surfaces as a failed install
  // rather than a silent no-op. The installer usage is `register <dll>`.
  const ps = 'Start-Process -FilePath $env:APC_INSTALLER -ArgumentList @("register",$env:APC_DLL) -Verb RunAs -Wait; exit $LASTEXITCODE';
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: 120000,
      env: { ...process.env, APC_INSTALLER: paths.installer, APC_DLL: paths.dll },
    }, (err) => (err ? reject(new Error(`Registration failed: ${err.message}`)) : resolve()));
  });
  const marker = webcamRegisteredMarker();
  if (marker) {
    try { fs.writeFileSync(marker, JSON.stringify({ registered: true, dll: paths.dll, at: Date.now() })); } catch {}
  }
  webcamLogLine('virtual camera registered');
  return { registered: true };
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

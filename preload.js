// This preload runs sandboxed (webPreferences.sandbox = true), where `require`
// is a polyfill that resolves only `electron` and a handful of node builtins.
// Requiring anything else — a node_module like jsqr, or a relative file like
// ./src/wireless — throws, Electron discards the entire preload, and the
// renderer boots with no window.api at all (which looked like the app hanging
// forever on "Setting up tools"). Keep this file to `electron` only.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // devices / dashboard
  listDevices: () => ipcRenderer.invoke('devices:list'),
  getDeviceInfo: (serial) => ipcRenderer.invoke('device:info', serial),
  getBattery: (serial) => ipcRenderer.invoke('device:battery', serial),
  getPower: (serial) => ipcRenderer.invoke('device:power', serial),
  getSoc: (serial) => ipcRenderer.invoke('device:soc', serial),
  getHardware: (serial) => ipcRenderer.invoke('device:hardware', serial),
  getPerformance: (serial) => ipcRenderer.invoke('device:performance', serial),
  getStorageBreakdown: (serial) => ipcRenderer.invoke('device:storageBreakdown', serial),
  // One round trip for everything that changes while the phone is connected, so
  // the dashboard can poll at 1 s without queueing six adb calls per tick.
  getTelemetry: (serial) => ipcRenderer.invoke('device:telemetry', serial),
  getStorage: (serial) => ipcRenderer.invoke('device:storage', serial),
  disconnectDevice: (serial) => ipcRenderer.invoke('device:disconnect', serial),

  // Remembered wireless devices. `autoconnect` re-attaches phones that were
  // paired in an earlier session, so pairing is a one-time step.
  listKnownDevices: () => ipcRenderer.invoke('devices:known'),
  autoconnect: (opts) => ipcRenderer.invoke('devices:autoconnect', opts),
  forgetKnownDevice: (hostOrSerial) => ipcRenderer.invoke('devices:forget', hostOrSerial),
  rebootBootloader: (serial) => ipcRenderer.invoke('device:rebootBootloader', serial),
  rebootSystem: (serial) => ipcRenderer.invoke('device:rebootSystem', serial),

  // side-channel controls
  volumeUp: (serial) => ipcRenderer.invoke('control:volumeUp', serial),
  volumeDown: (serial) => ipcRenderer.invoke('control:volumeDown', serial),
  powerLongPress: (serial) => ipcRenderer.invoke('control:powerLongPress', serial),
  navKey: (serial, action) => ipcRenderer.invoke('control:navKey', { serial, action }),
  statusBar: (serial, panel) => ipcRenderer.invoke('control:statusBar', { serial, panel }),
  rotate: (serial, rotation) => ipcRenderer.invoke('control:rotate', { serial, rotation }),
  screenshot: (serial) => ipcRenderer.invoke('control:screenshot', serial),
  recordStart: (serial) => ipcRenderer.invoke('control:recordStart', serial),
  recordStop: (serial) => ipcRenderer.invoke('control:recordStop', serial),
  recordStatus: () => ipcRenderer.invoke('control:recordStatus'),

  // raw console
  runConsole: (serial, command) => ipcRenderer.invoke('console:run', { serial, command }),

  // wireless
  pairWireless: (hostPort, code, connectPort) =>
    ipcRenderer.invoke('wireless:pair', { hostPort, code, connectPort }),
  connectWireless: (hostPort) => ipcRenderer.invoke('wireless:connect', hostPort),
  discoverWireless: () => ipcRenderer.invoke('wireless:discover'),
  enableTcpip: (serial, port) => ipcRenderer.invoke('wireless:enableTcpip', { serial, port }),

  // files
  listFiles: (serial, remotePath) => ipcRenderer.invoke('files:list', { serial, remotePath }),
  previewFile: (serial, remotePath) => ipcRenderer.invoke('files:preview', { serial, remotePath }),
  pullFile: (serial, remotePath) => ipcRenderer.invoke('files:pull', { serial, remotePath }),
  pullBatch: (serial, files, destDir) => ipcRenderer.invoke('files:pullBatch', { serial, files, destDir }),
  pushFile: (serial, remoteDir) => ipcRenderer.invoke('files:push', { serial, remoteDir }),
  pushBatch: (serial, remoteDir) => ipcRenderer.invoke('files:pushBatch', { serial, remoteDir }),
  pushBatchFiles: (serial, remoteDir, filePaths) => ipcRenderer.invoke('files:pushBatchFiles', { serial, remoteDir, filePaths }),
  deleteFile: (serial, remotePath) => ipcRenderer.invoke('files:delete', { serial, remotePath }),
  onPullProgress: (cb) => ipcRenderer.on('files:pullProgress', (_e, data) => cb(data)),
  onPushProgress: (cb) => ipcRenderer.on('files:pushProgress', (_e, data) => cb(data)),

  // apps
  listAppsDetailed: (serial) => ipcRenderer.invoke('apps:listDetailed', serial),
  getAppIcons: (serial, pkgs) => ipcRenderer.invoke('apps:icons', { serial, pkgs }),
  getAppDetail: (serial, pkg, app) => ipcRenderer.invoke('apps:detail', { serial, pkg, app }),
  installApk: (serial) => ipcRenderer.invoke('apps:install', serial),
  // Drag-and-drop sideloading. A dropped File has no usable path in the
  // renderer any more, so the path is resolved here and only the string crosses
  // the bridge — the renderer never gets to invent a path of its own.
  installApkFiles: (serial, filePaths) => ipcRenderer.invoke('apps:installFiles', { serial, filePaths }),
  pathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') return webUtils.getPathForFile(file);
    } catch { /* falls through to the legacy property below */ }
    return (file && file.path) || null;
  },
  uninstallApp: (serial, pkg) => ipcRenderer.invoke('apps:uninstall', { serial, pkg }),
  disableApp: (serial, pkg) => ipcRenderer.invoke('apps:disable', { serial, pkg }),
  enableApp: (serial, pkg) => ipcRenderer.invoke('apps:enable', { serial, pkg }),
  clearAppData: (serial, pkg) => ipcRenderer.invoke('apps:clearData', { serial, pkg }),

  // backup
  chooseBackupDestination: () => ipcRenderer.invoke('backup:chooseDestination'),
  runBackup: (serial, categories, destDir, includeApks) =>
    ipcRenderer.invoke('backup:run', { serial, categories, destDir, includeApks }),
  onBackupProgress: (callback) => ipcRenderer.on('backup:progress', (_e, line) => callback(line)),

  // mirror
  launchScrcpy: (serial, options) => ipcRenderer.invoke('scrcpy:launch', { serial, ...options }),
  scrcpyInfo: () => ipcRenderer.invoke('scrcpy:info'),
  stopMirror: () => ipcRenderer.invoke('scrcpy:stop'),
  redockControls: () => ipcRenderer.invoke('scrcpy:redock'),
  dockState: () => ipcRenderer.invoke('scrcpy:dockState'),
  setMirrorZoom: (zoom) => ipcRenderer.invoke('scrcpy:setZoom', zoom),
  nudgeMirrorZoom: (direction) => ipcRenderer.invoke('scrcpy:nudgeZoom', direction),

  // audio + media
  startAudio: (serial) => ipcRenderer.invoke('audio:start', serial),
  stopAudio: () => ipcRenderer.invoke('audio:stop'),
  audioStatus: () => ipcRenderer.invoke('audio:status'),
  setVolume: (serial, level) => ipcRenderer.invoke('audio:setVolume', { serial, level }),
  getVolume: (serial) => ipcRenderer.invoke('audio:getVolume', serial),
  mediaKey: (serial, action, pkg) => ipcRenderer.invoke('media:key', { serial, action, package: pkg }),
  nowPlaying: (serial) => ipcRenderer.invoke('media:nowPlaying', serial),
  artwork: (serial, uri) => ipcRenderer.invoke('media:artwork', { serial, uri }),
  artworkBatch: (serial, uris) => ipcRenderer.invoke('media:artworkBatch', { serial, uris }),

  // camera
  listCameras: (serial) => ipcRenderer.invoke('camera:list', serial),
  startCamera: (opts) => ipcRenderer.invoke('camera:start', opts),
  stopCamera: () => ipcRenderer.invoke('camera:stop'),
  cameraStatus: () => ipcRenderer.invoke('camera:status'),
  toggleTorch: (serial) => ipcRenderer.invoke('camera:torch', serial),
  cameraBridge: () => ipcRenderer.invoke('camera:bridge'),
  cameraCapturePhoto: (serial) => ipcRenderer.invoke('camera:capturePhoto', serial),
  cameraRecordStart: (serial) => ipcRenderer.invoke('camera:recordStart', serial),
  cameraRecordStop: (serial) => ipcRenderer.invoke('camera:recordStop', serial),
  cameraRecordStatus: () => ipcRenderer.invoke('camera:recordStatus'),
  cameraFrame: (serial) => ipcRenderer.invoke('camera:frame', serial),
  cameraSetZoom: (zoom) => ipcRenderer.invoke('camera:setZoom', zoom),
  cameraNudgeZoom: (direction) => ipcRenderer.invoke('camera:nudgeZoom', direction),
  cameraRedock: () => ipcRenderer.invoke('camera:redock'),
  cameraSwitch: (serial) => ipcRenderer.invoke('camera:switch', serial),
  cameraRotate: (serial) => ipcRenderer.invoke('camera:rotate', serial),
  cameraToggleMic: (serial) => ipcRenderer.invoke('camera:toggleMic', serial),

  // fastboot
  fastbootUnlock: (serial) => ipcRenderer.invoke('fastboot:unlock', serial),
  fastbootDevices: () => ipcRenderer.invoke('fastboot:devices'),
  chooseFlashImage: () => ipcRenderer.invoke('fastboot:flashPartition'),
  flashPartition: (serial, partition, filePath) =>
    ipcRenderer.invoke('fastboot:flashPartitionConfirm', { serial, partition, filePath }),

  // tool status
  getToolsStatus: () => ipcRenderer.invoke('tools:status'),
  reinitTools: () => ipcRenderer.invoke('tools:reinit'),

  // first-run setup progress
  onSetupProgress: (callback) => ipcRenderer.on('setup:progress', (_e, payload) => callback(payload)),

  // auto-detect device selection
  onDeviceAutoSelected: (cb) => ipcRenderer.on('device:auto-selected', (_e, d) => cb(d)),
  onDeviceChoose: (cb) => ipcRenderer.on('device:choose', (_e, devices) => cb(devices)),

  // window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // theme: persisted { mode, accent } (+ the OS dark preference), and a live
  // push when that OS preference flips so an "Auto" theme follows it.
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onOsThemeChanged: (cb) => ipcRenderer.on('theme:osUpdated', (_e, osPrefersDark) => cb(osPrefersDark)),

  // QR pairing. The PC *shows* the code and the phone scans it, so this returns
  // a module matrix for the renderer to draw; progress arrives as events while
  // main watches mDNS for the phone.
  startQrPairing: () => ipcRenderer.invoke('wireless:qrPairStart'),
  cancelQrPairing: () => ipcRenderer.invoke('wireless:qrPairCancel'),
  onQrPairProgress: (callback) =>
    ipcRenderer.on('wireless:qrPairProgress', (_e, payload) => callback(payload)),
});

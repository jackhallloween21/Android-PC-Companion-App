// This preload runs sandboxed (webPreferences.sandbox = true), where `require`
// is a polyfill that resolves only `electron` and a handful of node builtins.
// Requiring anything else — a node_module like jsqr, or a relative file like
// ./src/wireless — throws, Electron discards the entire preload, and the
// renderer boots with no window.api at all (which looked like the app hanging
// forever on "Setting up tools"). Keep this file to `electron` only.
const { contextBridge, ipcRenderer } = require('electron');

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
  pushFile: (serial, remoteDir) => ipcRenderer.invoke('files:push', { serial, remoteDir }),
  deleteFile: (serial, remotePath) => ipcRenderer.invoke('files:delete', { serial, remotePath }),

  // apps
  listAppsDetailed: (serial) => ipcRenderer.invoke('apps:listDetailed', serial),
  getAppDetail: (serial, pkg) => ipcRenderer.invoke('apps:detail', { serial, pkg }),
  installApk: (serial) => ipcRenderer.invoke('apps:install', serial),
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
  mediaKey: (serial, action) => ipcRenderer.invoke('media:key', { serial, action }),
  nowPlaying: (serial) => ipcRenderer.invoke('media:nowPlaying', { serial }),

  // camera
  listCameras: (serial) => ipcRenderer.invoke('camera:list', serial),
  startCamera: (opts) => ipcRenderer.invoke('camera:start', opts),
  stopCamera: () => ipcRenderer.invoke('camera:stop'),
  cameraStatus: () => ipcRenderer.invoke('camera:status'),
  toggleTorch: (serial) => ipcRenderer.invoke('camera:torch', serial),
  cameraBridge: () => ipcRenderer.invoke('camera:bridge'),

  // fastboot
  fastbootUnlock: (serial) => ipcRenderer.invoke('fastboot:unlock', serial),
  chooseFlashImage: () => ipcRenderer.invoke('fastboot:flashPartition'),
  flashPartition: (serial, partition, filePath) =>
    ipcRenderer.invoke('fastboot:flashPartitionConfirm', { serial, partition, filePath }),

  // tool status
  getToolsStatus: () => ipcRenderer.invoke('tools:status'),
  reinitTools: () => ipcRenderer.invoke('tools:reinit'),

  // first-run setup progress
  onSetupProgress: (callback) => ipcRenderer.on('setup:progress', (_e, payload) => callback(payload)),

  // window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  // QR scan for wireless pairing. Both are async now: the decoding happens in
  // the main process (see the sandbox note at the top of this file).
  decodeQR: (data, width, height) => ipcRenderer.invoke('qr:decode', { data, width, height }),
  parsePairingQR: (text) => ipcRenderer.invoke('qr:parsePairing', text),
});

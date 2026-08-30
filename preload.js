const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // devices / dashboard
  listDevices: () => ipcRenderer.invoke('devices:list'),
  getDeviceInfo: (serial) => ipcRenderer.invoke('device:info', serial),
  getBattery: (serial) => ipcRenderer.invoke('device:battery', serial),
  getHardware: (serial) => ipcRenderer.invoke('device:hardware', serial),
  getPerformance: (serial) => ipcRenderer.invoke('device:performance', serial),
  getStorageBreakdown: (serial) => ipcRenderer.invoke('device:storageBreakdown', serial),
  rebootBootloader: (serial) => ipcRenderer.invoke('device:rebootBootloader', serial),
  rebootSystem: (serial) => ipcRenderer.invoke('device:rebootSystem', serial),

  // side-channel controls
  volumeUp: (serial) => ipcRenderer.invoke('control:volumeUp', serial),
  volumeDown: (serial) => ipcRenderer.invoke('control:volumeDown', serial),
  powerLongPress: (serial) => ipcRenderer.invoke('control:powerLongPress', serial),
  rotate: (serial, rotation) => ipcRenderer.invoke('control:rotate', { serial, rotation }),
  screenshot: (serial) => ipcRenderer.invoke('control:screenshot', serial),
  recordStart: (serial) => ipcRenderer.invoke('control:recordStart', serial),
  recordStop: (serial) => ipcRenderer.invoke('control:recordStop', serial),
  recordStatus: () => ipcRenderer.invoke('control:recordStatus'),

  // raw console
  runConsole: (serial, command) => ipcRenderer.invoke('console:run', { serial, command }),

  // wireless
  pairWireless: (hostPort, code) => ipcRenderer.invoke('wireless:pair', { hostPort, code }),
  connectWireless: (hostPort) => ipcRenderer.invoke('wireless:connect', hostPort),
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

  // audio + media
  startAudio: (serial) => ipcRenderer.invoke('audio:start', serial),
  stopAudio: () => ipcRenderer.invoke('audio:stop'),
  audioStatus: () => ipcRenderer.invoke('audio:status'),
  mediaKey: (serial, action) => ipcRenderer.invoke('media:key', { serial, action }),
  nowPlaying: (serial) => ipcRenderer.invoke('media:nowPlaying', serial),

  // camera
  launchCameraPreview: (serial, facing) => ipcRenderer.invoke('webcam:launchPreview', { serial, facing }),

  // fastboot
  fastbootUnlock: (serial) => ipcRenderer.invoke('fastboot:unlock', serial),
  chooseFlashImage: () => ipcRenderer.invoke('fastboot:flashPartition'),
  flashPartition: (serial, partition, filePath) =>
    ipcRenderer.invoke('fastboot:flashPartitionConfirm', { serial, partition, filePath }),

  // tool status
  getToolsStatus: () => ipcRenderer.invoke('tools:status'),

  // first-run setup progress
  onSetupProgress: (callback) => ipcRenderer.on('setup:progress', (_e, payload) => callback(payload)),

  // window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
});

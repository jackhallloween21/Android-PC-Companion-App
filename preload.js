const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // devices
  listDevices: () => ipcRenderer.invoke('devices:list'),
  getDeviceInfo: (serial) => ipcRenderer.invoke('device:info', serial),
  getBattery: (serial) => ipcRenderer.invoke('device:battery', serial),
  rebootBootloader: (serial) => ipcRenderer.invoke('device:rebootBootloader', serial),
  rebootSystem: (serial) => ipcRenderer.invoke('device:rebootSystem', serial),

  // wireless
  pairWireless: (hostPort, code) => ipcRenderer.invoke('wireless:pair', { hostPort, code }),
  connectWireless: (hostPort) => ipcRenderer.invoke('wireless:connect', hostPort),
  enableTcpip: (serial, port) => ipcRenderer.invoke('wireless:enableTcpip', { serial, port }),

  // files
  listFiles: (serial, remotePath) => ipcRenderer.invoke('files:list', { serial, remotePath }),
  pullFile: (serial, remotePath) => ipcRenderer.invoke('files:pull', { serial, remotePath }),
  pushFile: (serial, remoteDir) => ipcRenderer.invoke('files:push', { serial, remoteDir }),
  deleteFile: (serial, remotePath) => ipcRenderer.invoke('files:delete', { serial, remotePath }),

  // apps
  listApps: (serial) => ipcRenderer.invoke('apps:list', serial),
  installApk: (serial) => ipcRenderer.invoke('apps:install', serial),
  uninstallApp: (serial, pkg) => ipcRenderer.invoke('apps:uninstall', { serial, pkg }),
  disableApp: (serial, pkg) => ipcRenderer.invoke('apps:disable', { serial, pkg }),
  enableApp: (serial, pkg) => ipcRenderer.invoke('apps:enable', { serial, pkg }),

  // mirroring
  launchScrcpy: (serial) => ipcRenderer.invoke('scrcpy:launch', serial),

  // fastboot
  fastbootDevices: () => ipcRenderer.invoke('fastboot:devices'),
  fastbootUnlock: (serial) => ipcRenderer.invoke('fastboot:unlock', serial),

  // first-run setup progress (adb/fastboot/scrcpy download)
  onSetupProgress: (callback) => ipcRenderer.on('setup:progress', (_e, payload) => callback(payload)),

  // window chrome
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),
});

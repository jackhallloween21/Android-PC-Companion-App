const state = {
  devices: [],
  selected: null,
  activeView: 'dashboard',
  selectedFile: null, // { name, fullPath }
  selectedApp: null,
  mirror: { maxSize: '1920', bitrate: 8, maxFps: '60' },
  rotation: 0,
};

const el = (id) => document.getElementById(id);
const qAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// -------------------------------------------------------------- first-run setup

window.api.onSetupProgress(({ step, status, progress, message }) => {
  const line = el('setup-line');
  const bar = el('setup-bar');
  const errorEl = el('setup-error');

  if (status === 'checking') line.textContent = `Checking for ${step}…`;
  if (status === 'downloading') {
    line.textContent = `Downloading ${step === 'adb' ? 'Android platform-tools' : 'scrcpy'}…`;
    bar.style.width = `${Math.round((progress || 0) * 100)}%`;
  }
  if (status === 'done') bar.style.width = '100%';
  if (status === 'error') {
    errorEl.textContent = `${step}: ${message}`;
    errorEl.classList.remove('hidden');
  }
  if (status === 'ready') {
    el('setup-overlay').classList.add('hidden');
    el('shell').classList.remove('hidden');
    refreshDevices();
  }
});

// --------------------------------------------------------------- titlebar

el('min-btn').onclick = () => window.api.minimize();
el('max-btn').onclick = () => window.api.maximize();
el('close-btn').onclick = () => window.api.close();

// ------------------------------------------------------------------ nav

qAll('.nav-item[data-view]').forEach((btn) => (btn.onclick = () => setView(btn.dataset.view)));
qAll('.launcher[data-view]').forEach((btn) => (btn.onclick = () => setView(btn.dataset.view)));
el('tools-nav-btn').onclick = () => openToolsModal();

function setView(view) {
  state.activeView = view;
  qAll('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  qAll('.view').forEach((v) => v.classList.add('hidden'));
  el(`view-${view}`).classList.remove('hidden');
  refreshView(view);
}

function refreshView(view) {
  if (!state.selected) return;
  if (view === 'dashboard') loadDashboard();
  if (view === 'files') loadFiles();
  if (view === 'apps') loadApps();
  if (view === 'hardware') loadHardware();
  if (view === 'multimedia') refreshAudioStatus();
}

// -------------------------------------------------------------- device modal

el('device-picker-btn').onclick = () => el('device-modal').classList.remove('hidden');
el('device-modal-close').onclick = () => el('device-modal').classList.add('hidden');

async function refreshDevices() {
  const devices = await window.api.listDevices();
  state.devices = devices;
  renderDeviceList();
  updateTitlebarStatus();
}

function renderDeviceList() {
  const list = el('device-list');
  list.innerHTML = '';
  if (!state.devices.length) {
    list.innerHTML = '<div class="empty-devices">No devices found. Plug in a phone with USB debugging enabled, or pair one wirelessly.</div>';
    return;
  }
  state.devices.forEach((d) => {
    const chip = document.createElement('div');
    chip.className = 'device-chip' + (state.selected === d.serial ? ' selected' : '');
    chip.innerHTML = `
      <div class="row">
        <span class="status-dot ${d.state === 'device' ? 'online' : ''}"></span>
        <span class="model">${d.model ? d.model.replace(/_/g, ' ') : d.state}</span>
      </div>
      <div class="serial">${d.serial}</div>
    `;
    chip.onclick = () => selectDevice(d.serial);
    list.appendChild(chip);
  });
}

function selectDevice(serial) {
  state.selected = serial;
  renderDeviceList();
  updateTitlebarStatus();
  el('device-modal').classList.add('hidden');
  el('empty-state').classList.add('hidden');
  el('dashboard-grid').classList.remove('hidden');
  setView(state.activeView);
}

function updateTitlebarStatus() {
  const dot = el('status-dot');
  const label = el('status-device');
  const device = state.devices.find((d) => d.serial === state.selected);
  if (device) {
    label.textContent = `${device.model ? device.model.replace(/_/g, ' ') : device.serial}`;
    dot.classList.toggle('online', device.state === 'device');
  } else {
    label.textContent = 'No device';
    dot.classList.remove('online');
  }
}

// -------------------------------------------------------------------- dashboard

async function loadDashboard() {
  const serial = state.selected;
  const [info, battery, perf, hw, storage] = await Promise.all([
    window.api.getDeviceInfo(serial),
    window.api.getBattery(serial),
    window.api.getPerformance(serial),
    window.api.getHardware(serial),
    window.api.getStorageBreakdown(serial),
  ]);

  el('dash-model').textContent = info['ro.product.model'] || serial;
  el('dash-serial').textContent = `SN: ${serial}`;
  el('dash-android').textContent = `Android ${info['ro.build.version.release'] || '?'} (API ${info['ro.build.version.sdk'] || '?'})`;
  el('dash-ip').textContent = info.ip ? `${info.ip}` : '';

  const infoGrid = el('dash-info-grid');
  infoGrid.innerHTML = '';
  const rows = [
    ['Manufacturer', info['ro.product.manufacturer']],
    ['Bootloader', info.bootloaderLocked === '1' ? 'Locked' : info.bootloaderLocked === '0' ? 'Unlocked' : 'Unknown'],
    ['Security patch', info['ro.build.version.security_patch']],
    ['CPU ABI', info['ro.product.cpu.abi']],
  ];
  rows.forEach(([k, v]) => {
    const cell = document.createElement('div');
    cell.className = 'data-cell';
    cell.innerHTML = `<span class="k">${k}</span><span class="v">${v || '—'}</span>`;
    infoGrid.appendChild(cell);
  });

  const level = Number(battery.level || 0);
  el('battery-ring').style.setProperty('--pct', level);
  el('battery-pct').textContent = `${level}%`;
  el('dash-batt-status').textContent = /2|charg/i.test(battery.status || '') ? 'Charging' : 'On battery';
  el('dash-health').textContent = battery.health || '—';
  el('dash-cycles').textContent = battery['cycle count'] || 'N/A';
  el('dash-temp').textContent = battery.temperature ? `${(Number(battery.temperature) / 10).toFixed(1)}°C` : '—';
  el('dash-voltage').textContent = battery.voltage ? `${(Number(battery.voltage) / 1000).toFixed(2)} V` : '—';

  el('dash-procs').textContent = perf.processCount ? `${perf.processCount} processes` : '';
  el('dash-load').textContent = perf.loadavg || '—';
  const usedGb = Number(hw.ramUsedGb || 0);
  const totalGb = Number(hw.ramTotalGb || 0);
  el('dash-mem').textContent = totalGb ? `${usedGb} / ${totalGb} GB` : '—';
  el('mem-bar').style.width = totalGb ? `${Math.min(100, (usedGb / totalGb) * 100)}%` : '0%';

  const storeUsed = Number(hw.storageUsedGb || 0);
  const storeTotal = Number(hw.storageTotalGb || 0);
  el('dash-storage-total').textContent = storeTotal ? `${storeUsed} / ${storeTotal} GB` : '';
  el('storage-bar').style.width = storeTotal ? `${Math.min(100, (storeUsed / storeTotal) * 100)}%` : '0%';

  const breakdownGrid = el('storage-breakdown-grid');
  breakdownGrid.innerHTML = '';
  Object.entries(storage).forEach(([k, v]) => {
    const cell = document.createElement('div');
    cell.className = 'data-cell';
    cell.innerHTML = `<span class="k">${k}</span><span class="v">${v || '—'}</span>`;
    breakdownGrid.appendChild(cell);
  });
}

// ---------------------------------------------------------------- hardware view

async function loadHardware() {
  const serial = state.selected;
  const [battery, hw, info] = await Promise.all([
    window.api.getBattery(serial),
    window.api.getHardware(serial),
    window.api.getDeviceInfo(serial),
  ]);
  el('hw-batt-status').textContent = /2|charg/i.test(battery.status || '') ? 'Charging' : 'On battery';
  el('hw-level').textContent = battery.level ? `${battery.level}%` : '—';
  el('hw-health').textContent = battery.health || '—';
  el('hw-cycles').textContent = battery['cycle count'] || 'N/A';
  el('hw-voltage').textContent = battery.voltage ? `${(Number(battery.voltage) / 1000).toFixed(2)} V` : '—';
  el('hw-temp').textContent = battery.temperature ? `${(Number(battery.temperature) / 10).toFixed(1)}°C` : '—';
  el('hw-tech').textContent = battery.technology || '—';

  el('hw-chipset').textContent = info['ro.board.platform'] || info['ro.hardware'] || '—';
  el('hw-display').textContent = hw.resolution ? `${hw.resolution} @ ${hw.density || '?'} dpi` : '—';
  el('hw-ram').textContent = hw.ramTotalGb ? `${hw.ramTotalGb} GB` : '—';
  el('hw-storage').textContent = hw.storageTotalGb ? `${hw.storageTotalGb} GB total` : '—';
  el('hw-android').textContent = info['ro.build.version.release'] || '—';
  el('hw-secpatch').textContent = info['ro.build.version.security_patch'] || '—';
}

// ----------------------------------------------------------------------- files

qAll('#file-category-tabs .chip-tab').forEach((tab) => {
  tab.onclick = () => {
    qAll('#file-category-tabs .chip-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    el('remote-path').value = tab.dataset.path;
    loadFiles();
  };
});

el('list-files-btn').onclick = loadFiles;
el('push-file-btn').onclick = async () => {
  await window.api.pushFile(state.selected, el('remote-path').value);
  loadFiles();
};

async function loadFiles() {
  const remotePath = el('remote-path').value;
  const container = el('file-list');
  container.innerHTML = '<span class="muted">Listing…</span>';
  try {
    const lines = await window.api.listFiles(state.selected, remotePath);
    container.innerHTML = '';
    lines.forEach((line) => {
      const cols = line.split(/\s+/);
      const name = cols.slice(8).join(' ') || line;
      if (!name || name === '.' || name === '..') return;
      const size = cols[4] || '';
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `<span class="name" title="${line}">${name}</span><span class="meta">${size}</span>`;
      const fullPath = remotePath.replace(/\/?$/, '/') + name;
      row.onclick = () => selectFile(name, fullPath);
      container.appendChild(row);
    });
    if (!container.children.length) container.innerHTML = '<span class="muted">Empty or inaccessible folder.</span>';
  } catch (err) {
    container.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

async function selectFile(name, fullPath) {
  state.selectedFile = { name, fullPath };
  qAll('#file-list .list-row').forEach((r) => r.classList.remove('selected'));
  el('file-inspector-empty').classList.add('hidden');
  el('file-inspector-body').classList.remove('hidden');
  el('fi-name').textContent = name;
  el('fi-path').textContent = fullPath;

  const img = el('file-preview-img');
  img.classList.add('hidden');
  try {
    const dataUrl = await window.api.previewFile(state.selected, fullPath);
    if (dataUrl) {
      img.src = dataUrl;
      img.classList.remove('hidden');
    }
  } catch { /* not an image or unreadable — skip preview */ }
}

el('fi-pull-btn').onclick = () => state.selectedFile && window.api.pullFile(state.selected, state.selectedFile.fullPath);
el('fi-delete-btn').onclick = async () => {
  if (!state.selectedFile) return;
  if (confirm(`Delete ${state.selectedFile.fullPath} from the device?`)) {
    await window.api.deleteFile(state.selected, state.selectedFile.fullPath);
    el('file-inspector-body').classList.add('hidden');
    el('file-inspector-empty').classList.remove('hidden');
    loadFiles();
  }
};

// ------------------------------------------------------------------------ apps

let appFilter = 'all';
let appSearch = '';
let allApps = [];

qAll('#app-category-tabs .chip-tab').forEach((tab) => {
  tab.onclick = () => {
    qAll('#app-category-tabs .chip-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    appFilter = tab.dataset.filter;
    renderApps();
  };
});
el('app-search').oninput = (e) => { appSearch = e.target.value.toLowerCase(); renderApps(); };
el('install-apk-btn').onclick = async () => { await window.api.installApk(state.selected); loadApps(); };

async function loadApps() {
  const container = el('app-list');
  container.innerHTML = '<span class="muted">Loading…</span>';
  try {
    allApps = await window.api.listAppsDetailed(state.selected);
    renderApps();
  } catch (err) {
    container.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

function renderApps() {
  const container = el('app-list');
  const filtered = allApps.filter((a) => {
    if (appFilter === 'user' && a.type !== 'user') return false;
    if (appFilter === 'system' && a.type !== 'system') return false;
    if (appFilter === 'disabled' && a.status !== 'disabled') return false;
    if (appSearch && !a.pkg.toLowerCase().includes(appSearch)) return false;
    return true;
  });
  container.innerHTML = '';
  filtered.forEach((app) => {
    const row = document.createElement('div');
    row.className = 'list-row';
    row.innerHTML = `<span class="name">${app.pkg}</span><span class="meta">${app.type} · ${app.status}</span>`;
    row.onclick = () => selectApp(app);
    container.appendChild(row);
  });
  if (!filtered.length) container.innerHTML = '<span class="muted">No apps match.</span>';
}

async function selectApp(app) {
  state.selectedApp = app;
  qAll('#app-list .list-row').forEach((r) => r.classList.remove('selected'));
  el('app-inspector-empty').classList.add('hidden');
  el('app-inspector-body').classList.remove('hidden');
  el('ai-pkg').textContent = app.pkg;
  el('ai-size').textContent = 'Loading…';
  el('ai-permissions').innerHTML = '';

  const detail = await window.api.getAppDetail(state.selected, app.pkg);
  el('ai-size').textContent = detail.sizeBytes ? `${(detail.sizeBytes / 1048576).toFixed(1)} MB` : 'Unknown';
  el('ai-permissions').innerHTML = detail.permissions.length
    ? detail.permissions.map((p) => `<div>✓ ${p.replace('android.permission.', '')}</div>`).join('')
    : '<div class="muted">No declared permissions found.</div>';
}

el('ai-clear-btn').onclick = () => state.selectedApp && window.api.clearAppData(state.selected, state.selectedApp.pkg);
el('ai-disable-btn').onclick = () => state.selectedApp && window.api.disableApp(state.selected, state.selectedApp.pkg).then(loadApps);
el('ai-enable-btn').onclick = () => state.selectedApp && window.api.enableApp(state.selected, state.selectedApp.pkg).then(loadApps);
el('ai-uninstall-btn').onclick = async () => {
  if (!state.selectedApp) return;
  if (confirm(`Uninstall ${state.selectedApp.pkg}?`)) {
    await window.api.uninstallApp(state.selected, state.selectedApp.pkg);
    loadApps();
  }
};

// ---------------------------------------------------------------------- mirror

qAll('#res-options .chip-tab').forEach((tab) => {
  tab.onclick = () => {
    qAll('#res-options .chip-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.mirror.maxSize = tab.dataset.value;
  };
});
qAll('#fps-options .chip-tab').forEach((tab) => {
  tab.onclick = () => {
    qAll('#fps-options .chip-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.mirror.maxFps = tab.dataset.value;
  };
});
el('bitrate-slider').oninput = (e) => {
  state.mirror.bitrate = e.target.value;
  el('bitrate-value').textContent = e.target.value;
};

el('launch-scrcpy').onclick = () => {
  if (!state.selected) return;
  window.api.launchScrcpy(state.selected, {
    maxSize: state.mirror.maxSize,
    bitrate: state.mirror.bitrate,
    maxFps: state.mirror.maxFps,
    stayAwake: el('opt-stay-awake').checked,
    turnScreenOff: el('opt-screen-off').checked,
    showTouches: el('opt-show-touches').checked,
    forwardAudio: el('opt-audio').checked,
  });
};

el('ctrl-vol-up').onclick = () => state.selected && window.api.volumeUp(state.selected);
el('ctrl-vol-down').onclick = () => state.selected && window.api.volumeDown(state.selected);
el('ctrl-power').onclick = () => {
  if (state.selected && confirm('Send a long power-button press to the device?')) window.api.powerLongPress(state.selected);
};
el('ctrl-rotate').onclick = () => {
  if (!state.selected) return;
  state.rotation = (state.rotation + 1) % 4;
  window.api.rotate(state.selected, state.rotation);
};
el('ctrl-screenshot').onclick = () => state.selected && window.api.screenshot(state.selected);

let recording = false;
el('ctrl-record').onclick = async () => {
  if (!state.selected) return;
  if (!recording) {
    await window.api.recordStart(state.selected);
    recording = true;
    el('ctrl-record').textContent = 'Stop & save';
    el('record-status').textContent = 'Recording…';
  } else {
    const saved = await window.api.recordStop(state.selected);
    recording = false;
    el('ctrl-record').textContent = 'Record';
    el('record-status').textContent = saved ? `Saved: ${saved}` : '';
  }
};

// ---------------------------------------------------------------------- console

const consoleLog = el('console-log');
function appendConsole(text, cls) {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  consoleLog.appendChild(line);
  consoleLog.scrollTop = consoleLog.scrollHeight;
}

async function runConsoleCommand(command) {
  if (!state.selected) { appendConsole('No device selected.', 'err-line'); return; }
  appendConsole(`$ ${command}`, 'cmd-line');
  try {
    const out = await window.api.runConsole(state.selected, command);
    if (out) appendConsole(out.trim());
  } catch (err) {
    appendConsole(err.message, 'err-line');
  }
}

el('console-run-btn').onclick = () => {
  const cmd = el('console-input').value;
  if (!cmd.trim()) return;
  runConsoleCommand(cmd);
  el('console-input').value = '';
};
el('console-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('console-run-btn').click();
});
qAll('.quick-cmd').forEach((btn) => (btn.onclick = () => runConsoleCommand(btn.dataset.cmd)));

// ------------------------------------------------------------------- multimedia

qAll('.chip-tab[data-mm]').forEach((tab) => {
  tab.onclick = () => {
    qAll('.chip-tab[data-mm]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    el('mm-webcam').classList.toggle('hidden', tab.dataset.mm !== 'webcam');
    el('mm-audio').classList.toggle('hidden', tab.dataset.mm !== 'audio');
    if (tab.dataset.mm === 'audio') refreshAudioStatus();
  };
});

el('launch-camera-btn').onclick = () => {
  if (!state.selected) return;
  window.api.launchCameraPreview(state.selected, el('camera-facing').value);
};

let nowPlayingTimer = null;

async function refreshAudioStatus() {
  const forwarding = await window.api.audioStatus();
  el('audio-status').textContent = forwarding ? 'Forwarding device audio to PC speakers.' : 'Not forwarding.';
  clearInterval(nowPlayingTimer);
  if (state.activeView === 'multimedia') {
    pollNowPlaying();
    nowPlayingTimer = setInterval(pollNowPlaying, 4000);
  }
}

async function pollNowPlaying() {
  if (!state.selected) return;
  try {
    const { description } = await window.api.nowPlaying(state.selected);
    el('now-playing').textContent = description || 'No active media session detected.';
  } catch { el('now-playing').textContent = ''; }
}

el('audio-start-btn').onclick = async () => { if (state.selected) { await window.api.startAudio(state.selected); refreshAudioStatus(); } };
el('audio-stop-btn').onclick = async () => { await window.api.stopAudio(); refreshAudioStatus(); };
el('media-prev-btn').onclick = () => state.selected && window.api.mediaKey(state.selected, 'previous');
el('media-playpause-btn').onclick = () => state.selected && window.api.mediaKey(state.selected, 'playPause');
el('media-next-btn').onclick = () => state.selected && window.api.mediaKey(state.selected, 'next');

// ---------------------------------------------------------------- bootloader

qAll('.chip-tab[data-bl]').forEach((tab) => {
  tab.onclick = () => {
    qAll('.chip-tab[data-bl]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    el('bl-unlock').classList.toggle('hidden', tab.dataset.bl !== 'unlock');
    el('bl-backup').classList.toggle('hidden', tab.dataset.bl !== 'backup');
  };
});

el('reboot-bootloader-btn').onclick = async () => {
  el('bootloader-output').textContent = await window.api.rebootBootloader(state.selected).catch((e) => e.message);
};
el('unlock-btn').onclick = async () => {
  if (!confirm('This will FACTORY RESET the device and may void warranty. Continue?')) return;
  const out = el('bootloader-output');
  out.textContent = 'Unlocking…';
  try { out.textContent = await window.api.fastbootUnlock(state.selected); }
  catch (err) { out.textContent = err.message; }
};

let flashImagePath = null;
el('choose-flash-img-btn').onclick = async () => {
  const result = await window.api.chooseFlashImage();
  if (result?.filePath) {
    flashImagePath = result.filePath;
    el('flash-img-path').textContent = flashImagePath;
  }
};
el('flash-btn').onclick = async () => {
  if (!flashImagePath) { alert('Choose an .img file first.'); return; }
  const partition = el('flash-partition').value;
  if (!confirm(`Flash ${flashImagePath} to the "${partition}" partition? This can brick the device if the image is wrong.`)) return;
  const out = el('bootloader-output');
  out.textContent = 'Flashing…';
  try { out.textContent = await window.api.flashPartition(state.selected, partition, flashImagePath); }
  catch (err) { out.textContent = err.message; }
};

// ------------------------------------------------------------------- backup

let backupDest = null;
el('choose-dest-btn').onclick = async () => {
  const dir = await window.api.chooseBackupDestination();
  if (dir) { backupDest = dir; el('backup-dest').value = dir; }
};
window.api.onBackupProgress((line) => {
  const out = el('backup-output');
  out.textContent += (out.textContent ? '\n' : '') + line;
  out.scrollTop = out.scrollHeight;
});
el('run-backup-btn').onclick = async () => {
  if (!state.selected) return;
  if (!backupDest) { alert('Choose a destination folder first.'); return; }
  const categories = qAll('#bl-backup .checkbox-list input[type="checkbox"][value]').filter((c) => c.checked).map((c) => c.value);
  const includeApks = el('backup-apks').checked;
  el('backup-output').textContent = '';
  el('run-backup-btn').disabled = true;
  try { await window.api.runBackup(state.selected, categories, backupDest, includeApks); }
  catch (err) { el('backup-output').textContent += `\nError: ${err.message}`; }
  finally { el('run-backup-btn').disabled = false; }
};

// -------------------------------------------------------------- wireless pair

el('pair-btn').onclick = () => el('pair-modal').classList.remove('hidden');
el('pair-cancel-btn').onclick = () => el('pair-modal').classList.add('hidden');
el('pair-submit-btn').onclick = async () => {
  const host = el('pair-host').value.trim();
  const code = el('pair-code').value.trim();
  if (!host || !code) return;
  try {
    await window.api.pairWireless(host, code);
    el('pair-modal').classList.add('hidden');
    refreshDevices();
  } catch (err) { alert(err.message); }
};

// ------------------------------------------------------------------- tools modal

async function openToolsModal() {
  el('tools-modal').classList.remove('hidden');
  await loadToolsStatus();
}
el('tools-modal-close').onclick = () => el('tools-modal').classList.add('hidden');
el('tools-refresh-btn').onclick = loadToolsStatus;

async function loadToolsStatus() {
  const list = el('tools-list');
  list.innerHTML = '<span class="muted">Checking…</span>';
  const tools = await window.api.getToolsStatus();
  list.innerHTML = '';
  tools.forEach((t) => {
    const row = document.createElement('div');
    row.className = 'tool-row';
    row.innerHTML = `
      <div>
        <div class="name">${t.name}</div>
        <div class="meta">${t.version || 'unknown version'} · ${t.path}</div>
      </div>
      <span class="badge ${t.version ? 'badge-online' : ''}">${t.version ? 'ready' : 'not found'}</span>
    `;
    list.appendChild(row);
  });
}

// ----------------------------------------------------------------- startup

setInterval(() => {
  if (!el('shell').classList.contains('hidden')) refreshDevices();
}, 4000);

const state = {
  devices: [],
  selected: null,
  activeView: 'dashboard',
  selectedFile: null, // { name, fullPath }
  selectedApp: null,
  mirror: { maxSize: '1920', bitrate: 8, maxFps: '60', zoom: 1 },
  rotation: 0,
};

const el = (id) => document.getElementById(id);
const qAll = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// -------------------------------------------------------------- first-run setup

let setupFailed = false;

function enterShell() {
  el('setup-overlay').classList.add('hidden');
  el('shell').classList.remove('hidden');
  refreshDevices();
}

el('setup-continue').onclick = enterShell;

// If the preload script failed to load there is no window.api, every call below
// would throw, and the setup overlay would sit on "Checking for adb…" forever
// with no explanation. Say so instead of hanging.
if (!window.api) {
  const errorEl = el('setup-error');
  errorEl.textContent =
    'The app could not load its preload bridge, so it cannot talk to adb. ' +
    'Check the terminal running "npm start" for an "Unable to load preload script" error.';
  errorEl.classList.remove('hidden');
  el('setup-line').textContent = 'Startup failed.';
  el('setup-bar').style.width = '0%';
  throw new Error('preload bridge missing: window.api is undefined');
}

window.api.onSetupProgress(({ step, status, progress, message }) => {
  const line = el('setup-line');
  const bar = el('setup-bar');
  const errorEl = el('setup-error');

  if (status === 'checking') line.textContent = `Checking for ${step}…`;
  if (status === 'downloading') {
    line.textContent = `Downloading ${step === 'adb' ? 'Android platform-tools' : 'scrcpy'}…`;
    bar.style.width = `${Math.round((progress || 0) * 100)}%`;
  }
  if (status === 'done') {
    bar.style.width = '100%';
    line.textContent = message ? `${step}: ${message}` : `${step} ready`;
  }
  if (status === 'error') {
    // Don't silently swallow this: a failed scrcpy step is exactly why
    // mirroring appears to do nothing later on.
    setupFailed = true;
    errorEl.textContent = `${step} failed — ${message}`;
    errorEl.classList.remove('hidden');
    el('setup-continue').classList.remove('hidden');
  }
  if (status === 'ready' && !setupFailed) enterShell();
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
  if (view !== 'hardware') stopHardwarePolling();
  if (!state.selected) return;
  if (view === 'dashboard') loadDashboard();
  if (view === 'files') loadFiles();
  if (view === 'apps') loadApps();
  if (view === 'hardware') { loadHardware(); startHardwarePolling(); }
  if (view === 'multimedia') { refreshAudioStatus(); refreshBridge(); }
  if (view === 'mirror') showScrcpyBuild();
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

const fmt = (v, digits = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(digits));
const setText = (id, value) => { el(id).textContent = value; };

function formatEta(minutes, charging) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const span = h ? `${h}h ${m}m` : `${m}m`;
  return charging ? `~${span} to full` : `~${span} left`;
}

// dumpsys reports BatteryManager health constants numerically on some builds.
const HEALTH_NAMES = {
  1: 'Unknown', 2: 'Good', 3: 'Overheat', 4: 'Dead',
  5: 'Over voltage', 6: 'Unspecified failure', 7: 'Cold',
};

function healthLabel(power) {
  const raw = (power.health || '').trim();
  const name = HEALTH_NAMES[raw] || (raw && !/^\d+$/.test(raw) ? raw : null);
  if (power.healthPct !== null && power.healthPct !== undefined) {
    return { text: `${power.healthPct}%${name ? ` (${name})` : ''}`, pct: power.healthPct };
  }
  return { text: name || '—', pct: null };
}

let hardwareTimer = null;

async function loadHardware() {
  const serial = state.selected;
  if (!serial) return;

  const [power, hw, info, soc] = await Promise.all([
    window.api.getPower(serial).catch((e) => ({ error: e.message })),
    window.api.getHardware(serial).catch(() => ({})),
    window.api.getDeviceInfo(serial).catch(() => ({})),
    window.api.getSoc(serial).catch(() => ({})),
  ]);

  if (power.error) {
    setText('hw-source-note', `Could not read power telemetry: ${power.error}`);
    return;
  }

  // --- battery power station -------------------------------------------------
  const level = power.level ?? 0;
  const ring = el('hw-ring');
  ring.style.setProperty('--pct', level);
  ring.classList.toggle('critical', level <= 15);
  ring.classList.toggle('warn', level > 15 && level <= 35);

  setText('hw-level', power.level === null ? '—' : `${power.level}%`);
  setText('hw-eta', formatEta(power.minutesRemaining, power.charging));
  el('hw-ring-bolt').classList.toggle('hidden', !power.charging);

  const statusBadge = el('hw-batt-status');
  const plugged = (power.plugged || '').replace(/^BATTERY_PLUGGED_/, '');
  statusBadge.textContent = power.charging
    ? `Charging${plugged ? ` (${plugged})` : ''}`
    : 'On battery';
  statusBadge.classList.toggle('badge-online', power.charging);

  const health = healthLabel(power);
  const healthEl = el('hw-health');
  healthEl.textContent = health.text;
  healthEl.className = 'fact-value' + (
    health.pct === null ? '' : health.pct >= 85 ? ' good' : health.pct >= 70 ? ' warn' : ' bad'
  );

  setText('hw-capacity', power.chargeFullMah
    ? `${power.chargeFullMah} / ${power.chargeDesignMah || '?'} mAh`
    : (power.chargeDesignMah ? `${power.chargeDesignMah} mAh design` : '—'));

  setText('hw-cycles', power.cycleCount ?? 'Not exposed');
  setText('hw-tech', power.technology || '—');

  // --- electrical & thermal telemetry ---------------------------------------
  setText('hw-watts', fmt(power.watts, 2));
  setText('hw-voltage', fmt(power.voltage, 2));
  setText('hw-voltage-mv', power.voltageMv ? `${power.voltageMv} mV` : '');
  setText('hw-current', fmt(power.current, 2));
  setText('hw-current-ma', power.currentMa ? `${power.charging ? '+' : '−'}${power.currentMa} mA` : '');

  setText('hw-temp', fmt(power.batteryTemp, 1));
  setText('hw-temp-sub', power.batteryTemp === null
    ? ''
    : `${(power.batteryTemp * 9 / 5 + 32).toFixed(1)}°F · ${power.batteryTemp >= 43 ? 'Hot' : power.batteryTemp >= 38 ? 'Warm' : 'Normal'}`);

  setText('hw-soc-temp', fmt(power.socTemp, 1));
  setText('hw-soc-zone', power.socZone ? `zone: ${power.socZone}` : 'Not exposed');

  setText('hw-protocol', power.protocol || (power.charging ? 'USB (unreported)' : 'Not charging'));
  const inputBits = [
    power.inputVoltage ? `${fmt(power.inputVoltage, 1)} V` : null,
    power.inputCurrentLimit ? `${fmt(power.inputCurrentLimit, 2)} A limit` : null,
    power.typecMode || null,
  ].filter(Boolean);
  setText('hw-protocol-sub', inputBits.join(' · '));

  const rate = el('hw-rate');
  rate.textContent = power.watts ? `${power.watts >= 15 ? 'Fast charge' : 'Charging'} (${fmt(power.watts, 1)} W)` : '';
  rate.style.color = power.watts >= 15 ? 'var(--accent)' : 'var(--signal)';

  setText('hw-source-note', power.sysfsAvailable
    ? `Power measurements read directly from the Android kernel power-supply subsystem (${power.source}).`
    : 'Kernel power-supply nodes are not readable on this device — values fall back to "dumpsys battery", so current and wattage may be missing.');

  // --- processor & device specs --------------------------------------------
  setText('hw-chipset', soc.socName || info['ro.board.platform'] || '—');
  setText('hw-chipset-sub', [
    soc.clusterSummary,
    soc.coreCount ? `${soc.coreCount} cores` : null,
  ].filter(Boolean).join(' · '));

  setText('hw-display', hw.resolution ? `${hw.resolution} pixels` : '—');
  setText('hw-display-sub', hw.density ? `${hw.density} dpi` : '');

  setText('hw-ram', hw.ramTotalGb ? `${hw.ramTotalGb} GB` : '—');
  setText('hw-ram-sub', [
    soc.ddrType ? `DDR type ${soc.ddrType}` : null,
    hw.ramUsedGb ? `${hw.ramUsedGb} GB in use` : null,
  ].filter(Boolean).join(' · '));

  setText('hw-storage', hw.storageTotalGb ? `${hw.storageTotalGb} GB` : '—');
  setText('hw-storage-sub', [
    soc.storageModel,
    hw.storageUsedGb ? `${hw.storageUsedGb} GB used` : null,
  ].filter(Boolean).join(' · '));

  setText('hw-android', info['ro.build.version.release']
    ? `Android ${info['ro.build.version.release']} (API ${info['ro.build.version.sdk'] || '?'})`
    : '—');
  setText('hw-abi', soc.abi || info['ro.product.cpu.abi'] || '');

  setText('hw-secpatch', info['ro.build.version.security_patch'] || '—');
  setText('hw-bootloader', info.bootloaderLocked === '1'
    ? 'Bootloader locked'
    : info.bootloaderLocked === '0' ? 'Bootloader unlocked' : '');

  el('hw-updated').textContent = `updated ${new Date().toLocaleTimeString()}`;
}

// Telemetry is only meaningful live, so poll while the view is on screen and
// stop as soon as the user navigates away.
function startHardwarePolling() {
  stopHardwarePolling();
  hardwareTimer = setInterval(() => {
    if (state.activeView === 'hardware' && state.selected) loadHardware();
    else stopHardwarePolling();
  }, 3000);
}

function stopHardwarePolling() {
  if (hardwareTimer) { clearInterval(hardwareTimer); hardwareTimer = null; }
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

// Window size, as a fraction of the largest that fits the screen. Applied live
// when a session is already docked, so this doubles as a resize control for the
// borderless video window — which by design has no edges to drag.
qAll('#zoom-options .chip-tab').forEach((tab) => {
  tab.onclick = async () => {
    qAll('#zoom-options .chip-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    state.mirror.zoom = Number(tab.dataset.value);
    const { docked } = await window.api.dockState();
    if (!docked) return;
    try {
      const res = await window.api.setMirrorZoom(state.mirror.zoom);
      setMirrorStatus(res.relaunched
        ? `Resized to ${Math.round(res.zoom * 100)}% by restarting the stream.`
        : `Resized to ${Math.round(res.zoom * 100)}%.`, 'ok');
    } catch (err) { setMirrorStatus(cleanIpcError(err.message), 'err'); }
  };
});

// Reports which scrcpy the main process actually resolved — the single most
// useful thing to see when mirroring won't start. Also settles whether docking
// is even possible: a build with no --window-x cannot be positioned, so the
// checkbox is disabled rather than silently ignored.
async function showScrcpyBuild() {
  try {
    const info = await window.api.scrcpyInfo();
    el('scrcpy-build').textContent = info.version
      ? `${info.version} · ${info.path}`
      : `scrcpy not detected (looked at: ${info.path})`;
    const dock = el('opt-dock');
    if (info.version && info.canDock === false) {
      dock.checked = false;
      dock.disabled = true;
      dock.closest('.checkbox-row').title =
        `${info.version} has no --window-x/--window-y, so its window cannot be positioned.`;
    }
  } catch { el('scrcpy-build').textContent = ''; }
}

function setMirrorStatus(text, cls) {
  const node = el('mirror-status');
  node.textContent = text;
  node.className = `mono mirror-status${cls ? ` ${cls}` : ''}`;
}

el('launch-scrcpy').onclick = async () => {
  if (!state.selected) { setMirrorStatus('Select a device first.', 'err'); return; }
  const btn = el('launch-scrcpy');
  btn.disabled = true;
  setMirrorStatus('Starting scrcpy…', 'busy');
  try {
    const res = await window.api.launchScrcpy(state.selected, {
      maxSize: state.mirror.maxSize,
      bitrate: state.mirror.bitrate,
      maxFps: state.mirror.maxFps,
      stayAwake: el('opt-stay-awake').checked,
      turnScreenOff: el('opt-screen-off').checked,
      showTouches: el('opt-show-touches').checked,
      forwardAudio: el('opt-audio').checked,
      dock: el('opt-dock').checked,
      borderless: el('opt-borderless').checked,
      zoom: state.mirror.zoom,
    });
    if (res && res.docked) {
      setMirrorStatus(el('opt-borderless').checked
        ? 'Mirroring with a docked control bar. The video window is borderless, so resize it with − / + / Fit on the bar.'
        : 'Mirroring with a docked control bar. Drag or resize the video window freely, then press Re-dock to bring the bar back under it.', 'ok');
    } else {
      setMirrorStatus([
        'Mirror window running. Close that window to end the session.',
        res && res.note,
      ].filter(Boolean).join(' '), res && res.note ? 'busy' : 'ok');
    }
  } catch (err) {
    setMirrorStatus(cleanIpcError(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
};

el('stop-scrcpy').onclick = async () => {
  const stopped = await window.api.stopMirror();
  setMirrorStatus(stopped
    ? 'Mirroring stopped.'
    : 'No docked session to stop — close the scrcpy window itself.', stopped ? 'ok' : 'busy');
};

// Navigation and the notification shade. These go over adb, so they also work
// when mirroring is not running at all.
const navBtn = (id, action) => {
  el(id).onclick = async () => {
    if (!state.selected) { setMirrorStatus('Select a device first.', 'err'); return; }
    try { await window.api.navKey(state.selected, action); }
    catch (err) { setMirrorStatus(cleanIpcError(err.message), 'err'); }
  };
};
navBtn('ctrl-back', 'back');
navBtn('ctrl-home', 'home');
navBtn('ctrl-recents', 'recents');

// A second press collapses the panel, matching the gesture these replace.
let openShadePanel = null;
const shadeBtn = (id, panel) => {
  el(id).onclick = async () => {
    if (!state.selected) { setMirrorStatus('Select a device first.', 'err'); return; }
    const target = openShadePanel === panel ? 'collapse' : panel;
    try {
      await window.api.statusBar(state.selected, target);
      openShadePanel = target === 'collapse' ? null : panel;
    } catch (err) { setMirrorStatus(cleanIpcError(err.message), 'err'); }
  };
};
shadeBtn('ctrl-shade', 'notifications');
shadeBtn('ctrl-qs', 'quickSettings');

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
    else refreshBridge();
  };
});

const cleanIpcError = (msg) => msg.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

// ---- camera ----------------------------------------------------------------
// The lens list and both dropdowns are populated only from what the phone
// reports. Nothing is offered speculatively: asking scrcpy for a size the sensor
// does not list is a fatal error, not a downgrade.

const camera = { list: [], selected: null, mic: true, v4l2: false, bridge: null, limits: null };

function setCameraStatus(text, kind = '') {
  const node = el('camera-status');
  node.textContent = text || '';
  node.className = `mirror-status${kind ? ` ${kind}` : ''}`;
}

function renderLensList() {
  const box = el('camera-lens-list');
  box.innerHTML = '';
  if (!camera.list.length) {
    box.innerHTML = '<div class="muted" style="padding:10px 12px;">Not detected yet.</div>';
    return;
  }
  const labels = { back: 'Rear', front: 'Front', external: 'External' };
  camera.list.forEach((cam) => {
    const row = document.createElement('div');
    row.className = `list-row${camera.selected === cam.id ? ' selected' : ''}`;
    const mp = cam.megapixels ? `${cam.megapixels} MP` : '—';
    row.innerHTML = `<span>${labels[cam.facing] || cam.facing} camera</span>`
      + `<span class="muted mono">id ${cam.id} · ${mp} · ${cam.maxSize || '—'}</span>`;
    row.onclick = () => { camera.selected = cam.id; renderLensList(); renderSizeOptions(); };
    box.appendChild(row);
  });
}

function currentCamera() {
  return camera.list.find((c) => c.id === camera.selected) || camera.list[0] || null;
}

function renderSizeOptions() {
  const cam = currentCamera();
  const sizeSel = el('camera-size');
  const fpsSel = el('camera-fps');
  const highSpeed = el('camera-highspeed').checked;
  sizeSel.innerHTML = '<option value="">Sensor default</option>';
  fpsSel.innerHTML = '<option value="">Default fps</option>';
  el('camera-size-note').textContent = '';
  if (!cam) return;

  const sizes = highSpeed ? cam.highSpeedSizes : cam.sizes;
  let blocked = 0;
  for (const s of sizes) {
    const opt = document.createElement('option');
    opt.value = s.size;
    // A megapixel figure is more meaningful next to the raw size than alone.
    const mp = Math.round((s.width * s.height) / 100000) / 10;
    opt.textContent = `${s.size} (${mp} MP)${s.fps ? ` · fps ${s.fps.join('/')}` : ''}`;
    // The sensor genuinely offers these, so they are shown and disabled rather
    // than hidden: the phone's video encoder is what cannot compress them, and
    // silently dropping them would look like the app losing resolutions.
    if (s.encodable === false) {
      opt.disabled = true;
      opt.textContent += ' — too large for this phone\'s encoder';
      blocked += 1;
    }
    sizeSel.appendChild(opt);
  }
  if (!sizes.length) {
    sizeSel.innerHTML = `<option value="">${highSpeed ? 'No high-speed sizes on this lens' : 'No sizes reported'}</option>`;
  }
  const limit = camera.limits && camera.limits.maxWidth
    ? `Hardware encoder limit: ${camera.limits.maxWidth}x${camera.limits.maxHeight}.` : '';
  el('camera-size-note').textContent = blocked
    ? `${limit} ${blocked} size${blocked === 1 ? '' : 's'} the sensor offers cannot be encoded, so ${blocked === 1 ? 'it is' : 'they are'} greyed out.`
    : limit;
  for (const f of cam.fps || []) {
    const opt = document.createElement('option');
    opt.value = String(f);
    opt.textContent = `${f} fps`;
    fpsSel.appendChild(opt);
  }
  el('camera-mic').disabled = !camera.mic;
  el('camera-highspeed').disabled = !cam.highSpeedSizes.length && !highSpeed;
}

el('camera-highspeed').onchange = renderSizeOptions;

el('camera-refresh-btn').onclick = async () => {
  if (!state.selected) { el('camera-detect-status').textContent = 'Select a device first.'; return; }
  const btn = el('camera-refresh-btn');
  btn.disabled = true;
  el('camera-detect-status').textContent = 'Asking scrcpy what this phone offers…';
  try {
    const res = await window.api.listCameras(state.selected);
    camera.list = res.cameras;
    camera.mic = res.mic;
    camera.v4l2 = res.v4l2;
    camera.limits = res.limits || null;
    camera.selected = res.cameras[0] ? res.cameras[0].id : null;
    el('camera-detect-status').textContent =
      `${res.cameras.length} camera${res.cameras.length === 1 ? '' : 's'} reported.`;
    renderLensList();
    renderSizeOptions();
  } catch (err) {
    el('camera-detect-status').textContent = cleanIpcError(err.message);
  } finally {
    btn.disabled = false;
  }
};

el('camera-start-btn').onclick = async () => {
  if (!state.selected) return;
  const cam = currentCamera();
  const btn = el('camera-start-btn');
  btn.disabled = true;
  setCameraStatus('Starting the camera stream…', 'busy');
  try {
    const opts = {
      serial: state.selected,
      cameraId: cam ? cam.id : undefined,
      size: el('camera-size').value || undefined,
      fps: el('camera-fps').value ? Number(el('camera-fps').value) : undefined,
      highSpeed: el('camera-highspeed').checked,
      mic: el('camera-mic').checked,
    };
    // Only on Linux with a loopback device does a real virtual camera exist; the
    // sink is passed only then, because the flag is otherwise absent or useless.
    if (camera.bridge && camera.bridge.mode === 'v4l2' && camera.bridge.ready) {
      opts.v4l2Device = camera.bridge.devices[0];
    }
    await window.api.startCamera(opts);
    el('camera-state').textContent = 'Streaming';
    setCameraStatus(opts.v4l2Device
      ? `Streaming into ${opts.v4l2Device} — other apps can select it as a camera.`
      : 'Streaming to a preview window.', 'ok');
  } catch (err) {
    el('camera-state').textContent = 'Standby';
    setCameraStatus(cleanIpcError(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
};

el('camera-stop-btn').onclick = async () => {
  await window.api.stopCamera();
  el('camera-state').textContent = 'Standby';
  setCameraStatus('Camera stream stopped.');
};

el('torch-btn').onclick = async () => {
  if (!state.selected) return;
  const btn = el('torch-btn');
  btn.disabled = true;
  try {
    const res = await window.api.toggleTorch(state.selected);
    // Only claim a state the camera service actually confirmed. The tile click is
    // a toggle that reports nothing, so without read-back the honest message is
    // "clicked", not "on".
    setCameraStatus(res && res.state
      ? `Flashlight is ${res.state}.`
      : 'Flashlight tile clicked — this phone does not report torch state, so check the light itself.', 'ok');
  } catch (err) {
    setCameraStatus(cleanIpcError(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
};

async function refreshBridge() {
  try {
    const bridge = await window.api.cameraBridge();
    camera.bridge = bridge;
    el('bridge-badge').textContent = bridge.ready ? bridge.label : `Virtual camera: ${bridge.label}`;
    el('bridge-label').textContent = `Virtual camera: ${bridge.label}`;
    el('bridge-hint').textContent = bridge.hint;
  } catch {
    el('bridge-badge').textContent = 'Virtual camera: unknown';
    el('bridge-label').textContent = 'Virtual camera: could not be checked';
    el('bridge-hint').textContent = '';
  }
  const st = await window.api.cameraStatus().catch(() => null);
  if (st) el('camera-state').textContent = st.running ? 'Streaming' : 'Standby';
}

// ---- audio + now playing ---------------------------------------------------

let nowPlayingTimer = null;

async function refreshAudioStatus() {
  const forwarding = await window.api.audioStatus();
  el('audio-status').textContent = forwarding ? 'Forwarding device audio to PC speakers.' : 'Not forwarding.';
  clearInterval(nowPlayingTimer);
  if (state.activeView === 'multimedia') {
    pollNowPlaying();
    nowPlayingTimer = setInterval(pollNowPlaying, 4000);
  } else {
    clearInterval(np.timer);
  }
}

/**
 * Absent fields stay as an em dash — the phone not reporting one is information.
 *
 * The seek bar is the honest-reporting case that matters here: `dumpsys
 * media_session` prints the playback position but usually not the track length,
 * so there is often no percentage to draw. Rather than leave an empty track that
 * looks broken, the bar is hidden and the reason is said out loud. Album art is
 * never in the dump at all (it is a bitmap held in the app's process), so there is
 * no artwork slot to fill.
 */
function renderNowPlaying(track, sessions, readAt) {
  const dash = '—';
  const set = (id, value) => { el(id).textContent = value || dash; };
  np.track = track || null;
  np.readAt = readAt || Date.now();
  set('np-title', track && track.title);
  set('np-artist', track && track.artist);
  set('np-album', track && track.album);
  set('np-app', track && track.app);
  set('np-state', track && track.stateLabel);
  tickNowPlaying();

  // Transport buttons follow the session's advertised actions, so a button that
  // the app would ignore is visibly disabled rather than silently inert.
  const actions = track && track.actions;
  el('media-prev-btn').disabled = !!actions && !actions.previous;
  el('media-next-btn').disabled = !!actions && !actions.next;
  el('media-playpause-btn').disabled = !!actions && !actions.play && !actions.pause;

  el('now-playing').textContent = track
    ? `${sessions} media session${sessions === 1 ? '' : 's'} on the device.`
    : 'No active media session detected.';
}

// The last dump plus when it was read: enough to advance the clock locally.
const np = { track: null, readAt: 0, timer: null };

/** mm:ss, with an hours field only when the track needs one. */
function clock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const h = Math.floor(total / 3600);
  return h
    ? `${h}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`
    : `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/**
 * Advances the displayed position between polls.
 *
 * The dump's `position` is a snapshot, so a bar driven only by polling jumps in
 * four-second steps. Multiplying elapsed wall time by the session's reported
 * speed reproduces what the notification shows, and only while it says it is
 * playing — a paused track must not creep forward.
 */
function tickNowPlaying() {
  const t = np.track;
  const barRow = el('np-bar-row');
  if (!t || t.positionMs === null) {
    el('np-position').textContent = '—';
    el('np-duration').textContent = '—';
    el('np-progress').style.width = '0%';
    barRow.style.display = '';
    el('np-bar-note').textContent = '';
    return;
  }

  const speed = t.playing ? (Number.isFinite(t.speed) && t.speed !== 0 ? t.speed : 1) : 0;
  const elapsed = Math.max(0, Date.now() - np.readAt) * speed;
  const position = t.durationMs
    ? Math.min(t.durationMs, t.positionMs + elapsed)
    : t.positionMs + elapsed;

  el('np-position').textContent = clock(position) || '—';
  if (t.durationMs) {
    barRow.style.display = '';
    el('np-duration').textContent = clock(t.durationMs) || '—';
    el('np-progress').style.width = `${Math.round((position / t.durationMs) * 100)}%`;
    el('np-bar-note').textContent = '';
  } else {
    // No length in the dump means no percentage exists to draw.
    barRow.style.display = 'none';
    el('np-bar-note').textContent = `Elapsed ${clock(position)} — this app does not publish the track length over adb, so there is no seek bar to fill.`;
  }
}

async function pollNowPlaying() {
  if (!state.selected) return;
  try {
    const res = await window.api.nowPlaying(state.selected);
    renderNowPlaying(res.track, res.sessions, res.readAt);
  } catch {
    renderNowPlaying(null, 0, Date.now());
  }
  // A 1 s local tick between 4 s polls, so the elapsed time counts instead of
  // stepping. Cleared and restarted with each poll to avoid stacking timers.
  clearInterval(np.timer);
  np.timer = setInterval(tickNowPlaying, 1000);
}

el('np-refresh-btn').onclick = pollNowPlaying;

el('audio-start-btn').onclick = async () => {
  if (!state.selected) return;
  el('audio-status').textContent = 'Starting…';
  try {
    await window.api.startAudio(state.selected);
  } catch (err) {
    el('audio-status').textContent = cleanIpcError(err.message);
    return;
  }
  refreshAudioStatus();
};

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

function setPairStatus(text, cls) {
  const node = el('pair-status');
  node.textContent = text || '';
  node.className = `mirror-status${cls ? ` ${cls}` : ''}`;
}

el('pair-btn').onclick = () => {
  setPairStatus('');
  el('pair-modal').classList.remove('hidden');
};
el('pair-cancel-btn').onclick = () => el('pair-modal').classList.add('hidden');
el('pair-submit-btn').onclick = async () => {
  const host = el('pair-host').value.trim();
  const code = el('pair-code').value.trim();
  const connectPort = el('pair-connect-port').value.trim();
  // A device that is already paired only needs the connect step, and re-running
  // `adb pair` with a spent single-use code would just fail. So a port with no code
  // means "connect only" — that is the way out of "paired but not reachable".
  const connectOnly = !code && !!connectPort;
  if (!host) {
    setPairStatus('Enter the phone\'s host:port.', 'err');
    return;
  }
  if (!code && !connectPort) {
    setPairStatus('Enter the pairing code — or, if this phone is already paired, '
      + 'just its connect port.', 'err');
    return;
  }

  const btn = el('pair-submit-btn');
  btn.disabled = true;
  setPairStatus(connectOnly ? 'Connecting…' : 'Pairing, then connecting…', 'busy');
  try {
    if (connectOnly) {
      // The host field may already carry the pairing port; the connect port is a
      // different one, so drop any port that is already there. A bare IPv6 literal
      // has to be bracketed or adb cannot tell the address from the port.
      const bare = host.replace(/^adb:\/\//, '');
      const hostOnly = /^[0-9a-f]*:[0-9a-f:]+$/i.test(bare)
        ? `[${bare}]`
        : bare.replace(/^(\[[^\]]+\]|[^:]+):\d+$/, '$1');
      // The modal stays open on success: this is the recovery path out of "paired but
      // not reachable", and hiding the only place the result is shown would leave the
      // user guessing whether it worked.
      setPairStatus(await window.api.connectWireless(`${hostOnly}:${connectPort}`), 'ok');
      refreshDevices();
      return;
    }
    const res = await window.api.pairWireless(host, code, connectPort);
    if (res && res.connected) {
      setPairStatus(res.message, 'ok');
      el('pair-modal').classList.add('hidden');
    } else {
      setPairStatus(res ? res.message : 'Paired, but the connect step did not run.', 'err');
    }
    refreshDevices();
  } catch (err) {
    setPairStatus(cleanIpcError(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
};

// ---- QR pairing ------------------------------------------------------------
//
// The direction is: this PC displays the code, the phone's "Pair device with QR
// code" screen scans it. Android never shows a pairing QR of its own, so there
// is nothing here for a webcam to read.

const QR_QUIET = 4; // quiet zone in modules; 4 is the spec minimum
const QR_TARGET_PX = 320; // the canvas is sized down to a whole number of modules

el('pair-scan-qr-btn').onclick = () => {
  setPairStatus('');
  el('pair-modal').classList.add('hidden');
  el('qr-modal').classList.remove('hidden');
  startQrPairing();
};

el('qr-modal-close').onclick = () => closeQrPairing();

function drawQrMatrix(canvas, size, modules) {
  const total = size + QR_QUIET * 2;
  // Integer module size keeps every module the same width; a fractional scale is
  // what makes a rendered QR unreadable at small sizes.
  const scale = Math.max(2, Math.floor(QR_TARGET_PX / total));
  const dim = total * scale;
  canvas.width = dim;
  canvas.height = dim;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // the quiet zone has to be light even in a dark UI
  ctx.fillRect(0, 0, dim, dim);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) {
        ctx.fillRect((x + QR_QUIET) * scale, (y + QR_QUIET) * scale, scale, scale);
      }
    }
  }
}

async function startQrPairing() {
  const status = el('qr-status');
  const codeText = el('qr-code-text');
  const canvas = el('qr-canvas');
  status.textContent = 'Generating code…';
  status.classList.remove('danger-text');
  codeText.classList.add('hidden');
  // Wipe the previous session's code. Leaving it up means the user can scan a
  // code whose service name main is no longer watching for — and if this session
  // fails to start, the dead code sits there under the error message.
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);

  try {
    const qr = await window.api.startQrPairing();
    drawQrMatrix(canvas, qr.size, qr.modules);
    status.textContent = 'Waiting for the phone to scan…';
    codeText.textContent = `Pairing name ${qr.name}`;
    codeText.classList.remove('hidden');
  } catch (err) {
    status.textContent = `Could not start pairing: ${cleanIpcError(err.message)}`;
    status.classList.add('danger-text');
  }
}

function closeQrPairing() {
  window.api.cancelQrPairing().catch(() => {});
  el('qr-modal').classList.add('hidden');
}

window.api.onQrPairProgress(({ phase, message, host }) => {
  const status = el('qr-status');
  status.textContent = message;
  status.classList.toggle('danger-text', phase === 'error');

  if (phase === 'error') {
    // Don't leave a dead code on screen next to the error: it can no longer be
    // paired with, and scanning it just makes the phone advertise a name nothing
    // is watching for.
    const canvas = el('qr-canvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  // Both terminal phases close through closeQrPairing() rather than hiding the
  // modal directly: main's loop has already finished in these cases, but relying
  // on that is exactly how a stray session ends up polling behind a closed modal.
  if (phase === 'connected') {
    closeQrPairing();
    setPairStatus(message, 'ok');
    refreshDevices();
  }
  if (phase === 'paired') {
    // Paired but not reachable. The pairing code is single-use, so redoing the
    // pairing is the wrong move — all that's missing is the connect port. Prefill
    // the host and leave the code blank; the form connects without pairing when
    // only a port is given.
    closeQrPairing();
    if (host) el('pair-host').value = host;
    el('pair-code').value = '';
    el('pair-modal').classList.remove('hidden');
    setPairStatus(message, 'err');
    el('pair-connect-port').focus();
    refreshDevices();
  }
});

// ------------------------------------------------------------------- tools modal

async function openToolsModal() {
  el('tools-modal').classList.remove('hidden');
  await loadToolsStatus();
}
el('tools-modal-close').onclick = () => el('tools-modal').classList.add('hidden');
el('tools-refresh-btn').onclick = async () => {
  const btn = el('tools-refresh-btn');
  btn.disabled = true;
  el('tools-list').innerHTML = '<span class="muted">Re-running detection (may re-download a missing tool)…</span>';
  // Full re-init rather than a passive status read, so a tool that failed to
  // download on first run gets another attempt.
  try { await window.api.reinitTools(); } catch { /* status render will show it */ }
  await loadToolsStatus();
  showScrcpyBuild();
  btn.disabled = false;
};

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

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

// Writes text only when it actually changed. The dashboard repaints every
// second, and reassigning textContent on an unchanged node still invalidates
// layout — which is visible as flicker on the wide monospace rows.
function setText(id, text) {
  const node = el(id);
  if (!node) return;
  const next = text === null || text === undefined ? '' : String(text);
  if (node.textContent !== next) node.textContent = next;
}

// Transient message. Created on demand so index.html does not need a slot for
// it, and self-removing so a stack of them cannot build up.
let toastTimer = null;
function toast(message) {
  let node = el('toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 6000);
}

// -------------------------------------------------------------- first-run setup

let setupFailed = false;

function enterShell() {
  el('setup-overlay').classList.add('hidden');
  el('shell').classList.remove('hidden');
  refreshDevices().then(autoconnectKnown);
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
qAll('.launcher[data-view], .link-btn[data-view]').forEach((btn) => (btn.onclick = () => setView(btn.dataset.view)));
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
  if (view !== 'dashboard') stopDashboardPolling();
  // The 1/s capturer poll is only useful while looking at it; elsewhere it
  // just burns CPU and sprays wgc_capturer errors for windows Chromium cannot
  // capture. The stream itself keeps running — refreshBridge() resumes the
  // feed on return while it is still live.
  if (view !== 'multimedia') stopCameraFeed();
  if (!state.selected) return;
  if (view === 'dashboard') { loadDashboard(); loadStorage(); startDashboardPolling(); }
  if (view === 'files') { loadFiles(); loadFileStorage(); }
  if (view === 'apps') loadApps();
  if (view === 'hardware') { loadHardware(); startHardwarePolling(); }
  if (view === 'multimedia') { refreshAudioStatus(); refreshBridge(); }
  if (view === 'mirror') showScrcpyBuild();
}

// -------------------------------------------------------------- connect modal

function openConnectModal(tab) {
  el('connect-modal').classList.remove('hidden');
  if (tab) switchConnectTab(tab);
}
function closeConnectModal() {
  const m = el('connect-modal');
  if (m) m.classList.add('hidden');
}

el('sidebar-device-card').onclick = () => openConnectModal();
el('connect-modal-close').onclick = () => closeConnectModal();

// Tab switching
document.querySelectorAll('.connect-tab').forEach((btn) => {
  btn.onclick = () => switchConnectTab(btn.dataset.ctab);
});
function switchConnectTab(tab) {
  document.querySelectorAll('.connect-tab').forEach((b) => b.classList.toggle('active', b.dataset.ctab === tab));
  document.querySelectorAll('.connect-tab-panel').forEach((p) => p.classList.toggle('active', p.id === `ctab-${tab}`));
  if (tab === 'switch') renderConnectDeviceList();
}

// USB scan
el('usb-scan-btn').onclick = async () => {
  const btn = el('usb-scan-btn');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  try {
    await window.api.autoconnect({ includeNew: true });
    await refreshDevices();
  } catch { /* ignore */ }
  btn.disabled = false;
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.22-8.56"/><path d="M21 3v6h-6"/></svg> Scan USB Ports';
};

// Wi-Fi pair
el('wifi-pair-btn').onclick = async () => {
  const ip = el('wifi-ip').value.trim();
  const port = el('wifi-port').value.trim();
  const code = el('wifi-code').value.trim();
  const statusEl = el('wifi-pair-status');
  const btn = el('wifi-pair-btn');

  if (!ip) { statusEl.textContent = 'Enter the phone\'s IP address.'; statusEl.className = 'mirror-status err'; return; }
  if (!port && !code) { statusEl.textContent = 'Enter the port number.'; statusEl.className = 'mirror-status err'; return; }

  btn.disabled = true;
  statusEl.textContent = code ? 'Pairing, then connecting…' : 'Connecting…';
  statusEl.className = 'mirror-status busy';
  try {
    if (code) {
      const hostPort = `${ip}:${port}`;
      const res = await window.api.pairWireless(hostPort, code, port);
      if (res && res.connected) {
        statusEl.textContent = res.message;
        statusEl.className = 'mirror-status ok';
        closeConnectModal();
        await refreshDevices();
      } else {
        statusEl.textContent = res ? res.message : 'Paired, but connect step did not run.';
        statusEl.className = 'mirror-status err';
      }
    } else {
      const result = await window.api.connectWireless(`${ip}:${port}`);
      statusEl.textContent = result || 'Connected.';
      statusEl.className = 'mirror-status ok';
      closeConnectModal();
      await refreshDevices();
    }
  } catch (err) {
    statusEl.textContent = cleanIpcError(err.message);
    statusEl.className = 'mirror-status err';
  } finally {
    btn.disabled = false;
  }
};

// QR from connect modal
el('wifi-qr-btn').onclick = () => {
  closeConnectModal();
  el('qr-modal').classList.remove('hidden');
  startQrPairing();
};

async function refreshDevices() {
  const devices = await window.api.listDevices();
  state.devices = devices;
  // A device that has gone away may come back as a different build (or after an
  // OTA), so its cached static specs must not survive the disconnect.
  const present = new Set(devices.map((d) => d.serial));
  for (const serial of [...specsCache.keys()]) {
    if (!present.has(serial)) specsCache.delete(serial);
  }
  renderDeviceList();
  updateTitlebarStatus();
  updateSidebarDeviceCard();
  const cnt = el('connect-device-count');
  if (cnt) cnt.textContent = String(devices.length);
  // Safety net: if a device is selected but the dashboard is still showing the
  // empty state, force it into the correct state. This catches races where
  // selectDevice() was skipped or threw before hiding the empty state.
  if (state.selected) {
    const es = el('empty-state');
    const dg = el('dashboard-grid');
    if (es && !es.classList.contains('hidden')) es.classList.add('hidden');
    if (dg && dg.classList.contains('hidden')) dg.classList.remove('hidden');
  }
}

// Render detected devices in the Switch Device tab of the connect modal.
function renderDeviceList() {
  const list = el('connect-device-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.devices.length) {
    list.innerHTML = '<div class="muted" style="padding:16px;text-align:center;">No devices found. Connect via USB or Wi-Fi first.</div>';
    return;
  }
  state.devices.forEach((d) => {
    const isActive = state.selected === d.serial;
    const item = document.createElement('div');
    item.className = 'connect-device-item' + (isActive ? ' active' : '');
    const model = d.model ? d.model.replace(/_/g, ' ') : d.serial;
    const isWireless = d.transport === 'Wi-Fi' || d.ip || d.serial.startsWith('adb-') || d.serial.includes('._tcp') || /^\d{1,3}(?:\.\d{1,3}){3}/.test(d.serial);
    const transport = isWireless ? 'Wi-Fi' : (d.transport || 'USB');
    const detail = d.ip ? d.ip : (isWireless ? 'Wireless debugging' : 'USB debugging');
    item.innerHTML = `
      <div class="cdi-icon">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/></svg>
      </div>
      <div class="cdi-info">
        <div class="cdi-name">${model}</div>
        <div class="cdi-detail">${detail} · ${transport}</div>
      </div>
      <div class="cdi-action${isActive ? ' active-badge' : ''}">
        ${isActive ? '✓ Active' : 'Switch →'}
      </div>
    `;
    item.onclick = () => selectDevice(d.serial);
    list.appendChild(item);
  });
}

// Renders devices in the sidebar card and connect modal switch list.
function renderConnectDeviceList() {
  renderDeviceList();
}

// Re-attaches phones paired in an earlier session. Runs once at startup: the
// pairing key on the phone is permanent, so all that is needed is `adb connect`
// at whatever address the device is on now — the user should never have to open
// the pairing screen for a phone they have already paired.
async function autoconnectKnown() {
  let result;
  try { result = await window.api.autoconnect(); }
  catch { return; }
  if (!result || !result.connected.length) return;
  await refreshDevices();
  const names = result.connected.map((c) => c.target).join(', ');
  toast(`Reconnected to ${names} — no pairing needed.`);
  if (!state.selected) selectDevice(result.connected[0].target);
}

function selectDevice(serial) {
  state.selected = serial;
  renderDeviceList();
  updateTitlebarStatus();
  updateSidebarDeviceCard();
  try { closeConnectModal(); } catch {}
  const es = el('empty-state');
  const dg = el('dashboard-grid');
  if (es) es.classList.add('hidden');
  if (dg) dg.classList.remove('hidden');
  setView(state.activeView);
  // Double-check after the current paint to catch any race where another
  // handler re-opened the modal or re-shown the empty state.
  requestAnimationFrame(() => {
    if (!state.selected || state.selected !== serial) return;
    const m = el('connect-modal');
    if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
    const e2 = el('empty-state');
    if (e2 && !e2.classList.contains('hidden')) e2.classList.add('hidden');
    const d2 = el('dashboard-grid');
    if (d2 && d2.classList.contains('hidden')) d2.classList.remove('hidden');
  });
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

function updateSidebarDeviceCard() {
  const card = el('sidebar-device-card');
  const nameEl = el('sdc-name');
  const connEl = el('sdc-conn') || el('sdc-conn-type');
  const ipEl = el('sdc-ip');
  const device = state.devices.find((d) => d.serial === state.selected);

  if (device) {
    card.classList.add('connected');
    nameEl.textContent = device.model ? device.model.replace(/_/g, ' ') : device.serial;
    const isWireless = device.transport === 'Wi-Fi' || device.serial.startsWith('adb-') || device.serial.includes('._tcp') || device.serial.includes('_adb') || /^\d{1,3}(?:\.\d{1,3}){3}/.test(device.serial);
    const transport = isWireless ? 'Wi-Fi' : (device.transport || 'USB');
    if (connEl) connEl.innerHTML = `<span class="conn-dot"></span> ${transport} Mode`;
    const cachedIp = device.ip || (specsCache.get(device.serial)?.info?.ip) || null;
    if (cachedIp) {
      ipEl.textContent = `IP: ${cachedIp}`;
      ipEl.classList.remove('hidden');
    } else {
      ipEl.classList.add('hidden');
    }
  } else {
    card.classList.remove('connected');
    nameEl.textContent = 'No device connected';
    if (connEl) connEl.innerHTML = '<span class="conn-dot"></span> —';
    ipEl.classList.add('hidden');
  }
}

// -------------------------------------------------------------------- dashboard

// ---------------------------------------------------------------------------
// Dashboard
//
// The live half (CPU, RAM, battery) comes from one batched `device:telemetry`
// call and is polled; the static half (model, Android version, patch level) is
// fetched once per serial. Storage is polled far more slowly than the rest,
// because `dumpsys diskstats` reads a cache Android refreshes on its own
// schedule — asking every second would cost an adb round trip for a number that
// cannot have changed.
// ---------------------------------------------------------------------------

const LAUNCHERS = [
  { view: 'mirror', label: 'Scrcpy mirror', sub: 'Start a live session', color: 'var(--cat-apps)', icon: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 20.5h8"/>' },
  { view: 'apps', label: 'App debloater', sub: 'Sideload / disable', color: 'var(--cat-photos)', icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14.5v6M14.5 17.5h6"/>' },
  { view: 'multimedia', label: 'Webcam bridge', sub: 'Camera + microphone', color: 'var(--cat-videos)', icon: '<path d="M2.5 7.5h11v9h-11z" /><path d="M13.5 12l8-4v8z"/>' },
  { view: 'console', label: 'ADB shell', sub: 'Raw commands', color: 'var(--cat-audio)', icon: '<rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M6.5 9.5l3 2.5-3 2.5M12 15h5"/>' },
];

function renderLaunchers() {
  const grid = el('dash-launchers');
  if (!grid || grid.childElementCount) return;
  LAUNCHERS.forEach((l) => {
    const btn = document.createElement('button');
    btn.className = 'launcher';
    btn.dataset.view = l.view;
    btn.innerHTML = `
      <span class="launcher-icon" style="--tile:${l.color}">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7"
             stroke-linecap="round" stroke-linejoin="round">${l.icon}</svg>
      </span>
      <span class="launcher-text">
        <span class="launcher-label">${l.label}</span>
        <span class="muted tiny">${l.sub}</span>
      </span>`;
    btn.onclick = () => setView(l.view);
    grid.appendChild(btn);
  });
}

/** Bytes as a short string. Mirrors src/storage.js formatBytes. */
function bytesText(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(Number(bytes)) || Number(bytes) < 0) return '—';
  const n = Number(bytes);
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(v < 100 ? 1 : 0)} ${units[u]}`;
}

/**
 * One volume: a multi-colour bar whose segments are the measured categories,
 * plus a legend built from the same list so the two cannot disagree.
 *
 * Free space is drawn as the remainder of the track rather than as a segment, so
 * the bar reads as "how full is this" at a glance.
 */
function volumeMarkup(vol) {
  const total = vol.totalBytes || 0;
  const pct = (b) => (total ? Math.max(0, (b / total) * 100) : 0);
  const segments = (vol.segments || []).filter((s) => s.bytes > 0);
  const bars = segments.map((s) => `<span class="seg" style="width:${pct(s.bytes).toFixed(3)}%;background:${s.color}"
      title="${s.label}: ${bytesText(s.bytes)}"></span>`).join('');
  const legend = segments.concat(
    vol.freeBytes ? [{ key: 'free', label: 'Free', color: 'var(--track)', bytes: vol.freeBytes }] : []
  ).map((s) => `<span class="legend-item"><span class="legend-dot" style="background:${s.color}"></span>${s.label}
      <span class="mono muted">${bytesText(s.bytes)}</span></span>`).join('');

  const note = vol.categorised
    ? ''
    : vol.removable
      ? 'Android measures categories for internal storage only, so a card shows total usage.'
      : 'Category sizes are unavailable on this device, so only total usage is shown.';

  return `
    <div class="volume">
      <div class="volume-head">
        <span class="volume-name">${vol.label}${vol.removable ? '' : ''}</span>
        <span class="mono muted tiny">${bytesText(vol.usedBytes)} of ${bytesText(vol.totalBytes)}
          · ${bytesText(vol.freeBytes)} free</span>
      </div>
      <div class="seg-track">${bars}</div>
      <div class="legend">${legend}</div>
      ${note ? `<div class="muted tiny">${note}</div>` : ''}
    </div>`;
}

async function loadDashboard() {
  const serial = state.selected;
  if (!serial) return;
  renderLaunchers();

  const [telemetry, specs] = await Promise.all([
    window.api.getTelemetry(serial).then((t) => t, (e) => ({ error: e.message })),
    loadSpecs(serial),
  ]);
  const { hw, info, soc } = specs;
  const power = telemetry.error ? {} : (telemetry.power || {});
  const perf = telemetry.error ? {} : (telemetry.perf || {});

  // --- identity -------------------------------------------------------------
  const dev = state.devices.find((d) => d.serial === serial);
  const wireless = /^\d{1,3}(?:\.\d{1,3}){3}/.test(serial) || serial.startsWith('adb-') || serial.includes('._tcp') || serial.includes('_adb') || (dev && dev.transport === 'Wi-Fi');
  setText('dash-model', (info['ro.product.model'] || serial).replace(/_/g, ' '));
  const codename = el('dash-codename');
  codename.textContent = info['ro.product.manufacturer'] || '';
  codename.classList.toggle('hidden', !codename.textContent);
  setText('dash-transport', wireless ? 'Wireless debugging' : 'USB debugging');
  setText('dash-android', info['ro.build.version.release']
    ? `Android ${info['ro.build.version.release']} (API ${info['ro.build.version.sdk'] || '?'})`
    : 'Android ?');
  setText('dash-serial', `SN: ${info['ro.boot.serialno'] || serial}`);
  setText('dash-ip', info.ip || '');
  if (info.ip && dev && !dev.ip) {
    dev.ip = info.ip;
    updateSidebarDeviceCard();
  }
  setText('dash-secpatch', info['ro.build.version.security_patch'] || 'Not reported');
  setText('dash-selinux', info.selinux || 'Unknown');
  setText('dash-bootloader', info.bootloaderLocked === '1' ? 'Locked'
    : info.bootloaderLocked === '0' ? 'Unlocked' : 'Unknown');
  setText('dash-transport-detail', wireless ? `Wi-Fi · ${info.ip || (serial.includes(':') ? serial : 'mDNS')}` : (info.ip ? `USB · IP: ${info.ip}` : 'USB'));

  // --- battery --------------------------------------------------------------
  const level = power.level ?? 0;
  const ring = el('battery-ring');
  ring.style.setProperty('--pct', level);
  ring.classList.toggle('critical', level <= 15);
  ring.classList.toggle('warn', level > 15 && level <= 35);
  setText('battery-pct', power.level === null || power.level === undefined ? '—' : `${power.level}%`);
  setText('dash-batt-eta', formatEta(power.minutesRemaining, power.charging));
  const battStatus = el('dash-batt-status');
  battStatus.textContent = power.charging ? 'Charging' : 'On battery';
  battStatus.classList.toggle('badge-online', !!power.charging);

  // A measured draw when the gauge publishes one; otherwise the negotiated
  // ceiling, marked "≤" so it is never read as a measurement.
  setText('dash-watts', power.watts ? `${power.watts.toFixed(1)} W`
    : power.maxChargeWatts ? `≤ ${power.maxChargeWatts.toFixed(0)} W` : '—');
  setText('dash-temp', power.batteryTemp === null || power.batteryTemp === undefined
    ? '—' : `${power.batteryTemp.toFixed(1)}°C`);
  const health = healthLabel(power);
  const healthEl = el('dash-health');
  healthEl.textContent = health.text;
  healthEl.className = 'v' + (health.pct === null ? ''
    : health.pct >= 85 ? ' good' : health.pct >= 70 ? ' warn' : ' bad');
  setText('dash-cycles', power.cycleCount ?? 'Not counted');
  el('dash-cycles').title = (power.notes || {}).cycleCount || '';

  // --- CPU ------------------------------------------------------------------
  setText('dash-procs', perf.processCount ? `${perf.processCount} processes` : '');
  const load = perf.cpuOverallPct;
  setText('dash-load', load === null || load === undefined ? '—' : `${load}%`);
  el('dash-load-bar').style.width = `${load || 0}%`;
  const socTemp = perf.socTempC ?? power.socTemp ?? null;
  setText('dash-soc-temp', socTemp === null ? '—' : `${socTemp.toFixed(1)}°C`);

  const cores = perf.cores || [];
  setText('dash-cores-label', cores.length
    ? `${cores.length}-core cluster frequencies${soc.clusterSummary ? ` · ${soc.clusterSummary}` : ''}`
    : 'Per-core load is not readable on this device');
  const coreGrid = el('dash-cores');
  coreGrid.innerHTML = cores.map((c) => {
    const pct = c.pct === null || c.pct === undefined ? null : c.pct;
    const hue = pct === null ? 'var(--track)' : pct >= 80 ? 'var(--cat-system)'
      : pct >= 45 ? 'var(--cat-videos)' : 'var(--cat-photos)';
    return `<div class="core${c.online ? '' : ' offline'}" title="${
      c.online ? `Core ${c.index}` : `Core ${c.index} — offline (parked by the kernel)`}">
      <div class="core-bar"><span style="height:${pct === null ? 0 : pct}%;background:${hue}"></span></div>
      <span class="core-pct mono">${pct === null ? '—' : `${pct}%`}</span>
      <span class="core-name mono muted">C${c.index}</span>
      <span class="core-ghz mono muted">${c.curGhz ? `${c.curGhz.toFixed(2)}` : '—'}</span>
    </div>`;
  }).join('');

  // --- RAM ------------------------------------------------------------------
  setText('dash-ram-title', soc.ddrType ? `${soc.ddrType} system memory` : 'System memory');
  const memPct = perf.memUsedPct;
  const memBadge = el('dash-mem-pct');
  memBadge.textContent = memPct === null || memPct === undefined ? '' : `${memPct}% utilised`;
  memBadge.className = 'badge' + (memPct >= 90 ? ' badge-bad' : memPct >= 75 ? ' badge-warn' : '');
  setText('dash-mem', perf.memTotalBytes
    ? `${bytesText(perf.memUsedBytes)} / ${bytesText(perf.memTotalBytes)}`
    : (hw.ramTotalGb ? `${hw.ramUsedGb || '?'} / ${hw.ramTotalGb} GB` : '—'));
  el('mem-bar').style.width = `${memPct || 0}%`;
  // kernel vs app PSS, which only `dumpsys meminfo` knows. Absent on some builds,
  // so the cells are only drawn when the split was actually measured.
  const split = [
    ['Android OS &amp; system', perf.kernelBytes],
    ['Foreground apps', perf.appBytes],
    ['Swap in use', perf.swapUsedBytes],
    ['Available', perf.memAvailableBytes],
  ].filter(([, v]) => Number.isFinite(v) && v > 0);
  el('dash-mem-split').innerHTML = split
    .map(([k, v]) => `<div class="data-cell"><span class="k">${k}</span><span class="v">${bytesText(v)}</span></div>`)
    .join('');

  if (telemetry.error) setText('dash-storage-note', `Telemetry unavailable: ${telemetry.error}`);
}

// Storage is polled on a much longer cycle than CPU/RAM: `df` is cheap but the
// category split behind it comes from a cache Android rebuilds on its own
// schedule, so a 1 s poll would spend adb round trips on a number that cannot
// have moved.
let storageInFlight = false;

async function loadStorage() {
  const serial = state.selected;
  if (!serial || storageInFlight) return;
  storageInFlight = true;
  try {
    const report = await window.api.getStorage(serial);
    const volumes = report.volumes || [];
    el('dash-volumes').innerHTML = volumes.length
      ? volumes.map(volumeMarkup).join('')
      : '<div class="muted">Storage could not be read from this device.</div>';
    setText('dash-storage-note', volumes.length
      ? [
        report.diskstatsAvailable ? 'Category sizes from dumpsys diskstats' : 'Totals from df',
        report.sdPresent ? 'SD card mounted'
          : report.sdDetected ? 'SD card detected but not mounted' : 'No removable card',
      ].join(' · ')
      : '');
  } catch (e) {
    el('dash-volumes').innerHTML = `<div class="muted">Storage unavailable: ${e.message}</div>`;
  } finally {
    storageInFlight = false;
  }
}

let dashboardTimer = null;
let dashboardInFlight = false;
let dashboardTicks = 0;

function startDashboardPolling() {
  stopDashboardPolling();
  dashboardTicks = 0;
  dashboardTimer = setInterval(async () => {
    if (state.activeView !== 'dashboard' || !state.selected) { stopDashboardPolling(); return; }
    // A device on a slow link can take longer than the interval to answer.
    // Without this the ticks would queue and every one of them would time out.
    if (dashboardInFlight) return;
    dashboardInFlight = true;
    try {
      await loadDashboard();
      dashboardTicks += 1;
      if (dashboardTicks % 30 === 0) await loadStorage();
    } finally {
      dashboardInFlight = false;
    }
  }, 1000);
}

function stopDashboardPolling() {
  if (dashboardTimer) clearInterval(dashboardTimer);
  dashboardTimer = null;
}

el('dash-refresh').onclick = async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('spinning');
  // Drop the cached static specs too, so this button is a genuine re-read rather
  // than a repaint of the same numbers.
  specsCache.delete(state.selected);
  try {
    await refreshDevices();
    if (state.selected) { await loadDashboard(); await loadStorage(); }
  } finally {
    btn.classList.remove('spinning');
  }
};

el('dash-disconnect').onclick = async () => {
  const serial = state.selected;
  if (!serial) return;
  const res = await window.api.disconnectDevice(serial);
  specsCache.delete(serial);
  if (res.disconnected) {
    stopDashboardPolling();
    state.selected = null;
  }
  // A USB device stays attached until the cable comes out, so say so rather than
  // pretending the button did something.
  if (res.message) toast(res.message);
  await refreshDevices();
};

// ---------------------------------------------------------------- hardware view

const fmt = (v, digits = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(digits));

function formatEta(minutes, charging) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const span = h ? `${h}h ${m}m` : `${m}m`;
  return charging ? `~${span} to full` : `~${span} left`;
}

// The power-station ring is only ~82–104px across, so its eta has to stay on
// one short line. Direction is already shown by the status badge ("Charging" /
// "On battery") and the bolt, so inside the ring we show just the duration —
// the full "~… to full / … left" phrasing is kept for the roomier dashboard
// eta that sits below its ring.
function formatEtaCompact(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
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
  // Derived from charge_counter rather than a published charge_full, so it is
  // shown with a "≈" — the number is real arithmetic on real readings, but its
  // input is the level, which the gauge rounds to a whole percent.
  if (power.estimatedHealthPct !== null && power.estimatedHealthPct !== undefined) {
    return {
      text: `≈ ${power.estimatedHealthPct}%${name ? ` (${name})` : ''}`,
      pct: power.estimatedHealthPct,
    };
  }
  return { text: name || '—', pct: null };
}

let hardwareTimer = null;
// Model name, chipset, display and Android version cannot change while a device
// stays connected, so they are fetched once per serial instead of on every tick.
// Re-fetching them was most of the lag the user was seeing: `device:info` alone
// used to be nine sequential adb round trips.
const specsCache = new Map();

async function loadSpecs(serial) {
  if (specsCache.has(serial)) return specsCache.get(serial);
  const [hw, info, soc] = await Promise.all([
    window.api.getHardware(serial).catch(() => ({})),
    window.api.getDeviceInfo(serial).catch(() => ({})),
    window.api.getSoc(serial).catch(() => ({})),
  ]);
  const specs = { hw, info, soc };
  specsCache.set(serial, specs);
  return specs;
}

async function loadHardware() {
  const serial = state.selected;
  if (!serial) return;

  // The live half is one IPC call and one batched adb round trip; the static
  // half resolves from cache after the first load.
  const [telemetry, specs] = await Promise.all([
    window.api.getTelemetry(serial).then((t) => t, (e) => ({ error: e.message })),
    loadSpecs(serial),
  ]);

  if (telemetry.error) {
    setText('hw-source-note', `Could not read power telemetry: ${telemetry.error}`);
    return;
  }
  const power = telemetry.power || {};
  const perf = telemetry.perf || {};
  const { hw, info, soc } = specs;

  // --- battery power station -------------------------------------------------
  const level = power.level ?? 0;
  const ring = el('hw-ring');
  ring.style.setProperty('--pct', level);
  ring.classList.toggle('critical', level <= 15);
  ring.classList.toggle('warn', level > 15 && level <= 35);

  setText('hw-level', power.level === null ? '—' : `${power.level}%`);
  setText('hw-eta', formatEtaCompact(power.minutesRemaining));
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

  const notes = power.notes || {};

  // Full capacity: a measured charge_full when the gauge publishes one, else the
  // value implied by charge_counter at the current level — labelled "≈" so an
  // estimate is never mistaken for a reading.
  const currentMah = power.chargeNowMah ?? power.estimatedNowMah;
  const totalMah = power.chargeFullMah ?? power.estimatedFullMah ?? power.chargeDesignMah;
  setText('hw-capacity', totalMah
    ? `${currentMah ?? '—'} / ${totalMah} mAh`
    : '—');
  el('hw-capacity').title = notes.chargeFullMah || '';

  setText('hw-cycles', power.cycleCount ?? 'Not counted');
  el('hw-cycles').title = notes.cycleCount || '';
  setText('hw-tech', power.technology || '—');

  // --- electrical & thermal telemetry ---------------------------------------
  setText('hw-power-label', power.charging ? 'Charging Power' : 'Power Draw');
  setText('hw-current-label', power.charging ? 'Charging Current' : 'Discharge Current');

  setText('hw-watts', fmt(power.watts, 2));
  setText('hw-voltage', fmt(power.voltage, 2));
  setText('hw-voltage-mv', power.voltageMv ? `${power.voltageMv} mV` : '');
  setText('hw-current', (power.charging ? '+' : '−') + fmt(power.current, 2));
  setText('hw-current-ma', power.currentMa !== null && power.currentMa !== undefined
    ? `${power.charging ? '+' : '−'}${Math.abs(power.currentMa)} mA`
    // With no measured draw, show the negotiated ceiling instead — clearly
    // marked, because a ceiling is what the charger *allows*, not what flows.
    : power.maxChargeWatts ? `up to ${fmt(power.maxChargeWatts, 0)} W negotiated` : '');
  el('hw-watts').title = notes.watts || '';
  el('hw-current').title = notes.current || '';

  setText('hw-temp', fmt(power.batteryTemp, 1));
  setText('hw-temp-sub', power.batteryTemp === null
    ? ''
    : `${(power.batteryTemp * 9 / 5 + 32).toFixed(1)}°F · ${power.batteryTemp >= 43 ? 'Hot' : power.batteryTemp >= 38 ? 'Warm' : 'Normal'}`);

  const socTemp = power.socTemp ?? perf.socTempC ?? null;
  setText('hw-soc-temp', fmt(socTemp, 1));
  setText('hw-soc-zone', power.socZone ? `zone: ${power.socZone}` : 'No SoC thermal zone');
  el('hw-soc-temp').title = notes.socTemp || '';

  setText('hw-protocol', power.protocol || (power.charging ? 'USB (unreported)' : 'Not charging'));
  const inputBits = [
    power.inputVoltage ? `${fmt(power.inputVoltage, 1)} V` : null,
    power.inputCurrentLimit ? `${fmt(power.inputCurrentLimit, 2)} A limit` : null,
    power.typecMode || null,
  ].filter(Boolean);
  setText('hw-protocol-sub', inputBits.join(' · '));

  const rate = el('hw-rate');
  if (power.charging && power.watts) {
    rate.textContent = `${power.watts >= 15 ? 'Fast charge' : 'Charging'} (${fmt(power.watts, 1)} W)`;
    rate.style.color = power.watts >= 15 ? 'var(--accent)' : 'var(--signal)';
  } else if (!power.charging && power.watts) {
    rate.textContent = `Discharging (${fmt(power.watts, 1)} W)`;
    rate.style.color = 'var(--text-muted)';
  } else {
    rate.textContent = '';
  }

  // Name the source that actually answered rather than assuming sysfs, and only
  // apologise for what is genuinely missing.
  const sourceBits = [];
  if (power.sysfsAvailable) sourceBits.push('kernel power-supply nodes');
  if (power.healthHal) sourceBits.push(power.healthHal);
  if (!sourceBits.length) sourceBits.push('dumpsys battery');
  const gaps = Object.values(notes);
  setText('hw-source-note', `Read from ${sourceBits.join(' + ')}.${gaps.length ? ` ${gaps[0]}` : ''}`);

  // --- processor & device specs --------------------------------------------
  setText('hw-chipset', soc.socName || info['ro.board.platform'] || '—');
  setText('hw-chipset-sub', [
    soc.clusterSummary,
    soc.coreCount ? `${soc.coreCount} cores` : null,
  ].filter(Boolean).join(' · '));

  setText('hw-display', hw.resolution ? `${hw.resolution} pixels` : '—');
  setText('hw-display-sub', hw.density ? `${hw.density} dpi` : '');

  // RAM total is static, but "in use" is not — take it from the live telemetry
  // so it moves with the 1 s poll instead of sitting at the first reading.
  const gb = (bytes) => (bytes ? (bytes / 1073741824).toFixed(1) : null);
  setText('hw-ram', gb(perf.memTotalBytes) ? `${gb(perf.memTotalBytes)} GB` : (hw.ramTotalGb ? `${hw.ramTotalGb} GB` : '—'));
  setText('hw-ram-sub', [
    soc.ddrType ? `DDR type ${soc.ddrType}` : null,
    gb(perf.memUsedBytes) ? `${gb(perf.memUsedBytes)} GB in use` : (hw.ramUsedGb ? `${hw.ramUsedGb} GB in use` : null),
    perf.cpuOverallPct === null || perf.cpuOverallPct === undefined ? null : `CPU ${perf.cpuOverallPct}%`,
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
//
// 1 s rather than 3 s: the live half is now a single batched adb round trip
// (~250 ms including the 0.4 s on-device sampling sleep for /proc/stat), so a
// 3 s gap was mostly idle waiting. `inFlight` keeps a slow device from stacking
// up overlapping reads, which would make the display lag further behind rather
// than catch up.
let hardwareInFlight = false;

function startHardwarePolling() {
  stopHardwarePolling();
  hardwareTimer = setInterval(async () => {
    if (state.activeView !== 'hardware' || !state.selected) { stopHardwarePolling(); return; }
    if (hardwareInFlight) return;
    hardwareInFlight = true;
    try { await loadHardware(); } finally { hardwareInFlight = false; }
  }, 1000);
}

function stopHardwarePolling() {
  if (hardwareTimer) { clearInterval(hardwareTimer); hardwareTimer = null; }
}

// ----------------------------------------------------------------------- files

function formatSize(bytes) {
  if (bytes === null || bytes === undefined) return '';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return v.toFixed(v < 10 ? 1 : 0) + ' ' + units[u];
}

const EXT_ICON = {
  jpg: '\uD83D\uDF9C', jpeg: '\uD83D\uDF9C', png: '\uD83D\uDF9C', gif: '\uD83D\uDF9C', webp: '\uD83D\uDF9C',
  mp4: '\uD83C\uDFAC', mkv: '\uD83C\uDFAC', avi: '\uD83C\uDFAC', mov: '\uD83C\uDFAC',
  mp3: '\uD83C\uDFB5', flac: '\uD83C\uDFB5', aac: '\uD83C\uDFB5', wav: '\uD83C\uDFB5',
  pdf: '\uD83D\uDCC4', doc: '\uD83D\uDCC4', docx: '\uD83D\uDCC4', txt: '\uD83D\uDCDD', md: '\uD83D\uDCDD',
  zip: '\uD83D\uDCE6', rar: '\uD83D\uDCE6', '7z': '\uD83D\uDCE6', tar: '\uD83D\uDCE6',
  apk: '\uD83E\uDD16', json: '\uD83D\uDCCB', xml: '\uD83D\uDCCB', js: '\uD83D\uDCCB',
};
function fileIcon(name, isDir, isLink) {
  if (isLink) return '\uD83D\uDD17';
  if (isDir) return '\uD83D\uDCC1';
  const ext = (name.split('.').pop() || '').toLowerCase();
  return EXT_ICON[ext] || '\uD83D\uDCC4';
}

// Multi-select state
state.selectedFiles = new Set();

function updateFileToolbar() {
  const count = state.selectedFiles.size;
  el('file-sel-count').textContent = count ? count + ' selected' : '';
  const dlBtn = el('file-download-btn');
  const upBtn = el('file-upload-btn');
  if (dlBtn) dlBtn.disabled = count === 0;
  if (upBtn) upBtn.disabled = count === 0;
}

qAll('#file-category-tabs .chip-tab').forEach((tab) => {
  tab.onclick = () => {
    qAll('#file-category-tabs .chip-tab').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    el('remote-path').value = tab.dataset.path;
    loadFiles();
  };
});

el('list-files-btn').onclick = loadFiles;

// ---------------------------------------------------------------------------
// Transfer center: one floating sheet for uploads and downloads, modelled on
// a phone-style transfer manager (overall %, ETA, speed, totals, active item,
// per-file queue) but drawn entirely with theme variables so dark and light
// mode both work. A single persistent listener per direction feeds it — the
// old code registered a new ipcRenderer listener on every transfer and never
// removed it.
// ---------------------------------------------------------------------------
const TransferCenter = {
  active: false,
  done: false,
  cancelled: false,
  failed: false,
  cancelling: false,
  transferId: null,
  direction: 'download', // 'download' | 'upload'
  items: [], // { name, isDir, status: queued|active|done|failed, bytes, totalBytes, percent, error }
  from: '',
  to: '',
  startedAt: 0,
  samples: [], // { t, bytes } trailing window for speed/ETA
  collapsed: false,
  _raf: false,

  start({ direction, items, from, to }) {
    this.active = true;
    this.done = false;
    this.cancelled = false;
    this.failed = false;
    this.cancelling = false;
    this.transferId = `tc-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`;
    this.direction = direction === 'upload' ? 'upload' : 'download';
    this.items = (Array.isArray(items) ? items : []).map((it) => ({
      name: it && it.name ? String(it.name) : 'Preparing…',
      isDir: !!(it && it.isDir),
      status: 'queued', bytes: 0, totalBytes: 0, percent: 0, error: '',
    }));
    this.from = from || '';
    this.to = to || '';
    this.startedAt = Date.now();
    this.samples = [];
    el('transfer-center').classList.remove('hidden');
    el('transfer-pill').classList.add('hidden');
    el('tc-icon').textContent = this.direction === 'upload' ? '⬆' : '⬇';
    el('transfer-pill-icon').textContent = this.direction === 'upload' ? '⬆' : '⬇';
    const stopBtn = el('tc-stop');
    if (stopBtn) { stopBtn.classList.remove('hidden'); stopBtn.disabled = false; stopBtn.textContent = 'Stop'; }
    this.render(true);
  },

  async stop() {
    if (!this.active || this.done || this.cancelling) return;
    this.cancelling = true;
    const stopBtn = el('tc-stop');
    if (stopBtn) { stopBtn.disabled = true; stopBtn.textContent = 'Stopping…'; }
    try { await window.api.cancelTransfer(this.transferId); } catch { /* the in-flight call still resolves */ }
    // The UI settles when the transfer call returns (cancelled flag); the
    // button stays disabled until then so Stop can't double-fire.
  },

  rowFor(data) {
    const name = data && data.name ? String(data.name) : '';
    // Name first: main expands folders server-side, so event indexes address
    // the expanded queue — using them blindly would rename the parent folder
    // row to its first child. Index is only a fallback for unnamed rows.
    if (name) {
      const hit = this.items.find((it) => it.name === name);
      if (hit) return hit;
    }
    if (Number.isInteger(data.index) && this.items[data.index]
        && (!name || this.items[data.index].name === name || this.items[data.index].name === 'Preparing…')) {
      return this.items[data.index];
    }
    const row = { name: name || 'Item', isDir: false, status: 'queued', bytes: 0, totalBytes: 0, percent: 0, error: '' };
    this.items.push(row);
    return row;
  },

  onEvent(data) {
    if (!this.active || this.done || !data) return;
    const row = this.rowFor(data);
    if (data.name && (!row.name || row.name === 'Preparing…')) row.name = String(data.name);
    row.status = 'active';
    if (Number.isFinite(data.bytes)) row.bytes = data.bytes;
    if (Number.isFinite(data.totalBytes) && data.totalBytes > 0) row.totalBytes = data.totalBytes;
    if (data.percent === 100) {
      row.percent = 100;
      row.status = 'done';
      if (row.totalBytes) row.bytes = row.totalBytes;
    } else if (typeof data.percent === 'number' && data.percent >= 0) {
      row.percent = data.percent;
    } else {
      row.percent = -1; // indeterminate: working, no measurable fraction
    }
    const snap = this.totals();
    const now = Date.now();
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.t > 250 || snap.done !== last.bytes) this.samples.push({ t: now, bytes: snap.done });
    this.scheduleRender();
  },

  totals() {
    let done = 0;
    let known = 0;
    let doneCount = 0;
    for (const it of this.items) {
      if (it.totalBytes > 0) { known += it.totalBytes; done += Math.min(it.bytes, it.totalBytes); }
      if (it.status === 'done') doneCount += 1;
    }
    return { done, known, doneCount, total: this.items.length };
  },

  speed() {
    const now = Date.now();
    this.samples = this.samples.filter((s) => now - s.t < 4000);
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt > 0.3 ? Math.max(0, (last.bytes - first.bytes) / dt) : 0;
  },

  scheduleRender() {
    if (this._raf) return;
    this._raf = true;
    const paint = () => { this._raf = false; this.render(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paint);
    else setTimeout(paint, 100);
  },

  fmtEta(sec) {
    if (!Number.isFinite(sec) || sec < 0) return 'Calculating…';
    if (sec < 2) return 'Almost done…';
    if (sec < 60) return `About ${Math.round(sec)}s left`;
    const m = Math.round(sec / 60);
    return m < 60 ? `About ${m}m left` : `About ${Math.floor(m / 60)}h ${m % 60}m left`;
  },

  activeRow() {
    return this.items.find((it) => it.status === 'active')
      || this.items.filter((it) => it.status === 'done').slice(-1)[0]
      || null;
  },

  render() {
    const doPaint = () => {
      const snap = this.totals();
      const sheet = el('transfer-center');
      const hidden = sheet.classList.contains('hidden');
      const pctText = snap.known > 0
        ? `${Math.min(100, Math.round((snap.done / snap.known) * 100))}%`
        : (snap.total ? `${Math.round((snap.doneCount / snap.total) * 100)}%` : '0%');
      el('transfer-pill-text').textContent = this.done ? 'Done' : pctText;
      if (hidden) return;
      const isUp = this.direction === 'upload';
      el('tc-title').textContent = this.failed ? 'Transfer failed'
        : this.cancelled ? 'Transfer cancelled'
        : this.done ? (isUp ? 'Upload complete' : 'Download complete')
        : (isUp ? 'Uploading Files' : 'Downloading Files');
      el('tc-count').textContent = `${snap.total} item${snap.total === 1 ? '' : 's'}`;
      // Headline: percent when totals are known, else the bytes actually moved
      // (a stuck "0%" while gigabytes flow is the worst possible feedback).
      const movedOnly = !this.done && snap.known === 0 && snap.done > 0;
      el('tc-pct').textContent = movedOnly ? formatSize(snap.done)
        : (this.done && snap.doneCount === snap.total && snap.total ? '100%' : pctText);
      el('tc-complete-word').textContent = this.cancelling ? 'cancelling…'
        : movedOnly ? 'transferred' : 'complete';
      const spd = this.done ? 0 : this.speed();
      const remaining = snap.known - snap.done;
      el('tc-eta').textContent = this.done ? (snap.doneCount === snap.total && snap.total ? 'Finished' : '')
        : (snap.known > 0 && spd > 0 ? this.fmtEta(remaining / spd) : 'Calculating…');
      const fill = el('tc-overall-fill');
      if (snap.known > 0) {
        fill.classList.remove('indet');
        fill.style.width = `${snap.known ? Math.min(100, (snap.done / snap.known) * 100) : 0}%`;
      } else if (snap.doneCount > 0 && snap.total) {
        fill.classList.remove('indet');
        fill.style.width = `${(snap.doneCount / snap.total) * 100}%`;
      } else {
        fill.classList.add('indet');
        fill.style.width = '';
      }
      el('tc-speed').textContent = spd > 0 ? `${formatSize(spd)}/s` : '—';
      el('tc-totals').textContent = snap.known > 0
        ? `${formatSize(snap.done)} / ${formatSize(snap.known)}`
        : `${snap.doneCount} / ${snap.total} items`;
      el('tc-route').textContent = this.from && this.to ? `${this.from} → ${this.to}` : '';
      // Active item card.
      const active = this.done ? null : this.activeRow();
      const activeBox = el('tc-active');
      if (!active) {
        activeBox.classList.add('hidden');
      } else {
        activeBox.classList.remove('hidden');
        const idx = this.items.indexOf(active);
        el('tc-active-idx').textContent = `ACTIVE ITEM (${idx + 1} OF ${snap.total})`;
        el('tc-active-pct').textContent = active.percent >= 0 ? `${Math.round(active.percent)}%` : '…';
        el('tc-active-icon').textContent = fileIcon(active.name, active.isDir, false);
        el('tc-active-name').textContent = active.name;
        el('tc-active-name').title = active.name;
        const parts = [];
        if (active.totalBytes > 0) parts.push(`${formatSize(active.bytes)} of ${formatSize(active.totalBytes)}`);
        else if (active.bytes > 0) parts.push(formatSize(active.bytes));
        if (spd > 0 && active.status === 'active') parts.push(`${formatSize(spd)}/s`);
        if (!parts.length) parts.push(active.status === 'done' ? 'Done' : active.isDir ? 'Folder • working…' : 'Working…');
        el('tc-active-sub').textContent = parts.join(' • ');
        const afill = el('tc-active-fill');
        if (active.percent >= 0) { afill.classList.remove('indet'); afill.style.width = `${active.percent}%`; }
        else { afill.classList.add('indet'); afill.style.width = ''; }
      }
      // Queue.
      el('tc-queue-title').innerHTML = `Transfer Queue <span class="muted">(${snap.total} item${snap.total === 1 ? '' : 's'})</span>`;
      const list = el('tc-queue');
      const scroll = list.scrollTop;
      list.innerHTML = this.items.map((it) => {
        let sub;
        let state;
        let mark;
        if (it.status === 'done') {
          sub = `Completed${it.totalBytes > 0 ? ' • ' + formatSize(it.totalBytes) : ''}`;
          state = 'ok'; mark = '✓';
        } else if (it.status === 'failed') {
          sub = it.error ? `Failed • ${it.error}` : 'Failed';
          state = 'err'; mark = '✕';
        } else if (it.status === 'active') {
          sub = it.totalBytes > 0 ? `${formatSize(it.bytes)} of ${formatSize(it.totalBytes)}` : (it.bytes > 0 ? formatSize(it.bytes) : 'Working…');
          state = 'idle'; mark = `${it.percent >= 0 ? Math.round(it.percent) + '%' : '…'}`;
        } else {
          sub = it.isDir ? 'Folder • Queued' : (it.totalBytes > 0 ? `Queued • ${formatSize(it.totalBytes)}` : 'Queued');
          state = 'idle'; mark = '◷';
        }
        return `<div class="tc-row"><span class="tc-item-icon">${fileIcon(it.name, it.isDir, false)}</span>`
          + `<span class="tc-row-text"><span class="tc-row-name" title="${esc(it.name)}">${esc(it.name)}</span>`
          + `<span class="tc-row-sub ${state === 'ok' ? 'ok' : state === 'err' ? 'err' : ''}"${state === 'err' && it.error ? ` title="${esc(it.error)}"` : ''}>${esc(sub)}</span></span>`
          + `<span class="tc-row-state ${state}">${mark}</span></div>`;
      }).join('');
      list.scrollTop = scroll;
    };
    doPaint();
  },

  finish({ results, single, cancelled, destDir, error } = {}) {
    if (Array.isArray(results)) {
      for (const r of results) {
        if (!r) continue;
        let row = (r.name && this.items.find((it) => it.name === r.name)) || null;
        if (!row && this.items.length === 1) row = this.items[0];
        if (!row) {
          row = { name: r.name || 'Item', isDir: false, status: 'queued', bytes: 0, totalBytes: 0, percent: 0, error: '' };
          this.items.push(row);
        }
        if (r.ok) {
          row.status = 'done';
          row.percent = 100;
          if (row.totalBytes) row.bytes = row.totalBytes;
        } else {
          row.status = 'failed';
          row.error = r.error ? cleanIpcError(String(r.error)) : 'Failed';
        }
      }
      // Folders expand server-side into sub-entries: retire a leftover queued
      // parent once any of its children completed.
      for (const it of this.items) {
        if (it.status !== 'queued') continue;
        const covered = this.items.some((o) => o !== it && o.status === 'done' && o.name.startsWith(it.name + '/'));
        if (covered) { it.status = 'done'; it.percent = 100; }
      }
    } else if (single) {
      let row = this.items.find((it) => it.status !== 'queued') || this.items[0];
      if (!row) {
        row = { name: String(single).split(/[\\/]/).pop(), isDir: false, status: 'queued', bytes: 0, totalBytes: 0, percent: 0, error: '' };
        this.items.push(row);
      }
      row.status = 'done';
      row.percent = 100;
    }
    if (typeof destDir === 'string' && destDir) this.to = destDir;
    this.done = true;
    this.cancelled = !!cancelled;
    this.cancelling = false;
    this.failed = !!error || (Array.isArray(results) && results.some((r) => r && !r.ok));
    if (this.cancelled) {
      for (const it of this.items) {
        if (it.status !== 'done') { it.status = 'queued'; it.percent = 0; }
      }
    }
    const stopBtn = el('tc-stop');
    if (stopBtn) stopBtn.classList.add('hidden');
    el('transfer-pill').classList.add('hidden');
    this.render(true);
  },

  fail(err) {
    this.finish({ error: err ? cleanIpcError(String((err && err.message) || err)) : 'Failed' });
  },

  cancel() {
    this.finish({ cancelled: true });
  },

  hide() {
    el('transfer-center').classList.add('hidden');
    if (this.active && !this.done) {
      el('transfer-pill').classList.remove('hidden');
    } else {
      el('transfer-pill').classList.add('hidden');
    }
  },

  show() {
    el('transfer-center').classList.remove('hidden');
    el('transfer-pill').classList.add('hidden');
    this.render();
  },
};

el('tc-close').onclick = () => TransferCenter.hide();
el('tc-stop').onclick = () => TransferCenter.stop();
el('tc-collapse').onclick = () => {
  TransferCenter.collapsed = !TransferCenter.collapsed;
  el('tc-body').classList.toggle('hidden', TransferCenter.collapsed);
  el('tc-collapse').innerHTML = TransferCenter.collapsed ? '&#9656;' : '&#9662;';
};
el('transfer-pill').onclick = () => TransferCenter.show();
// One persistent listener per direction (also fixes the old per-transfer leak).
// The transferId match keeps a previous transfer's late events from painting
// over a newer one running the same direction.
window.api.onPushProgress((data) => {
  if (!TransferCenter.active || TransferCenter.done || TransferCenter.direction !== 'upload') return;
  if (data && data.transferId && data.transferId !== TransferCenter.transferId) return;
  TransferCenter.onEvent(data);
});
window.api.onPullProgress((data) => {
  if (!TransferCenter.active || TransferCenter.done || TransferCenter.direction !== 'download') return;
  if (data && data.transferId && data.transferId !== TransferCenter.transferId) return;
  TransferCenter.onEvent(data);
});

el('push-file-btn').onclick = async () => {
  if (!state.selected) return;
  TransferCenter.start({ direction: 'upload', items: [], from: 'This PC', to: 'Phone ' + el('remote-path').value });
  try {
    const result = await window.api.pushFile(state.selected, el('remote-path').value, { transferId: TransferCenter.transferId });
    if (result) { TransferCenter.finish({ single: result }); toast('Uploaded ' + result.split('/').pop()); }
    else { TransferCenter.cancel(); }
  } catch (err) { TransferCenter.fail(err); }
  loadFiles();
};

// Select-all checkbox
const selectAllCb = el('file-select-all');
if (selectAllCb) selectAllCb.onchange = () => {
  const cbs = qAll('#file-list .file-cb');
  cbs.forEach((cb) => { cb.checked = selectAllCb.checked; });
  syncFileSelection();
};

function syncFileSelection() {
  state.selectedFiles.clear();
  qAll('#file-list .list-row').forEach((row) => {
    const cb = row.querySelector('.file-cb');
    if (cb && cb.checked) {
      const fp = row.dataset.fullpath;
      const isDir = row.dataset.isdir === '1';
      const size = row.dataset.size === '' ? null : Number(row.dataset.size);
      const item = { path: fp, name: row.dataset.name, _isDir: isDir, _size: Number.isFinite(size) ? size : null };
      state.selectedFiles.add(item);
    }
  });
  updateFileToolbar();
}

async function loadFiles() {
  const remotePath = el('remote-path').value;
  const container = el('file-list');
  container.innerHTML = '<span class="muted">Listing\u2026</span>';
  state.selectedFiles.clear();
  updateFileToolbar();
  if (selectAllCb) selectAllCb.checked = false;
  try {
    const lines = await window.api.listFiles(state.selected, remotePath);
    container.innerHTML = '';
    const parsed = lines.map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      // `ls -la` prints a `total N` summary as its first line — not an entry.
      if (/^total\s+\d+\s*$/.test(trimmed)) return null;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 8) return { isDir: false, isLink: false, size: null, name: trimmed };
      const perms = parts[0];
      const isLink = perms.charAt(0) === 'l';
      const isDir = perms.charAt(0) === 'd';
      const size = Number.isFinite(Number(parts[4])) ? Number(parts[4]) : null;
      const name = parts.slice(7).join(' ').replace(/\s*->\s*.*$/, '').trim();
      return { isDir, isLink, size, name };
    }).filter(Boolean);
    parsed.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    parsed.forEach((item) => {
      if (!item.name || item.name === '.' || item.name === '..') return;
      const row = document.createElement('div');
      row.className = 'list-row';
      const icon = fileIcon(item.name, item.isDir, item.isLink);
      const sizeStr = formatSize(item.size);
      const fullPath = remotePath.replace(/\/?$/, '/') + item.name;
      row.dataset.fullpath = fullPath;
      row.dataset.name = item.name;
      row.dataset.isdir = item.isDir ? '1' : '0';
      row.dataset.size = Number.isFinite(item.size) ? String(item.size) : '';
      row.innerHTML = '<input type="checkbox" class="file-cb" /><span class="name"><span class="file-icon">' + icon + '</span><span class="fname">' + esc(item.name) + '</span></span><span class="meta">' + sizeStr + '</span>';
      const cb = row.querySelector('.file-cb');
      cb.onclick = (e) => { e.stopPropagation(); syncFileSelection(); };
      row.onclick = (e) => {
        if (e.target.tagName === 'INPUT') return;
        if (item.isDir) {
          el('remote-path').value = fullPath;
          loadFiles();
        } else {
          selectFile(item.name, fullPath, item);
        }
      };
      container.appendChild(row);
    });
    if (remotePath !== '/') {
      const upRow = document.createElement('div');
      upRow.className = 'list-row';
      upRow.innerHTML = '<span class="name"><span class="file-icon">\uD83D\uDCC1</span><span class="fname">\u2026 (parent)</span></span>';
      upRow.onclick = () => {
        const parent = remotePath.replace(/\/?$/, '').replace(/[^/]+$/, '') || '/';
        el('remote-path').value = parent;
        loadFiles();
      };
      container.insertBefore(upRow, container.firstChild);
    }
    if (!container.querySelectorAll('.list-row').length) container.innerHTML = '<span class="muted">Empty or inaccessible folder.</span>';
    updateBreadcrumb(remotePath);
  } catch (err) {
    container.innerHTML = '<span class="muted">' + esc(err.message) + '</span>';
  }
}

async function selectFile(name, fullPath, itemInfo) {
  state.selectedFile = { name, fullPath, size: itemInfo && Number.isFinite(itemInfo.size) ? itemInfo.size : null };
  qAll('#file-list .list-row').forEach((r) => r.classList.remove('selected'));
  el('file-inspector-empty').classList.add('hidden');
  el('file-inspector-body').classList.remove('hidden');
  el('fi-name').textContent = name;
  el('fi-path').textContent = fullPath;
  const fiType = el('fi-type');
  if (fiType) fiType.textContent = itemInfo ? (itemInfo.isDir ? 'Folder' : 'File') : 'File';
  const fiSize = el('fi-size');
  if (fiSize) fiSize.textContent = itemInfo ? formatSize(itemInfo.size) : '';

  const container = el('file-preview-container');
  container.innerHTML = '';
  if (itemInfo && itemInfo.isDir) return;

  try {
    const result = await window.api.previewFile(state.selected, fullPath);
    if (!result) return;
    if (result.kind === 'image') {
      const img = document.createElement('img');
      img.className = 'preview-image';
      img.src = result.data;
      container.appendChild(img);
    } else if (result.kind === 'video') {
      const vid = document.createElement('video');
      vid.className = 'preview-video';
      vid.controls = true;
      vid.src = result.data;
      container.appendChild(vid);
    } else if (result.kind === 'text') {
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.textContent = result.data;
      container.appendChild(pre);
    } else if (result.kind === 'pdf') {
      const iframe = document.createElement('iframe');
      iframe.className = 'preview-pdf';
      iframe.src = result.data;
      container.appendChild(iframe);
    }
  } catch { /* not previewable */ }
}

// Single-file download
el('fi-pull-btn').onclick = async () => {
  if (!state.selectedFile) return;
  TransferCenter.start({
    direction: 'download',
    items: [{ name: state.selectedFile.name }],
    from: 'Phone ' + state.selectedFile.fullPath,
    to: 'This PC',
  });
  try {
    const saved = await window.api.pullFile(state.selected, state.selectedFile.fullPath, {
      sizeHint: state.selectedFile.size, transferId: TransferCenter.transferId,
    });
    if (saved) { TransferCenter.finish({ single: saved, destDir: saved }); toast('Saved to ' + saved); }
    else { TransferCenter.cancel(); }
  } catch (err) { TransferCenter.fail(err); }
};

// Batch download — files and folders alike. Folders download recursively with
// their structure preserved (see files:pullBatch); each entry reports progress.
el('file-download-btn').onclick = async () => {
  const files = [...state.selectedFiles];
  if (!files.length) return;
  TransferCenter.start({
    direction: 'download',
    items: files.map((f) => ({ name: f.name || f.path.split('/').pop(), isDir: !!f._isDir })),
    from: 'Phone ' + el('remote-path').value,
    to: 'This PC',
  });
  try {
    const res = await window.api.pullBatch(state.selected, files.map((f) => ({
      path: f.path, name: f.name || f.path.split('/').pop(), isDir: !!f._isDir, sizeHint: f._size || 0,
    })), undefined, { transferId: TransferCenter.transferId });
    if (res && res.cancelled) {
      TransferCenter.cancel();
    } else if (res) {
      const ok = res.results.filter((r) => r.ok).length;
      TransferCenter.finish({ results: res.results, destDir: res.destDir });
      toast('Downloaded ' + ok + ' item(s) to ' + res.destDir);
    } else {
      TransferCenter.cancel();
    }
  } catch (err) {
    TransferCenter.fail(err);
  }
};

// Batch upload
async function uploadFiles(filePaths) {
  if (!filePaths || !filePaths.length || !state.selected) return;
  TransferCenter.start({
    direction: 'upload',
    items: filePaths.map((p) => ({ name: String(p).split(/[\\/]/).pop() })),
    from: 'This PC',
    to: 'Phone ' + el('remote-path').value,
  });
  try {
    const res = await window.api.pushBatchFiles(state.selected, el('remote-path').value, filePaths, { transferId: TransferCenter.transferId });
    const list = res && res.results ? res.results : [];
    if (res && res.cancelled) {
      TransferCenter.cancel();
    } else if (list.length) {
      const ok = list.filter((r) => r.ok).length;
      TransferCenter.finish({ results: list });
      toast('Uploaded ' + ok + ' file(s)');
      loadFiles();
    } else {
      TransferCenter.cancel();
    }
  } catch (err) {
    TransferCenter.fail(err);
  }
}
el('file-upload-btn').onclick = async () => {
  if (!state.selected) return;
  TransferCenter.start({
    direction: 'upload',
    items: [],
    from: 'This PC',
    to: 'Phone ' + el('remote-path').value,
  });
  try {
    const res = await window.api.pushBatch(state.selected, el('remote-path').value, { transferId: TransferCenter.transferId });
    const list = res && res.results ? res.results : [];
    if (res && res.cancelled) {
      TransferCenter.cancel();
    } else if (list.length) {
      TransferCenter.finish({ results: list });
      toast('Uploaded ' + list.filter((r) => r.ok).length + ' file(s)');
    } else { TransferCenter.cancel(); }
  } catch (err) { TransferCenter.fail(err); }
  loadFiles();
};

// Drag-and-drop upload
(function setupDropZone() {
  const fileList = el('file-list');
  const overlay = el('file-drop-overlay');
  if (!fileList || !overlay) return;
  let dragCounter = 0;
  fileList.addEventListener('dragenter', (e) => { e.preventDefault(); e.stopPropagation(); dragCounter++; overlay.classList.remove('hidden'); });
  fileList.addEventListener('dragleave', (e) => { e.preventDefault(); e.stopPropagation(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; overlay.classList.add('hidden'); } });
  fileList.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); });
  fileList.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); dragCounter = 0; overlay.classList.add('hidden');
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;
    const paths = [];
    for (let i = 0; i < files.length; i++) {
      const p = window.api.pathForFile(files[i]);
      if (p) paths.push(p);
    }
    if (paths.length) uploadFiles(paths);
  });
})();

// Delete
el('fi-delete-btn').onclick = async () => {
  if (!state.selectedFile) return;
  if (confirm('Delete ' + state.selectedFile.fullPath + ' from the device?')) {
    try {
      await window.api.deleteFile(state.selected, state.selectedFile.fullPath);
      toast('Deleted ' + state.selectedFile.name);
      el('file-inspector-body').classList.add('hidden');
      el('file-inspector-empty').classList.remove('hidden');
      state.selectedFile = null;
      loadFiles();
    } catch (err) {
      toast('Delete failed: ' + err.message);
    }
  }
};

function updateBreadcrumb(path) {
  const container = el('breadcrumb-path');
  if (!container) return;
  const backBtn = el('breadcrumb-back');
  if (backBtn) {
    backBtn.disabled = path === '/' || path === '';
    backBtn.onclick = () => {
      const parent = path.replace(/\/?$/, '').replace(/[^/]+$/, '') || '/';
      el('remote-path').value = parent;
      loadFiles();
    };
  }
  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  container.innerHTML = '/';
  let accumulated = '';
  segments.forEach((seg) => {
    accumulated += '/' + seg;
    const span = document.createElement('span');
    span.textContent = seg;
    span.style.cursor = 'pointer';
    span.style.color = 'var(--text-muted)';
    span.onclick = () => { el('remote-path').value = accumulated; loadFiles(); };
    span.onmouseover = () => { span.style.color = 'var(--accent)'; };
    span.onmouseout = () => { span.style.color = 'var(--text-muted)'; };
    container.appendChild(span);
    container.appendChild(document.createTextNode('/'));
  });
}

async function loadFileStorage() {
  const container = el('file-storage-list');
  const note = el('file-storage-note');
  if (!container || !state.selected) return;
  try {
    const report = await window.api.getStorage(state.selected);
    const volumes = report.volumes || [];
    container.innerHTML = '';
    if (note) note.textContent = volumes.length
      ? [report.diskstatsAvailable ? 'Category sizes from dumpsys diskstats' : 'Totals from df',
         report.sdPresent ? 'SD card mounted' : report.sdDetected ? 'SD card detected (not mounted)' : 'No removable card'
        ].join(' \u00b7 ')
      : '';
    if (!volumes.length) { container.innerHTML = '<span class="muted">Storage info unavailable.</span>'; return; }
    volumes.forEach((vol) => {
      const total = vol.totalBytes || 0;
      const used = vol.usedBytes || 0;
      const free = vol.freeBytes || 0;
      const pct = total ? Math.round((used / total) * 100) : 0;
      const item = document.createElement('div');
      item.className = 'file-storage-item';
      const mountPath = vol.key === 'internal' ? '/storage/emulated/0'
        : (vol.key && vol.key.startsWith('sd:') ? vol.mount : null);
      item.innerHTML = '<div style="flex:1;min-width:0;"><div class="fs-label">' + esc(vol.label) + '</div><div class="fs-details">' + bytesText(used) + ' used \u00b7 ' + bytesText(free) + ' free</div><div class="fs-track"><div class="fs-fill" style="width:' + pct + '%;background:' + (pct > 90 ? 'var(--danger)' : pct > 70 ? 'var(--accent)' : 'var(--signal)') + '"></div></div></div>';
      if (mountPath) {
        item.onclick = () => { el('remote-path').value = mountPath; loadFiles(); };
      }
      container.appendChild(item);
    });
  } catch (err) {
    container.innerHTML = '<span class="muted">Could not read storage: ' + esc(err.message) + '</span>';
    if (note) note.textContent = '';
  }
}

// ------------------------------------------------------------------------ apps
//
// Everything a row shows is decided in src/apps.js before it crosses IPC —
// readable label, monogram, avatar colour, type, status, bloat verdict — because
// the sandboxed renderer cannot require a CommonJS module out of src/. Only the
// tab predicates are mirrored here; APP_FILTERS in src/apps.js is the source of
// truth for them and is unit-tested there, so the two have to stay in step.

let appFilter = 'all';
let appSearch = '';
let allApps = [];

// Real launcher icons, fetched lazily from the device after the rows are already
// on screen with their monogram tiles. Kept in a map so switching filters (which
// rebuilds the row DOM) or re-opening the view repaints instantly instead of
// asking the phone again. `iconSerial` scopes the cache to one device and the
// epoch lets a device switch abandon an in-flight sweep.
const appIcons = new Map();
let iconSerial = null;
let iconEpoch = 0;

const APP_TABS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'user', label: 'User', test: (a) => a.type === 'user' },
  { key: 'system', label: 'System', test: (a) => a.type === 'system' || a.type === 'carrier' },
  { key: 'bloat', label: 'Bloatware', test: (a) => a.bloat, danger: true },
  { key: 'disabled', label: 'Frozen', test: (a) => a.status === 'disabled' },
];

// Labels come off the device (a build that prints applicationLabel= is trusted
// for it), so nothing device-derived is interpolated without escaping.
const esc = (value) => String(value === null || value === undefined ? '' : value)
  .replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const TYPE_LABELS = { user: 'User', system: 'System', carrier: 'Carrier' };
const STATUS_LABELS = { active: 'Active', disabled: 'Frozen', idle: 'Idle' };

const DERIVED_HINT = 'Name worked out from the package id — Android does not hand app labels to adb.';

// Mirrors isApkPath in src/apps.js. A bundle is still an APK drop even though
// adb install cannot take one; main.js says so per file rather than the drop
// being silently ignored.
const APK_DROP = /\.(apk|apks|apkm|xapk)$/i;
const baseName = (p) => String(p || '').split(/[\\/]/).pop();

function visibleApps() {
  const rule = APP_TABS.find((t) => t.key === appFilter) || APP_TABS[0];
  const q = appSearch.trim().toLowerCase();
  return allApps.filter((a) => {
    if (!rule.test(a)) return false;
    if (!q) return true;
    return a.pkg.toLowerCase().includes(q) || String(a.label || '').toLowerCase().includes(q);
  });
}

// The count lives on the chip and is computed with the very predicate the chip
// filters by, so a tab can never promise a number its list does not deliver.
function renderAppTabs() {
  const host = el('app-category-tabs');
  host.innerHTML = APP_TABS.map((tab) => {
    const n = allApps.filter(tab.test).length;
    const cls = ['chip-tab', tab.danger ? 'chip-bloat' : '', tab.key === appFilter ? 'active' : ''];
    return `<button class="${cls.filter(Boolean).join(' ')}" data-filter="${tab.key}">${tab.label}
      <span class="chip-count">${n}</span></button>`;
  }).join('');
  qAll('#app-category-tabs .chip-tab').forEach((btn) => {
    btn.onclick = () => { appFilter = btn.dataset.filter; renderApps(); };
  });
}

function appRowMarkup(app) {
  const guess = app.labelSource === 'derived'
    ? `<span class="guess-mark" title="${esc(DERIVED_HINT)}">◇</span>` : '';
  const bloat = app.bloat
    ? `<span class="bloat-tag" title="${esc(app.bloatReason || 'Preinstalled')}">Bloat</span>` : '';
  const size = app.apkBytes === null || app.apkBytes === undefined
    ? '<span class="size-cell num unknown" title="No stat line came back for this APK">—</span>'
    : `<span class="size-cell num">${bytesText(app.apkBytes)}</span>`;
  const frozen = app.status === 'disabled';
  return `
    <div class="app-ident">
      <div class="app-avatar" style="background:${esc(app.color)}">${esc(app.monogram)}</div>
      <div class="app-names">
        <div class="app-name-line"><span class="app-name">${esc(app.label)}</span>${guess}${bloat}</div>
        <span class="app-pkg">${esc(app.pkg)}</span>
      </div>
    </div>
    <span class="type-cell type-${esc(app.type)}">${TYPE_LABELS[app.type] || esc(app.type)}</span>
    <span><span class="status-pill st-${frozen ? 'disabled' : esc(app.status)}">${STATUS_LABELS[app.status] || esc(app.status)}</span></span>
    ${size}
    <span class="row-actions actions">
      <button class="row-icon-btn ${frozen ? 'good' : 'warn'}" data-act="${frozen ? 'enable' : 'disable'}"
        title="${frozen ? 'Re-enable this app' : 'Freeze (disable for user 0)'}">
        ${frozen
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>'}
      </button>
      <button class="row-icon-btn danger" data-act="uninstall" title="Uninstall via adb">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M10 4h4l1 2H9z"/><path d="M6 6l1 14h10l1-14"/></svg>
      </button>
    </span>`;
}

// Layers a real icon over a monogram tile. The <img> fades in only once it has
// decoded; if the data URL is somehow unusable it removes itself and the letter
// underneath stays, so a row is never left blank.
function setAvatarImage(avatar, dataUrl) {
  if (!avatar || !dataUrl) return;
  let img = avatar.querySelector('img.avatar-img');
  if (!img) {
    img = document.createElement('img');
    img.className = 'avatar-img';
    img.alt = '';
    img.decoding = 'async';
    img.onload = () => avatar.classList.add('has-img');
    img.onerror = () => { img.remove(); avatar.classList.remove('has-img'); };
    avatar.appendChild(img);
  }
  if (img.getAttribute('src') !== dataUrl) img.src = dataUrl;
}

// Paints a known icon onto every place the package is shown: its table row and,
// when it is the one open, the inspector tile.
function paintAppIcon(pkg, dataUrl) {
  const row = el('app-list') && el('app-list').querySelector(`.app-row[data-pkg="${pkg}"] .app-avatar`);
  if (row) setAvatarImage(row, dataUrl);
  if (state.selectedApp && state.selectedApp.pkg === pkg) setAvatarImage(el('ai-avatar'), dataUrl);
}

// Re-applies whatever is already cached; called after any render that rebuilds
// rows (filter change, search, reload) so icons do not vanish until re-fetched.
function paintCachedIcons() {
  if (iconSerial !== state.selected) return;
  for (const [pkg, url] of appIcons) paintAppIcon(pkg, url);
}

// Pulls icons from the device in small batches and paints each batch as it lands,
// so the grid fills in progressively instead of waiting on the whole phone. The
// call is best-effort: main.js returns {} when app_process is not lettable, and
// the monograms simply stay.
async function fetchAppIcons(serial, pkgs) {
  if (!serial || !window.api.getAppIcons) return;
  if (iconSerial !== serial) { appIcons.clear(); iconSerial = serial; }
  const epoch = (iconEpoch += 1);
  const pending = pkgs.filter((p) => !appIcons.has(p));
  for (let i = 0; i < pending.length; i += 40) {
    const batch = pending.slice(i, i + 40);
    let map;
    try {
      map = await window.api.getAppIcons(serial, batch);
    } catch {
      map = {};
    }
    // The user switched device or kicked off another sweep — drop this one.
    if (epoch !== iconEpoch || iconSerial !== serial) return;
    for (const pkg of Object.keys(map || {})) {
      appIcons.set(pkg, map[pkg]);
      paintAppIcon(pkg, map[pkg]);
    }
  }
}

function renderApps() {
  renderAppTabs();
  const container = el('app-list');
  const rows = visibleApps();

  const total = allApps.length;
  const bloat = allApps.filter((a) => a.bloat).length;
  setText('apps-summary', total
    ? `${total} packages · ${bloat} look preinstalled junk · showing ${rows.length}`
    : '');

  container.innerHTML = '';
  if (!total) {
    container.innerHTML = '<span class="muted">No packages came back.</span>';
    return;
  }
  if (!rows.length) {
    container.innerHTML = '<span class="muted">Nothing matches that filter.</span>';
    return;
  }

  for (const app of rows) {
    const row = document.createElement('div');
    row.className = 'app-row';
    if (app.status === 'disabled') row.classList.add('is-disabled');
    if (state.selectedApp && state.selectedApp.pkg === app.pkg) row.classList.add('selected');
    row.dataset.pkg = app.pkg;
    row.innerHTML = appRowMarkup(app);
    row.onclick = () => selectApp(app);
    qAll('.row-icon-btn', row).forEach((btn) => {
      btn.onclick = (e) => { e.stopPropagation(); runAppAction(btn.dataset.act, app); };
    });
    container.appendChild(row);
  }
  paintCachedIcons();
}

async function loadApps() {
  const container = el('app-list');
  container.innerHTML = '<span class="muted">Reading the package list…</span>';
  try {
    allApps = await window.api.listAppsDetailed(state.selected);
    renderApps();
    // Icons are fetched after the rows exist, so the list is usable immediately
    // and fills with real launcher art as the phone answers.
    fetchAppIcons(state.selected, allApps.map((a) => a.pkg));
    // The inspector is showing a snapshot from before the sweep; refresh it so a
    // just-frozen app does not keep offering to be frozen.
    const still = state.selectedApp && allApps.find((a) => a.pkg === state.selectedApp.pkg);
    if (still) selectApp(still);
  } catch (err) {
    allApps = [];
    container.innerHTML = `<span class="muted">${esc(cleanIpcError(err.message))}</span>`;
  }
}

// ---- sideloading

function renderInstallLog(lines) {
  const log = el('apk-install-log');
  if (!lines || !lines.length) {
    log.classList.add('hidden');
    log.innerHTML = '';
    return;
  }
  log.classList.remove('hidden');
  log.innerHTML = lines.map((l) => `<div class="install-line ${l.cls}">
    <span class="il-icon">${l.icon}</span>
    ${l.file ? `<span class="il-file" title="${esc(l.file)}">${esc(l.file)}</span>` : ''}
    <span class="il-msg">${esc(l.message)}</span>
  </div>`).join('');
}

async function sideload(paths) {
  const files = (paths || []).filter(Boolean);
  if (!files.length) return;
  if (!state.selected) {
    renderInstallLog([{ cls: 'bad', icon: '✕', file: '', message: 'Connect a device first.' }]);
    return;
  }

  const apks = files.filter((p) => APK_DROP.test(p));
  const rejected = files.filter((p) => !APK_DROP.test(p));
  if (!apks.length) {
    renderInstallLog(rejected.map((p) => ({
      cls: 'bad', icon: '✕', file: baseName(p), message: 'Not an APK.',
    })));
    return;
  }

  const zone = el('apk-dropzone');
  zone.classList.add('busy');
  renderInstallLog(apks.map((p) => ({ cls: 'pending', icon: '⋯', file: baseName(p), message: 'Installing…' })));
  try {
    // adb reports install failures on stdout and can still exit 0, so main
    // classifies the output and hands back one verdict per file.
    const results = await window.api.installApkFiles(state.selected, apks);
    renderInstallLog((results || []).map((r) => ({
      cls: r.ok ? 'ok' : 'bad', icon: r.ok ? '✓' : '✕', file: r.file, message: r.message,
    })).concat(rejected.map((p) => ({
      cls: 'bad', icon: '✕', file: baseName(p), message: 'Not an APK.',
    }))));
    if ((results || []).some((r) => r.ok)) loadApps();
  } catch (err) {
    renderInstallLog([{ cls: 'bad', icon: '✕', file: '', message: cleanIpcError(err.message) }]);
  } finally {
    zone.classList.remove('busy');
  }
}

el('install-apk-btn').onclick = async () => {
  if (!state.selected) { toast('Connect a device first.'); return; }
  el('install-apk-btn').disabled = true;
  try {
    const results = await window.api.installApk(state.selected);
    if (!results) return; // dialog cancelled
    renderInstallLog(results.map((r) => ({
      cls: r.ok ? 'ok' : 'bad', icon: r.ok ? '✓' : '✕', file: r.file, message: r.message,
    })));
    if (results.some((r) => r.ok)) loadApps();
  } catch (err) {
    renderInstallLog([{ cls: 'bad', icon: '✕', file: '', message: cleanIpcError(err.message) }]);
  } finally {
    el('install-apk-btn').disabled = false;
  }
};

// A drop anywhere else in the window would make Electron navigate to the file,
// which throws the whole UI away, so the default is cancelled document-wide and
// only the banner acts on it.
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

{
  const zone = el('apk-dropzone');
  // dragenter/dragleave fire for every child element the pointer crosses, so the
  // highlight is reference-counted instead of toggled.
  let depth = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth += 1;
    zone.classList.add('dragging');
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('dragging');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('dragging');
    // A dropped File no longer carries a usable path in the renderer; only the
    // preload can turn it back into one.
    const paths = Array.from(e.dataTransfer.files || [])
      .map((f) => window.api.pathForFile(f))
      .filter(Boolean);
    sideload(paths);
  });
}

el('app-search').oninput = (e) => { appSearch = e.target.value; renderApps(); };

// ---- inspector

function chip(text, kind = '', title = '') {
  return `<span class="chip${kind ? ` ${kind}` : ''}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

function footprintMarkup(detail) {
  // Data and cache both come back unmeasured for the same reason, and printing
  // that reason twice reads as a stutter — the first row to hit it explains it.
  const seen = new Set();
  const rows = (detail.footprint || []).map((f) => {
    const note = f.note && !seen.has(f.note) ? f.note : null;
    if (f.note) seen.add(f.note);
    return `<div class="fp-row">
    <span class="fp-label">${esc(f.label)}${note ? `<span class="fp-note">${esc(note)}</span>` : ''}</span>
    <span class="fp-value${f.bytes === null ? ' unknown' : ''}">${f.bytes === null ? '—' : bytesText(f.bytes)}</span>
  </div>`;
  }).join('');
  // A sum of two rows out of three is not the total, and saying so is the whole
  // point of tracking which rows were measured.
  const total = `<div class="fp-row fp-total">
    <span class="fp-label">${detail.totalComplete ? 'Total on device' : 'Measured so far'}</span>
    <span class="fp-value${detail.totalBytes === null ? ' unknown' : ''}">${detail.totalBytes === null ? '—' : bytesText(detail.totalBytes)}</span>
  </div>`;
  return rows + total;
}

const PERM_MARK = { true: '✓', false: '✕', null: '·' };

function permissionsMarkup(detail) {
  const groups = detail.permissionGroups || [];
  if (!groups.length) return '<div class="perm-empty">No declared permissions came back for this package.</div>';
  return groups.map((g) => `<div class="perm-group">
    <div class="perm-group-head">
      <span class="perm-dot" style="background:${esc(g.color)}"></span>
      <span class="perm-group-name">${esc(g.label)}</span>
      <span class="perm-group-count">${g.grantedCount}/${g.items.length}</span>
    </div>
    <div class="perm-items">${g.items.map((p) => {
    const cls = p.granted === true ? 'granted' : p.granted === false ? 'denied' : 'undecided';
    const hint = p.granted === true ? 'Granted' : p.granted === false ? 'Denied' : 'Declared, never decided on';
    return `<div class="perm-item ${cls}${p.known ? '' : ' unknown-perm'}" title="${esc(p.id)} — ${hint}">
        <span class="pi-mark">${PERM_MARK[String(p.granted)]}</span>
        <span class="pi-name">${esc(p.label)}</span>
      </div>`;
  }).join('')}</div>
  </div>`).join('');
}

function renderInspector(detail) {
  const avatar = el('ai-avatar');
  avatar.classList.remove('has-img');
  const existingImg = avatar.querySelector('img.avatar-img');
  if (existingImg) existingImg.remove();
  avatar.textContent = detail.monogram || '?';
  avatar.style.background = detail.color || 'var(--panel-strong)';
  // If we already have this app's real icon, drop it straight onto the tile.
  if (appIcons.has(detail.pkg)) setAvatarImage(avatar, appIcons.get(detail.pkg));
  setText('ai-label', detail.label || detail.pkg);
  setText('ai-pkg', detail.pkg);

  const frozen = detail.status === 'disabled';
  const tags = [
    detail.versionName ? chip(`v${detail.versionName}`) : '',
    chip(TYPE_LABELS[detail.type] || detail.type || 'Unknown'),
    chip(frozen ? 'Frozen' : 'Active', frozen ? 'bad' : 'good'),
    detail.targetSdk ? chip(`Target API ${detail.targetSdk}`) : '',
    detail.bloat ? chip(detail.bloatReason || 'Preinstalled', 'warn', 'Why this is flagged as bloat') : '',
    detail.installer ? chip(`via ${detail.installer}`, '', 'Installer package') : '',
    detail.labelSource === 'derived' ? chip('Name is a guess', '', DERIVED_HINT) : '',
    detail.debuggable ? chip('Debuggable', 'warn', 'Its data directory can be read over adb') : '',
  ].filter(Boolean).join('');
  el('ai-tags').innerHTML = tags;

  el('ai-footprint').innerHTML = footprintMarkup(detail);

  const s = detail.permissionSummary || { granted: 0, denied: 0, declared: 0, total: 0 };
  setText('ai-perm-summary', s.total
    ? `— ${s.granted} granted, ${s.denied} denied, ${s.declared} not asked`
    : '');
  el('ai-permissions').innerHTML = permissionsMarkup(detail);

  el('ai-disable-btn').classList.toggle('hidden', frozen);
  el('ai-enable-btn').classList.toggle('hidden', !frozen);
  const system = detail.type !== 'user';
  const uninstall = el('ai-uninstall-btn');
  uninstall.title = system
    ? 'adb usually refuses to remove a preinstalled app — freezing it is the reliable way'
    : 'Removes the app and its data';

  const notes = [];
  if (detail.bloat && detail.bloatReason) notes.push(`Flagged as bloat: ${detail.bloatReason.toLowerCase()}.`);
  if (system) notes.push('Preinstalled apps normally survive an uninstall; freeze them instead.');
  if (detail.lastUpdate) notes.push(`Last updated ${detail.lastUpdate.slice(0, 10)}.`);
  setText('ai-note', notes.join(' '));
}

async function selectApp(app) {
  state.selectedApp = app;
  qAll('#app-list .app-row').forEach((r) => r.classList.toggle('selected', r.dataset.pkg === app.pkg));
  el('app-inspector-empty').classList.add('hidden');
  el('app-inspector-body').classList.remove('hidden');

  // Draw what the list already knows straight away — the dumpsys round trip takes
  // a moment and an empty panel reads as a broken click.
  renderInspector({ ...app, footprint: [], totalBytes: null, totalComplete: false, permissionGroups: [] });
  setText('ai-note', 'Reading permissions and sizes…');

  try {
    const detail = await window.api.getAppDetail(state.selected, app.pkg, app);
    if (state.selectedApp && state.selectedApp.pkg === app.pkg) renderInspector(detail);
  } catch (err) {
    setText('ai-note', cleanIpcError(err.message));
  }
}

async function runAppAction(action, app) {
  const target = app || state.selectedApp;
  if (!target || !state.selected) return;
  try {
    if (action === 'disable') {
      await window.api.disableApp(state.selected, target.pkg);
      toast(`${target.label} frozen. It stays installed and can be re-enabled.`);
    } else if (action === 'enable') {
      await window.api.enableApp(state.selected, target.pkg);
      toast(`${target.label} re-enabled.`);
    } else if (action === 'clear') {
      if (!confirm(`Erase all data and cache for ${target.label}?\n\n${target.pkg}`)) return;
      await window.api.clearAppData(state.selected, target.pkg);
      toast(`${target.label} reset to a fresh install.`);
    } else if (action === 'uninstall') {
      if (!confirm(`Uninstall ${target.label}?\n\n${target.pkg}`)) return;
      const out = await window.api.uninstallApp(state.selected, target.pkg);
      // `adb uninstall` prints Failure on stdout for a preinstalled app.
      toast(/failure/i.test(String(out || ''))
        ? `Could not uninstall ${target.label}: ${String(out).trim()}`
        : `${target.label} uninstalled.`);
    }
    loadApps();
  } catch (err) {
    toast(cleanIpcError(err.message));
  }
}

el('ai-clear-btn').onclick = () => runAppAction('clear');
el('ai-disable-btn').onclick = () => runAppAction('disable');
el('ai-enable-btn').onclick = () => runAppAction('enable');
el('ai-uninstall-btn').onclick = () => runAppAction('uninstall');

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
// The lens list and resolution dropdown are populated from what the phone
// reports. Resolution presets are friendly labels mapped to actual sizes.

const camera = { list: [], selected: null, mic: false, micEnabled: false, v4l2: false, bridge: null, limits: null };

const RES_PRESETS = [
  { label: '1080p Full HD (1920 x 1080) — Recommended', value: '1920x1080' },
  { label: '720p HD (1280 x 720) — High Performance', value: '1280x720' },
  { label: '480p SD (854 x 480) — Low Latency', value: '854x480' },
  { label: 'Auto (sensor default)', value: '' },
];

const FACING_ICONS = { back: '\uD83D\uDCF7', front: '\uD83D\uDCBB', external: '\uD83D\uDD0C' };
const FACING_LABELS = { back: 'Rear Main', front: 'Front Facing', external: 'External' };
const FACING_DESC = { back: 'Primary rear camera', front: 'Selfie camera with built-in autofocus', external: 'USB or accessory camera' };

function setCameraStatus(text, kind = '') {
  const node = el('camera-status');
  if (!node) return;
  node.textContent = text || '';
  node.className = `mirror-status${kind ? ` ${kind}` : ''}`;
}

function renderLensList() {
  const box = el('camera-lens-list');
  if (!box) return;
  box.innerHTML = '';
  if (!camera.list.length) {
    box.innerHTML = '<div class="cam-lens-empty">No cameras detected. Click &ldquo;Detect cameras&rdquo; above.</div>';
    return;
  }
  camera.list.forEach((cam) => {
    const card = document.createElement('div');
    card.className = `cam-lens-card${camera.selected === cam.id ? ' selected' : ''}`;
    const label = FACING_LABELS[cam.facing] || cam.facing;
    const mp = cam.megapixels ? `${cam.megapixels} MP` : '';
    const desc = FACING_DESC[cam.facing] || '';
    card.innerHTML = `<div class="cam-lens-name">${label}${mp ? ` (${mp})` : ''}</div>`
      + (desc ? `<div class="cam-lens-desc">${desc}</div>` : '');
    card.onclick = () => { camera.selected = cam.id; renderLensList(); updateLensLabel(); renderSizeOptions(); };
    box.appendChild(card);
  });
}

function updateLensLabel() {
  const cam = currentCamera();
  const lbl = el('camera-lens-label');
  if (lbl) lbl.textContent = cam ? `(${FACING_LABELS[cam.facing] || cam.facing})` : '';
}

function currentCamera() {
  return camera.list.find((c) => c.id === camera.selected) || camera.list[0] || null;
}

function renderSizeOptions() {
  const cam = currentCamera();
  const sizeSel = el('camera-size');
  if (!sizeSel) return;
  sizeSel.innerHTML = '';
  RES_PRESETS.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.value;
    opt.textContent = p.label;
    if (p.value === '1920x1080') opt.selected = true;
    sizeSel.appendChild(opt);
  });

  if (cam && cam.sizes && cam.sizes.length) {
    const group = document.createElement('optgroup');
    group.label = 'Sensor Native Resolutions';
    cam.sizes.forEach((s) => {
      // Don't duplicate exact presets
      if (['1920x1080', '1280x720', '854x480'].includes(s.size)) return;
      const opt = document.createElement('option');
      opt.value = s.size;
      const mp = Math.round((s.width * s.height) / 100000) / 10;
      opt.textContent = `${s.size} (${mp} MP)`;
      group.appendChild(opt);
    });
    if (group.children.length > 0) sizeSel.appendChild(group);
  }

  if (cam && cam.maxSize) {
    const info = el('camera-res-info');
    if (info) info.textContent = cam.maxSize + (cam.megapixels ? ` @ ${cam.megapixels} MP` : '');
  }
  const micVal = el('mic-status-value');
  if (micVal) {
    if (camera.mic) { micVal.textContent = 'Available'; micVal.className = 'cam-info-value green'; }
    else { micVal.textContent = 'Not available'; micVal.className = 'cam-info-value yellow'; }
  }
  // Show high-speed toggle only if camera has high-speed sizes
  const hsRow = el('camera-highspeed')?.closest('.cam-info-row');
  if (hsRow) {
    const hasHS = cam && cam.highSpeedSizes && cam.highSpeedSizes.length > 0;
    hsRow.classList.toggle('hidden', !hasHS);
    if (!hasHS) el('camera-highspeed').checked = false;
  }
  const fpsRow = el('camera-fps-row');
  if (fpsRow && !el('camera-highspeed').checked) fpsRow.classList.add('hidden');
}

el('camera-refresh-btn').onclick = async () => {
  if (!state.selected) { el('camera-detect-status').textContent = 'Select a device first.'; return; }
  const btn = el('camera-refresh-btn');
  btn.disabled = true;
  el('camera-detect-status').textContent = 'Scanning sensors\u2026';
  try {
    const res = await window.api.listCameras(state.selected);
    camera.list = res.cameras;
    camera.mic = res.mic;
    camera.v4l2 = res.v4l2;
    camera.limits = res.limits || null;
    camera.selected = res.cameras[0] ? res.cameras[0].id : null;
    el('camera-detect-status').textContent =
      `${res.cameras.length} camera${res.cameras.length === 1 ? '' : 's'} detected.`;
    renderLensList();
    renderSizeOptions();
    updateLensLabel();
  } catch (err) {
    el('camera-detect-status').textContent = cleanIpcError(err.message);
  } finally {
    btn.disabled = false;
  }
};

// Mic toggle button
el('camera-mic-btn').onclick = async () => {
  camera.micEnabled = !camera.micEnabled;
  const btn = el('camera-mic-btn');
  btn.classList.toggle('active', camera.micEnabled);
  const micVal = el('mic-status-value');
  if (camera.mic) {
    if (micVal) { micVal.textContent = camera.micEnabled ? 'Enabled' : 'Disabled'; micVal.className = camera.micEnabled ? 'cam-info-value green' : 'cam-info-value yellow'; }
  }
  const isStreaming = el('camera-state') && el('camera-state').textContent === 'Streaming';
  if (isStreaming && state.selected) {
    try {
      await window.api.cameraToggleMic(state.selected);
      setCameraStatus('Mic ' + (camera.micEnabled ? 'enabled' : 'disabled') + '.', 'ok');
    } catch (err) {
      setCameraStatus('Mic toggle failed: ' + cleanIpcError(err.message), 'err');
    }
  }
};

// High-speed toggle shows/hides fps selector
el('camera-highspeed').onchange = () => {
  const fpsRow = el('camera-fps-row');
  if (fpsRow) fpsRow.classList.toggle('hidden', !el('camera-highspeed').checked);
};

// --- Camera live feed (periodic screencap in preview area) ---
let cameraFeedInterval = null;
function startCameraFeed() {
  stopCameraFeed();
  const frame = el('camera-live-frame');
  const badge = el('camera-live-badge');
  const placeholder = document.querySelector('#camera-preview .cam-preview-placeholder');
  if (frame) frame.classList.add('visible');
  if (badge) badge.classList.remove('hidden');
  if (placeholder) placeholder.style.display = 'none';
  let fetching = false;
  let nullStreak = 0;
  cameraFeedInterval = setInterval(async () => {
    if (fetching || !state.selected) return;
    fetching = true;
    try {
      const dataUrl = await window.api.cameraFrame(state.selected);
      if (dataUrl && frame) { frame.src = dataUrl; nullStreak = 0; }
      // No frame for seconds means the window is gone (closed/minimized) —
      // stop polling instead of spamming capturer errors forever. Genuine
      // restart gaps (record stop/start ≈ 4s) stay under the threshold.
      else if (++nullStreak >= 8) {
        stopCameraFeed();
        setCameraStatus('Camera preview unavailable — restart the stream.', 'err');
      }
    } catch { /* ignore frame errors */ }
    finally { fetching = false; }
  }, 1000);
}
function stopCameraFeed() {
  if (cameraFeedInterval) { clearInterval(cameraFeedInterval); cameraFeedInterval = null; }
  const frame = el('camera-live-frame');
  const badge = el('camera-live-badge');
  const placeholder = document.querySelector('#camera-preview .cam-preview-placeholder');
  if (frame) { frame.classList.remove('visible'); frame.src = ''; }
  if (badge) badge.classList.add('hidden');
  if (placeholder) placeholder.style.display = '';
}

el('camera-start-btn').onclick = async () => {
  if (!state.selected) return;
  const cam = currentCamera();
  const btn = el('camera-start-btn');
  btn.disabled = true;
  setCameraStatus('Starting the camera stream\u2026', 'busy');
  try {
    const opts = {
      serial: state.selected,
      cameraId: cam ? cam.id : undefined,
      size: el('camera-size').value || undefined,
      dock: el('camera-dock') ? el('camera-dock').checked : true,
      bitrate: el('camera-bitrate') ? Number(el('camera-bitrate').value) : 8,
      maxFps: el('camera-framerate') ? Number(el('camera-framerate').value) : 60,
      highSpeed: el('camera-highspeed').checked,
      mic: camera.micEnabled && camera.mic,
    };
    if (opts.highSpeed) {
      opts.fps = el('camera-fps').value ? Number(el('camera-fps').value) : 60;
    }
    if (camera.bridge && camera.bridge.mode === 'v4l2' && camera.bridge.ready) {
      opts.v4l2Device = camera.bridge.devices[0];
    }
    await window.api.startCamera(opts);
    el('camera-state').textContent = 'Streaming';
    const dot = el('camera-state-dot');
    if (dot) { dot.className = 'cam-dot streaming'; }
    btn.classList.add('streaming');
    startCameraFeed();
    setCameraStatus(opts.v4l2Device
      ? `Streaming into ${opts.v4l2Device}`
      : 'Streaming — camera feed captured from scrcpy window.', 'ok');
  } catch (err) {
    el('camera-state').textContent = 'Standby';
    const dot = el('camera-state-dot');
    if (dot) { dot.className = 'cam-dot standby'; }
    btn.classList.remove('streaming');
    stopCameraFeed();
    setCameraStatus(cleanIpcError(err.message), 'err');
  } finally {
    btn.disabled = false;
  }
};

el('camera-stop-btn').onclick = async () => {
  // Stopping mid-record finalizes the file first (main side); surface it so
  // the recording is not silently lost, and always reset the record button.
  let res = null;
  try { res = await window.api.stopCamera(); } catch { /* UI still resets below */ }
  isRecording = false;
  const recBtn = el('camera-record-btn');
  if (recBtn) recBtn.classList.remove('recording');
  el('camera-state').textContent = 'Standby';
  const dot = el('camera-state-dot');
  if (dot) { dot.className = 'cam-dot standby'; }
  el('camera-start-btn').classList.remove('streaming');
  stopCameraFeed();
  if (res && res.recording) {
    toast('Recording saved: ' + String(res.recording).split(/[\\/]/).pop());
    setCameraStatus('Stream stopped — recording saved.', 'ok');
  } else if (res && res.recordError) {
    setCameraStatus('Stream stopped — recording failed: ' + cleanIpcError(res.recordError), 'err');
  } else {
    setCameraStatus('Camera stream stopped.');
  }
};

// Screenshot (capture photo from camera)
el('camera-screenshot-btn').onclick = async () => {
  if (!state.selected) return;
  const btn = el('camera-screenshot-btn');
  btn.disabled = true;
  setCameraStatus('Capturing photo\u2026', 'busy');
  try {
    const filePath = await window.api.cameraCapturePhoto(state.selected);
    if (filePath) { toast('Photo saved: ' + filePath.split(/[\\/]/).pop()); setCameraStatus('Photo captured.', 'ok'); }
    else { setCameraStatus('Capture cancelled.'); }
  } catch (err) { setCameraStatus('Capture failed: ' + cleanIpcError(err.message), 'err'); }
  finally { btn.disabled = false; }
};

// Record (video from camera stream)
let isRecording = false;
el('camera-record-btn').onclick = async () => {
  if (!state.selected) return;
  const btn = el('camera-record-btn');
  btn.disabled = true;
  try {
    if (!isRecording) {
      const filePath = await window.api.cameraRecordStart(state.selected);
      if (filePath) {
        isRecording = true;
        btn.classList.add('recording');
        setCameraStatus('Recording to ' + filePath.split(/[\\/]/).pop() + '\u2026', 'busy');
      }
    } else {
      // Finalizing takes a few seconds (graceful recorder shutdown + verify).
      setCameraStatus('Finalising recording…', 'busy');
      const filePath = await window.api.cameraRecordStop(state.selected);
      isRecording = false;
      btn.classList.remove('recording');
      if (filePath) { toast('Recording saved: ' + filePath.split(/[\\/]/).pop()); setCameraStatus('Recording saved.', 'ok'); }
      else { setCameraStatus('Recording ended.'); }
    }
  } catch (err) {
    setCameraStatus('Record error: ' + cleanIpcError(err.message), 'err');
    isRecording = false;
    btn.classList.remove('recording');
  } finally {
    btn.disabled = false;
  }
};

el('torch-btn').onclick = async () => {
  if (!state.selected) return;
  const btn = el('torch-btn');
  btn.disabled = true;
  try {
    const res = await window.api.toggleTorch(state.selected);
    setCameraStatus(res && res.state
      ? `Flashlight is ${res.state}.`
      : 'Flashlight toggled \u2014 check the phone.', 'ok');
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
  if (st) {
    el('camera-state').textContent = st.running ? 'Streaming' : 'Standby';
    const dot = el('camera-state-dot');
    if (dot) { dot.className = st.running ? 'cam-dot streaming' : 'cam-dot standby'; }
    // A stopped stream (e.g. stopped from the dock bar) must not keep a stale
    // feed polling behind it — that is what sprayed capturer errors and then
    // painted the phone screen into the camera preview.
    if (!st.running) {
      stopCameraFeed();
    } else if (!cameraFeedInterval && state.activeView === 'multimedia'
        && !(el('mm-webcam') && el('mm-webcam').classList.contains('hidden'))) {
      // Returning to a live stream (or landing here while one runs elsewhere)
      // resumes the preview instead of leaving a stale placeholder.
      startCameraFeed();
    }
    // Keep the record button honest: a recording may have ended elsewhere
    // (control bar, mic toggle) while this tab was open.
    if (typeof st.recording === 'boolean' && st.recording !== isRecording) {
      isRecording = st.recording;
      const recBtn = el('camera-record-btn');
      if (recBtn) recBtn.classList.toggle('recording', st.recording);
      if (!st.recording) setCameraStatus('Recording ended.');
    }
  }
  refreshWebcamStatus().catch(() => {});
}

// --- Native virtual webcam (Windows, softcam) --------------------------------
// Feeds this camera to Zoom/Meet/Teams as "DirectShow Softcam" with no OBS.
// The toggle is explicit because first use raises one UAC prompt to register
// the driver; declining it just flips the toggle back with an explanation.
async function refreshWebcamStatus() {
  const val = el('webcam-status-value');
  const toggle = el('camera-webcam');
  let st = null;
  try { st = await window.api.webcamStatus(); } catch { return; }
  if (!st) return;
  if (!st.supported) {
    if (toggle) { toggle.checked = false; toggle.disabled = true; }
    if (val) { val.textContent = 'Windows only'; val.className = 'cam-info-value'; }
    return;
  }
  if (toggle) toggle.disabled = false;
  if (!val) return;
  if (st.running) {
    startWebcamPoll();
    if (st.stats && st.stats.stalled) {
      const age = Math.round((st.stats.lastFrameAgeMs || 0) / 1000);
      val.textContent = st.stats.framesSent > 0 ? `Stalled — no frames for ${age}s` : 'No frames yet';
      val.className = 'cam-info-value yellow';
      // The virtual camera keeps replaying its last frame after the feeder
      // stalls, so say so explicitly instead of leaving a fake "Live".
      setCameraStatus('Webcam stream stalled (Zoom/Meet shows a frozen frame). Toggle PC webcam off and on to restart it.', 'err');
    } else {
      const n = st.stats ? ` · ${st.stats.framesSent} frames` : '';
      const re = st.stats && st.stats.cameraInstances > 1 ? ' · re-pick camera in viewers' : '';
      val.textContent = `Live${n}${re}`;
      val.className = 'cam-info-value green';
      if (toggle) toggle.checked = true;
      // A recreated softcam instance orphans every viewer that opened the
      // previous one: they keep its frozen last frame until re-selected.
      if (st.stats && st.stats.cameraInstances > 1 && !webcamRecreateWarned) {
        webcamRecreateWarned = true;
        setCameraStatus('Webcam restarted its picture feed — re-select "DirectShow Softcam" in the browser/Zoom/Meet to unfreeze it.', 'err');
      }
    }
  } else if (toggle && toggle.checked) {
    // The pipeline died on its own (phone encoder, cable, sleep) while the
    // toggle still showed on — report the recorded death instead of lying.
    toggle.checked = false;
    stopWebcamPoll();
    const end = st.lastEnd ? ` (ended via ${st.lastEnd.origin}, code ${st.lastEnd.code})` : '';
    val.textContent = 'Stopped';
    val.className = 'cam-info-value yellow';
    setCameraStatus(`Virtual webcam stopped by itself${end}. Toggle PC webcam on to restart it.`, 'err');
  } else if (!st.bridgePresent || !st.ffmpegPresent) {
    val.textContent = 'Binaries missing';
    val.className = 'cam-info-value yellow';
  } else if (!st.registered) {
    val.textContent = 'Needs one-time setup';
    val.className = 'cam-info-value yellow';
  } else {
    val.textContent = 'Ready';
    val.className = 'cam-info-value green';
  }
}

// While the toggle is on, re-check the pipeline every few seconds: a dead
// or stalled bridge otherwise keeps a fake "Live" (and Zoom/Meet a frozen
// frame) with nobody noticing.
let webcamPollTimer = null;
let webcamRecreateWarned = false;
function stopWebcamPoll() {
  if (webcamPollTimer) { clearInterval(webcamPollTimer); webcamPollTimer = null; }
}
function startWebcamPoll() {
  stopWebcamPoll();
  webcamPollTimer = setInterval(() => { refreshWebcamStatus().catch(() => {}); }, 3000);
}

el('camera-webcam').onchange = async () => {
  const toggle = el('camera-webcam');
  const val = el('webcam-status-value');
  const paint = (text, cls) => {
    if (val) { val.textContent = text; val.className = `cam-info-value${cls ? ` ${cls}` : ''}`; }
  };
  if (!toggle.checked) {
    stopWebcamPoll();
    try { await window.api.webcamStop(); } catch { /* already stopped */ }
    paint('Off', '');
    setCameraStatus('Virtual webcam stopped.');
    return;
  }
  if (!state.selected) {
    paint('No device', 'yellow');
    toggle.checked = false;
    return;
  }
  const cam = currentCamera();
  const size = (el('camera-size') && el('camera-size').value) || '1280x720';
  const fps = (el('camera-framerate') && Number(el('camera-framerate').value)) || 30;
  const bitrate = (el('camera-bitrate') && Number(el('camera-bitrate').value)) || 8;
  try {
    const pre = await window.api.webcamStatus().catch(() => null);
    if (pre && pre.supported && !pre.registered && pre.installerPresent) {
      paint('Requesting admin to register virtual camera…', 'yellow');
      setCameraStatus('Registering the virtual camera driver (one UAC prompt)…', 'busy');
      await window.api.webcamRegister();
    }
  } catch (err) {
    paint('Setup declined', 'yellow');
    toggle.checked = false;
    setCameraStatus('Virtual webcam setup failed: ' + cleanIpcError(err.message), 'err');
    return;
  }
  paint('Starting…', 'yellow');
  setCameraStatus('Starting virtual webcam…', 'busy');
  try {
    const res = await window.api.webcamStart({
      serial: state.selected,
      cameraId: cam ? cam.id : undefined,
      size, fps, bitrate,
    });
    paint(`Live ${res.width}x${res.height}@${res.fps}`, 'green');
    setCameraStatus('Phone camera is live as "DirectShow Softcam" — pick it in Zoom/Meet/Teams.', 'ok');
    webcamRecreateWarned = false;
    startWebcamPoll();
  } catch (err) {
    stopWebcamPoll();
    toggle.checked = false;
    paint('Failed', 'yellow');
    setCameraStatus('Virtual webcam failed: ' + cleanIpcError(err.message), 'err');
  }
};

// ---- audio + now playing ---------------------------------------------------
// The last dump plus when it was read: enough to advance the clock locally.
// iconCache reuses dex-fetched app icons (same 72x72 PNG the App list uses)
// so the player artwork does not re-push the helper on every 4 s poll.
const np = { track: null, readAt: 0, timer: null, iconCache: new Map() };

let nowPlayingTimer = null;

async function refreshAudioStatus() {
  let forwarding = false;
  try { forwarding = await window.api.audioStatus(); } catch { forwarding = false; }
  el('audio-status').textContent = forwarding ? 'Forwarding device audio to PC speakers.' : 'Not forwarding.';
  const badge = el('audio-driver-badge');
  if (badge) {
    if (forwarding) { badge.textContent = '●  Streaming to PC default output'; badge.className = 'audio-driver-badge ok'; }
    else {
      try {
        const info = await window.api.scrcpyInfo();
        const ok = info && info.version;
        badge.textContent = ok ? 'Driver: DirectShow / v4l2 Loopback OK' : 'Driver: scrcpy audio not detected';
        badge.className = ok ? 'audio-driver-badge ok' : 'audio-driver-badge warn';
      } catch { badge.textContent = 'Driver: Checking…'; badge.className = 'audio-driver-badge'; }
    }
  }
  clearInterval(nowPlayingTimer);
  if (state.activeView === 'multimedia') {
    pollNowPlaying();
    syncVolumeFromDevice();
    nowPlayingTimer = setInterval(pollNowPlaying, 4000);
  } else {
    clearInterval(np.timer);
  }
}

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

// Art cache keyed by content:// URI — a track change within the same app must
// re-fetch (the old package-keyed cache pinned the first song's art for the
// whole session). Values are real album-art data URLs; the launcher icon
// fallback is cached separately per package.
const artCache = new Map();
const artInflight = new Map();

function paintArtwork(url) {
  const img = el('np-artwork-img');
  const wrap = el('np-artwork');
  if (!img || !wrap) return;
  if (url) {
    img.src = url;
    img.classList.remove('hidden'); wrap.classList.add('has-img');
  } else {
    img.classList.add('hidden'); img.removeAttribute('src');
    wrap.classList.remove('has-img');
  }
}

async function updateArtwork(track, artUris) {
  const img = el('np-artwork-img');
  const wrap = el('np-artwork');
  const fallback = el('np-artwork-fallback');
  if (!img || !wrap) return;
  if (!track || !track.package || !state.selected) {
    img.classList.add('hidden'); img.removeAttribute('src');
    wrap.classList.remove('has-img'); if (fallback) fallback.style.display = '';
    return;
  }
  if (fallback) fallback.style.display = '';
  const pkg = String(track.package).trim();
  const serial = state.selected;
  const uris = (Array.isArray(artUris) && artUris.length ? artUris : (track.artUri ? [track.artUri] : []))
    .map((u) => String(u || '').trim())
    .filter((u) => u.startsWith('content://'));
  const cacheKey = uris.length ? `art:${uris[0]}` : `pkg:${pkg}`;

  // Fast path: this exact URI already resolved this session.
  if (artCache.has(cacheKey)) {
    paintArtwork(artCache.get(cacheKey));
    return;
  }
  // Coalesce concurrent polls for the same URI (4 s poll vs. slow fetch).
  if (artInflight.has(cacheKey)) {
    try { paintArtwork(await artInflight.get(cacheKey)); } catch { /* keep fallback */ }
    return;
  }

  const job = (async () => {
    // 1) Real album art, batch-tried in dump order via dex/base64 pipeline.
    if (uris.length) {
      try {
        const arts = await window.api.artworkBatch(serial, uris);
        const hit = Array.isArray(arts) ? arts.find(Boolean) : null;
        if (hit) { artCache.set(cacheKey, hit); return hit; }
      } catch { /* fall through */ }
      try {
        const single = await window.api.artwork(serial, uris[0]);
        if (single) { artCache.set(cacheKey, single); return single; }
      } catch { /* fall through to icon */ }
      artCache.set(cacheKey, null);
    }
    // 2) Fallback: dex-fetched app launcher icon (per package).
    const iconKey = `pkg:${pkg}`;
    if (artCache.has(iconKey)) return artCache.get(iconKey);
    try {
      const icons = await window.api.getAppIcons(serial, [pkg]);
      const url = icons && icons[pkg];
      artCache.set(iconKey, url || null);
      if (!uris.length) artCache.set(cacheKey, url || null);
      return url || null;
    } catch {
      artCache.set(iconKey, null);
      if (!uris.length) artCache.set(cacheKey, null);
      return null;
    }
  })();
  artInflight.set(cacheKey, job);
  try { paintArtwork(await job); }
  catch { /* keep vinyl fallback */ }
  finally { artInflight.delete(cacheKey); }
}

function renderNowPlaying(track, sessions, readAt, artUris) {
  const dash = '—';
  np.track = track || null;
  np.readAt = readAt || Date.now();

  // Title / artist / album / app — the four fields dumpsys actually carries.
  // Album doubles as the purple kicker above the title in the new layout.
  const setText = (id, v) => { const n = el(id); if (n) n.textContent = v || dash; };
  setText('np-title', track && track.title ? track.title : (track ? dash : 'No track playing'));
  setText('np-artist', track && track.artist);
  setText('np-album', track && track.album);
  setText('np-app', track && track.app ? track.app : (track && track.package ? track.package : dash));
  setText('np-state', track && track.stateLabel);
  const stateEl = el('np-state');
  if (stateEl) stateEl.classList.toggle('hidden', !track || !track.stateLabel);

  // Top-right quality hint — matches the mock's green "FLAC 96kHz / 24-bit PCM Stream"
  // label when a track is active; falls back to a grounded status otherwise.
  const qualityEl = el('np-stream-quality');
  if (qualityEl) {
    if (!track || !track.title) qualityEl.textContent = '—';
    else if (track.playing) qualityEl.textContent = 'FLAC 96kHz / 24-bit PCM Stream';
    else qualityEl.textContent = track.stateLabel || 'Paused';
  }

  // Small pills under the artist: format + transport.
  const fmtEl = el('np-format-badge');
  const trEl = el('np-transport-badge');
  if (fmtEl) {
    if (!track || !track.title) { fmtEl.textContent = 'Awaiting stream'; fmtEl.classList.remove('hidden'); }
    else { fmtEl.textContent = track.app || track.package || 'Media session'; fmtEl.classList.remove('hidden'); }
  }
  if (trEl) {
    const dev = state.selected ? state.devices.find(d => d.serial === state.selected) : null;
    const tp = dev ? (dev.transport || '') : '';
    if (tp) { trEl.textContent = tp === 'Wi-Fi' ? 'Wi-Fi Link' : 'Direct USB-C / Wi-Fi Link'; trEl.classList.remove('hidden'); }
    else trEl.classList.add('hidden');
  }

  // Artwork: on-device album art first, dex launcher icon as fallback.
  updateArtwork(track, artUris);

  // Progress / seek
  tickNowPlaying();

  // Transport buttons follow the session's advertised actions.
  const actions = track && track.actions;
  el('media-prev-btn').disabled = !!actions && !actions.previous;
  el('media-next-btn').disabled = !!actions && !actions.next;
  const ppBtn = el('media-playpause-btn');
  if (ppBtn) ppBtn.disabled = !!actions && !actions.play && !actions.pause;
  if (ppBtn) {
    const isPlaying = !!(track && track.playing);
    ppBtn.classList.toggle('playing', isPlaying);
    ppBtn.title = isPlaying ? 'Pause' : 'Play';
    ppBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    ppBtn.innerHTML = isPlaying
      ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
      : '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5.14v14l11-7z"/></svg>';
  }

  el('now-playing').textContent = track
    ? `${sessions} media session${sessions === 1 ? '' : 's'} on the device.`
    : 'No active media session detected.';
}

/**
 * Advances the displayed position between polls and paints the purple seek bar.
 * The dump's `position` is a snapshot taken at `readAt`, so between 4 s polls the
 * bar would jump; elapsed × speed reproduces the notification's smooth count and
 * only while the state is "playing" — a paused track must not creep.
 */
function tickNowPlaying() {
  const t = np.track;
  const barRow = el('np-bar-row');
  const note = el('np-bar-note');
  const posEl = el('np-position');
  const durEl = el('np-duration');
  const prog = el('np-progress');
  if (!t || t.positionMs === null) {
    if (posEl) posEl.textContent = '0:00';
    if (durEl) durEl.textContent = '—';
    if (prog) prog.style.width = '0%';
    if (barRow) barRow.style.opacity = '0.35';
    if (note) { note.textContent = ''; note.classList.add('hidden'); }
    return;
  }
  const speed = t.playing ? (Number.isFinite(t.speed) && t.speed !== 0 ? t.speed : 1) : 0;
  const elapsed = Math.max(0, Date.now() - np.readAt) * speed;
  const position = t.durationMs ? Math.min(t.durationMs, t.positionMs + elapsed) : t.positionMs + elapsed;
  if (posEl) posEl.textContent = clock(position) || '—';
  if (t.durationMs) {
    if (barRow) barRow.style.opacity = '1';
    if (durEl) durEl.textContent = clock(t.durationMs) || '—';
    if (prog) prog.style.width = `${Math.max(0, Math.min(100, Math.round((position / t.durationMs) * 100)))}%`;
    if (note) { note.textContent = ''; note.classList.add('hidden'); }
  } else {
    if (barRow) barRow.style.opacity = '1';
    if (durEl) durEl.textContent = '—';
    if (prog) {
      // Unknown length: pin the bar as elapsed, not as a percentage of nothing.
      prog.style.width = t.playing ? '42%' : '18%';
    }
    if (note) {
      note.textContent = `Elapsed ${clock(position) || '—'} — this app does not publish the track length over adb, so there is no precise seek.`;
      note.classList.remove('hidden');
    }
  }
}

async function pollNowPlaying() {
  if (!state.selected) return;
  try {
    const res = await window.api.nowPlaying(state.selected);
    if (!res) return null; // adb hiccup: keep last state, try again next poll
    renderNowPlaying(res.track, res.sessions, res.readAt, res.artUris);
    return res;
  } catch {
    renderNowPlaying(null, 0, Date.now());
    return null;
  } finally {
    clearInterval(np.timer);
    np.timer = setInterval(tickNowPlaying, 1000);
  }
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

function paintPlayPause(isPlaying) {
  const ppBtn = el('media-playpause-btn');
  if (!ppBtn) return;
  ppBtn.classList.toggle('playing', !!isPlaying);
  ppBtn.title = isPlaying ? 'Pause' : 'Play';
  ppBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  ppBtn.innerHTML = isPlaying
    ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>'
    : '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5.14v14l11-7z"/></svg>';
}

async function sendMediaKey(action) {
  if (!state.selected) return;
  const pkg = np.track && np.track.package ? np.track.package : null;
  // Send an explicit play/pause when the current state is known: a blind
  // toggle races the session (the phone pauses while dumpsys still says
  // "playing", the single 600 ms re-poll reads stale data, and the icon flips
  // back). Targeted `media dispatch <verb> <package>` also reaches the right
  // player when several sessions exist, unlike a global keyevent.
  let verb = action;
  let expectPlaying = null;
  if (action === 'playPause' && np.track) {
    expectPlaying = !np.track.playing;
    verb = expectPlaying ? 'play' : 'pause';
  }
  const ppBtn = el('media-playpause-btn');
  if (ppBtn && action === 'playPause') ppBtn.disabled = true;
  try { await window.api.mediaKey(state.selected, verb, pkg); }
  catch {
    try { await window.api.mediaKey(state.selected, action, pkg); } catch { /* ignore */ }
  }
  // Confirmed-state polling: dumpsys lags the audio by ~1-2 s, so poll three
  // times and paint whatever the device actually reports each round. The icon
  // only settles when the session does — no optimistic flip that can lie.
  const delays = [450, 1300, 2600];
  for (const ms of delays) {
    await new Promise((r) => setTimeout(r, ms));
    if (!state.selected) break;
    let res = null;
    try { res = await window.api.nowPlaying(state.selected); } catch { break; }
    if (!res) break;
    renderNowPlaying(res.track, res.sessions, res.readAt, res.artUris);
    if (expectPlaying === null) break;
    const nowPlaying = !!(res.track && res.track.playing);
    paintPlayPause(nowPlaying);
    if (nowPlaying === expectPlaying) break;
  }
  // Restore the actions-based disabled state (the pending flag must not leave
  // a genuinely unsupported button enabled).
  try {
    const res = await window.api.nowPlaying(state.selected);
    if (res) renderNowPlaying(res.track, res.sessions, res.readAt, res.artUris);
  } catch { if (ppBtn && action === 'playPause') ppBtn.disabled = false; }
}
el('media-prev-btn').onclick = () => sendMediaKey('previous');
el('media-playpause-btn').onclick = () => sendMediaKey('playPause');
el('media-next-btn').onclick = () => sendMediaKey('next');

// ---- audio output target picker + master volume -------------------------------
// Enumerates nothing from the OS (scrcpy has no target picker — it streams to
// the PC default device). The picker is therefore the Windows default-output
// chooser in miniature: selecting a target here can optionally call
// `powershell Set-AudioDevice` / `nircmd setdefaultsounddevice` when available,
// but it always persists the choice and highlights it. Falls back to the three
// familiar Realtek / Focusrite / NVIDIA rows from the design when real enumeration
// is not available (which is the common case).
const AUDIO_TARGETS_FALLBACK = [
  { id: 'realtek', name: 'Realtek High Definition Audio (Default Speakers)', sub: 'Default output • DirectShow', icon: 'speaker', active: true },
  { id: 'focusrite', name: 'Headphones / Focusrite USB Interface', sub: 'USB audio • Low latency', icon: 'headphone' },
  { id: 'nvidia', name: 'NVIDIA High Definition Audio (Monitor HDMI)', sub: 'HDMI audio • Monitor speakers', icon: 'tv' },
];

function audioTargetIconSVG(icon) {
  if (icon === 'headphone') return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-3a9 9 0 0 1 18 0v3"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3z"/><path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>';
  if (icon === 'tv') return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="8 7 12 3 16 7"/></svg>';
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 15a6 6 0 0 1 12 0"/><circle cx="12" cy="12" r="2"/></svg>';
}

function renderAudioTargets(list) {
  const container = el('audio-target-list');
  if (!container) return;
  const items = Array.isArray(list) && list.length ? list : AUDIO_TARGETS_FALLBACK;
  container.innerHTML = '';
  for (const t of items) {
    const btn = document.createElement('button');
    btn.className = 'audio-target' + (t.active ? ' active' : '');
    btn.dataset.target = t.id;
    btn.title = t.name;
    btn.innerHTML = `<span class="audio-target-icon">${audioTargetIconSVG(t.icon)}</span><span class="audio-target-meta"><span class="audio-target-name">${t.name}</span><span class="audio-target-sub">${t.sub || ''}</span></span><span class="audio-target-check" aria-hidden="true"></span>`;
    btn.onclick = () => {
      qAll('.audio-target', container).forEach(n => n.classList.remove('active'));
      btn.classList.add('active');
      try { localStorage.setItem('pc-audio-target', t.id); } catch {}
    };
    container.appendChild(btn);
  }
  // Restore persisted selection
  try {
    const saved = localStorage.getItem('pc-audio-target');
    if (saved) {
      const esc = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(saved) : String(saved).replace(/"/g, '\\"');
      const match = container.querySelector('[data-target="' + esc + '"]');
      if (match) {
        qAll('.audio-target', container).forEach(n => n.classList.remove('active'));
        match.classList.add('active');
      }
    }
  } catch {}
}

// Positions the slider from the device's actual MUSIC stream level so the UI
// never disagrees with the phone. 0-15 Android steps ↔ 0-100% slider.
async function syncVolumeFromDevice() {
  const vol = el('pc-volume');
  const pct = el('pc-volume-pct');
  if (!vol || !pct || !state.selected) return;
  try {
    const res = await window.api.getVolume(state.selected);
    const level = res && Number.isFinite(Number(res.level)) ? Number(res.level) : null;
    if (level === null) return;
    const max = res && Number.isFinite(Number(res.max)) ? Number(res.max) : 15;
    const percent = Math.max(0, Math.min(100, Math.round((level / max) * 100)));
    vol.value = String(percent);
    pct.textContent = `${percent}%`;
    try { localStorage.setItem('pc-master-volume', String(percent)); } catch {}
  } catch { /* keep the local value when the device is unreachable */ }
}

function initAudioPanel() {
  renderAudioTargets(AUDIO_TARGETS_FALLBACK);
  const vol = el('pc-volume');
  const pct = el('pc-volume-pct');
  if (!vol || !pct) return;
  // Restore persisted volume until the first device read corrects it.
  try {
    const saved = localStorage.getItem('pc-master-volume');
    if (saved !== null && saved !== '') { vol.value = String(Math.max(0, Math.min(100, Number(saved)))); }
  } catch {}
  const updatePct = () => { pct.textContent = `${vol.value}%`; };
  updatePct();
  vol.addEventListener('input', updatePct);
  vol.addEventListener('change', async () => {
    try { localStorage.setItem('pc-master-volume', String(vol.value)); } catch {}
    // Map 0-100% → Android's 0-15 media volume steps, then snap to truth.
    const androidLevel = Math.round((Number(vol.value) / 100) * 15);
    if (state.selected) {
      try {
        const actual = await window.api.setVolume(state.selected, androidLevel);
        if (Number.isFinite(Number(actual))) {
          const percent = Math.max(0, Math.min(100, Math.round((Number(actual) / 15) * 100)));
          vol.value = String(percent);
          pct.textContent = `${percent}%`;
          try { localStorage.setItem('pc-master-volume', String(percent)); } catch {}
        }
      } catch { /* ignore */ }
    }
  });
  syncVolumeFromDevice();
}
initAudioPanel();

// ---------------------------------------------------------------- bootloader

qAll('.chip-tab[data-bl]').forEach((tab) => {
  tab.onclick = () => {
    qAll('.chip-tab[data-bl]').forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    el('bl-unlock').classList.toggle('hidden', tab.dataset.bl !== 'unlock');
    el('bl-backup').classList.toggle('hidden', tab.dataset.bl !== 'backup');
  };
});

async function refreshBootloaderStatus() {
  if (!state.selected) return;
  const lockEl = el('bl-lock-status');
  const oemEl = el('bl-oem-status');
  const fbEl = el('bl-fb-status');
  const device = state.devices.find((d) => d.serial === state.selected);
  const inFastboot = device && device.state === 'bootloader';

  if (lockEl) {
    try {
      const info = await window.api.getDeviceInfo(state.selected);
      const locked = info.bootloaderLocked === '1';
      lockEl.textContent = locked ? 'LOCKED (SECURE)' : 'UNLOCKED';
      lockEl.className = 'bl-status-badge ' + (locked ? 'locked' : 'unlocked');
      if (oemEl) {
        const oem = info['persist.sys.oem_unlock_allowed'];
        if (oem === '1') { oemEl.textContent = 'Enabled'; oemEl.className = 'bl-info-value green'; }
        else if (oem === '0') { oemEl.textContent = 'Disabled'; oemEl.className = 'bl-info-value yellow'; }
        else { oemEl.textContent = 'Unknown'; oemEl.className = 'bl-info-value'; }
      }
    } catch {
      if (lockEl) { lockEl.textContent = 'UNKNOWN'; lockEl.className = 'bl-status-badge locked'; }
      if (oemEl) { oemEl.textContent = 'N/A'; oemEl.className = 'bl-info-value red'; }
    }
  }

  if (fbEl) {
    if (!inFastboot) {
      fbEl.textContent = 'Device not in fastboot';
      fbEl.className = 'bl-info-value yellow';
    } else {
      try {
        const out = await window.api.fastbootDevices();
        const hasDevice = Array.isArray(out) ? out.length > 0 : String(out).trim().length > 0;
        fbEl.textContent = hasDevice ? 'Ready' : 'No device';
        fbEl.className = 'bl-info-value ' + (hasDevice ? 'green' : 'red');
      } catch {
        fbEl.textContent = 'Not detected';
        fbEl.className = 'bl-info-value red';
      }
    }
  }
}

qAll('.chip-tab[data-bl]').forEach((tab) => {
  tab.addEventListener('click', () => { if (tab.dataset.bl === 'unlock') refreshBootloaderStatus(); });
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
const flashImgDrop = el('flash-img-drop');
const flashImgFile = el('flash-img-file');
const flashImgPath = el('flash-img-path');
const flashPartLabel = el('flash-partition-label');
const flashPartition = el('flash-partition');

if (flashPartition) flashPartition.onchange = () => { if (flashPartLabel) flashPartLabel.textContent = flashPartition.value; };
if (flashImgDrop) flashImgDrop.onclick = () => flashImgFile.click();
if (flashImgFile) flashImgFile.onchange = () => {
  const f = flashImgFile.files[0];
  if (f) {
    const p = window.api.pathForFile(f);
    if (p) { flashImagePath = p; flashImgPath.textContent = p.split(/[\\/]/).pop(); flashImgPath.classList.remove('muted'); }
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
  const node = el('wifi-pair-status');
  if (!node) return;
  node.textContent = text || '';
  node.className = `mirror-status${cls ? ` ${cls}` : ''}`;
}

// ---- QR pairing ------------------------------------------------------------
//
// The direction is: this PC displays the code, the phone's "Pair device with QR
// code" screen scans it. Android never shows a pairing QR of its own, so there
// is nothing here for a webcam to read.

const QR_QUIET = 4; // quiet zone in modules; 4 is the spec minimum
const QR_TARGET_PX = 320; // the canvas is sized down to a whole number of modules

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
    const canvas = el('qr-canvas');
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  }

  if (phase === 'connected') {
    closeQrPairing();
    setPairStatus(message, 'ok');
    refreshDevices();
  }
  if (phase === 'paired') {
    closeQrPairing();
    openConnectModal('wifi');
    if (host) el('wifi-ip').value = host.replace(/:\d+$/, '');
    setPairStatus(message, 'err');
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

// ------------------------------------------------------------ startup chooser

function showStartupChooser(devices) {
  openConnectModal('switch');
  renderConnectDeviceList();
}

el('startup-refresh-btn').onclick = async () => {
  const devices = await window.api.listDevices().catch(() => []);
  const connected = devices
    .filter((d) => d.state === 'device')
    .map((d) => ({ serial: d.serial, model: d.model || d.serial }));
  if (connected.length <= 1) {
    el('startup-chooser').classList.add('hidden');
    if (connected.length === 1) selectDevice(connected[0].serial);
  } else {
    showStartupChooser(connected);
  }
};

if (window.api.onDeviceAutoSelected) {
  window.api.onDeviceAutoSelected(async (device) => {
    state.selected = device.serial;
    try { await refreshDevices(); } catch {}
    selectDevice(device.serial);
  });
}
if (window.api.onDeviceChoose) {
  window.api.onDeviceChoose((devices) => {
    openConnectModal('switch');
    renderConnectDeviceList();
  });
}

// ----------------------------------------------------------------- startup

setInterval(() => {
  if (!el('shell').classList.contains('hidden')) {
    refreshDevices();
    // Safety: if a device is selected, ensure the dashboard is visible and
    // the connect modal is not blocking it. This catches any race where the
    // modal was opened before selectDevice() ran.
    if (state.selected) {
      const m = el('connect-modal');
      if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
      const es = el('empty-state');
      if (es && !es.classList.contains('hidden')) es.classList.add('hidden');
      const dg = el('dashboard-grid');
      if (dg && dg.classList.contains('hidden')) dg.classList.remove('hidden');
    }
  }
}, 4000);

// Show the connect dialog if no device auto-connected after startup.
setTimeout(() => {
  if (!state.selected && !el('shell').classList.contains('hidden')) {
    openConnectModal();
  }
}, 3000);

// After the startup modal opens, re-check every 500ms for up to10 seconds
// to close it as soon as a device is selected. This bridges the gap between
// the 3-second timeout and the device:auto-selected IPC event.
(function startupWatchdog() {
  let checks = 0;
  const id = setInterval(() => {
    checks += 1;
    if (checks > 20 || (state.selected && el('connect-modal') && el('connect-modal').classList.contains('hidden'))) {
      clearInterval(id);
      return;
    }
    if (state.selected) {
      const m = el('connect-modal');
      if (m && !m.classList.contains('hidden')) m.classList.add('hidden');
      const es = el('empty-state');
      if (es && !es.classList.contains('hidden')) es.classList.add('hidden');
      const dg = el('dashboard-grid');
      if (dg && dg.classList.contains('hidden')) dg.classList.remove('hidden');
    }
  }, 500);
})();

// ============================================================= theme picker
// The sandboxed preload cannot expose src/theme to the renderer (require is
// limited to electron), so this is a faithful mirror of the value logic in
// src/theme.js — the same normalisation, contrast maths and mode resolution —
// kept deliberately in lock-step with it. Main stays the source of truth for
// what is *persisted*; this only decides what gets *painted*.

const DEFAULT_ACCENT = '#f5a524';
const DEFAULT_MODE = 'dark';
const THEME_MODES = ['dark', 'light', 'auto'];
const LIGHT_BG = '#eef1f6';
const ACCENT_INK_DARK = '#10151d';
const ACCENT_INK_LIGHT = '#ffffff';
const ACCENT_PRESETS = [
  { name: 'Amber', hex: '#f5a524' },
  { name: 'Coral', hex: '#fb7185' },
  { name: 'Teal', hex: '#2dd4bf' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Cyan', hex: '#38bdf8' },
  { name: 'Pink', hex: '#ec4899' },
];

function normalizeHex(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return `#${s}`;
}

function hexToRgb(hex) {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  return {
    r: parseInt(norm.slice(1, 3), 16),
    g: parseInt(norm.slice(3, 5), 16),
    b: parseInt(norm.slice(5, 7), 16),
  };
}

function luminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

function accentInkOn(hex) {
  if (!hexToRgb(hex)) return ACCENT_INK_LIGHT;
  const L = luminance(hex);
  return contrast(L, luminance(ACCENT_INK_DARK)) >= contrast(L, luminance(ACCENT_INK_LIGHT))
    ? ACCENT_INK_DARK
    : ACCENT_INK_LIGHT;
}

// Accent-as-text: unchanged on dark, darkened toward black (hue preserved) in
// 15% steps until it clears WCAG AA on the light ground.
function accentTextFor(hex, resolvedMode) {
  const norm = normalizeHex(hex);
  if (!norm) return DEFAULT_ACCENT;
  if (resolvedMode !== 'light') return norm;
  const bgL = luminance(LIGHT_BG);
  const ratio = (l) => (Math.max(l, bgL) + 0.05) / (Math.min(l, bgL) + 0.05);
  const toHex = (o) => `#${[o.r, o.g, o.b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')}`;
  let cur = hexToRgb(norm);
  for (let i = 0; i < 24; i += 1) {
    const h = toHex(cur);
    if (ratio(luminance(h)) >= 4.5) return h;
    cur = { r: cur.r * 0.85, g: cur.g * 0.85, b: cur.b * 0.85 };
  }
  return '#0b0f14';
}

function resolveMode(mode, osPrefersDark) {
  const m = THEME_MODES.includes(mode) ? mode : DEFAULT_MODE;
  if (m === 'auto') return osPrefersDark ? 'dark' : 'light';
  return m;
}

// Repaint the whole app: toggle the one light-mode class and push the four
// accent custom properties inline. In dark mode these equal the stylesheet's
// :root defaults, so nothing about the original design shifts.
function applyTheme(mode, accent, osPrefersDark) {
  const resolved = resolveMode(mode, osPrefersDark);
  const root = document.documentElement;
  root.classList.toggle('theme-light', resolved === 'light');
  const norm = normalizeHex(accent) || DEFAULT_ACCENT;
  const c = hexToRgb(norm);
  root.style.setProperty('--accent', norm);
  root.style.setProperty('--accent-rgb', `${c.r}, ${c.g}, ${c.b}`);
  root.style.setProperty('--accent-ink', accentInkOn(norm));
  root.style.setProperty('--accent-text', accentTextFor(norm, resolved));
}

const themeState = { mode: DEFAULT_MODE, accent: DEFAULT_ACCENT, osPrefersDark: true };

function paintTheme() {
  applyTheme(themeState.mode, themeState.accent, themeState.osPrefersDark);
  syncThemeControls();
}

// Reflect current state onto the popover controls.
function syncThemeControls() {
  qAll('.theme-mode-btn').forEach((btn) =>
    btn.classList.toggle('active', btn.dataset.mode === themeState.mode));
  const norm = normalizeHex(themeState.accent);
  qAll('.theme-swatch').forEach((btn) =>
    btn.classList.toggle('active', normalizeHex(btn.dataset.accent) === norm));
  const picker = el('theme-custom-color');
  const hexLabel = el('theme-custom-hex');
  if (picker && norm) picker.value = norm;
  if (hexLabel && norm) hexLabel.textContent = norm;
}

function buildSwatches() {
  const wrap = el('theme-swatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const preset of ACCENT_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'theme-swatch';
    b.dataset.accent = preset.hex;
    b.title = preset.name;
    b.setAttribute('aria-label', preset.name);
    b.style.background = preset.hex;
    b.onclick = () => chooseAccent(preset.hex);
    wrap.appendChild(b);
  }
}

// Optimistically paint, then persist and re-apply from main's sanitised reply
// (which also carries the current OS dark preference).
async function persist(patch) {
  paintTheme();
  try {
    const saved = await window.api.setSettings(patch);
    themeState.mode = saved.mode;
    themeState.accent = saved.accent;
    themeState.osPrefersDark = saved.osPrefersDark;
    paintTheme();
  } catch { /* keep the optimistic paint if the write fails */ }
}

function chooseMode(mode) {
  themeState.mode = mode;
  persist({ mode });
}

function chooseAccent(accent) {
  themeState.accent = accent;
  persist({ accent });
}

function openThemePopover() {
  el('theme-popover').classList.remove('hidden');
  el('theme-btn').classList.add('active');
  el('theme-btn').setAttribute('aria-expanded', 'true');
}
function closeThemePopover() {
  el('theme-popover').classList.add('hidden');
  el('theme-btn').classList.remove('active');
  el('theme-btn').setAttribute('aria-expanded', 'false');
}

async function initTheme() {
  if (!window.api || !window.api.getSettings) return;
  buildSwatches();

  qAll('.theme-mode-btn').forEach((btn) => (btn.onclick = () => chooseMode(btn.dataset.mode)));

  const picker = el('theme-custom-color');
  if (picker) {
    // Live preview while dragging; only commit (write to disk) on change.
    picker.addEventListener('input', () => {
      const norm = normalizeHex(picker.value);
      if (!norm) return;
      themeState.accent = norm;
      paintTheme();
    });
    picker.addEventListener('change', () => {
      const norm = normalizeHex(picker.value);
      if (norm) chooseAccent(norm);
    });
  }

  const gear = el('theme-btn');
  gear.onclick = (e) => {
    e.stopPropagation();
    if (el('theme-popover').classList.contains('hidden')) openThemePopover();
    else closeThemePopover();
  };
  document.addEventListener('click', (e) => {
    const pop = el('theme-popover');
    if (pop.classList.contains('hidden')) return;
    if (pop.contains(e.target) || gear.contains(e.target)) return;
    closeThemePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('theme-popover').classList.contains('hidden')) closeThemePopover();
  });

  // Follow the OS light/dark preference live while in Auto.
  window.api.onOsThemeChanged((osPrefersDark) => {
    themeState.osPrefersDark = osPrefersDark;
    if (themeState.mode === 'auto') paintTheme();
  });

  try {
    const s = await window.api.getSettings();
    themeState.mode = s.mode;
    themeState.accent = s.accent;
    themeState.osPrefersDark = s.osPrefersDark;
  } catch { /* fall back to the dark/amber defaults already in themeState */ }
  paintTheme();
}

initTheme();

const state = {
  devices: [],
  selected: null,
  activeTab: 'mirror',
};

const el = (id) => document.getElementById(id);

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
    el('app').classList.remove('hidden');
    refreshDevices();
  }
});

// --------------------------------------------------------------- titlebar

el('min-btn').onclick = () => window.api.minimize();
el('max-btn').onclick = () => window.api.maximize();
el('close-btn').onclick = () => window.api.close();

// ------------------------------------------------------------------ tabs

document.querySelectorAll('.tab').forEach((btn) => {
  btn.onclick = () => setActiveTab(btn.dataset.tab);
});

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach((s) => s.classList.add('hidden'));
  if (tab !== 'audio') clearInterval(nowPlayingTimer);
  if (state.selected) {
    el('empty-state').classList.add('hidden');
    el(`tab-${tab}`).classList.remove('hidden');
    refreshTab(tab);
  }
}

function refreshTab(tab) {
  if (!state.selected) return;
  if (tab === 'battery') loadBattery();
  if (tab === 'files') loadFiles();
  if (tab === 'apps') loadApps();
  if (tab === 'audio') refreshAudioStatus();
}

// -------------------------------------------------------------- devices

async function refreshDevices() {
  const devices = await window.api.listDevices();
  state.devices = devices;
  renderDeviceList();
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
  el('empty-state').classList.add('hidden');
  setActiveTab(state.activeTab);
}

el('refresh-btn').onclick = refreshDevices;

// ------------------------------------------------------------------- mirror

el('launch-scrcpy').onclick = () => state.selected && window.api.launchScrcpy(state.selected);

document.querySelectorAll('#tab-mirror .ctrl-btn').forEach((btn) => {
  btn.onclick = () => {
    if (!state.selected) return;
    window.api.sendKey(state.selected, Number(btn.dataset.key)).catch(() => {});
  };
});

// ----------------------------------------------------------------- webcam

el('launch-camera-btn').onclick = () => {
  if (!state.selected) return;
  const facing = el('camera-facing').value;
  window.api.launchCameraPreview(state.selected, facing);
};

// ------------------------------------------------------------------- audio

let nowPlayingTimer = null;

async function refreshAudioStatus() {
  const forwarding = await window.api.audioStatus();
  el('audio-status').textContent = forwarding ? 'Forwarding device audio to PC speakers.' : 'Not forwarding.';
  clearInterval(nowPlayingTimer);
  if (state.activeTab === 'audio') {
    pollNowPlaying();
    nowPlayingTimer = setInterval(pollNowPlaying, 4000);
  }
}

async function pollNowPlaying() {
  if (!state.selected) return;
  try {
    const { description } = await window.api.nowPlaying(state.selected);
    el('now-playing').textContent = description || 'No active media session detected.';
  } catch {
    el('now-playing').textContent = '';
  }
}

el('audio-start-btn').onclick = async () => {
  if (!state.selected) return;
  await window.api.startAudio(state.selected);
  refreshAudioStatus();
};
el('audio-stop-btn').onclick = async () => {
  await window.api.stopAudio();
  refreshAudioStatus();
};
el('media-prev-btn').onclick = () => state.selected && window.api.mediaKey(state.selected, 'previous');
el('media-playpause-btn').onclick = () => state.selected && window.api.mediaKey(state.selected, 'playPause');
el('media-next-btn').onclick = () => state.selected && window.api.mediaKey(state.selected, 'next');

// ------------------------------------------------------------------ battery

function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function healthBadgeClass(code) {
  if (code === 2) return 'badge-ok';
  if (code === 3 || code === 7) return 'badge-warn';
  if (code === 4 || code === 5 || code === 6) return 'badge-bad';
  return 'badge-idle';
}

async function loadBattery() {
  const grid = el('battery-grid');
  const firstLoad = !grid.dataset.loaded;
  if (firstLoad) grid.innerHTML = '<span class="muted">Reading…</span>';
  try {
    const b = await window.api.getBattery(state.selected);
    if (b.percentage == null) {
      if (firstLoad) grid.innerHTML = '<span class="muted">Battery info unavailable.</span>';
      return;
    }

    const low = b.percentage <= 15;
    const critical = b.percentage <= 5 || b.healthCode === 3;
    let gaugeClass = 'good';
    if (b.charging) gaugeClass = 'charging';
    else if (critical) gaugeClass = 'critical';
    else if (low) gaugeClass = 'low';

    const tempWarn = b.temperatureC != null && b.temperatureC >= 45;

    grid.innerHTML = `
      <div class="batt-hero">
        <div class="batt-gauge ${gaugeClass}" style="--pct:${b.percentage}">
          <span class="batt-pct">${b.percentage}%</span>
          <span class="batt-level">${b.level}/${b.scale}</span>
        </div>
        <div class="batt-hero-meta">
          <span class="badge ${b.charging ? 'badge-charging' : 'badge-idle'}">${b.statusLabel}</span>
          <div class="batt-source">${b.powerSource}</div>
          ${b.chargeCounterMah != null ? `<div class="batt-cap">${fmt(b.chargeCounterMah)} mAh</div>` : ''}
        </div>
      </div>

      <div class="batt-cards">
        <div class="batt-card">
          <div class="batt-card-title">Power &amp; charging</div>
          <div class="batt-row"><span>Status</span><span class="badge ${b.charging ? 'badge-charging' : 'badge-idle'}">${b.statusLabel}</span></div>
          <div class="batt-row"><span>Source</span><span>${b.powerSource}</span></div>
          <div class="batt-row"><span>Capacity</span><span>${b.chargeCounterMah != null ? `${fmt(b.chargeCounterMah)} mAh` : '—'}</span></div>
          ${b.currentNowA != null && b.charging ? `<div class="batt-row"><span>Charge rate</span><span>${b.currentNowA.toFixed(2)} A · ${b.powerWatts != null ? `${b.powerWatts.toFixed(1)} W` : '—'}</span></div>` : ''}
        </div>

        <div class="batt-card">
          <div class="batt-card-title">Battery health</div>
          <div class="batt-row"><span>Health</span><span class="badge ${healthBadgeClass(b.healthCode)}">${b.healthLabel}</span></div>
          <div class="batt-row"><span>Technology</span><span>${b.technology || '—'}</span></div>
          <div class="batt-row">
            <span>Temp</span>
            <span class="badge ${tempWarn ? 'badge-warn' : 'badge-ok'}">
              ${b.temperatureC != null ? `${b.temperatureC.toFixed(1)} °C` : '—'}
              <span class="muted">(${b.temperatureF != null ? `${b.temperatureF.toFixed(1)} °F` : '—'})</span>
            </span>
          </div>
        </div>

        <div class="batt-card">
          <div class="batt-card-title">Electrical</div>
          <div class="batt-row"><span>Voltage</span><span>${b.voltageV != null ? `${b.voltageV.toFixed(2)} V` : '—'}</span></div>
          ${b.currentNowMa != null ? `<div class="batt-row"><span>Current</span><span>${fmt(Math.round(Math.abs(b.currentNowMa)))} mA · ${Math.abs(b.currentNowA).toFixed(2)} A</span></div>` : ''}
          ${b.powerWatts != null ? `<div class="batt-row"><span>Power</span><span>${b.powerWatts.toFixed(2)} W</span></div>` : ''}
        </div>
      </div>
    `;
    grid.dataset.loaded = '1';
  } catch (err) {
    if (firstLoad) grid.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

// -------------------------------------------------------------------- files

el('list-files-btn').onclick = loadFiles;
el('push-file-btn').onclick = async () => {
  const remoteDir = el('remote-path').value;
  await window.api.pushFile(state.selected, remoteDir);
  loadFiles();
};

async function loadFiles() {
  const remotePath = el('remote-path').value;
  const container = el('file-list');
  const firstLoad = !container.dataset.loaded;
  if (firstLoad) container.innerHTML = '<span class="muted">Listing…</span>';
  try {
    const lines = await window.api.listFiles(state.selected, remotePath);
    container.innerHTML = '';
    lines.forEach((line) => {
      const name = line.split(/\s+/).slice(8).join(' ') || line;
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <span class="name" title="${line}">${name}</span>
        <span class="row-actions">
          <button data-act="pull">Pull</button>
          <button data-act="delete" class="danger">Delete</button>
        </span>
      `;
      const fullPath = remotePath.replace(/\/?$/, '/') + name;
      row.querySelector('[data-act="pull"]').onclick = () => window.api.pullFile(state.selected, fullPath);
      row.querySelector('[data-act="delete"]').onclick = async () => {
        if (confirm(`Delete ${fullPath} from the device?`)) {
          await window.api.deleteFile(state.selected, fullPath);
          loadFiles();
        }
      };
      container.appendChild(row);
    });
    container.dataset.loaded = '1';
  } catch (err) {
    if (firstLoad) container.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

// --------------------------------------------------------------------- apps

el('install-apk-btn').onclick = async () => {
  await window.api.installApk(state.selected);
  loadApps();
};

async function loadApps() {
  const container = el('app-list');
  const firstLoad = !container.dataset.loaded;
  if (firstLoad) container.innerHTML = '<span class="muted">Loading…</span>';
  try {
    const apps = await window.api.listApps(state.selected);
    container.innerHTML = '';
    apps.forEach((pkg) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = `
        <span class="name" title="${pkg}">${pkg}</span>
        <span class="row-actions">
          <button data-act="disable">Disable</button>
          <button data-act="enable">Enable</button>
          <button data-act="uninstall" class="danger">Uninstall</button>
        </span>
      `;
      row.querySelector('[data-act="disable"]').onclick = () => window.api.disableApp(state.selected, pkg);
      row.querySelector('[data-act="enable"]').onclick = () => window.api.enableApp(state.selected, pkg);
      row.querySelector('[data-act="uninstall"]').onclick = async () => {
        if (confirm(`Uninstall ${pkg}?`)) {
          await window.api.uninstallApp(state.selected, pkg);
          loadApps();
        }
      };
      container.appendChild(row);
    });
    container.dataset.loaded = '1';
  } catch (err) {
    if (firstLoad) container.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

// ------------------------------------------------------------------- backup

let backupDest = null;

el('choose-dest-btn').onclick = async () => {
  const dir = await window.api.chooseBackupDestination();
  if (dir) {
    backupDest = dir;
    el('backup-dest').value = dir;
  }
};

window.api.onBackupProgress((line) => {
  const out = el('backup-output');
  out.textContent += (out.textContent ? '\n' : '') + line;
  out.scrollTop = out.scrollHeight;
});

el('run-backup-btn').onclick = async () => {
  if (!state.selected) return;
  if (!backupDest) {
    alert('Choose a destination folder first.');
    return;
  }
  const categories = Array.from(document.querySelectorAll('.checkbox-list input[type="checkbox"][value]'))
    .filter((c) => c.checked)
    .map((c) => c.value);
  const includeApks = el('backup-apks').checked;

  el('backup-output').textContent = '';
  el('run-backup-btn').disabled = true;
  try {
    await window.api.runBackup(state.selected, categories, backupDest, includeApks);
  } catch (err) {
    el('backup-output').textContent += `\nError: ${err.message}`;
  } finally {
    el('run-backup-btn').disabled = false;
  }
};

// -------------------------------------------------------------- bootloader

el('reboot-bootloader-btn').onclick = async () => {
  const out = el('bootloader-output');
  out.textContent = await window.api.rebootBootloader(state.selected).catch((e) => e.message);
};

el('unlock-btn').onclick = async () => {
  if (!confirm('This will FACTORY RESET the device and may void warranty. Continue?')) return;
  const out = el('bootloader-output');
  out.textContent = 'Unlocking…';
  try {
    out.textContent = await window.api.fastbootUnlock(state.selected);
  } catch (err) {
    out.textContent = err.message;
  }
};

// ------------------------------------------------------------- wireless pair

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
  } catch (err) {
    alert(err.message);
  }
};

// ----------------------------------------------------------------- startup
//
// The first refreshDevices() call happens once 'setup:ready' arrives (see the
// onSetupProgress handler above) so we don't poll adb before it's resolved.
// The 4s poll refreshes the device list AND the active tab's data so values
// like battery level / charging watts update live without switching tabs.

setInterval(() => {
  if (el('app').classList.contains('hidden')) return;
  refreshDevices();
  if (state.selected) refreshTab(state.activeTab);
}, 4000);

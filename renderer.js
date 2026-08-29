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

// ------------------------------------------------------------------ battery

async function loadBattery() {
  const grid = el('battery-grid');
  grid.innerHTML = '<span class="muted">Reading…</span>';
  try {
    const data = await window.api.getBattery(state.selected);
    grid.innerHTML = '';
    Object.entries(data).forEach(([k, v]) => {
      const cell = document.createElement('div');
      cell.className = 'data-cell';
      cell.innerHTML = `<span class="k">${k}</span><span class="v">${v}</span>`;
      grid.appendChild(cell);
    });
  } catch (err) {
    grid.innerHTML = `<span class="muted">${err.message}</span>`;
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
  container.innerHTML = '<span class="muted">Listing…</span>';
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
  } catch (err) {
    container.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

// --------------------------------------------------------------------- apps

el('install-apk-btn').onclick = async () => {
  await window.api.installApk(state.selected);
  loadApps();
};

async function loadApps() {
  const container = el('app-list');
  container.innerHTML = '<span class="muted">Loading…</span>';
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
  } catch (err) {
    container.innerHTML = `<span class="muted">${err.message}</span>`;
  }
}

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

setInterval(() => {
  if (!el('app').classList.contains('hidden')) refreshDevices();
}, 4000);

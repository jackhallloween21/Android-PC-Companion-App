// ---------------------------------------------------------------------------
// The docked control strip that sits under the scrcpy video window.
//
// Every action here goes over adb (see src/keys.js), not through scrcpy's
// control channel, so a click works without the video window having focus —
// which is the reason this bar exists at all.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const serial = params.get('serial') || '';
const type = params.get('type') || 'mirror';

const el = (id) => document.getElementById(id);
const toast = el('toast');
let toastTimer = null;

/**
 * Feedback has to be transient and out-of-flow: the strip is a fixed-height
 * window, so anything that occupied layout space would push the buttons around.
 */
function say(text, kind) {
  if (toastTimer) clearTimeout(toastTimer);
  toast.textContent = text || '';
  toast.className = text ? `show${kind ? ` ${kind}` : ''}` : '';
  if (text) toastTimer = setTimeout(() => { toast.className = ''; }, kind === 'err' ? 6000 : 2200);
}

/** Strips Electron's "Error invoking remote method 'x':" wrapper. */
function cleanError(message) {
  return String(message || 'Failed').replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');
}

/**
 * Wires a button so it cannot be double-fired while its IPC/adb call is in flight.
 */
function action(id, run, { busy, done } = {}) {
  const node = el(id);
  if (!node) return;
  node.addEventListener('click', async () => {
    node.disabled = true;
    if (busy) say(busy);
    try {
      const result = await run();
      if (done) say(done(result), 'ok');
      else if (busy) say('');
    } catch (err) {
      say(cleanError(err.message), 'err');
    } finally {
      node.disabled = false;
    }
  });
}

if (!serial) {
  say('No device serial was passed to this window.', 'err');
} else if (type === 'camera') {
  // ---- Camera Mode --------------------------------------------------------
  const mirrorNav = el('mirror-nav-row');
  const camNav = el('camera-nav-row');
  const mirrorAux = el('mirror-aux');
  const mirrorStop = el('a-stop');

  if (mirrorNav) mirrorNav.style.display = 'none';
  if (mirrorAux) mirrorAux.style.display = 'none';
  if (mirrorStop) mirrorStop.style.display = 'none';
  if (camNav) camNav.style.display = 'flex';

  action('c-flip', () => window.api.cameraSwitch(serial), {
    busy: 'Switching camera…',
    done: () => 'Switched camera',
  });

  action('c-rotate', () => window.api.cameraRotate(serial), {
    busy: 'Rotating camera…',
    done: () => 'Rotated camera 90°',
  });

  const micBtn = el('c-mic');
  let micActive = false;
  const paintMic = (active) => {
    micActive = !!active;
    if (micBtn) micBtn.classList.toggle('active-mic', micActive);
  };
  if (micBtn) {
    micBtn.addEventListener('click', async () => {
      micBtn.disabled = true;
      try {
        const res = await window.api.cameraToggleMic(serial);
        paintMic(res && res.mic);
        say(res && res.mic ? 'Microphone enabled' : 'Microphone muted', 'ok');
      } catch (err) {
        say(cleanError(err.message), 'err');
      } finally {
        micBtn.disabled = false;
      }
    });
  }

  action('c-shot', () => window.api.cameraCapturePhoto(serial), {
    busy: 'Capturing photo…',
    done: (file) => (file ? `Saved ${file.split(/[\\/]/).pop()}` : 'Cancelled'),
  });

  const camRecBtn = el('c-record');
  let camRecording = false;
  const paintCamRec = () => {
    if (camRecBtn) {
      camRecBtn.textContent = camRecording ? 'Stop rec' : 'Record';
      camRecBtn.classList.toggle('rec-on', camRecording);
    }
  };
  if (camRecBtn) {
    camRecBtn.addEventListener('click', async () => {
      camRecBtn.disabled = true;
      try {
        if (camRecording) {
          say('Finalising…');
          const file = await window.api.cameraRecordStop(serial);
          camRecording = false;
          say(file ? `Saved ${file.split(/[\\/]/).pop()}` : 'Discarded', 'ok');
        } else {
          const file = await window.api.cameraRecordStart(serial);
          if (file) {
            camRecording = true;
            say('Recording camera…');
          }
        }
      } catch (err) {
        say(cleanError(err.message), 'err');
      } finally {
        paintCamRec();
        camRecBtn.disabled = false;
      }
    });
  }
  window.api.cameraRecordStatus().then((active) => { camRecording = !!active; paintCamRec(); }).catch(() => {});

  action('c-stop', () => window.api.stopCamera(), { busy: 'Stopping camera…' });

  action('a-redock', () => window.api.cameraRedock(), {
    done: (ok) => (ok ? 'Snapped back under the video' : 'No docked session'),
  });

  // ---- Camera Resize ------------------------------------------------------
  const zoomValue = el('zoom-value');
  const zoomBtns = ['z-out', 'z-in', 'z-fit'].map(el);
  let zooming = false;

  const paintZoom = (zoom) => {
    if (Number.isFinite(zoom)) zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  };

  async function resize(run) {
    if (zooming) return;
    zooming = true;
    zoomBtns.forEach((b) => { if (b) b.disabled = true; });
    try {
      const res = await run();
      paintZoom(res && res.zoom);
    } catch (err) {
      say(cleanError(err.message), 'err');
    } finally {
      zooming = false;
      zoomBtns.forEach((b) => { if (b) b.disabled = false; });
    }
  }

  el('z-out').addEventListener('click', () => resize(() => window.api.cameraNudgeZoom(-1)));
  el('z-in').addEventListener('click', () => resize(() => window.api.cameraNudgeZoom(1)));
  el('z-fit').addEventListener('click', () => resize(() => window.api.cameraSetZoom(1)));

  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    resize(() => window.api.cameraNudgeZoom(e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  window.api.cameraStatus().then((st) => {
    if (st) {
      paintZoom(st.zoom || 1);
      paintMic(st.mic);
    }
  }).catch(() => {});

} else {
  // ---- Screen Mirror Mode -------------------------------------------------
  action('k-back', () => window.api.navKey(serial, 'back'));
  action('k-home', () => window.api.navKey(serial, 'home'));
  action('k-recents', () => window.api.navKey(serial, 'recents'));

  let openPanel = null;
  const shade = (id, panel) => action(id, async () => {
    const target = openPanel === panel ? 'collapse' : panel;
    await window.api.statusBar(serial, target);
    openPanel = target === 'collapse' ? null : panel;
  });
  shade('k-shade', 'notifications');
  shade('k-qs', 'quickSettings');

  action('a-power', () => window.api.powerLongPress(serial));
  action('a-vol-down', () => window.api.volumeDown(serial));
  action('a-vol-up', () => window.api.volumeUp(serial));

  let rotation = 0;
  action('a-rotate', () => {
    rotation = (rotation + 1) % 4;
    return window.api.rotate(serial, rotation);
  }, { done: () => `Rotation ${rotation * 90}°` });

  action('a-shot', () => window.api.screenshot(serial), {
    busy: 'Capturing…',
    done: (file) => (file ? `Saved ${file.split(/[\\/]/).pop()}` : 'Cancelled'),
  });

  const recordBtn = el('a-record');
  let recording = false;
  const paintRecord = () => {
    if (recordBtn) {
      recordBtn.textContent = recording ? 'Stop rec' : 'Record';
      recordBtn.classList.toggle('rec-on', recording);
    }
  };
  if (recordBtn) {
    recordBtn.addEventListener('click', async () => {
      recordBtn.disabled = true;
      try {
        if (recording) {
          say('Finalising…');
          const file = await window.api.recordStop(serial);
          recording = false;
          say(file ? `Saved ${file.split(/[\\/]/).pop()}` : 'Discarded', 'ok');
        } else {
          await window.api.recordStart(serial);
          recording = true;
          say('Recording…');
        }
      } catch (err) {
        say(cleanError(err.message), 'err');
      } finally {
        paintRecord();
        recordBtn.disabled = false;
      }
    });
  }
  window.api.recordStatus().then((active) => { recording = !!active; paintRecord(); }).catch(() => {});

  action('a-redock', () => window.api.redockControls(), {
    done: (ok) => (ok ? 'Snapped back under the video' : 'No docked session'),
  });

  // ---- Mirror Resize ------------------------------------------------------
  const zoomValue = el('zoom-value');
  const zoomBtns = ['z-out', 'z-in', 'z-fit'].map(el);
  let zooming = false;

  const paintZoom = (zoom) => {
    if (Number.isFinite(zoom)) zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  };

  async function resize(run) {
    if (zooming) return;
    zooming = true;
    zoomBtns.forEach((b) => { if (b) b.disabled = true; });
    try {
      const res = await run();
      paintZoom(res && res.zoom);
      if (res && res.relaunched) {
        say(res.reason === 'unsupported'
          ? 'Resized by restarting the stream (in-place resize is Windows-only).'
          : 'Resized by restarting the stream.', 'ok');
      } else {
        say('');
      }
    } catch (err) {
      say(cleanError(err.message), 'err');
    } finally {
      zooming = false;
      zoomBtns.forEach((b) => { if (b) b.disabled = false; });
    }
  }

  el('z-out').addEventListener('click', () => resize(() => window.api.nudgeMirrorZoom(-1)));
  el('z-in').addEventListener('click', () => resize(() => window.api.nudgeMirrorZoom(1)));
  el('z-fit').addEventListener('click', () => resize(() => window.api.setMirrorZoom(1)));

  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    resize(() => window.api.nudgeMirrorZoom(e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  window.api.dockState().then((s) => paintZoom(s && s.zoom)).catch(() => {});

  action('a-stop', () => window.api.stopMirror(), { busy: 'Stopping…' });
}

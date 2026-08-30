// ---------------------------------------------------------------------------
// The docked control strip that sits under the scrcpy video window.
//
// Every action here goes over adb (see src/keys.js), not through scrcpy's
// control channel, so a click works without the video window having focus —
// which is the reason this bar exists at all.
// ---------------------------------------------------------------------------

const serial = new URLSearchParams(location.search).get('serial') || '';

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
 * Wires a button so it cannot be double-fired while its adb call is in flight —
 * `input keyevent` is cheap but not instant, and a queued burst of Back presses
 * walks the user out of their app.
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
} else {
  action('k-back', () => window.api.navKey(serial, 'back'));
  action('k-home', () => window.api.navKey(serial, 'home'));
  action('k-recents', () => window.api.navKey(serial, 'recents'));

  // A second press on either shade button collapses it, so the buttons behave
  // like the gesture they replace rather than being one-way.
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

  // The device's absolute rotation is not queried, so cycle a local counter;
  // the first press may therefore land on the orientation it is already in.
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
    recordBtn.textContent = recording ? 'Stop rec' : 'Record';
    recordBtn.classList.toggle('rec-on', recording);
  };
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
  window.api.recordStatus().then((active) => { recording = !!active; paintRecord(); }).catch(() => {});

  action('a-redock', () => window.api.redockControls(), {
    done: (ok) => (ok ? 'Snapped back under the video' : 'No docked session'),
  });
  // ---- Resize -------------------------------------------------------------
  // The video window is borderless so it cannot drift out of alignment, which
  // also means it has no edges to drag. These buttons are the resize handle.
  const zoomValue = el('zoom-value');
  const zoomBtns = ['z-out', 'z-in', 'z-fit'].map(el);
  let zooming = false;

  const paintZoom = (zoom) => {
    if (Number.isFinite(zoom)) zoomValue.textContent = `${Math.round(zoom * 100)}%`;
  };

  // Serialised rather than debounced: each resize either moves the window or
  // relaunches scrcpy, and overlapping those would fight over the same window.
  async function resize(run) {
    if (zooming) return;
    zooming = true;
    zoomBtns.forEach((b) => { b.disabled = true; });
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
      zoomBtns.forEach((b) => { b.disabled = false; });
    }
  }

  el('z-out').addEventListener('click', () => resize(() => window.api.nudgeMirrorZoom(-1)));
  el('z-in').addEventListener('click', () => resize(() => window.api.nudgeMirrorZoom(1)));
  el('z-fit').addEventListener('click', () => resize(() => window.api.setMirrorZoom(1)));

  // Ctrl+wheel over the bar, the gesture people already expect for zoom.
  document.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    resize(() => window.api.nudgeMirrorZoom(e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  window.api.dockState().then((s) => paintZoom(s && s.zoom)).catch(() => {});

  // Stopping tears down scrcpy, which closes this window from the main process.
  action('a-stop', () => window.api.stopMirror(), { busy: 'Stopping…' });
}

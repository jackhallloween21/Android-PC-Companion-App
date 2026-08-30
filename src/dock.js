// ---------------------------------------------------------------------------
// Docked-mirror geometry.
//
// scrcpy renders into its own SDL window; it cannot be drawn inside an Electron
// BrowserWindow without native window reparenting. Instead we place the two
// windows so they read as one unit: scrcpy at a computed rectangle, and a slim
// always-on-top control strip immediately below it.
//
// The video window keeps its title bar by default, so it can be dragged and
// resized like any other window; `Re-dock` on the strip snaps the strip back
// underneath wherever it ended up. Borderless is available as an option for
// people who would rather the pair could not drift apart at all.
//
// Pure functions only; the arithmetic is unit-tested without launching Electron
// or touching a device.
// ---------------------------------------------------------------------------

const { pickFlag } = require('./scrcpy');

/** Fallback aspect when the device will not report its resolution: 9:19.5. */
const FALLBACK_DEVICE = { width: 1080, height: 2340 };

const DEFAULTS = {
  barHeight: 104,
  gap: 10,
  margin: 28,
  // Wide enough for every button on both rows. The strip is not allowed to be
  // merely as wide as the video: a phone mirrored at 50% is far narrower than
  // the controls, and a too-narrow strip clips the buttons on the right.
  minBarWidth: 880,
};

// Zoom is expressed as a fraction of the largest size that fits the screen, not
// of the device's pixel resolution: 1.0 means "as big as this monitor allows",
// which is the only upper bound that is meaningful once the block has to include
// the control strip. Below 0.3 the video is too small to interact with.
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 1;
const ZOOM_STEP = 0.1;

/** Nudge a zoom factor by whole steps, clamped, and rounded off float drift. */
function stepZoom(zoom, direction, step = ZOOM_STEP) {
  const base = Number.isFinite(zoom) ? zoom : ZOOM_MAX;
  const next = base + (direction < 0 ? -step : step);
  return Math.round(clamp(next, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
}

/**
 * Effective display size from `adb shell wm size`, which prints
 *   Physical size: 1080x2400
 * and, when a display override is active, an additional
 *   Override size: 720x1600
 * The override is what the compositor actually renders, so it wins.
 */
function parseWmSize(out) {
  const text = String(out || '');
  const pick = (label) => {
    const m = text.match(new RegExp(`${label} size:\\s*(\\d+)\\s*x\\s*(\\d+)`, 'i'));
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  };
  return pick('Override') || pick('Physical') || null;
}

/**
 * Current display rotation from `adb shell dumpsys input` / `window`.
 * Returns 0/1/2/3, or null when it cannot be read — callers then assume the
 * device is in its natural orientation.
 */
function parseRotation(out) {
  const m = String(out || '').match(/(?:SurfaceOrientation|mCurrentRotation|mRotation)[:=]\s*(?:ROTATION_(\d+)|(\d))/i);
  if (!m) return null;
  const raw = m[1] !== undefined ? Number(m[1]) : Number(m[2]);
  if (raw === 90) return 1;
  if (raw === 180) return 2;
  if (raw === 270) return 3;
  return raw >= 0 && raw <= 3 ? raw : null;
}

/** Even integers only: odd dimensions make some hardware encoders unhappy. */
function even(n) {
  const v = Math.max(2, Math.round(n));
  return v % 2 === 0 ? v : v - 1;
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Where to put the video window and the control strip.
 *
 * The two are laid out as a single block — video, gap, bar — centred in the
 * display's work area (which already excludes the taskbar). The video is scaled
 * down until the whole block fits, so the bar is never pushed off-screen by a
 * tall phone on a short monitor. That is the failure mode worth designing
 * against: at 1080x2400 on a 1080p display, an unscaled portrait video is
 * taller than the screen and the controls would be invisible.
 *
 * @param {object} o
 * @param {number} [o.deviceWidth]  device resolution, natural orientation
 * @param {number} [o.deviceHeight]
 * @param {number} [o.rotation]     0/1/2/3; 1 and 3 swap width and height
 * @param {number} [o.maxSize]      the mirror view's "max resolution" cap
 * @param {{x,y,width,height}} o.workArea  display work area
 * @returns {{video:{x,y,width,height}, bar:{x,y,width,height}, scale:number}}
 */
function computeDockLayout(o = {}) {
  const cfg = { ...DEFAULTS, ...o };
  const { workArea } = cfg;
  if (!workArea || !workArea.width || !workArea.height) {
    throw new Error('computeDockLayout needs a workArea with width and height.');
  }

  const natW = cfg.deviceWidth || FALLBACK_DEVICE.width;
  const natH = cfg.deviceHeight || FALLBACK_DEVICE.height;
  const landscape = cfg.rotation === 1 || cfg.rotation === 3;
  let vidW = landscape ? natH : natW;
  let vidH = landscape ? natW : natH;

  // scrcpy's --max-size caps the longest edge; mirror that here so the window
  // matches the stream it will contain and scrcpy has no reason to letterbox.
  if (cfg.maxSize) {
    const longest = Math.max(vidW, vidH);
    if (longest > cfg.maxSize) {
      const k = cfg.maxSize / longest;
      vidW *= k;
      vidH *= k;
    }
  }

  const availW = Math.max(160, workArea.width - cfg.margin * 2);
  const availH = Math.max(160, workArea.height - cfg.barHeight - cfg.gap - cfg.margin * 2);
  // `fit` is the largest the video can be here; `zoom` is the user's fraction of
  // that. Keeping them separate is what lets the zoom control mean the same
  // thing on a 4K monitor as on a laptop panel.
  const fit = Math.min(1, availW / vidW, availH / vidH);
  const zoom = clamp(Number.isFinite(cfg.zoom) ? cfg.zoom : ZOOM_MAX, ZOOM_MIN, ZOOM_MAX);
  const scale = fit * zoom;
  const width = even(vidW * scale);
  const height = even(vidH * scale);

  const blockH = height + cfg.gap + cfg.barHeight;
  const centreX = workArea.x + Math.round(workArea.width / 2);
  const top = workArea.y + Math.max(0, Math.round((workArea.height - blockH) / 2));

  const barWidth = Math.round(clamp(width, Math.min(cfg.minBarWidth, availW), availW));

  return {
    scale,
    fit,
    zoom,
    video: { x: centreX - Math.round(width / 2), y: top, width, height },
    bar: {
      x: centreX - Math.round(barWidth / 2),
      y: top + height + cfg.gap,
      width: barWidth,
      height: cfg.barHeight,
    },
  };
}

/**
 * Where the strip goes given a video rectangle that already exists — used by
 * `Re-dock` after the user has dragged or resized the video window themselves,
 * when the launch-time layout no longer describes reality.
 *
 * Kept inside the work area on both axes: a window dragged to the bottom of the
 * screen would otherwise put its strip behind the taskbar or off-screen, and a
 * control you cannot click is worse than one that is slightly out of place.
 */
function barBelow(video, workArea, o = {}) {
  const cfg = { ...DEFAULTS, ...o };
  if (!video || !video.width || !video.height) {
    throw new Error('barBelow needs the current video rectangle.');
  }
  if (!workArea || !workArea.width || !workArea.height) {
    throw new Error('barBelow needs a workArea with width and height.');
  }
  const availW = Math.max(160, workArea.width - cfg.margin * 2);
  const width = Math.round(clamp(Math.max(video.width, cfg.minBarWidth), 160, availW));
  const centreX = video.x + Math.round(video.width / 2);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - cfg.barHeight;
  return {
    x: Math.round(clamp(centreX - Math.round(width / 2), workArea.x, Math.max(workArea.x, maxX))),
    y: Math.round(clamp(video.y + video.height + cfg.gap, workArea.y, Math.max(workArea.y, maxY))),
    width,
    height: cfg.barHeight,
  };
}

/** Candidate spellings for the window-placement options, newest first. */const WINDOW_FLAGS = {
  x: ['--window-x'],
  y: ['--window-y'],
  width: ['--window-width'],
  height: ['--window-height'],
  borderless: ['--window-borderless'],
  alwaysOnTop: ['--always-on-top'],
};

/**
 * The `--window-*` argv for a docked launch, feature-detected against this
 * build's --help exactly like every other optional flag. A build that does not
 * advertise them simply opens wherever it likes; the bar still works, it just
 * will not be glued to the video.
 *
 * @param {{x,y,width,height}} video
 * @param {?string} help  raw `scrcpy --help` text
 * @param {{borderless?:boolean, alwaysOnTop?:boolean}} [opts]
 */
function buildWindowArgs(video, help, opts = {}) {
  const { borderless = false, alwaysOnTop = false } = opts;
  const args = [];
  const push = (key, value) => {
    const flag = pickFlag(help, WINDOW_FLAGS[key]);
    if (flag) args.push(value === undefined ? flag : `${flag}=${value}`);
  };
  if (!video) return args;
  push('x', video.x);
  push('y', video.y);
  if (video.width) push('width', video.width);
  if (video.height) push('height', video.height);
  if (borderless) push('borderless');
  if (alwaysOnTop) push('alwaysOnTop');
  return args;
}

/** Whether this build can be told where to put its window at all. */
function supportsPlacement(help) {
  return pickFlag(help, WINDOW_FLAGS.x) !== null && pickFlag(help, WINDOW_FLAGS.y) !== null;
}

module.exports = {
  DEFAULTS,
  FALLBACK_DEVICE,
  WINDOW_FLAGS,
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  stepZoom,
  parseWmSize,
  parseRotation,
  computeDockLayout,
  barBelow,
  buildWindowArgs,
  supportsPlacement,
};

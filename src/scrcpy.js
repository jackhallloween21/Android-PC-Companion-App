// ---------------------------------------------------------------------------
// scrcpy CLI feature detection and argument building.
//
// scrcpy renames options across majors — `--bit-rate` became `--video-bit-rate`
// in 2.0 — and an unrecognised option is fatal, not ignored. Deriving option
// names from the version number is fragile (it already broke once on 4.1), so
// instead every optional flag is looked up in the build's own `--help` output
// before it is passed.
//
// Pure functions only, so the flag logic can be unit-tested against captured
// --help text from several scrcpy generations without launching Electron.
// ---------------------------------------------------------------------------

/**
 * Whether `help` advertises `flag`.
 * Returns null when there is no help text, so callers can fall back to version
 * comparisons rather than silently dropping every option.
 *
 * Boundaries matter: a plain substring test for "--bit-rate" also matches inside
 * "--video-bit-rate" and "--audio-bit-rate".
 */
function supportsFlag(help, flag) {
  if (!help) return null;
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[\\s,])${escaped}([\\s,=\\]]|$)`, 'm').test(help);
}

/**
 * First flag in `candidates` that this build knows about, newest spelling first.
 * Returns null when help was readable and none matched — the option genuinely
 * does not exist here and should be skipped.
 */
function pickFlag(help, candidates, fallbackIndex = 0) {
  if (!help) return candidates[fallbackIndex] ?? null;
  for (const flag of candidates) if (supportsFlag(help, flag)) return flag;
  return null;
}

/** Candidate spellings, newest first, for each option the mirror view exposes. */
const MIRROR_FLAGS = {
  windowTitle: ['--window-title'],
  maxSize: ['--max-size'],
  bitrate: ['--video-bit-rate', '--bit-rate'],
  maxFps: ['--max-fps'],
  stayAwake: ['--stay-awake'],
  turnScreenOff: ['--turn-screen-off'],
  showTouches: ['--show-touches'],
};

/**
 * The window title we ask scrcpy for. Exported because the docked-resize path
 * has to find that window again by title, and the two must not drift apart.
 */
function mirrorWindowTitle(serial) {
  return `Mirror — ${serial}`;
}

/**
 * Builds the mirror argv. `info` is the probed { major, minor, help } record.
 */
function buildMirrorArgs(serial, opts = {}, info = {}) {
  const { maxSize, bitrate, maxFps, stayAwake, turnScreenOff, showTouches, forwardAudio } = opts;
  const help = info.help || null;
  const args = ['-s', serial];

  const push = (key, value) => {
    const flag = pickFlag(help, MIRROR_FLAGS[key]);
    if (flag) args.push(value === undefined ? flag : `${flag}=${value}`);
  };

  push('windowTitle', mirrorWindowTitle(serial));
  if (maxSize) push('maxSize', maxSize);
  if (bitrate) push('bitrate', `${bitrate}M`);
  if (maxFps) push('maxFps', maxFps);
  if (stayAwake) push('stayAwake');
  if (turnScreenOff) push('turnScreenOff');
  if (showTouches) push('showTouches');
  // Audio arrived in 2.0; on a 1.x build --no-audio is a fatal unknown option.
  if (!forwardAudio && hasAudio(info)) args.push('--no-audio');
  return args;
}

/** scrcpy 2.0+ mirrors audio. */
function hasAudio(info = {}) {
  return supportsFlag(info.help, '--no-audio') ?? (info.major || 0) >= 2;
}

/** Selectable audio source (`output` = the device's own playback) landed in 2.2. */
function hasAudioSource(info = {}) {
  const { major = 0, minor = 0 } = info;
  return supportsFlag(info.help, '--audio-source') ?? (major > 2 || (major === 2 && minor >= 2));
}

/** Camera mirroring (`--video-source=camera`) landed in 2.2. */
function hasCameraSource(info = {}) {
  const { major = 0, minor = 0 } = info;
  return supportsFlag(info.help, '--video-source') ?? (major > 2 || (major === 2 && minor >= 2));
}

module.exports = {
  MIRROR_FLAGS,
  mirrorWindowTitle,
  supportsFlag,
  pickFlag,
  buildMirrorArgs,
  hasAudio,
  hasAudioSource,
  hasCameraSource,
};

// ---------------------------------------------------------------------------
// Now playing, from `adb shell dumpsys media_session`.
//
// There is no adb command that answers "what is playing"; the only source is
// this dumpsys text, which is a debug dump and formatted accordingly. What it
// does contain, per media session:
//
//   package=com.spotify.music
//   state=PlaybackState {state=3, position=70000, buffered position=..., speed=1.0, ...}
//   metadata: size=9, description=Song Title, Artist Name, Album Name
//
// The metadata line is the awkward part: `description=` is three fields joined
// by ", " with no escaping, so an artist with a comma in the name is genuinely
// ambiguous. It is split on ", " into at most three parts and no attempt is made
// to be cleverer than the data allows.
//
// Several sessions are usually listed (a browser, a podcast app, the launcher's
// leftovers). The one worth showing is whichever is actually playing; failing
// that, the most recently active. Anything absent stays null so the UI can show
// "—" rather than a plausible-looking invention.
//
// Pure functions only.
// ---------------------------------------------------------------------------

/** PlaybackState.STATE_* constants, as reported in `state={n, ...}`. */
const PLAYBACK_STATES = {
  0: 'none',
  1: 'stopped',
  2: 'paused',
  3: 'playing',
  4: 'fast-forwarding',
  5: 'rewinding',
  6: 'buffering',
  7: 'error',
  8: 'connecting',
  9: 'skipping-to-previous',
  10: 'skipping-to-next',
  11: 'skipping-to-queue-item',
};

const STATE_LABELS = {
  playing: 'Playing',
  paused: 'Paused',
  stopped: 'Stopped',
  buffering: 'Buffering',
  connecting: 'Connecting',
  error: 'Error',
  none: 'Idle',
};

/** PlaybackState.ACTION_* bits, for greying out transport buttons honestly. */
const ACTION_BITS = {
  stop: 1,
  pause: 1 << 1,
  play: 1 << 2,
  rewind: 1 << 3,
  previous: 1 << 4,
  next: 1 << 5,
  fastForward: 1 << 6,
  seek: 1 << 8,
};

/** `1:10` / `1:02:03` — mm:ss, growing an hours field only when needed. */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const total = Math.round(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Splits one media_session dump into per-session blocks.
 *
 * Sessions are introduced by a line naming the package, and everything up to the
 * next such line belongs to it. Matching on the package line rather than on
 * indentation is deliberate: indentation differs between Android versions.
 */
function splitSessions(out) {
  const text = String(out || '');
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let current = null;

  for (const line of lines) {
    // "com.spotify.music/SpotifySession (userId=0)" or "package=com.spotify.music"
    const pkg = line.match(/^\s*package=([\w.]+)/)
      || line.match(/^\s{0,6}([a-z][\w]*(?:\.[\w]+){2,})\/[^\s]*\s*\(userId/);
    if (pkg) {
      // A session is usually announced twice — once as "pkg/Component (userId=0)"
      // and again as "package=pkg" a line later. Only the first of the pair starts
      // a block, or every session would be split into two half-empty ones.
      if (current && current.pkg === pkg[1]) { current.lines.push(line); continue; }
      current = { pkg: pkg[1], lines: [line] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return blocks.map((b) => ({ pkg: b.pkg, text: b.lines.join('\n') }));
}

/** One session block → a track object, or null when it carries nothing useful. */
function parseSession(block) {
  if (!block) return null;
  const { text } = block;

  const stateNum = text.match(/state=PlaybackState\s*\{\s*state=(\d+)/)
    || text.match(/\bstate=(\d+)\b/);
  const state = stateNum ? (PLAYBACK_STATES[Number(stateNum[1])] || 'none') : null;

  const position = text.match(/\bposition=(-?\d+)/);
  const actions = text.match(/\bactions=(\d+)/);
  const duration = text.match(/\b(?:duration|METADATA_KEY_DURATION)[=:]\s*(\d+)/);
  // position= is a snapshot taken when the dump was written, so a bar that moves
  // has to be advanced locally — which needs the playback speed the session
  // reports (0.0 while paused, 1.0 normally, other values when scrubbing).
  const speed = text.match(/\bspeed=(-?[\d.]+)/);

  // description= runs to end of line: "Title, Artist, Album".
  const desc = text.match(/description=(.*)/);
  let title = null; let artist = null; let album = null;
  if (desc) {
    const parts = desc[1].trim().split(/,\s+/);
    const clean = (s) => {
      const v = (s || '').trim();
      return v && v !== 'null' ? v : null;
    };
    title = clean(parts[0]);
    artist = clean(parts[1]);
    // Anything past the second comma is album; rejoining avoids truncating an
    // album title that itself contains a comma.
    album = clean(parts.slice(2).join(', '));
  }

  const positionMs = position ? Number(position[1]) : null;
  const durationMs = duration ? Number(duration[1]) : null;

  const track = {
    package: block.pkg || null,
    app: appLabel(block.pkg),
    state,
    stateLabel: state ? (STATE_LABELS[state] || state) : null,
    playing: state === 'playing',
    title,
    artist,
    album,
    positionMs: Number.isFinite(positionMs) && positionMs >= 0 ? positionMs : null,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : null,
    speed: speed && Number.isFinite(Number(speed[1])) ? Number(speed[1]) : null,
    actions: actions ? decodeActions(Number(actions[1])) : null,
  };
  track.position = formatDuration(track.positionMs);
  track.duration = formatDuration(track.durationMs);
  track.progress = (track.positionMs !== null && track.durationMs)
    ? Math.min(1, track.positionMs / track.durationMs)
    : null;

  const hasContent = track.title || track.artist || track.album || track.state;
  return hasContent ? track : null;
}

/** actions bitmask → { next: true, previous: false, … }. */
function decodeActions(mask) {
  if (!Number.isFinite(mask)) return null;
  const out = {};
  for (const [name, bit] of Object.entries(ACTION_BITS)) out[name] = (mask & bit) !== 0;
  return out;
}

/** "com.spotify.music" → "Spotify Music"; a best-effort label, not a lookup. */
function appLabel(pkg) {
  if (!pkg) return null;
  const last = String(pkg).split('.').filter(Boolean).pop();
  if (!last) return null;
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * The session worth showing: whatever is playing, else the first that has any
 * metadata at all. dumpsys lists most-recent first, so "first" is the right
 * tie-break rather than an arbitrary one.
 */
function parseNowPlaying(out) {
  const tracks = splitSessions(out).map(parseSession).filter(Boolean);
  if (!tracks.length) return null;
  return tracks.find((t) => t.playing) || tracks.find((t) => t.title) || tracks[0];
}

/** Every session, for a "N apps hold media sessions" line. */
function parseAllSessions(out) {
  return splitSessions(out).map(parseSession).filter(Boolean);
}

/** "Song — Artist" for a one-line status; null when there is nothing to say. */
function describeTrack(track) {
  if (!track) return null;
  const main = [track.title, track.artist].filter(Boolean).join(' — ');
  return main || track.app || null;
}

module.exports = {
  PLAYBACK_STATES,
  STATE_LABELS,
  ACTION_BITS,
  formatDuration,
  splitSessions,
  parseSession,
  decodeActions,
  appLabel,
  parseNowPlaying,
  parseAllSessions,
  describeTrack,
};

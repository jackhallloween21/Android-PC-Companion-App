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
  // Duration appears under many spellings across Android versions and apps:
  // `duration=`, `mDuration=`, `durationMillis=`,
  // `android.media.metadata.DURATION=`, `METADATA_KEY_DURATION=`.
  const duration = text.match(/(?:android\.media\.metadata\.DURATION|METADATA_KEY_DURATION|durationMillis|mDuration|duration)\s*[=:]\s*(\d+)/i);
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

  // Artwork URI — some sessions expose album art via a content:// URI
  // (e.g. Spotify, YouTube Music). The bitmap itself lives inside the player
  // process and never appears in the dump. Variants seen in the wild:
  // `art=`, `albumArt=`, `albumArtUri=`, `artUri=`, `displayIconUri=`,
  // `android.media.metadata.ART_URI=`, `ALBUM_ART_URI=`, `DISPLAY_ICON_URI=`,
  // `ALBUM_ART=`, `ART=`, `DISPLAY_ICON=`, `icon=`. The URI can be pulled
  // on-device (ContentResolver via dex helper, or `content read | base64`).
  // Not all apps set this; when absent the renderer falls back to the
  // dex-fetched launcher icon.
  const artUri = (() => {
    const re = /(?:android\.media\.metadata\.(?:ALBUM_ART_URI|ART_URI|DISPLAY_ICON_URI|ALBUM_ART|ART|DISPLAY_ICON)|METADATA_KEY_(?:ALBUM_ART_URI|ART_URI|DISPLAY_ICON_URI)|ALBUM_ART_URI|ART_URI|DISPLAY_ICON_URI|albumArtUri|artUri|displayIconUri|albumArt|art|displayIcon|icon)\s*[=:]\s*(content:\/\/\S+)/i;
    const m = text.match(re);
    if (!m) return null;
    // Strip trailing dump punctuation: `,`, `}`, `]`, quotes.
    return m[1].replace(/[,\}\]\)'"]+$/g, '');
  })();

  const positionMs = position ? Number(position[1]) : null;
  let durationMs = duration ? Number(duration[1]) : null;
  // Unit normalisation: some dumps report duration in seconds (e.g. `218`)
  // while position is in ms (e.g. `70000`). A duration shorter than the
  // position is impossible — if ×1000 makes it plausible, it was seconds.
  if (Number.isFinite(durationMs) && Number.isFinite(positionMs)
      && durationMs > 0 && positionMs >= 0 && durationMs < positionMs
      && durationMs * 1000 >= positionMs) {
    durationMs = durationMs * 1000;
  }

  const track = {
    package: block.pkg || null,
    app: appLabel(block.pkg),
    state,
    stateLabel: state ? (STATE_LABELS[state] || state) : null,
    playing: state === 'playing',
    title,
    artist,
    album,
    artUri,
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

/**
 * Collects every content:// art URI in a session block (some dumps carry two:
 * e.g. both ART_URI and ALBUM_ART_URI). The artwork fetcher tries them in order.
 */
function collectArtUris(text) {
  const out = [];
  const re = /(?:android\.media\.metadata\.(?:ALBUM_ART_URI|ART_URI|DISPLAY_ICON_URI|ALBUM_ART|ART|DISPLAY_ICON)|METADATA_KEY_(?:ALBUM_ART_URI|ART_URI|DISPLAY_ICON_URI)|ALBUM_ART_URI|ART_URI|DISPLAY_ICON_URI|albumArtUri|artUri|displayIconUri|albumArt|art|displayIcon|icon)\s*[=:]\s*(content:\/\/\S+)/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const uri = m[1].replace(/[,\}\]\)'"]+$/g, '');
    if (uri && !out.includes(uri)) out.push(uri);
  }
  return out;
}

/**
 * Parses `dumpsys audio` for the MUSIC stream level.
 * Formats differ by version (`STREAM_MUSIC(3): index:11`, `stream:3 ...`,
 * `Music: ...`), so several patterns are tried; returns { index, max } with
 * nulls where unreadable rather than throwing.
 */
function parseAudioVolume(out) {
  const text = String(out || '');
  // Modern: `STREAM_MUSIC(3): muted=false, ... index:11(max:15) ...`
  let m = text.match(/STREAM_MUSIC\s*\(\s*3\s*\)[^\n]*?index\s*[:=]\s*(\d+)(?:\s*\(?\s*max\s*[:=]\s*(\d+))?/i);
  if (m) {
    return {
      index: Number(m[1]),
      max: m[2] !== undefined ? Number(m[2]) : 15,
    };
  }
  // Compact: `stream:3 index:11` near a `music` label.
  m = text.match(/(?:stream\s*[:=]\s*3|music)[^\n]{0,120}?index\s*[:=]\s*(\d+)/i);
  if (m) return { index: Number(m[1]), max: 15 };
  // `cmd audio get-volume music` prints a bare number or `index: 11`.
  m = text.match(/index\s*[:=]\s*(\d+)/i) || text.match(/^\s*(\d+)\s*$/m);
  if (m) return { index: Number(m[1]), max: 15 };
  return { index: null, max: 15 };
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
  collectArtUris,
  parseAudioVolume,
};

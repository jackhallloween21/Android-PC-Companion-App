// Tests for now-playing parsing. dumpsys media_session is a debug dump, so the
// cases that matter are the messy ones: several sessions at once, missing
// metadata fields, and the unescaped comma-joined description line.

const test = require('node:test');
const assert = require('node:assert');
const {
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
  ACTION_BITS,
} = require('../src/media');

// Two sessions: a paused browser listed first, Spotify actually playing.
const DUMP = `
Sessions Stack - have global priority session:
  com.android.chrome/MediaSessionService (userId=0)
    package=com.android.chrome
    state=PlaybackState {state=2, position=0, buffered position=0, speed=0.0, actions=516}
    metadata: size=2, description=Some Video, YouTube, null
  com.spotify.music/SpotifyMediaSession (userId=0)
    package=com.spotify.music
    state=PlaybackState {state=3, position=70000, buffered position=218000, speed=1.0, actions=823}
    metadata: size=9, description=Midnight City, M83, Hurry Up, We're Dreaming
    duration=218000
`;

test('mm:ss, growing an hours field only when the track is long enough', () => {
  assert.strictEqual(formatDuration(70000), '1:10');
  assert.strictEqual(formatDuration(218000), '3:38');
  assert.strictEqual(formatDuration(0), '0:00');
  assert.strictEqual(formatDuration(3723000), '1:02:03');
  assert.strictEqual(formatDuration(-1), null, 'Android reports -1 for unknown duration');
  assert.strictEqual(formatDuration(null), null);
  assert.strictEqual(formatDuration(undefined), null);
});

test('each session becomes its own block, keyed by package', () => {
  const blocks = splitSessions(DUMP);
  assert.deepStrictEqual(blocks.map((b) => b.pkg), ['com.android.chrome', 'com.spotify.music']);
  assert.ok(!blocks[0].text.includes('Midnight City'),
    'one session must not absorb the next one metadata');
});

test('a session yields title, artist, album, state, position and duration', () => {
  const track = parseNowPlaying(DUMP);
  assert.strictEqual(track.package, 'com.spotify.music');
  assert.strictEqual(track.title, 'Midnight City');
  assert.strictEqual(track.artist, 'M83');
  assert.strictEqual(track.album, "Hurry Up, We're Dreaming",
    'an album containing a comma is rejoined, not truncated');
  assert.strictEqual(track.state, 'playing');
  assert.strictEqual(track.stateLabel, 'Playing');
  assert.strictEqual(track.playing, true);
  assert.strictEqual(track.position, '1:10');
  assert.strictEqual(track.duration, '3:38');
});

test('the playing session wins over one merely listed first', () => {
  assert.strictEqual(parseNowPlaying(DUMP).package, 'com.spotify.music');
  assert.strictEqual(parseAllSessions(DUMP).length, 2, 'the paused one is still reported separately');
});

test('progress is a fraction, and only when both numbers are known', () => {
  const track = parseNowPlaying(DUMP);
  assert.ok(Math.abs(track.progress - 70000 / 218000) < 1e-9);

  const noDuration = parseNowPlaying(`
    package=com.foo.player
    state=PlaybackState {state=3, position=5000, actions=0}
    metadata: size=1, description=Live Stream, Station, null
  `);
  assert.strictEqual(noDuration.durationMs, null);
  assert.strictEqual(noDuration.progress, null, 'a live stream has no progress to show');
  assert.strictEqual(noDuration.duration, null);
});

test('"null" placeholders become null, not the literal word', () => {
  const track = parseSession(splitSessions(DUMP)[0]);
  assert.strictEqual(track.title, 'Some Video');
  assert.strictEqual(track.artist, 'YouTube');
  assert.strictEqual(track.album, null, 'dumpsys prints "null" for an absent album');
  assert.strictEqual(track.state, 'paused');
  assert.strictEqual(track.playing, false);
});

test('a session with no metadata at all still reports its state', () => {
  const track = parseNowPlaying(`
    package=com.foo.player
    state=PlaybackState {state=2, position=0, actions=0}
  `);
  assert.strictEqual(track.title, null);
  assert.strictEqual(track.stateLabel, 'Paused');
  assert.strictEqual(track.app, 'Player');
});

test('nothing playing yields null rather than an empty-looking track', () => {
  assert.strictEqual(parseNowPlaying(''), null);
  assert.strictEqual(parseNowPlaying(undefined), null);
  assert.strictEqual(parseNowPlaying('Sessions Stack - have global priority session:'), null);
  assert.deepStrictEqual(parseAllSessions(''), []);
  assert.strictEqual(parseSession(null), null);
});

test('the actions bitmask says which transport buttons are real', () => {
  const track = parseNowPlaying(DUMP);
  // 823 = 0b1100110111 → stop, pause, play, rewind, previous, next, seek
  assert.strictEqual(track.actions.next, true);
  assert.strictEqual(track.actions.play, true);
  assert.strictEqual(track.actions.pause, true);
  assert.strictEqual(track.actions.previous, true);
  assert.strictEqual(track.actions.fastForward, false,
    'bit 6 is clear here, so a fast-forward button would be pretending');

  const all = decodeActions(Object.values(ACTION_BITS).reduce((a, b) => a | b, 0));
  assert.ok(Object.values(all).every(Boolean));
  assert.strictEqual(decodeActions(NaN), null);
  assert.strictEqual(decodeActions(0).next, false);
});

test('an app label is derived from the package, without pretending to be the real name', () => {
  assert.strictEqual(appLabel('com.spotify.music'), 'Music');
  assert.strictEqual(appLabel('com.google.android.youtube'), 'Youtube');
  assert.strictEqual(appLabel('com.foo.mediaPlayer'), 'Media Player');
  assert.strictEqual(appLabel(''), null);
  assert.strictEqual(appLabel(null), null);
});

test('describeTrack falls back through title, then app, then nothing', () => {
  assert.strictEqual(describeTrack(parseNowPlaying(DUMP)), 'Midnight City — M83');
  assert.strictEqual(
    describeTrack({ title: null, artist: null, app: 'Music' }), 'Music');
  assert.strictEqual(describeTrack({ title: 'Solo' }), 'Solo');
  assert.strictEqual(describeTrack(null), null);
});

test('a session block introduced only by its component name is still found', () => {
  const track = parseNowPlaying(`
  com.deezer.android.app/MediaSession (userId=0)
    state=PlaybackState {state=3, position=1000, actions=0}
    metadata: size=3, description=Track, Band, Record
  `);
  assert.strictEqual(track.package, 'com.deezer.android.app');
  assert.strictEqual(track.title, 'Track');
});

// ---------------------------------------------------------------------------
// Playback speed. position= is a snapshot, so the renderer advances it locally
// between polls; that needs the session's own speed, and a paused track must
// report 0 so nothing creeps forward.
// ---------------------------------------------------------------------------

test('playback speed is carried through so elapsed time can be advanced locally', () => {
  const [chrome, spotify] = parseAllSessions(DUMP);
  assert.strictEqual(spotify.speed, 1);
  assert.strictEqual(chrome.speed, 0, 'a paused session reports speed=0.0');
});

test('a session without a speed field reports null, not an assumed 1x', () => {
  const track = parseSession({
    pkg: 'com.example.player',
    text: 'package=com.example.player\nstate=PlaybackState {state=3, position=5000, actions=0}',
  });
  assert.strictEqual(track.speed, null);
});

test('no duration means no progress fraction — the bar has nothing to draw', () => {
  const track = parseSession({
    pkg: 'com.example.player',
    text: 'package=com.example.player\nstate=PlaybackState {state=3, position=28000, speed=1.0, actions=0}\nmetadata: size=3, description=40 Pra, Imran Khan, Unforgettable',
  });
  assert.strictEqual(track.positionMs, 28000);
  assert.strictEqual(track.durationMs, null);
  assert.strictEqual(track.duration, null);
  assert.strictEqual(track.progress, null);
  assert.strictEqual(track.position, '0:28');
});

test('duration is read from namespaced metadata keys, not just bare duration=', () => {
  const track = parseSession({
    pkg: 'com.example.player',
    text: 'package=com.example.player\nstate=PlaybackState {state=3, position=70000, speed=1.0, actions=0}\nmetadata: size=9, description=Song, Artist, Album\nandroid.media.metadata.DURATION=218000',
  });
  assert.strictEqual(track.durationMs, 218000);
  assert.strictEqual(track.duration, '3:38');
});

test('a seconds-scale duration is normalised when the position proves it', () => {
  const track = parseSession({
    pkg: 'com.example.player',
    text: 'package=com.example.player\nstate=PlaybackState {state=3, position=70000, speed=1.0, actions=0}\nmetadata: size=9, description=Song, Artist, Album\nduration=218',
  });
  assert.strictEqual(track.durationMs, 218000);
});

test('album-art URIs are found under vendor key spellings', () => {
  const text = 'package=com.spotify.music\nstate=PlaybackState {state=3, position=1000, speed=1.0, actions=0}\nmetadata: size=9, description=Song, Artist, Album\nandroid.media.metadata.ALBUM_ART_URI=content://media/external/audio/albumart/42}';
  const track = parseSession({ pkg: 'com.spotify.music', text });
  assert.strictEqual(track.artUri, 'content://media/external/audio/albumart/42');
  assert.deepStrictEqual(collectArtUris(text), ['content://media/external/audio/albumart/42']);
});

test('every art URI in a block is collected for ordered fallback', () => {
  const text = 'art=content://a/1,\nALBUM_ART_URI=content://b/2}';
  assert.deepStrictEqual(collectArtUris(text), ['content://a/1', 'content://b/2']);
});

test('dumpsys audio yields the music stream index across formats', () => {
  assert.deepStrictEqual(
    parseAudioVolume('STREAM_MUSIC(3): muted=false index:11(max:15)'),
    { index: 11, max: 15 });
  assert.deepStrictEqual(
    parseAudioVolume('stream:3 index:9'),
    { index: 9, max: 15 });
  assert.deepStrictEqual(parseAudioVolume(''), { index: null, max: 15 });
});

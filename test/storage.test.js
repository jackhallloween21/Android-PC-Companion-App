// Unit tests for the storage breakdown, run with `npm test` (node:test).
//
// Fixtures are shaped like real device output: a modern `df -k` where a long
// device-mapper path wraps, `sm list-volumes all` with and without a card, and a
// `dumpsys diskstats` block including the `-1` that Android writes for a
// category it could not measure.

const test = require('node:test');
const assert = require('node:assert');
const {
  formatBytes,
  parseDf,
  parseStorageDump,
  parseDiskstats,
  parseVolumes,
  parseDuBytes,
  buildSegments,
  buildStorageReport,
  STORAGE_SCRIPT,
  CATEGORIES,
} = require('../src/storage');

const DF = `Filesystem       1K-blocks      Used Available Use% Mounted on
/dev/block/dm-9  115343360  68923416  46419944  60% /data
/dev/block/dm-3    2965504   2836480    129024  96% /
/dev/fuse        115343360  68923416  46419944  60% /storage/emulated
/dev/block/vold/public:179,65
                  61069312  12058624  49010688  20% /storage/6132-3A29
`;

const VOLUMES = `private mounted null
emulated;0 mounted null
public:179,65 mounted 6132-3A29
`;

const DISKSTATS = `Latency: 3ms [512B Data Write]
Recent Disk Write Speed (kB/s) = 25000
Data-Free: 46419944K / 115343360K total = 40% free
Cache-Free: 46419944K / 115343360K total = 40% free
App Size: 20000000000
App Data Size: 5000000000
App Cache Size: 1000000000
Photos Size: 8000000000
Videos Size: 25000000000
Audio Size: 2000000000
Downloads Size: -1
System Size: 5000000000
Other Size: 1000000000
`;

test('byte formatting uses binary units and keeps one decimal where it helps', () => {
  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(1024), '1.0 KB');
  assert.strictEqual(formatBytes(7.4 * 1024 ** 3), '7.4 GB');
  // Above 100 the decimal is noise — a phone's storage is not known to 0.1 GB.
  assert.strictEqual(formatBytes(238 * 1024 ** 3), '238 GB');
  assert.strictEqual(formatBytes(null), '—');
  assert.strictEqual(formatBytes(-1), '—');
  assert.strictEqual(formatBytes('nonsense'), '—');
});

test('df rows parse into bytes, including a wrapped device path', () => {
  const rows = parseDf(DF);
  const data = rows.find((r) => r.mount === '/data');
  assert.strictEqual(data.totalBytes, 115343360 * 1024);
  assert.strictEqual(data.usedBytes, 68923416 * 1024);
  assert.strictEqual(data.freeBytes, 46419944 * 1024);
  // The vold path is on its own line and its numbers on the next; joining them
  // is the only way that row survives.
  const sd = rows.find((r) => r.mount === '/storage/6132-3A29');
  assert.ok(sd, 'the wrapped removable row was dropped');
  assert.strictEqual(sd.totalBytes, 61069312 * 1024);
  assert.deepStrictEqual(parseDf(''), []);
  assert.deepStrictEqual(parseDf(undefined), []);
});

test('a non-1K block size in the header is honoured', () => {
  const rows = parseDf('Filesystem 512-blocks Used Available Use% Mounted on\n/dev/x 2048 1024 1024 50% /data');
  assert.strictEqual(rows[0].totalBytes, 2048 * 512);
});

test('diskstats categories parse, and an unmeasured one is null not zero', () => {
  const stats = parseDiskstats(DISKSTATS);
  assert.strictEqual(stats.apps, 20000000000);
  assert.strictEqual(stats.videos, 25000000000);
  assert.strictEqual(stats.downloads, null, '-1 means Android could not measure it');
  assert.strictEqual(stats.dataTotalBytes, 115343360 * 1024);
  assert.strictEqual(stats.dataFreeBytes, 46419944 * 1024);
  assert.deepStrictEqual(parseDiskstats(''), {});
});

test('volumes are classified, and a removable one gets its mount path', () => {
  const vols = parseVolumes(VOLUMES);
  assert.strictEqual(vols.length, 3);
  const sd = vols.find((v) => v.removable);
  assert.strictEqual(sd.uuid, '6132-3A29');
  assert.strictEqual(sd.mount, '/storage/6132-3A29');
  assert.strictEqual(vols.find((v) => v.id === 'private').removable, false);
  assert.deepStrictEqual(parseVolumes('sm: command not found'), []);
});

test('the marked script output splits back into three sections', () => {
  const raw = `@@DF@@\n${DF}@@VOL@@\n${VOLUMES}@@DISK@@\n${DISKSTATS}`;
  const s = parseStorageDump(raw);
  assert.match(s.df, /1K-blocks/);
  assert.match(s.volumes, /public:179,65/);
  assert.match(s.diskstats, /App Size/);
  // Anything before the first marker belongs to no section and is discarded.
  assert.ok(!s.df.includes('@@'));
});

test('the script cannot fail on a device with no card', () => {
  // `sm list-volumes` exits non-zero on some builds; without `exit 0` that would
  // discard the df output too and the whole view would show nothing.
  assert.match(STORAGE_SCRIPT, /exit 0$/);
  assert.ok(!STORAGE_SCRIPT.includes('\n'), 'adb shell splices its args onto one line');
});

test('segments skip unmeasured categories and absorb the remainder into Other', () => {
  const used = 70000000000;
  const { segments, unaccounted } = buildSegments(parseDiskstats(DISKSTATS), used);
  const keys = segments.map((s) => s.key);
  assert.ok(!keys.includes('downloads'), 'an unmeasured category is left out, not drawn as 0 B');
  assert.strictEqual(keys[keys.length - 1], 'other');
  // Every segment sums back to `used`, so the bar cannot misreport its own total.
  assert.strictEqual(segments.reduce((a, s) => a + s.bytes, 0), used);
  // apps 20 + photos 8 + videos 25 + audio 2 + system 5 + measured other 1 = 61 GB,
  // so 9 GB of live usage is unaccounted for and joins the Other segment.
  assert.strictEqual(unaccounted, used - 61000000000);
  segments.forEach((s) => assert.match(s.color, /^#[0-9a-f]{6}$/i));
});

test('categories exceeding live usage do not produce a negative segment', () => {
  // diskstats is a cached measurement and df is live, so the cache can be higher
  // after the user deletes something.
  const { segments, unaccounted } = buildSegments({ apps: 900, photos: 900 }, 1000);
  assert.strictEqual(unaccounted, 0);
  assert.ok(segments.every((s) => s.bytes > 0));
  assert.strictEqual(segments.length, 2, 'no zero-width Other is appended');
});

test('segments with no usage figure at all still render what was measured', () => {
  const { segments, unaccounted } = buildSegments({ apps: 100 }, null);
  assert.deepStrictEqual(segments.map((s) => s.key), ['apps']);
  assert.strictEqual(unaccounted, null);
});

test('a full report covers internal and the card', () => {
  const report = buildStorageReport({ df: DF, volumes: VOLUMES, diskstats: DISKSTATS });
  assert.strictEqual(report.volumes.length, 2);
  assert.strictEqual(report.diskstatsAvailable, true);
  assert.strictEqual(report.sdPresent, true);

  const internal = report.volumes[0];
  // /data, not /sdcard: the FUSE view's totals can differ from the partition's.
  assert.strictEqual(internal.mount, '/data');
  assert.strictEqual(internal.totalBytes, 115343360 * 1024);
  assert.strictEqual(internal.categorised, true);

  const sd = report.volumes[1];
  assert.strictEqual(sd.removable, true);
  assert.strictEqual(sd.label, 'SD card (6132-3A29)');
  assert.strictEqual(sd.totalBytes, 61069312 * 1024);
  // Android measures categories only for internal storage, so the card gets one
  // plain "Used" segment rather than a fabricated split.
  assert.deepStrictEqual(sd.segments.map((s) => s.label), ['Used']);
  assert.strictEqual(sd.categorised, false);
});

test('no card means one volume, and the difference is reported', () => {
  const report = buildStorageReport({
    df: DF.split('\n').filter((l) => !/public|6132/.test(l)).join('\n'),
    volumes: 'private mounted null\nemulated;0 mounted null',
    diskstats: DISKSTATS,
  });
  assert.strictEqual(report.volumes.length, 1);
  assert.strictEqual(report.sdPresent, false);
  assert.strictEqual(report.sdDetected, false, 'nothing removable was even advertised');
});

test('a card sm calls mounted but df does not know is skipped, not shown as empty', () => {
  const report = buildStorageReport({
    df: 'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-9 100 50 50 50% /data',
    volumes: VOLUMES,
    diskstats: '',
  });
  assert.strictEqual(report.sdDetected, true, 'sm advertised it');
  assert.strictEqual(report.sdPresent, false, 'but "0 B of 0 B" would read as a broken card');
});

test('missing everything degrades to an empty report instead of throwing', () => {
  const report = buildStorageReport({});
  assert.deepStrictEqual(report.volumes, []);
  assert.strictEqual(report.diskstatsAvailable, false);
  assert.strictEqual(buildStorageReport().volumes.length, 0);
});

test('a deep du scan can categorise a card', () => {
  const du = parseDuBytes('4096\t/storage/6132-3A29/DCIM\n2048   /storage/6132-3A29/Music\n');
  assert.strictEqual(du['/storage/6132-3A29/DCIM'], 4096 * 1024);
  assert.strictEqual(du['/storage/6132-3A29/Music'], 2048 * 1024);
  assert.deepStrictEqual(parseDuBytes(''), {});

  const report = buildStorageReport({
    df: DF,
    volumes: VOLUMES,
    diskstats: DISKSTATS,
    deepScan: { '/storage/6132-3A29': { photos: 4096 * 1024, audio: 2048 * 1024 } },
  });
  const sd = report.volumes[1];
  assert.strictEqual(sd.categorised, true);
  assert.deepStrictEqual(sd.segments.map((s) => s.key), ['photos', 'audio', 'other']);
});

test('the palette is stable and every category has a distinct colour', () => {
  // The legend is generated from the same list as the bar, so a duplicate colour
  // would make two segments indistinguishable.
  const colors = CATEGORIES.map((c) => c.color);
  assert.strictEqual(new Set(colors).size, colors.length);
  assert.strictEqual(CATEGORIES[CATEGORIES.length - 1].key, 'other', 'Other draws last');
});

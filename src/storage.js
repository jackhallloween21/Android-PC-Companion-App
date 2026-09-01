// ---------------------------------------------------------------------------
// Storage breakdown (pure).
//
// Three sources, in descending order of trustworthiness:
//
//  1. `dumpsys diskstats` — Android's own categorisation of /data. It reports
//     real byte counts for apps, photos, videos, audio, downloads and system,
//     which is the only way to get a *category* split without root. It is a
//     cached measurement (MeasurementDetails), so it can be a few hours stale
//     and it can be missing entirely on some builds.
//  2. `df -k` — authoritative for total/used/free on any mount point. Always
//     available, but knows nothing about categories.
//  3. `du -sk <dir>` — a per-folder fallback when diskstats is unavailable, and
//     the only option at all for a removable card.
//
// The rule throughout: never invent a number. When the categories do not add up
// to what df says is used, the remainder becomes an explicit "Other" segment
// rather than being smeared across the known ones, and a category that could not
// be measured is absent rather than zero.
// ---------------------------------------------------------------------------

const KIB = 1024;

/**
 * Category order and palette. Order is the order segments are drawn in the bar,
 * so it must be stable; the colours live here (not only in CSS) because the bar
 * is built from data and the legend has to agree with it segment for segment.
 */
const CATEGORIES = [
  { key: 'apps', label: 'Apps', color: '#3b82f6' },
  { key: 'photos', label: 'Photos', color: '#34d399' },
  { key: 'videos', label: 'Videos', color: '#fbbf24' },
  { key: 'audio', label: 'Music', color: '#a855f7' },
  { key: 'downloads', label: 'Downloads', color: '#38bdf8' },
  { key: 'documents', label: 'Documents', color: '#f472b6' },
  { key: 'system', label: 'System', color: '#f87171' },
  { key: 'other', label: 'Other', color: '#64748b' },
];

const CATEGORY_BY_KEY = new Map(CATEGORIES.map((c) => [c.key, c]));

/** Bytes as a short human string. Binary units, because df and du are binary. */
function formatBytes(bytes, digits = null) {
  // Number(null) and Number('') are both 0, which would turn "we could not
  // measure this" into a confident "0 B".
  if (bytes === null || bytes === undefined || String(bytes).trim() === '') return '—';
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < KIB) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / KIB;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below 100 reads better ("7.4 GB"), whole numbers above it
  // ("238 GB") — a phone's storage is never known to 0.1 GB anyway.
  const places = digits === null ? (value < 100 ? 1 : 0) : digits;
  return `${value.toFixed(places)} ${units[unit]}`;
}

/**
 * `df -k` (or `df -k <path>`) into rows of bytes.
 *
 * Android's toybox df prints
 *   Filesystem     1K-blocks    Used Available Use% Mounted on
 *   /dev/block/dm-9 115343360 68923416  46419944  60% /data
 * but a long device path can wrap onto its own line, and the header wording
 * varies ("1K-blocks" vs "512-blocks" on some builds — hence the unit sniff).
 */
function parseDf(output) {
  const lines = String(output || '').split('\n');
  let blockSize = KIB;
  const rows = [];
  let carry = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/Filesystem/i.test(line)) {
      const m = line.match(/(\d+)[-\s]?blocks/i);
      if (m) blockSize = Number(m[1]);
      continue;
    }
    const text = carry ? `${carry} ${line}` : line;
    carry = null;
    const cols = text.split(/\s+/);
    if (cols.length === 1) { carry = text; continue; }
    // Filesystem <blocks> <used> <avail> <use%> <mount>
    const nums = cols.slice(1, 4).map(Number);
    if (nums.some((v) => !Number.isFinite(v))) continue;
    rows.push({
      filesystem: cols[0],
      mount: cols[cols.length - 1],
      totalBytes: nums[0] * blockSize,
      usedBytes: nums[1] * blockSize,
      freeBytes: nums[2] * blockSize,
    });
  }
  return rows;
}

// Section markers, so one adb round trip can carry three unrelated outputs.
// `exit 0` is deliberate: a script inherits the exit status of its last command,
// and `sm`/`dumpsys` failing on a device without a card would otherwise make adb
// report the whole read as a failure and throw away the df output too.
const STORAGE_SCRIPT = [
  'echo "@@DF@@";', 'df -k 2>/dev/null;',
  'echo "@@VOL@@";', 'sm list-volumes all 2>/dev/null;',
  'echo "@@DISK@@";', 'dumpsys diskstats 2>/dev/null;',
  'exit 0',
].join(' ');

/** Splits the marked STORAGE_SCRIPT output back into its three sections. */
function parseStorageDump(raw) {
  const sections = { df: '', volumes: '', diskstats: '' };
  let current = null;
  for (const line of String(raw || '').split('\n')) {
    const text = line.replace(/\r$/, '');
    if (text.trim() === '@@DF@@') { current = 'df'; continue; }
    if (text.trim() === '@@VOL@@') { current = 'volumes'; continue; }
    if (text.trim() === '@@DISK@@') { current = 'diskstats'; continue; }
    if (current) sections[current] += `${text}\n`;
  }
  return sections;
}

// `dumpsys diskstats` label -> our category key. These are byte counts measured
// by Android itself (the only category split available without root), read from
// a cache that a periodic job refreshes — so it can be hours stale, and the UI
// says so. A field it could not measure is reported as -1, which must become
// null rather than a confident zero.
const DISKSTAT_FIELDS = {
  'App Size': 'apps',
  'App Data Size': 'appData',
  'App Cache Size': 'appCache',
  'Photos Size': 'photos',
  'Videos Size': 'videos',
  'Audio Size': 'audio',
  'Downloads Size': 'downloads',
  'System Size': 'system',
  'Other Size': 'other',
};

function parseDiskstats(output) {
  const result = {};
  const text = String(output || '');
  for (const [label, key] of Object.entries(DISKSTAT_FIELDS)) {
    const m = text.match(new RegExp(`${label}\\s*:\\s*(-?\\d+)`, 'i'));
    if (!m) continue;
    const n = Number(m[1]);
    result[key] = Number.isFinite(n) && n >= 0 ? n : null;
  }
  // "Data-Free: 46419944K / 115343360K total = 40% free"
  const free = text.match(/Data-Free:\s*(\d+)K\s*\/\s*(\d+)K/i);
  if (free) {
    result.dataFreeBytes = Number(free[1]) * KIB;
    result.dataTotalBytes = Number(free[2]) * KIB;
  }
  return result;
}

/**
 * `sm list-volumes all` into volume descriptors. Rows are `<id> <state> <fsUuid>`:
 *   private mounted null
 *   emulated;0 mounted null
 *   public:179,65 mounted 6132-3A29
 * A `public:` volume is a removable card or a USB stick; there is no way to tell
 * which apart from the disk major number, so both are reported as removable and
 * labelled from the mount point rather than guessed at.
 */
function parseVolumes(output) {
  const volumes = [];
  for (const line of String(output || '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 2) continue;
    const [id, state, uuidRaw] = cols;
    if (!/^(private|public|emulated|stub)/.test(id)) continue;
    const uuid = !uuidRaw || uuidRaw === 'null' ? null : uuidRaw;
    volumes.push({
      id,
      state,
      uuid,
      removable: id.startsWith('public'),
      mount: id.startsWith('public') && uuid ? `/storage/${uuid}` : null,
    });
  }
  return volumes;
}

/** `du -sk <dir>` lines into bytes keyed by path. Used only for a deep scan. */
function parseDuBytes(output) {
  const sizes = {};
  for (const line of String(output || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S.*)$/);
    if (m) sizes[m[2].trim()] = Number(m[1]) * KIB;
  }
  return sizes;
}

/**
 * Turns the measured categories into drawable segments.
 *
 * Two rules keep this honest. Categories that Android did not measure are left
 * out entirely rather than drawn as a zero-width segment with a legend entry
 * claiming 0 B. And whatever `used` is left over after the known categories
 * becomes one explicit "Other" segment — the alternative, scaling the known
 * categories up to fill the bar, would silently misreport every one of them.
 * diskstats is a cached measurement while df is live, so the leftover is usually
 * real drift rather than an error.
 */
function buildSegments(categories, usedBytes) {
  const cats = categories || {};
  const segments = [];
  let accounted = 0;
  for (const cat of CATEGORIES) {
    if (cat.key === 'other') continue;
    const bytes = cats[cat.key];
    if (!Number.isFinite(bytes) || bytes <= 0) continue;
    segments.push({ ...cat, bytes });
    accounted += bytes;
  }

  const measuredOther = Number.isFinite(cats.other) && cats.other > 0 ? cats.other : 0;
  const total = accounted + measuredOther;
  // A negative leftover means the cached categories now exceed live usage, so
  // there is nothing to add.
  const leftover = Number.isFinite(usedBytes) ? Math.max(0, usedBytes - total) : 0;
  const otherBytes = measuredOther + leftover;
  if (otherBytes > 0) segments.push({ ...CATEGORY_BY_KEY.get('other'), bytes: otherBytes });

  return { segments, measured: total, unaccounted: Number.isFinite(usedBytes) ? leftover : null };
}

/**
 * The whole picture: one entry per volume, each with a total, a used figure and
 * the segments to draw.
 *
 * Internal storage is measured on `/data`, not `/sdcard`. They are the same
 * physical space, but `df /sdcard` on a modern device reports the emulated FUSE
 * view, whose totals can differ from the real partition.
 *
 * A removable card gets no category breakdown, and that is a limitation rather
 * than an oversight: Android only measures categories for internal storage, so
 * the only way to categorise a card is to walk it with `du`, which is what
 * `deepScan` is for.
 */
function buildStorageReport({ df = '', volumes = '', diskstats = '', deepScan = null } = {}) {
  const rows = parseDf(df);
  const vols = parseVolumes(volumes);
  const stats = parseDiskstats(diskstats);
  const byMount = (mount) => rows.find((r) => r.mount === mount) || null;

  const out = [];

  const dataRow = byMount('/data') || byMount('/data/user/0');
  const internalTotal = dataRow ? dataRow.totalBytes : stats.dataTotalBytes ?? null;
  const internalFree = dataRow ? dataRow.freeBytes : stats.dataFreeBytes ?? null;
  const internalUsed = dataRow
    ? dataRow.usedBytes
    : (internalTotal !== null && internalFree !== null ? internalTotal - internalFree : null);

  if (internalTotal !== null) {
    const { segments, unaccounted } = buildSegments(stats, internalUsed);
    out.push({
      key: 'internal',
      label: 'Internal storage',
      mount: dataRow ? dataRow.mount : '/data',
      removable: false,
      totalBytes: internalTotal,
      usedBytes: internalUsed,
      freeBytes: internalFree,
      segments,
      unaccountedBytes: unaccounted,
      categorised: segments.length > 1,
    });
  }

  // Removable volumes: every mounted `public:` volume that df also knows about.
  // A card that sm reports as mounted but df does not is skipped rather than
  // shown with unknown sizes — "0 B of 0 B" reads as a broken card.
  for (const vol of vols) {
    if (!vol.removable || vol.state !== 'mounted') continue;
    const row = (vol.mount && byMount(vol.mount))
      || rows.find((r) => r.mount.startsWith('/storage/') && !/emulated|self/.test(r.mount));
    if (!row) continue;
    if (out.some((v) => v.mount === row.mount)) continue;
    const deep = deepScan && deepScan[row.mount];
    const { segments } = deep
      ? buildSegments(deep, row.usedBytes)
      : { segments: [{ ...CATEGORY_BY_KEY.get('other'), label: 'Used', bytes: row.usedBytes }] };
    out.push({
      key: `sd:${vol.uuid || row.mount}`,
      label: vol.uuid ? `SD card (${vol.uuid})` : 'SD card',
      mount: row.mount,
      removable: true,
      totalBytes: row.totalBytes,
      usedBytes: row.usedBytes,
      freeBytes: row.freeBytes,
      segments,
      unaccountedBytes: null,
      categorised: !!deep,
    });
  }

  return {
    volumes: out,
    diskstatsAvailable: Object.keys(stats).length > 0,
    sdPresent: out.some((v) => v.removable),
    sdDetected: vols.some((v) => v.removable),
  };
}

module.exports = {
  KIB, CATEGORIES, CATEGORY_BY_KEY, formatBytes, parseDf,
  STORAGE_SCRIPT, parseStorageDump, parseDiskstats,
  parseVolumes, parseDuBytes, buildSegments, buildStorageReport,
};

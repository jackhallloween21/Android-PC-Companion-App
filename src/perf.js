// ---------------------------------------------------------------------------
// Pure parsing/normalisation for live CPU and RAM telemetry.
//
// There is no single Android API that gives a usable "CPU load" number over
// adb. /proc/stat exposes *cumulative* jiffy counters since boot, so a single
// read only tells you the average load since the device powered on — useless as
// a live reading. The only correct way is to sample twice a short time apart
// and divide the deltas, which is why PERF_SCRIPT does the sleep on-device
// rather than making two adb round trips (two round trips would add the adb
// latency, which is variable, into the sampling window).
//
// RAM is similar: /proc/meminfo is exact but says nothing about which part of
// the usage is app memory vs kernel, and `dumpsys meminfo` knows that split but
// reports pre-rounded, comma-formatted kB. So we take the totals from
// /proc/meminfo and only the app/kernel split from dumpsys.
//
// Everything here is deliberately free of Electron/child_process so it can be
// unit-tested against captured device output.
// ---------------------------------------------------------------------------

// toCelsius already handles the milli/deci/degree ambiguity of thermal nodes,
// so it is reused rather than reimplemented. The SoC-zone *patterns* are not
// exported by src/power.js, so they are duplicated below (kept in sync by hand).
const { toCelsius } = require('./power');

// One adb round trip. `adb shell` splices its arguments back together and hands
// the result to the device shell, so this has to stay a single line.
//
// Every read is guarded with `[ -r ... ]`: cpufreq is restricted on some builds
// (SELinux denies the shell user), and when a core is hot-unplugged its whole
// /sys/devices/system/cpu/cpuN/cpufreq directory disappears. An unguarded cat
// would spray errors onto stdout and corrupt the delimited output.
const PERF_SCRIPT = [
  // Sample 1 and sample 2 of the cumulative jiffy counters, 0.4 s apart. That
  // window is long enough to be statistically meaningful and short enough that
  // the UI still feels live.
  'cat /proc/stat 2>/dev/null | sed -e "s/^/S1|/";',
  'sleep 0.4;',
  'cat /proc/stat 2>/dev/null | sed -e "s/^/S2|/";',
  'cat /proc/meminfo 2>/dev/null | sed -e "s/^/MI|/";',
  'for d in /sys/devices/system/cpu/cpu*/cpufreq; do',
  'c=${d%/cpufreq}; c=${c##*/};',
  'for n in scaling_cur_freq cpuinfo_min_freq cpuinfo_max_freq; do',
  '[ -r "$d/$n" ] && echo "FQ|$c|$n|$(cat "$d/$n" 2>/dev/null)";',
  'done; done;',
  '[ -r /sys/devices/system/cpu/online ] && echo "ON|$(cat /sys/devices/system/cpu/online 2>/dev/null)";',
  // `exit 0` is load-bearing for the same reason it is in POWER_SCRIPT: a script
  // inherits the status of its last command, and the last command here is a
  // `[ -r … ] && echo …`. Without this, a device that does not expose the online
  // mask would make `adb shell` return 1 and the whole sample would be thrown
  // away as a failure.
  'exit 0',
].join(' ');

// Number(null) and Number('') are both 0, which would turn "we could not read
// this" into a confident zero, so empty-ish values are rejected up front.
const num = (v) => {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Splits the delimited PERF_SCRIPT output back into its four sections.
 * Unknown prefixes are ignored so a stray kernel warning cannot break parsing.
 */
function parsePerfDump(raw) {
  const stat1 = [];
  const stat2 = [];
  const meminfo = [];
  const freqs = {};
  let online = [];

  (raw || '').split('\n').forEach((line) => {
    const text = line.replace(/\r$/, '');
    const bar = text.indexOf('|');
    if (bar === -1) return;
    const tag = text.slice(0, bar);
    const rest = text.slice(bar + 1);
    if (tag === 'S1') stat1.push(rest);
    else if (tag === 'S2') stat2.push(rest);
    else if (tag === 'MI') meminfo.push(rest);
    else if (tag === 'FQ') {
      // FQ|cpu3|scaling_cur_freq|1804800
      const [core, node, ...value] = rest.split('|');
      const idx = num((core || '').replace(/^cpu/, ''));
      const v = num(value.join('|').trim());
      if (idx === null || v === null) return;
      freqs[idx] = freqs[idx] || { cur: null, min: null, max: null };
      if (node === 'scaling_cur_freq') freqs[idx].cur = v;
      else if (node === 'cpuinfo_min_freq') freqs[idx].min = v;
      else if (node === 'cpuinfo_max_freq') freqs[idx].max = v;
    } else if (tag === 'ON') {
      online = parseOnlineMask(rest);
    }
  });

  return {
    stat1: stat1.join('\n'),
    stat2: stat2.join('\n'),
    meminfo: meminfo.join('\n'),
    freqs,
    online,
  };
}

/** Expands a kernel CPU mask such as "0-3,6-7" or "0,2,4" into indices. */
function parseOnlineMask(text) {
  const out = [];
  (text || '').trim().split(',').forEach((part) => {
    const range = part.trim();
    if (!range) return;
    const m = range.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const from = Number(m[1]);
      const to = Number(m[2]);
      for (let i = from; i <= to; i += 1) out.push(i);
    } else {
      const one = num(range);
      if (one !== null) out.push(one);
    }
  });
  return out;
}

/**
 * Parses /proc/stat into the two numbers a load calculation needs per CPU.
 *
 * Field order is: user nice system idle iowait irq softirq steal guest
 * guest_nice. Older kernels print fewer fields (no steal/guest at all), so the
 * sums are taken over whatever is present rather than fixed offsets.
 *
 * `idle` counts idle + iowait: a core parked waiting on flash is not doing
 * work, and counting iowait as busy makes every storage-heavy moment look like
 * a pegged CPU.
 */
function parseProcStat(text) {
  let overall = null;
  const cores = [];

  (text || '').split('\n').forEach((line) => {
    const m = line.trim().match(/^cpu(\d*)\s+(.*)$/);
    if (!m) return;
    const fields = m[2].trim().split(/\s+/).map(num).filter((n) => n !== null);
    if (fields.length < 4) return; // need at least user/nice/system/idle
    const total = fields.reduce((a, b) => a + b, 0);
    const idle = fields[3] + (fields[4] || 0); // idle + iowait
    if (m[1] === '') overall = { idle, total };
    else cores.push({ index: Number(m[1]), idle, total });
  });

  cores.sort((a, b) => a.index - b.index);
  return { overall: overall || { idle: 0, total: 0 }, cores };
}

/** 0-100 from two cumulative counters, or null when the delta says nothing. */
function pctFromDeltas(a, b) {
  if (!a || !b) return null;
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  // dTotal === 0 means the samples are identical (or the counters were reset):
  // no jiffies elapsed, so there is no load to report. Reporting 0% here would
  // claim the CPU was measured as idle, which is a different statement.
  if (!(dTotal > 0)) return null;
  const pct = (1 - dIdle / dTotal) * 100;
  if (!Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

/**
 * CPU usage between two parseProcStat results.
 *
 * A core present in only one sample was hot-plugged mid-window; its load is
 * unmeasurable and it is reported as null, never 0.
 */
function cpuUsage(sampleA, sampleB) {
  const a = sampleA || { overall: null, cores: [] };
  const b = sampleB || { overall: null, cores: [] };
  const byIndexB = new Map((b.cores || []).map((c) => [c.index, c]));

  const cores = (a.cores || []).map((coreA) => ({
    index: coreA.index,
    pct: pctFromDeltas(coreA, byIndexB.get(coreA.index)),
  }));

  // Cores that only exist in the second sample (just came online) are listed
  // too, so the renderer sees the real core count.
  (b.cores || []).forEach((coreB) => {
    if (!cores.some((c) => c.index === coreB.index)) cores.push({ index: coreB.index, pct: null });
  });
  cores.sort((x, y) => x.index - y.index);

  return { overall: pctFromDeltas(a.overall, b.overall), cores };
}

const KB = 1024;

/** Reads a `MemTotal: 11393692 kB` style line. /proc/meminfo is always in kB. */
function meminfoKey(text, key) {
  const re = new RegExp(`^${key}\\s*:\\s*(\\d+)`, 'im');
  const m = (text || '').match(re);
  return m ? Number(m[1]) * KB : null;
}

/**
 * /proc/meminfo in bytes.
 *
 * usedBytes is total - MemAvailable, not total - MemFree. Linux deliberately
 * fills all spare RAM with page cache, so total - free reads as ~95% used on a
 * perfectly healthy phone. MemAvailable is the kernel's own estimate of what a
 * new allocation could get, which is what a user means by "free".
 */
function parseMeminfo(text) {
  const totalBytes = meminfoKey(text, 'MemTotal');
  const freeBytes = meminfoKey(text, 'MemFree');
  const availableBytes = meminfoKey(text, 'MemAvailable');
  const swapTotalBytes = meminfoKey(text, 'SwapTotal');
  const swapFreeBytes = meminfoKey(text, 'SwapFree');
  return {
    totalBytes,
    freeBytes,
    availableBytes,
    buffersBytes: meminfoKey(text, 'Buffers'),
    cachedBytes: meminfoKey(text, 'Cached'),
    swapTotalBytes,
    swapFreeBytes,
    usedBytes: totalBytes !== null && availableBytes !== null ? totalBytes - availableBytes : null,
  };
}

/** "11,671,140K" -> bytes. dumpsys formats with thousands separators. */
function dumpsysK(v) {
  const n = num(String(v == null ? '' : v).replace(/,/g, '').replace(/K$/i, ''));
  return n === null ? null : n * KB;
}

/**
 * The RAM summary at the tail of `dumpsys meminfo`:
 *
 *       Total RAM: 11,671,140K (status normal)
 *        Free RAM: 4,875,214K (2,110,236K cached pss + ...)
 *        Used RAM: 6,795,926K (5,236,412K used pss + 1,559,514K kernel)
 *        Lost RAM: 74,288K
 *
 * Only used for the app-vs-kernel split; the totals come from /proc/meminfo,
 * which is exact rather than rounded. Some builds (and `dumpsys meminfo <pkg>`)
 * print only the per-process PSS table with no summary at all, so every field
 * is independently optional.
 */
function parseDumpsysMeminfo(text) {
  const src = text || '';
  const grab = (label) => {
    const m = src.match(new RegExp(`${label}\\s+RAM\\s*:\\s*([\\d,]+K)`, 'i'));
    return m ? dumpsysK(m[1]) : null;
  };

  // The Used RAM parenthesis carries the split: "5,236,412K used pss + 1,559,514K kernel".
  const usedLine = src.match(/Used\s+RAM\s*:\s*[\d,]+K\s*\(([^)]*)\)/i);
  const inner = usedLine ? usedLine[1] : '';
  const pick = (suffix) => {
    const m = inner.match(new RegExp(`([\\d,]+K)\\s+${suffix}`, 'i'));
    return m ? dumpsysK(m[1]) : null;
  };

  return {
    totalBytes: grab('Total'),
    freeBytes: grab('Free'),
    usedBytes: grab('Used'),
    lostBytes: grab('Lost'),
    appBytes: pick('used pss'),
    kernelBytes: pick('kernel'),
  };
}

// Duplicated from src/power.js, which does not export its zone patterns. Any
// change there should be mirrored here.
const SOC_ZONE_PATTERNS = [/soc/i, /aoss/i, /tsens/i, /apc/i, /^cpu/i, /big/i, /silver/i, /gpu/i];

function pickSocZone(zones) {
  const list = zones || [];
  for (const re of SOC_ZONE_PATTERNS) {
    const hit = list.find((z) => z && re.test(z.type || ''));
    if (hit) return hit;
  }
  return null;
}

const toGhz = (kHz) => (kHz ? Number((kHz / 1e6).toFixed(2)) : null);

/**
 * Flattens everything into the shape the renderer consumes.
 *
 * Nothing is ever fabricated: a value that could not be read stays null so the
 * UI can render a dash instead of a confident-looking zero.
 */
function buildPerfReport({ perf = null, dumpsys = null, processCount = null, zones = [] } = {}) {
  const dump = perf || { stat1: '', stat2: '', meminfo: '', freqs: {}, online: [] };
  const usage = cpuUsage(parseProcStat(dump.stat1), parseProcStat(dump.stat2));
  const freqs = dump.freqs || {};
  const online = dump.online || [];

  // Core list is the union of what /proc/stat and cpufreq saw, so an offline
  // core still gets a row (marked offline) instead of silently vanishing.
  const indices = new Set(usage.cores.map((c) => c.index));
  Object.keys(freqs).forEach((k) => indices.add(Number(k)));
  online.forEach((i) => indices.add(i));

  const cores = [...indices].sort((a, b) => a - b).map((index) => {
    const f = freqs[index] || {};
    return {
      index,
      pct: (usage.cores.find((c) => c.index === index) || {}).pct ?? null,
      curGhz: toGhz(f.cur),
      maxGhz: toGhz(f.max),
      // With no mask at all we cannot claim a core is offline, so assume online.
      online: online.length ? online.includes(index) : true,
    };
  });

  const mem = parseMeminfo(dump.meminfo);
  const ds = dumpsys || {};

  const memTotalBytes = mem.totalBytes ?? ds.totalBytes ?? null;
  const memUsedBytes = mem.usedBytes ?? ds.usedBytes ?? null;
  const memAvailableBytes = mem.availableBytes ?? ds.freeBytes ?? null;
  const memUsedPct = memTotalBytes && memUsedBytes !== null
    ? Math.max(0, Math.min(100, Math.round((memUsedBytes / memTotalBytes) * 100)))
    : null;

  const swapTotalBytes = mem.swapTotalBytes;
  const swapUsedBytes = swapTotalBytes !== null && mem.swapFreeBytes !== null
    ? swapTotalBytes - mem.swapFreeBytes
    : null;

  const socZone = pickSocZone(zones);

  return {
    cpuOverallPct: usage.overall,
    cores,
    coreCount: cores.length || null,
    memTotalBytes,
    memUsedBytes,
    memAvailableBytes,
    memUsedPct,
    appBytes: ds.appBytes ?? null,
    kernelBytes: ds.kernelBytes ?? null,
    swapTotalBytes,
    swapUsedBytes,
    processCount: num(processCount),
    socTempC: socZone ? toCelsius(socZone.raw) : null,
  };
}

module.exports = {
  PERF_SCRIPT,
  parsePerfDump,
  parseOnlineMask,
  parseProcStat,
  cpuUsage,
  parseMeminfo,
  parseDumpsysMeminfo,
  buildPerfReport,
};

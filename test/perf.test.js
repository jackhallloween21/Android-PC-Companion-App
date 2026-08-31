// Unit tests for the CPU/RAM performance parsers, run with `npm test`
// (node:test). Fixtures are shaped like real device output: two /proc/stat
// samples 0.4 s apart from an 8-core-class SoC, a Pixel-style /proc/meminfo,
// and the RAM summary tail of `dumpsys meminfo` with its comma separators.

const test = require('node:test');
const assert = require('node:assert');
const {
  PERF_SCRIPT,
  parsePerfDump,
  parseOnlineMask,
  parseProcStat,
  cpuUsage,
  parseMeminfo,
  parseDumpsysMeminfo,
  buildPerfReport,
} = require('../src/perf');

const KB = 1024;

// Two samples 0.4 s apart. Between them cpu0 burns 100 jiffies entirely in
// user time (pegged) while cpu1 burns 100 jiffies entirely in idle.
const STAT_1 = `
cpu  100 0 50 1000 20 5 5 0 0 0
cpu0 50 0 25 500 10 2 2 0 0 0
cpu1 50 0 25 500 10 3 3 0 0 0
intr 123456 0 0
ctxt 987654
btime 1700000000
procs_running 2
`.trim();

const STAT_2 = `
cpu  200 0 50 1100 20 5 5 0 0 0
cpu0 150 0 25 500 10 2 2 0 0 0
cpu1 50 0 25 600 10 3 3 0 0 0
intr 123999 0 0
ctxt 991111
btime 1700000000
procs_running 3
`.trim();

const MEMINFO = `
MemTotal:       11393692 kB
MemFree:          412344 kB
MemAvailable:    4759112 kB
Buffers:           38220 kB
Cached:          3980112 kB
SwapCached:        11220 kB
Active:          3120044 kB
Inactive:        2210332 kB
SwapTotal:       4194300 kB
SwapFree:        3110400 kB
Dirty:               412 kB
`.trim();

const DUMPSYS_MEMINFO = `Total PSS by OOM adjustment:
    1,234,567K: Native
       12,345K: System

Total RAM: 11,671,140K (status normal)
 Free RAM: 4,875,214K (2,110,236K cached pss + 1,905,664K cached kernel + 859,314K free)
 Used RAM: 6,795,926K (5,236,412K used pss + 1,559,514K kernel)
 Lost RAM: 74,288K
     ZRAM: 402,124K physical used for 1,083,900K in swap (4,194,300K total swap)
`;

test('PERF_SCRIPT stays a single line and guards every optional read', () => {
  assert.ok(!PERF_SCRIPT.includes('\n'), 'adb shell splices its args onto one line');
  // Two /proc/stat samples with an on-device sleep between them: the delta is
  // what makes the reading live rather than an average since boot.
  assert.ok(PERF_SCRIPT.includes('S1|'));
  assert.ok(PERF_SCRIPT.includes('S2|'));
  // See src/perf.js: without the trailing `exit 0` an unreadable optional node
  // makes adb return 1 and the whole sample is discarded as a failure.
  assert.match(PERF_SCRIPT, /exit 0$/);
  assert.ok(PERF_SCRIPT.includes('sleep 0.4'));
  assert.ok(PERF_SCRIPT.includes('MI|'));
  assert.ok(PERF_SCRIPT.includes('/sys/devices/system/cpu/online'));
  // cpufreq is denied to the shell user on some builds; nothing is cat'ed blind.
  assert.ok(PERF_SCRIPT.includes('[ -r "$d/$n" ]'));
  assert.ok(PERF_SCRIPT.includes('[ -r /sys/devices/system/cpu/online ]'));
});

test('/proc/stat splits into an aggregate and per-core counters', () => {
  const s = parseProcStat(STAT_1);
  assert.strictEqual(s.overall.total, 1180);
  assert.strictEqual(s.overall.idle, 1020, 'idle is idle + iowait');
  assert.deepStrictEqual(s.cores.map((c) => c.index), [0, 1]);
  assert.strictEqual(s.cores[0].total, 589);
  assert.strictEqual(s.cores[0].idle, 510);
});

test('short /proc/stat lines from older kernels are tolerated', () => {
  // No steal/guest/guest_nice columns at all.
  const s = parseProcStat('cpu  10 0 5 100 0 0 0\ncpu0 10 0 5 100\n');
  assert.strictEqual(s.overall.total, 115);
  assert.strictEqual(s.overall.idle, 100);
  assert.strictEqual(s.cores[0].total, 115);
  assert.strictEqual(s.cores[0].idle, 100, 'missing iowait counts as zero');
});

test('usage comes from the deltas: one pegged core, one idle core', () => {
  const u = cpuUsage(parseProcStat(STAT_1), parseProcStat(STAT_2));
  assert.strictEqual(u.overall, 50);
  assert.deepStrictEqual(u.cores, [
    { index: 0, pct: 100 },
    { index: 1, pct: 0 },
  ]);
});

test('identical samples report null, not 0', () => {
  // No jiffies elapsed means nothing was measured. Reporting 0% would claim
  // the CPU was observed to be idle, which is a different statement.
  const u = cpuUsage(parseProcStat(STAT_1), parseProcStat(STAT_1));
  assert.strictEqual(u.overall, null);
  assert.deepStrictEqual(u.cores, [
    { index: 0, pct: null },
    { index: 1, pct: null },
  ]);
});

test('a core that disappears between samples is null, never 0', () => {
  const second = STAT_2.split('\n').filter((l) => !l.startsWith('cpu1 ')).join('\n');
  const u = cpuUsage(parseProcStat(STAT_1), parseProcStat(second));
  assert.strictEqual(u.cores.find((c) => c.index === 0).pct, 100);
  assert.strictEqual(u.cores.find((c) => c.index === 1).pct, null, 'hot-unplugged mid-window');
});

test('a core that appears only in the second sample is listed as unmeasured', () => {
  const first = STAT_1.split('\n').filter((l) => !l.startsWith('cpu1 ')).join('\n');
  const u = cpuUsage(parseProcStat(first), parseProcStat(STAT_2));
  assert.deepStrictEqual(u.cores.map((c) => c.index), [0, 1]);
  assert.strictEqual(u.cores[1].pct, null);
});

test('usage survives missing samples entirely', () => {
  const u = cpuUsage(null, null);
  assert.strictEqual(u.overall, null);
  assert.deepStrictEqual(u.cores, []);
});

test('meminfo used is total minus available, not total minus free', () => {
  const m = parseMeminfo(MEMINFO);
  assert.strictEqual(m.totalBytes, 11393692 * KB);
  assert.strictEqual(m.freeBytes, 412344 * KB);
  assert.strictEqual(m.availableBytes, 4759112 * KB);
  assert.strictEqual(m.buffersBytes, 38220 * KB);
  assert.strictEqual(m.cachedBytes, 3980112 * KB, 'Cached, not SwapCached');
  assert.strictEqual(m.swapTotalBytes, 4194300 * KB);
  assert.strictEqual(m.swapFreeBytes, 3110400 * KB);
  // total - available. total - free would count the page cache as used and
  // show a healthy phone as permanently ~96% full.
  assert.strictEqual(m.usedBytes, (11393692 - 4759112) * KB);
});

test('meminfo with missing keys yields nulls rather than zeros', () => {
  const m = parseMeminfo('MemTotal:       11393692 kB\n');
  assert.strictEqual(m.totalBytes, 11393692 * KB);
  assert.strictEqual(m.availableBytes, null);
  assert.strictEqual(m.usedBytes, null, 'derived value needs both inputs');
  assert.deepStrictEqual(parseMeminfo('').totalBytes, null);
});

test('dumpsys meminfo parses comma-separated kB and the used-RAM split', () => {
  const d = parseDumpsysMeminfo(DUMPSYS_MEMINFO);
  assert.strictEqual(d.totalBytes, 11671140 * KB);
  assert.strictEqual(d.freeBytes, 4875214 * KB);
  assert.strictEqual(d.usedBytes, 6795926 * KB);
  assert.strictEqual(d.lostBytes, 74288 * KB);
  assert.strictEqual(d.appBytes, 5236412 * KB, 'from "used pss" inside the parentheses');
  assert.strictEqual(d.kernelBytes, 1559514 * KB);
});

test('dumpsys meminfo without the RAM summary returns nulls instead of throwing', () => {
  const onlyPss = `Total PSS by process:
    412,344K: com.android.systemui (pid 2311)
    128,900K: com.google.android.gms (pid 4102)
`;
  const d = parseDumpsysMeminfo(onlyPss);
  assert.deepStrictEqual(d, {
    totalBytes: null, freeBytes: null, usedBytes: null,
    lostBytes: null, appBytes: null, kernelBytes: null,
  });
  assert.strictEqual(parseDumpsysMeminfo('').totalBytes, null);
  assert.strictEqual(parseDumpsysMeminfo(undefined).usedBytes, null);
});

test('the online mask expands mixed ranges and singletons', () => {
  assert.deepStrictEqual(parseOnlineMask('0-7'), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(parseOnlineMask('0-3,6-7'), [0, 1, 2, 3, 6, 7]);
  assert.deepStrictEqual(parseOnlineMask('0,2,4\n'), [0, 2, 4]);
  assert.deepStrictEqual(parseOnlineMask('3'), [3]);
  assert.deepStrictEqual(parseOnlineMask(''), []);
});

test('dump sections are separated and unreadable cpufreq dirs are simply absent', () => {
  // cpu2 is present in /proc/stat but its cpufreq directory was unreadable, so
  // no FQ lines were emitted for it at all.
  const raw = [
    ...STAT_1.split('\n').map((l) => `S1|${l}`),
    ...STAT_2.split('\n').map((l) => `S2|${l}`),
    ...MEMINFO.split('\n').map((l) => `MI|${l}`),
    'FQ|cpu0|scaling_cur_freq|1401600',
    'FQ|cpu0|cpuinfo_min_freq|300000',
    'FQ|cpu0|cpuinfo_max_freq|1803000',
    'FQ|cpu1|scaling_cur_freq|2350000',
    'FQ|cpu1|cpuinfo_min_freq|400000',
    'FQ|cpu1|cpuinfo_max_freq|2850000',
    'ON|0-2',
  ].join('\n');

  const d = parsePerfDump(raw);
  assert.ok(d.stat1.startsWith('cpu  100'));
  assert.ok(d.stat2.startsWith('cpu  200'));
  assert.ok(d.meminfo.startsWith('MemTotal:'));
  assert.deepStrictEqual(d.freqs[0], { cur: 1401600, min: 300000, max: 1803000 });
  assert.deepStrictEqual(d.freqs[1], { cur: 2350000, min: 400000, max: 2850000 });
  assert.strictEqual(d.freqs[2], undefined, 'restricted cpufreq dir yields no entry');
  assert.deepStrictEqual(d.online, [0, 1, 2]);
});

test('partial cpufreq reads keep the nodes that were readable', () => {
  // scaling_cur_freq is 0400 on some builds while cpuinfo_* stays world-readable.
  const d = parsePerfDump('FQ|cpu3|cpuinfo_max_freq|2850000\nFQ|cpu3|cpuinfo_min_freq|400000');
  assert.deepStrictEqual(d.freqs[3], { cur: null, min: 400000, max: 2850000 });
});

test('the report flattens CPU, RAM and thermal into renderer fields', () => {
  const raw = [
    ...STAT_1.split('\n').map((l) => `S1|${l}`),
    ...STAT_2.split('\n').map((l) => `S2|${l}`),
    ...MEMINFO.split('\n').map((l) => `MI|${l}`),
    'FQ|cpu0|scaling_cur_freq|1401600',
    'FQ|cpu0|cpuinfo_max_freq|1803000',
    'FQ|cpu1|scaling_cur_freq|2280000',
    'FQ|cpu1|cpuinfo_max_freq|2850000',
    'ON|0-1',
  ].join('\n');

  const r = buildPerfReport({
    perf: parsePerfDump(raw),
    dumpsys: parseDumpsysMeminfo(DUMPSYS_MEMINFO),
    processCount: 412,
    // Exactly the shape parsePowerDump() returns.
    zones: [{ type: 'battery', raw: 31400 }, { type: 'soc_therm', raw: 42500 }],
  });

  assert.strictEqual(r.cpuOverallPct, 50);
  assert.strictEqual(r.coreCount, 2);
  assert.deepStrictEqual(r.cores, [
    { index: 0, pct: 100, curGhz: 1.4, maxGhz: 1.8, online: true },
    { index: 1, pct: 0, curGhz: 2.28, maxGhz: 2.85, online: true },
  ]);

  // Totals come from /proc/meminfo (exact), the split from dumpsys (rounded).
  assert.strictEqual(r.memTotalBytes, 11393692 * KB);
  assert.strictEqual(r.memUsedBytes, (11393692 - 4759112) * KB);
  assert.strictEqual(r.memAvailableBytes, 4759112 * KB);
  assert.strictEqual(r.memUsedPct, 58);
  assert.strictEqual(r.appBytes, 5236412 * KB);
  assert.strictEqual(r.kernelBytes, 1559514 * KB);
  assert.strictEqual(r.swapTotalBytes, 4194300 * KB);
  assert.strictEqual(r.swapUsedBytes, (4194300 - 3110400) * KB);
  assert.strictEqual(r.processCount, 412);
  assert.strictEqual(r.socTempC, 42.5);
});

test('offline cores still get a row, marked offline and unmeasured', () => {
  // cpu3 is hot-unplugged: absent from /proc/stat and from cpufreq, present
  // only by its absence in the online mask.
  const raw = [
    'S1|cpu  100 0 50 1000 20 5 5 0 0 0',
    'S1|cpu0 50 0 25 500 10 2 2 0 0 0',
    'S2|cpu  200 0 50 1100 20 5 5 0 0 0',
    'S2|cpu0 150 0 25 500 10 2 2 0 0 0',
    'FQ|cpu0|scaling_cur_freq|1401600',
    'ON|0-1',
  ].join('\n');

  const r = buildPerfReport({ perf: parsePerfDump(raw) });
  assert.strictEqual(r.coreCount, 2);
  assert.deepStrictEqual(r.cores[1], {
    index: 1, pct: null, curGhz: null, maxGhz: null, online: true,
  });

  const noMask = buildPerfReport({ perf: parsePerfDump(raw.replace('ON|0-1', 'FQ|cpu5|cpuinfo_max_freq|2850000')) });
  assert.strictEqual(noMask.cores[1].online, true, 'no mask means we cannot claim offline');
  assert.strictEqual(noMask.cores[1].index, 5);
});

test('missing everything degrades to nulls instead of throwing', () => {
  const r = buildPerfReport({});
  assert.strictEqual(r.cpuOverallPct, null);
  assert.deepStrictEqual(r.cores, []);
  assert.strictEqual(r.coreCount, null);
  assert.strictEqual(r.memTotalBytes, null);
  assert.strictEqual(r.memUsedBytes, null);
  assert.strictEqual(r.memAvailableBytes, null);
  assert.strictEqual(r.memUsedPct, null);
  assert.strictEqual(r.appBytes, null);
  assert.strictEqual(r.kernelBytes, null);
  assert.strictEqual(r.swapTotalBytes, null);
  assert.strictEqual(r.swapUsedBytes, null);
  assert.strictEqual(r.processCount, null);
  assert.strictEqual(r.socTempC, null);

  // Called with no argument at all, and with a completely empty dump.
  assert.strictEqual(buildPerfReport().cpuOverallPct, null);
  assert.strictEqual(buildPerfReport({ perf: parsePerfDump('') }).memTotalBytes, null);
});

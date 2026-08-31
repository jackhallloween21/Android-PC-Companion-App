// Unit tests for the power/SoC parsers, run with `npm test` (node:test).
// Fixtures are shaped like real device output: Pixel-style µV/µA nodes, a
// Qualcomm-style mV/mA device, and a device where sysfs is entirely unreadable.

const test = require('node:test');
const assert = require('node:assert');
const {
  parsePowerDump,
  parseDumpsysBattery,
  buildPowerReport,
  parseCpuTopology,
  formatClusters,
  toVolts,
  toAmps,
  toCelsius,
  describeProtocol,
  POWER_SCRIPT,
  HEALTH_SOURCES,
  parseHealthDump,
  healthDumpUseful,
  explainMissing,
  toMah,
  reconcileDesignMah,
} = require('../src/power');

const PIXEL_SYSFS = `
PS|battery|capacity|87
PS|battery|status|Charging
PS|battery|health|Good
PS|battery|technology|Li-ion
PS|battery|voltage_now|4123000
PS|battery|current_now|3292000
PS|battery|charge_full|4720000
PS|battery|charge_full_design|5000000
PS|battery|charge_counter|4106400
PS|battery|cycle_count|342
PS|battery|temp|314
PS|usb|type|USB_PD
PS|usb|pd_active|2
PS|usb|input_voltage_settled|5000000
PS|usb|input_current_limit|3000000
TZ|battery|31400
TZ|soc_therm|41000
`.trim();

// Older Qualcomm kernels report mV / mA and expose usb_type with brackets.
const QCOM_SYSFS = `
PS|battery|capacity|54
PS|battery|status|Discharging
PS|battery|voltage_now|3821
PS|battery|current_now|-1450
PS|battery|charge_full|3900000
PS|battery|charge_full_design|4000000
PS|battery|temp|352
PS|usb|usb_type|Unknown SDP DCP [CDP] ACA C PD PD_DRP
TZ|bat_therm|35200
TZ|cpu0-silver-usr|46500
`.trim();

const DUMPSYS = `Current Battery Service state:
  AC powered: false
  USB powered: true
  status: 2
  health: 2
  present: true
  level: 87
  scale: 100
  voltage: 4123
  temperature: 314
  technology: Li-ion
`;

test('unit normalisation copes with µ and milli scales', () => {
  assert.strictEqual(toVolts('4123000'), 4.123);   // µV
  assert.strictEqual(toVolts('4123'), 4.123);      // mV
  assert.strictEqual(toVolts('0'), null);
  assert.strictEqual(toVolts('garbage'), null);

  assert.strictEqual(toAmps('3292000'), 3.292);    // µA
  assert.strictEqual(toAmps('-1450'), 1.45);       // mA, sign stripped

  assert.strictEqual(toCelsius('31400'), 31.4);    // millidegrees
  assert.strictEqual(toCelsius('314'), 31.4);      // decidegrees
  assert.strictEqual(toCelsius('31'), 31);         // degrees
});

test('sysfs sweep output parses into supplies and thermal zones', () => {
  const { supplies, zones } = parsePowerDump(PIXEL_SYSFS);
  assert.strictEqual(supplies.battery.capacity, '87');
  assert.strictEqual(supplies.usb.pd_active, '2');
  assert.deepStrictEqual(zones.map((z) => z.type), ['battery', 'soc_therm']);
});

test('charging device report matches the measured values', () => {
  const { supplies, zones } = parsePowerDump(PIXEL_SYSFS);
  const r = buildPowerReport({ dump: parseDumpsysBattery(DUMPSYS), supplies, zones });

  assert.strictEqual(r.sysfsAvailable, true);
  assert.strictEqual(r.source, '/sys/class/power_supply/battery/');
  assert.strictEqual(r.level, 87);
  assert.strictEqual(r.charging, true);
  assert.strictEqual(r.voltage, 4.123);
  assert.strictEqual(r.current, 3.292);
  // 4.123 V x 3.292 A
  assert.strictEqual(Number(r.watts.toFixed(2)), 13.57);
  assert.strictEqual(r.cycleCount, 342);
  assert.strictEqual(r.chargeFullMah, 4720);
  assert.strictEqual(r.chargeDesignMah, 5000);
  assert.strictEqual(r.healthPct, 94);
  assert.strictEqual(r.batteryTemp, 31.4);
  assert.strictEqual(r.socTemp, 41);
  assert.strictEqual(r.socZone, 'soc_therm');
  assert.strictEqual(r.protocol, 'USB-PD PPS');
  assert.strictEqual(r.inputVoltage, 5);
  assert.strictEqual(r.inputCurrentLimit, 3);
  // 13% of 4720 mAh left to fill at 3.292 A -> ~11 min
  assert.strictEqual(r.minutesRemaining, 11);
});

test('discharging device reports positive current and time-to-empty', () => {
  const { supplies, zones } = parsePowerDump(QCOM_SYSFS);
  const r = buildPowerReport({ dump: {}, supplies, zones });

  assert.strictEqual(r.charging, false);
  assert.strictEqual(r.voltage, 3.821);
  assert.strictEqual(r.current, 1.45, 'sign convention is normalised away');
  assert.strictEqual(r.batteryTemp, 35.2);
  assert.strictEqual(r.socZone, 'cpu0-silver-usr');
  assert.strictEqual(r.protocol, 'CDP', 'bracketed usb_type marks the active mode');
  assert.ok(r.minutesRemaining > 0 && r.minutesRemaining < 2880);
});

test('falls back to dumpsys when sysfs is unreadable', () => {
  const r = buildPowerReport({ dump: parseDumpsysBattery(DUMPSYS), supplies: {}, zones: [] });
  assert.strictEqual(r.sysfsAvailable, false);
  assert.strictEqual(r.source, 'dumpsys battery');
  assert.strictEqual(r.level, 87);
  assert.strictEqual(r.charging, true, 'numeric status 2 means charging');
  assert.strictEqual(r.voltage, 4.123);
  assert.strictEqual(r.batteryTemp, 31.4);
  assert.strictEqual(r.current, null, 'no current node, so no wattage');
  assert.strictEqual(r.watts, null);
});

test('missing everything degrades to nulls instead of throwing', () => {
  const r = buildPowerReport({});
  assert.strictEqual(r.level, null);
  assert.strictEqual(r.charging, false);
  assert.strictEqual(r.watts, null);
  assert.strictEqual(r.minutesRemaining, null);
});

test('charge state is read from status strings without false positives', () => {
  const state = (status) => buildPowerReport({ supplies: { battery: { status } } }).charging;
  assert.strictEqual(state('Charging'), true);
  assert.strictEqual(state('Full'), true);
  assert.strictEqual(state('Fast charging'), true);
  // Both of these contain the substring "charging".
  assert.strictEqual(state('Discharging'), false);
  assert.strictEqual(state('Not charging'), false);
});

test('protocol falls back to charge_type when the charger is silent', () => {
  const p = describeProtocol({}, { charge_type: 'Fast' });
  assert.strictEqual(p.label, 'Fast');
});

const TENSOR_CPUINFO = `
processor	: 0
CPU part	: 0xd05
processor	: 1
CPU part	: 0xd05
processor	: 2
CPU part	: 0xd05
processor	: 3
CPU part	: 0xd05
processor	: 4
CPU part	: 0xd41
processor	: 5
CPU part	: 0xd41
processor	: 6
CPU part	: 0xd44
processor	: 7
CPU part	: 0xd44
`;

const TENSOR_FREQS = [0, 1, 2, 3].map((i) => `/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq:1803000`)
  .concat([4, 5].map((i) => `/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq:2350000`))
  .concat([6, 7].map((i) => `/sys/devices/system/cpu/cpu${i}/cpufreq/cpuinfo_max_freq:2850000`))
  .join('\n');

test('CPU clusters are reconstructed from part IDs and clocks', () => {
  const t = parseCpuTopology(TENSOR_CPUINFO, TENSOR_FREQS);
  assert.strictEqual(t.coreCount, 8);
  assert.strictEqual(t.maxGhz, 2.85);
  assert.deepStrictEqual(t.clusters, [
    { name: 'Cortex-A55', ghz: 1.8, count: 4 },
    { name: 'Cortex-A78', ghz: 2.35, count: 2 },
    { name: 'Cortex-X1', ghz: 2.85, count: 2 },
  ]);
  assert.strictEqual(
    formatClusters(t.clusters),
    '4x 1.80 GHz Cortex-A55 + 2x 2.35 GHz Cortex-A78 + 2x 2.85 GHz Cortex-X1'
  );
});

test('unknown CPU part IDs pass through instead of being dropped', () => {
  const t = parseCpuTopology('CPU part\t: 0xfff\n', '');
  assert.strictEqual(t.coreCount, 1);
  assert.strictEqual(t.clusters[0].name, '0xfff');
  assert.strictEqual(t.clusters[0].ghz, null);
  assert.strictEqual(formatClusters(t.clusters), '1x 0xfff');
});

// ---------------------------------------------------------------------------
// Health HAL fallback.
//
// On the MediaTek device that prompted this, /sys/class/power_supply is not
// readable by the shell user, so current, capacity and cycle count all went
// blank at once. The health HAL runs privileged and prints the same numbers in
// its debug dump, which the shell user *is* allowed to request.
// ---------------------------------------------------------------------------

// healthd's BatteryMonitor::dumpState packs several pairs onto one line.
const HAL_DUMP = `
ac: 0 usb: 1 wireless: 0 current_max: 3000000 voltage_max: 5000000
status: 2 health: 2 present: 1
level: 68 voltage: 4062 temp: 380
current: 1850000 charge: 3400000 current_avg: 1810000 charge_full: 4850000 cycle_count: 118
technology: Li-ion
`;

// The AIDL dump uses camelCase field names and repeats a summary block.
const HAL_AIDL = `
  batteryLevel: 68
  batteryVoltageMillivolts: 4062
  batteryCurrentNow: 1850000
  batteryChargeCounter: 3400000
  batteryFullCharge: 4850000
  batteryCycleCount: 118
  batteryCurrentNow: 999
`;

test('a health HAL dump yields the values sysfs was withholding', () => {
  const parsed = parseHealthDump(HAL_DUMP);
  assert.strictEqual(parsed.current_now, '1850000');
  assert.strictEqual(parsed.charge_full, '4850000');
  assert.strictEqual(parsed.cycle_count, '118');
  assert.strictEqual(parsed.charge_counter, '3400000');
  assert.strictEqual(healthDumpUseful(parsed), true);
});

test('camelCase AIDL field names map onto the same sysfs node names', () => {
  const parsed = parseHealthDump(HAL_AIDL);
  assert.strictEqual(parsed.current_now, '1850000', 'first value wins; the repeat is a summary');
  assert.strictEqual(parsed.charge_full, '4850000');
  assert.strictEqual(parsed.cycle_count, '118');
});

test('a missing service is not mistaken for a reading', () => {
  // dumpsys prints this to stdout and still exits 0, so an absent service would
  // otherwise look like a successful but empty read.
  assert.deepStrictEqual(parseHealthDump("Can't find service: android.hardware.health.IHealth/default"), {});
  assert.deepStrictEqual(parseHealthDump(''), {});
  assert.deepStrictEqual(parseHealthDump(null), {});
  assert.strictEqual(healthDumpUseful({}), false);
  assert.strictEqual(healthDumpUseful({ capacity: '68' }), false, 'level alone adds nothing');
});

test('the HAL fills gaps but never overrides a live kernel node', () => {
  const { supplies } = parsePowerDump('PS|battery|capacity|68\nPS|battery|current_now|1200000');
  const report = buildPowerReport({
    supplies,
    health: parseHealthDump(HAL_DUMP),
    healthSource: 'health HAL 2.1',
  });
  // sysfs said 1.2 A and the HAL said 1.85 A; sysfs is live, the HAL is cached.
  assert.strictEqual(report.currentMa, 1200);
  // …but cycle count and charge_full existed only in the HAL.
  assert.strictEqual(report.cycleCount, 118);
  assert.strictEqual(report.chargeFullMah, 4850);
  assert.strictEqual(report.healthHal, 'health HAL 2.1');
});

test('the HAL alone is enough when sysfs is entirely unreadable', () => {
  const report = buildPowerReport({
    dump: parseDumpsysBattery('  level: 68\n  status: 2\n  temperature: 380\n  voltage: 4062'),
    supplies: {},
    zones: [],
    health: parseHealthDump(HAL_DUMP),
    healthSource: 'health AIDL HAL',
  });
  assert.strictEqual(report.sysfsAvailable, false);
  assert.strictEqual(report.currentMa, 1850);
  assert.strictEqual(report.cycleCount, 118);
  assert.strictEqual(report.chargeFullMah, 4850);
  assert.ok(report.watts > 7 && report.watts < 8, `expected ~7.5 W, got ${report.watts}`);
  assert.strictEqual(report.source, 'health AIDL HAL');
});

test('full capacity is estimated from the charge counter, and marked as an estimate', () => {
  // charge_counter at a known level implies the full capacity it was scaled from.
  const report = buildPowerReport({
    dump: parseDumpsysBattery('  level: 50\n  status: 2'),
    health: { charge_counter: '2500000', charge_full_design: '5000000' },
  });
  assert.strictEqual(report.chargeFullMah, null, 'never presented as a measurement');
  assert.strictEqual(report.estimatedFullMah, 5000);
  assert.strictEqual(report.estimatedHealthPct, 100);
  assert.strictEqual(report.healthPct, null);
});

test('a near-empty battery is not used to estimate capacity', () => {
  // At 3% the level's own rounding error swamps the result.
  const report = buildPowerReport({
    dump: parseDumpsysBattery('  level: 3'),
    health: { charge_counter: '150000' },
  });
  assert.strictEqual(report.estimatedFullMah, null);
});

test('the negotiated charging ceiling is kept apart from the measured draw', () => {
  const report = buildPowerReport({
    dump: parseDumpsysBattery(
      '  Max charging current: 3000000\n  Max charging voltage: 5000000\n  level: 68\n  status: 2'
    ),
  });
  assert.strictEqual(report.maxChargeAmps, 3);
  assert.strictEqual(report.maxChargeVolts, 5);
  assert.strictEqual(report.maxChargeWatts, 15);
  assert.strictEqual(report.current, null, 'a ceiling is not a measurement');
  assert.strictEqual(report.watts, null);
});

test('a missing value is explained by which source is absent, not blamed on sysfs', () => {
  const noSources = buildPowerReport({ dump: parseDumpsysBattery('  level: 68') });
  assert.match(explainMissing(noSources, 'current'), /not readable by the adb shell user/);

  // Everything is being read fine — the gauge just does not count cycles.
  const working = buildPowerReport({
    supplies: parsePowerDump('PS|battery|capacity|68\nPS|battery|current_now|1200000').supplies,
  });
  assert.strictEqual(working.cycleCount, null);
  assert.match(explainMissing(working, 'cycleCount'), /does not publish a cycle count/);
  assert.strictEqual(explainMissing(working, 'current'), null, 'present values get no excuse');
});

test('MediaTek and Exynos thermal zone names are recognised as the SoC', () => {
  const mtk = parsePowerDump('TZ|mtktsbattery|38000\nTZ|mtktscpu|42600');
  const report = buildPowerReport({ zones: mtk.zones, dump: parseDumpsysBattery('  level: 68') });
  assert.strictEqual(report.socTemp, 42.6);
  assert.strictEqual(report.socZone, 'mtktscpu');
  // The battery zone must not be offered as the SoC just because it matched first.
  assert.strictEqual(report.batteryTemp, 38);
});

test('the sweep script cannot fail on an unreadable last thermal zone', () => {
  // Without the trailing `exit 0` the script inherits the exit status of
  // `[ -r … ] && echo …`, so one unreadable zone made adb return 1 and threw the
  // entire sweep away — which is how a device with working power nodes ended up
  // reporting that none of them could be read.
  assert.match(POWER_SCRIPT, /exit 0$/);
  assert.ok(HEALTH_SOURCES.length >= 3);
  assert.ok(HEALTH_SOURCES.every((s) => s.id && s.label && s.command));
});

// ---------------------------------------------------------------------------
// Capacity units.
//
// A real device displayed "5000 / 500 mAh" and a health of 1000% because
// charge_full was published in µAh and charge_full_design was not. A single
// magnitude threshold cannot catch that, since 500 mAh is a perfectly plausible
// capacity in isolation — only comparing the two nodes reveals it.
// ---------------------------------------------------------------------------

test('charge nodes are read in whichever unit lands on a real capacity', () => {
  assert.strictEqual(toMah('5000000'), 5000, 'µAh');
  assert.strictEqual(toMah('5000'), 5000, 'mAh');
  assert.strictEqual(toMah('50000'), 5000, 'tenths of a mAh');
  assert.strictEqual(toMah('0'), null);
  assert.strictEqual(toMah('7'), null, 'no scale makes 7 a battery');
  assert.strictEqual(toMah(null), null);
});

test('a design capacity in the wrong unit is rescaled, not believed', () => {
  // The reported bug: 5000 mAh full charge against a 500 mAh design.
  assert.strictEqual(reconcileDesignMah(5000, 500), 5000);
  assert.strictEqual(reconcileDesignMah(4720, 5000), 5000, 'a genuinely worn cell is untouched');
  // 8% wear on a 5000 mAh design, expressed 1000x out.
  assert.strictEqual(reconcileDesignMah(4600, 5000000), 5000);
  // Nothing a power of ten can do makes 2000 the design of a 5000 mAh full
  // charge, so it is dropped rather than shown as 250% health.
  assert.strictEqual(reconcileDesignMah(5000, 2000), null);
  assert.strictEqual(reconcileDesignMah(null, 5000), 5000, 'nothing to compare against');
});

test('battery health cannot exceed what wear allows', () => {
  const report = buildPowerReport({
    supplies: {
      battery: { capacity: '87', charge_full: '5000000', charge_full_design: '500000' },
    },
  });
  assert.strictEqual(report.chargeFullMah, 5000);
  assert.strictEqual(report.chargeDesignMah, 5000, 'rescaled from the mismatched node');
  assert.strictEqual(report.healthPct, 100, 'was 1000% before the units were reconciled');
});

test('an irreconcilable design capacity is dropped rather than shown', () => {
  const report = buildPowerReport({
    supplies: { battery: { capacity: '87', charge_full: '5000000', charge_full_design: '2000' } },
  });
  assert.strictEqual(report.chargeFullMah, 5000);
  assert.strictEqual(report.chargeDesignMah, null);
  assert.strictEqual(report.healthPct, null, 'no number is better than 250%');
});

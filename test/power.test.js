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

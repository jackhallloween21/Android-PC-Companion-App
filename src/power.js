// ---------------------------------------------------------------------------
// Pure parsing/normalisation for battery, power and SoC telemetry.
//
// `dumpsys battery` only exposes a coarse subset (level/status/health/temp) and
// frequently omits current entirely. The kernel power-supply class is the real
// source: /sys/class/power_supply/<supply>/*. Vendors disagree on which supply
// exists, which nodes are readable, and which units they use (µV vs mV, µA vs
// mA), so we sweep every supply, keep whatever is readable, and normalise by
// magnitude.
//
// Everything here is deliberately free of Electron/child_process so it can be
// unit-tested against captured device output.
// ---------------------------------------------------------------------------

const POWER_NODES = [
  'capacity', 'capacity_level', 'status', 'health', 'technology', 'present',
  'voltage_now', 'voltage_ocv', 'voltage_max', 'voltage_max_design',
  'current_now', 'current_max', 'power_now',
  'charge_now', 'charge_full', 'charge_full_design', 'charge_counter', 'charge_type',
  'energy_full_design', 'cycle_count', 'temp', 'batt_temp',
  'input_current_limit', 'input_voltage_settled', 'constant_charge_current_max',
  'type', 'real_type', 'usb_type', 'pd_active', 'typec_mode', 'typec_power_role',
];

// One adb round-trip: sweeping ~30 nodes with individual `adb shell cat` calls
// took several seconds per refresh. Kept on a single line because `adb shell`
// splices its arguments together and hands the result to the device shell.
//
// The trailing `exit 0` is load-bearing, and its absence was a real bug. A shell
// script exits with the status of its last command, and the last command here is
// `[ -r "$z/temp" ] && echo …` inside a loop — so if the final thermal zone
// happens not to expose a readable temp, the script exits 1, `adb shell` returns
// 1, execFile treats that as a failure, and the *entire* sweep is discarded.
// Every electrical reading and every thermal zone then vanishes at once and the
// UI blames an unreadable sysfs, even where most of the nodes read perfectly.
const POWER_SCRIPT = [
  'for d in /sys/class/power_supply/*; do',
  'for n in ' + POWER_NODES.join(' ') + '; do',
  'if [ -r "$d/$n" ]; then',
  'v=$(cat "$d/$n" 2>/dev/null | head -n 1);',
  '[ -n "$v" ] && echo "PS|${d##*/}|$n|$v";',
  'fi; done; done;',
  'for z in /sys/class/thermal/thermal_zone*; do',
  '[ -r "$z/temp" ] && echo "TZ|$(cat $z/type 2>/dev/null)|$(cat $z/temp 2>/dev/null)";',
  'done;',
  'exit 0',
].join(' ');

// ---------------------------------------------------------------------------
// The health HAL, a second non-root source for the three values sysfs most
// often withholds: instantaneous current, full-charge capacity and cycle count.
//
// On plenty of devices — MediaTek builds especially — /sys/class/power_supply is
// labelled so that the `shell` user cannot read it. `[ -r ]` still succeeds
// (that only tests the permission bits, not SELinux), so the sweep above quietly
// yields nothing and every electrical reading disappears at once.
//
// The health HAL is the way around it: it runs with the privileges to read those
// nodes and prints them in its own debug dump, which `shell` *is* allowed to ask
// for. Same numbers, different door. Names and output shapes differ across
// versions, so each candidate is tried in turn and the text is parsed by
// scanning for known keys rather than by assuming a layout.
//
// `grep` narrows the dump to lines that could carry a value, which also filters
// out "Can't find service: …" — dumpsys prints that to stdout and exits 0, so an
// absent service otherwise looks like a successful read.
// ---------------------------------------------------------------------------

const HEALTH_GREP = 'grep -i -e current -e charge -e cycle -e capacity -e level -e voltage -e temp -e status -e health';

const HEALTH_SOURCES = [
  { id: 'aidl', label: 'health AIDL HAL', command: `dumpsys android.hardware.health.IHealth/default 2>/dev/null | ${HEALTH_GREP}` },
  { id: 'hidl-2.1', label: 'health HAL 2.1', command: `lshal debug android.hardware.health@2.1::IHealth/default 2>/dev/null | ${HEALTH_GREP}` },
  { id: 'hidl-2.0', label: 'health HAL 2.0', command: `lshal debug android.hardware.health@2.0::IHealth/default 2>/dev/null | ${HEALTH_GREP}` },
  { id: 'batteryproperties', label: 'batteryproperties service', command: `dumpsys batteryproperties 2>/dev/null | ${HEALTH_GREP}` },
];

// Every spelling of each field seen across healthd's dumpState, the HIDL
// HealthInfo dump and the AIDL one. Mapped onto the sysfs node names the rest of
// this file already speaks, so a HAL reading can stand in for a sysfs reading
// without any special-casing downstream.
const HEALTH_KEYS = {
  current: 'current_now',
  current_now: 'current_now',
  batterycurrentnow: 'current_now',
  current_avg: 'current_avg',
  current_average: 'current_avg',
  batterycurrentaverage: 'current_avg',
  charge: 'charge_counter',
  charge_counter: 'charge_counter',
  batterychargecounter: 'charge_counter',
  charge_full: 'charge_full',
  full_charge: 'charge_full',
  batteryfullcharge: 'charge_full',
  charge_full_design: 'charge_full_design',
  cycle_count: 'cycle_count',
  batterycyclecount: 'cycle_count',
  cycles: 'cycle_count',
  capacity: 'capacity',
  level: 'capacity',
  batterylevel: 'capacity',
  voltage: 'voltage_now',
  voltage_now: 'voltage_now',
  batteryvoltage: 'voltage_now',
  current_max: 'current_max',
  voltage_max: 'voltage_max',
  temp: 'temp',
  temperature: 'temp',
  batterytemperature: 'temp',
};

/**
 * Pulls whatever numeric fields a health HAL dump happens to contain.
 *
 * The dumps are flat runs of `key: value` and `key=value` pairs, several to a
 * line ("current: -406000 charge: 2853000 cycle_count: 42"), and which keys
 * appear depends on the HAL version and on what the kernel gave it. So rather
 * than matching a layout, every pair in the text is scanned and the recognised
 * ones are kept. A key seen twice keeps the first value, because the AIDL dump
 * repeats a summary block after the detail one.
 */
function parseHealthDump(raw) {
  const text = String(raw || '');
  if (/can'?t find service|does not exist|unknown service/i.test(text) && !/current/i.test(text)) return {};
  const found = {};
  const pair = /([A-Za-z][A-Za-z0-9_]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = pair.exec(text)) !== null) {
    const node = HEALTH_KEYS[m[1].toLowerCase()];
    if (!node) continue;
    if (found[node] === undefined) found[node] = m[2];
  }
  return found;
}

/** True when a HAL dump carried at least one value sysfs was not giving us. */
function healthDumpUseful(parsed) {
  return !!parsed && ['current_now', 'charge_full', 'cycle_count', 'charge_counter']
    .some((k) => parsed[k] !== undefined);
}

const num = (v) => {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Volts. Kernels report µV (4123000) or mV (4123) depending on the driver. */
function toVolts(v) {
  const n = num(v);
  if (n === null || n === 0) return null;
  const a = Math.abs(n);
  if (a > 100000) return n / 1e6;   // µV
  if (a > 100) return n / 1e3;      // mV
  return n;                          // already V
}

/**
 * Amps, always positive — the sign convention for charge vs discharge is
 * inverted between vendors, so direction is taken from `status` instead.
 */
function toAmps(v) {
  const n = num(v);
  if (n === null || n === 0) return null;
  const a = Math.abs(n);
  return a > 20000 ? a / 1e6 : a / 1e3; // µA : mA
}

// The range a real phone or tablet cell can occupy. Anything outside it is not a
// capacity, it is a unit we guessed wrong.
const MAH_MIN = 300;
const MAH_MAX = 30000;

/**
 * Milliamp-hours from a charge node.
 *
 * Vendors publish these in µAh (5000000), in mAh (5000) and occasionally in
 * tenths of a mAh (50000) — and a single kernel can mix units *between* nodes,
 * which is how a 5000 mAh cell ended up displayed as "5000 / 500 mAh" with a
 * health of 1000%: charge_full was in µAh and charge_full_design was not.
 *
 * So rather than one magnitude threshold, each power-of-ten scale is tried and
 * the first that lands inside the range a real cell can occupy wins. A value
 * that fits no scale returns null instead of a plausible-looking wrong number.
 */
function toMah(v) {
  const n = num(v);
  if (n === null || n === 0) return null;
  const a = Math.abs(n);
  // Scales are tried most-likely first: as published (mAh), µAh, tenths of a mAh,
  // hundredths, then a node that undercounts by ten.
  for (const scale of [1, 1e-3, 1e-1, 1e-2, 10]) {
    const mah = Math.round(a * scale);
    if (mah >= MAH_MIN && mah <= MAH_MAX) return mah;
  }
  return null;
}

/**
 * Rescales `designMah` when it is plainly not in the same unit as `fullMah`.
 *
 * A cell's full charge is between about half and just over its design capacity —
 * that is what wear means. A ratio of 10 or 1000 is not a worn-out battery, it is
 * two nodes published in different units, and believing it produces the "health
 * 1000%" the user saw. Only exact powers of ten are tried, since that is the only
 * way the two can legitimately differ; if none reconciles them, the design
 * capacity is dropped rather than shown against a full charge it cannot be
 * compared with.
 */
const HEALTH_RATIO_MIN = 0.5;
const HEALTH_RATIO_MAX = 1.15;

function reconcileDesignMah(fullMah, designMah) {
  if (!fullMah || !designMah) return designMah ?? null;
  const plausible = (d) => {
    const ratio = fullMah / d;
    return d >= MAH_MIN && d <= MAH_MAX && ratio >= HEALTH_RATIO_MIN && ratio <= HEALTH_RATIO_MAX;
  };
  if (plausible(designMah)) return designMah;
  for (const scale of [10, 100, 1000, 0.1, 0.01, 0.001]) {
    const scaled = Math.round(designMah * scale);
    if (plausible(scaled)) return scaled;
  }
  return null;
}

/** Celsius from millidegrees (31500), decidegrees (315) or degrees (31). */
function toCelsius(v) {
  const n = num(v);
  if (n === null) return null;
  const a = Math.abs(n);
  if (a > 10000) return n / 1000;
  if (a > 200) return n / 10;
  return n;
}

function parsePowerDump(raw) {
  const supplies = {};
  const zones = [];
  (raw || '').split('\n').forEach((line) => {
    const parts = line.trim().split('|');
    if (parts[0] === 'PS' && parts.length >= 4) {
      const [, supply, node, ...rest] = parts;
      supplies[supply] = supplies[supply] || {};
      supplies[supply][node] = rest.join('|').trim();
    } else if (parts[0] === 'TZ' && parts.length >= 3) {
      const temp = Number(parts[2]);
      if (Number.isFinite(temp)) zones.push({ type: (parts[1] || '').trim(), raw: temp });
    }
  });
  return { supplies, zones };
}

/** Parses the `key: value` block emitted by `dumpsys battery`. */
function parseDumpsysBattery(raw) {
  const info = {};
  (raw || '').split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    if (key) info[key] = line.slice(idx + 1).trim();
  });
  return info;
}

const BATTERY_SUPPLY_ORDER = ['battery', 'bms', 'main', 'battery_ext'];
const CHARGER_SUPPLY_HINTS = ['usb', 'pc_port', 'ac', 'dc', 'wireless', 'main_chg', 'usbpd'];

function pickBatterySupply(supplies) {
  for (const name of BATTERY_SUPPLY_ORDER) if (supplies[name]) return { name, data: supplies[name] };
  // Fall back to whichever supply reports a battery-ish payload.
  const entry = Object.entries(supplies).find(([, d]) => d.capacity !== undefined || d.charge_full !== undefined);
  return entry ? { name: entry[0], data: entry[1] } : { name: null, data: {} };
}

function mergeChargerNodes(supplies, batteryName) {
  const merged = {};
  for (const [name, data] of Object.entries(supplies)) {
    if (name === batteryName) continue;
    if (!CHARGER_SUPPLY_HINTS.some((h) => name.includes(h))) continue;
    for (const [k, v] of Object.entries(data)) if (merged[k] === undefined) merged[k] = v;
  }
  return merged;
}

// Zone naming is entirely vendor-specific. Qualcomm uses soc/aoss/tsens/apc,
// MediaTek uses mtktscpu / mtktsAP / soc_max, Exynos uses "BIG"/"LITTLE"/G3D.
// Ordered most-specific first, since the first match wins.
const SOC_ZONE_PATTERNS = [
  /soc/i, /aoss/i, /tsens/i, /apc/i, /mtkts_?cpu/i, /mtkts_?ap\b/i, /^cpu/i,
  /cpu[_-]?therm/i, /big/i, /silver/i, /little/i, /^g3d/i, /gpu/i, /mtkts/i,
];
const BATT_ZONE_PATTERNS = [/batt/i, /bat_?therm/i];

function pickZone(zones, patterns, exclude = null) {
  const eligible = exclude ? zones.filter((z) => !exclude.some((re) => re.test(z.type))) : zones;
  for (const re of patterns) {
    const hit = eligible.find((z) => re.test(z.type));
    if (hit) return hit;
  }
  return null;
}

function describeProtocol(charger, batteryData) {
  const type = (charger.real_type || charger.usb_type || charger.type || '').trim();
  const pd = charger.pd_active;
  const typec = (charger.typec_mode || '').trim();

  // usb_type renders the active mode in brackets: "Unknown SDP DCP CDP [PD] ..."
  const bracketed = type.match(/\[([^\]]+)\]/);
  const active = (bracketed ? bracketed[1] : type).replace(/^USB_?/i, '').trim();

  let label = active || null;
  if (pd && pd !== '0') label = pd === '2' ? 'USB-PD PPS' : 'USB-PD';
  if (!label && batteryData.charge_type) label = batteryData.charge_type;
  return { label: label || null, typecMode: typec || null };
}

/**
 * Combines the dumpsys map, the sysfs sweep, the health-HAL dump and the thermal
 * zones into the flat shape the renderer consumes.
 *
 * `health` is treated as another supply: its values are merged *under* the sysfs
 * battery node, so a readable kernel node always wins and the HAL only fills
 * gaps. That ordering matters because the HAL caches its snapshot for a second
 * or two, while sysfs is live.
 */
function buildPowerReport({ dump = {}, supplies = {}, zones = [], health = {}, healthSource = null }) {
  const { name: battName, data: sysfsBatt } = pickBatterySupply(supplies);
  const batt = { ...health, ...sysfsBatt };
  const charger = mergeChargerNodes(supplies, battName);

  const statusRaw = (batt.status || dump.status || '').trim();
  // Careful: "Discharging" and "Not charging" both contain "charging", so those
  // are excluded before the positive test. dumpsys reports BatteryManager
  // constants numerically; 2 = charging, 5 = full.
  const statusLower = statusRaw.toLowerCase();
  const charging = !/discharg|not charg/.test(statusLower)
    && (/charg|full/.test(statusLower) || statusRaw === '2' || statusRaw === '5');

  const volts = toVolts(batt.voltage_now) ?? toVolts(dump.voltage);
  const amps = toAmps(batt.current_now) ?? toAmps(dump['current now']);
  const powerNow = num(batt.power_now);
  const watts = powerNow ? Math.abs(powerNow) / 1e6 : (volts && amps ? volts * amps : null);

  const level = num(batt.capacity) ?? num(dump.level);
  const fullMah = toMah(batt.charge_full);
  const rawDesignMah = toMah(batt.charge_full_design) ?? toMah(batt.energy_full_design);
  const nowMah = toMah(batt.charge_now) ?? toMah(batt.charge_counter) ?? toMah(dump['Charge counter']);

  // Wear is (what it holds now / what it held new). With only one of the two we
  // can still say something useful, but it has to be flagged as an estimate:
  // charge_counter at a known level implies the full capacity it was scaled from.
  let estimatedFullMah = null;
  if (!fullMah && nowMah && level !== null && level >= 10) {
    estimatedFullMah = Math.round(nowMah / (level / 100));
  }
  // Reconciled against whichever full-charge figure we have, so a design node in
  // a different unit is corrected — or dropped — rather than yielding a health
  // percentage in the hundreds.
  const designMah = reconcileDesignMah(fullMah || estimatedFullMah, rawDesignMah);
  const healthPct = fullMah && designMah ? Math.round((fullMah / designMah) * 100) : null;
  const estimatedHealthPct = !healthPct && estimatedFullMah && designMah
    ? Math.round((estimatedFullMah / designMah) * 100)
    : null;

  // The number to divide the present charge by: what the cell actually holds
  // today when the gauge publishes it, and only failing that what it held new.
  // Design capacity is the last choice deliberately — dividing today's charge by
  // a worn battery's factory rating understates how full it is.
  const capacityMah = fullMah || estimatedFullMah || designMah;

  // How much charge is in the cell right now. Most gauges publish it outright.
  // Where charge_now, charge_counter and dumpsys' counter are all hidden, the
  // level is still a real reading of the same quantity — just quantised to a
  // whole percent — so it is scaled by the capacity and flagged as an estimate.
  // Note this can only fire when nowMah is absent, which is also the only case
  // where estimatedFullMah is null, so the two estimates never feed each other.
  const estimatedNowMah = !nowMah && capacityMah && level !== null
    ? Math.round(capacityMah * (level / 100))
    : null;

  // What the charger and phone negotiated, which dumpsys reports even where the
  // kernel nodes are locked down. It is a ceiling, not a measurement — the phone
  // may be drawing far less — so it is kept in its own fields and the UI must
  // never present it as the current draw.
  const maxChargeAmps = toAmps(dump['Max charging current']);
  const maxChargeVolts = toVolts(dump['Max charging voltage']);
  const maxChargeWatts = maxChargeAmps && maxChargeVolts ? maxChargeAmps * maxChargeVolts : null;

  const battZone = pickZone(zones, BATT_ZONE_PATTERNS);
  const socZone = pickZone(zones, SOC_ZONE_PATTERNS, BATT_ZONE_PATTERNS);
  const batteryTemp = toCelsius(batt.temp) ?? toCelsius(dump.temperature) ?? (battZone ? toCelsius(battZone.raw) : null);
  const socTemp = socZone ? toCelsius(socZone.raw) : null;

  // Minutes remaining, from the measured current and the charge gap.
  let minutesRemaining = null;
  if (amps && amps > 0.01 && level !== null && capacityMah) {
    const remainingMah = charging
      ? capacityMah * ((100 - level) / 100)
      : (nowMah ?? capacityMah * (level / 100));
    const mins = Math.round((remainingMah / (amps * 1000)) * 60);
    minutesRemaining = Number.isFinite(mins) && mins > 0 && mins < 60 * 48 ? mins : null;
  }

  const protocol = describeProtocol(charger, batt);

  // Which door each electrical value came in through. The old UI note said only
  // "kernel nodes are not readable", which is true but tells the user nothing
  // about why *this* field is blank — cycle count is missing on a great many
  // phones simply because the fuel gauge does not count cycles, and that is a
  // different problem from a locked-down sysfs.
  const sources = {
    sysfs: !!battName,
    health: healthDumpUseful(health) ? healthSource || 'health HAL' : null,
    dumpsys: Object.keys(dump).length > 0,
  };

  return {
    source: battName ? `/sys/class/power_supply/${battName}/` : (sources.health || 'dumpsys battery'),
    sysfsAvailable: !!battName,
    healthHal: sources.health,
    sources,
    level,
    charging,
    status: statusRaw || null,
    plugged: dump.plugged || charger.type || null,
    health: dump.health || batt.health || null,
    healthPct,
    estimatedHealthPct,
    technology: dump.technology || batt.technology || null,
    voltage: volts,
    voltageMv: volts ? Math.round(volts * 1000) : null,
    current: amps,
    currentMa: amps ? Math.round(amps * 1000) : null,
    watts,
    maxChargeAmps,
    maxChargeVolts,
    maxChargeWatts,
    cycleCount: num(batt.cycle_count) ?? num(dump['cycle count']),
    chargeFullMah: fullMah,
    estimatedFullMah,
    chargeDesignMah: designMah,
    chargeNowMah: nowMah,
    estimatedNowMah,
    capacityMah,
    batteryTemp,
    socTemp,
    socZone: socZone ? socZone.type : null,
    protocol: protocol.label,
    typecMode: protocol.typecMode,
    inputVoltage: toVolts(charger.input_voltage_settled),
    inputCurrentLimit: toAmps(charger.input_current_limit),
    minutesRemaining,
    thermalZones: zones.map((z) => ({ type: z.type, celsius: toCelsius(z.raw) })),
  };
}

/**
 * One sentence explaining why a reading is absent, or null when it is present.
 *
 * The distinction the previous note flattened: a value can be missing because
 * nothing we are allowed to talk to exposes it (sysfs locked *and* no HAL), or
 * because every source is working fine and this particular phone's fuel gauge
 * simply does not report that quantity. Only the first is worth suggesting a
 * remedy for.
 */
function explainMissing(report, field) {
  if (!report) return null;
  if (report[field] !== null && report[field] !== undefined) return null;
  const { sysfs, health } = report.sources || {};
  if (!sysfs && !health) {
    return 'Kernel power-supply nodes are not readable by the adb shell user on this '
      + 'device and no health HAL answered, so only the coarse "dumpsys battery" '
      + 'values are available.';
  }
  const via = sysfs ? 'the kernel power-supply nodes' : `the ${health}`;
  if (field === 'cycleCount') {
    return `This phone's fuel gauge does not publish a cycle count through ${via}. `
      + 'Most mid-range MediaTek and Exynos gauges never do, so battery wear cannot '
      + 'be derived from cycles here.';
  }
  if (field === 'chargeFullMah') {
    return `Full-charge capacity is not published through ${via}, so wear cannot be `
      + 'measured against the design capacity.';
  }
  if (field === 'chargeNowMah') {
    return `The present charge in mAh is not published through ${via}. It is estimated `
      + 'from the charge level instead, which the gauge rounds to a whole percent.';
  }
  if (field === 'current' || field === 'watts') {
    return `No instantaneous current is published through ${via}. The charging `
      + 'ceiling the phone negotiated is shown instead where dumpsys reports it.';
  }
  if (field === 'socTemp') {
    return 'No thermal zone on this device is named recognisably enough to be trusted '
      + 'as the SoC junction temperature.';
  }
  return `Not published through ${via} on this device.`;
}

// ---------------------------------------------------------------------------
// CPU topology
//
// ro.soc.model only exists from Android 12; before that all we have is the
// codename in ro.board.platform. Core clusters are reconstructed from the ARM
// part IDs in /proc/cpuinfo paired with each core's cpufreq ceiling.
// ---------------------------------------------------------------------------

const ARM_PARTS = {
  '0xd01': 'Cortex-A32', '0xd03': 'Cortex-A53', '0xd04': 'Cortex-A35',
  '0xd05': 'Cortex-A55', '0xd07': 'Cortex-A57', '0xd08': 'Cortex-A72',
  '0xd09': 'Cortex-A73', '0xd0a': 'Cortex-A75', '0xd0b': 'Cortex-A76',
  '0xd0d': 'Cortex-A77', '0xd41': 'Cortex-A78', '0xd42': 'Cortex-A78AE',
  '0xd44': 'Cortex-X1', '0xd46': 'Cortex-A510', '0xd47': 'Cortex-A710',
  '0xd48': 'Cortex-X2', '0xd4d': 'Cortex-A715', '0xd4e': 'Cortex-X3',
  '0xd80': 'Cortex-A520', '0xd81': 'Cortex-A720', '0xd82': 'Cortex-X4',
  '0xd85': 'Cortex-X925', '0xd87': 'Cortex-A725', '0xd88': 'Cortex-A520AE',
  '0x802': 'Kryo 280 Gold', '0x803': 'Kryo 280 Silver',
  '0x804': 'Kryo 385 Gold', '0x805': 'Kryo 385 Silver',
  '0x001': 'Kryo', '0x006': 'Kryo 4xx Gold', '0x007': 'Kryo 4xx Silver',
};

function parseCpuTopology(cpuinfo, freqLines) {
  // A "CPU part : 0xd44" line appears once per core, in cpu0..cpuN order.
  const parts = ((cpuinfo || '').match(/CPU part\s*:\s*(\S+)/g) || [])
    .map((l) => l.split(':')[1].trim().toLowerCase());

  // Lines look like ".../cpu0/cpufreq/cpuinfo_max_freq:2850000"
  const freqs = {};
  (freqLines || '').split('\n').forEach((line) => {
    const m = line.match(/cpu(\d+)\/cpufreq\/cpuinfo_max_freq[:\s]+(\d+)/);
    if (m) freqs[Number(m[1])] = Number(m[2]);
  });

  const cores = parts.map((part, i) => ({
    index: i,
    name: ARM_PARTS[part] || part,
    ghz: freqs[i] ? Number((freqs[i] / 1e6).toFixed(2)) : null,
  }));

  // Group consecutive identical (core model, clock) pairs into clusters.
  const clusters = [];
  cores.forEach((core) => {
    const last = clusters[clusters.length - 1];
    if (last && last.name === core.name && last.ghz === core.ghz) last.count += 1;
    else clusters.push({ name: core.name, ghz: core.ghz, count: 1 });
  });

  const maxGhz = cores.reduce((m, c) => (c.ghz && c.ghz > m ? c.ghz : m), 0);
  return { coreCount: cores.length || null, clusters, maxGhz: maxGhz || null };
}

function formatClusters(clusters) {
  if (!clusters || !clusters.length) return null;
  return clusters
    .map((c) => `${c.count}x ${c.ghz ? `${c.ghz.toFixed(2)} GHz ` : ''}${c.name}`)
    .join(' + ');
}

module.exports = {
  POWER_NODES,
  POWER_SCRIPT,
  HEALTH_SOURCES,
  parseHealthDump,
  healthDumpUseful,
  explainMissing,
  parsePowerDump,
  parseDumpsysBattery,
  buildPowerReport,
  parseCpuTopology,
  formatClusters,
  toVolts,
  toAmps,
  toMah,
  reconcileDesignMah,
  toCelsius,
  describeProtocol,
  pickBatterySupply,
};

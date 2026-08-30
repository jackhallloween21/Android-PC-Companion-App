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
const POWER_SCRIPT = [
  'for d in /sys/class/power_supply/*; do',
  'for n in ' + POWER_NODES.join(' ') + '; do',
  'if [ -r "$d/$n" ]; then',
  'v=$(cat "$d/$n" 2>/dev/null | head -n 1);',
  '[ -n "$v" ] && echo "PS|${d##*/}|$n|$v";',
  'fi; done; done;',
  'for z in /sys/class/thermal/thermal_zone*; do',
  '[ -r "$z/temp" ] && echo "TZ|$(cat $z/type 2>/dev/null)|$(cat $z/temp 2>/dev/null)";',
  'done',
].join(' ');

const num = (v) => {
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

/** Milliamp-hours from a µAh (typical) or mAh node. */
function toMah(v) {
  const n = num(v);
  if (n === null || n === 0) return null;
  const a = Math.abs(n);
  return a > 100000 ? Math.round(a / 1000) : Math.round(a);
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

const SOC_ZONE_PATTERNS = [/soc/i, /aoss/i, /tsens/i, /apc/i, /^cpu/i, /big/i, /silver/i, /gpu/i];
const BATT_ZONE_PATTERNS = [/batt/i, /bat_?therm/i];

function pickZone(zones, patterns) {
  for (const re of patterns) {
    const hit = zones.find((z) => re.test(z.type));
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
 * Combines the dumpsys map, the sysfs sweep and the thermal zones into the flat
 * shape the renderer consumes.
 */
function buildPowerReport({ dump = {}, supplies = {}, zones = [] }) {
  const { name: battName, data: batt } = pickBatterySupply(supplies);
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
  const designMah = toMah(batt.charge_full_design) ?? toMah(batt.energy_full_design);
  const nowMah = toMah(batt.charge_now) ?? toMah(batt.charge_counter);
  const healthPct = fullMah && designMah ? Math.round((fullMah / designMah) * 100) : null;

  const battZone = pickZone(zones, BATT_ZONE_PATTERNS);
  const socZone = pickZone(zones, SOC_ZONE_PATTERNS);
  const batteryTemp = toCelsius(batt.temp) ?? toCelsius(dump.temperature) ?? (battZone ? toCelsius(battZone.raw) : null);
  const socTemp = socZone ? toCelsius(socZone.raw) : null;

  // Minutes remaining, from the measured current and the charge gap.
  let minutesRemaining = null;
  const capacityMah = fullMah || designMah;
  if (amps && amps > 0.01 && level !== null && capacityMah) {
    const remainingMah = charging
      ? capacityMah * ((100 - level) / 100)
      : (nowMah ?? capacityMah * (level / 100));
    const mins = Math.round((remainingMah / (amps * 1000)) * 60);
    minutesRemaining = Number.isFinite(mins) && mins > 0 && mins < 60 * 48 ? mins : null;
  }

  const protocol = describeProtocol(charger, batt);

  return {
    source: battName ? `/sys/class/power_supply/${battName}/` : 'dumpsys battery',
    sysfsAvailable: !!battName,
    level,
    charging,
    status: statusRaw || null,
    plugged: dump.plugged || charger.type || null,
    health: dump.health || batt.health || null,
    healthPct,
    technology: dump.technology || batt.technology || null,
    voltage: volts,
    voltageMv: volts ? Math.round(volts * 1000) : null,
    current: amps,
    currentMa: amps ? Math.round(amps * 1000) : null,
    watts,
    cycleCount: num(batt.cycle_count) ?? num(dump['cycle count']),
    chargeFullMah: fullMah,
    chargeDesignMah: designMah,
    chargeNowMah: nowMah,
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
  parsePowerDump,
  parseDumpsysBattery,
  buildPowerReport,
  parseCpuTopology,
  formatClusters,
  toVolts,
  toAmps,
  toMah,
  toCelsius,
  describeProtocol,
  pickBatterySupply,
};

// ---------------------------------------------------------------------------
// Remembering wirelessly-paired devices, so a phone that has been paired once
// does not have to be paired again.
//
// The important thing to understand is that pairing and addressing are separate.
// `adb pair` writes a key the phone keeps until the user revokes it, so the
// pairing survives reboots of both ends indefinitely. What does *not* survive is
// the address: Android picks a fresh, random connect port every time wireless
// debugging is toggled, and DHCP can hand out a different IP. So a remembered
// entry is a hint, not an address — the last-known host:port is worth one quick
// attempt, but the authoritative answer comes from mDNS, which advertises the
// port the phone is listening on right now.
//
// The mDNS *instance name* (`adb-39041FDJH00BQZ-vWLnDS`) is the only stable
// identity available before connecting: it embeds the device's serial and does
// not change when the address does. Matching on it is what lets a phone be found
// again after its IP has changed.
//
// This module is pure: it decides what to try and in what order. main.js does
// the adb calls and the file I/O.
// ---------------------------------------------------------------------------

const { splitHostPort } = require('./wireless');

// A remembered device is dropped after this long without a successful connect.
// Long enough to cover a holiday, short enough that a phone sold or reset does
// not linger forever.
const STALE_MS = 90 * 24 * 60 * 60 * 1000;

// mDNS instance names look like `adb-<serial>-<random>`. The middle field is the
// device serial, which is what makes two advertisements comparable.
const INSTANCE = /^adb-([^-\s]+)-/;

/** The device serial embedded in an mDNS instance name, or null. */
function serialFromInstance(name) {
  const m = String(name || '').trim().match(INSTANCE);
  return m ? m[1] : null;
}

/**
 * Every advertised connect endpoint with its instance name kept, which
 * listConnectTargets in wireless.js discards. Rows look like:
 *   adb-39041FDJH00BQZ-vWLnDS  _adb-tls-connect._tcp.  192.168.1.23:37123
 */
function listAdvertised(mdnsOutput) {
  const out = [];
  for (const line of String(mdnsOutput || '').split('\n')) {
    if (!/_adb-tls-connect/.test(line)) continue;
    const m = line.match(/(\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d+)/i);
    if (!m) continue;
    const instance = line.trim().split(/\s+/)[0] || null;
    out.push({
      instance,
      deviceSerial: serialFromInstance(instance),
      target: `${m[1]}:${m[2]}`,
      host: m[1],
      port: m[2],
    });
  }
  return out;
}

/** True for a serial adb can genuinely `connect`/`disconnect`. */
function isWirelessSerial(serial) {
  const s = String(serial || '').trim();
  if (!s) return false;
  if (/^(\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?$/i.test(s)) return true;
  if (s.startsWith('adb-') || s.includes('._tcp') || s.includes('_adb-tls-connect')) return true;
  return false;
}

/**
 * Folds a successful wireless connection into the remembered list.
 *
 * Entries are keyed by device serial when one is known, because that is what
 * survives an address change; a device we only ever saw as host:port is keyed by
 * host so that at least the IP is remembered. Keying by the full host:port would
 * create a new entry every time the phone picked a new port.
 */
function rememberDevice(known, entry, now = Date.now()) {
  const list = Array.isArray(known) ? known.slice() : [];
  const { host, port } = splitHostPort(entry.target || '');
  if (!host) return list;

  const key = entry.deviceSerial || null;
  const idx = list.findIndex((k) => (key && k.deviceSerial === key) || (!key && !k.deviceSerial && k.host === host));

  const record = {
    ...(idx === -1 ? {} : list[idx]),
    deviceSerial: key || (idx === -1 ? null : list[idx].deviceSerial),
    host,
    port: port || (idx === -1 ? null : list[idx].port),
    label: entry.label || (idx === -1 ? null : list[idx].label) || null,
    lastSeen: now,
  };
  if (idx === -1) list.push(record); else list[idx] = record;
  return list;
}

function forgetKnownDevice(known, hostOrSerial) {
  const s = String(hostOrSerial || '').trim();
  const { host } = splitHostPort(s);
  return (Array.isArray(known) ? known : []).filter(
    (k) => k.deviceSerial !== s && k.host !== s && k.host !== host
  );
}

/** Drops entries that have not connected in a long time. */
function pruneKnown(known, now = Date.now()) {
  return (Array.isArray(known) ? known : []).filter(
    (k) => k && k.host && now - Number(k.lastSeen || 0) < STALE_MS
  );
}

/**
 * The connect attempts to make at startup, best first.
 *
 * Ordering is by how likely the attempt is to succeed *and* how cheap it is to
 * fail. An mDNS-advertised endpoint for a device we recognise is both: the phone
 * is provably listening on that port right now. A remembered host:port is worth
 * trying next — it usually still works and costs one round trip. An advertised
 * endpoint we do not recognise comes last and only when `includeNew` is set,
 * because auto-connecting to any phone that happens to advertise on the network
 * would attach the app to someone else's device.
 *
 * Serials already in `connected` are skipped, and each target is attempted once.
 */
function planReconnect({ known = [], mdns = '', connected = [], includeNew = false } = {}) {
  const list = Array.isArray(known) ? known : [];
  const advertised = listAdvertised(mdns);
  const attached = new Set((Array.isArray(connected) ? connected : []).map((s) => String(s).trim()));
  const knownSerials = new Set(list.map((k) => k.deviceSerial).filter(Boolean));
  const knownHosts = new Set(list.map((k) => k.host).filter(Boolean));

  const plan = [];
  const seen = new Set();
  const push = (target, reason, deviceSerial = null) => {
    if (!target || seen.has(target) || attached.has(target)) return;
    seen.add(target);
    plan.push({ target, reason, deviceSerial });
  };

  // 1. Recognised devices, at the address they are advertising now.
  for (const ad of advertised) {
    const recognised = (ad.deviceSerial && knownSerials.has(ad.deviceSerial)) || knownHosts.has(ad.host);
    if (recognised) push(ad.target, 'discovered', ad.deviceSerial);
  }
  // 2. Last-known addresses, most recently used first.
  for (const k of [...list].sort((a, b) => Number(b.lastSeen || 0) - Number(a.lastSeen || 0))) {
    if (k.host && k.port) push(`${k.host}:${k.port}`, 'remembered', k.deviceSerial || null);
  }
  // 3. Anything else advertising, only on request.
  if (includeNew) {
    for (const ad of advertised) push(ad.target, 'new', ad.deviceSerial);
  }
  return plan;
}

module.exports = {
  STALE_MS,
  serialFromInstance,
  listAdvertised,
  isWirelessSerial,
  rememberDevice,
  forgetKnownDevice,
  pruneKnown,
  planReconnect,
};

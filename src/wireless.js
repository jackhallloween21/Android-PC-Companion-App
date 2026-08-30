// ---------------------------------------------------------------------------
// Wireless debugging helpers (pure).
//
// Two different ports are involved and they are never the same one: the phone's
// "Pair device with pairing code" dialog shows an ephemeral *pairing* port,
// while the main Wireless debugging screen shows the persistent *connect* port.
// `adb pair` only exchanges keys — the device does not appear in `adb devices`
// until something calls `adb connect` on the connect port. That is why a phone
// can say "paired" while the app still lists no devices.
//
// Both commands also report failure on stdout and frequently still exit 0, so
// their output text has to be classified rather than trusted.
// ---------------------------------------------------------------------------

const PAIR_OK = /successfully paired/i;
const CONNECT_OK = /\b(connected to|already connected)\b/i;

/** Splits "192.168.1.23:41235" (or a bare host) into its parts. */
function splitHostPort(hostPort) {
  const s = String(hostPort || '').trim().replace(/^adb:\/\//, '');
  // IPv6 literals are bracketed: [fe80::1]:5555
  const v6 = s.match(/^(\[[^\]]+\]):(\d+)$/);
  if (v6) return { host: v6[1], port: v6[2] };
  const idx = s.lastIndexOf(':');
  if (idx === -1) return { host: s, port: null };
  return { host: s.slice(0, idx), port: s.slice(idx + 1) || null };
}

function isPaired(output) {
  return PAIR_OK.test(String(output || ''));
}

function isConnected(output) {
  return CONNECT_OK.test(String(output || ''));
}

/**
 * Pulls the connect target out of `adb mdns services`, whose rows look like
 *   adb-39041FDJH00BQZ-vWLnDS  _adb-tls-connect._tcp.  192.168.1.23:37123
 * Only the _adb-tls-connect service is usable; _adb-tls-pairing is the
 * short-lived pairing endpoint and connecting to it fails.
 */
function pickConnectTarget(mdnsOutput, host = null) {
  for (const line of String(mdnsOutput || '').split('\n')) {
    if (!/_adb-tls-connect/.test(line)) continue;
    const m = line.match(/(\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d+)/i);
    if (m && (!host || m[1] === host)) return `${m[1]}:${m[2]}`;
  }
  return null;
}

/**
 * Orders the connect targets to try: the port the user supplied first, then
 * whatever mDNS advertises for that host.
 */
function connectCandidates(host, connectPort, mdnsOutput) {
  const targets = [];
  const explicit = String(connectPort ?? '').trim();
  if (explicit) targets.push(`${host}:${explicit}`);
  const discovered = pickConnectTarget(mdnsOutput, host);
  if (discovered && !targets.includes(discovered)) targets.push(discovered);
  return targets;
}

module.exports = {
  splitHostPort,
  isPaired,
  isConnected,
  pickConnectTarget,
  connectCandidates,
};

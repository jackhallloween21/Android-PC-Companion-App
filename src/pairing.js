// ---------------------------------------------------------------------------
// QR pairing for Android wireless debugging (pure logic).
//
// The direction matters and it is the opposite of a webcam scanner: **the PC
// displays the QR code and the phone scans it**. Android's "Pair device with
// QR code" screen opens the phone's camera; it never shows a code of its own.
//
// The flow adb and Android Studio implement:
//   1. The host invents a service name and a password and renders
//        WIFI:T:ADB;S:<name>;P:<password>;;
//   2. The phone scans it and, if it accepts, starts advertising a *pairing*
//      endpoint over mDNS as `_adb-tls-pairing._tcp` whose instance name is the
//      service name from step 1.
//   3. The host finds that endpoint in `adb mdns services` and runs
//        adb pair <ip>:<port> <password>
//   4. Pairing only exchanges keys, so the host still has to `adb connect` on
//      the separate `_adb-tls-connect` port (see src/wireless.js).
//
// The password is the pairing code: it is never typed by the user here, it only
// has to match between the QR payload and the `adb pair` argument.
// ---------------------------------------------------------------------------

const PAIRING_SERVICE = '_adb-tls-pairing';

// Name prefix is cosmetic — it shows up in the phone's pairing toast — but it
// must not contain the `;` that separates QR fields.
const NAME_PREFIX = 'companion';
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Builds the payload string the phone's camera expects. */
function buildPairingPayload(name, password) {
  const safe = (v, field) => {
    const s = String(v == null ? '' : v);
    if (!s) throw new Error(`Pairing ${field} must not be empty`);
    if (/[;]/.test(s)) throw new Error(`Pairing ${field} must not contain ";"`);
    return s;
  };
  return `WIFI:T:ADB;S:${safe(name, 'name')};P:${safe(password, 'password')};;`;
}

/**
 * A fresh pairing session. `randomBytes` is injected so tests are deterministic.
 */
function newPairingSession(randomBytes, { passwordLength = 10 } = {}) {
  const nameBytes = randomBytes(3);
  const name = `${NAME_PREFIX}-${Buffer.from(nameBytes).toString('hex')}`;

  const pwBytes = randomBytes(passwordLength);
  let password = '';
  for (let i = 0; i < passwordLength; i++) {
    password += PASSWORD_ALPHABET[pwBytes[i] % PASSWORD_ALPHABET.length];
  }

  return { name, password, payload: buildPairingPayload(name, password) };
}

const ADDRESS = /(\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d+)/i;

/**
 * Finds the phone's pairing endpoint in `adb mdns services` output.
 *
 * Rows look like:
 *   companion-3f9a2c   _adb-tls-pairing._tcp.   192.168.1.23:41235
 *
 * The instance name is the one we put in the QR payload, and in this flow that
 * name is the *only* evidence that the phone in front of the user is the one
 * that scanned our code — so an exact match is what we want.
 *
 * Some ROMs do advertise the pairing service under their own name
 * (`adb-<serial>-…`), hence `allowRename`. It is deliberately narrow: taking any
 * pairing row would mean firing our password at a stranger's phone that merely
 * has its own pairing dialog open, which fails and burns their pairing attempt.
 * So the fallback only applies when there is exactly one unrecognised candidate,
 * and callers should hold it back until the exact-name search has come up empty
 * for a while.
 */
function findPairingEndpoint(mdnsOutput, name = null, { allowRename = true } = {}) {
  const rows = String(mdnsOutput || '')
    .split(/\r?\n/)
    .filter((line) => line.includes(PAIRING_SERVICE));

  const matched = [];
  const others = [];
  for (const line of rows) {
    const m = line.match(ADDRESS);
    if (!m) continue;
    const entry = { target: `${m[1]}:${m[2]}`, host: m[1], port: m[2], name: line.trim().split(/\s+/)[0] };
    if (name && entry.name === name) matched.push(entry);
    else others.push(entry);
  }
  if (matched[0]) return matched[0];
  if (allowRename && others.length === 1) return others[0];
  return null;
}

/**
 * adb's mDNS backend is the weak link on Windows: when it is not running, the
 * phone is never discovered and the pairing looks like it silently failed.
 *
 * Feed this the output of `adb mdns check`, not `adb mdns services`. With a dead
 * daemon, `services` prints its "List of discovered mdns services" header and
 * nothing else — no error to detect — so watching that output can only ever
 * produce a timeout that blames the user's phone. `check` is the subcommand that
 * actually reports on the backend: "mdns daemon version [nnnn]" when it is up.
 */
function mdnsUnavailable(checkOutput) {
  const text = String(checkOutput || '').trim();
  if (!text) return false; // nothing to go on; don't block pairing on a guess
  if (/mdns\s+daemon\s+version/i.test(text)) return false;
  return /(unavailable|not\s+running|unable|cannot|failed|error)/i.test(text);
}

module.exports = {
  PAIRING_SERVICE,
  NAME_PREFIX,
  buildPairingPayload,
  newPairingSession,
  findPairingEndpoint,
  mdnsUnavailable,
};

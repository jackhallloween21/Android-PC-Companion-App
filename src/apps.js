// ---------------------------------------------------------------------------
// App inventory (pure).
//
// The awkward truth this module is built around: adb shell cannot tell you an
// app's *name*. `pm list packages` returns package ids and nothing else, and
// `dumpsys package` prints a numeric `labelRes` resource id rather than the
// string it points at. The only ways to resolve it are to read the APK's
// resources.arsc or to ask the framework from inside an app — neither of which
// is available here. So the label is layered, and every entry says where it came
// from so the UI can be honest about it:
//
//   1. `catalogue` — a curated table of packages whose names are stable and
//      well known. Correct, but only covers what is listed.
//   2. `dump` — an `applicationLabel=` line, which a few OEM builds do print.
//   3. `derived` — title-cased from the package id (`com.google.android.youtube`
//      -> "Youtube"). A readable guess, and marked as one.
//
// The package id is always shown next to the label for exactly this reason: it
// is the part that is never guessed.
//
// Icons are the same problem one step further — the real launcher icon lives in
// the APK. What is drawn instead is a deterministic monogram tile, coloured from
// a hash of the package id, so an app keeps the same colour across refreshes and
// across devices.
// ---------------------------------------------------------------------------

const KIB = 1024;

/**
 * One shell round trip for the whole inventory.
 *
 * `pm list packages -f` is the useful one: it returns `package:<apk path>=<id>`,
 * which means the APK path arrives with the list instead of costing a `pm path`
 * per app. The size loop re-derives those paths and stats them in the same
 * shell — 300 apps would otherwise be 300 adb invocations.
 *
 * The trailing `exit 0` is load-bearing. A script inherits the status of its
 * last command, and `stat` on a path that has since been replaced (a system app
 * updated in /data) exits non-zero, which would make `adb shell` fail and the
 * entire sweep be discarded.
 */
const APPS_SCRIPT = [
  'echo "@@ALL@@";', 'pm list packages -f --user 0 2>/dev/null;',
  'echo "@@THIRD@@";', 'pm list packages -3 --user 0 2>/dev/null;',
  'echo "@@DISABLED@@";', 'pm list packages -d --user 0 2>/dev/null;',
  'echo "@@INSTALLER@@";', 'pm list packages -i --user 0 2>/dev/null;',
  'echo "@@SIZES@@";',
  'pm list packages -f --user 0 2>/dev/null',
  '| sed -e "s/^package://" -e "s/=[^=]*$//"',
  '| while read -r p; do',
  '[ -n "$p" ] && stat -c "%s %n" "$p" 2>/dev/null;',
  'done;',
  'exit 0',
].join(' ');

const SECTIONS = { '@@ALL@@': 'all', '@@THIRD@@': 'third', '@@DISABLED@@': 'disabled', '@@INSTALLER@@': 'installer', '@@SIZES@@': 'sizes' };

/** Splits the marked APPS_SCRIPT output back into its sections. */
function parseAppsDump(raw) {
  const out = { all: '', third: '', disabled: '', installer: '', sizes: '' };
  let current = null;
  for (const line of String(raw || '').split('\n')) {
    const text = line.replace(/\r$/, '');
    const key = SECTIONS[text.trim()];
    if (key) { current = key; continue; }
    if (current) out[current] += `${text}\n`;
  }
  return out;
}

/** `package:com.foo` lines into a Set, tolerating the `-f` and `-i` suffixes. */
function parsePackageSet(text) {
  const set = new Set();
  for (const line of String(text || '').split('\n')) {
    const pkg = packageFromListLine(line);
    if (pkg) set.add(pkg);
  }
  return set;
}

/**
 * The package id out of one `pm list packages` line, whichever flags were used:
 *   package:com.foo
 *   package:/data/app/~~a/com.foo-b/base.apk=com.foo      (-f)
 *   package:com.foo  installer=com.android.vending        (-i)
 */
function packageFromListLine(line) {
  let text = String(line || '').trim();
  if (!text.startsWith('package:')) return null;
  text = text.slice('package:'.length).trim();
  text = text.split(/\s+/)[0] || '';
  // With -f the id is after the last '=', because the APK path can contain none.
  const eq = text.lastIndexOf('=');
  if (eq !== -1) text = text.slice(eq + 1);
  return text.trim() || null;
}

/** `-f` lines into { pkg -> apk path }. */
function parseApkPaths(text) {
  const paths = {};
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('package:')) continue;
    const body = trimmed.slice('package:'.length);
    const eq = body.lastIndexOf('=');
    if (eq === -1) continue;
    const apk = body.slice(0, eq).trim();
    const pkg = body.slice(eq + 1).trim();
    if (pkg && apk) paths[pkg] = apk;
  }
  return paths;
}

/** `-i` lines into { pkg -> installer }, with `null` for a preloaded app. */
function parseInstallers(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^package:(\S+)\s+installer=(\S+)/);
    if (!m) continue;
    const installer = m[2] === 'null' ? null : m[2];
    out[m[1]] = installer;
  }
  return out;
}

/** `stat -c "%s %n"` lines into { path -> bytes }. */
function parseStatSizes(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S.*)$/);
    if (!m) continue;
    const bytes = Number(m[1]);
    if (Number.isFinite(bytes)) out[m[2].trim()] = bytes;
  }
  return out;
}

// --------------------------------------------------------------------- labels
//
// Curated names for packages a phone is very likely to have. This exists because
// the framework's own label is unreachable over adb (see the header), and a
// derived name gets some of these badly wrong — "com.android.vending" derives to
// "Vending", which is not a thing any user has heard of.
const CATALOGUE = {
  'com.android.vending': 'Google Play Store',
  'com.google.android.gms': 'Google Play Services',
  'com.google.android.gsf': 'Google Services Framework',
  'com.google.android.googlequicksearchbox': 'Google',
  'com.google.android.apps.photos': 'Google Photos',
  'com.google.android.apps.maps': 'Google Maps',
  'com.google.android.apps.messaging': 'Google Messages',
  'com.google.android.apps.docs': 'Google Drive',
  'com.google.android.apps.nbu.files': 'Files by Google',
  'com.google.android.apps.tachyon': 'Google Meet',
  'com.google.android.apps.wellbeing': 'Digital Wellbeing',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.gm': 'Gmail',
  'com.google.android.calendar': 'Google Calendar',
  'com.google.android.contacts': 'Contacts',
  'com.google.android.dialer': 'Phone',
  'com.google.android.deskclock': 'Clock',
  'com.google.android.inputmethod.latin': 'Gboard',
  'com.google.android.tts': 'Speech Services',
  'com.google.android.webview': 'Android System WebView',
  'com.google.android.packageinstaller': 'Package Installer',
  'com.google.android.setupwizard': 'Setup Wizard',
  'com.google.android.partnersetup': 'Google Partner Setup',
  'com.google.android.projection.gearhead': 'Android Auto',
  'com.google.ar.core': 'Google Play Services for AR',
  'com.android.chrome': 'Chrome',
  'com.android.settings': 'Settings',
  'com.android.systemui': 'System UI',
  'com.android.phone': 'Phone Services',
  'com.android.providers.media.module': 'Media Storage',
  'com.android.providers.downloads': 'Download Manager',
  'com.android.documentsui': 'Files',
  'com.android.bluetooth': 'Bluetooth',
  'com.android.nfc': 'NFC Service',
  'com.android.shell': 'ADB Shell',
  'com.android.cts.priv.ctsshim': 'CTS Shim (priv)',
  'com.android.cts.ctsshim': 'CTS Shim',
};

// Second half of the catalogue: OEM and popular third-party packages.
Object.assign(CATALOGUE, {
  'com.samsung.android.messaging': 'Samsung Messages',
  'com.samsung.android.dialer': 'Samsung Phone',
  'com.samsung.android.app.contacts': 'Samsung Contacts',
  'com.sec.android.gallery3d': 'Samsung Gallery',
  'com.sec.android.app.camera': 'Samsung Camera',
  'com.sec.android.app.myfiles': 'My Files',
  'com.samsung.android.bixby.agent': 'Bixby',
  'com.samsung.android.app.spage': 'Samsung Free',
  'com.samsung.android.game.gamehome': 'Game Launcher',
  'com.samsung.android.scloud': 'Samsung Cloud',
  'com.samsung.android.themestore': 'Galaxy Themes',
  'com.sec.android.app.samsungapps': 'Galaxy Store',
  'com.samsung.android.arzone': 'AR Zone',
  'com.miui.home': 'Xiaomi Launcher',
  'com.miui.gallery': 'Xiaomi Gallery',
  'com.miui.securitycenter': 'Xiaomi Security',
  'com.miui.msa.global': 'MSA (Xiaomi ad services)',
  'com.miui.analytics': 'Xiaomi Analytics',
  'com.xiaomi.glgm': 'Xiaomi Game Center',
  'com.mi.globalbrowser': 'Mi Browser',
  'com.oneplus.gallery': 'OnePlus Gallery',
  'com.oplus.camera': 'OPPO Camera',
  'com.coloros.gallery3d': 'ColorOS Gallery',
  'com.transsion.phoenix': 'Phoenix Browser',
  'com.motorola.launcher3': 'Motorola Launcher',
  'com.whatsapp': 'WhatsApp',
  'com.facebook.katana': 'Facebook',
  'com.facebook.appmanager': 'Facebook App Manager',
  'com.facebook.services': 'Facebook Services',
  'com.facebook.system': 'Facebook Installer',
  'com.instagram.android': 'Instagram',
  'com.spotify.music': 'Spotify',
  'com.netflix.mediaclient': 'Netflix',
  'com.netflix.partner.activation': 'Netflix Activation',
  'com.amazon.mShop.android.shopping': 'Amazon Shopping',
  'com.microsoft.office.outlook': 'Outlook',
  'com.microsoft.skydrive': 'OneDrive',
  'com.linkedin.android': 'LinkedIn',
  'com.twitter.android': 'X (Twitter)',
  'com.zhiliaoapp.musically': 'TikTok',
  'com.discord': 'Discord',
  'com.reddit.frontpage': 'Reddit',
  'org.telegram.messenger': 'Telegram',
  'com.snapchat.android': 'Snapchat',
  'com.valvesoftware.android.steam.community': 'Steam',
  'com.termux': 'Termux',
});

// Segments that carry no meaning on their own, so the derivation keeps looking
// leftwards for something a person would recognise.
const FILLER = new Set([
  'android', 'app', 'apps', 'com', 'org', 'net', 'io', 'mobile', 'client',
  'service', 'services', 'provider', 'providers', 'module', 'core', 'main',
  'ui', 'free', 'lite', 'pro', 'plus', 'global', 'overlay', 'stub', 'installer',
]);

const VENDOR = {
  'com.google': 'Google', 'com.android': 'Android', 'android': 'Android',
  'com.samsung': 'Samsung', 'com.sec': 'Samsung', 'com.miui': 'Xiaomi',
  'com.xiaomi': 'Xiaomi', 'com.mi': 'Xiaomi', 'com.oplus': 'OPPO',
  'com.coloros': 'OPPO', 'com.oneplus': 'OnePlus', 'com.motorola': 'Motorola',
  'com.qualcomm': 'Qualcomm', 'com.qti': 'Qualcomm', 'com.mediatek': 'MediaTek',
  'com.microsoft': 'Microsoft', 'com.amazon': 'Amazon', 'com.facebook': 'Meta',
};

/** The publisher a package id implies, or null. Never shown as fact, only as a hint. */
function vendorOf(pkg) {
  const id = String(pkg || '');
  const two = id.split('.').slice(0, 2).join('.');
  return VENDOR[two] || VENDOR[id.split('.')[0]] || null;
}

/** `youtubeMusic` / `youtube_music` / `youtube-music` -> `Youtube Music`. */
function titleCase(segment) {
  return String(segment || '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && w === w.toUpperCase() ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * A readable name guessed from the package id, walking right to left past
 * segments that say nothing ("com.google.android.apps.nbu.files" -> "Files").
 * Always paired with `labelSource: 'derived'` so the UI can mark it as a guess.
 */
function deriveLabel(pkg) {
  const parts = String(pkg || '').split('.').filter(Boolean);
  if (!parts.length) return String(pkg || '');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (!FILLER.has(parts[i].toLowerCase())) return titleCase(parts[i]);
  }
  return titleCase(parts[parts.length - 1]);
}

/**
 * The label to show, plus where it came from.
 *
 * `dumpLabel` is only present on the handful of builds that print an
 * `applicationLabel=` line; it is preferred over the catalogue because it comes
 * from the device itself.
 */
function resolveLabel(pkg, dumpLabel = null) {
  const fromDump = String(dumpLabel || '').trim();
  if (fromDump) return { label: fromDump, labelSource: 'dump' };
  if (CATALOGUE[pkg]) return { label: CATALOGUE[pkg], labelSource: 'catalogue' };
  return { label: deriveLabel(pkg), labelSource: 'derived' };
}

// Avatar palette. Deliberately the same hues as the storage categories so the
// app as a whole looks like one product; index is chosen by hash, not by order,
// so a package keeps its colour whatever else is installed.
const AVATAR_COLORS = [
  '#3b82f6', '#34d399', '#fbbf24', '#a855f7',
  '#38bdf8', '#f472b6', '#f87171', '#22d3ee',
];

/** FNV-1a. Any stable hash would do; this one is short and has no collisions worth caring about here. */
function hashString(text) {
  let h = 0x811c9dc5;
  const s = String(text || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function avatarColor(pkg) {
  return AVATAR_COLORS[hashString(pkg) % AVATAR_COLORS.length];
}

/**
 * One or two letters for the tile. Two words give initials ("Google Play" ->
 * "GP"); one word gives its first letter. Digits and symbols are skipped so
 * "3C Toolbox" does not become "3".
 */
function monogram(label) {
  const words = String(label || '').split(/[\s._-]+/).map((w) => w.replace(/[^A-Za-z0-9]/g, '')).filter(Boolean);
  const letters = words.filter((w) => /^[A-Za-z]/.test(w));
  const pick = letters.length ? letters : words;
  if (!pick.length) return '?';
  if (pick.length === 1) return pick[0][0].toUpperCase();
  return (pick[0][0] + pick[1][0]).toUpperCase();
}

// ----------------------------------------------------------------- bloatware
//
// "Bloat" is a judgement, not a fact, so every rule carries the reason it fired
// and the UI shows that reason rather than an unexplained red badge. The rules
// only ever mark *preinstalled* packages: something the user chose to install is
// not bloat no matter what it is.
//
// Nothing here uninstalls anything on its own — it only sorts the list. Removing
// a package still takes an explicit click, because a few of these are load-
// bearing on some builds (disabling a carrier IMS package can break VoLTE).
const BLOAT_RULES = [
  { test: /^com\.(vzw|verizon|att|tmobile|sprint|telstra|vodafone|orange|claro|movistar|rogers|telus|bell|jio|airtel|dti)\b/i, reason: 'Carrier preload', carrier: true },
  { test: /(^|\.)(vzw|myverizon|attmessages|tmo|sprint)\./i, reason: 'Carrier preload', carrier: true },
  { test: /^com\.facebook\.(appmanager|services|system)$/i, reason: 'Preinstalled Facebook stub that keeps itself updated' },
  { test: /^com\.netflix\.partner\.activation$/i, reason: 'Preinstalled partner activation stub' },
  { test: /^com\.miui\.(msa|analytics|systemAdSolution|daemon)/i, reason: 'Xiaomi ad or analytics service' },
  { test: /^com\.xiaomi\.(glgm|joyose|mipicks)/i, reason: 'Xiaomi promotional service' },
  { test: /^com\.samsung\.android\.(app\.spage|game\.gamehome|arzone|kidsinstaller|mateagent)$/i, reason: 'Samsung promotional or optional extra' },
  { test: /^com\.samsung\.android\.rubin\.app$/i, reason: 'Samsung usage-analytics service' },
  { test: /^com\.(linkedin|amazon\.mShop|booking|spotify|netflix\.mediaclient)/i, reason: 'Preinstalled third-party app' },
  { test: /\.(analytics|telemetry|adservice|adsdk)(\.|$)/i, reason: 'Analytics or advertising component' },
];

/** The matching rule for a preinstalled package, or null. */
function bloatRule(pkg, { preinstalled = true } = {}) {
  if (!preinstalled) return null;
  const id = String(pkg || '');
  return BLOAT_RULES.find((r) => r.test.test(id)) || null;
}

/**
 * How the app got onto the phone.
 *
 * `user` means it was installed by something (the Play Store, sideloading, this
 * app) rather than shipped in the system image. `carrier` is a subset of system
 * that a carrier rule matched — worth calling out separately because it is the
 * category people actually want to find.
 */
function classifyType(pkg, { thirdParty = false, rule = null } = {}) {
  if (thirdParty) return 'user';
  if (rule && rule.carrier) return 'carrier';
  return 'system';
}

// --------------------------------------------------------------- permissions
//
// `dumpsys package` prints raw constant names, which are readable but not
// *legible*: ACCESS_COARSE_LOCATION and ACCESS_BACKGROUND_LOCATION sit next to
// each other in an alphabetical list and mean very different things. So each
// known permission gets a plain-English label and a group, and the groups are
// ordered by how much they matter to a person reading the list — the sensors and
// personal data first, housekeeping last.
const PERMISSION_GROUPS = [
  { key: 'location', label: 'Location', color: '#34d399' },
  { key: 'camera', label: 'Camera', color: '#3b82f6' },
  { key: 'microphone', label: 'Microphone', color: '#a855f7' },
  { key: 'contacts', label: 'Contacts & accounts', color: '#f472b6' },
  { key: 'phone', label: 'Phone & call log', color: '#fbbf24' },
  { key: 'sms', label: 'Messages', color: '#38bdf8' },
  { key: 'calendar', label: 'Calendar', color: '#22d3ee' },
  { key: 'storage', label: 'Files & media', color: '#f87171' },
  { key: 'body', label: 'Body sensors & activity', color: '#fb923c' },
  { key: 'network', label: 'Network & connectivity', color: '#64748b' },
  { key: 'system', label: 'System & background', color: '#94a3b8' },
  { key: 'other', label: 'Other declared permissions', color: '#64748b' },
];

const GROUP_BY_KEY = new Map(PERMISSION_GROUPS.map((g) => [g.key, g]));

const PERMISSIONS = {
  ACCESS_FINE_LOCATION: ['Location (precise)', 'location'],
  ACCESS_COARSE_LOCATION: ['Location (approximate)', 'location'],
  ACCESS_BACKGROUND_LOCATION: ['Location in the background', 'location'],
  ACCESS_MEDIA_LOCATION: ['Location tags in photos', 'location'],
  CAMERA: ['Camera access', 'camera'],
  RECORD_AUDIO: ['Microphone', 'microphone'],
  CAPTURE_AUDIO_OUTPUT: ['Capture audio output', 'microphone'],
  MODIFY_AUDIO_SETTINGS: ['Change audio settings', 'microphone'],
  READ_CONTACTS: ['Read contacts', 'contacts'],
  WRITE_CONTACTS: ['Modify contacts', 'contacts'],
  GET_ACCOUNTS: ['See your accounts', 'contacts'],
  READ_PHONE_STATE: ['Phone state & identity', 'phone'],
  READ_PHONE_NUMBERS: ['Read your phone number', 'phone'],
  CALL_PHONE: ['Place calls', 'phone'],
  ANSWER_PHONE_CALLS: ['Answer calls', 'phone'],
  READ_CALL_LOG: ['Read call log', 'phone'],
  WRITE_CALL_LOG: ['Modify call log', 'phone'],
  SEND_SMS: ['Send SMS', 'sms'],
  RECEIVE_SMS: ['Receive SMS', 'sms'],
  READ_SMS: ['Read SMS', 'sms'],
  RECEIVE_MMS: ['Receive MMS', 'sms'],
  READ_CALENDAR: ['Read calendar', 'calendar'],
  WRITE_CALENDAR: ['Modify calendar', 'calendar'],
};

Object.assign(PERMISSIONS, {
  READ_EXTERNAL_STORAGE: ['Read files & media', 'storage'],
  WRITE_EXTERNAL_STORAGE: ['Write files & media', 'storage'],
  MANAGE_EXTERNAL_STORAGE: ['Manage all files', 'storage'],
  READ_MEDIA_IMAGES: ['Read photos', 'storage'],
  READ_MEDIA_VIDEO: ['Read videos', 'storage'],
  READ_MEDIA_AUDIO: ['Read audio files', 'storage'],
  BODY_SENSORS: ['Body sensors', 'body'],
  ACTIVITY_RECOGNITION: ['Physical activity', 'body'],
  HIGH_SAMPLING_RATE_SENSORS: ['High-rate sensor data', 'body'],
  INTERNET: ['Internet access', 'network'],
  ACCESS_NETWORK_STATE: ['See network state', 'network'],
  ACCESS_WIFI_STATE: ['See Wi-Fi state', 'network'],
  CHANGE_WIFI_STATE: ['Change Wi-Fi state', 'network'],
  NEARBY_WIFI_DEVICES: ['Nearby Wi-Fi devices', 'network'],
  BLUETOOTH: ['Bluetooth', 'network'],
  BLUETOOTH_CONNECT: ['Connect to Bluetooth devices', 'network'],
  BLUETOOTH_SCAN: ['Scan for Bluetooth devices', 'network'],
  NFC: ['NFC', 'network'],
  POST_NOTIFICATIONS: ['Post notifications', 'system'],
  FOREGROUND_SERVICE: ['Run foreground services', 'system'],
  FOREGROUND_SERVICE_MEDIA_PLAYBACK: ['Background audio playback', 'system'],
  FOREGROUND_SERVICE_LOCATION: ['Background location service', 'system'],
  RECEIVE_BOOT_COMPLETED: ['Start at boot', 'system'],
  WAKE_LOCK: ['Keep the device awake', 'system'],
  VIBRATE: ['Vibrate', 'system'],
  SCHEDULE_EXACT_ALARM: ['Schedule exact alarms', 'system'],
  REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: ['Ignore battery optimisation', 'system'],
  SYSTEM_ALERT_WINDOW: ['Draw over other apps', 'system'],
  QUERY_ALL_PACKAGES: ['See all installed apps', 'system'],
  REQUEST_INSTALL_PACKAGES: ['Install other apps', 'system'],
  REQUEST_DELETE_PACKAGES: ['Uninstall other apps', 'system'],
  USE_BIOMETRIC: ['Biometric unlock', 'system'],
  USE_FINGERPRINT: ['Fingerprint unlock', 'system'],
  READ_SYNC_SETTINGS: ['Read sync settings', 'system'],
  WRITE_SYNC_SETTINGS: ['Change sync settings', 'system'],
  BILLING: ['In-app purchases', 'system'],
});

/** The friendly name and group for one permission id. Unknown ids keep their constant. */
function describePermission(id) {
  const full = String(id || '').trim();
  const short = full.replace(/^.*\.permission(-group)?\./, '');
  const hit = PERMISSIONS[short];
  return {
    id: full,
    short,
    label: hit ? hit[0] : titleCase(short.toLowerCase()),
    group: hit ? hit[1] : 'other',
    known: !!hit,
  };
}

/**
 * Declared permissions folded into ordered, labelled groups.
 *
 * `granted` is deliberately three-valued. `dumpsys package` reports it only for
 * permissions the framework has actually decided on: install-time permissions
 * are listed as granted=true, runtime ones carry the user's answer, and a
 * runtime permission that has never been asked for appears in `requested
 * permissions:` and nowhere else. That last case is "declared but not granted",
 * which is a different statement from "denied" — so it stays null and the UI
 * shows a hollow marker rather than a red cross.
 */
function groupPermissions(entries) {
  const list = (Array.isArray(entries) ? entries : [])
    .map((e) => (typeof e === 'string' ? { id: e, granted: null } : e))
    .filter((e) => e && e.id);

  const byGroup = new Map();
  for (const entry of list) {
    const info = describePermission(entry.id);
    if (!byGroup.has(info.group)) byGroup.set(info.group, []);
    byGroup.get(info.group).push({ ...info, granted: entry.granted ?? null });
  }

  const out = [];
  for (const group of PERMISSION_GROUPS) {
    const items = byGroup.get(group.key);
    if (!items || !items.length) continue;
    items.sort((a, b) => a.label.localeCompare(b.label));
    out.push({
      ...group,
      items,
      grantedCount: items.filter((i) => i.granted === true).length,
    });
  }
  return out;
}

/** Counts for the header: how many are granted, denied, or merely declared. */
function permissionSummary(groups) {
  let granted = 0;
  let denied = 0;
  let declared = 0;
  for (const g of (groups || [])) {
    for (const item of g.items) {
      if (item.granted === true) granted += 1;
      else if (item.granted === false) denied += 1;
      else declared += 1;
    }
  }
  return { granted, denied, declared, total: granted + denied + declared };
}

// ------------------------------------------------------- dumpsys package <pkg>

/**
 * The indented lines under a `foo:` header.
 *
 * Written against indentation rather than a blank-line terminator because
 * `dumpsys package` does not put blank lines between its blocks — `install
 * permissions:` is followed immediately by `User 0:` at the same indent. The
 * block ends at the first line indented no further than its header.
 */
function readBlock(text, headerRegex, fromIndex = 0) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((line, i) => i >= fromIndex && headerRegex.test(line));
  if (start === -1) return { lines: [], endIndex: fromIndex };
  const indent = (s) => s.length - s.replace(/^\s*/, '').length;
  const base = indent(lines[start]);
  const out = [];
  let i = start + 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    if (indent(line) <= base) break;
    out.push(line.trim());
  }
  return { lines: out, endIndex: i };
}

/** `android.permission.CAMERA: granted=false, flags=[ USER_SET ]` */
function parsePermissionLine(line) {
  const m = String(line || '').trim().match(/^([A-Za-z0-9_.]+\.permission[^\s:]*|[A-Za-z0-9_.]+):?\s*(.*)$/);
  if (!m) return null;
  const id = m[1];
  if (!id.includes('.')) return null;
  const granted = /granted=true/.test(m[2]) ? true : (/granted=false/.test(m[2]) ? false : null);
  return { id, granted };
}

/**
 * Every permission the package declares, with the framework's decision where it
 * has one. Three sources are merged, later ones winning: `requested permissions`
 * (the complete list, no decisions), `install permissions` (normal permissions,
 * always granted), and the `runtime permissions` block for user 0 (the answers
 * the user actually gave).
 */
function parseDeclaredPermissions(text) {
  const merged = new Map();
  const add = (entry) => {
    if (!entry) return;
    const prev = merged.get(entry.id);
    merged.set(entry.id, { id: entry.id, granted: entry.granted ?? (prev ? prev.granted : null) });
  };

  for (const line of readBlock(text, /^\s*requested permissions:\s*$/m).lines) add(parsePermissionLine(line));
  for (const line of readBlock(text, /^\s*install permissions:\s*$/m).lines) add(parsePermissionLine(line));

  // Runtime grants are per-user; user 0 is the one this app talks to.
  const src = String(text || '');
  const userIdx = src.split('\n').findIndex((l) => /^\s*User 0:/.test(l));
  const runtime = readBlock(src, /^\s*runtime permissions:\s*$/m, userIdx === -1 ? 0 : userIdx);
  for (const line of runtime.lines) add(parsePermissionLine(line));

  return [...merged.values()];
}

const field = (text, key) => {
  const m = String(text || '').match(new RegExp(`\\b${key}=([^\\s\\]]+)`));
  return m ? m[1] : null;
};

/** A `2024-01-02 10:00:00` timestamp as an ISO date, or null. dumpsys prints local time. */
function parseInstallTime(text, key) {
  const m = String(text || '').match(new RegExp(`\\b${key}=(\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2})`));
  if (!m) return null;
  const t = Date.parse(m[1].replace(' ', 'T'));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The parts of `dumpsys package <pkg>` worth showing.
 *
 * `stopped` is the framework's own flag for an app that has never been launched
 * or was force-stopped. It is the only third state available without root, which
 * is why the status pill has exactly three values and no invented "idle".
 */
function parsePackageDump(text) {
  const src = String(text || '');
  const userLine = (src.split('\n').find((l) => /^\s*User 0:/.test(l)) || '');
  const num = (v) => {
    if (v === null || v === undefined || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const flagsMatch = src.match(/\bflags=\[([^\]]*)\]/);
  const label = src.match(/\bapplicationLabel=(.+)/);

  return {
    found: /\bPackage \[/.test(src) || /\bversionName=/.test(src),
    label: label ? label[1].trim() || null : null,
    versionName: field(src, 'versionName'),
    versionCode: num(field(src, 'versionCode')),
    minSdk: num(field(src, 'minSdk')),
    targetSdk: num(field(src, 'targetSdk')),
    installer: (() => { const v = field(src, 'installerPackageName'); return !v || v === 'null' ? null : v; })(),
    firstInstall: parseInstallTime(src, 'firstInstallTime'),
    lastUpdate: parseInstallTime(src, 'lastUpdateTime'),
    dataDir: field(src, 'dataDir'),
    codePath: field(src, 'codePath'),
    flags: flagsMatch ? flagsMatch[1].trim().split(/\s+/).filter(Boolean) : [],
    stopped: /stopped=true/.test(userLine),
    notLaunched: /notLaunched=true/.test(userLine),
    userInstalled: userLine ? !/installed=false/.test(userLine) : null,
    permissions: parseDeclaredPermissions(src),
  };
}

// ------------------------------------------------------------------ inventory

/**
 * The whole list, from one APPS_SCRIPT sweep.
 *
 * Sorted by label rather than package id, because that is the order the list is
 * read in; ties fall back to the id so the order is stable between refreshes.
 */
function buildAppList(sections = {}) {
  const all = parsePackageSet(sections.all);
  const third = parsePackageSet(sections.third);
  const disabled = parsePackageSet(sections.disabled);
  const apkPaths = parseApkPaths(sections.all);
  const installers = parseInstallers(sections.installer);
  const sizes = parseStatSizes(sections.sizes);

  // A disabled system app is missing from `pm list packages -f`, so the disabled
  // set has to be folded in or debloated apps would vanish from the list.
  for (const pkg of disabled) all.add(pkg);

  const out = [];
  for (const pkg of all) {
    const thirdParty = third.has(pkg);
    const rule = bloatRule(pkg, { preinstalled: !thirdParty });
    const { label, labelSource } = resolveLabel(pkg);
    const apkPath = apkPaths[pkg] || null;
    out.push({
      pkg,
      label,
      labelSource,
      vendor: vendorOf(pkg),
      monogram: monogram(label),
      color: avatarColor(pkg),
      type: classifyType(pkg, { thirdParty, rule }),
      status: disabled.has(pkg) ? 'disabled' : 'active',
      bloat: !!rule,
      bloatReason: rule ? rule.reason : null,
      installer: installers[pkg] ?? null,
      apkPath,
      apkBytes: apkPath && Number.isFinite(sizes[apkPath]) ? sizes[apkPath] : null,
    });
  }

  out.sort((a, b) => a.label.localeCompare(b.label) || a.pkg.localeCompare(b.pkg));
  return out;
}

// The filters offered above the list, in tab order. `test` is what decides
// membership, and the same predicate produces the count on the tab — so a tab
// can never claim a number the list then disagrees with.
const APP_FILTERS = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'user', label: 'User', test: (a) => a.type === 'user' },
  { key: 'system', label: 'System', test: (a) => a.type === 'system' || a.type === 'carrier' },
  { key: 'bloat', label: 'Bloatware', test: (a) => a.bloat },
  { key: 'disabled', label: 'Disabled', test: (a) => a.status === 'disabled' },
];

const FILTER_BY_KEY = new Map(APP_FILTERS.map((f) => [f.key, f]));

/**
 * Applies a tab and a search box. The search matches the label as well as the
 * package id: someone looking for "gallery" should not have to know whether this
 * phone calls it com.sec.android.gallery3d or com.miui.gallery.
 */
function filterApps(apps, { filter = 'all', query = '' } = {}) {
  const rule = FILTER_BY_KEY.get(filter) || FILTER_BY_KEY.get('all');
  const q = String(query || '').trim().toLowerCase();
  return (Array.isArray(apps) ? apps : []).filter((a) => {
    if (!rule.test(a)) return false;
    if (!q) return true;
    return a.pkg.toLowerCase().includes(q) || String(a.label || '').toLowerCase().includes(q);
  });
}

/** One count per tab, computed from the same predicates the tabs filter with. */
function countApps(apps) {
  const list = Array.isArray(apps) ? apps : [];
  const counts = {};
  for (const f of APP_FILTERS) counts[f.key] = list.filter(f.test).length;
  return counts;
}

// ----------------------------------------------------------------- app detail

// Why a size can be missing. /data/data is 0700 root:root with SELinux on top,
// so `du` from the adb shell is denied for every app that is not debuggable —
// this is a platform limitation, not a bug, and the panel says so instead of
// printing a confident 0 B.
const NO_SIZE_NOTE = 'Android hides app data from adb unless the app is debuggable or the device is rooted.';

/**
 * The inspector's view of one app.
 *
 * Sizes are three separate measurements with three separate failure modes, so
 * they are reported per row: the APK is always readable, while data and cache
 * usually are not. `totalBytes` adds up only what was measured and says how much
 * of the picture that is, rather than presenting a partial sum as the total.
 */
function buildAppDetail({ app = null, dump = null, apkBytes = null, dataBytes = null, cacheBytes = null } = {}) {
  const info = dump || {};
  const base = app || {};
  const resolved = resolveLabel(base.pkg, info.label);
  const groups = groupPermissions(info.permissions || []);

  const row = (key, label, bytes) => ({
    key,
    label,
    bytes: Number.isFinite(bytes) && bytes >= 0 ? bytes : null,
    note: Number.isFinite(bytes) && bytes >= 0 ? null : NO_SIZE_NOTE,
  });
  const footprint = [
    row('apk', 'APK binary', apkBytes ?? base.apkBytes ?? null),
    row('data', 'User app data', dataBytes),
    row('cache', 'Cache storage', cacheBytes),
  ];
  const measured = footprint.filter((f) => f.bytes !== null);

  return {
    ...base,
    label: resolved.label,
    labelSource: resolved.labelSource,
    monogram: monogram(resolved.label),
    versionName: info.versionName || null,
    versionCode: info.versionCode ?? null,
    targetSdk: info.targetSdk ?? null,
    installer: info.installer ?? base.installer ?? null,
    firstInstall: info.firstInstall || null,
    lastUpdate: info.lastUpdate || null,
    debuggable: (info.flags || []).includes('DEBUGGABLE'),
    stopped: !!info.stopped,
    footprint,
    totalBytes: measured.length ? measured.reduce((sum, f) => sum + f.bytes, 0) : null,
    totalComplete: measured.length === footprint.length,
    permissionGroups: groups,
    permissionSummary: permissionSummary(groups),
  };
}

// --------------------------------------------------------------- sideloading

/** `du -sk <path>` (one line) as bytes, or null. */
function parseDuBytes(text) {
  const m = String(text || '').trim().match(/^(\d+)\s+/m);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n * KIB : null;
}

function isApkPath(filePath) {
  return /\.(apk|apks|apkm|xapk)$/i.test(String(filePath || '').trim());
}

/** Only .apk can be handed straight to `adb install`; the bundle formats cannot. */
function isInstallable(filePath) {
  return /\.apk$/i.test(String(filePath || '').trim());
}

// `adb install` reports failure on stdout and, depending on the version, still
// exits 0 — the same trap as `adb pair`. These are the codes worth translating;
// anything else is shown verbatim, because a raw code the user can search for
// beats a vague paraphrase.
const INSTALL_FAILURES = {
  INSTALL_FAILED_ALREADY_EXISTS: 'That app is already installed. Reinstalling over it kept failing — uninstall it first.',
  INSTALL_FAILED_VERSION_DOWNGRADE: 'The installed version is newer. Android refuses downgrades unless the app is uninstalled first.',
  INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'A different signing key signed the installed copy, so this APK cannot update it.',
  INSTALL_FAILED_INSUFFICIENT_STORAGE: 'Not enough free space on the device.',
  INSTALL_FAILED_INVALID_APK: 'The file is not a valid APK.',
  INSTALL_FAILED_NO_MATCHING_ABIS: 'The APK has no native code for this device’s CPU.',
  INSTALL_FAILED_OLDER_SDK: 'The APK targets a newer Android version than this device runs.',
  INSTALL_FAILED_TEST_ONLY: 'The APK is marked test-only, so it needs `adb install -t`.',
  INSTALL_FAILED_USER_RESTRICTED: 'The phone declined the install. Enable "install via USB" in developer options.',
  INSTALL_FAILED_VERIFICATION_FAILURE: 'Play Protect blocked the install. Turn off "verify apps over USB" to allow it.',
  INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'The APK is unsigned.',
};

/**
 * What `adb install` actually did.
 *
 * "Success" is the only positive signal; the streamed-install progress lines are
 * noise. A failure line carries a bracketed code, which is the useful part.
 */
function parseInstallResult(output) {
  const text = String(output || '').trim();
  if (/^Success$/m.test(text)) return { ok: true, code: null, message: 'Installed' };
  const code = (text.match(/\[?(INSTALL_[A-Z_]+|INSTALL_PARSE_FAILED_[A-Z_]+)/) || [])[1] || null;
  const detail = (text.match(/Failure \[([^\]]+)\]/) || [])[1] || null;
  const message = (code && INSTALL_FAILURES[code]) || detail || text || 'adb install returned no output.';
  return { ok: false, code, message };
}

/**
 * Turns the on-device icon helper's output into a { pkg: dataUrl } map.
 *
 * The helper (a tiny dex run with `app_process`, which is the only way to reach
 * PackageManager.getApplicationIcon from the adb shell without pulling whole
 * APKs) prints one `ICON:<pkg>:<base64png>` line per app it could render, plus
 * whatever the runtime writes to stderr — Binder warnings, a stray "WARNING:
 * linker" line, an occasional stack trace for a package it could not read. So
 * every line is treated as untrusted: only `ICON:` lines with a plausible
 * package id and a clean base64 payload are kept, and anything else is dropped
 * rather than allowed to become a broken <img src>.
 */
const ICON_PKG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.]*$/;
const ICON_B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function parseIconDump(stdout) {
  const icons = {};
  for (const raw of String(stdout || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.startsWith('ICON:')) continue;
    const body = line.slice(5);
    const sep = body.indexOf(':');
    if (sep <= 0) continue;
    const pkg = body.slice(0, sep).trim();
    const b64 = body.slice(sep + 1).trim();
    // A valid PNG is at least a few hundred bytes; a handful of base64 chars is
    // a truncated line, not an icon, so it is discarded.
    if (!ICON_PKG_RE.test(pkg) || b64.length < 32 || !ICON_B64_RE.test(b64)) continue;
    icons[pkg] = `data:image/png;base64,${b64}`;
  }
  return icons;
}

module.exports = {
  KIB, APPS_SCRIPT, parseAppsDump, parsePackageSet, packageFromListLine,
  parseApkPaths, parseInstallers, parseStatSizes, CATALOGUE,
  VENDOR, vendorOf, titleCase, deriveLabel, resolveLabel,
  AVATAR_COLORS, hashString, avatarColor, monogram,
  BLOAT_RULES, bloatRule, classifyType,
  PERMISSION_GROUPS, GROUP_BY_KEY, PERMISSIONS, describePermission,
  groupPermissions, permissionSummary,
  readBlock, parsePermissionLine, parseDeclaredPermissions, parsePackageDump,
  buildAppList, APP_FILTERS, filterApps, countApps,
  NO_SIZE_NOTE, buildAppDetail,
  parseDuBytes, isApkPath, isInstallable, INSTALL_FAILURES, parseInstallResult,
  parseIconDump,
};

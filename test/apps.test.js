// Unit tests for the app inventory, run with `npm test` (node:test).
//
// The recurring theme: adb hands back package *ids*, and everything a person
// wants to see — a name, a size, whether a permission was actually granted — has
// to be derived from several partial sources. These tests pin down what is
// measured, what is guessed, and what is left as "unknown" rather than filled in
// with a plausible-looking zero.

const test = require('node:test');
const assert = require('node:assert');
const {
  APPS_SCRIPT,
  parseAppsDump,
  parsePackageSet,
  packageFromListLine,
  parseApkPaths,
  parseInstallers,
  parseStatSizes,
  deriveLabel,
  resolveLabel,
  avatarColor,
  monogram,
  bloatRule,
  classifyType,
  describePermission,
  groupPermissions,
  permissionSummary,
  readBlock,
  parseDeclaredPermissions,
  parsePackageDump,
  buildAppList,
  filterApps,
  countApps,
  buildAppDetail,
  parseDuBytes,
  isApkPath,
  isInstallable,
  parseInstallResult,
} = require('../src/apps');

// Real `pm list packages -f` output. The /data/app hash directories genuinely
// contain '=' characters, which is why the package id has to be taken from the
// *last* '=' rather than the first.
const LIST_F = `package:/system/priv-app/Settings/Settings.apk=com.android.settings
package:/data/app/~~S4vP8bIQ==/com.whatsapp-mCzJgOaMnB==/base.apk=com.whatsapp
package:/product/priv-app/MyVerizon/MyVerizon.apk=com.vzw.hss.myverizon
package:/system/app/FacebookInstaller/FacebookInstaller.apk=com.facebook.system
package:/system/priv-app/Vending/Vending.apk=com.android.vending
`;

const LIST_3 = `package:com.whatsapp
`;

const LIST_D = `package:com.facebook.system
`;

const LIST_I = `package:com.whatsapp  installer=com.android.vending
package:com.android.settings  installer=null
`;

const SIZES = `61403136 /data/app/~~S4vP8bIQ==/com.whatsapp-mCzJgOaMnB==/base.apk
28311552 /system/priv-app/Settings/Settings.apk
`;

// A trimmed but structurally faithful `dumpsys package com.whatsapp`. The nesting
// matters: `runtime permissions:` is indented under `User 0:`, and none of the
// blocks are separated by blank lines.
const DUMP = `Packages:
  Package [com.whatsapp] (7f3a91b):
    userId=10234
    codePath=/data/app/~~S4vP8bIQ==/com.whatsapp-mCzJgOaMnB==
    primaryCpuAbi=arm64-v8a
    versionCode=524288 minSdk=24 targetSdk=34
    versionName=19.14.36
    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ALLOW_BACKUP ]
    dataDir=/data/user/0/com.whatsapp
    timeStamp=2025-04-30 21:11:02
    firstInstallTime=2024-01-02 10:00:00
    lastUpdateTime=2025-05-01 08:22:11
    installerPackageName=com.android.vending
    pkgFlags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]
    requested permissions:
      android.permission.CAMERA
      android.permission.RECORD_AUDIO
      android.permission.ACCESS_FINE_LOCATION
      android.permission.INTERNET
      android.permission.POST_NOTIFICATIONS
      com.whatsapp.permission.BROADCAST
    install permissions:
      android.permission.INTERNET: granted=true
    User 0: ceDataInode=1234 installed=true hidden=false suspended=false distractionFlags=0 stopped=false notLaunched=false enabled=0 instant=false virtual=false
      gids=[3003]
      runtime permissions:
        android.permission.CAMERA: granted=true, flags=[ USER_SET ]
        android.permission.RECORD_AUDIO: granted=true, flags=[ USER_SET ]
        android.permission.ACCESS_FINE_LOCATION: granted=false, flags=[ USER_SET|USER_FIXED ]
        android.permission.POST_NOTIFICATIONS: granted=true, flags=[ USER_SET ]
`;

test('the batched inventory script cannot be discarded by its own last command', () => {
  // A script inherits the status of its last command, and `stat` on a path that
  // has been replaced exits non-zero — which would throw away the whole sweep.
  assert.ok(APPS_SCRIPT.trim().endsWith('exit 0'), 'APPS_SCRIPT must end with exit 0');
  assert.ok(APPS_SCRIPT.includes('--user 0'), 'every listing is scoped to the primary user');
});

test('the marked sections come back apart', () => {
  const raw = `@@ALL@@\n${LIST_F}@@THIRD@@\n${LIST_3}@@DISABLED@@\n${LIST_D}@@INSTALLER@@\n${LIST_I}@@SIZES@@\n${SIZES}`;
  const sections = parseAppsDump(raw);
  assert.match(sections.all, /com\.whatsapp/);
  assert.match(sections.third, /com\.whatsapp/);
  assert.match(sections.disabled, /com\.facebook\.system/);
  assert.match(sections.installer, /installer=com\.android\.vending/);
  assert.match(sections.sizes, /61403136/);
  assert.deepStrictEqual(parseAppsDump(null), { all: '', third: '', disabled: '', installer: '', sizes: '' });
});

test('a package id survives an APK path that is full of = characters', () => {
  assert.strictEqual(
    packageFromListLine('package:/data/app/~~S4vP8bIQ==/com.whatsapp-mCzJgOaMnB==/base.apk=com.whatsapp'),
    'com.whatsapp'
  );
  assert.strictEqual(packageFromListLine('package:com.whatsapp  installer=com.android.vending'), 'com.whatsapp');
  assert.strictEqual(packageFromListLine('package:com.whatsapp'), 'com.whatsapp');
  assert.strictEqual(packageFromListLine('List of packages:'), null);
  assert.strictEqual(packageFromListLine(''), null);
});

test('paths, installers and sizes are read off the same sweep', () => {
  const paths = parseApkPaths(LIST_F);
  assert.strictEqual(paths['com.whatsapp'], '/data/app/~~S4vP8bIQ==/com.whatsapp-mCzJgOaMnB==/base.apk');
  assert.strictEqual(paths['com.android.settings'], '/system/priv-app/Settings/Settings.apk');

  const installers = parseInstallers(LIST_I);
  assert.strictEqual(installers['com.whatsapp'], 'com.android.vending');
  assert.strictEqual(installers['com.android.settings'], null, 'installer=null means preloaded, not unknown');

  assert.strictEqual(parseStatSizes(SIZES)['/system/priv-app/Settings/Settings.apk'], 28311552);
  assert.deepStrictEqual(parseStatSizes(''), {});
  assert.strictEqual(parsePackageSet(LIST_F).size, 5);
});

test('a label is either known or openly guessed, never silently invented', () => {
  assert.deepStrictEqual(resolveLabel('com.android.vending'), {
    label: 'Google Play Store', labelSource: 'catalogue',
  });
  // The framework's own label wins when a build happens to print one.
  assert.deepStrictEqual(resolveLabel('com.android.vending', 'Play Store'), {
    label: 'Play Store', labelSource: 'dump',
  });
  const guessed = resolveLabel('com.acme.superwidget');
  assert.strictEqual(guessed.label, 'Superwidget');
  assert.strictEqual(guessed.labelSource, 'derived', 'the UI has to be able to mark this as a guess');
});

test('deriving a name walks past segments that mean nothing', () => {
  assert.strictEqual(deriveLabel('com.google.android.apps.nbu.files'), 'Files');
  assert.strictEqual(deriveLabel('com.foo.youtubeMusic'), 'Youtube Music');
  assert.strictEqual(deriveLabel('com.foo.photo_editor'), 'Photo Editor');
  // Everything is filler, so the last segment is used rather than returning ''.
  assert.strictEqual(deriveLabel('com.android.app'), 'App');
  assert.strictEqual(deriveLabel(''), '');
});

test('a monogram and colour are stable for a package, not for its position', () => {
  assert.strictEqual(monogram('Google Play Store'), 'GP');
  assert.strictEqual(monogram('WhatsApp'), 'W');
  assert.strictEqual(monogram('3C Toolbox'), 'T', 'a leading digit is not a useful initial');
  assert.strictEqual(monogram(''), '?');
  assert.strictEqual(avatarColor('com.whatsapp'), avatarColor('com.whatsapp'));
  assert.match(avatarColor('com.whatsapp'), /^#[0-9a-f]{6}$/);
});

test('only preinstalled packages can be called bloat, and the reason is always given', () => {
  const carrier = bloatRule('com.vzw.hss.myverizon');
  assert.ok(carrier);
  assert.strictEqual(carrier.reason, 'Carrier preload');
  assert.strictEqual(carrier.carrier, true);
  assert.ok(bloatRule('com.facebook.system'));
  assert.strictEqual(bloatRule('com.whatsapp'), null);
  // The same package the user installed themselves is not bloat.
  assert.strictEqual(bloatRule('com.linkedin.android', { preinstalled: false }), null);
});

test('type separates what the user installed from what shipped with the phone', () => {
  assert.strictEqual(classifyType('com.whatsapp', { thirdParty: true }), 'user');
  assert.strictEqual(classifyType('com.android.settings', {}), 'system');
  assert.strictEqual(
    classifyType('com.vzw.hss.myverizon', { rule: bloatRule('com.vzw.hss.myverizon') }),
    'carrier'
  );
});

test('an indented dumpsys block ends at the next line that is not indented further', () => {
  // There are no blank lines between blocks, so indentation is the only terminator.
  const requested = readBlock(DUMP, /^\s*requested permissions:\s*$/m).lines;
  assert.strictEqual(requested.length, 6);
  assert.ok(requested.every((l) => !/^install permissions/.test(l)), 'the next header leaked into the block');
  assert.deepStrictEqual(readBlock(DUMP, /^\s*nothing like this:\s*$/m).lines, []);
});

test('a permission that was never asked about is unknown, not denied', () => {
  const perms = parseDeclaredPermissions(DUMP);
  const byId = new Map(perms.map((p) => [p.id, p.granted]));
  assert.strictEqual(byId.get('android.permission.CAMERA'), true);
  assert.strictEqual(byId.get('android.permission.ACCESS_FINE_LOCATION'), false);
  assert.strictEqual(byId.get('android.permission.INTERNET'), true, 'install-time permissions are granted');
  assert.strictEqual(
    byId.get('com.whatsapp.permission.BROADCAST'), null,
    'declared but never decided on is a third state'
  );
  assert.strictEqual(perms.length, 6, 'the three sources are merged, not concatenated');
});

test('the package dump yields the version and install history', () => {
  const info = parsePackageDump(DUMP);
  assert.strictEqual(info.found, true);
  assert.strictEqual(info.versionName, '19.14.36');
  assert.strictEqual(info.versionCode, 524288);
  assert.strictEqual(info.targetSdk, 34);
  assert.strictEqual(info.installer, 'com.android.vending');
  assert.strictEqual(info.dataDir, '/data/user/0/com.whatsapp');
  assert.deepStrictEqual(info.flags, ['HAS_CODE', 'ALLOW_CLEAR_USER_DATA', 'ALLOW_BACKUP']);
  assert.match(info.firstInstall, /^2024-01-02T/);
  assert.strictEqual(info.stopped, false);
  assert.strictEqual(parsePackageDump('Unable to find package: com.nope').found, false);
  assert.strictEqual(parsePackageDump(null).versionName, null);
});

test('permissions are grouped in a reading order, with the sensors first', () => {
  const groups = groupPermissions(parseDeclaredPermissions(DUMP));
  assert.deepStrictEqual(groups.map((g) => g.key), ['location', 'camera', 'microphone', 'network', 'system', 'other']);
  assert.strictEqual(groups[0].items[0].label, 'Location (precise)');
  assert.strictEqual(groups[0].grantedCount, 0, 'location was denied');
  assert.match(groups[0].color, /^#[0-9a-f]{6}$/);

  const summary = permissionSummary(groups);
  assert.deepStrictEqual(summary, { granted: 4, denied: 1, declared: 1, total: 6 });
  assert.deepStrictEqual(groupPermissions(null), []);
});

test('an unknown permission keeps a readable name instead of being dropped', () => {
  const info = describePermission('com.acme.permission.SECRET_SAUCE');
  assert.strictEqual(info.label, 'Secret Sauce');
  assert.strictEqual(info.group, 'other');
  assert.strictEqual(info.known, false);
  // Strings can arrive without a granted state at all.
  const groups = groupPermissions(['android.permission.CAMERA']);
  assert.strictEqual(groups[0].items[0].granted, null);
});

test('the inventory is assembled from every section at once', () => {
  const apps = buildAppList({ all: LIST_F, third: LIST_3, disabled: LIST_D, installer: LIST_I, sizes: SIZES });
  assert.strictEqual(apps.length, 5);
  assert.deepStrictEqual(apps.map((a) => a.label), [
    'Facebook Installer', 'Google Play Store', 'Myverizon', 'Settings', 'WhatsApp',
  ]);

  const wa = apps.find((a) => a.pkg === 'com.whatsapp');
  assert.strictEqual(wa.type, 'user');
  assert.strictEqual(wa.status, 'active');
  assert.strictEqual(wa.bloat, false);
  assert.strictEqual(wa.apkBytes, 61403136);
  assert.strictEqual(wa.installer, 'com.android.vending');

  const fb = apps.find((a) => a.pkg === 'com.facebook.system');
  assert.strictEqual(fb.status, 'disabled');
  assert.strictEqual(fb.bloat, true);
  assert.match(fb.bloatReason, /Facebook stub/);

  assert.strictEqual(apps.find((a) => a.pkg === 'com.vzw.hss.myverizon').type, 'carrier');
  // No stat line means unknown, not zero.
  assert.strictEqual(apps.find((a) => a.pkg === 'com.android.vending').apkBytes, null);
});

test('a debloated system app stays in the list instead of vanishing', () => {
  // `pm list packages -f` omits disabled system apps, so the disabled set has to
  // be folded back in or the app the user just froze would disappear.
  const apps = buildAppList({ all: 'package:/x/A.apk=com.a', disabled: 'package:com.gone' });
  assert.deepStrictEqual(apps.map((a) => a.pkg).sort(), ['com.a', 'com.gone']);
  assert.strictEqual(apps.find((a) => a.pkg === 'com.gone').status, 'disabled');
  assert.deepStrictEqual(buildAppList(), []);
});

test('a tab and its count can never disagree', () => {
  const apps = buildAppList({ all: LIST_F, third: LIST_3, disabled: LIST_D, installer: LIST_I, sizes: SIZES });
  const counts = countApps(apps);
  for (const key of Object.keys(counts)) {
    assert.strictEqual(filterApps(apps, { filter: key }).length, counts[key], `${key} count disagrees`);
  }
  assert.deepStrictEqual(counts, { all: 5, user: 1, system: 4, bloat: 2, disabled: 1 });
});

test('search matches the readable name as well as the package id', () => {
  const apps = buildAppList({ all: LIST_F, third: LIST_3 });
  // Nobody knows a gallery is called com.sec.android.gallery3d.
  assert.deepStrictEqual(filterApps(apps, { query: 'play store' }).map((a) => a.pkg), ['com.android.vending']);
  assert.deepStrictEqual(filterApps(apps, { query: 'vzw' }).map((a) => a.pkg), ['com.vzw.hss.myverizon']);
  assert.strictEqual(filterApps(apps, { filter: 'user', query: 'settings' }).length, 0);
  assert.strictEqual(filterApps(apps, { filter: 'nonsense' }).length, 5, 'an unknown tab falls back to all');
  assert.deepStrictEqual(filterApps(null), []);
});

test('a footprint says which rows were measured rather than summing a guess', () => {
  const app = { pkg: 'com.whatsapp', apkBytes: 61403136 };
  const detail = buildAppDetail({ app, dump: parsePackageDump(DUMP), dataBytes: null, cacheBytes: null });
  assert.strictEqual(detail.label, 'WhatsApp');
  assert.strictEqual(detail.versionName, '19.14.36');
  assert.strictEqual(detail.footprint[0].bytes, 61403136);
  assert.strictEqual(detail.footprint[0].note, null);
  assert.strictEqual(detail.footprint[1].bytes, null, 'app data is not readable without root');
  assert.match(detail.footprint[1].note, /debuggable or the device is rooted/);
  assert.strictEqual(detail.totalBytes, 61403136);
  assert.strictEqual(detail.totalComplete, false, 'a partial sum must not be presented as the total');
  assert.strictEqual(detail.permissionSummary.total, 6);

  const full = buildAppDetail({ app, dataBytes: 1000, cacheBytes: 500 });
  assert.strictEqual(full.totalBytes, 61403136 + 1500);
  assert.strictEqual(full.totalComplete, true);
  // Nothing known at all still returns a usable shape.
  assert.strictEqual(buildAppDetail().totalBytes, null);
});

test('du output becomes bytes, and a permission-denied message becomes null', () => {
  assert.strictEqual(parseDuBytes('12345\t/data/user/0/com.whatsapp'), 12345 * 1024);
  assert.strictEqual(parseDuBytes('du: /data/user/0/com.whatsapp: Permission denied'), null);
  assert.strictEqual(parseDuBytes(''), null);
});

test('only a plain .apk can be handed to adb install', () => {
  assert.strictEqual(isApkPath('C:\\Downloads\\app.apk'), true);
  assert.strictEqual(isApkPath('/tmp/bundle.apks'), true, 'a bundle is still an APK drop');
  assert.strictEqual(isInstallable('/tmp/bundle.apks'), false, 'but adb install cannot take one');
  assert.strictEqual(isInstallable('/tmp/app.APK'), true);
  assert.strictEqual(isApkPath('/tmp/notes.txt'), false);
  assert.strictEqual(isApkPath(null), false);
});

test('adb install reports failure on stdout, so the output is classified', () => {
  assert.deepStrictEqual(parseInstallResult('Performing Streamed Install\nSuccess'), {
    ok: true, code: null, message: 'Installed',
  });

  const downgrade = parseInstallResult(
    'adb: failed to install app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE: Downgrade detected]'
  );
  assert.strictEqual(downgrade.ok, false);
  assert.strictEqual(downgrade.code, 'INSTALL_FAILED_VERSION_DOWNGRADE');
  assert.match(downgrade.message, /refuses downgrades/);

  // An untranslated code is shown as-is rather than paraphrased into vagueness.
  const odd = parseInstallResult('Failure [INSTALL_FAILED_SOMETHING_NEW: what]');
  assert.strictEqual(odd.code, 'INSTALL_FAILED_SOMETHING_NEW');
  assert.strictEqual(odd.message, 'INSTALL_FAILED_SOMETHING_NEW: what');

  assert.strictEqual(parseInstallResult('').ok, false, 'no output is not success');
  assert.match(parseInstallResult('').message, /no output/);
});

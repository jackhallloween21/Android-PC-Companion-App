// ---------------------------------------------------------------------------
// Device key and status-bar commands.
//
// These go over adb rather than through scrcpy's control channel, so they work
// whether or not a mirror window has focus — which is the whole point of a
// separate control strip.
//
// Pure argv builders, so the keycodes and the shell commands are unit-tested
// without a device attached. Getting a keycode wrong is silent: `input keyevent`
// happily dispatches a valid-but-different key.
// ---------------------------------------------------------------------------

/** Android KeyEvent constants. Names match the KEYCODE_* identifiers. */
const KEYCODES = {
  back: 4,        // KEYCODE_BACK
  home: 3,        // KEYCODE_HOME
  recents: 187,   // KEYCODE_APP_SWITCH
  menu: 82,       // KEYCODE_MENU
  power: 26,      // KEYCODE_POWER
  volumeUp: 24,   // KEYCODE_VOLUME_UP
  volumeDown: 25, // KEYCODE_VOLUME_DOWN
  wake: 224,      // KEYCODE_WAKEUP
  sleep: 223,     // KEYCODE_SLEEP
};

/**
 * `cmd statusbar` is the only reliable way to pull the shade down from adb.
 * KEYCODE_NOTIFICATION does not exist and there is no keyevent for quick
 * settings, so anything keycode-based here would be a no-op.
 *
 * Requires Android 7.0+; older devices fall back to the legacy
 * `service call statusbar` transaction numbers, which differ per release and
 * are therefore not attempted.
 */
const STATUSBAR_PANELS = {
  notifications: 'expand-notifications',
  quickSettings: 'expand-settings',
  collapse: 'collapse',
};

/**
 * argv for `adb -s <serial> shell input keyevent [--longpress] <code>`.
 * @param {string} serial
 * @param {string} action  key of KEYCODES
 * @param {{longPress?: boolean}} [opts]
 */
function keyEventArgs(serial, action, opts = {}) {
  if (!serial) throw new Error('No device selected.');
  const code = KEYCODES[action];
  if (code === undefined) throw new Error(`Unknown key action: ${action}`);
  const args = ['-s', serial, 'shell', 'input', 'keyevent'];
  if (opts.longPress) args.push('--longpress');
  args.push(String(code));
  return args;
}

/**
 * argv for `adb -s <serial> shell cmd statusbar <verb>`.
 * @param {string} serial
 * @param {string} panel  key of STATUSBAR_PANELS
 */
function statusBarArgs(serial, panel) {
  if (!serial) throw new Error('No device selected.');
  const verb = STATUSBAR_PANELS[panel];
  if (!verb) throw new Error(`Unknown status bar panel: ${panel}`);
  return ['-s', serial, 'shell', 'cmd', 'statusbar', verb];
}

/**
 * Turns the failure text from `cmd statusbar` into something actionable.
 * On Android 6 and below `cmd` does not exist; on some vendor ROMs the
 * statusbar service is not exposed to shell.
 */
function describeStatusBarFailure(output) {
  const text = String(output || '').trim();
  if (/can't find service|unknown service|not found|inaccessible/i.test(text)) {
    return 'This device does not let adb open the notification shade '
      + '(needs Android 7 or newer, and some vendor ROMs block it).';
  }
  return text || 'Could not open the notification shade.';
}

module.exports = {
  KEYCODES,
  STATUSBAR_PANELS,
  keyEventArgs,
  statusBarArgs,
  describeStatusBarFailure,
};

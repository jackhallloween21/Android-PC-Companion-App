// ---------------------------------------------------------------------------
// Moving, resizing and locating the live scrcpy window (Windows).
//
// scrcpy's window belongs to another process, and Electron has no API for
// foreign windows, so a resize would otherwise mean relaunching scrcpy — a
// visible stream restart on every click of a zoom button. On Windows the window
// can instead be moved in place through user32!MoveWindow, reached via the
// PowerShell that ships with the OS rather than a native FFI dependency.
//
// The window is found by **process id**, not by title. Titles were the first
// attempt and were not reliable: scrcpy only honours --window-title on some
// builds, and a build that ignores it names the window after the device instead,
// at which point the lookup fails and every resize falls back to relaunching.
// We spawn scrcpy.exe ourselves, so its pid is something we always know.
//
// Everything here is string building, so it is unit-testable; the actual spawn
// lives in main.js. Other platforms have no equivalent that avoids a new
// dependency, so they fall back to relaunching.
// ---------------------------------------------------------------------------

/**
 * The window title we ask scrcpy for. Still exported (and still passed as a
 * secondary lookup) because a titled window is easier to find after a pid has
 * gone stale. Re-exported from src/scrcpy.js, which sets it at launch.
 */
const { mirrorWindowTitle } = require('./scrcpy');

/**
 * Shared prologue: declare the user32 entry points and resolve a window handle.
 *
 * Inputs arrive through the environment rather than being interpolated into the
 * source. That is deliberate — the title contains a device serial, PowerShell
 * escaping is unpleasant to get right, and env vars leave no injection surface.
 */
const FIND_PROLOGUE = `
$ErrorActionPreference = 'Stop'
Add-Type -Namespace Companion -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern System.IntPtr FindWindowW(string lpClassName, string lpWindowName);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool MoveWindow(System.IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool GetWindowRect(System.IntPtr hWnd, out System.Drawing.Rectangle lpRect);
'@ -ReferencedAssemblies System.Drawing
$handle = [System.IntPtr]::Zero
if ($env:COMPANION_WIN_PID) {
  $proc = Get-Process -Id ([int]$env:COMPANION_WIN_PID) -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [System.IntPtr]::Zero) { $handle = $proc.MainWindowHandle }
}
if ($handle -eq [System.IntPtr]::Zero -and $env:COMPANION_WIN_TITLE) {
  $handle = [Companion.Win]::FindWindowW($null, $env:COMPANION_WIN_TITLE)
}
if ($handle -eq [System.IntPtr]::Zero) { Write-Output 'NOTFOUND'; exit 2 }
`;

const MOVE_SCRIPT = `${FIND_PROLOGUE}
$ok = [Companion.Win]::MoveWindow(
  $handle,
  [int]$env:COMPANION_WIN_X, [int]$env:COMPANION_WIN_Y,
  [int]$env:COMPANION_WIN_W, [int]$env:COMPANION_WIN_H,
  $true)
if ($ok) { Write-Output 'OK' } else { Write-Output 'FAILED'; exit 3 }
`;

// GetWindowRect fills a RECT (left, top, right, bottom). System.Drawing.Rectangle
// has the same four-int layout but names them X/Y/Width/Height, so its Width and
// Height fields actually hold right and bottom — hence the subtraction here.
const RECT_SCRIPT = `${FIND_PROLOGUE}
$r = New-Object System.Drawing.Rectangle
$ok = [Companion.Win]::GetWindowRect($handle, [ref]$r)
if (-not $ok) { Write-Output 'FAILED'; exit 3 }
Write-Output ('RECT {0} {1} {2} {3}' -f $r.X, $r.Y, ($r.Width - $r.X), ($r.Height - $r.Y))
`;

/**
 * PowerShell's -EncodedCommand takes base64 of UTF-16LE, which sidesteps every
 * layer of cmd.exe and PowerShell quoting for the script body.
 */
function encodeCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64');
}

/** argv for the PowerShell process. */
function moveWindowArgs(script = MOVE_SCRIPT) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodeCommand(script)];
}

/**
 * Environment identifying the window to act on. Either a pid or a title will do;
 * passing both means the title covers the case where the pid has no window yet.
 * @param {{pid?:number, title?:string}} target
 */
function findWindowEnv(target = {}) {
  const { pid, title } = target;
  if (!pid && !title) throw new Error('No window to look for: pass a pid or a title.');
  const env = {};
  if (pid) env.COMPANION_WIN_PID = String(Math.round(pid));
  if (title) env.COMPANION_WIN_TITLE = String(title);
  return env;
}

/**
 * The environment the move script reads its target from.
 * @param {{pid?:number, title?:string}} target
 * @param {{x:number,y:number,width:number,height:number}} rect
 */
function moveWindowEnv(target, rect) {
  if (!rect || !rect.width || !rect.height) throw new Error('No target rectangle to move to.');
  return {
    ...findWindowEnv(typeof target === 'string' ? { title: target } : target),
    COMPANION_WIN_X: String(Math.round(rect.x)),
    COMPANION_WIN_Y: String(Math.round(rect.y)),
    COMPANION_WIN_W: String(Math.round(rect.width)),
    COMPANION_WIN_H: String(Math.round(rect.height)),
  };
}

/** Whether in-place moving is possible at all on this platform. */
function canMoveWindows(platform = process.platform) {
  return platform === 'win32';
}

/**
 * Classifies the script's output. 'notfound' is the interesting one — it means
 * the window is gone or was never titled as expected, and the caller should
 * relaunch rather than report a failure.
 */
function classifyMoveResult(output) {
  const text = String(output || '');
  if (/\bOK\b/.test(text)) return 'ok';
  if (/NOTFOUND/.test(text)) return 'notfound';
  return 'failed';
}

/**
 * Parses the rect script's output. Returns null for anything unparseable, so
 * callers treat "could not read the window" the same as "no window".
 */
function parseRectOutput(output) {
  const m = String(output || '').match(/RECT\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
  if (!m) return null;
  const [x, y, width, height] = m.slice(1, 5).map(Number);
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

module.exports = {
  FIND_PROLOGUE,
  MOVE_SCRIPT,
  RECT_SCRIPT,
  mirrorWindowTitle,
  encodeCommand,
  moveWindowArgs,
  findWindowEnv,
  moveWindowEnv,
  canMoveWindows,
  classifyMoveResult,
  parseRectOutput,
};

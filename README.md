# Android PC Companion — scaffold

Electron app for controlling Android devices from a desktop: mirroring, battery info,
file management, sideloading, app management, and bootloader unlock.

## Requirements

- Node.js 18+
- `adb` and `scrcpy` on your `PATH` (install via Android Platform Tools + scrcpy release)
- `fastboot` on your `PATH` for the bootloader tab

## Run it

```bash
npm install
npm start
```

## What's implemented

- **Device dock** — polls `adb devices -l` every few seconds, lets you pick the active device.
- **Wireless pairing** — Android 11+ pairing-code flow (`adb pair`) via a modal, plus
  `adb connect` / `adb tcpip` for the classic USB-then-wireless handoff.
- **Mirror tab** — spawns `scrcpy` as its own window. See "Upgrading mirroring" below.
- **Battery tab** — parses `adb shell dumpsys battery` into a data grid.
- **Files tab** — browse a path with `ls -la`, pull/push/delete over adb.
- **Apps tab** — list third-party packages, sideload an APK, disable/enable/uninstall.
- **Bootloader tab** — reboot to bootloader, and a generic `fastboot flashing unlock`
  with a confirmation prompt. This only works on OEMs that support the standard
  fastboot unlock flow (Pixel-style AOSP devices). Xiaomi, OnePlus, and others require
  their own account-bound unlock tool and a mandatory wait period — there's no way to
  script around that, only surface instructions for it.

## Window chrome

The window is frameless with a custom titlebar (`renderer/index.html` + the
`#titlebar` styles). Transparency/blur comes from native OS effects, set in `main.js`:

- **macOS**: `vibrancy: 'under-window'`
- **Windows 11 22H2+**: `backgroundMaterial: 'acrylic'` (falls back to plain transparent
  on older Windows)
- **Linux**: compositor support is inconsistent, so the window stays opaque
  (`#0a0e14`) there rather than risk a black window on unsupported setups.

## Architecture notes for going further

**ADB layer.** Right now everything shells out to the `adb`/`fastboot` binaries via
`child_process.execFile` (see the `run()`/`adb()`/`fastboot()` helpers at the top of
`main.js`). That's fine for an MVP but means parsing text output. When you're ready,
swap that block for a proper ADB-protocol client (e.g. `adbkit`) so you get real
device-state events (`trackDevices`) instead of polling, and streamed shell/push/pull
instead of buffered subprocess output. Nothing in the IPC handlers below it needs to
change shape.

**Bundling binaries.** For distribution, ship `adb`/`fastboot`/`scrcpy` per-platform
under `resources/<platform>/` and resolve the binary path via `process.resourcesPath`
instead of relying on the user's `PATH`.

**Upgrading mirroring.** scrcpy is a client/server pair: it pushes `scrcpy-server.jar`
to the device over adb, which opens a socket and streams H.264/H.265 video plus
accepts control packets for touch/key input. The current build spawns the `scrcpy`
CLI as a separate window. To embed the video feed directly inside this app's UI,
you'd instead talk to `scrcpy-server`'s socket yourself, decode frames with
FFmpeg/libav, and render them into a `<canvas>` — plus translate your own UI's
pointer/key events into scrcpy's control-packet format. That's a bigger lift (likely
a native addon), worth doing once the rest of the app is solid.

**Cross-platform.** Electron already gets you Windows/macOS/Linux from one codebase.
The only per-OS code is in `main.js` (window vibrancy/acrylic options) and wherever
you resolve bundled binary paths — everything else in `renderer/` is platform-neutral.

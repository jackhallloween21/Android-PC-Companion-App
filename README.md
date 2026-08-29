# Android PC Companion — scaffold

Electron app for controlling Android devices from a desktop: mirroring, battery info,
file management, sideloading, app management, and bootloader unlock.

## Requirements

- Node.js 18+
- A real desktop session (this won't run headless — see "Running in a
  container/Codespace" below) and, for USB workflows, physical USB access to
  the phone

That's it — you do **not** need to install `adb`/`fastboot`/`scrcpy` yourself.

## Run it

```bash
npm install
npm start
```

## Auto-downloaded tools

On first launch the app checks whether `adb`, `fastboot`, and `scrcpy` are
already on your `PATH`. If not, it downloads:

- **Android platform-tools** (adb + fastboot) straight from Google
  (`dl.google.com/android/repo/...`)
- **scrcpy** from its [latest GitHub release](https://github.com/Genymobile/scrcpy/releases)

into this app's user-data folder (`app.getPath('userData')/bin`) and uses
those copies from then on — no reinstalling on every launch. A setup screen
shows progress for each download. See `src/downloader.js` for the logic and
`initTools()` in `main.js` for how it's wired into startup.

If the scrcpy download fails (e.g. GitHub's release asset naming changes),
everything except the Mirror tab still works — install scrcpy yourself and
put it on your `PATH` as a fallback.

## Running in a container/Codespace

This won't work in a headless devcontainer or Codespace out of the box: it
needs a real display to render the window, and USB devices generally aren't
passed through to a remote container, so `adb`/`fastboot` can't see a
USB-connected phone. Wireless ADB (pairing over the network) can work if the
container can reach your phone's IP, but you'd still need a virtual display
(e.g. Xvfb) plus a way to view it (VNC/remote desktop) to see the mirrored
screen and interact with the UI. Simplest path: run this on your local
desktop machine.

## What's implemented

- **Device dock** — polls `adb devices -l` every few seconds, lets you pick the active device.
- **Wireless pairing** — Android 11+ pairing-code flow (`adb pair`) via a modal, plus
  `adb connect` / `adb tcpip` for the classic USB-then-wireless handoff.
- **Mirror tab** — spawns `scrcpy` as its own window. See "Upgrading mirroring" below.
- **Webcam tab** — opens a preview window of the phone's camera via scrcpy's
  `--video-source=camera`. This is only the video-capture half of "use my phone as a
  webcam" — see "Camera as a virtual webcam" below for the missing piece.
- **Audio tab** — forwards device audio to PC speakers via scrcpy
  (`--no-video --audio-source=output`), plus play/pause/next/previous using standard
  Android media keycodes over `adb shell input keyevent`, and a best-effort "now
  playing" scrape from `dumpsys media_session`.
- **Battery tab** — parses `adb shell dumpsys battery` into a data grid.
- **Files tab** — browse a path with `ls -la`, pull/push/delete over adb.
- **Apps tab** — list third-party packages, sideload an APK, disable/enable/uninstall.
- **Backup tab** — pulls shared-storage folders (DCIM, Pictures, Downloads, Music,
  Documents) and, optionally, installed APKs to a folder you choose. This is **not** a
  full system/app-data backup — Android doesn't allow reading another app's private
  data without root, and `adb backup` itself is unreliable on modern Android since most
  apps opt out via `allowBackup=false`. It only reaches what userspace adb can see.
- **Bootloader tab** — reboot to bootloader, and a generic `fastboot flashing unlock`
  with a confirmation prompt. This only works on OEMs that support the standard
  fastboot unlock flow (Pixel-style AOSP devices). Xiaomi, OnePlus, and others require
  their own account-bound unlock tool and a mandatory wait period — there's no way to
  script around that, only surface instructions for it.

## Camera as a virtual webcam — what's missing

The Webcam tab captures and displays the phone's camera feed, which is the same
video pipeline scrcpy uses for screen mirroring, just pointed at the camera instead.
What it does **not** do is register that feed as a selectable webcam device inside
other apps (Zoom, Discord, OBS, browsers) — that's what DroidCam and similar tools
actually do, and it requires a signed virtual-camera driver per OS:

- **Windows**: a DirectShow or Media Foundation virtual camera source filter —
  needs a driver, typically kernel-signed for modern Windows to load it without
  disabling driver signature enforcement.
- **macOS**: a CoreMediaIO DAL plugin/extension, which needs to be notarized to run
  without Gatekeeper warnings on current macOS.
- **Linux**: comparatively easy — the `v4l2loopback` kernel module creates a
  `/dev/videoN` device, and you can pipe scrcpy's camera output through `ffmpeg` into
  it (`ffmpeg -i <scrcpy camera stream> -f v4l2 /dev/videoN`), and it shows up in any
  app as a normal webcam.

Realistic path if you want this: build and ship the Linux `v4l2loopback` version
first since it needs no custom driver, and treat Windows/macOS as a much larger
follow-on project (or lean on an already-installed driver, e.g. piping frames into
OBS Studio's existing Virtual Camera via its WebSocket API, so users install OBS once
rather than your own unsigned driver).

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
instead of relying on the user's `PATH`. (Auto-download already handles the common
case — see above — this note is about fully offline/bundled distribution instead.)

**Audio source flag.** scrcpy's audio-source flag name has changed across versions
(`--audio-source=output` on some, `--audio-source=playback` on newer ones). If audio
forwarding fails on your scrcpy version, run `scrcpy --help` and update
`AUDIO_SOURCE` in `main.js`.

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

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
  (`dl.google.com/android/repository/...`)
- **scrcpy** from its [latest GitHub release](https://github.com/Genymobile/scrcpy/releases)

into this app's user-data folder (`app.getPath('userData')/bin`) and uses
those copies from then on — no reinstalling on every launch. A setup screen
shows progress for each download. See `src/downloader.js` for the logic and
`initTools()` in `main.js` for how it's wired into startup. Check the
**Binaries & Drivers** panel in the sidebar any time to see resolved paths
and detected versions, or force a re-check.

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

## Layout

A sidebar (not tabs) drives navigation now:

- **Dashboard** — device summary, battery ring, CPU load/memory, storage
  breakdown by folder, and quick launchers into the other sections.
- **File Explorer** — category shortcuts (Photos/Documents/Videos/Music),
  a file list, and a File Inspector panel with an image preview (for common
  image extensions), pull, and delete.
- **App Management** — filter chips (All/User/System/Disabled), search,
  sideload, and an App Diagnostics panel showing APK size, declared
  permissions (scraped from `dumpsys package`), clear-data, disable/enable,
  and uninstall.
- **Screen Mirror** — resolution/bitrate/FPS controls that map to real scrcpy
  flags, plus a transport bar (volume, long-press power, rotate, screenshot,
  record) that works over adb independently of whether the mirror window is
  open.
- **Power Tools (ADB)** — a console: quick-command buttons plus a free-text
  input that runs anything starting with `adb` or `fastboot`. See "Console
  command parsing" below for its limits.
- **Multimedia Hub** — camera preview (webcam video half) and audio
  forwarding + media transport controls, combined under one section with an
  internal toggle.
- **Hardware & Power** — a fuller battery + device-spec readout than the
  dashboard's summary cards.
- **Bootloader & Backup** — unlock/reboot-to-bootloader, a fastboot
  partition flasher (pick a partition + a local `.img`, confirm, flash), and
  the shared-storage backup flow.
- **Binaries & Drivers** (sidebar utility) — shows resolved adb/fastboot/scrcpy
  paths, detected versions, and a re-verify button.

## What's real vs. approximated

Everything above calls real `adb`/`fastboot`/`scrcpy` commands — nothing is
mocked — but a few things are best-effort approximations rather than a
polished OS-level API, and are worth knowing about before you rely on them:

- **Storage breakdown** is per-folder `du -sh` on DCIM/Pictures/Movies/Music/
  Download/Documents, not a true Apps/Photos/System partition breakdown —
  Android doesn't expose that cleanly without root.
- **CPU/memory** uses `/proc/loadavg`, `/proc/meminfo`, and a process count
  from `ps -A` — a real but coarse picture, not per-core frequency graphs.
- **Battery cycle count** comes from
  `/sys/class/power_supply/battery/cycle_count`, which isn't present on every
  device/kernel; the UI shows "N/A" when it's missing rather than a fake number.
- **Screen recording stop** sends `SIGINT` to the local `adb shell
  screenrecord` process, which is how `screenrecord` normally gets told to
  finalize the file — reliable in practice, but if the process is killed
  harder than that the resulting file can be corrupt.
- **Console command parsing** naively splits on whitespace, so arguments
  needing quotes (paths with spaces, etc.) won't parse correctly. Fine for
  the common one-liners it's meant for; not a full shell.
- **Fastboot partition flashing** is a real `fastboot flash <partition>
  <img>` — it will happily brick a device if given the wrong image for the
  wrong partition. The confirmation dialog is there for a reason.

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

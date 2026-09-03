<div align="center">

# 📱 Android PC Companion

**Control your Android device from your desktop — mirror your screen, manage files, sideload apps, monitor battery, and more.**

[![Release](https://img.shields.io/github/v/release/jackhallloween21/Android-PC-Companion-App?style=flat-square&logo=github&color=blue)](https://github.com/jackhallloween21/Android-PC-Companion-App/releases)
[![Downloads](https://img.shields.io/github/downloads/jackhallloween21/Android-PC-Companion-App/total?style=flat-square&color=brightgreen)](https://github.com/jackhallloween21/Android-PC-Companion-App/releases)
[![Platform](https://img.shields.io/badge/Platform-Windows-blue?style=flat-square&logo=windows&logoColor=white)](https://github.com/jackhallloween21/Android-PC-Companion-App/releases)
[![License: MIT](https://img.shields.io/github/license/jackhallloween21/Android-PC-Companion-App?style=flat-square&color=orange)](LICENSE)

<br>

[⬇️ **Download the latest EXE**](https://github.com/jackhallloween21/Android-PC-Companion-App/releases) · [🐛 Report an Issue](https://github.com/jackhallloween21/Android-PC-Companion-App/issues)

</div>

---

## 📖 About

Android PC Companion is a desktop app that bridges your PC and your Android phone. No bloat, no account, no root — it talks directly to your device over `adb` and `scrcpy`, and **downloads those tools automatically** on first launch. You never have to install them yourself.

> **Note:** USB debugging must be enabled on your phone (Developer Options), or you can connect wirelessly via the built-in QR pairing.

---

## 🚀 Features

### 🏠 Dashboard
Live device summary — battery ring with estimated mAh, CPU load, memory usage, storage breakdown, and quick launchers into every section.

### 📁 File Explorer
Full-featured file manager for your device storage:
- **Multi-select** files with checkboxes + batch **download** and **upload** with per-file progress
- **Drag-and-drop** upload from your PC
- **Preview** images, videos, text files, and PDFs inline
- **Breadcrumb navigation** with clickable path segments and a back arrow
- Clickable storage overview — jump straight to internal storage or SD card

### 📦 App Management
- Filter chips (**All / User / System / Disabled**) + search
- **Sideload** APKs from your PC
- **App diagnostics** — APK size, declared permissions, clear-data, disable/enable, uninstall

### 🖥️ Screen Mirror
- Real [scrcpy](https://github.com/Genymobile/scrcpy) mirroring with resolution / bitrate / FPS controls
- **Transport bar** — volume, rotate, screenshot, screen record, long-press power — works over adb even when the mirror window is closed

### 📷 Multimedia Hub
- **Camera preview** — view your phone's cameras (front/back/tele/wide) live, with sensor info
- **Capture photos** and **record video** from any camera
- **Torch control** with multi-tile flash support
- **Audio forwarding** + media transport controls (play/pause/next/prev)
- Now-playing display with track info
- **Use the phone as a PC webcam** — via OBS Virtual Camera (Windows/macOS) or v4l2 loopback (Linux); see [🎥 Use Your Phone as a Webcam](#-use-your-phone-as-a-webcam) below

### 🔋 Hardware & Power
Fuller battery + device-spec readout — health, temperature, cycle count (where the kernel exposes it), voltage, and SoC details.

### 🛠️ Power Tools (ADB Console)
Quick-command buttons plus a free-text console that runs anything starting with `adb` or `fastboot`.

### 🔓 Bootloader & Backup
- Unlock / reboot-to-bootloader
- **Fastboot partition flasher** — pick a partition, pick a `.img`, confirm, flash *(with confirmation for a reason — wrong image = brick)*
- Shared-storage backup flow

### 📡 Wireless Connection
- **QR pairing** — the app renders a QR code locally, your phone scans it, done
- **Wi-Fi pairing** with pairing code / port entry
- **Auto-connect** — previously paired phones reconnect automatically
- Multi-device switcher

---

## ⬇️ Download

Grab the latest installer from the **Releases** page:

👉 **[Download from GitHub Releases](https://github.com/jackhallloween21/Android-PC-Companion-App/releases)**

Each release ships a Windows installer (`Companion Setup x.x.x.exe`). Just run it — adb, fastboot, and scrcpy are downloaded automatically on first launch.

> The app version automatically matches the release tag (e.g. release `v1.2.3` → exe version `1.2.3`), so you always know what you're running.

---

## 📸 Screenshots

### 🏠 Dashboard — Dark, Light & Custom Themes

| Dark Overview | Theme Picker | Light Mode | Storage & Memory |
|---|---|---|---|
| ![Dashboard Dark Overview](Screenshots/01-dashboard-dark-overview.png) | ![Dashboard Theme Picker](Screenshots/02-dashboard-theme-picker.png) | ![Dashboard Light Mode](Screenshots/03-dashboard-light-mode.png) | ![Dashboard Storage](Screenshots/04-dashboard-storage-memory.png) |

*Battery station (47% charging), CPU cores at 99%, system memory 5.7/7.4 GB, storage breakdown, and the accent-color / dark-light-auto picker.*

### 📁 File Explorer

| Browse | Text Preview | Image Preview | Drag & Drop |
|---|---|---|---|
| ![File Explorer Browse](Screenshots/05-file-explorer-browse.png) | ![File Explorer Text Preview](Screenshots/06-file-explorer-text-preview.png) | ![File Explorer Image Preview](Screenshots/07-file-explorer-image-preview.png) | ![File Explorer Drag & Drop](Screenshots/08-file-explorer-drag-drop-upload.png) |

*Multi-select → batch download, breadcrumb navigation, SD card / internal storage, and inline previews for code, text, and images — drag files from Windows Explorer straight onto the device.*

### 📦 App Management

![App Management](Screenshots/09-app-management.png)

*518 packages with User / System / Bloatware / Frozen filters, search, APK sideload via drag-and-drop, and per-app diagnostics (size, permissions, freeze, uninstall).*

### 🖥️ Screen Mirror (scrcpy)

| Settings | Active Mirroring | YouTube Playback |
|---|---|---|
| ![Screen Mirror Settings](Screenshots/10-screen-mirror-settings.png) | ![Screen Mirror Active](Screenshots/11-screen-mirror-active.png) | ![Screen Mirror YouTube](Screenshots/12-screen-mirror-youtube.png) |

*Resolution / bitrate / FPS controls, docked control bar (power, volume, rotate, screenshot, record) and real device mirroring — works even when dragging the floating window around.*

### 🛠️ Power Tools — ADB / Fastboot Console

![Power Tools Console](Screenshots/13-power-tools-adb-console.png)

*One-click shortcuts (`adb devices`, `dumpsys battery`, etc.) plus a free-text shell for any `adb` / `fastboot` command.*

### 📷 Multimedia Hub — Phone as Webcam

| Standby | Live Camera Feed |
|---|---|
| ![Multimedia Hub Standby](Screenshots/14-multimedia-hub-standby.png) | ![Live Camera Feed](Screenshots/15-multimedia-hub-live-camera.png) |

*Optics & stream parameters, sensor picker (Rear 12.5 MP / Front 16.2 MP), torch & mic toggles — standby → live camera bridge with the phone as a PC webcam.*

### 🔋 Hardware & Power

![Hardware & Power](Screenshots/16-hardware-and-power.png)

*Battery power station, real-time electrical & thermal telemetry (voltage, current, temp), SoC specs (Mediatek MT6833GP, 8 cores), RAM and storage details.*

### 🔓 Bootloader & Backup

| Fastboot Flasher | Backup & Binaries |
|---|---|
| ![Bootloader Fastboot Flasher](Screenshots/17-bootloader-fastboot-flasher.png) | ![Backup and Binaries](Screenshots/18-backup-and-binaries.png) |

*Unlock suite with factory-reset warning, partition flasher (`boot` + custom `.img`), shared-storage backup and the `adb` / `fastboot` / `scrcpy` version panel (all READY).*

### 📡 Connect Device — USB, Wireless & QR

| USB Mode | Wireless Mode | QR Pairing | Switch Device |
|---|---|---|---|
| ![Connect USB](Screenshots/19-connect-usb-debugging.png) | ![Connect Wireless](Screenshots/20-connect-wireless-mode.png) | ![Connect QR](Screenshots/21-connect-qr-pairing.png) | ![Switch Device](Screenshots/22-connect-switch-device.png) |

*USB debugging guide + scan, Wi-Fi IP/port + 6-digit pairing code, QR code for Android 11+ wireless debugging, and the detected-devices switcher.*

### 🪟 Installed on Windows

![Windows Start Menu](Screenshots/23-windows-start-menu.png)

*Companion appears under "Recently added" right after installing `Companion Setup x.x.x.exe`.*

---

## 🎥 Use Your Phone as a Webcam

The Multimedia tab streams any phone camera to your PC. To make other apps (Zoom, Meet, Teams, Discord) see it as a webcam, bridge it through a virtual-camera driver. The Camera tab's bridge status tells you which route applies on your machine.

### Windows / macOS — via OBS Studio

Windows has no built-in virtual camera, so the route is [OBS Studio](https://obsproject.com/) (free, signed driver — the app detects it and reports *"OBS Virtual Camera available"*).

1. Connect your phone, open the **Multimedia** tab, pick a lens/resolution and press **Start** — a window titled `Camera — <serial>` appears. Keep it open.
2. Open OBS → **Sources** → **+** → **Window Capture** → select the `Camera — <serial>` window (crop/fit with right-click → *Transform* if needed).
3. In OBS → **Controls** (bottom-right) → **Start Virtual Camera**. First run may ask for admin to register the driver — one time only.
4. In Zoom/Meet/Teams/Discord, pick **OBS Virtual Camera** as the camera. If it doesn't appear, restart that app after step 3.

Keep OBS running while you use the camera elsewhere, and stop the stream in Companion when you're done.

### Linux — direct via v4l2 loopback (no OBS needed)

```bash
sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Camera"
```

Reopen the Camera tab — it will report *v4l2 loopback ready* with the device (e.g. `/dev/video2`). Start the stream and pick **Phone Camera** as the camera in any app. (Needs a scrcpy build with `--v4l2-sink` — distro packages have it; the tab warns you otherwise.)

> **Mic:** the camera tab's mic toggle forwards the phone mic into the stream audio (heard on PC speakers). The OBS route above carries video — for calls, pair it with your usual microphone, or use OBS's audio monitoring to route it.

---

## 🧰 Tech Stack

Built with:

| | Technology | Purpose |
|---|---|---|
| <img src="https://img.shields.io/badge/Electron-31-2B2E3A?style=flat-square&logo=electron&logoColor=9FEAF9" alt="Electron"> | [Electron](https://www.electronjs.org/) | Desktop app shell, frameless window with acrylic/vibrancy |
| <img src="https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js"> | [Node.js](https://nodejs.org/) | Main-process logic, IPC, tool orchestration |
| <img src="https://img.shields.io/badge/ADB-Fastboot-3DDC84?style=flat-square&logo=android&logoColor=white" alt="ADB"> | [ADB / Fastboot](https://developer.android.com/tools/adb) | Device communication, file transfer, shell commands |
| <img src="https://img.shields.io/badge/scrcpy-4.x-3DDC84?style=flat-square&logo=android&logoColor=white" alt="scrcpy"> | [scrcpy](https://github.com/Genymobile/scrcpy) | Screen mirroring + camera feed |
| <img src="https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript"> | Vanilla JS | Renderer — no frontend framework |
| <img src="https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white" alt="HTML5"> <img src="https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white" alt="CSS3"> | HTML + CSS | UI layout, custom window chrome |
| <img src="https://img.shields.io/badge/jsqr-1.4-000?style=flat-square" alt="jsqr"> | [jsQR](https://github.com/cozmo/jsQR) | QR code decoding (pairing flow) |
| <img src="https://img.shields.io/badge/extract--zip-2.0-000?style=flat-square" alt="extract-zip"> | [extract-zip](https://github.com/maxogden/extract-zip) | Tool extraction after download |

**Zero adb/scrcpy knowledge required** — the app auto-downloads [platform-tools](https://developer.android.com/tools/releases/platform-tools) from Google and scrcpy from its GitHub releases into its own user-data folder, and uses those copies from then on.

---

## 🚦 Getting Started (Development)

**Requirements:** Node.js 18+, a real desktop session (not headless), and for USB workflows, physical USB access to the phone.

```bash
# Clone
git clone https://github.com/jackhallloween21/Android-PC-Companion-App.git
cd Android-PC-Companion-App

# Install dependencies
npm install

# Run in dev mode
npm start

# Run the test suite
npm test

# Build the Windows installer
npm run dist
```

---

## 📂 Project Structure

```
Android-PC-Companion-App/
│
├── main.js                  # Electron main process — window, IPC handlers,
│                            #   adb/fastboot/scrcpy orchestration
├── preload.js               # Secure bridge between main & renderer (contextIsolation)
│
├── src/                     # Pure logic modules (no DOM, testable)
│   ├── apps.js              #   App inventory from pm list packages / dumpsys
│   ├── autoconnect.js       #   Remember wirelessly-paired devices
│   ├── camera.js            #   Camera capability discovery, torch, launch args
│   ├── dock.js              #   Docked-mirror window geometry
│   ├── downloader.js        #   Auto-download adb/fastboot/scrcpy
│   ├── keys.js              #   Device key & status-bar commands over adb
│   ├── media.js             #   Now-playing parsing from dumpsys media_session
│   ├── pairing.js           #   QR payload generation for wireless pairing
│   ├── perf.js              #   CPU/RAM telemetry from /proc
│   ├── power.js             #   Battery/power parsing from kernel power-supply class
│   ├── qrencode.js          #   Hand-rolled QR encoder (byte mode, v1-10)
│   ├── scrcpy.js            #   scrcpy version-aware flag detection & arg building
│   ├── storage.js           #   Storage breakdown (dumpsys diskstats + df)
│   ├── theme.js             #   Accent colors & light/dark/auto themes
│   ├── winmove.js           #   Move/resize the foreign scrcpy window (Windows)
│   └── wireless.js          #   Wireless debugging helpers (pair vs connect ports)
│
├── renderer/                # UI layer
│   ├── index.html           #   App shell — titlebar, sidebar, views, modals
│   ├── renderer.js          #   Renderer logic — state, views, event wiring
│   ├── controlbar.html      #   Mirror transport control bar
│   ├── controlbar.js        #   Transport bar logic
│   └── styles.css           #   Full styling — glass cards, dark theme
│
├── test/                    # Node test-runner suite (one file per src module)
├── tools/                   # Dev utilities (icon builder)
├── assets/                  # Bundled resources
│
└── .github/workflows/
    └── build.yml            # CI: builds the exe on release, auto-bumps version
                             #   from the release tag, attaches it to the release
```

---

## ⚙️ How It Works

Everything the app does is a real `adb` / `fastboot` / `scrcpy` invocation — nothing is mocked. The main process shells out via `child_process.execFile`, parses output with the pure modules in `src/`, and exposes it to the renderer over typed IPC channels.

**Auto-downloaded tools** — on first launch the app checks for `adb`/`fastboot`/`scrcpy` on your `PATH`. Missing ones are downloaded (platform-tools from `dl.google.com`, scrcpy from GitHub releases) into `app.getPath('userData')/bin` and reused forever. The **Binaries & Drivers** panel in the sidebar shows resolved paths, versions, and a re-verify button.

**Wireless QR pairing** — the PC displays a QR code rendered by the app's own encoder (`src/qrencode.js`, byte-mode, versions 1–10, round-trip tested); the phone scans it with Android's "Pair device with QR code" screen. The phone then advertises over mDNS (`_adb-tls-pairing._tcp`), the app runs `adb pair` against it, then connects on the separate `_adb-tls-connect._tcp` port. A manual pairing-code form is the fallback when adb's mDNS backend isn't running (common on Windows).

**Window chrome** — frameless with a custom titlebar, using native OS effects: `vibrancy` on macOS, `backgroundMaterial: 'acrylic'` on Windows 11 22H2+, opaque on Linux for compositor safety.

---

## ⚠️ Known Approximations

Honest engineering notes — real functionality, best-effort data sources:

- **Storage breakdown** is per-folder `du -sh` (DCIM/Pictures/etc.), not a true partition split — Android doesn't expose that without root
- **Battery cycle count** reads `/sys/class/power_supply/battery/cycle_count`, missing on some kernels → shows "N/A", not a fake number
- **Console command parsing** splits on whitespace — quoted args with spaces won't parse; it's for one-liners, not a full shell
- **Fastboot flashing** will brick a device given the wrong image — that's why the confirmation dialog exists
- **Camera feed** displays in-app, with a bridge-status row that routes it to other apps: OBS Virtual Camera on Windows/macOS, direct v4l2 loopback on Linux — see [🎥 Use Your Phone as a Webcam](#-use-your-phone-as-a-webcam)

---

## 🤝 Contributing

1. Fork the repo
2. Create your branch (`git checkout -b feature/amazing`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push (`git push origin feature/amazing`)
5. Open a Pull Request

Run `npm test` before submitting — the test suite covers every `src/` module.

---

## 📄 License

[MIT](LICENSE) © [jackhallloween21](https://github.com/jackhallloween21)

---

<div align="center">

**Made with** ❤️ **and lots of** `adb shell`

⭐ Star the repo if you find it useful!

</div>

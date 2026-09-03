# softcam-bridge

The native glue that turns the phone's camera into a **DirectShow virtual
webcam** on Windows, so Zoom / Meet / Teams / OBS list it directly with no
extra app to run.

It is the last hop of the pipeline built in `src/webcam.js`:

```
scrcpy --video-source=camera --record=\\.\pipe\...   (H.264 in MKV)
  -> Node named-pipe server (bytes only)
  -> ffmpeg (demux MKV, decode -> raw BGR24 on stdout)
  -> softcam-bridge.exe (stdin BGR24 -> softcam Sender API -> softcam.dll)
```

## stdin protocol

The app spawns the bridge as `softcam-bridge.exe --fps <N>` and then writes a
continuous stream of length-prefixed frames:

```
[u32le width][u32le height][ width * height * 3 bytes, BGR24 ]
```

* The size header is repeated on **every** frame. If it changes mid-stream
  (rotation, camera switch) the bridge tears down the old softcam instance and
  creates a new one at the new size.
* `--no-flip` sends frames verbatim; by default the bridge flips vertically
  (see below).

## Why it flips vertically

ffmpeg's `bgr24` output is **top-down** (first row = top of the picture).
softcam serves RGB24 through DirectShow using the Windows DIB convention, which
is **bottom-up** (first row in the buffer = bottom of the picture). Sent as-is
the picture is upside down in the consumer app, so the bridge reverses the row
order before `scSendFrame`. The colour order already matches (`bgr24` is
`B,G,R` per pixel, which is what softcam expects), so no channel swap is done.

## Building

The bridge links against `softcam.lib` and includes `softcam.h`, both emitted
when you build [tshino/softcam](https://github.com/tshino/softcam) with Visual
Studio 2022 (Release, x64). At runtime it loads `softcam.dll` from the same
folder.

**In CI (the supported path):** `.github/workflows/build.yml` checks out
softcam, builds `softcam.dll` + `softcam_installer.exe`, compiles this bridge
against the freshly built import library, and stages all three into
`assets/softcam/` before electron-builder packages the app. No local toolchain
is required.

**By hand:** open the *x64 Native Tools Command Prompt for VS 2022*, build
softcam, then:

```bat
build.bat "<softcam>\dist\inc" "<softcam>\dist\lib\x64\softcam.lib"
```

The exe is compiled with `/MT`, so it carries no VC++ redistributable
dependency of its own.

## License note

This bridge is part of the Android PC Companion app (MIT). `softcam.dll`,
`softcam.lib`, `softcam.h`, and `softcam_installer.exe` come from tshino/softcam
(built from source, not vendored here) and keep their own license. ffmpeg is
**not** bundled: the app expects a user-provided LGPL build (bundling a GPL
build would contaminate this MIT app).

// ---------------------------------------------------------------------------
// Phone camera: capability discovery, launch arguments, torch, and the
// virtual-camera ("webcam bridge") question.
//
// scrcpy can read a camera instead of the display (--video-source=camera, 2.2+)
// and will report what the sensors can actually do (--list-cameras,
// --list-camera-sizes). Those lists are the only trustworthy source for the
// resolution picker: megapixel counts from marketing material and the sizes the
// camera2 API will actually hand out are different things, and asking for a size
// the sensor does not offer makes scrcpy exit.
//
// Turning that stream into a camera other PC apps can select is a separate
// problem with no portable answer, so it is modelled explicitly rather than
// implied — see describeBridge below.
//
// Pure functions only; parsers are unit-tested against captured output.
// ---------------------------------------------------------------------------

const { pickFlag, supportsFlag } = require('./scrcpy');

const CAMERA_FLAGS = {
  videoSource: ['--video-source'],
  cameraId: ['--camera-id'],
  facing: ['--camera-facing'],
  size: ['--camera-size'],
  fps: ['--camera-fps'],
  maxFps: ['--max-fps'],
  bitrate: ['--video-bit-rate', '--bit-rate'],
  maxSize: ['--max-size'],
  aspectRatio: ['--camera-ar'],
  highSpeed: ['--camera-high-speed'],
  audioSource: ['--audio-source'],
  v4l2Sink: ['--v4l2-sink'],
  windowTitle: ['--window-title'],
  captureOrientation: ['--capture-orientation', '--orientation', '--display-orientation'],
  record: ['--record'],
  stayAwake: ['--stay-awake'],
};

/** Human labels for the facing values scrcpy reports. */
const FACING_LABELS = { back: 'Rear', front: 'Front', external: 'External' };

/**
 * Window title for camera streams. Used for docked window matching and tracking.
 */
function cameraWindowTitle(serial) {
  return `Camera — ${serial}`;
}

/**
 * Parses `scrcpy --list-cameras` and `--list-camera-sizes`.
 *
 * The format is one line per camera —
 *     --camera-id=0    (back, 4000x3000, fps=[15, 20, 24, 30])
 * optionally followed by indented size lines when sizes were requested:
 *     - 4000x3000
 *     - 1920x1080
 * and a "High speed capture" section whose sizes only work with
 * --camera-high-speed, so they are kept separate rather than mixed in.
 *
 * Log prefixes vary between builds ("[server] INFO:", "INFO:", none), so lines
 * are matched on content, not position.
 */
function parseCameraList(out) {
  const cameras = [];
  let current = null;
  let highSpeed = false;

  for (const raw of String(out || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const head = line.match(/--camera-id[= ]([^\s)]+)\s*\((.*)\)\s*$/);
    if (head) {
      const [, id, detail] = head;
      const parts = detail.split(',').map((s) => s.trim());
      const facing = (parts[0] || '').toLowerCase();
      const res = detail.match(/(\d+)\s*x\s*(\d+)/);
      const fps = (detail.match(/fps=\[([^\]]*)\]/) || [])[1];
      current = {
        id,
        facing: FACING_LABELS[facing] ? facing : (facing || 'unknown'),
        maxSize: res ? `${res[1]}x${res[2]}` : null,
        megapixels: res ? Math.round((Number(res[1]) * Number(res[2])) / 100000) / 10 : null,
        fps: fps ? fps.split(',').map((n) => Number(n.trim())).filter(Number.isFinite) : [],
        sizes: [],
        highSpeedSizes: [],
      };
      cameras.push(current);
      highSpeed = false;
      continue;
    }

    if (/high speed/i.test(line)) { highSpeed = true; continue; }

    const size = line.match(/^-\s*(\d+)\s*x\s*(\d+)/);
    if (size && current) {
      const entry = { size: `${size[1]}x${size[2]}`, width: Number(size[1]), height: Number(size[2]) };
      const fps = (line.match(/fps=\[([^\]]*)\]/) || [])[1];
      if (fps) entry.fps = fps.split(',').map((n) => Number(n.trim())).filter(Number.isFinite);
      (highSpeed ? current.highSpeedSizes : current.sizes).push(entry);
    }
  }

  // Biggest first: that is the order a resolution picker wants, and scrcpy
  // itself lists sizes in sensor order, which is not always descending.
  for (const cam of cameras) {
    const bigFirst = (a, b) => (b.width * b.height) - (a.width * a.height);
    cam.sizes.sort(bigFirst);
    cam.highSpeedSizes.sort(bigFirst);
  }
  return cameras;
}

/** "Rear 50.3 MP · 4000x3000" — one line describing a sensor to a person. */
function describeCamera(cam) {
  if (!cam) return '';
  const facing = FACING_LABELS[cam.facing] || 'Camera';
  const mp = cam.megapixels ? `${cam.megapixels} MP` : null;
  return [`${facing} (id ${cam.id})`, mp, cam.maxSize].filter(Boolean).join(' · ');
}

/**
 * argv for a camera stream.
 *
 * Every optional flag is feature-detected, and an explicit camera id wins over
 * facing: passing both is an error in scrcpy, and the id is the unambiguous one.
 *
 * @param {string} serial
 * @param {object} o
 * @param {string} [o.cameraId]
 * @param {string} [o.facing]      back | front | external
 * @param {string} [o.size]        e.g. "1920x1080"
 * @param {number} [o.fps]
 * @param {boolean} [o.highSpeed]  size came from the high-speed list
 * @param {boolean} [o.mic]        also forward the phone microphone
 * @param {string} [o.v4l2Device]  Linux: write frames to this loopback device
 * @param {?string} help
 * @param {object} [info]  scrcpyInfo { major, minor, help } for version-based detection
 */
function buildCameraArgs(serial, o = {}, help = null, info = null) {
  if (!serial) throw new Error('No device selected.');
  const source = pickFlag(help, CAMERA_FLAGS.videoSource);
  if (!source) throw new Error('This scrcpy build cannot use the camera as a video source (needs 2.2 or newer).');

  const args = ['-s', serial, `${source}=camera`];
  const push = (key, value) => {
    const flag = pickFlag(help, CAMERA_FLAGS[key]);
    if (flag) args.push(value === undefined ? flag : `${flag}=${value}`);
  };

  if (o.cameraId !== undefined && o.cameraId !== null && o.cameraId !== '') push('cameraId', o.cameraId);
  else if (o.facing) push('facing', o.facing);

  if (o.size) push('size', o.size);
  if (o.fps) push('fps', o.fps);
  if (o.maxFps) push('maxFps', o.maxFps);
  if (o.bitrate) push('bitrate', typeof o.bitrate === 'number' ? `${o.bitrate}M` : o.bitrate);
  if (o.maxSize) push('maxSize', o.maxSize);
  if (o.highSpeed) push('highSpeed');
  if (o.orientation !== undefined && o.orientation !== null) push('captureOrientation', o.orientation);
  if (o.record) push('record', o.record);
  if (o.stayAwake) push('stayAwake');

  // Audio: the mic is a genuine capture source; without it there is nothing
  // worth forwarding from a camera session, so the default is silence.
  const audioFlag = pickFlag(help, CAMERA_FLAGS.audioSource);
  if (o.mic && audioFlag && supportsMic(help, info)) args.push(`${audioFlag}=mic`);
  else if (supportsFlag(help, '--no-audio') ?? true) args.push('--no-audio');

  if (o.v4l2Device) {
    const flag = pickFlag(help, CAMERA_FLAGS.v4l2Sink);
    if (!flag) throw new Error('This scrcpy build has no --v4l2-sink, so it cannot feed a virtual camera.');
    args.push(`${flag}=${o.v4l2Device}`);
  }

  push('windowTitle', cameraWindowTitle(serial));
  return args;
}

/** Whether `--audio-source=mic` is available (scrcpy 2.2+ on Android 11+). */
function supportsMic(help, info) {
  if (!help) return true;
  // Fast path: version >= 2.2 always supports mic regardless of help parsing.
  if (info && (info.major > 2 || (info.major === 2 && info.minor >= 2))) return true;
  // scrcpy 2.x-3.x: --audio-source listed with mic option
  if (/--audio-source[^\n]*\bmic\b/i.test(help)) return true;
  const match = (help.match(/--audio-source[\s\S]{0,400}/) || [''])[0];
  if (/\b(?:possible values|values are)\b/i.test(match)) {
    return /\bmic\b/i.test(match);
  }
  if (/\bmic\b/i.test(match)) return true;
  if (/--audio-source/i.test(help) && !/--audio-source=\w+/i.test(match)) return true;
  return false;
}

/** Whether this build can write into a v4l2 loopback device at all. */
function supportsV4l2(help) {
  return pickFlag(help, CAMERA_FLAGS.v4l2Sink) !== null;
}

// ---------------------------------------------------------------------------
// Hardware encoder limits
//
// A size the *sensor* offers is not necessarily a size the *encoder* accepts,
// and the two lists are unrelated. A 2944x2944 sensor mode is perfectly real,
// but a Qualcomm AVC encoder that tops out at 4096x2176 rejects it on the height
// axis and MediaCodec.configure throws — which reaches the user as a Java stack
// trace and an immediately dead stream.
//
// The limits are declared on the device in media_codecs XML, so they can be read
// rather than guessed:
//     <Encoders>
//       <MediaCodec name="c2.qti.avc.encoder" type="video/avc">
//         <Limit name="size" min="128x128" max="4096x2176" />
//         <Limit name="alignment" value="2x2" />
// Only the <Encoders> section counts: decoders routinely support larger frames
// than the encoder can produce.
// ---------------------------------------------------------------------------

/** scrcpy's default video codec, and the one whose limits therefore apply. */
const DEFAULT_CODEC = 'video/avc';

/**
 * @param {string} xml  contents of one or more media_codecs*.xml files
 * @returns {{codecs: object, maxWidth: ?number, maxHeight: ?number}}
 */
function parseEncoderLimits(xml) {
  const text = String(xml || '');
  const codecs = {};

  // Several files may be concatenated, so every <Encoders> block is considered.
  const blocks = text.match(/<Encoders>[\s\S]*?<\/Encoders>/g) || [];
  for (const block of blocks) {
    for (const entry of block.split(/<MediaCodec\b/).slice(1)) {
      const type = (entry.match(/type\s*=\s*"([^"]+)"/) || [])[1];
      if (!type || !/^video\//i.test(type)) continue;
      // Stop at the end of this MediaCodec element so limits are not stolen from
      // the next one when a file omits the closing tag we split on.
      const body = entry.split(/<\/MediaCodec>/)[0];
      const size = body.match(/<Limit\s+name\s*=\s*"size"[^>]*max\s*=\s*"(\d+)x(\d+)"/i);
      if (!size) continue;
      const width = Number(size[1]);
      const height = Number(size[2]);
      const align = body.match(/<Limit\s+name\s*=\s*"alignment"[^>]*value\s*=\s*"(\d+)x(\d+)"/i);
      const key = type.toLowerCase();
      const prev = codecs[key];
      // Keep the most capable encoder for the type; a device can list several.
      if (!prev || (width * height) > (prev.maxWidth * prev.maxHeight)) {
        codecs[key] = {
          maxWidth: width,
          maxHeight: height,
          alignment: align ? { width: Number(align[1]), height: Number(align[2]) } : null,
        };
      }
    }
  }

  const preferred = codecs[DEFAULT_CODEC]
    || Object.values(codecs).sort((a, b) => (b.maxWidth * b.maxHeight) - (a.maxWidth * a.maxHeight))[0];
  return {
    codecs,
    maxWidth: preferred ? preferred.maxWidth : null,
    maxHeight: preferred ? preferred.maxHeight : null,
  };
}

/**
 * Whether the encoder can take this size.
 *
 * Both orientations are allowed: scrcpy hands the encoder the frame as the
 * sensor produces it, and a limit of 4096x2176 accepts a 2176x4096 portrait
 * frame on hardware that reports rotation support. Unknown limits return true —
 * refusing every size because a file could not be read would be worse than
 * letting the device answer for itself.
 */
function sizeFitsEncoder(size, limits) {
  if (!limits || !limits.maxWidth || !limits.maxHeight) return true;
  const m = String(size || '').match(/^(\d+)x(\d+)$/);
  if (!m) return true;
  const w = Number(m[1]);
  const h = Number(m[2]);
  const { maxWidth: mw, maxHeight: mh } = limits;
  const fits = (a, b) => a <= mw && b <= mh;
  return fits(w, h) || fits(h, w);
}

/** Annotates each size with whether the encoder will accept it. */
function annotateSizes(sizes, limits) {
  return (sizes || []).map((s) => ({ ...s, encodable: sizeFitsEncoder(s.size, limits) }));
}

/**
 * Turns a dead camera stream into something actionable.
 *
 * scrcpy surfaces an encoder rejection as a Java stack trace from
 * MediaCodec.configure, which tells the user nothing. The size that was asked
 * for and the limit that was read are what they need.
 */
function describeCameraFailure(log, o = {}) {
  const text = String(log || '');
  const { size, limits } = o;
  const limitText = limits && limits.maxWidth
    ? `This phone's hardware encoder accepts up to ${limits.maxWidth}x${limits.maxHeight}.`
    : 'The size is larger than this phone\'s hardware encoder accepts.';

  if (/MediaCodec\.configure|IllegalArgumentException|ConfigureFailed/i.test(text)) {
    return [
      size
        ? `The hardware encoder refused ${size}, so the stream could not start.`
        : 'The hardware encoder refused that capture size, so the stream could not start.',
      limitText,
      'The sensor can produce this size, but the encoder that has to compress it cannot — pick a smaller resolution.',
    ].join(' ');
  }
  if (/Demuxer error/i.test(text)) {
    return 'The video stream ended immediately. This is usually the hardware encoder refusing the capture size — try a smaller resolution.';
  }
  if (/Camera access|CameraAccessException|camera is in use|in use by another/i.test(text)) {
    return 'The camera is already in use — close the phone\'s camera app (and any other stream) and try again.';
  }
  if (/--camera-size|Invalid camera size|not available/i.test(text)) {
    return 'This phone rejected that capture size. Press Detect cameras again and pick one from the list.';
  }
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join('\n')
    || 'The camera stream stopped without saying why.';
}

// ---------------------------------------------------------------------------
// Torch
// ---------------------------------------------------------------------------

/**
 * Toggling the flashlight has no adb command of its own: the camera2 torch API
 * is not exposed to the shell. The one route that works on stock Android 11+ is
 * clicking the quick-settings tile, which is a real toggle rather than a
 * settable state — so callers must treat this as "toggle", not "turn on".
 */
const TORCH_TILES = [
  'com.android.systemui/.qs.tiles.FlashlightTile',
  'com.android.systemui/com.android.systemui.qs.tiles.FlashlightTile',
  'com.android.systemui/.qs.tiles.LanternTile',
  'com.android.systemui/com.android.systemui.qs.tiles.LanternTile',
];

function torchArgs(serial, tile = TORCH_TILES[0]) {
  if (!serial) throw new Error('No device selected.');
  return ['-s', serial, 'shell', 'cmd', 'statusbar', 'click-tile', tile];
}

/** Alternative: toggle torch via settings + am broadcast fallback. */
function torchFallbackArgs(serial) {
  if (!serial) throw new Error('No device selected.');
  return ['-s', serial, 'shell', 'cmd', 'statusbar', 'expand-settings'];
}

/** `settings get secure sysui_qs_tiles` → the tile specs the shade actually has. */
function parseQsTiles(out) {
  const text = String(out || '').trim();
  if (!text || /^null$/i.test(text)) return [];
  return text.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/** Whether a flashlight tile exists at all — if not, click-tile cannot work. */
function hasTorchTile(specs) {
  return (specs || []).some((s) => /flash|torch/i.test(s));
}

/**
 * Torch state read back from `dumpsys media.camera`, or null when this build
 * does not report it.
 *
 * Read-back matters because `cmd statusbar click-tile` prints nothing whether it
 * toggled a tile or silently did nothing, so without this the UI would have to
 * claim success it cannot verify. Several shapes are accepted because the line
 * differs between Android versions and vendor camera services; anything
 * unrecognised returns null rather than a guess.
 */
function parseTorchStatus(out) {
  const text = String(out || '');
  const m = text.match(/torch\s*(?:mode\s*)?status[^\n]*?[:=]\s*"?(\w+)"?/i);
  if (!m) return null;
  const value = m[1].toLowerCase();
  if (/^(on|available_on|1|true)$/.test(value)) return 'on';
  if (/^(off|available_off|0|false)$/.test(value)) return 'off';
  return null;
}

/** Plain-English reason a torch toggle failed, from the shell's own output. */
function describeTorchFailure(output) {
  const text = String(output || '').trim();
  if (/click-tile|unknown command|Unknown command/i.test(text)) {
    return 'This Android version has no "click-tile" command, so the flashlight cannot be toggled over adb (needs Android 11 or newer).';
  }
  if (/can't find service|unknown service|inaccessible|SecurityException|permission/i.test(text)) {
    return 'This ROM blocks adb from touching quick-settings tiles, so the flashlight cannot be toggled from here.';
  }
  if (/not found|no such tile|Invalid tile/i.test(text)) {
    return 'This device does not expose a flashlight quick-settings tile under the standard name.';
  }
  return text || 'Could not toggle the flashlight.';
}

// ---------------------------------------------------------------------------
// Virtual camera ("use this as a webcam in other apps")
// ---------------------------------------------------------------------------

/**
 * What it would take, on this machine, for other applications to select the
 * phone as a camera. Deliberately explicit about the three states rather than
 * showing a status light that is always green:
 *
 *  - 'v4l2'      Linux with a loopback device: scrcpy writes frames straight
 *                into it and every app sees a real camera. Fully supported.
 *  - 'obs'       Windows/macOS with OBS installed: OBS's virtual camera is the
 *                only widely available signed driver, and it has to capture the
 *                scrcpy window. Works, but needs OBS running.
 *  - 'none'      No route available without installing something.
 *
 * @param {{platform?:string, help?:?string, v4l2Devices?:string[], obsInstalled?:boolean}} env
 */
function describeBridge(env = {}) {
  const { platform = process.platform, help = null, v4l2Devices = [], obsInstalled = false } = env;

  if (platform === 'linux') {
    if (!supportsV4l2(help)) {
      return {
        mode: 'none',
        ready: false,
        label: 'No v4l2 support in this scrcpy build',
        hint: 'This scrcpy was built without --v4l2-sink. Install the distribution package (scrcpy with v4l2 support) to feed a virtual camera.',
      };
    }
    if (!v4l2Devices.length) {
      return {
        mode: 'v4l2',
        ready: false,
        label: 'v4l2loopback not loaded',
        hint: 'Load the loopback module, then reopen this tab: sudo modprobe v4l2loopback exclusive_caps=1 card_label="Phone Camera"',
      };
    }
    return {
      mode: 'v4l2',
      ready: true,
      devices: v4l2Devices,
      label: `v4l2 loopback ready (${v4l2Devices[0]})`,
      hint: `Start the stream, then pick "Phone Camera" (${v4l2Devices[0]}) as the camera in any app.`,
    };
  }

  if (obsInstalled) {
    return {
      mode: 'obs',
      ready: true,
      label: 'OBS Virtual Camera available',
      hint: 'Start the camera stream, then in OBS add a Window Capture of the "Camera — <serial>" window and press Start Virtual Camera. Other apps will then list "OBS Virtual Camera".',
    };
  }

  return {
    mode: 'none',
    ready: false,
    label: platform === 'win32' ? 'No virtual camera driver found' : 'No virtual camera route found',
    hint: platform === 'win32'
      ? 'Windows has no built-in virtual camera. Install OBS Studio (its Virtual Camera is a signed DirectShow driver), then capture the camera window with it. The preview window below works either way.'
      : 'Install OBS Studio and use its Virtual Camera to expose this stream to other apps. The preview window below works either way.',
  };
}

module.exports = {
  CAMERA_FLAGS,
  FACING_LABELS,
  TORCH_TILES,
  DEFAULT_CODEC,
  cameraWindowTitle,
  parseCameraList,
  describeCamera,
  buildCameraArgs,
  supportsMic,
  supportsV4l2,
  parseEncoderLimits,
  sizeFitsEncoder,
  annotateSizes,
  describeCameraFailure,
  torchArgs,
  parseQsTiles,
  hasTorchTile,
  parseTorchStatus,
  describeTorchFailure,
  describeBridge,
};

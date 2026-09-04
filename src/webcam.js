// ---------------------------------------------------------------------------
// Phone camera -> DirectShow virtual webcam (Windows, tshino/softcam).
//
// Pipeline:
//   scrcpy --video-source=camera --no-window --record=<named pipe> (mkv)
//     -> Node named-pipe server (bytes only, no parsing)
//     -> ffmpeg (demux mkv, decode h264 -> raw bgr24 frames on stdout)
//     -> softcam-bridge.exe (stdin BGR24 frames -> softcam.dll virtual cam)
//
// Why a named pipe and not `--record=-`: scrcpy hands its filename to
// libavformat's `file:` protocol, which has no "- means stdout" convention
// (that lives in the ffmpeg CLI, not the library), so `-` would create a
// literal file called `-`. Verified 2026-09-03: `--record=-` wrote ./`-`,
// while `--record=\\.\pipe\name` streamed a healthy 7s MKV (video DTS 0).
//
// Why --no-audio: softcam carries video only. Capturing mic audio would burn
// encoder + bandwidth for a stream nothing consumes; the phone mic stays
// available through the app's separate audio forwarding.
//
// Why --camera-fps and not --max-fps: --max-fps caps display mirroring;
// camera capture rate is --camera-fps (verified in scrcpy 4.1 --help).
//
// Pure builder functions are unit-tested (test/webcam.test.js); only
// startWebcamBridge touches processes.
// ---------------------------------------------------------------------------

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { pickFlag } = require('./scrcpy');

/** Candidate spellings, newest first, for each webcam-pipeline option. */
const WEBCAM_FLAGS = {
  videoSource: ['--video-source'],
  noWindow: ['--no-window'],
  noControl: ['--no-control'],
  noAudio: ['--no-audio'],
  record: ['--record'],
  recordFormat: ['--record-format'],
  videoBitrate: ['--video-bit-rate', '--bit-rate'],
  cameraFacing: ['--camera-facing'],
  cameraId: ['--camera-id'],
  cameraSize: ['--camera-size'],
  cameraFps: ['--camera-fps'],
};

/**
 * Headless camera-only scrcpy argv recording into a pipe (or file).
 * `help` is the probed `scrcpy --help` text; with none, modern spellings are
 * assumed (same fallback convention as src/scrcpy.js).
 */
function buildScrcpyCameraArgs(serial, o = {}, help = null) {
  if (!serial) throw new Error('No device selected.');
  const flag = (key) => pickFlag(help, WEBCAM_FLAGS[key]);
  const args = ['-s', serial];
  const push = (key, value) => {
    const f = flag(key);
    if (f) args.push(value === undefined ? f : `${f}=${value}`);
  };
  const source = flag('videoSource');
  if (!source) throw new Error('This scrcpy build cannot use the camera as a video source (needs 2.2 or newer).');
  args.push(`${source}=camera`);
  push('noWindow');
  push('noControl');
  push('noAudio');
  if (o.cameraId !== undefined && o.cameraId !== null && o.cameraId !== '') push('cameraId', o.cameraId);
  else if (o.facing) push('cameraFacing', o.facing);
  if (o.size) push('cameraSize', o.size);
  if (o.fps) push('cameraFps', o.fps);
  push('videoBitrate', `${o.bitrate || 8}M`);
  if (!o.recordTarget) throw new Error('A record target (named pipe or file) is required.');
  push('record', o.recordTarget);
  push('recordFormat', 'mkv');
  return args;
}

/**
 * ffmpeg: demux mkv from stdin, emit raw bgr24 frames on stdout.
 *
 * Tuned for LIVE latency, not archival fidelity. The one change from a plain
 * transcode is `-vsync 0` (frame passthrough): emit each decoded frame as-is
 * instead of buffering to regulate a constant output rate (the default with a
 * `-r` target). Forcing CFR is what let latency creep upward over a long
 * session -- every hiccup added a frame to ffmpeg's rate-conversion queue that
 * never drained. softcam always serves the newest frame anyway, so a steady
 * wall-clock cadence out of ffmpeg buys nothing here. `fps` is still validated
 * (the bridge is told the declared rate via --fps) but no longer pins output.
 *
 * Deliberately conservative on decode flags: `-fflags nobuffer` / `-flags
 * low_delay` were tried and destabilised this exact pipeline (ffmpeg faulted
 * mid-stream, Windows exit 3221225477 = access violation), so they are left
 * off. `-vsync 0` uses the portable spelling, not `-fps_mode` (ffmpeg >= 5.1
 * only), so 4.x builds keep working.
 */
function buildFfmpegArgs({ width, height, fps }) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`Invalid frame size ${width}x${height}.`);
  }
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error(`Invalid fps ${fps}.`);
  return [
    '-hide_banner', '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-vf', `scale=${width}:${height}`,
    '-vsync', '0',
    '-f', 'rawvideo',
    '-pix_fmt', 'bgr24',
    'pipe:1',
  ];
}

/** Length-prefixed BGR24 frame header the bridge expects (u32le w, u32le h). */
function frameHeader(width, height) {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(width, 0);
  buf.writeUInt32LE(height, 4);
  return buf;
}

/**
 * Splits an ffmpeg rawvideo byte stream into complete frames. Returns any
 * full frames decoded from this chunk plus the leftover carry. Frames are
 * COPIED out: holding subarrays would pin every parent chunk for the life of
 * the stream and grow memory without bound on a long-running webcam.
 */
function createFrameSplitter(frameBytes) {
  if (!Number.isInteger(frameBytes) || frameBytes <= 0) throw new Error('frameBytes must be positive.');
  let carry = Buffer.alloc(0);
  return {
    push(chunk) {
      if (!chunk || !chunk.length) return [];
      carry = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const frames = [];
      while (carry.length >= frameBytes) {
        frames.push(Buffer.from(carry.subarray(0, frameBytes)));
        carry = carry.subarray(frameBytes);
      }
      // Keep the carry small: it is at most one partial frame by construction,
      // but copy it so the consumed parent can still be collected.
      if (carry.length) carry = Buffer.from(carry);
      return frames;
    },
    pendingBytes() { return carry.length; },
  };
}

let pipeCounter = 0;

/** Unique Windows named-pipe path for one bridge run. */
function createPipeName() {
  pipeCounter = (pipeCounter + 1) % 100000;
  return `\\\\.\\pipe\\apc-webcam-${process.pid}-${pipeCounter}`;
}

/**
 * First existing candidate wins: bundled resources, user-data bin, PATH.
 * Returns null when nothing is installed — callers turn that into an error
 * naming the binary and where it was looked for.
 */
function resolveWebcamBin(name, dirs) {
  for (const dir of dirs || []) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Starts the phone-camera -> virtual-webcam pipeline.
 *
 * @param {Object} params
 * @param {string} params.serial device serial
 * @param {string} params.scrcpyPath resolved scrcpy binary
 * @param {string} params.ffmpegPath resolved ffmpeg binary (LGPL build)
 * @param {string} params.bridgePath resolved softcam-bridge.exe
 * @param {string} [params.cameraId] e.g. "0" (mutually exclusive with facing)
 * @param {string} [params.facing] back | front | external
 * @param {{width:number,height:number}} [params.size]
 * @param {number} [params.fps]
 * @param {number} [params.bitrate] Mbps
 * @param {string} [params.help] probed `scrcpy --help` text for flag detection
 * @param {(msg:string)=>void} [params.onLog]
 * @param {(info:{code:number|null,origin:string})=>void} [params.onExit]
 * @returns {{stop:()=>void, running:boolean, pipePath:string}}
 */
function startWebcamBridge({
  serial,
  scrcpyPath,
  ffmpegPath,
  bridgePath,
  cameraId,
  facing,
  size = { width: 1280, height: 720 },
  fps = 30,
  bitrate = 8,
  help = null,
  onLog = () => {},
  onExit = () => {},
}) {
  for (const [label, p] of [['scrcpy', scrcpyPath], ['ffmpeg', ffmpegPath], ['softcam-bridge', bridgePath]]) {
    if (!p || !fs.existsSync(p)) throw new Error(`${label} binary not found${p ? `: ${p}` : ''}.`);
  }
  const width = Number(size && size.width);
  const height = Number(size && size.height);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('A valid frame size is required.');
  }
  const frameBytes = width * height * 3;
  if (!Number.isSafeInteger(frameBytes)) throw new Error('Frame size overflows.');
  const header = frameHeader(width, height);
  const pipePath = createPipeName();

  const scrcpyArgs = buildScrcpyCameraArgs(serial, {
    cameraId, facing, size: `${width}x${height}`, fps, bitrate, recordTarget: pipePath,
  }, help);
  const ffmpegArgs = buildFfmpegArgs({ width, height, fps });

  let running = true;
  let stopping = false;
  const procs = [];
  const sockets = new Set();
  const splitter = createFrameSplitter(frameBytes);
  const pending = []; // frames waiting on bridge backpressure
  // Live stream: never let a backlog build. If the bridge applies backpressure
  // we hold at most a couple of frames and always favour the freshest, so a
  // momentary stall costs a dropped frame or two, never accumulating latency
  // (the old 120-frame cap could sit on ~4s of stale video before shedding).
  const MAX_PENDING = 2;
  let dropped = 0;
  let server = null;
  // Liveness stats: the bridge keeps serving its last frame to DirectShow
  // clients after the feeder dies, so "running" alone cannot tell a live
  // picture from a frozen one. Frames + byte counters let callers detect a
  // stall (e.g. the phone encoder wedged with all processes still alive).
  const startedAt = Date.now();
  let framesSent = 0;
  let firstFrameAt = 0;
  let lastFrameAt = 0;
  let bytesForwarded = 0;

  function log(msg) { try { onLog(String(msg)); } catch { /* logging never breaks the pipe */ } }
  function finish(origin, code) {
    if (!running) return;
    try { onExit({ code: code ?? null, origin }); } catch { /* ignore */ }
    stop();
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    running = false;
    for (const s of [...sockets]) { try { s.destroy(); } catch {} }
    sockets.clear();
    try { if (server) server.close(); } catch {}
    server = null;
    for (const p of procs) { try { p.kill(); } catch {} }
  }

  // Header + frame travel as ONE packet: two write() calls could split across
  // a backpressure boundary and desync the bridge's length-prefixed protocol.
  // The single copy this costs (~2.7 MB at 720p) is negligible next to decode.
  function packFrame(frame) {
    const packet = Buffer.allocUnsafe(header.length + frame.length);
    header.copy(packet, 0);
    frame.copy(packet, header.length);
    return packet;
  }

  function pumpBridge() {
    const sink = bridgeProc && bridgeProc.stdin && bridgeProc.stdin.writable ? bridgeProc.stdin : null;
    if (!sink) return;
    while (pending.length) {
      if (sink.write(pending[0]) === false) return; // wait for drain
      pending.shift();
    }
  }

  function onFrame(frame) {
    const sink = bridgeProc && bridgeProc.stdin && bridgeProc.stdin.writable ? bridgeProc.stdin : null;
    if (!sink) return;
    const now = Date.now();
    if (!firstFrameAt) firstFrameAt = now;
    lastFrameAt = now;
    framesSent += 1;
    const packet = packFrame(frame);
    if (pending.length) {
      // Still draining: queue behind, dropping oldest past the cap rather
      // than delaying the live picture indefinitely.
      pending.push(packet);
      if (pending.length > MAX_PENDING) { pending.shift(); dropped += 1; }
      if (dropped === 1 || dropped % 300 === 0) log(`bridge backpressure: dropped ${dropped} frames total`);
      return;
    }
    if (sink.write(packet) === false) {
      pending.push(packet);
    }
  }

  let bridgeProc = null;
  let ffmpegProc = null;

  // The pipe server must listen before scrcpy starts, or its open fails.
  server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', (err) => log(`pipe socket error: ${err.message}`));
    sock.on('close', () => sockets.delete(sock));
    // Bytes flow scrcpy -> ffmpeg; the server itself only forwards them.
    // Count them: bytes flowing with zero decoded frames means ffmpeg (not
    // scrcpy) is the stuck stage; zero bytes means scrcpy/phone is silent.
    sock.on('data', (chunk) => { bytesForwarded += chunk.length; });
    sock.pipe(ffmpegProc.stdin, { end: false });
    sock.on('end', () => { /* scrcpy closed its end; ffmpeg drains what it has */ });
  });
  server.on('error', (err) => { log(`pipe server error: ${err.message}`); finish('pipe', null); });

  let scrcpyProc = null;
  try {
    server.listen(pipePath, () => {
      // The listen callback fires async: an earlier failure may have stopped
      // the pipeline meanwhile, in which case there is nothing to spawn into.
      if (!running || stopping) return;
      try {
        scrcpyProc = spawn(scrcpyPath, scrcpyArgs, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } catch (err) {
        log(`scrcpy spawn failed: ${err.message}`);
        finish('scrcpy', null);
        return;
      }
      procs.push(scrcpyProc);
      scrcpyProc.on('error', (err) => { log(`scrcpy error: ${err.message}`); finish('scrcpy', null); });
      scrcpyProc.stderr.on('data', (d) => log(`[scrcpy] ${d}`));
      scrcpyProc.stderr.on('error', () => {});
      scrcpyProc.on('exit', (code) => { if (!stopping) { log(`scrcpy exited (${code})`); finish('scrcpy', code); } });
    });
  } catch (err) {
    stop();
    throw new Error(`Could not listen on ${pipePath}: ${err.message}`);
  }

  try {
    ffmpegProc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    stop();
    throw new Error(`Could not start ffmpeg: ${err.message}`);
  }
  procs.push(ffmpegProc);

  try {
    bridgeProc = spawn(bridgePath, ['--fps', String(fps)], { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  } catch (err) {
    stop();
    throw new Error(`Could not start softcam-bridge: ${err.message}`);
  }
  procs.push(bridgeProc);

  ffmpegProc.on('error', (err) => { log(`ffmpeg error: ${err.message}`); finish('ffmpeg', null); });
  ffmpegProc.stderr.on('data', (d) => log(`[ffmpeg] ${d}`));
  ffmpegProc.stderr.on('error', () => {});
  ffmpegProc.stdin.on('error', (err) => log(`ffmpeg stdin: ${err.message}`));
  ffmpegProc.stdout.on('data', (chunk) => {
    for (const frame of splitter.push(chunk)) onFrame(frame);
  });
  ffmpegProc.stdout.on('error', () => {});
  ffmpegProc.on('exit', (code) => { if (!stopping) { log(`ffmpeg exited (${code})`); finish('ffmpeg', code); } });

  bridgeProc.on('error', (err) => { log(`softcam-bridge error: ${err.message}`); finish('bridge', null); });
  bridgeProc.stderr.on('data', (d) => log(`[softcam-bridge] ${d}`));
  bridgeProc.stderr.on('error', () => {});
  bridgeProc.stdin.on('error', (err) => log(`bridge stdin: ${err.message}`));
  bridgeProc.stdin.on('drain', pumpBridge);
  bridgeProc.on('exit', (code) => { if (!stopping) { log(`softcam-bridge exited (${code})`); finish('bridge', code); } });

  return {
    stop,
    get running() { return running; },
    get pipePath() { return pipePath; },
    get startedAt() { return startedAt; },
    get framesSent() { return framesSent; },
    get firstFrameAt() { return firstFrameAt; },
    get lastFrameAt() { return lastFrameAt; },
    get droppedFrames() { return dropped; },
    get bytesForwarded() { return bytesForwarded; },
  };
}

module.exports = {
  WEBCAM_FLAGS,
  buildScrcpyCameraArgs,
  buildFfmpegArgs,
  frameHeader,
  createFrameSplitter,
  createPipeName,
  resolveWebcamBin,
  startWebcamBridge,
};

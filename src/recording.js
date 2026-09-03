// ---------------------------------------------------------------------------
// Camera recording finalization checks.
//
// scrcpy's recorder finalizes the container only on a clean shutdown: MP4 gets
// its moov index written last, Matroska stays playable because it is a
// streaming format. A hard-killed recorder leaves video bytes with no index —
// a file that exists but no player will open. These pure checks let the main
// process verify a recording before handing the path back to the UI, so a dead
// file is reported as an error instead of a "saved" video.
//
// Pure functions only, so the container logic is unit-testable with synthetic
// buffers instead of real recordings.
// ---------------------------------------------------------------------------

/** Grace window for scrcpy to flush the encoder + trailer after the close signal. */
const RECORD_STOP_TIMEOUT_MS = 6000;
/** Extra settle after process exit before the file is inspected. */
const RECORD_FLUSH_SETTLE_MS = 800;
/** Below this a container cannot hold a real recording. */
const RECORD_MIN_BYTES = 1024;
/** How much of the file tail is scanned for the MP4 index. */
const RECORD_TAIL_SCAN_BYTES = 256 * 1024;

/** First box of every MP4 scrcpy writes: size + 'ftyp' in the first bytes. */
function hasFtypBox(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  return buf.length >= 12
    && buf.subarray(4, 8).toString('ascii') === 'ftyp';
}

/**
 * The MP4 index. scrcpy writes it last, on clean shutdown, so its absence
 * means the recorder died mid-stream and no player will open the file.
 */
function hasMoovBox(tail) {
  const buf = Buffer.isBuffer(tail) ? tail : Buffer.from(tail || []);
  return buf.includes('moov');
}

/** Matroska / WebM magic: EBML header `0x1A45DFA3` at offset 0. */
function hasEbmlHeader(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  return buf.length >= 4
    && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
}

/** EBML element id at pos, or null when out of bounds / malformed. */
function readEbmlId(buf, pos) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  if (first < 0x10) return null;
  const len = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : 4;
  if (pos + len > buf.length) return null;
  let val = 0;
  for (let i = 0; i < len; i += 1) val = val * 256 + buf[pos + i];
  return { len, val };
}

/** EBML data size (vint) at pos, or null when out of bounds. */
function readEbmlSize(buf, pos) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { len += 1; mask >>= 1; }
  if (len > 8 || pos + len > buf.length) return null;
  let val = first & (mask - 1);
  for (let i = 1; i < len; i += 1) val = val * 256 + buf[pos + i];
  return { len, val };
}

/**
 * Iterates direct children in [start, end). A child clipped by the buffer end
 * (inevitable: libavformat patches a multi-MB Segment size at close, so any
 * file head clips it) is still descended into over its visible part — the Info
 * block always sits up front — but iteration stops afterwards, since the next
 * sibling's offset is unknowable. Unknown-size elements run to end.
 */
function eachEbmlChild(buf, start, end, cb) {
  let pos = start;
  while (pos < end) {
    const id = readEbmlId(buf, pos);
    if (!id) return;
    const size = readEbmlSize(buf, pos + id.len);
    if (!size) return;
    const hlen = id.len + size.len;
    const unknown = size.val === 2 ** (7 * size.len) - 1;
    const fullEnd = pos + hlen + size.val;
    const clipped = !unknown && fullEnd > end;
    const dend = unknown ? end : Math.min(fullEnd, end);
    if (dend < pos + hlen) return;
    cb(id.val, pos + hlen, dend, pos);
    if (clipped) return;
    pos = dend;
  }
}

/**
 * Segment Duration in milliseconds, or null. libavformat writes it only when
 * the file is closed cleanly, so its absence is the signature of a killed
 * recorder: clusters are present (the file "opens") but there is no duration
 * and no seek index, which players show with a bogus length and frozen seeking.
 * `head` must cover the file start (Info sits within the first bytes).
 */
function findMkvDuration(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  let durationMs = null;
  eachEbmlChild(buf, 0, buf.length, (id, start, end) => {
    if (id !== 0x18538067) return; // Segment
    eachEbmlChild(buf, start, end, (cid, cstart, cend) => {
      if (cid !== 0x1549A966) return; // Info
      let scale = 1000000;
      let dur = null;
      eachEbmlChild(buf, cstart, cend, (iid, istart, iend) => {
        const raw = buf.subarray(istart, iend);
        if (iid === 0x2AD7B1 && raw.length > 0) { // TimestampScale
          let v = 0;
          for (const b of raw) v = v * 256 + b;
          if (v > 0) scale = v;
        } else if (iid === 0x4489 && (raw.length === 4 || raw.length === 8)) { // Duration
          dur = raw.length === 4 ? raw.readFloatBE(0) : raw.readDoubleBE(0);
        }
      });
      if (Number.isFinite(dur) && dur > 0) durationMs = (dur * scale) / 1000000;
    });
  });
  return durationMs;
}

/**
 * Whether a finished recording is playable. `head` is the first bytes of the
 * file, `tail` the last bytes (up to RECORD_TAIL_SCAN_BYTES), `size` the file
 * length, `ext` the chosen container (scrcpy muxes by extension).
 */
function assessRecording({ head, tail, size, ext }) {
  if (!Number.isFinite(size) || size < RECORD_MIN_BYTES) {
    return { ok: false, reason: 'file is empty' };
  }
  const container = String(ext || '').toLowerCase();
  if (container === '.mkv' || container === '.webm') {
    if (!hasEbmlHeader(head)) return { ok: false, reason: 'not a valid video file' };
    if (findMkvDuration(head) === null) {
      return { ok: false, reason: 'video index was never written (recorder did not shut down cleanly)' };
    }
    const skew = findMkvStartSkew(head);
    if (skew !== null && skew > TIMELINE_SKEW_THRESHOLD_MS) {
      return { ok: false, reason: `audio and video start ${Math.round(skew / 1000)}s apart (camera timestamps skewed)` };
    }
    return { ok: true, reason: null };
  }
  if (container === '.mp4' || container === '.m4v' || container === '.mov') {
    if (!hasFtypBox(head)) return { ok: false, reason: 'not a valid video file' };
    if (!hasMoovBox(tail)) {
      return { ok: false, reason: 'video index was never written (recorder did not shut down cleanly)' };
    }
    const skew = findMp4StartSkew(tail);
    if (skew !== null && skew > TIMELINE_SKEW_THRESHOLD_MS) {
      return { ok: false, reason: `audio and video start ${Math.round(skew / 1000)}s apart (camera timestamps skewed)` };
    }
    return { ok: true, reason: null };
  }
  // Unknown extension: scrcpy picks the muxer by extension, so this should not
  // happen — fall back to the size check rather than inventing a verdict.
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------
// Timestamp repair.
//
// A second, subtler failure mode (seen on a Tecno LH8n, Android 14): the
// recording finalizes cleanly — Duration/moov present — but the video track's
// first timestamp sits minutes after the audio's (e.g. +308s after a
// preview-to-record restart on a hot camera). Playback then shows a frozen
// frame for the whole phantom duration and motion only at the end. Deltas
// within each track are perfect; only the base is wrong, so shifting the late
// track back produces a correct file.
//
// Every rewrite below is strictly size-preserving — rewritten values keep
// their field widths (zero-padded), Cues are swapped for an equal-sized Void —
// so no byte offset moves and SeekHead stays valid.
// ---------------------------------------------------------------------------

/**
 * A/V start skew above this is treated as corruption, not startup lag (first
 * frames legitimately land up to ~1s in while the encoder spins up).
 */
const TIMELINE_SKEW_THRESHOLD_MS = 2000;

const MKV_ID_SEGMENT = 0x18538067;
const MKV_ID_INFO = 0x1549A966;
const MKV_ID_TRACKS = 0x1654AE6B;
const MKV_ID_CLUSTER = 0x1F43B675;
const MKV_ID_CUES = 0x1C53BB6B;
const MKV_ID_TRACK_ENTRY = 0xAE;
const MKV_ID_TRACK_TYPE = 0x83;
const MKV_ID_TIMESTAMP = 0xE7;
const MKV_ID_SIMPLE_BLOCK = 0xA3;
const MKV_ID_BLOCK_GROUP = 0xA0;
const MKV_ID_BLOCK = 0xA1;

/** Track number (vint) at the start of a SimpleBlock/Block payload. */
function blockTrackNo(payload) {
  const first = payload[0];
  const len = first & 0x80 ? 1 : first & 0x40 ? 2 : first & 0x20 ? 3 : 4;
  if (payload.length < len + 2) return null;
  let val = first & (0xFF >> len);
  for (let i = 1; i < len; i += 1) val = val * 256 + payload[i];
  return { no: val, headerLen: len + 2 }; // + int16 relative timestamp
}

/**
 * First packet timestamp per track in an MKV prefix, plus the track-kind map.
 * Returns null when the prefix holds no decodable clusters.
 */
function analyzeMkvTimeline(head) {
  const buf = Buffer.isBuffer(head) ? head : Buffer.from(head || []);
  const kinds = {}; // trackNo -> 'audio' | 'video'
  const first = {}; // trackNo -> first DTS (ms, TimestampScale units are ms here)
  const last = {};
  const clusters = [];
  let scale = 1000000;
  let duration = null;
  let cues = null;
  eachEbmlChild(buf, 0, buf.length, (id, start, end) => {
    if (id !== MKV_ID_SEGMENT) return;
    eachEbmlChild(buf, start, end, (cid, cstart, cend, cpos) => {
      if (cid === MKV_ID_TRACKS) {
        eachEbmlChild(buf, cstart, cend, (tid, tstart, tend) => {
          if (tid !== MKV_ID_TRACK_ENTRY) return;
          let no = null;
          let kind = null;
          eachEbmlChild(buf, tstart, tend, (fid, fstart, fend) => {
            const raw = buf.subarray(fstart, fend);
            if (fid === 0xD7 && raw.length >= 1) no = raw[0]; // TrackNumber
            else if (fid === MKV_ID_TRACK_TYPE && raw.length >= 1) {
              kind = raw[0] === 1 ? 'video' : raw[0] === 2 ? 'audio' : null;
            }
          });
          if (no !== null) kinds[no] = kind;
        });
      } else if (cid === 0x1549A966) { // Info
        eachEbmlChild(buf, cstart, cend, (iid, istart, iend) => {
          const raw = buf.subarray(istart, iend);
          if (iid === 0x2AD7B1 && raw.length > 0) {
            let v = 0;
            for (const b of raw) v = v * 256 + b;
            if (v > 0) scale = v;
          } else if (iid === 0x4489 && (raw.length === 4 || raw.length === 8)) {
            const d = raw.length === 4 ? raw.readFloatBE(0) : raw.readDoubleBE(0);
            if (Number.isFinite(d) && d > 0) duration = { pos: istart, len: raw.length, ms: (d * scale) / 1000000 };
          }
        });
      } else if (cid === MKV_ID_CUES) {
        cues = { pos: cpos, total: cend - cpos };
      } else if (cid === MKV_ID_CLUSTER) {
        let clusterTs = null;
        let tsPos = -1;
        let tsLen = 0;
        const present = new Set();
        eachEbmlChild(buf, cstart, cend, (eid, estart, eend) => {
          if (eid === MKV_ID_TIMESTAMP) {
            const raw = buf.subarray(estart, eend);
            let v = 0;
            for (const b of raw) v = v * 256 + b;
            clusterTs = v;
            tsPos = estart;
            tsLen = eend - estart;
          } else if (eid === MKV_ID_SIMPLE_BLOCK) {
            const t = blockTrackNo(buf.subarray(estart, eend));
            if (t && clusterTs !== null) {
              const abs = clusterTs + relOf(buf, estart, t);
              present.add(t.no);
              if (first[t.no] === undefined) first[t.no] = abs;
              last[t.no] = abs;
            }
          } else if (eid === MKV_ID_BLOCK_GROUP) {
            eachEbmlChild(buf, estart, eend, (bid, bstart, bend) => {
              if (bid !== MKV_ID_BLOCK) return;
              const t = blockTrackNo(buf.subarray(bstart, bend));
              if (t && clusterTs !== null) {
                const abs = clusterTs + relOf(buf, bstart, t);
                present.add(t.no);
                if (first[t.no] === undefined) first[t.no] = abs;
                last[t.no] = abs;
              }
            });
          }
        });
        if (clusterTs !== null) {
          clusters.push({ tsPos, tsLen, tsVal: clusterTs, tracks: [...present] });
        }
      }
    });
  });
  if (!clusters.length) return null;
  return { kinds, first, last, scale, duration, cues, clusters };
}

/** Signed int16 relative timestamp inside a block payload. */
function relOf(buf, payloadStart, t) {
  return buf.readInt16BE(payloadStart + t.headerLen - 2);
}

/** Video-minus-audio start skew in ms, or null when it cannot be assessed. */
function findMkvStartSkew(head) {
  const a = analyzeMkvTimeline(head);
  if (!a) return null;
  const videoFirsts = Object.entries(a.first)
    .filter(([no]) => a.kinds[Number(no)] === 'video')
    .map(([, ts]) => ts);
  if (!videoFirsts.length) return null;
  const videoFirst = Math.min(...videoFirsts);
  const audioFirsts = Object.entries(a.first)
    .filter(([no]) => a.kinds[Number(no)] === 'audio')
    .map(([, ts]) => ts);
  if (audioFirsts.length) return videoFirst - Math.min(...audioFirsts);
  // No audio track at all: any late video start is skew by itself. But when
  // an audio track EXISTS yet delivered no packets in the scanned prefix, the
  // picture is incomplete — stay silent rather than misjudge.
  const hasAudioTrack = Object.values(a.kinds).includes('audio');
  return hasAudioTrack ? null : videoFirst;
}

/** Overwrites a uint field keeping its width (zero-padded big-endian). */
function writeUintSameWidth(buf, pos, len, val) {
  if (val < 0 || !Number.isFinite(val)) return false;
  let v = Math.floor(val);
  for (let i = len - 1; i >= 0; i -= 1) {
    buf[pos + i] = v & 0xFF;
    v = Math.floor(v / 256);
  }
  return v === 0;
}

/** Replaces [pos, pos+total) with an equal-sized Void element. */
function writeVoidSameSize(buf, pos, total) {
  for (let len = 1; len <= 8; len += 1) {
    const val = total - 1 - len;
    if (val >= 0 && val < 2 ** (7 * len)) {
      buf[pos] = 0xEC;
      let v = val;
      const tmp = Buffer.alloc(len);
      for (let i = len - 1; i >= 0; i -= 1) { tmp[i] = v & 0xFF; v = Math.floor(v / 256); }
      tmp[0] |= 256 - 2 ** (8 - len);
      tmp.copy(buf, pos + 1);
      buf.fill(0, pos + 1 + len, pos + total);
      return true;
    }
  }
  return false;
}

/**
 * Repairs skewed MKV timelines in place semantics, without moving a byte:
 * shifts late video clusters back, rewrites Duration, swaps Cues for Void.
 * Tri-state: the original buffer (nothing to do), a new repaired Buffer, or
 * null (skewed but unrepairable — e.g. mixed audio/video clusters).
 */
function repairMkvTimestamps(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  const a = analyzeMkvTimeline(buf);
  if (!a) return input;
  const videoNos = Object.entries(a.kinds)
    .filter(([, kind]) => kind === 'video')
    .map(([no]) => Number(no));
  if (!videoNos.length) return input;
  const videoFirst = Math.min(...videoNos.map((no) => a.first[no]).filter((v) => v !== undefined));
  if (!Number.isFinite(videoFirst)) return input;
  const audioFirsts = Object.entries(a.kinds)
    .filter(([, kind]) => kind === 'audio')
    .map(([no]) => a.first[Number(no)])
    .filter((v) => v !== undefined);
  const hasAudioTrack = Object.values(a.kinds).includes('audio');
  if (hasAudioTrack && !audioFirsts.length) return null; // incomplete picture
  const anchor = audioFirsts.length ? Math.min(...audioFirsts) : 0;
  const shift = videoFirst - anchor;
  if (!(shift > TIMELINE_SKEW_THRESHOLD_MS)) return input;
  // A cluster mixing both tracks cannot be shifted as a unit (relatives are
  // int16); interleaving guarantees this never happens across a real skew,
  // but refuse rather than corrupt.
  for (const c of a.clusters) {
    const kinds = new Set(c.tracks.map((no) => a.kinds[no] || null));
    if (kinds.has('video') && kinds.has('audio')) return null;
  }
  const out = Buffer.from(buf);
  for (const c of a.clusters) {
    if (!c.tracks.some((no) => a.kinds[no] === 'video')) continue;
    const nv = c.tsVal - shift;
    if (nv < 0 || !writeUintSameWidth(out, c.tsPos, c.tsLen, nv)) return null;
  }
  // New duration: latest packet end across tracks, anchored at zero.
  let latest = 0;
  for (const [no, kind] of Object.entries(a.kinds)) {
    const last = a.last[Number(no)];
    if (last === undefined) continue;
    latest = Math.max(latest, kind === 'video' ? last - shift : last);
  }
  if (a.duration) {
    const v = latest * (a.scale / 1000000);
    if (a.duration.len === 8) out.writeDoubleBE(v, a.duration.pos);
    else out.writeFloatBE(v, a.duration.pos);
  }
  if (a.cues && !writeVoidSameSize(out, a.cues.pos, a.cues.total)) return null;
  return out;
}

// ---------------------------------------------------------------------------
// MP4 edit-list repair.
// ---------------------------------------------------------------------------

/** Iterates top-level and nested MP4 boxes: cb(type, pos, headerLen, end). */
function eachMp4Box(buf, start, end, cb) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    let hdr = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      const hi = buf.readUInt32BE(pos + 8);
      const lo = buf.readUInt32BE(pos + 12);
      if (hi > 0x1FFFFF) return; // beyond safe integer: refuse
      size = hi * 0x100000000 + lo;
      hdr = 16;
    } else if (size === 0) {
      cb(type, pos, hdr, end);
      return;
    }
    if (size < hdr || pos + size > end) return;
    cb(type, pos, hdr, pos + size);
    pos += size;
  }
}

function mp4FullBox(buf, pos, hdr) {
  return { version: buf[pos + hdr], flags: buf.readUIntBE(pos + hdr + 1, 3) };
}

/**
 * Leading empty-edit duration per track (movie timescale), i.e. presentation
 * time consumed before any media. libavformat writes one when the first
 * sample timestamps start late — exactly the camera-skew signature.
 */
function findMp4LeadingEmpties(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const out = [];
  eachMp4Box(b, 0, b.length, (type, pos, hdr, end) => {
    if (type !== 'moov') return;
    let movieScale = 1000;
    const traks = [];
    eachMp4Box(b, pos + hdr, end, (t2, p2, h2, e2) => {
      if (t2 === 'mvhd') {
        const { version } = mp4FullBox(b, p2, h2);
        movieScale = version === 0 ? b.readUInt32BE(p2 + h2 + 12) : b.readUInt32BE(p2 + h2 + 20);
      } else if (t2 === 'trak') {
        traks.push([p2 + h2, e2]);
      }
    });
    if (!movieScale) return;
    for (const [tstart, tend] of traks) {
      let leading = 0;
      let total = 0;
      eachMp4Box(b, tstart, tend, (t3, p3, h3, e3) => {
        if (t3 !== 'edts') return;
        eachMp4Box(b, p3 + h3, e3, (t4, p4, h4, e4) => {
          if (t4 !== 'elst') return;
          const { version } = mp4FullBox(b, p4, h4);
          const n = b.readUInt32BE(p4 + h4 + 4);
          let off = p4 + h4 + 8;
          const entryLen = version === 0 ? 12 : 20;
          let leadingDone = false;
          for (let i = 0; i < n && off + entryLen <= e4; i += 1) {
            let dur;
            let media;
            if (version === 0) {
              dur = b.readUInt32BE(off);
              media = b.readInt32BE(off + 4);
            } else {
              const dHi = b.readUInt32BE(off);
              const dLo = b.readUInt32BE(off + 4);
              dur = dHi * 0x100000000 + dLo;
              media = Number(b.readBigInt64BE(off + 8));
            }
            total += dur;
            if (!leadingDone && media === -1) leading += dur;
            else if (media !== -1) leadingDone = true;
            off += entryLen;
          }
        });
      });
      out.push({ leadingMs: (leading / movieScale) * 1000, totalMs: (total / movieScale) * 1000 });
    }
  });
  return out;
}

/** Max leading-empty presentation time across tracks, ms (0 when clean). */
function findMp4StartSkew(buf) {
  const tracks = findMp4LeadingEmpties(buf);
  if (!tracks.length) return null;
  return Math.max(...tracks.map((t) => t.leadingMs));
}

/**
 * Zeroes pathological leading empty edits and re-points mvhd/tkhd durations
 * at the true presentation end. Fixed widths everywhere, so offsets never move.
 * Tri-state like repairMkvTimestamps: original buffer, repaired Buffer, or
 * null when skewed but structurally unrepairable.
 */
function repairMp4Edits(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input || []);
  let mvhd = null;
  const traks = [];
  eachMp4Box(buf, 0, buf.length, (type, pos, hdr, end) => {
    if (type !== 'moov') return;
    eachMp4Box(buf, pos + hdr, end, (t2, p2, h2, e2) => {
      if (t2 === 'mvhd') {
        const { version } = mp4FullBox(buf, p2, h2);
        mvhd = version === 0
          ? { scale: buf.readUInt32BE(p2 + h2 + 12), durPos: p2 + h2 + 16, wide: false }
          : { scale: buf.readUInt32BE(p2 + h2 + 20), durPos: p2 + h2 + 32, wide: true };
      } else if (t2 === 'trak') {
        const trak = { start: p2 + h2, end: e2, tkhd: null, elst: [] };
        eachMp4Box(buf, p2 + h2, e2, (t3, p3, h3, e3) => {
          if (t3 === 'tkhd') {
            const { version } = mp4FullBox(buf, p3, h3);
            trak.tkhd = version === 0 ? { durPos: p3 + h3 + 20, wide: false } : { durPos: p3 + h3 + 36, wide: true };
          } else if (t3 === 'edts') {
            eachMp4Box(buf, p3 + h3, e3, (t4, p4, h4, e4) => {
              if (t4 !== 'elst') return;
              const { version } = mp4FullBox(buf, p4, h4);
              trak.elst.push({ pos: p4, hdr: h4, version, end: e4 });
            });
          }
        });
        traks.push(trak);
      }
    });
  });
  if (!mvhd || !mvhd.scale || !traks.length) return input;
  const out = Buffer.from(buf);
  let maxEnd = 0;
  let repairedAny = false;
  for (const trak of traks) {
    // First pass: total leading empty time for this track. Only a pathological
    // total (minutes, not the ~44ms AAC priming) zeroes anything — all or none,
    // so small legitimate gaps are never touched.
    let leadingTotalMs = 0;
    const leadingSpans = [];
    for (const el of trak.elst) {
      const n = out.readUInt32BE(el.pos + el.hdr + 4);
      let off = el.pos + el.hdr + 8;
      const entryLen = el.version === 0 ? 12 : 20;
      let leadingDone = false;
      for (let i = 0; i < n && off + entryLen <= el.end; i += 1) {
        let dur;
        let media;
        if (el.version === 0) {
          dur = out.readUInt32BE(off);
          media = out.readInt32BE(off + 4);
        } else {
          dur = Number(out.readBigUInt64BE(off));
          if (!Number.isSafeInteger(dur)) return null;
          media = Number(out.readBigInt64BE(off + 8));
          if (!Number.isSafeInteger(media) && media !== -1) return null;
        }
        if (!leadingDone && media === -1) {
          leadingTotalMs += (dur / mvhd.scale) * 1000;
          leadingSpans.push({ off, version: el.version });
        } else {
          if (media !== -1) leadingDone = true;
        }
        off += entryLen;
      }
    }
    if (leadingTotalMs > TIMELINE_SKEW_THRESHOLD_MS) {
      for (const s of leadingSpans) {
        if (s.version === 0) out.writeUInt32BE(0, s.off);
        else out.writeBigUInt64BE(0n, s.off);
      }
      repairedAny = true;
    }
    // Recompute the track end from the (possibly edited) list.
    let trackEnd = 0;
    for (const el of trak.elst) {
      const n = out.readUInt32BE(el.pos + el.hdr + 4);
      let off = el.pos + el.hdr + 8;
      const entryLen = el.version === 0 ? 12 : 20;
      for (let i = 0; i < n && off + entryLen <= el.end; i += 1) {
        trackEnd += el.version === 0 ? out.readUInt32BE(off) : Number(out.readBigUInt64BE(off));
        off += entryLen;
      }
    }
    maxEnd = Math.max(maxEnd, trackEnd);
    if (trak.tkhd) {
      if (trak.tkhd.wide) out.writeBigUInt64BE(BigInt(trackEnd), trak.tkhd.durPos);
      else out.writeUInt32BE(trackEnd >>> 0, trak.tkhd.durPos);
    }
  }
  if (!repairedAny) return input;
  if (mvhd.wide) out.writeBigUInt64BE(BigInt(maxEnd), mvhd.durPos);
  else out.writeUInt32BE(maxEnd >>> 0, mvhd.durPos);
  return out;
}

module.exports = {
  RECORD_STOP_TIMEOUT_MS,
  RECORD_FLUSH_SETTLE_MS,
  RECORD_MIN_BYTES,
  RECORD_TAIL_SCAN_BYTES,
  /** Bytes of file head needed to cover the MKV Info block. */
  RECORD_HEAD_SCAN_BYTES: 64 * 1024,
  /** A/V start skew above this is corruption, not startup lag. */
  TIMELINE_SKEW_THRESHOLD_MS,
  hasFtypBox,
  hasMoovBox,
  hasEbmlHeader,
  findMkvDuration,
  analyzeMkvTimeline,
  findMkvStartSkew,
  repairMkvTimestamps,
  findMp4StartSkew,
  repairMp4Edits,
  assessRecording,
};

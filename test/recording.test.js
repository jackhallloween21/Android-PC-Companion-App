// Tests for recording finalization checks: a killed recorder leaves video bytes
// with no index, and the app must report that instead of a "saved" file.

const test = require('node:test');
const assert = require('node:assert');
const {
  RECORD_MIN_BYTES,
  hasFtypBox,
  hasMoovBox,
  hasEbmlHeader,
  findMkvDuration,
  findMkvStartSkew,
  repairMkvTimestamps,
  findMp4StartSkew,
  repairMp4Edits,
  assessRecording,
} = require('../src/recording');

const ftypHead = () => Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftypisom', 'ascii'),
  Buffer.alloc(16),
]);

test('a finalized MP4 (ftyp head, moov tail) verifies', () => {
  const tail = Buffer.concat([Buffer.alloc(100), Buffer.from('moov', 'ascii'), Buffer.alloc(100)]);
  assert.deepStrictEqual(
    assessRecording({ head: ftypHead(), tail, size: 5 * 1024 * 1024, ext: '.mp4' }),
    { ok: true, reason: null });
});

test('a killed MP4 (no moov) is reported, not handed back as saved', () => {
  const tail = Buffer.concat([Buffer.alloc(100), Buffer.from('mdat', 'ascii'), Buffer.alloc(100)]);
  const res = assessRecording({ head: ftypHead(), tail, size: 5 * 1024 * 1024, ext: '.mp4' });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /index|moov|shut down/i);
});

test('an empty or tiny file is never called a recording', () => {
  assert.strictEqual(assessRecording({ head: Buffer.alloc(0), tail: Buffer.alloc(0), size: 0, ext: '.mp4' }).ok, false);
  assert.strictEqual(assessRecording({ head: ftypHead(), tail: Buffer.alloc(8), size: RECORD_MIN_BYTES - 1, ext: '.mp4' }).ok, false);
});

test('garbage with an mp4 name is rejected', () => {
  const res = assessRecording({
    head: Buffer.alloc(32, 0x41), tail: Buffer.alloc(32, 0x41), size: 2048, ext: '.mp4',
  });
  assert.strictEqual(res.ok, false);
});

/** Minimal file head: EBML header + Segment(unknown size) + Info{Duration}. */
function mkvHead({ durationMs = 8000, withDuration = true } = {}) {
  const ebmlId = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);
  const ebmlSize = Buffer.from([0x80]); // empty payload
  const segId = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  // Unknown size: 8-byte vint with all value bits set (0x01 + 7 x 0xFF).
  const segSize = Buffer.from([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  let infoPayload = Buffer.alloc(0);
  if (withDuration) {
    const dur = Buffer.alloc(8);
    dur.writeDoubleBE(durationMs, 0);
    infoPayload = Buffer.concat([Buffer.from([0x44, 0x89, 0x88]), dur]);
  }
  const infoId = Buffer.from([0x15, 0x49, 0xA9, 0x66]);
  const infoSize = Buffer.from([0x80 | infoPayload.length]);
  return Buffer.concat([ebmlId, ebmlSize, segId, segSize, infoId, infoSize, infoPayload]);
}

test('Matroska verifies on header plus a written Duration (clean close)', () => {
  const head = mkvHead();
  assert.strictEqual(assessRecording({ head, tail: Buffer.alloc(8), size: 2048, ext: '.mkv' }).ok, true);
  assert.strictEqual(assessRecording({ head, tail: Buffer.alloc(8), size: 2048, ext: '.webm' }).ok, true);
  assert.strictEqual(assessRecording({
    head: Buffer.alloc(8, 0x00), tail: Buffer.alloc(8), size: 2048, ext: '.mkv',
  }).ok, false);
});

test('a killed Matroska (clusters but no Duration) is reported, not saved', () => {
  const res = assessRecording({
    head: mkvHead({ withDuration: false }), tail: Buffer.alloc(8), size: 33 * 1024 * 1024, ext: '.mkv',
  });
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /index|shut down/i);
});

test('findMkvDuration reads the Segment/Info Duration in ms', () => {
  assert.strictEqual(findMkvDuration(mkvHead({ durationMs: 8222 })), 8222);
  assert.strictEqual(findMkvDuration(mkvHead({ withDuration: false })), null);
  assert.strictEqual(findMkvDuration(Buffer.alloc(16)), null);
  assert.strictEqual(findMkvDuration(Buffer.alloc(0)), null);
});

test('box helpers read the magic they claim', () => {
  assert.strictEqual(hasFtypBox(ftypHead()), true);
  assert.strictEqual(hasFtypBox(Buffer.alloc(32)), false);
  assert.strictEqual(hasMoovBox(Buffer.from('xxmoovxx', 'ascii')), true);
  assert.strictEqual(hasMoovBox(Buffer.from('xxmdatxx', 'ascii')), false);
  assert.strictEqual(hasEbmlHeader(Buffer.from([0x1A, 0x45, 0xDF, 0xA3])), true);
  assert.strictEqual(hasEbmlHeader(Buffer.from([0x00, 0x00, 0x00, 0x00])), false);
});

// ---------------------------------------------------------------------------
// Timestamp repair: synthetic skewed files.
// ---------------------------------------------------------------------------

/** EBML id + size + payload. */
function e(idBytes, payload) {
  const sizes = [payload.length];
  const id = Buffer.from(idBytes);
  let len = 1;
  while (sizes[0] >= 2 ** (7 * len)) len += 1;
  const size = Buffer.alloc(len);
  let v = payload.length;
  for (let i = len - 1; i >= 0; i -= 1) { size[i] = v & 0xFF; v = Math.floor(v / 256); }
  size[0] |= 256 - 2 ** (8 - len);
  return Buffer.concat([id, size, payload]);
}
const SEG = Buffer.from([0x18, 0x53, 0x80, 0x67]);
const INFO = Buffer.from([0x15, 0x49, 0xA9, 0x66]);
const TRACKS = Buffer.from([0x16, 0x54, 0xAE, 0x6B]);
const ENTRY = Buffer.from([0xAE]);
const CLUSTER = Buffer.from([0x1F, 0x43, 0xB6, 0x75]);
const TS = Buffer.from([0xE7]);
const SIMPLE = Buffer.from([0xA3]);

function uintPayload(v, len) {
  const b = Buffer.alloc(len);
  for (let i = len - 1; i >= 0; i -= 1) { b[i] = v & 0xFF; v = Math.floor(v / 256); }
  return b;
}

/** One SimpleBlock payload: track vint + int16 rel + flags + 4 dummy bytes. */
function simpleBlock(trackNo, rel) {
  const head = Buffer.from([0x80 | trackNo]);
  const ts = Buffer.alloc(2);
  ts.writeInt16BE(rel, 0);
  return Buffer.concat([head, ts, Buffer.from([0x80, 0x00, 0x00, 0x00, 0x00])]);
}

/** Minimal MKV: 2 tracks (1=video, 2=audio), audio at 0, video offset by videoStart. */
function skewedMkv(videoStart) {
  const entry = (no, kind) => e([...ENTRY], Buffer.concat([
    e([0xD7], Buffer.from([no])),
    e([0x83], Buffer.from([kind])),
  ]));
  const tracks = e([...TRACKS], Buffer.concat([entry(1, 1), entry(2, 2)]));
  const dur = Buffer.alloc(8);
  dur.writeDoubleBE(320000, 0);
  const info = e([...INFO], Buffer.concat([
    e([0x2A, 0xD7, 0xB1], Buffer.from([0x0F, 0x42, 0x40])), // TimestampScale 1e6
    e([0x44, 0x89], dur),
  ]));
  const cluster = (ts, trackNo) => e([...CLUSTER], Buffer.concat([
    e([...TS], uintPayload(ts, 3)),
    e([...SIMPLE], simpleBlock(trackNo, 0)),
  ]));
  const segBody = Buffer.concat([
    tracks, info,
    cluster(0, 2), cluster(20, 2), // audio at 0..20ms
    cluster(videoStart, 1), cluster(videoStart + 33, 1), // video at offset
  ]);
  const segSize = Buffer.alloc(8);
  segSize[0] = 0x01;
  segSize.writeUIntBE(segBody.length, 2, 6);
  return Buffer.concat([
    Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x80]),
    SEG, segSize, segBody,
  ]);
}

test('skewed MKV is detected and repaired to a zero-based timeline', () => {
  const bad = skewedMkv(308656);
  assert.strictEqual(findMkvStartSkew(bad) > 2000, true);
  assert.strictEqual(
    assessRecording({ head: bad, tail: bad, size: bad.length + 2048, ext: '.mkv' }).ok,
    false);
  const fixed = repairMkvTimestamps(bad);
  assert.ok(fixed && fixed !== bad, 'returns a new repaired buffer');
  assert.strictEqual(fixed.length, bad.length, 'repair never moves a byte');
  assert.strictEqual(findMkvStartSkew(fixed), 0);
  assert.strictEqual(findMkvDuration(fixed) < 5000, true);
  assert.strictEqual(
    assessRecording({ head: fixed, tail: fixed, size: fixed.length + 2048, ext: '.mkv' }).ok,
    true);
});

test('aligned MKV passes repair through untouched', () => {
  const good = skewedMkv(40);
  const out = repairMkvTimestamps(good);
  assert.strictEqual(out, good, 'same reference, no copy');
  assert.strictEqual(
    assessRecording({ head: good, tail: good, size: good.length + 2048, ext: '.mkv' }).ok,
    true);
});

/** Minimal MP4: ftyp + moov(mvhd + 1 trak with elst). */
function skewedMp4(emptyMs) {
  const box = (type, payload) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, 'ascii');
    return Buffer.concat([h, payload]);
  };
  const mvhdPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // v0 + flags
    Buffer.alloc(8), // creation + modification
    Buffer.from([0x00, 0x00, 0x03, 0xE8]), // timescale 1000
    Buffer.from([0x00, 0x04, 0xE2, 0x00]), // duration (placeholder)
  ]);
  const elstPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]), // v0 + flags
    Buffer.from([0x00, 0x00, 0x00, 0x02]), // 2 entries
    (() => { const b = Buffer.alloc(12); b.writeUInt32BE(emptyMs, 0); b.writeInt32BE(-1, 4); b.writeUInt32BE(1, 8); return b; })(),
    (() => { const b = Buffer.alloc(12); b.writeUInt32BE(8000, 0); b.writeInt32BE(0, 4); b.writeUInt32BE(1, 8); return b; })(),
  ]);
  const tkhdPayload = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.alloc(8),
    Buffer.from([0x00, 0x00, 0x00, 0x01]), Buffer.alloc(4),
    Buffer.from([0x00, 0x04, 0xE2, 0x00]), // duration (placeholder)
  ]);
  const moov = box('moov', Buffer.concat([
    box('mvhd', mvhdPayload),
    box('trak', Buffer.concat([
      box('tkhd', tkhdPayload),
      box('edts', box('elst', elstPayload)),
    ])),
  ]));
  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'ascii')),
    box('mdat', Buffer.alloc(2048)),
    moov,
  ]);
}

test('MP4 with a pathological leading empty edit is detected and repaired', () => {
  const bad = skewedMp4(309264);
  assert.strictEqual(findMp4StartSkew(bad) > 2000, true);
  const fixed = repairMp4Edits(bad);
  assert.ok(fixed && fixed !== bad, 'returns a new repaired buffer');
  assert.strictEqual(fixed.length, bad.length, 'repair never moves a byte');
  assert.strictEqual(findMp4StartSkew(fixed), 0);
});

test('MP4 with only AAC-priming-scale gaps is left alone', () => {
  const good = skewedMp4(44);
  assert.strictEqual(repairMp4Edits(good), good, 'same reference, no copy');
});

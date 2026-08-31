const test = require('node:test');
const assert = require('node:assert');
const jsQR = require('jsqr');
const { encodeQR, dataCodewords } = require('../src/qrencode');

// The encoder is only trustworthy if a real decoder can read what it produces,
// so every case here is a round-trip through jsqr (which the app already ships).
const SCALE = 4;
const QUIET = 4;

function rasterize({ size, modules }) {
  const dim = (size + QUIET * 2) * SCALE;
  const pixels = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const mx = Math.floor(x / SCALE) - QUIET;
      const my = Math.floor(y / SCALE) - QUIET;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my][mx];
      const i = (y * dim + x) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = dark ? 0 : 255;
      pixels[i + 3] = 255;
    }
  }
  return { pixels, dim };
}

function decode(text, opts) {
  const qr = encodeQR(text, opts);
  const { pixels, dim } = rasterize(qr);
  const result = jsQR(pixels, dim, dim);
  return { qr, text: result && result.data };
}

test('a pairing payload survives a round-trip through a real decoder', () => {
  const payload = 'WIFI:T:ADB;S:companion-3f9a2c;P:7Ke9Qm2Zab;;';
  const { qr, text } = decode(payload, { ecc: 'M' });
  assert.strictEqual(text, payload);
  assert.strictEqual(qr.size, qr.version * 4 + 17);
});

test('every error-correction level round-trips', () => {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const payload = `WIFI:T:ADB;S:companion-aabbcc;P:pass${ecc}1234;;`;
    assert.strictEqual(decode(payload, { ecc }).text, payload, `level ${ecc} failed`);
  }
});

test('versions 1 through 10 all round-trip', () => {
  const seen = new Set();
  for (let len = 1; len <= 260; len += 13) {
    const payload = 'A'.repeat(len);
    const { qr, text } = decode(payload, { ecc: 'L' });
    assert.strictEqual(text, payload, `length ${len} failed`);
    seen.add(qr.version);
  }
  // The sweep above must actually exercise the multi-block and version-info
  // (version >= 7) code paths, not just tiny codes.
  assert.ok(Math.max(...seen) >= 7, `only reached version ${Math.max(...seen)}`);
});

test('minVersion forces a larger symbol without breaking the payload', () => {
  const payload = 'hello';
  const small = encodeQR(payload, { ecc: 'M' });
  const { qr, text } = decode(payload, { ecc: 'M', minVersion: 6 });
  assert.strictEqual(text, payload);
  assert.strictEqual(qr.version, 6);
  assert.ok(small.version < 6);
});

test('non-ASCII payloads are encoded as UTF-8 bytes', () => {
  const payload = 'naïve café — ünïcøde';
  assert.strictEqual(decode(payload, { ecc: 'M' }).text, payload);
});

test('the chosen mask is one of the eight standard masks', () => {
  const { qr } = decode('WIFI:T:ADB;S:companion-1;P:abcdefghij;;', { ecc: 'M' });
  assert.ok(qr.mask >= 0 && qr.mask <= 7);
});

test('text beyond version 10 capacity is rejected, not silently truncated', () => {
  assert.throws(() => encodeQR('x'.repeat(400), { ecc: 'H' }), /too long/i);
});

test('an unknown error-correction level is rejected', () => {
  assert.throws(() => encodeQR('hi', { ecc: 'Z' }), /error-correction/i);
});

test('data capacity matches the spec for known version/level pairs', () => {
  // Spot-checks from ISO/IEC 18004 table 9.
  assert.strictEqual(dataCodewords(1, 'L'), 19);
  assert.strictEqual(dataCodewords(1, 'H'), 9);
  assert.strictEqual(dataCodewords(5, 'Q'), 62);
  assert.strictEqual(dataCodewords(10, 'M'), 216);
});

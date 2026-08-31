// ---------------------------------------------------------------------------
// Minimal QR Code encoder (byte mode, versions 1-10).
//
// Why hand-rolled: the app already ships `jsqr`, but jsqr only *decodes*. The
// wireless-debugging QR flow needs the opposite direction — the PC displays a
// code and the phone's camera reads it — and there is no encoder in the
// dependency tree. The algorithm below is the standard one (ISO/IEC 18004):
// bit stream -> Reed-Solomon blocks -> interleave -> module placement -> pick
// the mask with the lowest penalty.
//
// Scope is deliberately narrow: byte mode only, versions 1-10, which covers the
// ~45-byte "WIFI:T:ADB;..." payload with room to spare. Correctness is verified
// in test/qrencode.test.js by decoding every generated matrix back with jsqr.
// ---------------------------------------------------------------------------

const MIN_VERSION = 1;
const MAX_VERSION = 10;

// Error-correction codewords per block, indexed [ecl][version]; index 0 unused.
const ECC_PER_BLOCK = {
  L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};

// Number of error-correction blocks, indexed [ecl][version].
const ECC_BLOCKS = {
  L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/** Total data+ECC modules for a version, i.e. everything but the function patterns. */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Codewords available for data (payload + header + padding) at this version/ECL. */
function dataCodewords(version, ecl) {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[ecl][version] * ECC_BLOCKS[ecl][version];
}

// --------------------------------------------------------------- GF(256) math

/** Multiply in GF(256) with the QR primitive polynomial 0x11D. */
function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = ((z << 1) ^ ((z >>> 7) * 0x11d)) & 0xff;
    z ^= ((y >>> i) & 1) !== 0 ? x : 0;
  }
  return z;
}

/** Generator polynomial coefficients for `degree` error-correction codewords. */
function rsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** Reed-Solomon remainder — the ECC codewords appended to a data block. */
function rsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) result[i] ^= gfMul(divisor[i], factor);
  }
  return result;
}

// ------------------------------------------------------------------ bit stream

/**
 * Byte-mode bit stream: mode indicator, character count, payload, terminator,
 * then the alternating 0xEC/0x11 pad bytes the spec requires.
 */
function buildCodewords(bytes, version, ecl) {
  const bits = [];
  const push = (value, width) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  push(0x4, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCodewords(version, ecl) * 8;
  if (bits.length > capacityBits) return null;

  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    words.push(byte);
  }
  for (let pad = 0xec; words.length < capacityBits / 8; pad ^= 0xec ^ 0x11) words.push(pad);
  return words;
}

/**
 * Splits the data codewords into blocks, appends each block's ECC, then
 * interleaves them the way the spec expects (short blocks first, so their
 * missing last data codeword lines up as a hole that is simply skipped).
 */
function interleave(words, version, ecl) {
  const numBlocks = ECC_BLOCKS[ecl][version];
  const eccLen = ECC_PER_BLOCK[ecl][version];
  const totalWords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = numBlocks - (totalWords % numBlocks);
  const shortLen = Math.floor(totalWords / numBlocks) - eccLen;

  const divisor = rsDivisor(eccLen);
  const blocks = [];
  let offset = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i < shortBlocks ? 0 : 1);
    const data = words.slice(offset, offset + len);
    offset += len;
    blocks.push({ data, ecc: rsRemainder(data, divisor) });
  }

  const result = [];
  for (let i = 0; i < shortLen + 1; i++) {
    blocks.forEach((block, b) => {
      // The short blocks have no codeword in the final data column.
      if (i < shortLen || b >= shortBlocks) result.push(block.data[i]);
    });
  }
  for (let i = 0; i < eccLen; i++) {
    for (const block of blocks) result.push(block.ecc[i]);
  }
  return result;
}

// ------------------------------------------------------------ module placement

/** Centres of the alignment patterns for a version (empty for version 1). */
function alignmentPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.floor((version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function makeGrid(size, value) {
  return Array.from({ length: size }, () => new Array(size).fill(value));
}

/** Finder pattern plus its separator, centred on (cx, cy). */
function drawFinder(modules, isFunction, size, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || x >= size || y < 0 || y >= size) continue;
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      modules[y][x] = dist !== 2 && dist !== 4;
      isFunction[y][x] = true;
    }
  }
}

function drawAlignment(modules, isFunction, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      modules[cy + dy][cx + dx] = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      isFunction[cy + dy][cx + dx] = true;
    }
  }
}

/** Format information: 5 data bits + BCH(15,5) remainder, XORed with 0x5412. */
function formatBits(ecl, mask) {
  const data = (ECC_FORMAT_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Version information (versions 7+): 6 data bits + BCH(18,6) remainder. */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (version << 12) | rem;
}

function drawFormatBits(modules, isFunction, size, ecl, mask) {
  const bits = formatBits(ecl, mask);
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  const set = (x, y, on) => { modules[y][x] = on; isFunction[y][x] = true; };

  // First copy, around the top-left finder.
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));

  // Second copy, split between the other two finders.
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // the always-dark module
}

function drawVersionBits(modules, isFunction, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >>> i) & 1) !== 0;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = on;
    isFunction[b][a] = true;
    modules[a][b] = on;
    isFunction[a][b] = true;
  }
}

function drawFunctionPatterns(modules, isFunction, size, version, ecl) {
  // Timing patterns.
  for (let i = 0; i < size; i++) {
    modules[6][i] = i % 2 === 0;
    isFunction[6][i] = true;
    modules[i][6] = i % 2 === 0;
    isFunction[i][6] = true;
  }

  drawFinder(modules, isFunction, size, 3, 3);
  drawFinder(modules, isFunction, size, size - 4, 3);
  drawFinder(modules, isFunction, size, 3, size - 4);

  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      // The three corners are occupied by the finder patterns.
      const corner = (i === 0 && j === 0)
        || (i === 0 && j === positions.length - 1)
        || (i === positions.length - 1 && j === 0);
      if (!corner) drawAlignment(modules, isFunction, positions[i], positions[j]);
    }
  }

  drawFormatBits(modules, isFunction, size, ecl, 0);
  drawVersionBits(modules, isFunction, size, version);
}

/** Zigzag placement of the interleaved codewords into the non-function modules. */
function drawCodewords(modules, isFunction, size, words) {
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern: the pair *shifts* to 5/4, it does
    // not merely get read as 5. Advancing `right` itself is what keeps the
    // remaining pairs aligned — leaving it at 6 makes the next pair 4/3, which
    // re-reads column 4 and never reaches column 0.
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (isFunction[y][x] || i >= words.length * 8) continue;
        modules[y][x] = ((words[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        i++;
      }
    }
  }
}

// ------------------------------------------------------------------- masking

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(modules, isFunction, size, mask) {
  const fn = MASKS[mask];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!isFunction[y][x] && fn(x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

const FINDER_LIKE = [true, false, true, true, true, false, true];

function penaltyLine(line) {
  let penalty = 0;
  let runLength = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      runLength++;
      continue;
    }
    // Rule 1: runs of five or more same-coloured modules.
    if (runLength >= 5) penalty += 3 + (runLength - 5);
    runLength = 1;
  }
  // Rule 3: a finder-like 1:1:3:1:1 pattern next to four light modules.
  for (let i = 0; i + 7 <= line.length; i++) {
    if (FINDER_LIKE.some((v, k) => line[i + k] !== v)) continue;
    const before = line.slice(Math.max(0, i - 4), i);
    const after = line.slice(i + 7, i + 11);
    if ((before.length === 4 && before.every((v) => !v)) || (after.length === 4 && after.every((v) => !v))) {
      penalty += 40;
    }
  }
  return penalty;
}

function penaltyScore(modules, size) {
  let penalty = 0;
  let dark = 0;

  for (let y = 0; y < size; y++) penalty += penaltyLine(modules[y]);
  for (let x = 0; x < size; x++) penalty += penaltyLine(modules.map((row) => row[x]));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      // Rule 2: 2x2 blocks of one colour.
      if (x + 1 < size && y + 1 < size) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) penalty += 3;
      }
    }
  }

  // Rule 4: deviation of the dark-module ratio from 50%, in 5% steps.
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  return penalty + Math.max(0, k) * 10;
}

// ------------------------------------------------------------------ public API

/**
 * Encodes `text` as a QR code.
 *
 * @returns {{ size: number, version: number, mask: number, modules: boolean[][] }}
 *          `modules[y][x] === true` means a dark module. No quiet zone is
 *          included; the caller adds one (4 modules is the spec minimum).
 */
function encodeQR(text, { ecc = 'M', minVersion = MIN_VERSION, forceMask = null } = {}) {
  const level = String(ecc).toUpperCase();
  if (!ECC_PER_BLOCK[level]) throw new Error(`Unknown error-correction level: ${ecc}`);

  const bytes = Array.from(Buffer.from(String(text), 'utf8'));
  let version = null;
  let words = null;
  for (let v = Math.max(MIN_VERSION, minVersion); v <= MAX_VERSION; v++) {
    const candidate = buildCodewords(bytes, v, level);
    if (candidate) {
      version = v;
      words = candidate;
      break;
    }
  }
  if (!words) {
    throw new Error(`Text is too long for a version ${MAX_VERSION} QR code at level ${level}`);
  }

  const size = version * 4 + 17;
  const modules = makeGrid(size, false);
  const isFunction = makeGrid(size, false);
  drawFunctionPatterns(modules, isFunction, size, version, level);
  drawCodewords(modules, isFunction, size, interleave(words, version, level));

  // Pick the mask with the lowest penalty, as the spec prescribes. `forceMask`
  // exists for the tests, which need to check every mask individually.
  let best = { mask: 0, score: Infinity };
  if (forceMask !== null) {
    best = { mask: forceMask, score: 0 };
  } else {
    for (let mask = 0; mask < 8; mask++) {
      applyMask(modules, isFunction, size, mask);
      drawFormatBits(modules, isFunction, size, level, mask);
      const score = penaltyScore(modules, size);
      if (score < best.score) best = { mask, score };
      applyMask(modules, isFunction, size, mask); // XOR again to undo
    }
  }
  applyMask(modules, isFunction, size, best.mask);
  drawFormatBits(modules, isFunction, size, level, best.mask);

  return { size, version, mask: best.mask, modules };
}

module.exports = {
  MIN_VERSION,
  MAX_VERSION,
  rawDataModules,
  dataCodewords,
  encodeQR,
};

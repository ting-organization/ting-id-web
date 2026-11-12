// Reads QR codes (ISO/IEC 18004) from camera frames and pictures, for
// browsers without BarcodeDetector. Written for this page from the standard,
// with no third-party code.
//
//   decodeQR(ctx.getImageData(0, 0, w, h))  → the text, or null
//
// How a frame is read:
//   1. luminance, lightly blurred if the picture is noisy;
//   2. each pixel is compared with a threshold made from its neighbourhood
//      (8×8 blocks; flat blocks borrow the threshold of the nearest block
//      with contrast), so uneven light does not matter;
//   3. finder patterns are runs dark–light–dark–light–dark in the ratio
//      1:1:3:1:1 along a row, confirmed down the column, across again and
//      along both diagonals; three of them that make a right angle are a code;
//   4. the format information next to the finders, read in each finder's
//      own frame, must be there, or the three are passed over; the size comes
//      from the module size measured across the finders along the code's own
//      axes, and for version 7 and up from the version information (BCH 18,6);
//   5. alignment patterns are looked for where their found neighbours (or
//      else all found so far) put them, each refining a perspective transform;
//   6. the modules are sampled through the transform (and, if that fails, cell
//      by cell between alignment patterns, which follows lens distortion), the
//      format information (BCH 15,5, two copies, nearest code) gives level and
//      mask, the codewords are read in their zig-zag, de-interleaved and
//      corrected by Reed–Solomon over GF(256) (Berlekamp–Massey, Chien search,
//      Forney), keeping back the misdecode guard of the smallest codes;
//   7. the segments (numeric, alphanumeric, byte, kanji, ECI) are decoded;
//      bytes are UTF-8 unless an ECI says otherwise (ISO-8859-1 if not UTF-8).
// A mirrored code is read by transposing the grid; a light-on-dark code by
// looking again with dark and light swapped. Frames over 2.4 megapixels are
// scaled down first, and the work on any frame is bounded.

// Error correction codewords per block, and blocks, by level (L, M, Q, H) and
// version (ISO/IEC 18004 table 9); index 0 is unused.
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
/** The level (index into the tables) for the two level bits of the format information. */
const LEVEL_OF_BITS = [1, 0, 3, 2];
/** Codewords kept back to guard against misdecoding in the smallest codes (table 9, note b). */
const misdecodeGuard = (ver, level) => (ver === 1 ? [3, 2, 1, 1][level] : ver === 2 && level === 0 ? 2 : ver === 3 && level === 0 ? 1 : 0);

// --- GF(256) with x^8 + x^4 + x^3 + x^2 + 1, generator 2 ---------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => (a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]]);
/** p(α^e) for p given lowest power first, up to degree `deg`. */
function evalAt(p, deg, e) {
  let v = 0;
  for (let j = 0; j <= deg; j++) if (p[j] !== 0) v ^= EXP[(LOG[p[j]] + e * j) % 255];
  return v;
}

/** The syndromes r(α^j), j < ecc, of a block, first codeword the highest power. */
function syndromes(block, ecc) {
  const s = new Uint8Array(ecc);
  let any = 0;
  for (let j = 0; j < ecc; j++) {
    let v = 0;
    for (let k = 0; k < block.length; k++) v = (v === 0 ? 0 : EXP[LOG[v] + j]) ^ block[k];
    s[j] = v;
    any |= v;
  }
  return any === 0 ? null : s;
}

/**
 * Corrects up to `maxErrors` wrong codewords of a Reed–Solomon block (data
 * then `ecc` check codewords, generator roots α^0 … α^(ecc−1)) in place.
 * False if the block has more errors than that.
 */
function rsCorrect(block, ecc, maxErrors) {
  const n = block.length;
  const S = syndromes(block, ecc);
  if (S === null) return true;
  if (maxErrors <= 0) return false;
  // Berlekamp–Massey: the error locator Λ, shortest LFSR that makes S
  let lam = new Uint8Array(ecc + 1);
  let prev = new Uint8Array(ecc + 1);
  lam[0] = prev[0] = 1;
  let L = 0, gap = 1, lastD = 1;
  for (let i = 0; i < ecc; i++) {
    let d = S[i];
    for (let j = 1; j <= L; j++) d ^= mul(lam[j], S[i - j]);
    if (d === 0) {
      gap++;
      continue;
    }
    const f = div(d, lastD);
    const keep = 2 * L <= i ? lam.slice() : null;
    for (let j = 0; j + gap <= ecc; j++) lam[j + gap] ^= mul(f, prev[j]);
    if (keep) {
      L = i + 1 - L;
      prev = keep;
      lastD = d;
      gap = 1;
    } else {
      gap++;
    }
  }
  if (L === 0 || L > maxErrors || lam[L] === 0) return false;
  // Error evaluator Ω = S·Λ mod x^ecc
  const om = new Uint8Array(ecc);
  for (let i = 0; i < ecc; i++) {
    let v = 0;
    for (let j = 0; j <= L && j <= i; j++) v ^= mul(lam[j], S[i - j]);
    om[i] = v;
  }
  // Chien search for the roots α^−p of Λ, Forney for the error values
  const where = [], what = [];
  for (let p = 0; p < n; p++) {
    const inv = (255 - p) % 255;
    if (evalAt(lam, L, inv) !== 0) continue;
    let den = 0;
    for (let j = 1; j <= L; j += 2) if (lam[j] !== 0) den ^= EXP[(LOG[lam[j]] + inv * (j - 1)) % 255];
    const e = mul(EXP[p], div(evalAt(om, ecc - 1, inv), den || 1));
    if (den === 0 || e === 0) return false;
    where.push(n - 1 - p);
    what.push(e);
  }
  if (where.length !== L) return false;
  for (let i = 0; i < L; i++) block[where[i]] ^= what[i];
  return syndromes(block, ecc) === null;
}

// --- Code structure ---------------------------------------------------------
const popcount = (x) => {
  let n = 0;
  for (; x; x &= x - 1) n++;
  return n;
};
const FORMAT_CODES = Array.from({ length: 32 }, (_, v) => {
  let r = v;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  return ((v << 10) | r) ^ 0x5412;
});
const VERSION_CODES = Array.from({ length: 41 }, (_, v) => {
  if (v < 7) return -1;
  let r = v;
  for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
  return (v << 12) | r;
});
/** The version whose 18-bit version information is nearest `bits`, if within 3 bits. */
function nearestVersion(bits) {
  let best = 0, bestD = 4;
  for (let v = 7; v <= 40; v++) {
    const d = popcount(bits ^ VERSION_CODES[v]);
    if (d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best ? { ver: best, dist: bestD } : null;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

const functionMasks = [];
/** Which modules of a version are function patterns (not data), row by row. */
function functionMask(ver) {
  if (functionMasks[ver]) return functionMasks[ver];
  const dim = ver * 4 + 17;
  const f = new Uint8Array(dim * dim);
  const fill = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y * dim + x] = 1;
  };
  fill(0, 0, 9, 9); // finder, separator, format
  fill(dim - 8, 0, 8, 9);
  fill(0, dim - 8, 9, 8);
  fill(6, 0, 1, dim); // timing
  fill(0, 6, dim, 1);
  const pos = alignmentPositions(ver);
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0);
      if (!corner) fill(pos[i] - 2, pos[j] - 2, 5, 5);
    }
  }
  if (ver >= 7) {
    fill(dim - 11, 0, 3, 6);
    fill(0, dim - 11, 6, 3);
  }
  return (functionMasks[ver] = f);
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * Level and mask from the two copies of the format information, read with
 * at(x, y) (1 = dark): the nearest valid code within 3 bits of either copy,
 * with `agree` when both copies are within 3 of it; or null.
 */
function readFormat(at, dim) {
  let a = 0, b = 0;
  for (let i = 0; i <= 5; i++) a |= at(8, i) << i;
  a |= (at(8, 7) << 6) | (at(8, 8) << 7) | (at(7, 8) << 8);
  for (let i = 9; i < 15; i++) a |= at(14 - i, 8) << i;
  for (let i = 0; i < 8; i++) b |= at(dim - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) b |= at(8, dim - 15 + i) << i;
  let best = -1, bestD = 4, bestSum = 99;
  for (let v = 0; v < 32; v++) {
    const da = popcount(a ^ FORMAT_CODES[v]), db = popcount(b ^ FORMAT_CODES[v]);
    const d = Math.min(da, db);
    if (d < bestD || (d === bestD && da + db < bestSum)) {
      best = v;
      bestD = d;
      bestSum = da + db;
    }
  }
  if (best < 0) return null;
  return { level: LEVEL_OF_BITS[best >> 3], mask: best & 7, dist: bestD, agree: bestSum - bestD <= 3 };
}

/**
 * Is there likely a code here? Its format information, either way round,
 * with `at` reading a module: both copies near the same code, or one within
 * a bit. Random modules pass about one time in twelve; a real code nearly always.
 */
function formatPlausible(at, dim) {
  for (const f of [readFormat(at, dim), readFormat((x, y) => at(y, x), dim)]) if (f && (f.agree || f.dist <= 1)) return true;
  return false;
}

/** The text of a sampled grid (1 = dark), or null. */
function decodeGrid(g, dim) {
  const ver = (dim - 17) / 4;
  if (!Number.isInteger(ver) || ver < 1 || ver > 40) return null;
  const format = readFormat((x, y) => g[y * dim + x], dim);
  if (format === null) return null;
  if (ver >= 7) {
    // A readable version block that names another version means a misread size
    let a = 0, b = 0;
    for (let i = 0; i < 18; i++) {
      const p = dim - 11 + (i % 3), q = Math.floor(i / 3);
      a |= g[q * dim + p] << i;
      b |= g[p * dim + q] << i;
    }
    const va = nearestVersion(a), vb = nearestVersion(b);
    if ((va && va.ver !== ver && !(vb && vb.ver === ver)) || (vb && vb.ver !== ver && !(va && va.ver === ver))) return null;
  }
  const fn = functionMask(ver);
  const isMasked = MASKS[format.mask];
  const total = codewordCount(ver);
  const cw = new Uint8Array(total);
  let i = 0;
  for (let right = dim - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < dim; vert++) {
      const y = upward ? dim - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fn[y * dim + x] || i >= total * 8) continue;
        const bit = g[y * dim + x] ^ (isMasked(x, y) ? 1 : 0);
        cw[i >> 3] |= bit << (7 - (i & 7));
        i++;
      }
    }
  }

  const { level } = format;
  const nb = BLOCKS[level][ver], ecc = ECC_PER_BLOCK[level][ver];
  const shortLen = Math.floor(total / nb), shortCount = nb - (total % nb), shortData = shortLen - ecc;
  const blocks = [];
  for (let b = 0; b < nb; b++) blocks.push(new Uint8Array(shortLen + (b < shortCount ? 0 : 1)));
  let p = 0;
  for (let k = 0; k <= shortData; k++) for (let b = 0; b < nb; b++) if (k < shortData || b >= shortCount) blocks[b][k] = cw[p++];
  for (let k = 0; k < ecc; k++) for (let b = 0; b < nb; b++) blocks[b][blocks[b].length - ecc + k] = cw[p++];

  const maxErrors = (ecc - misdecodeGuard(ver, level)) >> 1;
  const data = new Uint8Array(total - nb * ecc);
  let o = 0;
  for (const block of blocks) {
    if (!rsCorrect(block, ecc, maxErrors)) return null;
    data.set(block.subarray(0, block.length - ecc), o);
    o += block.length - ecc;
  }
  return parseSegments(data, ver);
}

function codewordCount(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n >> 3;
}

// --- Segments ---------------------------------------------------------------
const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
/** Character sets of the ECI designators a phone might meet. */
const ECI_CHARSETS = {
  1: 'latin1', 3: 'latin1', 20: 'shift_jis', 21: 'windows-1250', 22: 'windows-1251', 23: 'windows-1252',
  24: 'windows-1256', 25: 'utf-16be', 26: 'utf-8', 27: 'latin1', 28: 'big5', 29: 'gb18030', 30: 'euc-kr', 170: 'latin1',
};
for (let e = 4; e <= 18; e++) if (e !== 14) ECI_CHARSETS[e] = `iso-8859-${e - 2}`;

function bytesToText(bytes, charset) {
  if (charset === 'latin1') {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  }
  if (charset !== null) {
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch (e) {
      // Kanji without a Shift JIS decoder cannot be read at all; another
      // unknown character set reads as UTF-8 below
      if (charset === 'shift_jis') throw e;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Without an ECI the standard's default is ISO-8859-1
    return charset === null ? bytesToText(bytes, 'latin1') : new TextDecoder('utf-8').decode(bytes);
  }
}

/** The text of the data codewords, or null if they are not a well-formed bit stream. */
function parseSegments(data, ver) {
  const total = data.length * 8;
  let pos = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((data[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
  const size = ver < 10 ? 0 : ver < 27 ? 1 : 2;
  let text = '';
  let chunk = [], chunkCharset = null, eci = null;
  const flush = () => {
    if (chunk.length) text += bytesToText(Uint8Array.from(chunk), chunkCharset);
    chunk = [];
  };
  const put = (b, charset) => {
    if (chunk.length && charset !== chunkCharset) flush();
    chunkCharset = charset;
    chunk.push(b);
  };
  while (total - pos >= 4) {
    const mode = take(4);
    if (mode === 0) break;
    if (mode === 1 || mode === 2 || mode === 4 || mode === 8) {
      const countBits = { 1: [10, 12, 14], 2: [9, 11, 13], 4: [8, 16, 16], 8: [8, 10, 12] }[mode][size];
      if (total - pos < countBits) return null;
      let count = take(countBits);
      const need = { 1: Math.floor(count / 3) * 10 + [0, 4, 7][count % 3], 2: Math.floor(count / 2) * 11 + (count % 2) * 6, 4: count * 8, 8: count * 13 }[mode];
      if (total - pos < need) return null;
      if (mode === 1) {
        flush();
        for (; count >= 3; count -= 3) {
          const v = take(10);
          if (v > 999) return null;
          text += String(v).padStart(3, '0');
        }
        if (count > 0) {
          const v = take(count === 2 ? 7 : 4);
          if (v >= (count === 2 ? 100 : 10)) return null;
          text += String(v).padStart(count, '0');
        }
      } else if (mode === 2) {
        flush();
        for (; count >= 2; count -= 2) {
          const v = take(11);
          if (v >= 45 * 45) return null;
          text += ALPHANUMERIC[Math.floor(v / 45)] + ALPHANUMERIC[v % 45];
        }
        if (count === 1) {
          const v = take(6);
          if (v >= 45) return null;
          text += ALPHANUMERIC[v];
        }
      } else if (mode === 4) {
        const charset = eci === null ? null : ECI_CHARSETS[eci] ?? null;
        for (let k = 0; k < count; k++) put(take(8), charset);
      } else {
        for (let k = 0; k < count; k++) {
          const v = take(13);
          let t = (Math.floor(v / 0xc0) << 8) | (v % 0xc0);
          t += t < 0x1f00 ? 0x8140 : 0xc140;
          put(t >> 8, 'shift_jis');
          put(t & 0xff, 'shift_jis');
        }
      }
    } else if (mode === 7) {
      if (total - pos < 8) return null;
      const first = take(8);
      if ((first & 0x80) === 0) eci = first;
      else if ((first & 0xc0) === 0x80 && total - pos >= 8) eci = ((first & 0x3f) << 8) | take(8);
      else if ((first & 0xe0) === 0xc0 && total - pos >= 16) eci = ((first & 0x1f) << 16) | take(16);
      else return null;
    } else if (mode === 3) {
      if (total - pos < 16) return null;
      take(16); // structured append: position and parity, not needed for one code
    } else if (mode === 5) {
      // FNC1 in first position: nothing follows
    } else if (mode === 9) {
      if (total - pos < 8) return null;
      take(8);
    } else {
      return null;
    }
  }
  flush();
  return text;
}

// --- Image to binary --------------------------------------------------------
const MAX_PIXELS = 2_400_000;
const BLOCK = 8;

/** Luminance, scaled down by `f` (box average) when f > 1; transparent pixels are on white. */
function luminance(data, width, w, h, f) {
  const g = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0, j = ((y * f + dy) * width + x * f) * 4; dx < f; dx++, j += 4) {
          let v = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
          const a = data[j + 3];
          if (a < 255) v = 255 - (((255 - v) * a) / 255) | 0;
          sum += v;
        }
      }
      g[y * w + x] = f === 1 ? sum : (sum / (f * f)) | 0;
    }
  }
  return g;
}

/** Median absolute difference of horizontal neighbours: about the noise σ. */
function noiseLevel(g, w, h) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = 0; y < h; y += 4) {
    for (let i = y * w, e = i + w - 1; i < e; i++) {
      const d = g[i + 1] - g[i];
      hist[d < 0 ? -d : d]++;
      n++;
    }
  }
  let acc = 0;
  for (let d = 0; d < 256; d++) if ((acc += hist[d]) * 2 >= n) return d;
  return 255;
}

function blur3(g, w, h) {
  const t = new Uint16Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) t[r + x] = g[r + (x > 0 ? x - 1 : 0)] + g[r + x] + g[r + (x < w - 1 ? x + 1 : x)];
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w, r = y * w, down = (y < h - 1 ? y + 1 : y) * w;
    for (let x = 0; x < w; x++) out[r + x] = ((t[up + x] + t[r + x] + t[down + x]) / 9 + 0.5) | 0;
  }
  return out;
}

/**
 * Dark (1) or light (0) for each pixel, against a local threshold: the
 * midpoint of each 8×8 block with contrast; flat blocks take the threshold of
 * the nearest block with contrast; then averaged over 5×5 blocks.
 */
function binarize(g, w, h, minRange) {
  const bw = Math.ceil(w / BLOCK), bh = Math.ceil(h / BLOCK), nb = bw * bh;
  const thr = new Float32Array(nb);
  const done = new Uint8Array(nb);
  const queue = new Int32Array(nb);
  let qt = 0;
  for (let by = 0; by < bh; by++) {
    const y0 = by * BLOCK, y1 = Math.min(h, y0 + BLOCK);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = bx * BLOCK, x1 = Math.min(w, x0 + BLOCK);
      let lo = 255, hi = 0;
      for (let y = y0; y < y1; y++) {
        for (let i = y * w + x0, e = y * w + x1; i < e; i++) {
          const v = g[i];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      if (hi - lo >= minRange) {
        const b = by * bw + bx;
        thr[b] = (lo + hi) / 2;
        done[b] = 1;
        queue[qt++] = b;
      }
    }
  }
  if (qt === 0) return null;
  for (let qh = 0; qh < qt; qh++) {
    const b = queue[qh], bx = b % bw;
    const next = [bx > 0 ? b - 1 : -1, bx < bw - 1 ? b + 1 : -1, b - bw, b + bw];
    for (const c of next) {
      if (c >= 0 && c < nb && !done[c]) {
        done[c] = 1;
        thr[c] = thr[b];
        queue[qt++] = c;
      }
    }
  }
  const sw = bw + 1, sat = new Float64Array(sw * (bh + 1));
  for (let by = 0; by < bh; by++) {
    let row = 0;
    for (let bx = 0; bx < bw; bx++) {
      row += thr[by * bw + bx];
      sat[(by + 1) * sw + bx + 1] = sat[by * sw + bx + 1] + row;
    }
  }
  const t = new Uint8Array(nb);
  for (let by = 0; by < bh; by++) {
    const y0 = Math.max(0, by - 2), y1 = Math.min(bh, by + 3);
    for (let bx = 0; bx < bw; bx++) {
      const x0 = Math.max(0, bx - 2), x1 = Math.min(bw, bx + 3);
      const sum = sat[y1 * sw + x1] - sat[y0 * sw + x1] - sat[y1 * sw + x0] + sat[y0 * sw + x0];
      t[by * bw + bx] = Math.ceil(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  const bin = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const tb = (y >> 3) * bw;
    for (let x = 0, i = y * w; x < w; x++, i++) bin[i] = g[i] < t[tb + (x >> 3)] ? 1 : 0;
  }
  return bin;
}

// --- Finder patterns --------------------------------------------------------
/**
 * Runs (outer, light, centre, light, outer) in the ratio 1:1:3:1:1? Each may
 * be off by half a module and a pixel: small modules seen at an angle are
 * a pixel or so out either way.
 */
function finderRatio(a, b, c, d, e) {
  const total = a + b + c + d + e;
  if (total < 7) return false;
  const u = total / 7, tol = u * 0.5 + 1, lo = u - tol, hi = u + tol;
  return a > lo && a < hi && b > lo && b < hi && d > lo && d < hi && e > lo && e < hi && Math.abs(c - 3 * u) < u + 1.5;
}

/**
 * From the dark pixel (x, y), the lengths of the run it is in, the next run
 * and the one after, walking by (dx, dy). Outside the image counts as light.
 */
function runsFrom(img, x, y, dx, dy, maxLen, out) {
  const { bin, w, h, inv } = img;
  out[0] = out[1] = out[2] = 0;
  let k = 0, want = 1;
  while (k < 3) {
    const inside = x >= 0 && y >= 0 && x < w && y < h;
    if ((inside ? bin[y * w + x] ^ inv : 0) === want) {
      if (++out[k] > maxLen) return false;
      x += dx;
      y += dy;
    } else {
      k++;
      want ^= 1;
    }
  }
  return out[0] > 0;
}

const runA = new Int32Array(3), runB = new Int32Array(3);
/** Runs of the pattern through (x, y) along ±(dx, dy): [outer, light, centre, light, outer], centre offset, total. */
function crossRuns(img, x, y, dx, dy, maxLen) {
  if (!runsFrom(img, x, y, -dx, -dy, maxLen, runA) || !runsFrom(img, x, y, dx, dy, maxLen, runB)) return null;
  const centre = runA[0] + runB[0] - 1;
  if (!finderRatio(runA[2], runA[1], centre, runB[1], runB[2])) return null;
  return { offset: (runB[0] - runA[0]) / 2, total: runA[2] + runA[1] + centre + runB[1] + runB[2] };
}

/** Confirms a finder seen in a row at (cx, y): down the column, across again, both diagonals. */
function confirmFinder(img, cx, y, rowTotal) {
  const maxLen = Math.ceil(rowTotal);
  const x0 = Math.round(cx);
  const v = crossRuns(img, x0, y, 0, 1, maxLen);
  if (!v || v.total > rowTotal * 2 || v.total * 2 < rowTotal) return null;
  const cy = y + v.offset, y0 = Math.round(cy);
  const hz = crossRuns(img, x0, y0, 1, 0, maxLen);
  if (!hz || hz.total > v.total * 2 || hz.total * 2 < v.total) return null;
  const x1 = x0 + hz.offset, xr = Math.round(x1);
  if (!crossRuns(img, xr, y0, 1, 1, maxLen) || !crossRuns(img, xr, y0, 1, -1, maxLen)) return null;
  return { x: x1, y: cy, m: (hz.total + v.total) / 14 };
}

function findFinders(img) {
  const { bin, w, h, inv } = img;
  const found = [];
  const runs = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let n = 0, len = 1, c = bin[row] ^ inv;
    const firstDark = c;
    for (let x = 1; x < w; x++) {
      const v = bin[row + x] ^ inv;
      if (v === c) len++;
      else {
        runs[n++] = len;
        len = 1;
        c = v;
      }
    }
    runs[n++] = len;
    let x = 0;
    for (let i = 0; i + 4 < n; i++) {
      if ((firstDark ^ (i & 1)) === 1 && finderRatio(runs[i], runs[i + 1], runs[i + 2], runs[i + 3], runs[i + 4])) {
        const total = runs[i] + runs[i + 1] + runs[i + 2] + runs[i + 3] + runs[i + 4];
        const f = confirmFinder(img, x + runs[i] + runs[i + 1] + (runs[i + 2] - 1) / 2, y, total);
        if (f) addFinder(found, f);
        if (found.length > 200) return found;
      }
      x += runs[i];
    }
  }
  return found;
}

function addFinder(list, f) {
  for (const c of list) {
    const r = Math.max(c.m, f.m) * 1.5;
    if (Math.abs(c.x - f.x) <= r && Math.abs(c.y - f.y) <= r && f.m < c.m * 1.6 && c.m < f.m * 1.6) {
      const n = c.n + 1;
      c.x = (c.x * c.n + f.x) / n;
      c.y = (c.y * c.n + f.y) / n;
      c.m = (c.m * c.n + f.m) / n;
      c.n = n;
      return;
    }
  }
  list.push({ ...f, n: 1 });
}

/** Triples of finders that could be the corners of one code, likeliest first, as top-left, top-right, bottom-left. */
function finderTriples(found) {
  let list = found.filter((c) => c.n >= 2);
  if (list.length < 3) list = found.slice();
  list.sort((a, b) => b.n - a.n);
  list = list.slice(0, 12);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      for (let k = j + 1; k < list.length; k++) {
        const t = orient(list[i], list[j], list[k]);
        if (t) out.push(t);
      }
    }
  }
  return out.sort((a, b) => a.score - b.score).slice(0, 6);
}

function orient(a, b, c) {
  const d2 = (p, q) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
  const ab = d2(a, b), bc = d2(b, c), ac = d2(a, c);
  const [tl, p, q] = bc >= ab && bc >= ac ? [a, b, c] : ac >= ab ? [b, a, c] : [c, a, b];
  const v1x = p.x - tl.x, v1y = p.y - tl.y, v2x = q.x - tl.x, v2y = q.y - tl.y;
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  const mMin = Math.min(a.m, b.m, c.m), mMax = Math.max(a.m, b.m, c.m), m = (a.m + b.m + c.m) / 3;
  if (mMax > mMin * 2 || Math.min(l1, l2) < 8 * m || Math.max(l1, l2) > 200 * m) return null;
  const cos = (v1x * v2x + v1y * v2y) / (l1 * l2), ratio = Math.max(l1, l2) / Math.min(l1, l2);
  if (Math.abs(cos) > 0.45 || ratio > 1.8) return null;
  const [tr, bl] = v1x * v2y - v1y * v2x > 0 ? [p, q] : [q, p];
  return { tl, tr, bl, score: Math.abs(cos) + (ratio - 1) + Math.log(mMax / mMin) };
}

// --- Geometry ---------------------------------------------------------------
function sample(img, x, y) {
  const ix = Math.round(x), iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= img.w || iy >= img.h) return 0;
  return img.bin[iy * img.w + ix] ^ img.inv;
}

/**
 * The module size of the finder centred at (cx, cy), measured along the unit
 * vector (ux, uy) and back: [forward, back], null for a way where it does not
 * look like a finder. Taken from the middles of the light ring (2 modules out)
 * and of the dark ring (3 modules), which stay put when blur or the threshold
 * makes dark parts fatter or thinner; the dark ring only if it has not run on
 * into what lies beyond it (a blurred-out separator).
 */
function finderScale(img, cx, cy, ux, uy) {
  return [1, -1].map((s) => {
    const lens = [0, 0, 0];
    let k = 0, want = 1, t = 0;
    while (k < 3 && t < 2000) {
      if (sample(img, cx + s * ux * t, cy + s * uy * t) === want) {
        lens[k] += 0.5;
        t += 0.5;
      } else {
        k++;
        want ^= 1;
      }
    }
    if (k < 3) return null;
    const m = (lens[0] + lens[1] / 2) / 2;
    if (lens[1] < m * 0.25 || lens[1] > m * 1.75 || lens[2] < m * 0.4) return null;
    return lens[2] < m * 1.6 ? (lens[0] + lens[1] / 2 + lens[0] + lens[1] + lens[2] / 2) / 5 : m;
  });
}

/** A transform from module coordinates (u, v) to the image, exact for the points given (3) or least squares (4+). */
function fitTransform(src, dst) {
  const n = src.length;
  let cx = 0, cy = 0, s = 0, su = 0;
  for (let i = 0; i < n; i++) {
    cx += dst[i][0] / n;
    cy += dst[i][1] / n;
    su = Math.max(su, src[i][0], src[i][1]);
  }
  for (let i = 0; i < n; i++) s += Math.hypot(dst[i][0] - cx, dst[i][1] - cy) / n;
  s ||= 1;
  su = 1 / (su || 1);
  const unknowns = n === 3 ? 6 : 8;
  const A = new Float64Array(unknowns * unknowns), B = new Float64Array(unknowns);
  for (let i = 0; i < n; i++) {
    const u = src[i][0] * su, v = src[i][1] * su, x = (dst[i][0] - cx) / s, y = (dst[i][1] - cy) / s;
    const rows = [
      [[u, v, 1, 0, 0, 0, -u * x, -v * x], x],
      [[0, 0, 0, u, v, 1, -u * y, -v * y], y],
    ];
    for (const [r, rhs] of rows) {
      for (let a = 0; a < unknowns; a++) {
        B[a] += r[a] * rhs;
        for (let b = 0; b < unknowns; b++) A[a * unknowns + b] += r[a] * r[b];
      }
    }
  }
  const p = solve(A, B, unknowns);
  if (!p) return null;
  const g = unknowns === 8 ? p[6] : 0, hh = unknowns === 8 ? p[7] : 0;
  return (u, v) => {
    u *= su;
    v *= su;
    const z = g * u + hh * v + 1;
    return [((p[0] * u + p[1] * v + p[2]) / z) * s + cx, ((p[3] * u + p[4] * v + p[5]) / z) * s + cy];
  };
}

/** Solves the n×n system A x = b (Gaussian elimination, partial pivoting). */
function solve(A, b, n) {
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r * n + c]) > Math.abs(A[piv * n + c])) piv = r;
    if (Math.abs(A[piv * n + c]) < 1e-12) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) [A[c * n + k], A[piv * n + k]] = [A[piv * n + k], A[c * n + k]];
      [b[c], b[piv]] = [b[piv], b[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / A[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      b[r] -= f * b[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let v = b[r];
    for (let k = r + 1; k < n; k++) v -= A[r * n + k] * x[k];
    x[r] = v / A[r * n + r];
  }
  return x;
}

/** How well the 5×5 alignment pattern fits centred at (cx, cy), in modules matching (0 when it is clearly not there). */
function alignmentScore(img, cx, cy, ex, ey, fx, fy) {
  let score = 0, misses = 0;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const want = Math.max(Math.abs(i), Math.abs(j)) === 1 ? 0 : 1;
      if (sample(img, cx + ex * i + fx * j, cy + ey * i + fy * j) === want) score++;
      else if (++misses > 3) return 0;
    }
  }
  return score;
}

/**
 * The alignment pattern nearest (px, py) within R modules, where (ex, ey) and
 * (fx, fy) are one module along the code's x and y there; null if none.
 */
function findAlignment(img, px, py, ex, ey, fx, fy, R) {
  const STEP = 0.5, n = Math.round(R / STEP), side = 2 * n + 1;
  const scores = new Uint8Array(side * side);
  let best = 0, bi = 0, bj = 0, bd = Infinity;
  for (let j = -n; j <= n; j++) {
    for (let i = -n; i <= n; i++) {
      const du = i * STEP, dv = j * STEP;
      const s = alignmentScore(img, px + ex * du + fx * dv, py + ey * du + fy * dv, ex, ey, fx, fy);
      scores[(j + n) * side + i + n] = s;
      const d = i * i + j * j;
      if (s > best || (s === best && s > 0 && d < bd)) {
        best = s;
        bi = i;
        bj = j;
        bd = d;
      }
    }
  }
  if (best < 22) return null;
  // The centre is the middle of the best-fitting positions around the chosen one
  let si = 0, sj = 0, cnt = 0;
  for (let j = Math.max(-n, bj - 2); j <= Math.min(n, bj + 2); j++) {
    for (let i = Math.max(-n, bi - 2); i <= Math.min(n, bi + 2); i++) {
      if (scores[(j + n) * side + i + n] === best) {
        si += i;
        sj += j;
        cnt++;
      }
    }
  }
  const du = (si / cnt) * STEP, dv = (sj / cnt) * STEP;
  return [px + ex * du + fx * dv, py + ey * du + fy * dv];
}

/** The version from the version information beside the top-right (or bottom-left) finder, read with at(du, dv) from its centre. */
function versionNear(at, topRight) {
  let bits = 0;
  for (let i = 0; i < 18; i++) {
    const a = (i % 3) - 7, b = Math.floor(i / 3) - 3;
    bits |= (topRight ? at(a, b) : at(b, a)) << i;
  }
  return nearestVersion(bits);
}

function transpose(g, dim) {
  const t = new Uint8Array(dim * dim);
  for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) t[x * dim + y] = g[y * dim + x];
  return t;
}

function sampleGrid(img, map, dim) {
  const g = new Uint8Array(dim * dim);
  for (let y = 0; y < dim; y++) {
    for (let x = 0; x < dim; x++) {
      const [px, py] = map(x + 0.5, y + 0.5);
      g[y * dim + x] = sample(img, px, py);
    }
  }
  return g;
}

function readGrid(img, map, dim) {
  if (!map) return null;
  const g = sampleGrid(img, map, dim);
  return decodeGrid(g, dim) ?? decodeGrid(transpose(g, dim), dim);
}

/**
 * Are there four of these points with no three on a line? Otherwise no
 * perspective transform is determined by them (one fitted anyway is degenerate).
 */
function inGeneralPosition(pts) {
  if (pts.length < 4) return false;
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const far = (from, score) => pts.reduce((best, p) => (score(p) > score(best) ? p : best), from);
  const a = pts[0], b = far(a, (p) => Math.hypot(p[0] - a[0], p[1] - a[1]));
  const c = far(a, (p) => Math.abs(cross(a, b, p)));
  if (Math.abs(cross(a, b, c)) < 1) return false;
  return pts.some((p) => Math.abs(cross(a, b, p)) >= 1 && Math.abs(cross(a, c, p)) >= 1 && Math.abs(cross(b, c, p)) >= 1);
}

/** A transform made of one per cell of the alignment grid, through its four corners (found, or else as `map` puts them). */
function cellwise(pos, found, map) {
  const k = pos.length, cells = [];
  const at = (i, j) => found[i * k + j] ?? map(pos[i] + 0.5, pos[j] + 0.5);
  for (let j = 0; j < k - 1; j++) {
    for (let i = 0; i < k - 1; i++) {
      const src = [[pos[i], pos[j]], [pos[i + 1], pos[j]], [pos[i], pos[j + 1]], [pos[i + 1], pos[j + 1]]].map(([u, v]) => [u + 0.5, v + 0.5]);
      cells.push(fitTransform(src, [at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)]) ?? map);
    }
  }
  const cellOf = (c) => {
    let i = 0;
    while (i < k - 2 && c > pos[i + 1]) i++;
    return i;
  };
  return (u, v) => cells[cellOf(v) * (k - 1) + cellOf(u)](u, v);
}

/** Reads the code whose finders are tl, tr, bl, or null. */
function readCode(img, { tl, tr, bl }) {
  const lx = Math.hypot(tr.x - tl.x, tr.y - tl.y), ly = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const ux = (tr.x - tl.x) / lx, uy = (tr.y - tl.y) / lx, vx = (bl.x - tl.x) / ly, vy = (bl.y - tl.y) / ly;
  // Each finder's module size along the code's own axes, each way, gives a
  // frame for reading what lies just beyond it. The side facing the quiet
  // zone is the surer: the inner side is used only when it agrees with it.
  const finders = [tl, tr, bl];
  const scales = (c, dx, dy, outward) => {
    const [fwd, back] = finderScale(img, c.x, c.y, dx, dy);
    let out = outward > 0 ? fwd : back, inner = outward > 0 ? back : fwd;
    out ??= inner ?? c.m;
    if (inner === null || Math.abs(inner - out) > out * 0.15) inner = out;
    return outward > 0 ? [out, inner] : [inner, out];
  };
  const ex = [scales(tl, ux, uy, -1), scales(tr, ux, uy, 1), scales(bl, ux, uy, -1)];
  const ey = [scales(tl, vx, vy, -1), scales(tr, vx, vy, -1), scales(bl, vx, vy, 1)];
  const mx = ex.map(([a, b]) => (a + b) / 2), my = ey.map(([a, b]) => (a + b) / 2);
  const frame = (k) => (du, dv) => {
    const a = du * ex[k][du >= 0 ? 0 : 1], b = dv * ey[k][dv >= 0 ? 0 : 1];
    return sample(img, finders[k].x + ux * a + vx * b, finders[k].y + uy * a + vy * b);
  };
  const frames = [frame(0), frame(1), frame(2)];
  const dimEst = (lx / ((mx[0] + mx[1]) / 2) + ly / ((my[0] + my[2]) / 2)) / 2 + 7;
  const vEst = (dimEst - 17) / 4;

  // The format information lies within 9 modules of the finders: read it in
  // each finder's own frame (true under perspective, whatever the version),
  // and give up on these three finders if it is not there.
  const d0 = Math.max(21, Math.round(vEst) * 4 + 17);
  const local = (x, y) => {
    const k = x + 0.5 > d0 / 2 ? 1 : y + 0.5 > d0 / 2 ? 2 : 0;
    return frames[k](x + 0.5 - (k === 1 ? d0 - 3.5 : 3.5), y + 0.5 - (k === 2 ? d0 - 3.5 : 3.5));
  };
  if (!formatPlausible(local, d0)) return null;

  // Versions to try: what the version information says, if it is plausible
  // for the size (below version 7 those modules are data, and random bits come
  // within 3 of some version's code one time in eight), then the nearest by size.
  const read = (vEst < 5 ? [] : [versionNear(frames[1], true), versionNear(frames[2], false)])
    .filter((v) => v && Math.abs(v.ver - vEst) <= 2 + vEst * 0.15)
    .sort((a, b) => a.dist - b.dist);
  const versions = [...new Set(read.map((v) => v.ver))];
  // Both copies naming the same version, or one within a bit, settles it
  const sure = read.length > 0 && (read[0].dist <= 1 || (read.length === 2 && read[0].ver === read[1].ver));
  const v0 = Math.min(40, Math.max(1, Math.round(vEst))), other = vEst > v0 ? 1 : -1;
  for (const d of sure ? [] : [0, other, -other, 2 * other]) {
    const v = v0 + d;
    if (v >= 1 && v <= 40 && !versions.includes(v) && versions.length < 4) versions.push(v);
  }

  for (const ver of versions) {
    if (img.budget.attempts-- <= 0) return null;
    const dim = ver * 4 + 17;
    let wider = 3; // searches of 7 modules after a miss nearer
    const src = [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5]];
    const dst = [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y]];
    let map = fitTransform(src, dst);
    if (!map) continue;
    // Alignment patterns, nearest the top-left first, each looked for where
    // a transform through its found neighbours puts it (which follows a lens
    // or a bent page), else where the transform through all found so far does.
    const pos = alignmentPositions(ver), k = pos.length;
    const corner = (i, j) => (i === 0 && (j === 0 || j === k - 1)) || (i === k - 1 && j === 0);
    const found = new Array(k * k).fill(null);
    const order = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) if (!corner(i, j)) order.push([i, j]);
    order.sort((a, b) => a[0] + a[1] - b[0] - b[1]);
    const nearby = (i, j) => {
      for (const r of [1, 2]) {
        const s = [], d = [];
        for (let a = Math.max(0, i - r); a <= Math.min(k - 1, i + r); a++) {
          for (let b = Math.max(0, j - r); b <= Math.min(k - 1, j + r); b++) {
            const p = corner(a, b) ? map(pos[a] + 0.5, pos[b] + 0.5) : found[a * k + b];
            if (!p) continue;
            s.push([pos[a] + 0.5, pos[b] + 0.5]);
            d.push(p);
          }
        }
        if (inGeneralPosition(s)) return fitTransform(s, d);
      }
      return null;
    };
    for (let n = 0; n < order.length; n++) {
      // The patterns next to the finders are the easiest to find: none of
      // them there means these are not the finders of a code of this version
      if (n === 6 && src.length < 5) break;
      const [i, j] = order[n], u = pos[i] + 0.5, v = pos[j] + 0.5;
      const near = nearby(i, j);
      const m = near ?? map;
      const [px, py] = m(u, v), [ax, ay] = m(u + 1, v), [bx, by] = m(u, v + 1);
      const R = near ? 3 : src.length > 3 ? 4 : ver < 7 ? Math.max(4, dim * 0.15) : 7;
      let p = findAlignment(img, px, py, ax - px, ay - py, bx - px, by - py, R);
      if (!p && R < 7 && wider-- > 0) p = findAlignment(img, px, py, ax - px, ay - py, bx - px, by - py, 7);
      if (p) {
        found[i * k + j] = p;
        src.push([u, v]);
        dst.push(p);
        map = fitTransform(src, dst) ?? map;
      }
    }
    let text = readGrid(img, map, dim);
    if (text !== null) return text;
    if (k >= 3 && src.length > 4) {
      // A lens or a curved page bends the grid: map each cell between
      // alignment patterns through its own four corners. Where the grid
      // meets a finder, the corner comes from that finder's centre and the
      // three alignment patterns nearest it.
      const corners = [[0, 0, tl, 3.5, 3.5, 1, 1], [k - 1, 0, tr, dim - 3.5, 3.5, -1, 1], [0, k - 1, bl, 3.5, dim - 3.5, 1, -1]];
      for (const [i, j, c, fu, fv, di, dj] of corners) {
        const s = [[fu, fv]], d = [[c.x, c.y]];
        for (const [a, b] of [[i + di, j], [i, j + dj], [i + di, j + dj]]) {
          if (found[a * k + b]) {
            s.push([pos[a] + 0.5, pos[b] + 0.5]);
            d.push(found[a * k + b]);
          }
        }
        const m = s.length === 4 ? fitTransform(s, d) : null;
        if (m) found[i * k + j] = m(pos[i] + 0.5, pos[j] + 0.5);
      }
      text = readGrid(img, cellwise(pos, found, map), dim);
      if (text !== null) return text;
    }
    if (src.length > 3) {
      // Perhaps a wrong alignment pattern: try the three finders and the parallelogram's fourth corner
      text = readGrid(img, fitTransform([...src.slice(0, 3), [dim - 3.5, dim - 3.5]], [...dst.slice(0, 3), [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y]]), dim);
      if (text !== null) return text;
    } else if (ver >= 2) {
      text = readGrid(img, fitTransform([...src, [dim - 3.5, dim - 3.5]], [...dst, [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y]]), dim);
      if (text !== null) return text;
    }
  }
  return null;
}

function readImage(image) {
  const { data, width, height } = image ?? {};
  if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;
  const f = Math.max(1, Math.ceil(Math.sqrt((width * height) / MAX_PIXELS)));
  const w = Math.floor(width / f), h = Math.floor(height / f);
  if (w < 21 || h < 21) return null;
  let gray = luminance(data, width, w, h, f);
  // Noise σ is about the median difference of neighbours. A noisy picture is
  // blurred (3×3, σ/3), and a block must then have more contrast than the
  // noise left in it can make (≈ 64 samples' range) to set a threshold.
  const noise = noiseLevel(gray, w, h);
  if (noise >= 3) gray = blur3(gray, w, h);
  const bin = binarize(gray, w, h, Math.max(20, noise * 2.5));
  if (!bin) return null;
  // Bounds the work on a frame full of finder look-alikes; a real code needs one to four
  const budget = { attempts: 10 };
  for (const inv of [0, 1]) {
    const img = { bin, w, h, inv, budget };
    for (const t of finderTriples(findFinders(img))) {
      const text = readCode(img, t);
      if (text !== null) return text;
    }
  }
  return null;
}

/**
 * The text of the first QR code found in `imageData` ({ data: RGBA bytes,
 * width, height }, as from getImageData), or null. Never throws.
 */
export function decodeQR(imageData) {
  try {
    return readImage(imageData);
  } catch {
    return null;
  }
}

/** The text of a QR code given as rows of modules (truthy = dark), without quiet zone; or null. */
export function decodeQRMatrix(modules) {
  try {
    const dim = modules.length;
    const g = new Uint8Array(dim * dim);
    for (let y = 0; y < dim; y++) {
      if (modules[y].length !== dim) return null;
      for (let x = 0; x < dim; x++) g[y * dim + x] = modules[y][x] ? 1 : 0;
    }
    return decodeGrid(g, dim) ?? decodeGrid(transpose(g, dim), dim);
  } catch {
    return null;
  }
}

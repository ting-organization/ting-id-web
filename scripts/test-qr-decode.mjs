#!/usr/bin/env node
// Tests the QR code reader (web/js/qr-decode.js) on codes from three makers:
// kit/web/qr.js (levels L and M, byte mode, every version), a fuller encoder
// written here (levels Q and H, numeric, alphanumeric, kanji and ECI
// segments, every mask; checked first against qr.js and the worked example of
// ISO/IEC 18004 annex I), and Core Image's CIQRCodeGenerator on macOS (fixed
// fixtures below). Codes are decoded from module grids, and from frames drawn
// here: turned, in perspective, blurred, noisy, dim, unevenly lit, among
// clutter, inverted, mirrored, damaged within and beyond what Reed–Solomon
// can correct, plus frames with no code at all. A last group goes past what
// is asked of the reader (steep angles, out of focus, lens distortion, 2 px
// modules, no quiet zone) and is measured, not required.
//
//   node scripts/test-qr-decode.mjs [seed]
//
// Prints a table and the time per 1280×720 frame, and exits 1 if a target is
// missed or the 95th percentile time is over 100 ms. A decode that returns
// other text than was encoded fails the run whatever the rate, in any group.
import { qrModules } from '../kit/web/qr.js';
import { decodeQR, decodeQRMatrix } from '../web/js/qr-decode.js';

const seed = Number(process.argv[2] ?? 20261112) >>> 0;
let state = seed || 1;
/** xorshift32: deterministic for a seed, so a failure can be replayed. */
const rnd = () => {
  state ^= state << 13;
  state >>>= 0;
  state ^= state >>> 17;
  state ^= state << 5;
  state >>>= 0;
  return state / 4294967296;
};
const uniform = (a, b) => a + (b - a) * rnd();
const int = (a, b) => Math.floor(uniform(a, b + 1));
const pick = (list) => list[Math.floor(rnd() * list.length)];
const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
const utf8 = (s) => new TextEncoder().encode(s);

// --- Payloads ----------------------------------------------------------------
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[int(0, 15)]).join('');
const WORDS = 'ting pay call program value amount fee memo node chain block wallet key sign send swap the a to of and with for'.split(' ');
const NON_ASCII = [...'äöüÄÖÜßéèêçñåøæ€£¥©°±µΩπλЖжПривет東京日本語中文漢字한국어😀🎉👍🔑'];

function tingPay(len) {
  let s = `ting:pay?to=${hex(64)}&net=${pick(['main', 'test', 'dev'])}`;
  if (len > s.length + 12) s += `&amount=${int(1, 99999)}.${int(0, 99)}`;
  if (len > s.length + 8) s += '&memo=' + Array.from({ length: len }, () => pick(WORDS)).join('+');
  return s.slice(0, Math.max(len, 85));
}
function tingCall(len) {
  let s = `ting:call?net=${pick(['main', 'test'])}&program=${hex(64)}&template=${pick(['transfer', 'swap', 'mint', 'vote', 'escrow'])}&values=`;
  while (s.length < len) s += pick([() => hex(64), () => String(int(0, 1e9)), () => `${hex(8)}%2C${int(0, 999)}`])() + ',';
  return s.slice(0, Math.max(len, 120));
}
const plainText = (len) => {
  let s = '';
  while (s.length < len) s += pick(WORDS) + pick([' ', ' ', ', ', '. ', '! ', '? ', '-', '/']);
  return s.slice(0, len);
};
const digits = (len) => Array.from({ length: len }, () => int(0, 9)).join('');
const nonAscii = (len) => {
  let s = '';
  while ([...s].length < len) s += rnd() < 0.4 ? pick(NON_ASCII) : pick(WORDS) + ' ';
  return s;
};
/** A payload of tens to ~1,500 characters, mostly Ting links. */
function payload(maxLen = 1500) {
  const r = rnd();
  const len = Math.min(maxLen, r < 0.4 ? int(20, 200) : r < 0.7 ? int(200, 700) : int(700, 1500));
  const kind = rnd();
  if (kind < 0.35) return tingCall(len);
  if (kind < 0.55) return tingPay(len);
  if (kind < 0.7) return plainText(len);
  if (kind < 0.8) return digits(len);
  return nonAscii(Math.max(5, Math.floor(len / 2)));
}

// --- A fuller encoder, for levels Q and H and segment modes qr.js lacks ------
const ECC = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NBLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const LEVEL_BITS = [1, 0, 3, 2]; // L, M, Q, H
const LEVEL_NAMES = 'LMQH';

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
/** Check codewords: the remainder of data·x^n by Π(x − α^i), i < n. */
function rsCheck(data, n) {
  let gen = [1];
  for (let i = 0, root = 1; i < n; i++, root = gfMul(root, 2)) {
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => {
      next[j] ^= c;
      next[j + 1] ^= gfMul(c, root);
    });
    gen = next;
  }
  const rem = new Array(n).fill(0);
  for (const b of data) {
    const f = b ^ rem.shift();
    rem.push(0);
    for (let j = 0; j < n; j++) rem[j] ^= gfMul(gen[j + 1], f);
  }
  return rem;
}

function alignmentCentres(ver) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2, size = ver * 4 + 17;
  const step = ver === 32 ? 26 : Math.ceil((size - 13) / (count * 2 - 2)) * 2;
  const pos = [6];
  for (let p = size - 7; pos.length < count; p -= step) pos.splice(1, 0, p);
  return pos;
}

const layouts = new Map();
/**
 * Where everything sits in a code of this version and level: function
 * modules, the data modules in bit order, and which block and position each
 * interleaved codeword belongs to.
 */
function layout(ver, level) {
  const key = ver * 4 + level;
  if (layouts.has(key)) return layouts.get(key);
  const dim = ver * 4 + 17;
  const fn = new Uint8Array(dim * dim);
  const mark = (x0, y0, w, h) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) fn[y * dim + x] = 1;
  };
  mark(0, 0, 9, 9);
  mark(dim - 8, 0, 8, 9);
  mark(0, dim - 8, 9, 8);
  mark(6, 0, 1, dim);
  mark(0, 6, dim, 1);
  const pos = alignmentCentres(ver), k = pos.length - 1;
  for (let i = 0; i <= k; i++) for (let j = 0; j <= k; j++) if (!((i === 0 && j === 0) || (i === 0 && j === k) || (i === k && j === 0))) mark(pos[i] - 2, pos[j] - 2, 5, 5);
  if (ver >= 7) {
    mark(dim - 11, 0, 3, 6);
    mark(0, dim - 11, 6, 3);
  }
  const order = [];
  for (let right = dim - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < dim; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? dim - 1 - vert : vert;
        if (!fn[y * dim + x]) order.push(y * dim + x);
      }
    }
  }
  const total = order.length >> 3, nb = NBLOCKS[level][ver], ecc = ECC[level][ver];
  const shortLen = Math.floor(total / nb), shortCount = nb - (total % nb), shortData = shortLen - ecc;
  const cwBlock = [], cwIndex = [];
  for (let i = 0; i <= shortData; i++) for (let b = 0; b < nb; b++) if (i < shortData || b >= shortCount) cwBlock.push(b), cwIndex.push(i);
  for (let i = 0; i < ecc; i++) for (let b = 0; b < nb; b++) cwBlock.push(b), cwIndex.push(shortData + (b >= shortCount ? 1 : 0) + i);
  const owner = new Int32Array(dim * dim).fill(-1);
  for (let i = 0; i < total * 8; i++) owner[order[i]] = i >> 3;
  const guard = ver === 1 ? [3, 2, 1, 1][level] : ver === 2 && level === 0 ? 2 : ver === 3 && level === 0 ? 1 : 0;
  const result = { dim, fn, order, total, nb, ecc, shortLen, shortCount, shortData, cwBlock, cwIndex, owner, t: (ecc - guard) >> 1 };
  layouts.set(key, result);
  return result;
}

const MASK_FNS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** Segment bits for a version: [{ mode: 'numeric'|'alnum'|'byte'|'kanji'|'eci', value }]. */
function segmentBits(segments, ver) {
  const bits = [];
  const put = (v, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  const size = ver < 10 ? 0 : ver < 27 ? 1 : 2;
  for (const { mode, value } of segments) {
    if (mode === 'numeric') {
      put(1, 4);
      put(value.length, [10, 12, 14][size]);
      for (let i = 0; i < value.length; i += 3) {
        const g = value.slice(i, i + 3);
        put(Number(g), [0, 4, 7, 10][g.length]);
      }
    } else if (mode === 'alnum') {
      put(2, 4);
      put(value.length, [9, 11, 13][size]);
      for (let i = 0; i < value.length; i += 2) {
        if (i + 1 < value.length) put(ALNUM.indexOf(value[i]) * 45 + ALNUM.indexOf(value[i + 1]), 11);
        else put(ALNUM.indexOf(value[i]), 6);
      }
    } else if (mode === 'byte') {
      put(4, 4);
      put(value.length, [8, 16, 16][size]);
      for (const b of value) put(b, 8);
    } else if (mode === 'kanji') {
      put(8, 4);
      put(value.length, [8, 10, 12][size]);
      for (const c of value) {
        const t = c - (c <= 0x9ffc ? 0x8140 : 0xc140);
        put((t >> 8) * 0xc0 + (t & 0xff), 13);
      }
    } else if (mode === 'eci') {
      put(7, 4);
      if (value < 128) put(value, 8);
      else if (value < 16384) put(0x8000 | value, 16);
      else put(0xc00000 | value, 24);
    }
  }
  return bits;
}

/** A code for the segments at `level` (0–3) with the given mask: modules, version, codewords. */
function encode(segments, level, mask, minVersion = 1) {
  let ver = minVersion, bits;
  for (; ; ver++) {
    if (ver > 40) return null;
    bits = segmentBits(segments, ver);
    const lay = layout(ver, level);
    if (bits.length <= (lay.total - lay.nb * lay.ecc) * 8) break;
  }
  const lay = layout(ver, level), dim = lay.dim, capacity = (lay.total - lay.nb * lay.ecc) * 8;
  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) for (let i = 7; i >= 0; i--) bits.push((pad >> i) & 1);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  const blocks = [];
  for (let b = 0, k = 0; b < lay.nb; b++) {
    const len = lay.shortData + (b >= lay.shortCount ? 1 : 0);
    const d = data.slice(k, k + len);
    k += len;
    blocks.push(d.concat(rsCheck(d, lay.ecc)));
  }
  const codewords = lay.cwBlock.map((b, i) => blocks[b][lay.cwIndex[i]]);

  const g = new Uint8Array(dim * dim);
  const set = (x, y, v) => (g[y * dim + x] = v ? 1 : 0);
  for (const [cx, cy] of [[3, 3], [dim - 4, 3], [3, dim - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && y >= 0 && x < dim && y < dim) set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  for (let i = 8; i < dim - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const pos = alignmentCentres(ver), k = pos.length - 1;
  for (let i = 0; i <= k; i++) {
    for (let j = 0; j <= k; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === k) || (i === k && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  for (let i = 0; i < lay.total * 8; i++) g[lay.order[i]] = (codewords[i >> 3] >> (7 - (i & 7))) & 1;
  for (let y = 0; y < dim; y++) for (let x = 0; x < dim; x++) if (!lay.fn[y * dim + x] && MASK_FNS[mask](x, y)) g[y * dim + x] ^= 1;
  const value = (LEVEL_BITS[level] << 3) | mask;
  let rem = value;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const f = ((value << 10) | rem) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const b = (f >> i) & 1;
    const [x1, y1] = i < 6 ? [8, i] : i < 8 ? [8, i + 1] : i === 8 ? [7, 8] : [14 - i, 8];
    const [x2, y2] = i < 8 ? [dim - 1 - i, 8] : [8, dim - 15 + i];
    set(x1, y1, b);
    set(x2, y2, b);
  }
  set(8, dim - 8, 1);
  if (ver >= 7) {
    let r = ver;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const v = (ver << 12) | r;
    for (let i = 0; i < 18; i++) {
      set(dim - 11 + (i % 3), Math.floor(i / 3), (v >> i) & 1);
      set(Math.floor(i / 3), dim - 11 + (i % 3), (v >> i) & 1);
    }
  }
  const modules = Array.from({ length: dim }, (_, y) => Array.from(g.subarray(y * dim, (y + 1) * dim), Boolean));
  return { modules, ver, level, mask, data, codewords };
}

/** The level and mask of a module grid, from its first format copy. */
function formatOf(modules) {
  let f = 0;
  for (let i = 0; i < 15; i++) {
    const [x, y] = i < 6 ? [8, i] : i < 8 ? [8, i + 1] : i === 8 ? [7, 8] : [14 - i, 8];
    f |= (modules[y][x] ? 1 : 0) << i;
  }
  f ^= 0x5412;
  return { level: LEVEL_BITS.indexOf(f >> 13), mask: (f >> 10) & 7 };
}

// Shift JIS double-byte codes that decode to a kanji, for kanji segments
const SJIS = [];
{
  const dec = new TextDecoder('shift_jis');
  for (const [lo, hi] of [[0x889f, 0x9ffc], [0xe040, 0xeaa4]]) {
    for (let c = lo; c <= hi; c += 7) {
      if ((c & 0xff) < 0x40 || (c & 0xff) === 0x7f || (c & 0xff) > 0xfc) continue;
      const s = dec.decode(new Uint8Array([c >> 8, c & 0xff]));
      if (s.length === 1 && s !== '�') SJIS.push([c, s]);
    }
  }
}

/** A random multi-segment message as the encoder input and the text it should read as. */
function segmentMessage() {
  const segs = [];
  let text = '';
  const kinds = ['numeric', 'alnum', 'byte', 'kanji', 'eci-utf8', 'eci-latin1'];
  const n = int(1, 4);
  for (let i = 0; i < n; i++) {
    const kind = pick(kinds), len = int(1, 60);
    if (kind === 'numeric') {
      const v = digits(len);
      segs.push({ mode: 'numeric', value: v });
      text += v;
    } else if (kind === 'alnum') {
      const v = Array.from({ length: len }, () => pick([...ALNUM])).join('');
      segs.push({ mode: 'alnum', value: v });
      text += v;
    } else if (kind === 'byte') {
      const v = plainText(len);
      segs.push({ mode: 'byte', value: utf8(v) });
      text += v;
    } else if (kind === 'kanji') {
      const chars = Array.from({ length: Math.ceil(len / 3) }, () => pick(SJIS));
      segs.push({ mode: 'kanji', value: chars.map((c) => c[0]) });
      text += chars.map((c) => c[1]).join('');
    } else if (kind === 'eci-utf8') {
      const v = nonAscii(Math.ceil(len / 2));
      segs.push({ mode: 'eci', value: 26 }, { mode: 'byte', value: utf8(v) });
      text += v;
    } else {
      const v = Array.from({ length: len }, () => pick([...'abcxyzäöüßéñçÅØ¿¡ 0123'])).join('');
      segs.push({ mode: 'eci', value: 3 }, { mode: 'byte', value: Uint8Array.from(v, (c) => c.charCodeAt(0)) });
      text += v;
    }
    // An ECI holds until the next one: return to UTF-8 so later byte segments read as written
    if (kind.startsWith('eci') && i < n - 1) segs.push({ mode: 'eci', value: 26 });
  }
  return { segs, text };
}

// Codes made by Core Image's CIQRCodeGenerator (macOS) from UTF-8 text: level,
// size, text, modules row by row (dark = 1, most significant bit first, base64).
const CORE_IMAGE = [
  ["H", 21, "hello",
    '/gv8EBButLt1RdujrsERB/qv4A4AG3BlKx81tU+am0T4PQBXK/qIkE6Puqjd1eQujf8E///iQAA='],
  ["Q", 21, "01234567",
    '/qv8FtBuoLt15duoLsExB/qv4BkAa2L6ZSiswdza2yKm8IBNC/viMEtLuqrt0auupcsF+4/ncoA='],
  ["M", 21, "HELLO WORLD",
    '/iv8FxBuirt0VdurrsE5B/qv4AAAqkiTxIRH9LHrOuT1OoBRF/glkExousv90aiuvdMEOL/tcIA='],
  ["L", 29, "Grüße aus Zürich – 東京 😀 ting:pay",
    '/u2b/BcjUG6seLt1rwXboDOuwU8VB/qqr+AJcgDOEFl7q1Es6OetRSNjCsa6m+YGgyRyaZmbmq1EJluT6yZlQDzOzzIac+NsjXqN/QBy3FP4g+swWTMTuvh/3dF6a26eYgcFphy/7RatAA=='],
  ["Q", 45, "ting:pay?to=c20ac803923e315b3f228cbf5e1cdd119ca35321917d255ff12e07cf5126ca59&net=main",
    '/sPo/8v8ESTwLpBuiqh8pLt0ROJMtduuEP+HrsFS1EPhB/qqqqqv4AfdEMEAf2ov3+mMwlzBAi8U2Lyz9q7C5S2FUoapWiqGarBJHFj0rJ3+TotQijFYb+h5kjv3AdEmQaVaAP/ZtDxKOAWIxgQpjiH6Av1y+CRsZEkcdmrB60GqlRUxHvcc77vv4g+ZRBfp+y1l+bVgNooJmV7tMN/k+tmp0Tyc97qxYh3RbC915Kj1ltAwM+z022/gQmVoISMCvmTw+4ryDaomIqmpYPzb+QBGPEo0b/qtqy2qkFLDHekbuvg/0J+l1SxsWO+urgcyK5EFjifqEE/l6Sr++QA='],
  ["H", 53, "ting:pay?to=c48b28aea282079823d83fe3ae6e07240a57fc0a1ddfd150c841246cd12ae4a1&net=test&amount=12.5",
    '/jEj2oMj/BDrCGSpkG6iQ+6jRLt1Kvs3r1Xbp/7PvyIuwSjqxBPRB/qqqqqqr+AIwnF2/wAbB337wahlbNUIjN3P9L3BivNgXPkCcQE30QqnVAMPJbEYWXo5ThP2earCiLVMt4unbyOfp8bLHqAe98hg40P1PfWb/SlSDrdiQlbVcDS2aW9gf0jHbOCKjb8dQ/qM0kumaPr+oYpBe+XHr/Bp+XG/qEQxFGvSRCqvBKrwuqGRVokVNNGX/Wj/jGb+Bi/3v+xFbp7Ym1Yv2fkMGnnoVZRCJqsnOL9/ZqounluVHrIvL39TcMPo7kbouQsr5sHMr3CUVPtCK7L0j2N1au4usKl1JWDjC1cDztJubFAJghjED5r3l+wizmS2wgdtJ0ffYSSPP56T/oBTO0ZUXFv7m+a8fmrQQ7GRfjcaurp8/C9fxdThaklrKq6DFmOWYocESrZR2Vtf4JszPA6UAA=='],
  ["M", 69, "ting:call?net=main&program=53cebb680356458570443165170e56cd986077e51ab708d012c9db814338f87d&template=transfer&values=e4cb5500,e8aa98a6,b7f65154,39aded89,c5a35131,ee8bea5a,8debd39a,654a6d30,93fa9bc5,4568d5d5,6cef7f59,92bf36b3,55cb4bb9,687bf325,b24dd826,7f0f366b,b87ddc23,356315eb,9d841d49,28a8b467,f36",
    '/iRqkUiCcvv8EUgnqE3q/BBusxcs19GrCLt1BoTMJhHgldutv+i/xx02rsFWPMDEV6NxB/qqqqqqqqqv4BCNCZFIfqYAvlGeg/yAqIvhLiVCPFq82FiJ6uDoRCtT9GpgspbclEfjjCeyzFc7AJVgmth++/FWumQvi7oaa3GGYW4n26FcVVvy/ormFkjKhAJkx6p6Y2HAl/+yNHEfnm/rAk9D+jzz5z018K9krmt6bK1BU493voD2EQV+CoE2k3unxcFt4X+Pr4toeYBL/q5szxgOYxFxpJtKrvhIN18Gs+OeyRz2UCgWMKEy+NVeFK0gTdIyxWQVSgxsEqrgrwlVKg+v5pjk+k0yhS8GDLqqcuVoTAz0P7NNwv9lxy+gRM91tEeOCkYGsmv4qm4vpr8x/nhjHotAcVL7cn9vxg2w/4rD8GwphsOqCVvVHxDG4jtwgCPZ7VHiXSQ+4i5J8Xheg/4t47givpGgCgiNjQ4/Ky/R9w7D2k8eLGVDUswythduHsFgMuSCDzMoUmE86vmbkBK3tEl946lOaQzI9pQUWu4usipIG2Z7bhhWlguOoRwrzWWDcyNG909bIJQ1QaVig4ltr885xw/hosDK+XEwfYuDKilv4+fw4DnmVby8oZDg1IwbBuXZA8y4AYE4xhzfEg+NIiero3Ega75C9kkD7XE1Pr9KSemoldkf2wwf+IBHoVXHt4Okd/iaLtKi0GcrMFOfN1Fo3o8Wuozfxf0Zpz+V1+adm+djumIur45/ZX9G5akEKlni3ozKws/q+sdBAB1xewA='],
  ["H", 105, "ting:call?net=main&program=1451968c4e2c6492411a40048b736d3ed7600dcfa177652361a8e172cf059c34&template=transfer&values=e09e3376,a3394f92,daff2b24,8169fdd6,cb6cd1f7,b5cd3025,dfec7b61,1c43b986,3d77fbd1,a1507e51,1e84530c,fb6328a4,62f97c12,1452245f,6c9aee45,99514e51,3f7235dd,4a1afeab,da4945ed,ec4b69c2,f38fb988,7c63a39d,a544845f,0de2d887,9746a7c6,48e57cbc,b1270677,f4a5a4df,55a6dc52,6d773e2b,e0433f6c,60d27f57,17b269ab,c1d380",
    '/skwASloRKWtT/CqP8Fqmj6rHSHp08ikCxBupP48nF5lsjck023Lt0MMHv0tcqkx5AfiFdujcV+oI7/F7c/vDNrsF4aMeKv8ZKm8SlmJB/qqqqqqqqqqqqqqqv4BDI0SKqERE+scEugAOtCX/L8+/e1i+SdT84DROLIEPQbWq0/IlIAGiGBcpMfIGrr8m+Ewoa0yisqUtCx9gEgNIujgWt7AJPGuyktCvSyqoKwmHeOB0UQAfDNiijg/xaoohmPvl9hiChTTzlPgflayZtAvmkKGk5gqWkzUT9fz6DfS665ZEimfhCNLha1hnioU23TVvUb3HTIgKyFl0YnCg+Ii4mo+wWKmoAd6eJLA842BKQ5W4W7ox7RTjwquMNjZWaPPgpq0BXSwgeezxxM+nW0TlwL6jDwfp2Y+sMgqP8e//O/b/PR5/SIT+7R1Scfo5kWMAkcq/0SSqIVrAzRrXwZreylqxxSyUVLHsebj0cmkkdf4l++fek/b1d+L6X+6g2saxevej9tjK5PPY/ga4xH+IYCEd27gVBvqYCKgO49xviXugknMMxPQCC/X483hRE5eA4YK5jUcyAN0+xAIlXYgnlkobdKeK8N/t1kI4QG9iEGAHDWYUmElMkn1BztfCkaGJV0U9DS4L2vL42ohPV8jMYRtwW6apSGppUNHR2A4y1ijO+nKJ1YGqUBn8UADwjZ8iJTkZLg+3J5S0qT5IyA0xp6vDpP6Rtyyl8eC5uhZyXTjwpQYqaahTL7hPxwXlEQ2pqooCOmwVc2x7aCX5CEpbaOiMs5QZfBNsIT+abwaY6/GCGrAlWktkMSbmYSgLKgm2rEtYSuYf6Ip+A/i//+e+Uom+6Rd5URCccTBuMXDfsUqsNvq4GHqlmArllhqhxAUcX+j0XqzMVUykc3+Ny+C8y/cc7/VZq++SIRBwYqK8xlszQ3Fsa5ldlZjPGI6iJhs1TsS2HEqtaTs3UsewahskxwdYm9efC1HVToO7MAC4AwvRSFe5m9gfNkutCDVcrywShHBRswzrL++NZyzhLSbm+0phMui3o2bqEfdKOBX6ywZxAzD2pNvCA/mjC5iEk4psX7Y+erRSamkymYimj/Dd3Td60F3qqDMyrf97gZe6j+SYW43wcRxXSH1cPFZQkrp9Is04xQlK1Nw3Oz6hkny4CuhjPpN1fPcs2AOJkz4Ot6GjqmYr/FT9H5fSSu6gbUdYldXNC/UmEyabGa02jbV1Zn1NioYqvZRz8reBrv3EGBMn4S0+WP1+n0z/TeP+dRBz8XgmMVrrMfBaEQ2ui3qubNrSzCrDl/q9RrjscCXUcoyEUocEc/51x+lSh/6HT+W8e+46b0/W5XCO7Rmni+IKLhyaZ+WveG8gJgB9d5wbQ17s3yaETsEEMm224BI7ZAVwtFi7f8G83B7Of5AX67j1A1A+KjCoyQOM1rwNq2+FF5yj5GEnAJMoCjIqNEUk8t6Y6FCjHqHGyhWpWdmb9zZFVRkJlTgXvUm7V+RA0tqw4G+x83ELFBqzyNkel6aBlqskGgcgn95wL7wP4Dm5S5SpnISaDcmzJLC9sROfmLh3kwSjmfTzOCdzcJkFgX2tIFkl9SIuOE2keikvihWc6RtX2VXsSI0LZ4mWox7JkzEzUdO54+TkMwThEIcghEcVVxZc5Dm1rk5jhrmkkA1GufM/Pwb/xiy+qKS+gBP6ETGa8SmZMfo8MZ/hKUqfdYqlPUq0MGr0Ej4EVjM8RB7MesPERur8r/WSH/ssC/WBD/91L5+5KKufzrJ3gTnouoyHDokAjRs13iljqkEKPX+zp6ZuYuBoEEg/k9oNwAXR5K/e2cfWwA='],
  ["Q", 117, "ting:call?net=main&program=ee8f52659ecae5e7c30624a59baf4d346f8c42c0159b27e9abd0250d69200f66&template=transfer&values=c007bd4e,62633182,150626aa,fa525916,243db409,23f27753,13138fc1,ef1926e1,9da61938,3a96fcc5,fe109d16,8d1bc0de,fa7ba7fc,30cfdeac,1feba038,42e53abf,9fc46a51,42a08b87,1ef4a75d,d03d9e5e,40401403,52981676,0f705954,ac25fe69,dd176c0b,06f9a2e5,55ca12ef,ad6bab89,94a36a3f,871bfb13,701662e2,e6f9ce5f,781f7c56,0ce6888a,be9279e0,7985bdaf,76cf59df,3cf4214a,b3ded500,5a94bb75,5d7263ae,94bebfce,7fde29b9,52462e38,53c0923a,6515364c,d62955ff,1210349d,53d36449,751c16fd,acbdb4ae,77405774,3686be3f,c5f30fd9,04d7cd9b,193a14d8,30abd728,0286f91f,12abe9b5,2217904e,7a8c441e,a3ebbf97,582bed0a,cccfef4d,d5eca3a",
    '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'],
  ["L", 129, "ting:call?net=main&program=ee852c7c0a9ab8795488d72d87049905295f5fa5d8577d9342af7e7db5803f39&template=transfer&values=1b601774,2f14e660,41063d61,41632008,fcfd8ce8,3110853e,2ecee09a,822779d3,64454e18,5567baa5,04497a96,02afc731,bbdf986e,061d5cbf,4ef8a76f,0c6c6ca5,e375b299,1b12ec8c,57dbe2bb,0e2bbc98,dc73d56b,704cc12e,b9552fca,16ee0c2d,7e30dba3,c202ab06,afe4e1f7,28b03cee,e1cf0628,2ca7f35f,4826ac31,64d8c03c,ab555dbc,d266f931,2bd17d05,ff41e1ee,0a7e9be2,befc092e,e320bbab,a1da79d0,e2e30c04,d434bc25,5b186514,5573b406,9e07c10c,ed081281,9296e39c,fe8251d1,c906d950,80bcf6c7,266143e8,0dbb399d,c7416a95,f9d21c26,29b2d731,f26a4b2f,7391d08c,8888e5d8,3d5a15fd,2d8b600f,0f1047db,77362cd6,d5c59516,d8c8ff14,006e3cec,c3b6506f,9af53f82,23e34d61,fb7b6361,0edc10e5,9de477fa,1c3ec7cd,cb700d7b,66f7fdfb,6b907e00,3f38022b,f9312465,aea062e3,9315d34f,079796fe,235b937a,2fe8ffc6,ae589f3d,21961305,2f11f5f7,b17eee9d,8b3dbfcc,50bcef09,9a9e6779,817326fd,dc27be2e,40763ef0,bab929b1,07367077,5b77457e,2db520c8,d43088cb,23dfa1e2,747fa5b5,2673c873,026c39eb,5c93a648,9f3fe065,7ee16d1b,3d2e56d0,83f86125,b92b2e0f,e935dbd1,e3fbc850,409eb96b,3cbfb413,d9cbd03d,db6db1b6,9bf632b9,cb0dac87,da42c49c,723f23ae,1f0c83cd,81bb3fb9,458655ec,98e08ce2,dc2873b4,f1deabd6,3f97d49f,251bdbf8,cff77c74,948b30e1,3bef0454,00746e79,dd2a05a6,c66976d0,1fa67d26,d5a7ec91,be8b6bf3,d7a4214d,1595e1a2,a81d2c95,62d0bb77,36362e30,6fd9139e,ea0572d0,8a338a7a,17969fbc,c8faa3c8,b435ab73,3056e762,52d672b9,4f4f2e61,a94ffea3,99a9be56,46d48efe,c1f14e94,82866ecb,936088",
    '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'],
  ["Q", 141, "ting:call?net=main&program=947c8a301c01dc91e3cd3150be6cc9a142ecb3c03f0e6f2fed6b01a7acf0cdee&template=transfer&values=9c7704c9,aa29af02,b2b15fe8,0c9b4d1b,ccb92ed1,c01efb5d,2667f2aa,e6993c1d,93688b1b,29d403e1,2b26d32f,b668a94d,ed48e2fa,ea689b25,1656e293,dc9c0ae9,2950581e,8a9d0be2,dee2e747,6108bdfa,5993ade8,e5b0df78,8954a798,46198086,5eb377cc,1a1ad81e,1985d533,be10de51,c24982e8,1564696d,4864813e,86c2d85b,6c565b38,27e7b775,f7ba9c73,e9ac538e,8449f2b0,745fbd83,fddd3f50,be8bfa73,ae013f15,df14da64,15cb79dc,b4db8c55,58de97db,abf33854,aed313aa,06f1dc76,c03e21de,14610f3e,4ec61c7b,dfeacc4b,4740769d,4e62c8ad,9d4884b2,2893e350,a232925a,7532206b,6aa9e825,0f29f043,6baa5df4,11235736,84817310,e47f49aa,6534ce82,8263d9fc,10fbeb17,3d095c25,ed398047,7547a267,fe5dde54,e735f0ca,005f32b0,c6861b14,68039659,79bb97c8,b20f72f0,230ca958,5f675122,5d5341b6,e41f7d3f,fc67359a,10af6e74,e57f502c,b6f9ac9b,1ab728db,6dbfd674,5374b5a5,a247e14d,43c8b06d,1320de86,6624550d,96ce70a7,285d843b,2eadd1e2,5e6d3a9f,c6311f44,e1f7651f,d",
    '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'],
];
function unpack(dim, b64) {
  const bytes = Buffer.from(b64, 'base64');
  return Array.from({ length: dim }, (_, y) => Array.from({ length: dim }, (_, x) => ((bytes[(y * dim + x) >> 3] >> (7 - ((y * dim + x) & 7))) & 1) === 1));
}

// --- Drawing frames ------------------------------------------------------------
/** Solves A x = b (n×n, Gaussian elimination with partial pivoting). */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = A[r][c] / A[c][c];
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = b[r];
    for (let k = r + 1; k < n; k++) v -= A[r][k] * x[k];
    x[r] = v / A[r][r];
  }
  return x;
}
/** Coefficients of the projective map taking from[i] to to[i] (four points). */
function homography(from, to) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return solve(A, b);
}

/**
 * Where the corners of the code and its quiet zone land in the frame: the code
 * square (module size m at the camera's focal distance) turned by `rotation`,
 * tilted by `tilt` about an axis in its plane at angle `axis`, seen through a
 * pinhole of focal length f centred at (cx, cy).
 */
function project(n, q, m, rotation, tilt, axis, f, cx, cy) {
  const c = Math.cos(rotation), s = Math.sin(rotation), ct = Math.cos(tilt), st = Math.sin(tilt);
  const kx = Math.cos(axis), ky = Math.sin(axis);
  return [[-q, -q], [n + q, -q], [n + q, n + q], [-q, n + q]].map(([u, v]) => {
    const x0 = (u - n / 2) * m, y0 = (v - n / 2) * m;
    const X = x0 * c - y0 * s, Y = x0 * s + y0 * c;
    const kv = kx * X + ky * Y;
    const Xr = X * ct + kx * kv * (1 - ct), Yr = Y * ct + ky * kv * (1 - ct), Zr = (kx * Y - ky * X) * st;
    return [cx + (f * Xr) / (f + Zr), cy + (f * Yr) / (f + Zr)];
  });
}

function drawClutter(refl, W, H, fakeFinders) {
  const box = (x0, y0, w, h, v) => {
    for (let y = Math.max(0, y0 | 0); y < Math.min(H, (y0 + h) | 0); y++) for (let x = Math.max(0, x0 | 0); x < Math.min(W, (x0 + w) | 0); x++) refl[y * W + x] = v;
  };
  const shapes = int(20, 50);
  for (let i = 0; i < shapes; i++) {
    const kind = rnd(), x = uniform(-50, W), y = uniform(-50, H), v = rnd();
    if (kind < 0.35) box(x, y, uniform(5, 250), uniform(5, 250), v);
    else if (kind < 0.55) {
      const rx = uniform(5, 120), ry = uniform(5, 120);
      for (let yy = Math.max(0, (y - ry) | 0); yy < Math.min(H, y + ry); yy++) {
        for (let xx = Math.max(0, (x - rx) | 0); xx < Math.min(W, x + rx); xx++) if (((xx - x) / rx) ** 2 + ((yy - y) / ry) ** 2 < 1) refl[yy * W + xx] = v;
      }
    } else if (kind < 0.7) {
      const a = uniform(0, Math.PI), len = uniform(30, 600), t = uniform(1, 5);
      for (let k = 0; k < len; k += 0.5) box(x + Math.cos(a) * k, y + Math.sin(a) * k, t, t, v);
    } else if (kind < 0.85) {
      // lines of "text"
      const size = int(3, 9), rows = int(1, 6), cols = int(5, 40);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (rnd() < 0.7) box(x + c * size * 1.3, y + r * size * 2, size * uniform(0.4, 1.1), size, v * 0.4);
    } else {
      // a patch of checks
      const cell = int(2, 8), cells = int(4, 20);
      for (let r = 0; r < cells; r++) for (let c = 0; c < cells; c++) if ((r + c) % 2 === 0) box(x + c * cell, y + r * cell, cell, cell, v * 0.3);
    }
  }
  // Finder-like squares that are not part of a code
  for (let i = 0; i < fakeFinders; i++) {
    const u = int(3, 9), x = uniform(0, W - 7 * u), y = uniform(0, H - 7 * u);
    box(x - u, y - u, 9 * u, 9 * u, 0.95);
    box(x, y, 7 * u, 7 * u, 0.05);
    box(x + u, y + u, 5 * u, 5 * u, 0.95);
    box(x + 2 * u, y + 2 * u, 3 * u, 3 * u, 0.05);
  }
}

function gaussianBlur(img, W, H, sigma) {
  if (sigma < 0.3) return img;
  const r = Math.ceil(sigma * 2.5), k = [];
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * img[y * W + Math.min(W - 1, Math.max(0, x + i))];
      tmp[y * W + x] = v;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.min(H - 1, Math.max(0, y + i)) * W + x];
      out[y * W + x] = v;
    }
  }
  return out;
}

/**
 * An RGBA frame showing `modules`. Options: width, height, quiet, px (module
 * size), rotation, tilt (degrees), blur (σ in pixels), noise (σ in levels),
 * lo/hi (levels of dark and light), gradient (0–1 light fall-off across the
 * frame), clutter, fakeFinders, invert, blot { u, v, r, dark } in modules,
 * barrel (lens distortion k: radius scaled by 1 + k·r², r = 1 at the frame's
 * half-width). Null if the code does not fit in the frame.
 */
function drawFrame(modules, o) {
  const n = modules.length, q = o.quiet, W = o.width, H = o.height;
  const f = 0.9 * Math.max(W, H);
  const rot = ((o.rotation ?? 0) * Math.PI) / 180, tilt = ((o.tilt ?? 0) * Math.PI) / 180, axis = uniform(0, Math.PI);
  let corners = null;
  for (let attempt = 0; attempt < 30 && !corners; attempt++) {
    const cx = attempt < 29 ? uniform(0.25, 0.75) * W : W / 2, cy = attempt < 29 ? uniform(0.25, 0.75) * H : H / 2;
    const c = project(n, q, o.px, rot, tilt, axis, f, cx, cy);
    if (c.every(([x, y]) => x >= 2 && y >= 2 && x <= W - 3 && y <= H - 3)) corners = c;
  }
  if (!corners) return null;
  const h = homography(corners, [[-q, -q], [n + q, -q], [n + q, n + q], [-q, n + q]]);

  const refl = new Float32Array(W * H).fill(o.background ?? uniform(0.6, 0.95));
  if (o.clutter) drawClutter(refl, W, H, o.fakeFinders ?? 0);
  const dark = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) dark[y * n + x] = modules[y][x] ? 1 : 0;
  const blot = o.blot;
  const codeRefl = (u, v) => {
    let d = 0;
    const iu = Math.floor(u), iv = Math.floor(v);
    if (iu >= 0 && iv >= 0 && iu < n && iv < n) d = dark[iv * n + iu];
    if (blot && (u - blot.u) ** 2 + (v - blot.v) ** 2 < blot.r * blot.r) d = blot.dark ? 1 : 0;
    return o.invert ? d : 1 - d;
  };
  const xs = corners.map((c) => c[0]), ys = corners.map((c) => c[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(W - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(H - 1, Math.ceil(Math.max(...ys)));
  const ss = o.px < 5 ? 3 : 2;
  const [X0, X1, Y0, Y1] = o.barrel ? [0, W - 1, 0, H - 1] : [x0, x1, y0, y1];
  for (let y = Y0; y <= Y1; y++) {
    for (let x = X0; x <= X1; x++) {
      const i = y * W + x, bg = refl[i];
      let acc = 0, inside = false;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          let px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          if (o.barrel) {
            const R = Math.max(W, H) / 2, dx = (px - W / 2) / R, dy = (py - H / 2) / R, k = 1 + o.barrel * (dx * dx + dy * dy);
            px = W / 2 + dx * k * R;
            py = H / 2 + dy * k * R;
          }
          const z = h[6] * px + h[7] * py + 1, u = (h[0] * px + h[1] * py + h[2]) / z, v = (h[3] * px + h[4] * py + h[5]) / z;
          if (u >= -q && v >= -q && u < n + q && v < n + q) {
            acc += codeRefl(u, v);
            inside = true;
          } else acc += bg;
        }
      }
      if (inside) refl[i] = acc / (ss * ss);
    }
  }

  const lo = o.lo ?? 25, hi = o.hi ?? 230, g = o.gradient ?? 0;
  const ga = uniform(0, 2 * Math.PI), gx = Math.cos(ga), gy = Math.sin(ga), gl = Math.abs(gx) * W + Math.abs(gy) * H;
  const gx0 = gx < 0 ? W : 0, gy0 = gy < 0 ? H : 0;
  const spotX = uniform(0, W), spotY = uniform(0, H), spotR = uniform(0.2, 0.5) * Math.max(W, H), spot = g > 0 ? uniform(0, 0.3) : 0;
  let img = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = ((x - gx0) * gx + (y - gy0) * gy) / gl;
      const light = (1 - g * t) * (1 + spot * Math.exp(-((x - spotX) ** 2 + (y - spotY) ** 2) / (2 * spotR * spotR)));
      img[y * W + x] = (lo + refl[y * W + x] * (hi - lo)) * light;
    }
  }
  img = gaussianBlur(img, W, H, o.blur ?? 0);
  const data = new Uint8ClampedArray(W * H * 4);
  const tint = [uniform(0.9, 1), uniform(0.9, 1), uniform(0.85, 1)];
  for (let i = 0; i < W * H; i++) {
    const v = img[i] + (o.noise ? o.noise * gauss() : 0);
    data[i * 4] = v * tint[0];
    data[i * 4 + 1] = v * tint[1];
    data[i * 4 + 2] = v * tint[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: W, height: H };
}

// --- Damage ----------------------------------------------------------------------
/** Codewords in error per block for a blot: `possible` counts any codeword a module of which touches the
 *  disc (grown by `grow`), otherwise only codewords with a module wholly inside (shrunk by `grow`) that changes colour. */
function blotErrors(modules, lay, blot, grow, possible) {
  const n = lay.dim, perBlock = new Array(lay.nb).fill(0), seen = new Set();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cw = lay.owner[y * n + x];
      if (cw < 0 || seen.has(cw)) continue;
      const nx = Math.max(x, Math.min(blot.u, x + 1)), ny = Math.max(y, Math.min(blot.v, y + 1));
      const far = Math.max(...[[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([a, b]) => Math.hypot(a - blot.u, b - blot.v)));
      const hit = possible ? Math.hypot(nx - blot.u, ny - blot.v) < blot.r + grow : far < blot.r - grow && modules[y][x] !== blot.dark;
      if (hit) {
        seen.add(cw);
        perBlock[lay.cwBlock[cw]]++;
      }
    }
  }
  return perBlock;
}
/** A blot as large as the code can surely correct (within) or surely cannot (beyond), or null. */
function makeBlot(modules, lay, within) {
  const n = lay.dim;
  for (let attempt = 0; attempt < 20; attempt++) {
    const blot = { u: uniform(10, n - 10), v: uniform(10, n - 10), r: 0, dark: rnd() < 0.5 };
    // keep clear of the finders and format information
    const room = Math.min(...[[0, 0], [n, 0], [0, n]].map(([a, b]) => Math.max(Math.abs(blot.u - a), Math.abs(blot.v - b)) - 10));
    if (within) {
      let lo = 0, hi = Math.min(room, n / 2);
      for (let k = 0; k < 20; k++) {
        const r = (lo + hi) / 2;
        if (Math.max(...blotErrors(modules, lay, { ...blot, r }, 0.75, true)) <= lay.t) lo = r;
        else hi = r;
      }
      if (lo >= 1.5) return { ...blot, r: lo };
    } else {
      for (let r = 1; r < n / 2; r += 0.5) {
        if (Math.max(...blotErrors(modules, lay, { ...blot, r }, 0.75, false)) >= lay.t + 2) return { ...blot, r };
      }
    }
  }
  return null;
}

// --- Running ---------------------------------------------------------------------
const results = [];
const timings = { found: [], empty: [] };
let thrown = 0;

function check(row, expected, image) {
  const t0 = performance.now();
  let got;
  try {
    got = image?.modules ? decodeQRMatrix(image.modules) : decodeQR(image);
  } catch (e) {
    thrown++;
    got = undefined;
    console.error(`${row.name}: threw ${e?.stack ?? e}`);
  }
  const dt = performance.now() - t0;
  if (image && !image.modules && image.width * image.height === 1280 * 720) (got == null ? timings.empty : timings.found).push(dt);
  row.n++;
  if (got === null) row.none++;
  else if (got === expected) row.ok++;
  else {
    row.wrong++;
    console.error(`${row.name}: WRONG ${JSON.stringify(String(got).slice(0, 60))} for ${JSON.stringify(String(expected).slice(0, 60))}`);
  }
}

/** Runs `count` cases of a condition; make() returns [expected text or null, image or { modules }] or null to skip. */
function condition(name, target, count, make) {
  const row = { name, target, n: 0, ok: 0, none: 0, wrong: 0, expectNull: false };
  results.push(row);
  let made = 0;
  for (let tries = 0; made < count && tries < count * 20; tries++) {
    const c = make(made);
    if (!c) continue;
    made++;
    if (c[0] === null) row.expectNull = true;
    check(row, c[0], c[1]);
  }
  const rate = row.n ? (100 * (row.expectNull ? row.none : row.ok)) / row.n : 0;
  process.stdout.write(`  ${name.padEnd(46)} ${String(row.n).padStart(4)}  ${rate.toFixed(1).padStart(5)}%\n`);
}

/** qr.js modules for a payload at level L or M, or null if too long. */
function qrjs(text, level) {
  try {
    return qrModules(utf8(text), level);
  } catch {
    return null;
  }
}
/** A random code from qr.js, small enough for `maxModules` across with quiet zone q. */
function randomCode(maxModules, q = 4, maxLen = 1500) {
  for (let i = 0; i < 30; i++) {
    const text = payload(maxLen), level = int(0, 1), modules = qrjs(text, level);
    if (modules && modules.length + 2 * q <= maxModules) return { text, level, modules };
    maxLen = Math.max(20, maxLen * 0.7);
  }
  return null;
}
const mirror = (m) => m.map((row) => row.slice().reverse());
const frameSize = () => (rnd() < 0.7 ? [1280, 720] : [720, 1280]);

/** A frame with a random code; `opts(code)` gives drawFrame options (px decided from occupancy or module size). */
function frameCase(opts, { occupancy = [0.2, 0.8], px = null, quiet = 4, code = null, size: frame = frameSize() } = {}) {
  const [W, H] = frame, short = Math.min(W, H);
  const pxWanted = px ? uniform(px[0], px[1]) : null;
  const c = code ?? randomCode(pxWanted ? Math.floor((short * 0.9) / pxWanted) : Math.floor((short * 0.8) / 3), quiet);
  if (!c) return null;
  const across = c.modules.length + 2 * quiet;
  const size = pxWanted ?? Math.max(3, (uniform(occupancy[0], occupancy[1]) * short) / across);
  const o = { width: W, height: H, quiet, px: size, clutter: true, ...opts(c) };
  const image = drawFrame(o.mirror ? mirror(c.modules) : c.modules, o);
  return image && [c.text, image];
}

console.log(`QR reader tests, seed ${seed}`);

// --- Encoder sanity: the encoder here must agree with qr.js and the standard's example
{
  const iso = encode([{ mode: 'numeric', value: '01234567' }], 1, 0);
  const isoData = '10 20 0C 56 61 80 EC 11 EC 11 EC 11 EC 11 EC 11', isoEcc = 'A5 24 D4 C1 ED 36 C7 87 2C 55';
  const toHex = (a) => a.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const row = { name: 'encoder here = ISO 18004 annex I and qr.js', target: 100, n: 1, ok: toHex(iso.codewords) === `${isoData} ${isoEcc}` ? 1 : 0, none: 0, wrong: 0 };
  results.push(row);
  for (let i = 0; i < 60; i++) {
    const text = i < 40 ? 'x'.repeat(int(1, 9)) + payload(i < 20 ? 300 : 1500) : payload(3000).repeat(2);
    const level = i % 2, ref = qrjs(text, level);
    if (!ref) continue;
    const mine = encode([{ mode: 'byte', value: utf8(text) }], level, formatOf(ref).mask);
    row.n++;
    if (mine && JSON.stringify(mine.modules) === JSON.stringify(ref)) row.ok++;
  }
  console.log(`  ${row.name.padEnd(46)} ${String(row.n).padStart(4)}  ${((100 * row.ok) / row.n).toFixed(1).padStart(5)}%`);
}

console.log('Module grids');
const capacityText = (ver, level) => {
  const lay = layout(ver, level), bytes = lay.total - lay.nb * lay.ecc - (ver < 10 ? 2 : 3);
  return tingCall(bytes).slice(0, bytes).padEnd(bytes, '0');
};
condition('qr.js L and M, versions 1–40', 100, 80, (i) => {
  const text = capacityText((i >> 1) + 1, i & 1);
  const modules = qrjs(text, i & 1);
  return modules && modules.length === ((i >> 1) + 1) * 4 + 17 && [text, { modules }];
});
condition('Core Image L/M/Q/H fixtures', 100, CORE_IMAGE.length, (i) => [CORE_IMAGE[i][2], { modules: unpack(CORE_IMAGE[i][1], CORE_IMAGE[i][3]) }]);
condition('encoder here Q and H, versions 1–40, any mask', 100, 80, (i) => {
  const ver = (i >> 1) + 1, level = 2 + (i & 1), text = capacityText(ver, level);
  return [text, { modules: encode([{ mode: 'byte', value: utf8(text) }], level, int(0, 7)).modules }];
});
condition('numeric/alnum/kanji/ECI/mixed segments', 100, 80, () => {
  const { segs, text } = segmentMessage();
  const code = encode(segs, int(0, 3), int(0, 7));
  return code && [text, { modules: code.modules }];
});

/** Flips the modules of codeword `cw` by `e`. */
function corrupt(g, lay, cw, e) {
  for (let b = 0; b < 8; b++) if ((e >> (7 - b)) & 1) g[lay.order[cw * 8 + b]] ^= 1;
}
function randomGridCode() {
  if (rnd() < 0.6) {
    const c = randomCode(200, 0, 2000);
    return c && { text: c.text, modules: c.modules, level: c.level };
  }
  const text = payload(1200), level = int(0, 3), code = encode([{ mode: 'byte', value: utf8(text) }], level, int(0, 7), int(1, 20));
  return code && { text, modules: code.modules, level };
}
/** A grid with `extra` more errors than correctable in one block, `t` in the others, and format bits damaged. */
function damagedGrid(extra) {
  const c = randomGridCode();
  if (!c) return null;
  const dim = c.modules.length, ver = (dim - 17) / 4, lay = layout(ver, c.level);
  const g = c.modules.flat().map(Number);
  const worst = int(0, lay.nb - 1);
  for (let b = 0; b < lay.nb; b++) {
    const members = [];
    lay.cwBlock.forEach((bb, i) => bb === b && members.push(i));
    const errors = b === worst ? lay.t + extra : extra ? int(0, lay.t) : lay.t;
    for (let k = 0; k < errors; k++) corrupt(g, lay, members.splice(int(0, members.length - 1), 1)[0], int(1, 255));
  }
  // up to three wrong bits in each copy of the format information
  for (const copy of [0, 1]) {
    for (let k = int(0, 3), used = new Set(); k > 0; k--) {
      let i;
      do i = int(0, 14);
      while (used.has(i));
      used.add(i);
      const [x, y] = copy === 0 ? (i < 6 ? [8, i] : i < 8 ? [8, i + 1] : i === 8 ? [7, 8] : [14 - i, 8]) : i < 8 ? [dim - 1 - i, 8] : [8, dim - 15 + i];
      g[y * dim + x] ^= 1;
    }
  }
  return [extra ? null : c.text, { modules: Array.from({ length: dim }, (_, y) => g.slice(y * dim, (y + 1) * dim)) }];
}
condition('RS: t errors in every block, format damaged', 100, 150, () => damagedGrid(0));
condition('RS: t+1 errors in one block → null', 100, 150, () => damagedGrid(1));

console.log('Frames');
// Warm up the JIT so the timings are of steady state
for (let i = 0; i < 5; i++) {
  const c = frameCase(() => ({}));
  if (c) decodeQR(c[1]);
}
condition('clean, qr.js every version, 3–5 px, L and M', 100, 80, (i) => {
  const ver = (i >> 1) + 1, text = capacityText(ver, i & 1), modules = qrjs(text, i & 1), px = int(3, 5);
  const side = (modules.length + 8) * px + 40;
  return [text, drawFrame(modules, { width: side, height: side, quiet: 4, px, background: 1, lo: 0, hi: 255 })];
});
condition('clean, Core Image and encoder here (Q, H, modes)', 100, 60, (i) => {
  let text, modules;
  if (i < CORE_IMAGE.length) {
    text = CORE_IMAGE[i][2];
    modules = unpack(CORE_IMAGE[i][1], CORE_IMAGE[i][3]);
  } else {
    const m = i % 2 ? segmentMessage() : { segs: null, text: payload(900) };
    const c = encode(m.segs ?? [{ mode: 'byte', value: utf8(m.text) }], m.segs ? int(0, 3) : int(2, 3), int(0, 7));
    if (!c) return null;
    [text, modules] = [m.text, c.modules];
  }
  const px = int(3, 6), side = (modules.length + 8) * px + 40;
  return [text, drawFrame(modules, { width: side, height: side, quiet: 4, px, background: 1, lo: 0, hi: 255 })];
});
condition('quiet zone 1–2 modules, clutter', 95, 60, () => {
  const quiet = int(1, 2);
  return frameCase(() => ({ quiet, rotation: uniform(-10, 10), fakeFinders: int(0, 2) }), { quiet });
});
for (const px of [3, 4, 5, 6, 7, 8, 10]) condition(`module size ${px} px, clutter`, px === 3 ? 90 : 95, 20, () => frameCase(() => ({ rotation: uniform(-5, 5) }), { px: [px, px] }));
condition('rotation 0–360°', 95, 80, () => frameCase(() => ({ rotation: uniform(0, 360) })));
condition('perspective 5–20° (any rotation)', 95, 80, () => frameCase(() => ({ rotation: uniform(0, 360), tilt: uniform(5, 20) })));
/** A long ting:call link (1,000–1,500 characters, versions 22–32), as qr.js makes it. */
function denseCode() {
  for (let i = 0; i < 20; i++) {
    const text = tingCall(int(1000, 1500)), level = int(0, 1), modules = qrjs(text, level);
    if (modules) return { text, level, modules };
  }
  return null;
}
condition('1,000–1,500 chars, 4–5 px, perspective ≤ 20°', 95, 40, () => frameCase(() => ({ rotation: uniform(0, 360), tilt: uniform(5, 20) }), { px: [4, 5], code: denseCode() }));
condition('blur σ 0.15–0.35 module', 95, 60, () => {
  const px = uniform(3, 8);
  return frameCase(() => ({ rotation: uniform(0, 360), blur: px * uniform(0.15, 0.35) }), { px: [px, px] });
});
condition('noise σ 4–16 levels', 95, 60, () => frameCase(() => ({ rotation: uniform(0, 360), noise: uniform(4, 16) })));
condition('low contrast (40–70 levels apart)', 95, 60, () => {
  const lo = uniform(70, 130);
  return frameCase(() => ({ rotation: uniform(0, 360), lo, hi: lo + uniform(40, 70), noise: 2 }));
});
condition('uneven light (falls 40–70% across, spot)', 95, 60, () => frameCase(() => ({ rotation: uniform(0, 360), gradient: uniform(0.4, 0.7) })));
condition('20–80% of 1280×720 / 720×1280, clutter', 95, 80, () => frameCase(() => ({ rotation: uniform(0, 360), fakeFinders: int(0, 2) })));
condition('moderate everything (turn, 12° tilt, blur...)', 95, 100, () => {
  const px = uniform(3.5, 9);
  return frameCase(() => ({ rotation: uniform(0, 360), tilt: uniform(0, 12), blur: px * uniform(0, 0.2), noise: uniform(0, 8), gradient: uniform(0, 0.4), quiet: int(2, 4), lo: uniform(10, 50), hi: uniform(170, 240), fakeFinders: int(0, 1) }), { px: [px, px] });
});
condition('inverted (light on dark)', 95, 40, () => frameCase(() => ({ rotation: uniform(0, 360), invert: true, tilt: uniform(0, 10) })));
condition('mirrored', 95, 40, () => frameCase(() => ({ rotation: uniform(0, 360), mirror: true, tilt: uniform(0, 10) })));
condition('blot within EC capacity (RS corrects)', 95, 60, () => {
  const c = randomCode(160, 4);
  if (!c) return null;
  const blot = makeBlot(c.modules, layout((c.modules.length - 17) / 4, c.level), true);
  return blot && frameCase(() => ({ rotation: uniform(0, 360), tilt: uniform(0, 8), blot }), { code: c, occupancy: [0.4, 0.8] });
});
condition('blot beyond EC capacity → null', 100, 60, () => {
  const c = randomCode(160, 4);
  if (!c) return null;
  const blot = makeBlot(c.modules, layout((c.modules.length - 17) / 4, c.level), false);
  const f = blot && frameCase(() => ({ rotation: uniform(0, 360), tilt: uniform(0, 8), blot }), { code: c, occupancy: [0.4, 0.8] });
  return f && [null, f[1]];
});

condition('3000×2000 photo (scaled down inside)', 100, 6, () => frameCase(() => ({ rotation: uniform(0, 360), tilt: uniform(0, 10) }), { size: [3000, 2000], px: [7, 12] }));

console.log('No code');
condition('clutter only (with finder-like squares)', 100, 40, () => {
  const refl = drawFrame([[false]], { width: 1280, height: 720, quiet: 0, px: 1, clutter: true, fakeFinders: int(0, 6) });
  return [null, refl];
});
condition('random noise, flat, gradients', 100, 30, (i) => {
  const W = 1280, H = 720, data = new Uint8ClampedArray(W * H * 4);
  const kind = i % 3, level = int(0, 255);
  for (let p = 0; p < W * H; p++) {
    const v = kind === 0 ? int(0, 255) : kind === 1 ? level : (p % W) / 5 + ((p / W) | 0) / 10;
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v;
    data[p * 4 + 3] = 255;
  }
  return [null, { data, width: W, height: H }];
});
condition('malformed input', 100, 12, (i) => [null, [
  null, undefined, {}, { data: null, width: 10, height: 10 }, { data: new Uint8ClampedArray(3), width: 10, height: 10 },
  { data: new Uint8ClampedArray(4), width: 1, height: 1 }, { data: new Uint8ClampedArray(400), width: -10, height: -10 },
  { data: new Uint8ClampedArray(400), width: 10.5, height: 10 }, { data: new Uint8ClampedArray(0), width: 0, height: 0 },
  { data: 'abc', width: 1, height: 1 }, { data: new Uint8ClampedArray(64 * 64 * 4), width: 64, height: 64 },
  { data: new Uint8ClampedArray(32 * 32 * 4).fill(255), width: 32, height: 32 },
][i] ?? {}]);

console.log('Beyond the targets (measured, not required)');
condition('perspective 25–40°', null, 40, () => frameCase(() => ({ rotation: uniform(0, 360), tilt: uniform(25, 40) })));
condition('blur σ 0.4–0.6 module (out of focus)', null, 40, () => {
  const px = uniform(3, 8);
  return frameCase(() => ({ rotation: uniform(0, 360), blur: px * uniform(0.4, 0.6) }), { px: [px, px] });
});
condition('lens distortion k = −0.08, code fills 70–90%', null, 30, () => frameCase(() => ({ rotation: uniform(0, 360), barrel: -0.08 }), { occupancy: [0.7, 0.9] }));
condition('modules of 2 px', null, 30, () => frameCase(() => ({ rotation: uniform(0, 360) }), { px: [2, 2] }));
condition('1,000–1,500 chars at 3 px, 15°, blur, noise', null, 30, () => frameCase(() => ({ rotation: uniform(0, 360), tilt: 15, blur: 0.9, noise: 6 }), { px: [3.2, 3.2], code: denseCode() }));
condition('no quiet zone, clutter', null, 30, () => frameCase(() => ({ quiet: 0, rotation: uniform(0, 360) }), { quiet: 0 }));

// --- Summary ---------------------------------------------------------------------
const pct = (a, n) => (n ? (100 * a) / n : 0);
let failed = thrown > 0;
console.log(`\n${'condition'.padEnd(48)} ${'n'.padStart(4)} ${'read'.padStart(5)} ${'null'.padStart(5)} ${'wrong'.padStart(5)} ${'rate'.padStart(7)} ${'target'.padStart(7)}`);
for (const r of results) {
  const rate = pct(r.expectNull ? r.none : r.ok, r.n);
  const pass = r.wrong === 0 && (r.target === null || rate >= r.target);
  if (!pass) failed = true;
  const target = r.target === null ? 'info' : `≥${r.target}%`;
  console.log(`${(pass ? '  ' : '✗ ') + r.name.padEnd(46)} ${String(r.n).padStart(4)} ${String(r.ok).padStart(5)} ${String(r.none).padStart(5)} ${String(r.wrong).padStart(5)} ${rate.toFixed(1).padStart(6)}% ${target.padStart(7)}`);
}
const stats = (a) => {
  const s = [...a].sort((x, y) => x - y), at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  return `n ${s.length}, median ${at(0.5).toFixed(1)} ms, mean ${(s.reduce((x, y) => x + y, 0) / (s.length || 1)).toFixed(1)} ms, p95 ${at(0.95).toFixed(1)} ms, max ${at(1).toFixed(1)} ms`;
};
console.log(`\nTime per 1280×720 frame, code read:      ${stats(timings.found)}`);
console.log(`Time per 1280×720 frame, nothing read:   ${stats(timings.empty)}`);
const all = [...timings.found, ...timings.empty].sort((x, y) => x - y);
const p95 = all[Math.floor(0.95 * all.length)] ?? 0;
if (p95 > 100) {
  failed = true;
  console.log('✗ p95 decode time over 100 ms');
}
if (thrown) console.log(`✗ ${thrown} calls threw`);
console.log(failed ? '\nFAILED' : '\nAll targets met');
process.exit(failed ? 1 : 0);

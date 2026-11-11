// P-256 (secp256r1) public-key recovery and verification, in BigInt. Only for
// public data: the wallet never holds a private key, the passkey does. A
// passkey hands over its public key once, when it is created; on another
// device the wallet recovers it from a signature instead.

const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
export const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const G = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
];

const mod = (a, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function inv(a, m = P) {
  let [t, next, r, rest] = [0n, 1n, m, mod(a, m)];
  while (rest) {
    const q = r / rest;
    [t, next] = [next, t - q * next];
    [r, rest] = [rest, r - q * rest];
  }
  return mod(t, m);
}

function pow(b, e, m) {
  let r = 1n;
  b = mod(b, m);
  while (e) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** Affine point addition; `null` is the point at infinity. */
function add(p1, p2) {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1, [x2, y2] = p2;
  let l;
  if (x1 === x2) {
    if (mod(y1 + y2) === 0n) return null;
    l = mod((3n * x1 * x1 + A) * inv(2n * y1));
  } else {
    l = mod((y2 - y1) * inv(x2 - x1));
  }
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}

function mul(k, point) {
  let r = null;
  for (let q = point; k; k >>= 1n, q = add(q, q)) if (k & 1n) r = add(r, q);
  return r;
}

export const toBig = (bytes) => bytes.reduce((v, b) => (v << 8n) | BigInt(b), 0n);
export function fromBig(v, length = 32) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

const encode = ([x, y]) => {
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(fromBig(x), 1);
  out.set(fromBig(y), 33);
  return out;
};

function decode(key) {
  if (key.length !== 65 || key[0] !== 4) return null;
  const x = toBig(key.subarray(1, 33)), y = toBig(key.subarray(33));
  return mod(y * y - (x * x * x + A * x + B)) === 0n ? [x, y] : null;
}

/**
 * The public keys, 65 bytes uncompressed, that could have made the signature
 * `(r, s)` over the 32-byte `hash`: at most two, one for each y of the point
 * whose x is `r`.
 */
export function recover(hash, r, s) {
  if (r <= 0n || r >= N || s <= 0n || s >= N) return [];
  const e = toBig(hash) % N;
  const alpha = mod(r * r * r + A * r + B);
  const beta = pow(alpha, (P + 1n) / 4n, P);
  if ((beta * beta) % P !== alpha) return [];
  const rInv = inv(r, N);
  const u1 = mod(-e * rInv, N), u2 = mod(s * rInv, N);
  return [beta, P - beta]
    .map((y) => add(mul(u1, G), mul(u2, [r, y])))
    .filter(Boolean)
    .map(encode);
}

/** Whether `(r, s)` is a signature by `key` over the 32-byte `hash`. */
export function verify(key, hash, r, s) {
  const Q = decode(key);
  if (!Q || r <= 0n || r >= N || s <= 0n || s >= N) return false;
  const w = inv(s, N);
  const X = add(mul(mod(toBig(hash) * w, N), G), mul(mod(r * w, N), Q));
  return Boolean(X) && mod(X[0], N) === r;
}

// The automatic fee, as Ting ID sets it: what recent paying transactions paid
// for a whole block's worth of room, at the median, times the share of a
// block this transaction takes. Read from the newest blocks only when a fee
// is about to be shown, and kept for a few minutes.
import { equal, Reader, unhex } from '../../../kit/web/bytes.js';
import { H } from '../../../kit/web/ting.js';
import { TOPICS } from './coins.js';

const PAYMENT = H('app/event/producer-payment-v1');
const ZERO = new Uint8Array(32);
/** Blocks read back at most: three requests. */
const LOOK_BACK = 300;
const SAMPLES = 50;
const cache = new Map();

/**
 * What a passkey payment uses, in C, S, D, G: a coin transfer whose
 * signature policy-webauthn checks through the identity registry.
 */
export const SHARES = {
  own: [15_500_000, 17, 800, 76],
};

const shareOf = (used, limits) => Math.max(...used.map((u, i) => Number(u) / Number(limits[i] || 1)));

function twoDigits(v) {
  if (v < 100n) return v;
  const digits = v.toString().length;
  const unit = 10n ** BigInt(digits - 2);
  return ((v + unit / 2n) / unit) * unit;
}

/**
 * The automatic fee in `coin` for an operation of `kind`, in its smallest
 * units, or 0 when no recent transaction paid in it.
 */
export async function autoFee(pool, coin, kind = 'own') {
  const key = `${coin}:${kind}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 300_000) return hit.fee;
  const rates = [];
  let limits = null;
  let to = pool.height;
  while (to > 0 && pool.height - to < LOOK_BACK && rates.length < SAMPLES) {
    const from = Math.max(1, to - 99);
    const page = await pool.blocks(from, to - from + 1);
    const blocks = [...page.items].reverse();
    for (const block of blocks) {
      if (!block.limits) continue;
      limits ??= block.limits;
      for (const receipt of block.receipts ?? []) {
        if (receipt.status !== 0) continue;
        let paid = 0n;
        let issues = false;
        for (const e of receipt.events) {
          if (e.contract !== coin) continue;
          const payload = unhex(e.payload_hex);
          if (equal(payload.subarray(0, 32), PAYMENT)) {
            const r = new Reader(payload.subarray(64));
            paid += r.u128();
          } else if (equal(payload.subarray(0, 32), TOPICS.transfer) && equal(payload.subarray(32, 64), ZERO)) {
            issues = true;
          }
        }
        if (!paid || issues) continue;
        const share = shareOf(receipt.used, block.limits);
        if (share > 0) rates.push(Number(paid) / share);
        if (rates.length >= SAMPLES) break;
      }
      if (rates.length >= SAMPLES) break;
    }
    to = from - 1;
  }
  let fee = 0n;
  if (rates.length && limits) {
    rates.sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)];
    fee = twoDigits(BigInt(Math.max(1, Math.ceil(median * shareOf(SHARES[kind], limits)))));
  }
  cache.set(key, { fee, at: Date.now() });
  return fee;
}

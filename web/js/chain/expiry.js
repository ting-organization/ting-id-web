// When what the wallet signed can no longer go in, and whether the same
// thing is still on its way. A signed action that no block took holds its
// nonce only until it expires: after that the next action takes the chain's
// nonce again, so one that could never go in does not keep every later one
// waiting behind it. No DOM and no node here: scripts/test-expiry.mjs runs
// these rules as they are.

/** How far, in seconds, a block's time may trail the clock: it only has to pass the median of the blocks before it. */
export const LATE = 3600;

/** A block's timestamp must be greater than the median of this many before it (Ting wiki: consensus/difficulty). */
const WINDOW = 11;

/** How far below the tip the chain's time is read: a reorganization no deeper leaves it as it was. */
const SETTLED = 3;

/** The fewest blocks a chain has for its time to be read that far down. */
export const TIME_BLOCKS = WINDOW + SETTLED;

/** The first of the `WINDOW` heights the chain's time is read from, at a tip of `height`. */
export const timeFrom = (height) => height - TIME_BLOCKS + 1;

/**
 * The chain's time three blocks below a tip at `height`: the median
 * timestamp of the blocks at `height - 13 … height - 3`, which `blocks` must
 * be, in order. Every block after them is stamped later than this, on any
 * chain that still has them, and the median only rises from block to block.
 * Null when the chain is shorter, or `blocks` are not those eleven.
 */
export function settledTime(blocks, height) {
  if (!Number.isSafeInteger(height) || height < TIME_BLOCKS || blocks?.length !== WINDOW) return null;
  const times = [];
  for (let i = 0; i < WINDOW; i++) {
    const b = blocks[i];
    if (b?.height !== timeFrom(height) + i || !Number.isSafeInteger(b.timestamp)) return null;
    times.push(b.timestamp);
  }
  times.sort((a, b) => a - b);
  return times[WINDOW >> 1];
}

/**
 * Whether an action that expires at `expires` (block time, seconds; null
 * for one that never does) can no longer be included, at `now` by the clock
 * and `chainTime` (settledTime). A block includes it while its timestamp is
 * not past `expires`, so it is over once the clock is past it and the
 * chain's time has reached it: both, as a node's word alone moves no nonce.
 * With no chain time to go by, once the clock is `LATE` past it.
 */
export function cannotGoIn(expires, now, chainTime = null) {
  if (expires == null || !(now > expires)) return false;
  return chainTime != null ? chainTime >= expires : now > expires + LATE;
}

/** Whether `p`, something this browser sent, still waits for a block that could include it. */
export const waiting = (p, now, chainTime = null) =>
  ['pending', 'deferred'].includes(p.state) && !cannotGoIn(p.expires, now, chainTime);

/** What a payment is, to tell the same one sent again: coin, paying account and recipient in hex, and the amount in the coin's smallest units. */
export const payKey = (coin, from, to, units) => `pay:${coin}:${from}:${to}:${units}`;

/** What a program call is: the program and the call's TCR-1 head (template and values), both in hex. */
export const callKey = (program, head) => `call:${program}:${head}`;

/** The newest of `items` still waiting that is the action `what`; undefined when none is. One noted before `what` was kept is never it. */
export function repeatOf(items, what, now, chainTime = null) {
  return items.filter((p) => p.what != null && p.what === what && waiting(p, now, chainTime))
    .reduce((newest, p) => (!newest || p.at > newest.at ? p : newest), undefined);
}

/**
 * The newest of `items` still waiting that is a call to `program` (hex)
 * signed with the program's nonce `nonce`, or with one not noted: the
 * wallet signs each call with the nonce the chain holds, so of two such
 * calls only one can go in. One signed with an earlier nonce went in, or
 * gave way to another, and is not in the way.
 */
export function callWaiting(items, program, nonce, now, chainTime = null) {
  return items.filter((p) => p.program != null && p.program === program && waiting(p, now, chainTime)
    && (p.callNonce == null || BigInt(p.callNonce) >= BigInt(nonce)))
    .reduce((newest, p) => (!newest || p.at > newest.at ? p : newest), undefined);
}

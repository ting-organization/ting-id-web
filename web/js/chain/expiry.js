// When what the wallet signed can no longer go in, whether the same thing is
// still on its way, and how its actions queue. Every action of an account
// carries the next nonce, and a block takes them in order, so one that could
// never go in keeps every later one waiting behind it. A signed action holds
// its nonce only until it expires: once the last one queued has, the next
// action takes the chain's nonce again. Until then nothing more is signed
// behind one that did not go in: it could not go in either, and would only
// hold the nonce an hour longer. No DOM and no node here:
// scripts/test-expiry.mjs runs these rules as they are.

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
 * One nonce queue of this browser's as it stands: an account's actions in a
 * coin, or its calls to a program. `items` are the queue's own, each with its
 * nonce under `field`, and `chainNonce` is the nonce the last read of the
 * chain gave. `head` is the nonce a block takes next: the chain's, or one
 * past an action of this browser's that a block has taken since, as a lookup
 * can be a block ahead of the read. `ahead` are the actions from `head` on
 * that a block could still include.
 */
export function queueOf(items, field, chainNonce, now, chainTime = null) {
  const at = (p) => BigInt(p[field]);
  const own = items.filter((p) => p[field] != null);
  let head = BigInt(chainNonce);
  for (const p of own) if (p.state === 'included' && at(p) >= head) head = at(p) + 1n;
  return { field, head, ahead: own.filter((p) => at(p) >= head && waiting(p, now, chainTime)) };
}

/** The nonce the next action of a queue takes: one past the last still on its way, so that it queues behind them; the head when none is. */
export function nextIn({ field, head, ahead }) {
  return ahead.reduce((next, p) => (BigInt(p[field]) >= next ? BigInt(p[field]) + 1n : next), head);
}

/**
 * Whether another action should not be signed into a queue yet. One signed
 * now takes the nonce after the last still on its way, so it goes in only
 * if each of those does, in order. They cannot when the one whose turn it is
 * did not go in: it failed, or expired, and left a gap, or it is past its
 * expiry by the clock and only waits for the chain's time to say so. Signed
 * behind it, a new one could not go in either, and would hold the nonce
 * until its own expiry: whoever keeps trying would stay stuck. So nothing
 * is signed until the queue has run out. Null when one can be signed; else
 * `{ until }`, when the last of those ahead expires (seconds), or null when
 * one of them never does.
 */
export function heldUp({ field, head, ahead }, now) {
  if (!ahead.length) return null;
  const nonces = [...new Set(ahead.map((p) => BigInt(p[field])))].sort((a, b) => (a < b ? -1 : 1));
  const inOrder = nonces.length === ahead.length && nonces.every((n, i) => n === head + BigInt(i));
  if (inOrder && !ahead.some((p) => p.expires != null && now > p.expires)) return null;
  return { until: ahead.some((p) => p.expires == null) ? null : Math.max(...ahead.map((p) => p.expires)) };
}

/**
 * What "Forget waiting transactions" puts away: the payments and calls that
 * no block has taken and the wallet still follows or shows as lost, which
 * are what signed something with an expiry. Not what a node holds for a
 * later time, such as the run of a withdrawal from Savings, which waits as
 * it should, and not an identity's change, which holds no payment back.
 */
export const forgettable = (p, now) =>
  ['pending', 'lost'].includes(p.state) && p.expires != null && !(p.notBefore && p.notBefore > now);

// What this browser sent and no block has taken yet: when it is cleared,
// when its account looks stuck, and the payment or call a new one would
// repeat. Every action of an account carries the next nonce, and a block takes
// them in order, so one that never goes in keeps the account's later payments
// waiting behind it until they have all expired. Anything signed meanwhile
// queues behind them and moves that time on, so the wallet asks people to
// wait instead. It never refuses. No DOM and no node here:
// scripts/test-waiting.mjs runs these rules as they are.

/** How far, in seconds, a block's time may trail the clock: it only has to pass the median of the blocks before it. */
export const LATE = 3600;

/** How long, in seconds, a payment noted without an expiry could go in: an earlier version signed until the end of the next day at most. */
const UNDATED = 2 * 86_400;

/** How long, in seconds, something waits for a block before it looks stuck: blocks come about once a minute. */
export const STUCK_AFTER = 600;

/** Until when a block could include `p`, in seconds: its expiry, or two days after it was noted when it has none. */
export const couldGoInUntil = (p) => p.expires ?? Math.floor(p.at / 1000) + UNDATED;

/**
 * When `p` is cleared, in seconds: past its expiry, and as long again as a
 * block's time may trail the clock, no block can take it any more. The
 * wallet then shows it as not included and no longer queues behind it.
 */
export const clearsAt = (p) => couldGoInUntil(p) + LATE;

/** Whether `p` waits for a block at `now` (seconds): sent for now, not held by a node for later, and not cleared. */
const waiting = (p, now) => p.state === 'pending' && !(p.notBefore && p.notBefore > now) && now <= clearsAt(p);

/** The queue of the account `account` in the coin `coin` (both hex): its payments go in one after the other. */
export const queueKey = (coin, account) => `${coin}:${account}`;

/**
 * The queues that look stuck at `now` (seconds), by queueKey: something in
 * them has waited STUCK_AFTER without a block. Each says since when (`since`)
 * and when it is cleared (`clearsAt`): once everything waiting in it is, the
 * next payment takes the chain's nonce again. What is signed into it before
 * then waits behind the rest, and moves that time on.
 */
export function stuckQueues(items, now) {
  const queues = new Map();
  for (const p of items) {
    if (!p.coin || !p.account || !waiting(p, now)) continue;
    const key = queueKey(p.coin, p.account);
    const q = queues.get(key) ?? { since: null, clearsAt: 0 };
    q.clearsAt = Math.max(q.clearsAt, clearsAt(p));
    const sent = Math.floor(p.at / 1000);
    if (now - sent >= STUCK_AFTER && (q.since == null || sent < q.since)) q.since = sent;
    queues.set(key, q);
  }
  return new Map([...queues].filter(([, q]) => q.since != null));
}

/** How long since `since`, at `now` (seconds), in words. */
function waited(since, now) {
  const minutes = Math.max(1, Math.floor((now - since) / 60));
  return minutes < 120 ? `${minutes} minutes` : `${Math.floor(minutes / 60)} hours`;
}

/**
 * The question before something is signed into a stuck queue (`stuck`, an
 * entry of stuckQueues), at `now` (seconds); `when` writes a time.
 */
export const waitWords = (stuck, now, when) =>
  `A transaction from this account has waited ${waited(stuck.since, now)} for a block. Anything you sign now waits behind it, and makes the wait longer. Everything waiting should be cleared by about ${when(stuck.clearsAt)}.`;

/** The note on the wallet while something looks stuck: `clearsAt` is the latest of the stuck queues'. */
export const stuckWords = (clearsAt, when) =>
  `Some transactions look stuck. Wait until about ${when(clearsAt)}, when they are cleared. Signing more before then makes the wait longer.`;

/** What a payment is, to tell the same one sent again: coin, paying account and recipient (hex), and the amount in the coin's smallest units. */
export const payKey = (coin, from, to, units) => `pay:${coin}:${from}:${to}:${units}`;

/** What a program's call is, to tell the same one approved again: the program and acting account, and the call's TCR-1 head (template and values), all hex. */
export const callKey = (program, account, head) => `call:${program}:${account}:${head}`;

/**
 * The newest of `items` that is the payment or call `what` (payKey, callKey)
 * and still waits for a block at `now` (seconds), or undefined. `passed(p)`
 * says whether the chain's nonce is past the one `p` took: then another took
 * its place, or it went in, and either way it is no second one. Only a repeat
 * is asked about: any other payment or call goes as it always does.
 */
export function repeatOf(items, what, now, passed = () => false) {
  return items.filter((p) => p.what != null && p.what === what && ['pending', 'deferred'].includes(p.state) && now <= clearsAt(p) && !passed(p))
    .reduce((newest, p) => (!newest || p.at > newest.at ? p : newest), undefined);
}

/**
 * The question before the payment `before` (repeatOf) is sent again: the
 * second queues behind the first, so both can go through. `again` says
 * otherwise when only one of the two can go in.
 */
export const sendAgainWords = (before, when, again = 'If you send it again, it could be paid twice.') =>
  `${before.summary} is still waiting for a block (sent ${when(Math.floor(before.at / 1000))}). ${again}`;

/**
 * The question before the call `before` (repeatOf) is approved again. The
 * wallet signs each call with the program's nonce as the chain has it, so
 * the two take the same one, and only one of them can go in.
 */
export const approveAgainWords = (before, when) =>
  `You approved this call at ${when(Math.floor(before.at / 1000))}, and it is still waiting for a block. Approved again, only one of the two can go in.`;

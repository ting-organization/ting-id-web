// What "Forget waiting transactions" in Settings puts away, and what the
// question before it says; and the payment or call a new one would repeat.
// Every action of an account carries the next nonce, and a block takes them
// in order, so one that never goes in keeps the account's later payments
// waiting behind it. Forgetting lets the next one take the chain's nonce
// again; it cancels nothing. No DOM and no node here: scripts/test-waiting.mjs
// runs these rules as they are.

/** How far, in seconds, a block's time may trail the clock: it only has to pass the median of the blocks before it. */
export const LATE = 3600;

/** How long, in seconds, a payment noted without an expiry could go in: what the wallet signs is valid until the end of the next day at most. */
const UNDATED = 2 * 86_400;

/**
 * Whether "Forget waiting transactions" puts `p` away at `now` (seconds): a
 * payment or call that no block has taken, which the wallet still follows or
 * shows as lost. Those are what hold an account's next payments back. Not
 * what a node holds for a later time, such as the run of a withdrawal from
 * Savings, and not an identity's change: neither holds a payment back.
 */
export const forgettable = (p, now) =>
  ['pending', 'lost'].includes(p.state) && (p.expires != null || p.nonce != null)
  && !(p.notBefore && p.notBefore > now);

/** Until when a block could include `p`, in seconds: its expiry, or two days after it was noted when it has none. */
export const couldGoInUntil = (p) => p.expires ?? Math.floor(p.at / 1000) + UNDATED;

/**
 * The question before `items` (forgettable) are forgotten at `now` (seconds),
 * with `when` writing a time. It says that this cancels nothing, until when
 * one of them could still go through, and that the same payment sent again
 * before then could be paid twice. Once a block's time can no longer trail
 * the clock that far (LATE), none can.
 */
export function forgetWords(items, now, when) {
  const one = items.length === 1;
  const them = one ? 'it' : 'them';
  const last = Math.max(...items.map(couldGoInUntil)) + LATE;
  const what = `Ting ID stops following the ${one ? 'transaction' : `${items.length} transactions`} that no block has taken yet, and your next one no longer waits behind ${them}.`;
  return now > last
    ? `${what} ${one ? 'It has' : 'They have'} expired, so nothing of ${them} can still go through.`
    : `${what} This cancels nothing: ${one ? 'it' : 'any of them'} may still go through until about ${when(last)}. If you send the same payment again before then, it could be paid twice.`;
}

/** What a payment is, to tell the same one sent again: coin, paying account and recipient (hex), and the amount in the coin's smallest units. */
export const payKey = (coin, from, to, units) => `pay:${coin}:${from}:${to}:${units}`;

/** What a program's call is, to tell the same one approved again: the program and acting account, and the call's TCR-1 head (template and values), all hex. */
export const callKey = (program, account, head) => `call:${program}:${account}:${head}`;

/**
 * Whether `p`, something this browser sent, could still go in at `now`
 * (seconds): it waits for a block, or "Forget waiting transactions" put it
 * away (`forgotten`), and its time has not run out, as long again as a
 * block's time may trail the clock.
 */
const couldStillGoIn = (p, now) =>
  (['pending', 'deferred'].includes(p.state) || (p.state === 'dismissed' && p.forgotten === true))
  && now <= couldGoInUntil(p) + LATE;

/**
 * The newest of `items` that is the payment or call `what` (payKey, callKey)
 * and could still go in at `now`, or undefined. `passed(p)` says whether the
 * chain's nonce is past the one `p` took: then another took its place, or it
 * went in, and either way it is no second one. Only a repeat is asked about:
 * any other payment or call goes as it always does.
 */
export function repeatOf(items, what, now, passed = () => false) {
  return items.filter((p) => p.what != null && p.what === what && couldStillGoIn(p, now) && !passed(p))
    .reduce((newest, p) => (!newest || p.at > newest.at ? p : newest), undefined);
}

/** Where `before` (repeatOf) stands, for the question before it is repeated, with `when` writing a time. */
function standing(before, when) {
  const sent = when(Math.floor(before.at / 1000));
  return before.forgotten
    ? `was forgotten in Settings (sent ${sent}), but could still go through until about ${when(couldGoInUntil(before) + LATE)}`
    : `is still waiting for a block (sent ${sent})`;
}

/**
 * The question before the payment `before` (repeatOf) is sent again. One
 * still waiting and the new one queue one after the other, so both can go
 * through; one forgotten may go through as well. `again` says otherwise when
 * only one of the two can go in.
 */
export function sendAgainWords(before, when, again = 'If you send it again, it could be paid twice.') {
  return `${before.summary} ${standing(before, when)}. ${again}`;
}

/**
 * The question before the call `before` (repeatOf) is approved again. The
 * wallet signs each call with the program's nonce as the chain has it, so
 * the two take the same one, and only one of them can go in.
 */
export function approveAgainWords(before, when) {
  return `You approved this call before, and it ${standing(before, when)}. Approved again, only one of the two can go in.`;
}

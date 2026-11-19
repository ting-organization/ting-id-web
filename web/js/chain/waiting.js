// What "Forget waiting transactions" in Settings puts away, and what the
// question before it says. Every action of an account carries the next nonce,
// and a block takes them in order, so one that never goes in keeps the
// account's later payments waiting behind it. Forgetting lets the next one
// take the chain's nonce again; it cancels nothing. No DOM and no node here:
// scripts/test-waiting.mjs runs these rules as they are.

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

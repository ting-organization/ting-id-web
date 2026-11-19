#!/usr/bin/env node
// What this browser sent and no block has taken yet: how long what it signs
// lasts, when an account's queue looks stuck and when it clears, and the
// payment or call a new one would repeat (web/js/chain/waiting.js,
// web/js/chain/coins.js).
//
//   node scripts/test-waiting.mjs
import { BLOCK_AHEAD, SIGNED_LIFE, signedExpiry } from '../web/js/chain/coins.js';
import {
  approveAgainWords, callKey, clearsAt, couldGoInUntil, LATE, payKey, queueKey, repeatOf, sendAgainWords, STUCK_AFTER, stuckQueues,
  stuckWords, waitWords,
} from '../web/js/chain/waiting.js';

let failed = 0;
function expect(what, got, want) {
  if (got !== want) {
    failed++;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const now = 1_800_000_000;
const ms = (seconds) => seconds * 1000;
const when = (seconds) => `T${seconds}`;
/** A payment from account a1 in coin c0, sent `ago` seconds before now. */
const payment = (nonce, ago, extra = {}) => ({
  state: 'pending', at: ms(now - ago), coin: 'c0', account: 'a1', nonce: String(nonce), spend: '100', expires: now - ago + SIGNED_LIFE, ...extra,
});

// What is signed lasts three hours, counted from the later of the clock and the newest block read from.
{
  const realNow = Date.now;
  Date.now = () => ms(now);
  try {
    expect('three hours', SIGNED_LIFE, 3 * 3600);
    expect('from the clock', signedExpiry(), BigInt(now + SIGNED_LIFE));
    expect('from a newer block, when the clock is slow', signedExpiry(now + 7200), BigInt(now + 7200 + SIGNED_LIFE));
    expect('from the clock, when the block is older', signedExpiry(now - 600), BigInt(now + SIGNED_LIFE));
    expect('no block read yet', signedExpiry(null), BigInt(now + SIGNED_LIFE));
    expect('a call, an hour', signedExpiry(null, 3600), BigInt(now + 3600));
    expect('a block a week ahead is believed a day', signedExpiry(now + 7 * 86_400), BigInt(now + BLOCK_AHEAD + SIGNED_LIFE));
  } finally {
    Date.now = realNow;
  }
}

// When one is cleared: past its expiry, and an hour more, as a block's time may trail the clock.
{
  expect('with an expiry', clearsAt(payment(4, 0)), now + SIGNED_LIFE + LATE);
  expect('one of an earlier version, without', couldGoInUntil({ ...payment(4, 0), expires: undefined }), now + 2 * 86_400);
}

// A queue looks stuck once something in it has waited ten minutes without a block.
{
  const key = queueKey('c0', 'a1');
  expect('just sent', stuckQueues([payment(4, 60)], now).size, 0);
  expect('nine minutes', stuckQueues([payment(4, STUCK_AFTER - 60)], now).size, 0);
  const stuck = stuckQueues([payment(4, STUCK_AFTER)], now).get(key);
  expect('ten minutes', stuck?.since, now - STUCK_AFTER);

  // It clears when the last of what waits in it does: what was signed behind the stuck one moves that on.
  const queue = stuckQueues([payment(4, 1800), payment(5, 900), payment(6, 30)], now).get(key);
  expect('since the oldest', queue.since, now - 1800);
  expect('cleared with the newest', queue.clearsAt, now - 30 + SIGNED_LIFE + LATE);

  // Only what still waits for a block counts.
  for (const state of ['included', 'done', 'failed', 'lost', 'dismissed', 'deferred']) {
    expect(`one ${state}`, stuckQueues([payment(4, 1800, { state })], now).size, 0);
  }
  expect('held by a node for later', stuckQueues([payment(4, 1800, { notBefore: now + 600 })], now).size, 0);
  expect('cleared already', stuckQueues([payment(4, SIGNED_LIFE + LATE + 1)], now).size, 0);
  expect('nothing of an account', stuckQueues([{ state: 'pending', at: ms(now - 1800), expires: now + 3600 }], now).size, 0);

  // Each account in each coin is a queue of its own.
  const two = stuckQueues([payment(4, 1800), payment(9, 30, { account: 'a2' })], now);
  expect('the stuck account', two.has(key), true);
  expect('another account', two.has(queueKey('c0', 'a2')), false);
}

// What it says: how long it has waited, and until when to wait.
{
  expect('the question', waitWords({ since: now - 1500, clearsAt: now + 9000 }, now, when),
    `A transaction from this account has waited 25 minutes for a block. Anything you sign now waits behind it, and makes the wait longer. Everything waiting should be cleared by about T${now + 9000}.`);
  expect('in hours', waitWords({ since: now - 3 * 3600, clearsAt: now }, now, when).includes('has waited 3 hours for a block'), true);
  expect('the note', stuckWords(now + 9000, when),
    `Some transactions look stuck. Wait until about T${now + 9000}, when they are cleared. Signing more before then makes the wait longer.`);
}

// Only the same payment counts as a repeat: same coin, account, recipient and amount.
{
  expect('a payment key', payKey('c0', 'a1', 'b2', 100n), 'pay:c0:a1:b2:100');
  expect('a call key', callKey('p0', 'a1', 'h2'), 'call:p0:a1:h2');
  const what = payKey('c0', 'a1', 'b2', 100n);
  const sent = { ...payment(4, 600), what, summary: '1 DLR to Bo' };
  expect('the same payment waiting', repeatOf([sent], what, now), sent);
  expect('another amount', repeatOf([sent], payKey('c0', 'a1', 'b2', 101n), now), undefined);
  expect('another recipient', repeatOf([sent], payKey('c0', 'a1', 'b3', 100n), now), undefined);
  expect('one noted without what it was', repeatOf([{ ...payment(4, 600), summary: '1 DLR to Bo' }], what, now), undefined);
  const held = { ...sent, state: 'deferred' };
  expect('held by the node for later', repeatOf([held], what, now), held);
  for (const state of ['included', 'done', 'failed', 'lost', 'dismissed']) expect(`one ${state}`, repeatOf([{ ...sent, state }], what, now), undefined);
  expect('cleared', repeatOf([sent], what, clearsAt(sent) + 1), undefined);

  // One whose nonce the chain has passed went in or lost its place: no second one.
  const passed = (p) => BigInt(p.nonce) < 5n;
  expect('its nonce passed', repeatOf([sent], what, now, passed), undefined);
  expect('its nonce not passed', repeatOf([{ ...sent, nonce: '5' }], what, now, passed)?.nonce, '5');

  const newer = { ...sent, at: sent.at + 60_000, nonce: '5' };
  expect('the newest of them', repeatOf([sent, newer], what, now), newer);
}

// The repeat questions say when the first was sent, and what a second one does.
{
  const sent = { ...payment(4, 600), summary: '1 DLR to Bo' };
  const sentAt = now - 600;
  expect('a payment', sendAgainWords(sent, when), `1 DLR to Bo is still waiting for a block (sent T${sentAt}). If you send it again, it could be paid twice.`);
  expect('only one can go in', sendAgainWords(sent, when, 'Sent again, only one of the two can go in.'),
    `1 DLR to Bo is still waiting for a block (sent T${sentAt}). Sent again, only one of the two can go in.`);
  expect('a call', approveAgainWords({ state: 'pending', at: ms(sentAt), expires: now + 3600 }, when),
    `You approved this call at T${sentAt}, and it is still waiting for a block. Approved again, only one of the two can go in.`);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('waiting: all passed');

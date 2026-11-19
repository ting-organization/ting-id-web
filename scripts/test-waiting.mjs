#!/usr/bin/env node
// What "Forget waiting transactions" in Settings puts away, and what the
// question before it says (web/js/chain/waiting.js).
//
//   node scripts/test-waiting.mjs
import { couldGoInUntil, forgettable, forgetWords, LATE } from '../web/js/chain/waiting.js';

let failed = 0;
function expect(what, got, want) {
  if (got !== want) {
    failed++;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

const now = 1_800_000_000;
const at = (now - 600) * 1000;
const payment = { state: 'pending', at, coin: 'c0', account: 'a1', nonce: '4', spend: '100', expires: now + 3600 };
const when = (seconds) => `T${seconds}`;

// What holds a payment back is put away, wherever it stands short of a block.
{
  expect('a waiting payment', forgettable(payment, now), true);
  expect('a lost payment', forgettable({ ...payment, state: 'lost' }, now), true);
  expect('a call without a payment', forgettable({ state: 'pending', at, expires: now + 3600 }, now), true);
  expect('a payment noted without an expiry', forgettable({ ...payment, expires: undefined }, now), true);
  for (const state of ['included', 'done', 'failed', 'deferred', 'dismissed']) {
    expect(`a payment ${state}`, forgettable({ ...payment, state }, now), false);
  }
}

// What holds no payment back stays: an identity's change, and the run of a withdrawal from Savings.
{
  expect('an identity change', forgettable({ state: 'pending', at }, now), false);
  expect('a change held for later', forgettable({ state: 'pending', at, notBefore: now + 600, tag: 'apply' }, now), false);
  expect('a run held for later', forgettable({ state: 'pending', at, notBefore: now + 120, runOf: 'c0:a1:4' }, now), false);
  expect('a run come due', forgettable({ state: 'pending', at, notBefore: now - 10, runOf: 'c0:a1:4' }, now), false);
  expect('a payment held for later', forgettable({ ...payment, notBefore: now + 120 }, now), false);
}

// Until when one could still go in: its expiry, or two days after it was noted.
{
  expect('with an expiry', couldGoInUntil(payment), now + 3600);
  expect('without one', couldGoInUntil({ ...payment, expires: undefined }), now - 600 + 2 * 86_400);
}

// The question says until when one may still go through: the last expiry, and as long again as a
// block's time may trail the clock. Past that, that they have expired.
{
  const one = forgetWords([payment], now, when);
  expect('one: what it does', one.startsWith('Ting ID stops following the transaction that no block has taken yet, and your next one no longer waits behind it.'), true);
  expect('one: until when', one.includes(`This cancels nothing: it may still go through until about T${now + 3600 + LATE}.`), true);
  expect('one: paid twice', one.endsWith('If you send the same payment again before then, it could be paid twice.'), true);

  const later = { ...payment, nonce: '5', expires: now + 7200 };
  const two = forgetWords([payment, later], now, when);
  expect('two: how many', two.includes('the 2 transactions that no block has taken yet') && two.includes('waits behind them.'), true);
  expect('two: the last of them', two.includes(`any of them may still go through until about T${now + 7200 + LATE}.`), true);

  const lastMoment = now + 3600 + LATE;
  expect('at the last moment', forgetWords([payment], lastMoment, when).includes('may still go through'), true);
  const over = forgetWords([payment], lastMoment + 1, when);
  expect('one: expired', over.endsWith('It has expired, so nothing of it can still go through.'), true);
  expect('one: expired, nothing about paying twice', over.includes('paid twice'), false);
  expect('two: expired', forgetWords([payment, payment], lastMoment + 1, when).endsWith('They have expired, so nothing of them can still go through.'), true);

  const undated = { ...payment, expires: undefined };
  expect('undated: two days after it was noted', forgetWords([undated], now, when).includes(`until about T${now - 600 + 2 * 86_400 + LATE}.`), true);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('waiting: all passed');

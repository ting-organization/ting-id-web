#!/usr/bin/env node
// What the wallet signs lasts an hour, and what no block took by then is
// forgotten by the chain's time (web/js/chain/expiry.js): the rule itself,
// the session marking such a transaction lost even while a node still holds
// it, the next action taking its nonce, and the same payment or a second
// call to one program found while the first still waits.
//
//   node scripts/test-expiry.mjs
import { hex } from '../kit/web/bytes.js';
import * as coins from '../web/js/chain/coins.js';
import {
  callKey, callWaiting, cannotGoIn, LATE, payKey, repeatOf, settledTime, TIME_BLOCKS, timeFrom, waiting,
} from '../web/js/chain/expiry.js';

// The session and the Send screen read the page's address when they load.
globalThis.location = { hostname: 'localhost', hash: '' };
const { session } = await import('../web/js/session.js');
const store = await import('../web/js/store.js');
const { nextNonce, spendable } = await import('../web/js/screens/send.js');

let failed = 0;
function expect(what, got, want) {
  const same = typeof want === 'bigint' || typeof got === 'bigint' ? got === want : JSON.stringify(got) === JSON.stringify(want);
  if (same) return;
  failed++;
  console.error(`✗ ${what}: got ${typeof got === 'bigint' ? got : JSON.stringify(got)}, want ${typeof want === 'bigint' ? want : JSON.stringify(want)}`);
}

// ---- What is signed lasts an hour ----------------------------------------------

{
  expect('an hour', coins.SIGNED_LIFE, 3600);
  const before = Math.floor(Date.now() / 1000);
  const expiry = Number(coins.signedExpiry());
  const after = Math.floor(Date.now() / 1000);
  expect('signed now, it expires an hour from now', expiry >= before + 3600 && expiry <= after + 3600, true);
}

// ---- The chain's time ----------------------------------------------------------

/** The blocks at `from … from + times.length - 1`, stamped `times`. */
const blocks = (from, times) => times.map((timestamp, i) => ({ height: from + i, timestamp }));
const T = 1_800_000_000;

{
  expect('fourteen blocks before the time can be read', TIME_BLOCKS, 14);
  expect('read from thirteen below the tip', timeFrom(100), 87);
  // Heights 87 … 97 under a tip at 100: the median is the sixth of the eleven, in whatever order they are stamped.
  const eleven = blocks(87, [T + 50, T + 10, T + 20, T + 30, T + 40, T + 5, T + 60, T + 70, T + 80, T + 90, T + 100]);
  expect('the median of the eleven', settledTime(eleven, 100), T + 50);
  expect('a block may be stamped before its parent', settledTime(blocks(87, [9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 10]), 100), 5);
  // The eleven blocks ending at the tip are not those three below it.
  expect('not the blocks at the tip', settledTime(blocks(90, eleven.map((b) => b.timestamp)), 100), null);
  expect('not ten blocks', settledTime(eleven.slice(1), 100), null);
  expect('not twelve', settledTime([...eleven, { height: 98, timestamp: T }], 100), null);
  expect('not one without a timestamp', settledTime(eleven.map((b, i) => (i === 3 ? { height: b.height } : b)), 100), null);
  expect('nothing read', settledTime(undefined, 100), null);
  expect('a chain of 13 blocks is too short', settledTime(blocks(0, eleven.map((b) => b.timestamp)), 13), null);
  expect('one of 14 has its first eleven', settledTime(blocks(1, eleven.map((b) => b.timestamp)), 14), T + 50);
}

// ---- When it can no longer go in -----------------------------------------------

{
  expect('never expires', cannotGoIn(null, T + 1e9, T + 1e9), false);
  expect('never expires, as stored without one', cannotGoIn(undefined, T + 1e9), false);
  expect('before its expiry', cannotGoIn(T, T - 1, T + 500), false);
  expect('at its expiry by the clock, a block may still take it', cannotGoIn(T, T, T), false);
  expect('the clock past it, the chain not yet', cannotGoIn(T, T + 1, T - 1), false);
  expect('the clock long past it, the chain not yet', cannotGoIn(T, T + 10 * LATE, T - 1), false);
  expect('the chain past it, the clock not: a node’s word alone', cannotGoIn(T, T, T + 500), false);
  expect('both past it', cannotGoIn(T, T + 1, T + 1), true);
  expect('the chain’s time exactly at it: the next block is stamped later', cannotGoIn(T, T + 1, T), true);
  expect('no chain time, an hour past it by the clock', cannotGoIn(T, T + LATE, null), false);
  expect('no chain time, more than an hour past it', cannotGoIn(T, T + LATE + 1, null), true);
  expect('no chain time given', cannotGoIn(T, T + LATE + 1), true);
}

// ---- The same thing, still waiting ---------------------------------------------

{
  const coin = 'c0'.repeat(32), me = 'aa'.repeat(32), bob = 'bb'.repeat(32), eve = 'ee'.repeat(32);
  const what = payKey(coin, me, bob, 100n);
  expect('a payment’s key', what, `pay:${coin}:${me}:${bob}:100`);
  expect('another amount is another payment', payKey(coin, me, bob, 101n) === what, false);
  expect('another recipient is another payment', payKey(coin, me, eve, 100n) === what, false);
  const now = T;
  const sent = (at, more = {}) => ({ id: `tx${at}`, at, state: 'pending', expires: T + 3600, what, ...more });
  expect('none sent', repeatOf([], what, now), undefined);
  expect('the same, waiting', repeatOf([sent(1)], what, now)?.id, 'tx1');
  expect('the newest of them', repeatOf([sent(1), sent(3), sent(2)], what, now)?.id, 'tx3');
  expect('held by the node until its time', repeatOf([sent(1, { state: 'deferred' })], what, now)?.id, 'tx1');
  for (const state of ['included', 'done', 'failed', 'lost', 'dismissed']) {
    expect(`not one ${state}`, repeatOf([sent(1, { state })], what, now), undefined);
  }
  expect('not another payment', repeatOf([sent(1, { what: payKey(coin, me, eve, 100n) })], what, now), undefined);
  expect('not one noted before payments were told apart', repeatOf([sent(1, { what: undefined })], undefined, now), undefined);
  expect('not one past its expiry', repeatOf([sent(1, { expires: T - 10 })], what, T, T - 5), undefined);
  expect('one past the clock only still waits', repeatOf([sent(1, { expires: T - 10 })], what, T, T - 11)?.id, 'tx1');
  expect('waiting', waiting(sent(1), now), true);
  expect('not waiting once failed', waiting(sent(1, { state: 'failed' }), now), false);

  const program = 'd1'.repeat(32), other = 'd2'.repeat(32);
  expect('a call’s key', callKey(program, 'beef'), `call:${program}:beef`);
  const call = (at, more = {}) => ({ id: `call${at}`, at, state: 'pending', expires: T + 3600, program, callNonce: '7', ...more });
  expect('a call to the program, signed with the same nonce', callWaiting([call(1)], program, 7n, now)?.id, 'call1');
  expect('whatever it calls', callWaiting([call(1, { what: callKey(program, '01') }), call(2, { what: callKey(program, '02') })], program, 7n, now)?.id, 'call2');
  expect('not a call to another program', callWaiting([call(1)], other, 7n, now), undefined);
  expect('not one whose nonce the chain is past: it went in', callWaiting([call(1, { callNonce: '6' })], program, 7n, now), undefined);
  expect('one with no nonce noted counts', callWaiting([call(1, { callNonce: undefined })], program, 7n, now)?.id, 'call1');
  expect('not one noted without its program', callWaiting([call(1, { program: undefined })], program, 7n, now), undefined);
  expect('not one lost', callWaiting([call(1, { state: 'lost' })], program, 7n, now), undefined);
  expect('not one past its expiry', callWaiting([call(1, { expires: T - 10 })], program, 7n, T, T), undefined);

}

// ---- The session forgets it, and the next action takes its nonce ----------------

{
  const now = Math.floor(Date.now() / 1000);
  const account = { account: new Uint8Array(32).fill(0xaa), name: 'Spending', record: { nonce: 5n, available: 1000n } };
  const coin = 'c0'.repeat(32);
  /** What a node answers for each transaction id: null for one it does not know. */
  const answers = {};
  const reads = [];
  let resent = 0;
  let stamps = null; // the timestamps of the eleven blocks asked for, or null for a node that cannot give them
  session.net = { key: 'test' };
  session.pool = {
    transaction: async (id) => answers[id],
    blocks: async (from, limit) => {
      reads.push([from, limit]);
      if (!stamps) throw new Error('unreachable');
      return { items: blocks(from, stamps) };
    },
    submit: async () => { resent++; },
  };
  const tip = (height) => { session.status = { tip: `tip${height}`, height }; };
  const item = (id, nonce, expires, more = {}) => ({
    id, summary: id, at: Date.now(), network: 'test', hex: '00', state: 'pending',
    coin, account: hex(account.account), nonce: String(nonce), spend: '100', expires, ...more,
  });
  const state = (id) => store.get().pending.find((p) => p.id === id).state;
  const eleven = (median) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => median - 5 + i);

  // Still within its hour: nothing is read, and the next action queues behind it.
  store.set({ pending: [item('a', 5, now + 3600)] });
  answers.a = { pending: true, occurrences: [] };
  tip(100);
  stamps = eleven(now);
  await session.watchPending();
  expect('within its hour it waits', state('a'), 'pending');
  expect('and no blocks are read for the time', reads.length, 0);
  expect('the next action queues behind it', nextNonce(coin, account), 6n);
  expect('what it takes is not there to spend', spendable(coin, account), 900n);

  // Past its expiry by the clock, the chain's time not there yet: it may still go in.
  const expired = now - 10;
  store.set({ pending: [item('a', 5, expired), item('b', 6, expired)] });
  answers.b = { pending: true, occurrences: [] };
  stamps = eleven(expired - 1);
  await session.watchPending();
  expect('the clock past it but not the chain: it waits', state('a'), 'pending');
  expect('the eleven blocks three below the tip, read once', reads, [[87, 11]]);
  expect('still queued behind', nextNonce(coin, account), 7n);
  await session.watchPending();
  expect('not read again for the same tip', reads.length, 1);

  // A new tip, the chain's time at its expiry: lost, though a node still holds it.
  tip(101);
  stamps = eleven(expired);
  await session.watchPending();
  expect('read again for the new tip', reads, [[87, 11], [88, 11]]);
  expect('the chain’s time at its expiry: lost, though a node still holds it', state('a'), 'lost');
  expect('and the one queued behind it', state('b'), 'lost');
  expect('the next action takes the chain’s nonce', nextNonce(coin, account), 5n);
  expect('and all of the account is there to spend', spendable(coin, account), 1000n);

  // Lost, it stays lost: the node still lists it, and the time cannot be read at the next tip.
  tip(102);
  stamps = null;
  await session.watchPending();
  expect('lost stays lost', state('a'), 'lost');
  expect('no blocks read for what is lost already', reads.length, 2);

  // Unless a block did include it.
  answers.a = { occurrences: [{ height: 102, receipt: { status: 0 } }] };
  await session.watchPending();
  expect('a block that included it says otherwise', state('a'), 'included');
  expect('the other is still lost', state('b'), 'lost');

  // A block that included it wins over the expiry, also the first time it is looked at.
  store.set({ pending: [item('c', 5, expired)] });
  answers.c = { occurrences: [{ height: 90, receipt: { status: 0 } }] };
  stamps = eleven(expired + 100);
  tip(103);
  await session.watchPending();
  expect('included before it expired: done', state('c'), 'done');

  // The screens go by the last time read, before the session has looked again.
  store.set({ pending: [item('d', 5, expired)] });
  expect('past its expiry by the last time read: its nonce is free', nextNonce(coin, account), 5n);
  session.timeAt = null;
  expect('no time read: it waits', nextNonce(coin, account), 6n);

  // The time cannot be read: an hour past its expiry by the clock.
  answers.d = { pending: true, occurrences: [] };
  answers.e = { pending: true, occurrences: [] };
  store.set({ pending: [item('d', 5, expired), item('e', 6, now - LATE - 5)] });
  stamps = null;
  tip(104);
  await session.watchPending();
  expect('the time cannot be read, just past its expiry: it waits', state('d'), 'pending');
  expect('an hour past it: lost', state('e'), 'lost');

  // A chain too short for its time to be read: the same, with nothing asked.
  const asked = reads.length;
  session.timeAt = null;
  tip(13);
  stamps = eleven(now + 100);
  await session.watchPending();
  expect('a short chain is not asked', reads.length, asked);
  expect('and it waits out the hour', state('d'), 'pending');

  // No node knows it: sent again until it is over, then lost.
  store.set({ pending: [item('f', 5, expired, { at: Date.now() - 600_000 })] });
  answers.f = null;
  stamps = eleven(expired - 1);
  tip(105);
  await session.watchPending();
  expect('unknown to the node, not over yet: sent again', [state('f'), resent], ['pending', 1]);
  stamps = eleven(expired);
  tip(106);
  await session.watchPending();
  expect('over: lost, and not sent again', [state('f'), resent], ['lost', 1]);

  // One without an expiry is none of this: dropped by every node, it is lost after a day, as before.
  store.set({ pending: [
    { id: 'g', summary: 'g', at: Date.now() - 600_000, network: 'test', hex: '00', state: 'pending' },
    { id: 'h', summary: 'h', at: Date.now() - 86_400_000 - 1000, network: 'test', hex: '00', state: 'pending' },
  ] });
  answers.g = null;
  answers.h = null;
  const before = reads.length;
  tip(107);
  await session.watchPending();
  expect('without an expiry: sent again within the day', [state('g'), resent], ['pending', 2]);
  expect('and lost after it', state('h'), 'lost');
  expect('with no blocks read', reads.length, before);

  // Another network's are left alone.
  store.set({ pending: [item('i', 5, expired, { network: 'other' })] });
  answers.i = { pending: true, occurrences: [] };
  stamps = eleven(expired + 100);
  tip(108);
  await session.watchPending();
  expect('another network’s is not touched', [state('i'), reads.length], ['pending', before]);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('expiry: all passed');

#!/usr/bin/env node
// What the wallet signs lasts an hour, and what no block took by then is
// forgotten by the chain's time (web/js/chain/expiry.js): the rule itself,
// the session marking such a transaction lost even while a node still holds
// it, the next action taking its nonce, the same payment or call found while
// the first still waits, how actions queue and when nothing more is signed
// behind one that did not go in, and Settings forgetting what waits.
//
//   node scripts/test-expiry.mjs
import { hex } from '../kit/web/bytes.js';
import * as coins from '../web/js/chain/coins.js';
import {
  callKey, cannotGoIn, forgettable, heldUp, LATE, nextIn, payKey, queueOf, repeatOf, settledTime, TIME_BLOCKS, timeFrom, waiting,
} from '../web/js/chain/expiry.js';
import { Pool } from '../web/js/chain/pool.js';

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
  // By the later of the device's clock and the newest block read from: a clock that runs slow signs nothing expired on arrival.
  expect('the chain ahead of the clock: an hour from the chain’s time', coins.signedExpiry(after + 7200), BigInt(after + 7200 + 3600));
  const behind = Number(coins.signedExpiry(before - 7200));
  expect('the chain behind the clock: an hour from the clock', behind >= before + 3600 && behind <= after + 3600, true);
  const none = Number(coins.signedExpiry(null));
  expect('no block read yet: an hour from the clock', none >= before + 3600 && none <= after + 3600, true);
  expect('a time that is no number is not gone by', Number(coins.signedExpiry(NaN)) <= after + 3600, true);

  // The pool's word for it: the timestamp of the newest block a checked read came from.
  const pool = new Pool({ chainId: '00' }, []);
  expect('no block read from yet', pool.tipTime(), null);
  pool.newest = { height: 9n, timestamp: 1_800_000_000n };
  expect('the newest block’s timestamp, in seconds', pool.tipTime(), 1_800_000_000);
  pool.newest = { height: 9n, timestamp: 2n ** 63n };
  expect('one beyond any date is not used', pool.tipTime(), null);
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
  // The same call, by program and by what it calls.
  const called = callKey(program, '01');
  const call = (at, more = {}) => ({ id: `call${at}`, at, state: 'pending', expires: T + 3600, program, what: called, ...more });
  expect('the same call, waiting', repeatOf([call(1)], called, now)?.id, 'call1');
  expect('not another call to the program', repeatOf([call(1)], callKey(program, '02'), now), undefined);
  expect('not the same call to another program', repeatOf([call(1)], callKey(other, '01'), now), undefined);
}

// ---- A queue, and when nothing more is signed into it ----------------------------

{
  const now = T;
  const program = 'd1'.repeat(32);
  const call = (nonce, more = {}) => ({ id: `call${nonce}`, state: 'pending', expires: T + 3600, program, callNonce: String(nonce), ...more });
  const q = (items, chainNonce, chainTime = null, at = now) => queueOf(items, 'callNonce', chainNonce, at, chainTime);
  const next = (items, chainNonce, chainTime = null, at = now) => nextIn(q(items, chainNonce, chainTime, at));
  const held = (items, chainNonce, chainTime = null, at = now) => heldUp(q(items, chainNonce, chainTime, at), at);

  // Calls to a program queue as payments do: each takes the nonce after the last still on its way.
  expect('nothing waiting: the chain’s nonce', next([], 7n), 7n);
  expect('one waiting: the nonce after it', next([call(7)], 7n), 8n);
  expect('three waiting: after the last', next([call(7), call(9), call(8)], 7n), 10n);
  expect('held by the node until its time counts', next([call(7, { state: 'deferred' })], 7n), 8n);
  expect('one the chain is past is not in the way', next([call(6)], 7n), 7n);
  for (const state of ['done', 'failed', 'lost', 'dismissed']) {
    expect(`one ${state} is not in the way`, next([call(7, { state })], 7n), 7n);
  }
  expect('one past its expiry is not in the way', next([call(7, { expires: T - 10 })], 7n, T - 5), 7n);
  expect('one noted without its nonce is not counted', next([call(7, { callNonce: undefined })], 7n), 7n);
  // A lookup can be a block ahead of the read that gave the chain's nonce.
  expect('a block took one the read does not show yet: the nonce after it', next([call(7, { state: 'included' })], 7n), 8n);
  expect('and what queues behind that one is in turn', held([call(7, { state: 'included' }), call(8)], 7n), null);
  expect('one included that the read already counts changes nothing', next([call(6, { state: 'included' })], 7n), 7n);

  // In order from the chain's nonce and within their hour, another can follow.
  expect('nothing waiting: sign', held([], 7n), null);
  expect('one waiting, its turn: sign behind it', held([call(7)], 7n), null);
  expect('three in order: sign behind them', held([call(8), call(7), call(9)], 7n), null);
  // The one whose turn it is did not go in: what waits behind it cannot, and neither could another.
  expect('the first failed: hold off until the rest have expired', held([call(7, { state: 'failed' }), call(8, { expires: T + 100 }), call(9, { expires: T + 900 })], 7n), { until: T + 900 });
  expect('the first expired and is lost: the same', held([call(7, { state: 'lost', expires: T - 50 }), call(8, { expires: T + 600 })], 7n), { until: T + 600 });
  expect('the first forgotten one by one: the same', held([call(7, { state: 'dismissed' }), call(8, { expires: T + 600 })], 7n), { until: T + 600 });
  expect('a gap in the middle: the same', held([call(7), call(9, { expires: T + 700 })], 7n), { until: T + 3600 });
  // Past its expiry by the clock, waiting only for the chain's time: nothing is signed behind it.
  expect('the first past its expiry by the clock', held([call(7, { expires: T - 10 }), call(8, { expires: T + 500 })], 7n, T - 11), { until: T + 500 });
  expect('all of them past it: until the last', held([call(7, { expires: T - 90 }), call(8, { expires: T - 10 })], 7n, T - 91), { until: T - 10 });
  expect('exactly at its expiry a block may still take it', held([call(7, { expires: T })], 7n), null);
  // Whoever keeps trying is not kept waiting by it: the time does not move, as nothing new is signed.
  expect('later, the same time', held([call(7, { state: 'failed' }), call(8, { expires: T + 100 })], 7n, null, T + 60), { until: T + 100 });
  // Once the chain's time has passed the last of them, the queue has run out.
  const ranOut = [call(7, { state: 'failed' }), call(8, { expires: T + 100 })];
  expect('the queue has run out: sign', held(ranOut, 7n, T + 100, T + 101), null);
  expect('with the chain’s nonce', next(ranOut, 7n, T + 100, T + 101), 7n);
  expect('one that never expires gives no time', held([call(7, { state: 'failed' }), call(8, { expires: undefined })], 7n), { until: null });

  // Two different calls to one program, signed one after the other, both go in: 7, then 8.
  const first = call(next([], 7n));
  const second = call(next([first], 7n));
  expect('the second call takes the program’s next nonce', [first.callNonce, second.callNonce], ['7', '8']);
  expect('and a third can follow', held([first, second], 7n), null);

  // What Settings forgets: what no block has taken, not what a node holds for later.
  expect('one waiting is forgotten', forgettable({ state: 'pending', expires: T }, now), true);
  expect('one lost is put away too', forgettable({ state: 'lost', expires: T }, now), true);
  expect('one due, handed to the node earlier', forgettable({ state: 'pending', expires: T, notBefore: T - 5 }, now), true);
  expect('not one held for a later time', forgettable({ state: 'pending', expires: T, notBefore: T + 5 }, now), false);
  expect('not one that signed no expiry, such as an identity’s change', forgettable({ state: 'pending' }, now), false);
  for (const state of ['deferred', 'included', 'done', 'failed', 'dismissed']) {
    expect(`not one ${state}`, forgettable({ state, expires: T }, now), false);
  }
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

  // A block took the first before the account was read again: the next goes after it, not at its nonce.
  store.set({ pending: [item('j', 5, now + 3600, { state: 'included' })] });
  expect('a block took one the read does not show yet', nextNonce(coin, account), 6n);
  store.set({ pending: [item('j', 5, now + 3600, { state: 'included' }), item('k', 6, now + 3600)] });
  expect('and one queued behind it is counted from there', nextNonce(coin, account), 7n);

  // Settings forgets what waits: put away, never sent again, and nothing of it counts any more.
  store.set({ pending: [
    item('l', 5, now + 3600), item('m', 6, now + 3600), item('n', 4, now - 9000, { state: 'lost' }),
    item('o', 7, now + 3600, { state: 'deferred' }),
    { id: 'p', summary: 'Run', at: Date.now(), network: 'test', hex: '00', state: 'pending', notBefore: now + 9000, runOf: 'x' },
    item('q', 3, now + 3600, { state: 'failed' }), item('r', 2, now + 3600, { state: 'done' }),
    item('s', 5, now + 3600, { network: 'other' }),
    { id: 't', summary: 'Link a guardian', at: Date.now(), network: 'test', hex: '00', state: 'pending' },
  ] });
  expect('before: the next action queues behind them', nextNonce(coin, account), 8n);
  expect('what would be forgotten', session.forgettable().map((p) => p.id), ['l', 'm', 'n']);
  expect('it says how many it forgot', session.forgetWaiting(), 3);
  expect('they are put away', ['l', 'm', 'n'].map(state), ['dismissed', 'dismissed', 'dismissed']);
  expect('what a node holds for later stays, and what is settled', ['o', 'p', 'q', 'r'].map(state), ['deferred', 'pending', 'failed', 'done']);
  expect('an identity’s change is left alone', state('t'), 'pending');
  expect('another network’s is left alone', state('s'), 'pending');
  expect('nothing left to forget', [session.forgettable().length, session.forgetWaiting()], [0, 0]);
  store.set({ pending: store.get().pending.filter((p) => p.id !== 'o') });
  expect('the next action takes the chain’s nonce', nextNonce(coin, account), 5n);
  expect('and all of the account is there to spend', spendable(coin, account), 1000n);
  const sentBefore = resent;
  answers.l = null;
  answers.m = null;
  tip(109);
  await session.watchPending();
  expect('forgotten, they are not sent again', resent, sentBefore);
  expect('nor followed', ['l', 'm'].map(state), ['dismissed', 'dismissed']);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('expiry: all passed');

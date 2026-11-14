#!/usr/bin/env node
// Links handed to the wallet in its address, `#ting:call?…`, read as written:
// each field decoded once (LINKS.md; TCR-1, the link), whether the page put the
// link there as written or percent-encoded as a whole. And durations in words,
// as Ting ID words them (TCR-1, field types: "a length of time, such as 7 days").
//
//   node scripts/test-call-links.mjs
import { readLink } from '../kit/web/tcr.js';
import { linkFromAddress, lowercaseIds, readPayLink } from '../web/js/links.js';
import { durationWords } from '../web/js/ui.js';

let failed = 0;
const check = (what, got, want) => {
  if (got === want) return;
  failed++;
  console.log(`✗ ${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
};

// A call link as a page writes one: the template and the return address each
// percent-encoded on their own; the return address has a query string of its own.
const template = 'give(item:u64,to:account): Give item {item} to {to}';
const returnTo = 'http://localhost:8770/ltc.html?node=http%3A%2F%2F127.0.0.1%3A28451&htlc=a921&ltcnet=regtest';
const link = `ting:call?net=85787871&program=${'ab'.repeat(32)}&template=${encodeURIComponent(template)}`
  + `&values=AQAAAAAAAAAREREREREREREREREREREREREREREREREREREREREREREREREQ&return=${encodeURIComponent(returnTo)}`;

for (const [what, fragment] of [
  ['a link as written', link],
  ['a link percent-encoded as a whole', encodeURIComponent(link)],
]) {
  const text = linkFromAddress(fragment);
  check(`${what}: read as written`, text, link);
  const f = await readLink(text);
  check(`${what}: the return address whole`, f.return, returnTo);
  check(`${what}: the template whole`, f.template, template);
}

// What the old reading did: the whole address decoded, then each field again.
// The return address's own `&` became the link's, and the address ended there.
const twice = await readLink(decodeURIComponent(link));
check('decoding twice cuts the return address (the bug)', twice.return === returnTo, false);

for (const [fragment, want] of [
  ['/send', null],
  ['/tx/ab12', null],
  ['', null],
  ['%E0%A4%A', null],
  ['TING:CALL?net=1', 'TING:CALL?net=1'],
  ['ting://call?net=1', 'ting://call?net=1'],
  ['ting%3Apay%3Fto%3Dab', 'ting:pay?to=ab'],
]) check(`the address #${fragment}`, linkFromAddress(fragment), want);

// Hex in either case (LINKS.md), read in lowercase, as the wallet keeps its own
// ids and Ting ID reads a link: a call link written in capitals pays the same
// coin and account, from the same account, on the same network.
const coinId = 'cd'.repeat(32), toId = 'ef'.repeat(32), fromId = '12'.repeat(32), programId = 'ab'.repeat(32);
const upper = `ting:call?net=8578ABCD&program=${programId.toUpperCase()}&template=${encodeURIComponent('pay(): Pay {payment}')}`
  + `&coin=${coinId.toUpperCase()}&to=${toId.toUpperCase()}&amount=10&from=${fromId.toUpperCase()}`;
const lowered = lowercaseIds(await readLink(upper));
check('a call link in capitals: its network', lowered.net, '8578abcd');
check('a call link in capitals: its program', lowered.program, programId);
check('a call link in capitals: its coin', lowered.coin, coinId);
check('a call link in capitals: its account to pay', lowered.to, toId);
check('a call link in capitals: the account it is for', lowered.from, fromId);

// Pay links (LINKS.md: `to`, `coin`?, `amount`?, `net`), read as Ting ID reads them.
const net = '85787871';
const pay = (q) => { try { return readPayLink(`ting:pay?${q}`, net); } catch (e) { return e.message; } };
const paid = pay(`TO=${toId.toUpperCase()}&Coin=${coinId.toUpperCase()}&amount=12.5&NET=${net}`);
check('a pay link in capitals: its account', paid.to, toId);
check('a pay link in capitals: its coin', paid.coin, coinId);
check('a pay link in capitals: its amount', paid.amount, '12.5');
const bare = pay(`to=${toId}&net=${net}`);
check('a pay link without coin or amount: coin', bare.coin, null);
check('a pay link without coin or amount: amount', bare.amount, null);
for (const [what, q] of [
  ['no network', `to=${toId}`],
  ['another network', `to=${toId}&net=15d6549c`],
  ['no account', `coin=${coinId}&net=${net}`],
  ['an account that is not 64 hex digits', `to=${toId.slice(2)}&net=${net}`],
  ['a coin that is not 64 hex digits', `to=${toId}&coin=DLR&net=${net}`],
  ['an amount with a comma', `to=${toId}&coin=${coinId}&amount=1,5&net=${net}`],
  ['an account given twice', `to=${toId}&TO=${fromId}&net=${net}`],
]) check(`a pay link with ${what} is refused`, typeof pay(q), 'string');

// Ting ID's own wording (core/…/text/Describe.kt, relativeDuration), but for
// under a minute: there, in seconds, not rounded to `0 minutes`.
for (const [seconds, want] of [
  [0, 'none'],
  [1, '1 second'],
  [10, '10 seconds'],
  [59, '59 seconds'],
  [60, '1 minute'],
  [45 * 60, '45 minutes'],
  [3600, '1 hour'],
  [5400, '1.5 hours'],
  [43_200, '12 hours'],
  [86_400, '1 day'],
  [25 * 3600, '1 day'],
  [129_600, '1.5 days'],
  [604_800, '7 days'],
  [2 ** 64, `${2 ** 64} seconds`],
]) check(`${seconds} s`, durationWords(seconds), want);

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
console.log('call links and durations: all passed');

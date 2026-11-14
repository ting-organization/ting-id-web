#!/usr/bin/env node
// Links handed to the wallet in its address, `#ting:call?…`, read as written:
// each field decoded once (LINKS.md; TCR-1, the link), whether the page put the
// link there as written or percent-encoded as a whole. And durations in words,
// as Ting ID words them (TCR-1, field types: "a length of time, such as 7 days").
//
//   node scripts/test-call-links.mjs
import { readLink } from '../kit/web/tcr.js';
import { linkFromAddress } from '../web/js/links.js';
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

// Ting ID's own wording (core/…/text/Describe.kt, relativeDuration).
for (const [seconds, want] of [
  [0, 'none'],
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

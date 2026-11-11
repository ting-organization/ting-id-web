#!/usr/bin/env node
// A stand-in for Ting ID on the development chain: reads a `ting:call` link
// as a wallet must, shows the operation in the program's words, signs it with
// a P-256 key of its own, pays if the link asks, and submits it. The key is
// kept in .devchain.json, and funded from the faucet when it must pay.
//
//   node kit/scripts/wallet.mjs '<ting:call link>'
//
// With a payment, the payment is the approval and the call carries no
// witness. Without one, a link that names a coin gets a fee payment, a
// transfer of 0 to the program's account that carries the fee, as the
// approval; otherwise the key signs the call's digest. Its account has no
// delay.
import { hex, unhex } from '../web/bytes.js';
import * as C from '../web/coin.js';
import { Key } from '../web/keys.js';
import * as tcr from '../web/tcr.js';
import { Chain } from './chain.mjs';
import { loadState, NODE_URL, saveState } from './devchain.mjs';

const [link] = process.argv.slice(2);
if (!link) {
  console.error("usage: node kit/scripts/wallet.mjs '<ting:call link>'");
  process.exit(2);
}
const chain = await Chain.open(NODE_URL);

// What a wallet checks before anyone signs (TCR-1, checking): the link's own
// rules, read by readLink; the program's template list; the values.
const fields = await tcr.readLink(link);
if (fields.net !== chain.chainHex.slice(0, 8)) throw new Error('a link for another network');
const program = unhex(fields.program);
const values = fields.valueBytes;
const listed = tcr.decodeTemplateList(await chain.node.record(program, tcr.TEMPLATES_KEY));
tcr.checkListed(listed, fields.template);
const { parts } = tcr.decodeValues(fields.parsed, values);
if (fields.coin && (await chain.node.contract(unhex(fields.coin))).code_hash !== C.CODE_HASH) {
  throw new Error('the payment is in a contract that is not a coin');
}

const state = loadState();
const coin = unhex(state.coin);
if (!state.wallet) {
  state.wallet = (await Key.generate()).jwk;
  saveState(state);
}
const signer = (await Key.fromJwk(state.wallet)).signer(chain.policy);
const info = C.decodeCoin(await chain.node.record(coin, C.CONFIG_KEY));
const units = (text) => C.parseAmount(text, info.decimals);
const shown = (type, v) => {
  if (type.enum) return v.label;
  if (type.list) return `${v.length} (${v.map((item) => Object.values(item).map((x) => x.label ?? String(x)).join(' ')).join(', ')})`;
  if (type === 'amount') return `${C.formatAmount(v.amount, info.decimals)} ${hex(v.coin) === hex(coin) ? info.symbol : 'of an unknown coin'}`;
  if (type === 'text') return `“${v}”`;
  if (type === 'time') return new Date(v * 1000).toISOString();
  if (type === 'bytes') return `${v.length} bytes`;
  if (v instanceof Uint8Array) return hex(v);
  return String(v);
};
const paymentText = fields.burn ? `${fields.burn} ${info.symbol}` : fields.amount ? `${fields.amount} ${info.symbol}` : '';
const show = (p) => (p.payment ? paymentText : p.slot ? shown(p.type, p.value) : p.text);
console.log(`Program    ${fields.program}`);
console.log(`Operation  ${parts.map(show).join('')}`);
console.log(`Account    ${hex(signer.account)}`);

let payment = null;
if (fields.burn || fields.to) {
  if (fields.coin !== state.coin) throw new Error('the payment is in a coin this wallet does not hold');
  const effect = fields.burn ? C.burnEffect(units(fields.burn)) : C.transferEffect(unhex(fields.to), units(fields.amount));
  console.log(`Pays       ${fields.burn ? `${fields.burn} ${info.symbol}, burned` : `${fields.amount} ${info.symbol} to ${fields.to}`}`);
  const need = units(fields.burn ?? fields.amount);
  if ((await chain.funds(coin, signer.account)).available < need) {
    const faucet = (await Key.fromJwk(state.faucet)).signer(chain.policy);
    await chain.transfer(faucet, coin, signer.account, need + 100_000_000n);
  }
  payment = { coin, coinNonce: (await chain.funds(coin, signer.account)).nonce, effect };
} else if (fields.coin) {
  if (fields.coin !== state.coin) throw new Error('the program takes fee payments in a coin this wallet does not hold');
  console.log('Pays       nothing but the fee, as a fee payment');
  payment = { coin, coinNonce: (await chain.funds(coin, signer.account)).nonce, effect: tcr.feeEffect(program) };
}
if (fields.from && fields.from !== hex(signer.account)) throw new Error('the link is for another account');

const nonce = await chain.nonce(program, signer.account);
const head = tcr.head(fields.template, values);
const input = await tcr.signCall({
  signer, chain: chain.chain, program, nonce, head, payment,
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
});
const r = await chain.call(program, input);
console.log(r.status === 0 ? `Done, in block ${r.height}` : `Failed: ${r.reason}`);
// A wallet offers the page back, and never opens it by itself.
if (fields.return) console.log(`Return     ${fields.return}#ting-tx=${r.id}`);
process.exit(r.status === 0 ? 0 : 1);

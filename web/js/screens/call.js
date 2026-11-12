// Links: `ting:call` (TCR-1, a program call), `ting:pay` (a payment) and
// `ting:create` (someone's new identity, to send its first coins: sponsor.js).
// They open from the address bar, `#ting:call?…`, so that any page can hand
// one to this wallet with a plain https link. A device, guardian or recovery
// link never opens that way (links.js): only scanned or pasted on the Scan
// screen.
import { hex, unhex } from '../../../kit/web/bytes.js';
import * as tcr from '../../../kit/web/tcr.js';
import { BUDGETS } from '../chain/budgets.js';
import * as coins from '../chain/coins.js';
import { autoFee } from '../chain/fees.js';
import { coinMark, exactMoney as money, notices, who } from '../parts.js';
import { session } from '../session.js';
import { $, amount, esc, icon, parseAmount, problem, short, toast } from '../ui.js';
import { INSIDE_ONLY } from '../links.js';
import { prefill } from './send.js';
import { sponsor } from './sponsor.js';

/** Reference programs: a call link never names one of these as its program. */
const REFERENCE_CODES = new Set([
  coins.CODE_HASH,
  'f065bf6d04a34ecbbeb94fb91571ccb2c08c6070cffd2ea4df948b46cda5ef06',
  '492e5470e3384a0bfa7cdfcf496c2e374a314325ce24327c75670f17e9201dcf',
  'edea54d81ee9c28319bb5f0aea7aacbe891654e358f6a5cbe7225078ba7396d3',
]);

const pending = new Map();

async function check(link) {
  const f = await tcr.readLink(link);
  if (f.net !== session.net.chainId.slice(0, 8)) throw new Error('This link is for another network.');
  const program = unhex(f.program);
  const contract = await session.pool.contract(program).catch(() => null);
  if (!contract) throw new Error('No program has that ID on this network.');
  if (REFERENCE_CODES.has(contract.code_hash)) throw new Error('A call link cannot name a reference program.');
  const list = tcr.decodeTemplateList(await session.pool.record(program, tcr.TEMPLATES_KEY));
  tcr.checkListed(list, f.template);
  const { parts } = tcr.decodeValues(f.parsed, f.valueBytes);
  let coin = null;
  if (f.coin) {
    coin = session.coins.find((c) => c.id === f.coin);
    if (!coin) {
      const c = await session.pool.contract(unhex(f.coin)).catch(() => null);
      if (c?.code_hash !== coins.CODE_HASH) throw new Error('The payment is in a contract that is not a coin.');
      throw new Error(`The link pays in coin ${short(f.coin)}, which you do not follow. Follow it in Settings first.`);
    }
  }
  const spending = coin?.accounts[0];
  const paid = f.burn ?? f.amount;
  const units = paid && coin ? parseAmount(paid, coin.decimals) : null;
  const fee = coin ? await autoFee(session.pool, coin.id).catch(() => 0n) : 0n;
  if (f.from && session.accounts()[0] !== f.from) throw new Error('This link is for another account.');
  return { f, program, parts, coin, spending, units, fee };
}

function shown(part, coin) {
  if (part.payment) return '';
  if (!part.slot) return esc(part.text);
  const { type, value } = part;
  let text;
  if (type === 'amount') {
    const c = session.coins.find((x) => x.id === hex(value.coin));
    text = c ? money(value.amount, c) : `${value.amount} of coin ${short(value.coin)}`;
  } else if (type === 'account') text = esc(who(hex(value)));
  else if (type === 'coin') text = esc(session.coins.find((x) => x.id === hex(value))?.symbol ?? short(value));
  else if (type === 'text') text = `“${esc(value)}”`;
  else if (type === 'time') text = esc(new Date(Number(value) * 1000).toLocaleString());
  else if (type.enum) text = esc(value.label);
  else if (type.list) text = `${value.length} items`;
  else if (value instanceof Uint8Array) text = short(value);
  else text = esc(String(value));
  return `<b>${text}</b>`;
}

export const link = {
  async render(raw) {
    const text = decodeURIComponent(raw);
    const kind = (/^ting:(?:\/\/)?([a-z]+)/i.exec(text)?.[1] ?? '').toLowerCase();
    if (!session.saved() && kind !== 'pay') {
      return `<section class="screen plain narrow"><h1 class="page">Ting link</h1>
        <div class="note mt">${icon('info')}<div>Create or open an identity first, then open the link again.</div></div>
        <a class="btn primary mt" href="#/welcome">Get started</a></section>`;
    }
    if (kind === 'pay') {
      const f = Object.fromEntries(new URLSearchParams(text.slice(text.indexOf('?') + 1)));
      if (f.net && f.net !== session.net.chainId.slice(0, 8)) return failed('This pay link is for another network.');
      // A link writes its amount with a dot, `12.5` (LINKS.md); `1,5` or `1,000` could mean two things.
      if (f.amount && !/^\d+(\.\d+)?$/.test(f.amount)) return failed('This pay link’s amount is not written as links write one, like 12.5.');
      prefill({ to: f.to, coin: f.coin, amount: f.amount });
      setTimeout(() => { location.hash = '#/send'; });
      return '';
    }
    if (kind === 'create') return sponsor.render(text);
    if (INSIDE_ONLY.has(kind)) {
      return failed('This kind of link lets someone into an identity, so it never opens from another page or a message. Scan its code on the Scan screen, or paste it there.');
    }
    if (kind === 'sign') return failed('Signing in to sites (TOCS-1) is not in Ting ID Web yet. Use Ting ID on your phone for it.');
    if (kind !== 'call') return failed('Ting ID Web does not open this kind of link.');
    let c;
    try {
      c = await check(text);
    } catch (e) {
      return failed(problem(e));
    }
    pending.set(text, c);
    const { f, program, parts, coin, units, fee } = c;
    const sentence = parts.map((p) => (p.payment ? `<b>${coin ? money(units, coin) : f.amount ?? f.burn}</b>` : shown(p, coin))).join('');
    const payWords = f.burn ? `Burns ${money(units, coin)}` : f.to ? `${money(units, coin)} to ${esc(who(f.to))}` : 'Nothing but the fee';
    return `<section class="screen plain narrow">
      <h1 class="page">A program call</h1>
      ${notices()}
      <div class="card list mt"><div class="row"><span class="avatar">${icon('call')}</span><span class="main"><b>A program Ting ID does not know</b>
        <span class="mono">Program ${short(program)}</span></span></div></div>
      <div class="card pad mt"><div class="muted small">The program says</div><p class="says">${sentence}</p></div>
      <div class="card mt">
        <div class="kv"><span>From</span><span>${esc(session.saved().name)} · Spending</span></div>
        <div class="kv"><span>${f.burn ? 'Burns' : f.to ? 'Pays' : 'Pays'}</span><span>${payWords}</span></div>
        <div class="kv"><span>Fee</span><span>${fee && coin ? money(fee, coin) : 'None'}</span></div>
        <div class="kv"><span>Can be used</span><span>For an hour after you approve</span></div>
      </div>
      <div class="note warn">${icon('warn')}<div>Only approve what you meant to do on the page that sent you here. The program’s words are its own, not Ting ID’s.</div></div>
      <button class="btn primary mt" data-approve>${icon('key')} Approve</button>
      <a class="link" href="#/wallet">Decline</a>
    </section>`;
  },

  bind(view, raw) {
    const text = decodeURIComponent(raw);
    if (/^ting:(?:\/\/)?create/i.test(text)) return sponsor.bind(view, text);
    $('[data-approve]', view)?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      const c = pending.get(text);
      const signer = session.signer();
      if (!signer) return toast('This browser can’t act for this identity yet');
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Waiting for your passkey';
      try {
        const { f, program, coin, spending, units, fee } = c;
        const slot = signer.slot(0);
        const nonceBytes = await session.pool.record(program, tcr.nonceKey(slot.account));
        const nonce = nonceBytes ? new DataView(nonceBytes.buffer, nonceBytes.byteOffset).getBigUint64(0, true) : 0n;
        let payment = null;
        if (f.burn || f.to) {
          const effect = f.burn ? coins.framed && new Uint8Array([2, ...u128le(units)]) : coins.transferEffect(unhex(f.to), units);
          payment = { coin: unhex(coin.id), coinNonce: spending.record.nonce, effect, fee };
        } else if (coin && fee) {
          payment = { coin: unhex(coin.id), coinNonce: spending.record.nonce, effect: tcr.feeEffect(program), fee };
        }
        const input = await tcr.signCall({
          signer: slot, chain: session.chain, program, nonce, head: tcr.head(f.template, f.valueBytes), payment,
          validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
        });
        const summary = `Program call · ${short(program)}`;
        const sent = await session.call(program, input, BUDGETS.batch, summary, f.return ? { returnTo: f.return } : {});
        location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        button.disabled = false;
        button.innerHTML = `${icon('key')} Approve`;
      }
    });
  },
};

function u128le(v) {
  const out = [];
  for (let i = 0; i < 16; i++, v >>= 8n) out.push(Number(v & 0xffn));
  return out;
}

function failed(message) {
  return `<section class="screen plain narrow"><h1 class="page">This link can’t be used</h1>
    <div class="note bad mt">${icon('warn')}<div>${esc(message)}</div></div>
    <a class="btn secondary mt" href="#/wallet">Back to wallet</a></section>`;
}

export { amount, coinMark };

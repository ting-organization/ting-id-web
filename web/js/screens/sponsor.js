// Getting someone started, from their create link (Ting ID's LINKS.md): the
// identity they made on their device, sent its first coins and, while no
// block has it yet, created here, with this identity paying the fee. Anyone
// may submit a creation, but only exactly as made: the ID is the hash of the
// creation input, so the link cannot be turned into another identity. The
// name is only what the link says.
//
// And the other side: the code a new identity shows to get its first coins.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { qrSvg } from '../../../kit/web/qr.js';
import { batchInput, prefixAfter } from '../chain/batch.js';
import { BUDGETS } from '../chain/budgets.js';
import * as coins from '../chain/coins.js';
import { autoFee } from '../chain/fees.js';
import { BATCH_CODE_HASH } from '../chain/net.js';
import * as registry from '../chain/registry.js';
import { createLink, readCreateLink } from '../links.js';
import { coinMark, exactMoney, fingerprint, keyKind, netTag } from '../parts.js';
import { session } from '../session.js';
import * as store from '../store.js';
import { $, amount, duration, esc, icon, parseAmount, problem, short, toast } from '../ui.js';
import { nextNonce } from './send.js';

const checked = new Map();

/** What a create link asks, checked against the chain; throws, saying why, when it can't be done. */
async function check(text) {
  const me = session.identity;
  if (!me?.onChain || me.keyId == null) throw new Error('This browser can’t act for an identity yet, so it can’t send coins.');
  const link = readCreateLink(text, netTag());
  let creation;
  try {
    creation = registry.decodeCreation(link.input);
  } catch {
    throw new Error('The identity in this link is not written right.');
  }
  const id = registry.idOf(link.input);
  if (hex(id) === hex(me.id)) throw new Error('This is your own identity’s link: show it to someone who has coins.');
  const exists = Boolean(await session.pool.record(session.registry, registry.coreKey(id)));
  const coin = link.coin ? session.coins.find((c) => c.id === link.coin)
    : session.coins.find((c) => c.id === store.get().coin) ?? session.coins[0];
  if (link.coin && !coin) throw new Error(`The link asks for coin ${short(link.coin)}, which you do not follow. Follow it in Settings first.`);
  if (!coin) throw new Error('Follow a coin in Settings first.');
  if (!exists) {
    const batch = await session.pool.contract(unhex(session.net.batch)).catch(() => null);
    if (batch?.code_hash !== BATCH_CODE_HASH) throw new Error('The batch program is not on this network, so the wallet cannot pay for a creation here.');
  }
  const fee = await autoFee(session.pool, coin.id).catch(() => 0n);
  return { link, creation, id, exists, coin, spending: coin.accounts[0], fee };
}

const failed = (message) => `<section class="screen plain narrow"><h1 class="page">This link can’t be used</h1>
  <div class="note bad mt">${icon('warn')}<div>${esc(message)}</div></div>
  <a class="btn secondary mt" href="#/wallet">Back to wallet</a></section>`;

export const sponsor = {
  async render(text) {
    let c;
    try {
      c = await check(text);
    } catch (err) {
      return failed(problem(err));
    }
    checked.set(text, c);
    const { link, creation, id, exists, coin, spending, fee } = c;
    const who = link.name ?? 'Someone';
    const asked = link.amount && parseAmount(link.amount, coin.decimals) !== null ? link.amount : '';
    return `<section class="screen plain narrow">
      <h1 class="page">Get ${esc(who)} started</h1>
      <p class="lead">${exists
        ? `This identity is on chain already: you send it coins to start with.`
        : `No block has this identity yet. You create it, exactly as its link describes, paying the fee, and send it coins to start with.`}</p>
      <div class="card list"><div class="row"><span class="avatar">${icon('identity')}</span><span class="main">
        <b>${esc(who)}</b><span class="mono">Identity ${short(id)}</span></span>
        <span class="chip ${exists ? 'good' : 'warn'}">${exists ? 'On chain' : 'Not yet'}</span></div></div>
      ${exists ? '' : `<div class="card mt">
        <div class="kv"><span>Keys</span><span>${creation.keys.map((k) => `${esc(keyKind(k))} <span class="mono">${fingerprint(k.params)}</span>`).join('<br>')}</span></div>
        <div class="kv"><span>Guardians</span><span>${creation.guardians.length || 'None yet'}</span></div>
        <div class="kv"><span>Savings withdrawals wait</span><span>${esc(duration(creation.slots[1] ?? 0n))}</span></div>
        <div class="kv"><span>Changes wait</span><span>${esc(duration(creation.changeDelay))}</span></div></div>`}
      <div class="card mt">
        <label class="field"><span>Send them</span><div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0" value="${esc(asked)}" autocomplete="off"><em>${esc(coin.symbol)}</em></div></label>
        <div class="kv"><span>From</span><span>Your Spending · ${exactMoney(spending.record.available, coin)} available</span></div>
        <div class="kv"><span>Fee</span><span>${fee ? exactMoney(fee, coin) : 'None'}</span></div>
      </div>
      <div class="note warn">${icon('warn')}<div>“${esc(who)}” is only what the link says. Send to someone you know, who showed you this code themselves.</div></div>
      <button class="btn primary mt" data-send>${coinMark(coin)} ${exists ? 'Send' : 'Create and send'}</button>
      <a class="link" href="#/wallet">Decline</a>
    </section>`;
  },

  bind(view, text) {
    const c = checked.get(text);
    const button = $('[data-send]', view);
    if (!c || !button) return;
    button.addEventListener('click', async () => {
      const { link, id, exists, coin, spending, fee } = c;
      const units = parseAmount($('[name=amount]', view).value || '0', coin.decimals);
      if (units === null) return toast(`Enter an amount like 12.5, with at most ${coin.decimals} decimals`);
      if (exists && units === 0n) return toast('Enter how much to send them');
      if (units + fee > spending.record.available) return toast(`Only ${amount(spending.record.available, coin.decimals)} ${coin.symbol} available`);
      const signer = session.signer();
      if (!signer) return toast('This browser can’t act for this identity yet');
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Waiting for your passkey';
      try {
        const to = registry.slotAccount(session.registry, id, 0);
        const nonce = nextNonce(coin.id, spending);
        const who = link.name ?? `Identity ${short(id)}`;
        const summary = `${exists ? '' : `Create ${who}, and send `}${amount(units, coin.decimals)} ${coin.symbol}${exists ? ` to ${who}` : ''}`;
        const pay = { chain: session.chain, coin: unhex(coin.id), signer: signer.slot(0), nonce, effect: coins.transferEffect(to, units), fee };
        const noted = { coin: coin.id, account: hex(spending.account), nonce: nonce.toString() };
        let sent;
        if (exists) {
          sent = await session.call(unhex(coin.id), await coins.actionInput(pay), BUDGETS.execute, summary, noted);
        } else {
          // One transaction: the creation, then the payment that pays its fee, bound to the batch after the creation.
          const create = { target: session.registry, input: registry.createInput(link.input) };
          const batch = unhex(session.net.batch);
          const payment = await coins.actionInput({ ...pay, within: { program: batch, commitment: prefixAfter([create]) } });
          sent = await session.call(batch, batchInput([create, { target: unhex(coin.id), input: payment }]), BUDGETS.batch, summary, noted);
        }
        if (link.name && !store.contactOf(hex(to)) && !store.get().contacts.some((x) => x.name.toLowerCase() === link.name.toLowerCase())) {
          store.saveContact(link.name, hex(to), hex(id));
        }
        location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        button.disabled = false;
        button.innerHTML = `${coinMark(coin)} ${exists ? 'Send' : 'Create and send'}`;
      }
    });
  },
};

/**
 * On the wallet of an identity made here that holds no coins yet: its create
 * link, to show someone who has some. They send coins to start with, and put
 * the identity in a block, paying its fee, if none has it yet.
 */
export function firstCoins() {
  const saved = session.saved();
  const id = session.identity;
  if (!saved?.creation || !id || (id.onChain && id.keyId == null)) return '';
  const holds = session.coins.some((c) => c.accounts.some((a) => a.record.balance > 0n));
  if (holds || session.activity.some((a) => a.kind === 'received')) return '';
  const link = createLink(netTag(), unhex(saved.creation), saved.name);
  let qr = '';
  try { qr = qrSvg(link); } catch { /* too long: the link can still be copied */ }
  return `<div class="card pad stack"><b>Get your first coins</b>
    <p class="muted">Show this to someone who has coins. They scan it with Ting ID or Ting ID Web and send you some to start with${id.onChain ? '' : ', and put your identity in the next block, paying its fee'}.</p>
    <div class="qr">${qr}</div>
    <button class="btn secondary" data-copy="${esc(link)}">${icon('copy')} Copy link</button></div>`;
}

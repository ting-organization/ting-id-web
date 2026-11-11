// Send, Review payment, Transaction, Receive and Scan: paying and getting paid.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { qrSvg } from '../../../kit/web/qr.js';
import { idOf } from '../../../kit/web/ting.js';
import { BUDGETS } from '../chain/budgets.js';
import * as coins from '../chain/coins.js';
import { autoFee } from '../chain/fees.js';
import { accountBox, coinMark, money, notices, who } from '../parts.js';
import { reasonOf, session } from '../session.js';
import * as store from '../store.js';
import { $, $$, amount, copy, duration, esc, grouped, icon, initials, parseAmount, problem, short, toast, when } from '../ui.js';
import { currentCoin } from './wallet.js';

/** The payment being written: it survives a trip to Review and back. */
const draft = { coin: null, slot: 0, to: '', amount: '', fee: null, feeAuto: true };

export function prefill({ to, coin, amount: a, slot }) {
  if (to) draft.to = to;
  if (coin) draft.coin = coin;
  if (a) draft.amount = a;
  if (slot != null) draft.slot = slot;
}

function current() {
  const coin = session.coins.find((c) => c.id === draft.coin) ?? currentCoin();
  const account = coin?.accounts[draft.slot] ?? coin?.accounts[0];
  return { coin, account };
}

/** What is wrong with the draft, in words; empty when it can go to Review. */
function problems(coin, account) {
  const out = [];
  const to = idOf(draft.to.replace(/\s+/g, ''));
  if (!draft.to.trim()) out.push('Enter who to pay');
  else if (!to) out.push('The recipient must be a 64-digit hex account');
  else if (to.every((b) => b === 0)) out.push('Nobody can spend from that account: check the recipient');
  else if (session.identity && hex(to) === hex(session.identity.id)) out.push('That is your identity’s ID, not an account: send to an account');
  const units = parseAmount(draft.amount, coin.decimals);
  if (!draft.amount.trim()) out.push('Enter an amount like 12.5');
  else if (units === null) out.push(`Enter an amount like 12.5, with at most ${coin.decimals} decimals`);
  else if (units <= 0n) out.push('The amount must be above zero');
  else if (units + (account.delay ? 0n : draft.fee ?? 0n) > account.record.available) {
    out.push(`Only ${amount(account.record.available, coin.decimals)} ${coin.symbol} available`);
  }
  return out;
}

export const send = {
  async render(to) {
    if (to) draft.to = to;
    const { coin, account } = current();
    if (!coin) return `<section class="screen plain narrow"><h1 class="page">Send</h1><div class="note mt">${icon('info')}<div>Follow a coin in Settings first.</div></div></section>`;
    draft.coin = coin.id;
    if (draft.feeAuto && !account.delay) draft.fee = await autoFee(session.pool, coin.id).catch(() => 0n);
    if (account.delay) draft.fee = 0n;
    const toId = idOf(draft.to.replace(/\s+/g, ''));
    const toName = toId ? store.nameOf(hex(toId), session.accounts()) : null;
    const contacts = store.get().contacts;
    const own = session.accounts().map((a, n) => ({ name: `Your ${n === 1 ? 'Savings' : n === 0 ? 'Spending' : `account ${n + 1}`}`, account: a }))
      .filter((o) => o.account !== hex(account.account));
    const choices = [...own, ...contacts].map((c) => `<button class="row" type="button" data-pick="${c.account}"><span class="avatar">${esc(initials(c.name))}</span><span class="main"><b>${esc(c.name)}</b><span class="mono">${short(c.account)}</span></span></button>`).join('');
    return `<section class="screen plain narrow">
      <div class="head"><h1>Send</h1></div>
      ${notices()}
      <div class="card list">
        <button class="row" type="button" data-from>${coinMark(coin)}<span class="main"><b>${esc(session.saved()?.name ?? 'You')} · ${esc(account.name)}</b>
          <span>${money(account.record.available, coin)} available · ${account.delay ? `${duration(account.delay)} lock` : 'Instant'}</span></span>${icon('swap')}</button>
      </div>
      ${account.delay ? `<div class="note warn mt">${icon('lock')}<div>Withdrawals from ${esc(account.name)} wait ${esc(duration(account.delay))}: it runs when the lock ends, and you can cancel it until then.</div></div>` : ''}
      <div class="card mt">
        <label class="field"><span>Amount</span><div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0" value="${esc(draft.amount)}" autocomplete="off"><em>${esc(coin.symbol)}</em>
          <button class="btn small secondary" type="button" data-max>Max</button></div></label>
        <label class="field"><span>To</span><textarea name="to" rows="2" spellcheck="false" placeholder="Account or pay link">${esc(toId ? grouped(toId) : draft.to)}</textarea>
          ${toName ? `<div class="hint">${esc(toName)}</div>` : ''}</label>
        ${choices ? `<details class="field"><summary class="link">${icon('people')} Choose from your accounts and contacts</summary><div class="list">${choices}</div></details>` : ''}
        <div class="kv"><span>Fee</span><span>${draft.fee ? `${money(draft.fee, coin)} · ${esc(account.name)}` : 'None'} <button class="link" type="button" data-fee>Change</button></span></div>
      </div>
      <div class="note warn mt" data-problems hidden></div>
      <button class="btn primary mt" data-review>Review</button>
    </section>`;
  },

  bind(view) {
    const { coin, account } = current();
    if (!coin) return;
    const form = { amount: $('[name=amount]', view), to: $('[name=to]', view) };
    form.amount.addEventListener('input', () => { draft.amount = form.amount.value; });
    form.to.addEventListener('input', () => {
      const text = form.to.value.trim();
      if (/^ting:/i.test(text) || text.includes('#ting:')) return useLink(text);
      draft.to = text;
    });
    $('[data-max]', view).addEventListener('click', () => {
      const most = account.record.available - (account.delay ? 0n : draft.fee ?? 0n);
      draft.amount = most > 0n ? amount(most, coin.decimals).replace(/ /g, '') : '0';
      form.amount.value = draft.amount;
    });
    $('[data-from]', view).addEventListener('click', () => {
      draft.slot = (draft.slot + 1) % coin.accounts.length;
      draft.feeAuto = true;
      location.hash = '#/send';
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    $$('[data-pick]', view).forEach((b) => b.addEventListener('click', () => {
      draft.to = b.dataset.pick;
      dispatchEvent(new HashChangeEvent('hashchange'));
    }));
    $('[data-fee]', view).addEventListener('click', () => {
      if (account.delay) return toast('A withdrawal from a locked account carries no fee of its own');
      const text = prompt(`Fee in ${coin.symbol} (empty for automatic)`, draft.fee ? amount(draft.fee, coin.decimals).replace(/ /g, '') : '');
      if (text === null) return;
      if (!text.trim()) draft.feeAuto = true;
      else {
        const v = parseAmount(text, coin.decimals);
        if (v === null) return toast('Not an amount');
        draft.fee = v;
        draft.feeAuto = false;
      }
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    $('[data-review]', view).addEventListener('click', () => {
      draft.amount = form.amount.value;
      draft.to = form.to.value;
      const list = problems(coin, account);
      const box = $('[data-problems]', view);
      if (list.length) {
        box.hidden = false;
        box.innerHTML = `${icon('warn')}<div>${esc(list.join('. '))}.</div>`;
        return;
      }
      location.hash = '#/review';
    });
  },
};

function useLink(text) {
  const link = text.slice(text.indexOf('ting:'));
  location.hash = `#${link}`;
}

export const review = {
  render() {
    const { coin, account } = current();
    if (!coin || problems(coin, account).length) return send.render();
    const to = hex(idOf(draft.to.replace(/\s+/g, '')));
    const units = parseAmount(draft.amount, coin.decimals);
    const name = store.nameOf(to, session.accounts());
    const fee = draft.fee ?? 0n;
    const lock = account.delay;
    return `<section class="screen plain narrow">
      <button class="back" data-edit>${icon('back')} Edit</button>
      <h1 class="page">Review payment</h1>
      <div class="big-amount">${coinMark(coin, true)}<b>${amount(units, coin.decimals)}<small>${esc(coin.symbol)}</small></b>
        <p>${lock ? `Runs when the ${esc(duration(lock))} lock ends` : 'Goes as soon as a block includes it'}</p></div>
      <div class="card">
        <div class="kv"><span>From</span><span>${esc(session.saved()?.name ?? 'You')} · ${esc(account.name)}</span></div>
        <div class="kv block"><span>To</span><div>${name ? `<b>${esc(name)}</b> <span class="mono muted">${short(to)}</span>` : `<b>New recipient</b>${accountBox(to)}
          <button class="link" data-save>${icon('userplus')} Save as contact</button>`}</div></div>
        <div class="kv"><span>When</span><span>${lock ? `In ${esc(duration(lock))}` : 'Now'}</span></div>
        <div class="kv"><span>Fee</span><span>${fee ? money(fee, coin) : 'None'}</span></div>
        <div class="kv"><span>Total from ${esc(account.name)}</span><span>${money(units + fee, coin)}</span></div>
        <div class="kv"><span>Available after</span><span>${money(account.record.available - units - fee, coin)}</span></div>
      </div>
      ${lock ? `<div class="note warn">${icon('lock')}<div>${money(units, coin)} is reserved until it runs, and you can cancel it from the wallet until then.</div></div>` : ''}
      ${name ? '' : `<div class="note">${icon('user')}<div>This account is not in your contacts. Check the address with whoever you pay: a payment cannot be taken back once it runs.</div></div>`}
      <button class="btn primary mt" data-confirm>${icon('key')} Confirm and ${lock ? 'schedule' : 'send'}</button>
      <button class="link" data-edit>Edit</button>
    </section>`;
  },

  bind(view) {
    const { coin, account } = current();
    $$('[data-edit]', view).forEach((b) => b.addEventListener('click', () => { location.hash = '#/send'; }));
    $('[data-save]', view)?.addEventListener('click', () => {
      const name = prompt('Name for this account');
      if (name?.trim()) {
        store.saveContact(name, hex(idOf(draft.to.replace(/\s+/g, ''))));
        dispatchEvent(new HashChangeEvent('hashchange'));
      }
    });
    $('[data-confirm]', view)?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      const signer = session.signer();
      if (!signer) return toast('This browser can’t act for this identity yet');
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Waiting for your passkey';
      try {
        const to = idOf(draft.to.replace(/\s+/g, ''));
        const units = parseAmount(draft.amount, coin.decimals);
        const slot = signer.slot(account.slot);
        const nonce = nextNonce(coin.id, account);
        const input = await coins.actionInput({
          chain: session.chain, coin: unhex(coin.id), signer: slot, nonce,
          effect: coins.transferEffect(to, units), fee: account.delay ? 0n : draft.fee ?? 0n,
        });
        const summary = `${amount(units, coin.decimals)} ${coin.symbol} to ${who(hex(to))}`;
        const sent = await session.call(unhex(coin.id), input, BUDGETS.execute, summary, { coin: coin.id, account: hex(account.account), nonce: nonce.toString() });
        if (account.delay) {
          // The run of the scheduled payment, handed to the node to hold until it is due.
          const notBefore = Math.floor(Date.now() / 1000) + Number(account.delay) + 30;
          await session.call(unhex(coin.id), coins.runInput(account.account, nonce), BUDGETS.claim,
            `Run: ${summary}`, { notBefore, runOf: `${coin.id}:${hex(account.account)}:${nonce}` }).catch(() => {});
        }
        draft.amount = '';
        draft.to = '';
        location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        button.disabled = false;
        button.innerHTML = `${icon('key')} Try again`;
      }
    });
  },
};

/** The next nonce for an account: after this browser’s own action still on its way, if any. */
function nextNonce(coinId, account) {
  const pending = session.pending().filter((p) => p.coin === coinId && p.account === hex(account.account)
    && ['pending', 'deferred'].includes(p.state) && Date.now() - p.at < 2 * 86_400_000);
  const noted = pending.map((p) => BigInt(p.nonce)).reduce((a, b) => (b > a ? b : a), -1n);
  return noted >= account.record.nonce ? noted + 1n : account.record.nonce;
}

const STAGES = {
  pending: ['clock', 'Waiting for a block', 'warn'],
  deferred: ['clock', 'Held by the node until its time', ''],
  included: ['check', 'Confirmed', 'good'],
  done: ['check', 'Confirmed', 'good'],
  failed: ['x', 'Failed', 'bad'],
};

export const tx = {
  async render(id) {
    const mine = session.pending().find((p) => p.id === id);
    const t = await session.pool.transaction(id).catch(() => null);
    const last = t?.occurrences?.at(-1);
    const state = last ? (last.receipt.status === 0 ? 'included' : 'failed') : t?.deferred ? 'deferred' : mine?.state ?? 'pending';
    const [mark, label, tone] = STAGES[state] ?? STAGES.pending;
    const ret = mine?.returnTo;
    return `<section class="screen plain narrow">
      <h1 class="page">Transaction</h1>
      <div class="big-amount"><span class="avatar status ${tone}">${icon(mark)}</span>
        <b class="headline">${esc(mine?.summary ?? 'A transaction')}</b><p><span class="chip ${tone}">${esc(label)}</span></p></div>
      ${!t && !last ? `<div class="note">${icon('info')}<div>The node does not know this transaction yet. If it was just sent, give it a moment.</div></div>` : ''}
      ${state === 'failed' ? `<div class="note bad">${icon('warn')}<div>${esc(reasonOf(last.receipt))}</div></div>` : ''}
      <div class="card mt">
        <div class="kv block"><span>Transaction</span><div class="mono small">${grouped(id)}</div></div>
        ${last ? `<div class="kv"><span>Block</span><span>${last.height}</span></div>` : ''}
      </div>
      <div class="stack mt">
        ${ret ? `<a class="btn secondary" href="${esc(ret)}#ting-tx=${id}" rel="noopener">Open ${esc(new URL(ret).host)}</a>` : ''}
        <a class="btn ${ret ? 'secondary' : 'primary'}" href="#/wallet">Back to wallet</a>
      </div>
    </section>`;
  },
  bind(view, id) {
    const timer = setInterval(async () => {
      if (!view.isConnected || location.hash !== `#/tx/${id}`) return clearInterval(timer);
      const t = await session.pool.transaction(id).catch(() => null);
      if (t?.occurrences?.length) {
        clearInterval(timer);
        session.refresh(true);
        dispatchEvent(new HashChangeEvent('hashchange'));
      }
    }, 2500);
  },
};

const receiveState = { slot: 0, ask: '' };

export const receive = {
  render() {
    const coin = currentCoin();
    const accounts = session.accounts();
    if (!accounts.length) return '<section class="screen plain"><h1 class="page">Receive</h1></section>';
    const account = accounts[receiveState.slot];
    const net = session.net.chainId.slice(0, 8);
    const units = coin && receiveState.ask ? parseAmount(receiveState.ask, coin.decimals) : null;
    const link = `ting:pay?to=${account}${units && coin ? `&coin=${coin.id}&amount=${receiveState.ask.trim()}` : ''}&net=${net}`;
    let qr = '';
    try { qr = qrSvg(link); } catch { /* too long */ }
    const lock = session.identity?.slots[receiveState.slot];
    return `<section class="screen plain narrow">
      <h1 class="page">Receive</h1>
      <div class="seg mt">${[0, 1].map((n) => `<button data-slot="${n}" class="${n === receiveState.slot ? 'on' : ''}">${n ? 'Savings' : 'Spending'}</button>`).join('')}</div>
      <div class="card pad mt center">
        <div class="qr">${qr}</div>
        <p class="muted small">Deposits are instant${lock ? `; withdrawals from Savings wait ${esc(duration(lock))}` : ''}.</p>
        <div class="stack"><button class="btn secondary" data-copy-link>${icon('copy')} Copy link</button></div>
      </div>
      <div class="card mt">
        <label class="field"><span>Ask for an amount${coin ? ` (${esc(coin.symbol)})` : ''}</span><input name="ask" inputmode="decimal" placeholder="Optional" value="${esc(receiveState.ask)}">
          <div class="hint">The link asks for this amount; whoever pays can change it.</div></label>
        <div class="kv block"><span>The account, to copy</span>${accountBox(account)}</div>
        <div class="kv block"><span>The link</span><div class="mono small">${esc(link)}</div></div>
      </div>
    </section>`;
  },
  bind(view) {
    $$('[data-slot]', view).forEach((b) => b.addEventListener('click', () => {
      receiveState.slot = Number(b.dataset.slot);
      dispatchEvent(new HashChangeEvent('hashchange'));
    }));
    $('[name=ask]', view)?.addEventListener('change', (e) => {
      receiveState.ask = e.target.value;
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    $('[data-copy-link]', view)?.addEventListener('click', () => copy($('.kv.block .mono', view).textContent, 'Link copied'));
  },
};

export const scan = {
  render() {
    return `<section class="screen plain narrow">
      <h1 class="page">Open a link</h1>
      <p class="lead">Paste a Ting link someone sent you: a pay link, a call link from a program’s page, or a device link.</p>
      <div class="card"><label class="field"><span>Link</span><textarea name="link" rows="4" spellcheck="false" placeholder="ting:…"></textarea></label></div>
      <button class="btn primary mt" data-open>Open</button>
    </section>`;
  },
  bind(view) {
    $('[data-open]', view).addEventListener('click', () => {
      const text = $('[name=link]', view).value.trim();
      if (!/ting:/i.test(text)) return toast('That is not a Ting link');
      useLink(text);
    });
  },
};

export { when, short };

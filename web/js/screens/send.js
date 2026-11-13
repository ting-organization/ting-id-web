// Send, Review payment, Transaction, Receive and Scan: paying and getting paid.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { qrSvg } from '../../../kit/web/qr.js';
import { idOf } from '../../../kit/web/ting.js';
import { BUDGETS } from '../chain/budgets.js';
import * as coins from '../chain/coins.js';
import { autoFee, knownFee } from '../chain/fees.js';
import { accountBox, coinMark, exactMoney, money, notices, who } from '../parts.js';
import { reasonOf, session } from '../session.js';
import * as store from '../store.js';
import { $, $$, amount, amountProblem, ask, copy, duration, esc, fractionHtml, grouped, icon, initials, linkAmount, openSheet, parseAmount, problem, short, shortAmount, toast, when } from '../ui.js';
import { currentCoin } from './wallet.js';

/**
 * The payment being written: it survives a trip to Review and back. `fee` is
 * paid at once, by an instant account; `runFee` is a withdrawal from a locked
 * account's tip, paid to the miner that runs it when it falls due, and
 * reserved with it until then (Ting wiki: programs/coin, fees and tips).
 */
const draft = { coin: null, slot: 0, to: '', amount: '', fee: null, feeAuto: true, runFee: null, runFeeAuto: true };

/** What the payment costs beside its amount: the fee now, or a withdrawal's run fee; null while not worked out. */
const extra = (account) => (account.delay ? draft.runFee : draft.fee);

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
  else if (units === null) out.push(amountProblem(draft.amount, coin.decimals));
  else if (units <= 0n) out.push('The amount must be above zero');
  else if (units + (extra(account) ?? 0n) > account.record.available) {
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
    // The screen draws at once: a fee worked out lately is shown, a new one fills in when ready.
    if (draft.feeAuto && !account.delay) draft.fee = knownFee(coin.id);
    if (account.delay) {
      draft.fee = 0n;
      if (draft.runFeeAuto) draft.runFee = knownFee(coin.id, 'run');
    }
    const toId = idOf(draft.to.replace(/\s+/g, ''));
    const toName = toId ? store.nameOf(hex(toId), session.accounts()) : null;
    return `<section class="screen plain narrow">
      <div class="head"><h1>Send</h1></div>
      ${notices()}
      <div class="card list">
        <button class="row" type="button" data-from>${coinMark(coin)}<span class="main"><b>${esc(session.saved()?.name ?? 'You')} · ${esc(account.name)}</b>
          <span>${money(account.record.available, coin)} available · ${account.delay ? `${duration(account.delay)} lock` : 'Instant'}</span></span>${icon('chevron')}</button>
      </div>
      ${account.delay ? `<div class="note warn mt">${icon('lock')}<div>Withdrawals from ${esc(account.name)} wait ${esc(duration(account.delay))}: it runs when the lock ends, and you can cancel it until then.</div></div>` : ''}
      <div class="card mt">
        <label class="field"><span>Amount</span><div class="amount-input"><input name="amount" inputmode="decimal" placeholder="0" value="${esc(draft.amount)}" autocomplete="off"><em>${esc(coin.symbol)}</em>
          <button class="btn small secondary" type="button" data-max>Max</button></div></label>
        <div class="field"><span>To</span><div class="to-line"><textarea name="to" rows="2" spellcheck="false" placeholder="Account or pay link">${esc(toId ? grouped(toId) : draft.to)}</textarea>
          <button class="icon-button" type="button" data-recipients aria-label="Choose a recipient">${icon('people')}</button>
          <a class="icon-button" href="#/scan" aria-label="Scan a code">${icon('scan')}</a></div>
          ${toName ? `<div class="hint">${esc(toName)}</div>` : ''}</div>
        <div class="kv"><span>Fee</span><span><span data-fee-text>${feeText(coin, account)}</span> <button class="link" type="button" data-fee>Change</button></span></div>
      </div>
      <div class="note warn mt" data-problems hidden></div>
      <button class="btn primary mt" data-review>Review</button>
    </section>`;
  },

  bind(view) {
    const { coin, account } = current();
    if (!coin) return;
    const showFee = () => {
      const text = $('[data-fee-text]', view);
      if (text) text.innerHTML = feeText(coin, account);
    };
    if (draft.feeAuto && !account.delay && draft.fee === null) {
      autoFee(session.pool, coin.id).catch(() => 0n).then((fee) => {
        if (!draft.feeAuto || draft.coin !== coin.id) return;
        draft.fee = fee;
        showFee();
      });
    }
    if (account.delay && draft.runFeeAuto && draft.runFee === null) {
      autoFee(session.pool, coin.id, 'run').catch(() => 0n).then((fee) => {
        if (!draft.runFeeAuto || draft.coin !== coin.id) return;
        draft.runFee = fee;
        showFee();
      });
    }
    const form = { amount: $('[name=amount]', view), to: $('[name=to]', view) };
    form.amount.addEventListener('input', () => { draft.amount = form.amount.value; });
    form.to.addEventListener('input', () => {
      const text = form.to.value.trim();
      if (/^ting:/i.test(text) || text.includes('#ting:')) return useLink(text);
      draft.to = text;
    });
    $('[data-max]', view).addEventListener('click', () => {
      const most = account.record.available - (extra(account) ?? 0n);
      draft.amount = most > 0n ? amount(most, coin.decimals).replace(/ /g, '') : '0';
      form.amount.value = draft.amount;
    });
    const redraw = () => dispatchEvent(new HashChangeEvent('hashchange'));
    const row = (c, caption) => `<button class="row" type="button" data-value="${c.value}"><span class="avatar">${c.icon ? icon(c.icon) : esc(initials(c.name))}</span>
      <span class="main"><b>${esc(c.name)}</b><span>${esc(caption)}</span></span></button>`;
    $('[data-from]', view).addEventListener('click', () => {
      const rows = session.coins.flatMap((c) => c.accounts.map((a) => row(
        { value: `${c.id}:${a.slot}`, name: `${session.saved()?.name ?? 'You'} · ${a.name}`, icon: a.delay ? 'lock' : 'wallet' },
        `${shortText(a.record.available, c)} available · ${a.delay ? `withdrawals wait ${duration(a.delay)}` : 'instant'}`))).join('');
      const { dialog, close } = openSheet(`<div class="sheet-body"><h2>Send from</h2><div class="card list">${rows}</div></div>`);
      dialog.addEventListener('click', (e) => {
        const b = e.target.closest('[data-value]');
        if (!b) return;
        const [coinId, slot] = b.dataset.value.split(':');
        draft.coin = coinId;
        draft.slot = Number(slot);
        draft.feeAuto = true;
        draft.runFeeAuto = true;
        close();
        redraw();
      });
    });
    $('[data-recipients]', view).addEventListener('click', () => {
      const own = session.accounts().map((a, n) => ({ value: a, name: `Your ${n === 0 ? 'Spending' : n === 1 ? 'Savings' : `account ${n + 1}`}`, icon: n ? 'lock' : 'wallet', n }))
        .filter((o) => o.value !== hex(account.account));
      const contacts = store.get().contacts;
      const body = `<div class="sheet-body"><h2>Recipient</h2>
        ${own.length ? `<div class="group-title">Your accounts</div><div class="card list">${own.map((o) => row(o, session.identity.slots[o.n] ? `withdrawals wait ${duration(session.identity.slots[o.n])}` : 'instant')).join('')}</div>` : ''}
        <div class="group-title">Contacts</div>
        <div class="card list">${contacts.map((c) => row({ value: c.account, name: c.name }, short(c.account))).join('')
          || '<div class="row"><span class="main"><span class="wrap">No contacts yet. Accounts you pay can be saved by name.</span></span></div>'}</div></div>`;
      const { dialog, close } = openSheet(body);
      dialog.addEventListener('click', (e) => {
        const b = e.target.closest('[data-value]');
        if (!b) return;
        draft.to = b.dataset.value;
        close();
        redraw();
      });
    });
    $('[data-fee]', view).addEventListener('click', async () => {
      // From a locked account the fee is the run fee: paid when the withdrawal runs, to the miner that runs it.
      const run = Boolean(account.delay);
      const auto = run ? draft.runFeeAuto : draft.feeAuto;
      const answer = await ask({
        title: 'Fee',
        text: run
          ? `Paid when the withdrawal runs, to the miner that runs it, and reserved with it until then. Automatic: what recent transactions paid for the room a run takes.`
          : 'Automatic: what recent transactions paid for the same room in a block.',
        fields: [{ name: 'fee', label: `Fee (${coin.symbol})`, value: auto ? '' : amount((run ? draft.runFee : draft.fee) ?? 0n, coin.decimals).replace(/\u202f/g, ''), placeholder: 'Automatic', inputmode: 'decimal' }],
        confirm: 'Done',
      });
      if (!answer) return;
      let value = null;
      if (answer.fee.trim()) {
        value = parseAmount(answer.fee, coin.decimals);
        if (value === null) return toast(amountProblem(answer.fee, coin.decimals));
      }
      if (run) {
        draft.runFeeAuto = value === null;
        draft.runFee = value;
      } else {
        draft.feeAuto = value === null;
        if (value !== null) draft.fee = value;
      }
      redraw();
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

const shortText = (units, coin) => `${shortAmount(units, coin.decimals)} ${coin.symbol}`;

/** The fee row: working out, none, or the amount and the account it comes from (a withdrawal's run fee is its fee). */
function feeText(coin, account) {
  const fee = extra(account);
  if (fee === null) return '<span class="muted">Working it out…</span>';
  return fee ? `${money(fee, coin)} · ${esc(account.name)}` : 'None';
}

function useLink(text) {
  const link = text.slice(text.indexOf('ting:'));
  location.hash = `#${link}`;
}

export const review = {
  async render() {
    const { coin, account } = current();
    if (!coin) return send.render();
    // Opened before the automatic fee was worked out: worked out now, never taken as none.
    if (account.delay && draft.runFeeAuto && draft.runFee === null) draft.runFee = await autoFee(session.pool, coin.id, 'run').catch(() => 0n);
    if (!account.delay && draft.feeAuto && draft.fee === null) draft.fee = await autoFee(session.pool, coin.id).catch(() => 0n);
    if (problems(coin, account).length) return send.render();
    const to = hex(idOf(draft.to.replace(/\s+/g, '')));
    const units = parseAmount(draft.amount, coin.decimals);
    const name = store.nameOf(to, session.accounts());
    const lock = account.delay;
    // One fee: paid now from an instant account, or, from a locked one, when the withdrawal runs.
    const fee = (lock ? draft.runFee : draft.fee) ?? 0n;
    return `<section class="screen plain narrow">
      <button class="back" data-edit>${icon('back')} Edit</button>
      <h1 class="page">Review payment</h1>
      <div class="big-amount">${coinMark(coin, true)}<b>${fractionHtml(amount(units, coin.decimals))}<small>${esc(coin.symbol)}</small></b>
        <p>${lock ? `Runs when the ${esc(duration(lock))} lock ends` : 'Goes as soon as a block includes it'}</p></div>
      <div class="card">
        <div class="kv"><span>From</span><span>${esc(session.saved()?.name ?? 'You')} · ${esc(account.name)}</span></div>
        <div class="kv block"><span>To</span><div>${name ? `<b>${esc(name)}</b> <span class="mono muted">${short(to)}</span>` : `<b>New recipient</b>${accountBox(to)}
          <button class="link" data-save>${icon('userplus')} Save as contact</button>`}</div></div>
        <div class="kv"><span>When</span><span>${lock ? `In ${esc(duration(lock))}` : 'Now'}</span></div>
        <div class="kv"><span>Fee</span><span>${fee ? exactMoney(fee, coin) : 'None'}</span></div>
        <div class="kv"><span>Total from ${esc(account.name)}</span><span>${exactMoney(units + fee, coin)}</span></div>
        <div class="kv"><span>Available after</span><span>${exactMoney(account.record.available - units - fee, coin)}</span></div>
      </div>
      ${lock ? `<div class="note warn">${icon('lock')}<div>${exactMoney(units + fee, coin)} is reserved until it runs, and you can cancel it from the wallet until then.</div></div>` : ''}
      ${name ? '' : `<div class="note">${icon('user')}<div>This account is not in your contacts. Check the address with whoever you pay: a payment cannot be taken back once it runs.</div></div>`}
      <button class="btn primary mt" data-confirm>${icon('key')} Confirm and ${lock ? 'schedule' : 'send'}</button>
      <button class="link" data-edit>Edit</button>
    </section>`;
  },

  bind(view) {
    const { coin, account } = current();
    $$('[data-edit]', view).forEach((b) => b.addEventListener('click', () => { location.hash = '#/send'; }));
    $('[data-save]', view)?.addEventListener('click', async () => {
      const answer = await ask({ title: 'Save as contact', fields: [{ name: 'name', label: 'Name', placeholder: 'Their name' }], confirm: 'Save' });
      if (answer?.name.trim()) {
        store.saveContact(answer.name, hex(idOf(draft.to.replace(/\s+/g, ''))));
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
          tip: account.delay ? draft.runFee ?? 0n : 0n,
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
export function nextNonce(coinId, account) {
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
  lost: ['x', 'Not included', 'bad'],
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
      ${!t && !last && state === 'lost' ? `<div class="note bad">${icon('warn')}<div>No block included it, and the network has dropped it: nothing was paid or changed.</div></div>` : ''}
      ${!t && !last && state === 'pending' ? `<div class="note">${icon('info')}<div>The node does not know this transaction yet. If it was just sent, give it a moment.</div></div>` : ''}
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
    // The amount as read, written as links write it: `0,55` typed is `0.55` in the link.
    const link = `ting:pay?to=${account}${units && coin ? `&coin=${coin.id}&amount=${linkAmount(units, coin.decimals)}` : ''}&net=${net}`;
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

export { when, short };

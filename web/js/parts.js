// Pieces several screens show: the coin mark, notices, an account box, the
// activity list, the scheduled actions and what is waiting for a block.
import { hex } from '../../kit/web/bytes.js';
import { session, slotName } from './session.js';
import * as store from './store.js';
import { amount, day, esc, fractionHtml, grouped, icon, initials, short, shortAmount, when } from './ui.js';

export function coinMark(coin, large = false) {
  const daler = coin?.symbol === 'DLR';
  return `<span class="coinmark ${large ? 'lg' : ''} ${daler ? '' : 'other'}" aria-hidden="true">${daler ? 'D' : esc((coin?.symbol ?? '?').slice(0, 1))}</span>`;
}

/** A balance or a listed amount, as Ting ID shortens it. */
export const money = (units, coin, signed = '') =>
  `${signed}${fractionHtml(shortAmount(BigInt(units), coin.decimals))}\u00a0${esc(coin.symbol)}`;

/** The exact amount, for what is reviewed, signed or confirmed. */
export const exactMoney = (units, coin, signed = '') =>
  `${signed}${fractionHtml(amount(BigInt(units), coin.decimals))}\u00a0${esc(coin.symbol)}`;

/** The notices every tab shows first: the node, and the identity's state. */
export function notices() {
  const out = [];
  if (session.problem) out.push(`<div class="note warn">${icon('warn')}<div>${esc(session.problem)}</div></div>`);
  const id = session.identity;
  if (id && !id.onChain) out.push(`<div class="note">${icon('clock')}<div>Waiting for the next block to create this identity.</div></div>`);
  if (id?.onChain && id.keyId == null) {
    out.push(`<div class="note warn">${icon('key')}<div>This browser can’t act for this identity yet. <a href="#/identity">Open Identity</a></div></div>`);
  }
  return out.join('');
}

export function accountBox(account) {
  const h = typeof account === 'string' ? account : hex(account);
  return `<div class="addr"><span>${grouped(h)}</span><button class="copy" data-copy="${h}" aria-label="Copy">${icon('copy')}</button></div>`;
}

/** Who an account is, in words: one of yours, a contact, or its short form. */
export function who(accountHex) {
  return store.nameOf(accountHex, session.accounts()) ?? short(accountHex);
}

function activityRow(item, coin) {
  const time = when(item.time);
  if (item.kind === 'sent' || item.kind === 'received' || item.kind === 'moved') {
    const party = item.kind === 'sent' ? item.to : item.from;
    const name = store.nameOf(party, []);
    const title = item.kind === 'moved' ? 'Moved' : name ?? (item.kind === 'sent' ? 'Sent' : 'Received');
    const caption = item.kind === 'moved'
      ? `${slotName(session.accounts().indexOf(item.from))} → ${slotName(session.accounts().indexOf(item.to))} · ${time}`
      : name ? `${item.kind === 'sent' ? 'Sent' : 'Received'} · ${time}` : `${item.kind === 'sent' ? 'to' : 'from'} ${short(party)} · ${time}`;
    const avatar = name ? `<span class="avatar">${esc(initials(name))}</span>`
      : `<span class="avatar">${icon(item.kind === 'sent' ? 'up' : item.kind === 'received' ? 'down' : 'swap')}</span>`;
    const sign = item.kind === 'sent' ? '−' : item.kind === 'received' ? '+' : '';
    return `<div class="row">${avatar}<span class="main"><b>${esc(title)}</b><span>${esc(caption)}</span></span>
      <span class="end ${item.kind === 'received' ? 'in' : ''}">${coin ? money(item.amount, coin, sign) : ''}</span></div>`;
  }
  if (item.kind === 'scheduled') {
    const to = item.to ? who(item.to) : 'an action';
    return `<div class="row"><span class="avatar">${icon('clock')}</span><span class="main"><b>Scheduled</b>
      <span>${item.amount && coin ? `Send ${money(item.amount, coin)} to ${esc(to)}` : 'An action'} · runs ${esc(when(item.executeAt))}</span></span></div>`;
  }
  if (item.kind === 'executed' || item.kind === 'cancelled') {
    return `<div class="row"><span class="avatar">${icon(item.kind === 'executed' ? 'check' : 'x')}</span><span class="main">
      <b>${item.kind === 'executed' ? 'Ran' : 'Cancelled'}</b><span>Scheduled action #${esc(item.sequence)} · ${time}</span></span></div>`;
  }
  if (item.kind.startsWith('id:')) {
    const name = item.kind.slice(3);
    const titles = {
      created: 'Identity created',
      'change-proposed': `Change #${item.changeNo} proposed`,
      'change-cancelled': `Change #${item.changeNo} cancelled`,
      'change-applied': `Change #${item.changeNo} applied`,
      'recovery-approved': 'A guardian approved a recovery',
      'recovery-withdrawn': 'A guardian withdrew a recovery approval',
      recovered: 'Identity recovered',
    };
    const detail = name === 'change-proposed' ? `${(item.ops ?? []).map((o) => o.text).join(', ')} · applies ${when(item.effectiveAt)}` : time;
    return `<div class="row"><span class="avatar">${icon(name.startsWith('recover') ? 'shield' : 'identity')}</span><span class="main">
      <b>${esc(titles[name] ?? 'Identity')}</b><span>${esc(detail)}</span></span></div>`;
  }
  return '';
}

/** The activity list, by day. */
export function activityList(limit = 30) {
  const items = session.activity.slice(0, limit);
  if (!items.length) {
    return `<div class="card pad"><b>No activity yet</b><p class="muted small">Payments, scheduled actions and identity changes show up here.</p></div>`;
  }
  let lastDay = null;
  const rows = items.map((item) => {
    const coin = session.coins.find((c) => c.id === item.contract);
    const d = day(item.time);
    const head = d !== lastDay ? `<div class="group">${esc(d)}</div>` : '';
    lastDay = d;
    return head + activityRow(item, coin);
  }).join('');
  return `<div class="card list">${rows}</div>`;
}

/** The scheduled actions of every account, with Cancel and, once due, Run. */
export function scheduledList() {
  const rows = [];
  const now = Date.now() / 1000;
  for (const coin of session.coins) {
    for (const a of coin.accounts) {
      for (const s of a.scheduled) {
        const due = Number(s.executeAt) <= now;
        const what = s.effect.kind === 'transfer' ? `${money(s.effect.amount, coin)} to ${esc(who(hex(s.effect.to)))}` : 'An action';
        rows.push(`<div class="row"><span class="avatar">${icon('clock')}</span><span class="main"><b>${what}</b>
          <span>From ${esc(a.name)} · ${due ? 'due now' : `runs ${esc(when(Number(s.executeAt)))}`}</span></span>
          <span class="end">${due ? `<button class="btn small secondary" data-run="${coin.id}:${a.slot}:${s.sequence}">Run</button>` : ''}
          <button class="btn small danger" data-cancel="${coin.id}:${a.slot}:${s.sequence}">Cancel</button></span></div>`);
      }
    }
  }
  if (!rows.length) return '';
  return `<h2 class="section">Scheduled</h2><div class="card list">${rows.join('')}</div>`;
}

const STATES = {
  pending: 'Waiting for a block',
  deferred: 'Held by the node until its time',
  included: 'In a block; done once a few more follow',
  failed: 'Not done',
};

/** What this browser sent that is not settled yet. */
export function waitingList() {
  const items = session.pending().filter((p) => !['done', 'dismissed'].includes(p.state));
  if (!items.length) return '';
  const rows = items.map((p) => `<div class="row"><span class="avatar">${p.state === 'failed' ? icon('warn') : '<span class="spinner"></span>'}</span>
    <a class="main" href="#/tx/${p.id}"><b>${esc(p.summary)}</b><span>${esc(STATES[p.state] ?? p.state)}${p.reason ? ` · ${esc(p.reason)}` : ''} · sent ${esc(when(Math.floor(p.at / 1000)))}</span></a>
    ${p.state === 'failed' ? `<button class="btn small secondary" data-dismiss="${p.id}">Dismiss</button>` : icon('chevron')}</div>`).join('');
  return `<h2 class="section">Waiting (${items.length})</h2><div class="card list">${rows}</div>`;
}

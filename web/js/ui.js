// What every screen uses: escaping, icons, amounts, addresses, toasts.
import { hex } from '../../kit/web/bytes.js';

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const PATHS = {
  wallet: '<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M16 12h2.5M3 9h15a3 3 0 0 1 3 3"/>',
  send: '<path d="M21 3 10 14M21 3l-7 18-4-7-7-4z"/>',
  identity: '<path d="M12 11v3a8 8 0 0 1-1.5 4.7M7.6 6.4A6 6 0 0 1 18 10.5V13M6 10.5a6 6 0 0 1 .4-2.2M6 14.5v-4M15 17.5a12 12 0 0 1-1 3M9 21a12 12 0 0 0 1.4-3M18 16.5c0 1.3-.2 2.6-.5 3.8M9 10.5a3 3 0 0 1 6 0V13"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 20a6.5 6.5 0 0 0-3-5.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8" y="8" width="3" height="3"/><rect x="13" y="8" width="3" height="3"/><rect x="8" y="13" width="3" height="3"/><path d="M13 13h3v3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  shield: '<path d="M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  check: '<path d="m5 12 5 5L20 7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  userplus: '<circle cx="10" cy="8" r="4"/><path d="M2 21a8 8 0 0 1 13-6.2M19 14v6M16 17h6"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
  swap: '<path d="M7 7h13M16 3l4 4-4 4M17 17H4M8 13l-4 4 4 4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  warn: '<path d="M12 3 2 21h20zM12 10v5M12 18v.5"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  call: '<path d="M4 6h16M4 12h10M4 18h7"/><path d="m16 15 3 3-3 3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};

export const icon = (name) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;

/** `1234567` → `1 234 567`: Ting ID groups with narrow spaces. */
const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** An amount in a coin's smallest units, shown in whole coins. */
export function amount(units, decimals, maxFraction = decimals) {
  const negative = units < 0n;
  const v = negative ? -units : units;
  const unit = 10n ** BigInt(decimals);
  const fraction = (v % unit).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  return (negative ? '−' : '') + group((v / unit).toString()) + (fraction ? '.' + fraction : '');
}

/**
 * A balance as Ting ID shows it: 6 significant digits, cut, not rounded, and
 * at least 2 decimals: `239 756.16`, `6 330`, `0.000123456`. For anything
 * signed or confirmed, `amount` gives the exact figure.
 */
export function shortAmount(units, decimals) {
  const negative = units < 0n;
  const v = negative ? -units : units;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const digits = (v % unit).toString().padStart(decimals, '0');
  let keep;
  if (whole > 0n) keep = Math.max(2, 6 - whole.toString().length);
  else {
    const lead = digits.search(/[1-9]/);
    keep = lead < 0 ? 2 : Math.max(2, lead + 6);
  }
  const fraction = digits.slice(0, Math.min(keep, decimals)).replace(/0+$/, '');
  return (negative ? '−' : '') + group(whole.toString()) + (fraction ? '.' + fraction : '');
}

/** An amount's text as HTML, its fraction smaller and fainter. */
export const fractionHtml = (text) => esc(text).replace(/\.(\d+)/, '<span class="frac">.$1</span>');

/** Units of a decimal amount such as `12.5`, or null. */
export function parseAmount(text, decimals) {
  const m = String(text).trim().replace(/[\s,_ ]/g, '').match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (m[1] === '' && !m[2])) return null;
  if ((m[2] ?? '').length > decimals) return null;
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}

/** `7a3f9c2e…6d2c48` */
export const short = (id) => {
  const h = typeof id === 'string' ? id : hex(id);
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
};

/** An id in groups of four, as Ting ID shows an address to check. */
export const grouped = (id) => (typeof id === 'string' ? id : hex(id)).match(/.{1,4}/g).join(' ');

export const initials = (name) =>
  String(name ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export function when(seconds) {
  const d = new Date(seconds * 1000);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export function day(seconds) {
  const d = new Date(seconds * 1000);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

/** A length of time such as `7 days` or `90 seconds`. */
export function duration(seconds) {
  const s = Number(seconds);
  const units = [[86_400, 'day'], [3_600, 'hour'], [60, 'minute'], [1, 'second']];
  for (const [size, name] of units) {
    if (s >= size && s % size === 0) {
      const n = s / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${s} seconds`;
}

let toastTimer = null;
export function toast(message, ms = 3500) {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    box.className = 'toast';
    box.setAttribute('role', 'status');
    document.body.append(box);
  }
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, ms);
}

export async function copy(text, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    toast('Could not copy: select it instead');
  }
}

/**
 * A bottom sheet (a centred dialog on wide screens), as Ting ID shows choices
 * and confirmations. Closes on its backdrop, Escape, or `close()`.
 */
export function openSheet(inner, { onClose } = {}) {
  const dialog = document.createElement('dialog');
  dialog.className = 'sheet';
  dialog.innerHTML = `<div class="grip" aria-hidden="true"></div>${inner}`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    onClose?.();
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.showModal();
  return { dialog, close: () => dialog.close() };
}

/**
 * Asks in a sheet: a confirmation (resolves true), or fields (resolves their
 * values). Resolves null when the user goes back. The back button is never
 * "Cancel"; the confirm button names the action.
 */
export function ask({ title, text = '', fields = [], confirm = 'OK', back = 'Back', danger = false }) {
  return new Promise((resolve) => {
    let result = null;
    const field = (f) => `<label class="field boxed"><span>${esc(f.label)}</span>${f.multiline
      ? `<textarea name="${f.name}" rows="3" spellcheck="false" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea>`
      : `<input name="${f.name}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" ${f.inputmode ? `inputmode="${f.inputmode}"` : ''} autocomplete="off" spellcheck="false">`}
      ${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''}</label>`;
    const { dialog, close } = openSheet(`<form class="sheet-body">
      <h2>${esc(title)}</h2>${text ? `<p class="muted">${esc(text)}</p>` : ''}
      ${fields.map(field).join('')}
      <div class="sheet-actions"><button type="button" class="btn secondary" data-back>${esc(back)}</button>
        <button class="btn ${danger ? 'destructive' : 'primary'}">${esc(confirm)}</button></div></form>`, { onClose: () => resolve(result) });
    const form = $('form', dialog);
    $('[data-back]', dialog).addEventListener('click', close);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      result = fields.length ? Object.fromEntries(new FormData(form)) : true;
      close();
    });
    $('input, textarea', dialog)?.focus();
  });
}

/** A friendly sentence for an error from a passkey, a node or the chain. */
export function problem(e) {
  if (e?.name === 'NotAllowedError') return 'The passkey request was cancelled or timed out.';
  if (e?.name === 'InvalidStateError') return 'This device already has that passkey.';
  if (e?.name === 'SecurityError') return 'Passkeys need https, or localhost while developing.';
  return e?.message ?? String(e);
}

// Ting ID Web: screens, tabs and the address bar. A screen is an object with
// `render(…args)`, which returns its HTML, and `bind(view, …args)`; `#/send`,
// `#/identity`, … pick it. A Ting link opened as `#ting:call?…` (or pay,
// device) goes straight to its screen.
import * as store from './store.js';
import { $, copy, esc, icon, problem } from './ui.js';
import { screens } from './screens.js';
import { session } from './session.js';
import { applyTheme } from './screens/settings.js';

const TABS = [
  ['wallet', 'Wallet', 'wallet'],
  ['send', 'Send', 'send'],
  ['identity', 'Identity', 'identity'],
  ['people', 'People', 'people'],
  ['settings', 'Settings', 'settings'],
];
/** Screens that follow the chain: drawn again when a new block changes what they show. */
const LIVE = new Set(['wallet', 'identity', 'settings']);

function drawNav(current) {
  const nav = $('#nav');
  nav.classList.toggle('locked', !store.get().identity);
  nav.innerHTML = '<div class="brand">Ting ID</div>' + TABS.map(([path, label, name]) => {
    const on = current === path || (path === 'wallet' && ['welcome', 'create', 'restore', 'tx', 'receive', 'scan'].includes(current))
      || (path === 'send' && current === 'review') || (path === 'people' && current === 'person')
      || (path === 'identity' && ['add-guardian', 'add-device'].includes(current));
    return `<a href="#/${path}" class="${on ? 'on' : ''}" ${on ? 'aria-current="page"' : ''}><span class="pillbox">${icon(name)}</span>${esc(label)}</a>`;
  }).join('');
}

/** `#/name/arg…` → the screen and its arguments; a Ting link → the link screen. */
function parse() {
  const raw = location.hash.slice(1);
  if (/^ting:/i.test(decodeURIComponent(raw))) return { name: 'link', args: [raw] };
  const [name = '', ...args] = raw.replace(/^\/+/, '').split('/');
  return { name: name || 'wallet', args };
}

let current = null;
let currentName = null;

export async function show() {
  let { name, args } = parse();
  const hasIdentity = Boolean(store.get().identity && session.saved());
  if (!hasIdentity && !['welcome', 'create', 'restore', 'settings', 'link', 'people', 'person'].includes(name)) name = 'welcome';
  if (hasIdentity && ['welcome', 'create', 'restore'].includes(name)) name = 'wallet';
  const screen = screens[name] ?? screens.wallet;
  const token = (current = {});
  currentName = name;
  drawNav(name);
  const view = $('#view');
  // A screen that reads the chain before it draws shows a bar at the top meanwhile.
  const slow = setTimeout(() => document.body.classList.add('busy'), 120);
  const done = () => {
    clearTimeout(slow);
    if (current === token) document.body.classList.remove('busy');
  };
  try {
    const html = await screen.render(...args);
    done();
    if (current !== token) return;
    view.innerHTML = html;
    await screen.bind?.(view, ...args);
  } catch (e) {
    done();
    if (current !== token) return;
    view.innerHTML = `<section class="screen plain narrow"><h1 class="page">Something went wrong</h1>
      <div class="stack mt"><div class="note bad">${icon('warn')}<div>${esc(problem(e))}</div></div>
      <button class="btn secondary" data-retry>Try again</button></div></section>`;
    $('[data-retry]', view)?.addEventListener('click', show);
  }
}

window.addEventListener('hashchange', () => {
  show();
  window.scrollTo(0, 0);
});

// Copy buttons anywhere: `data-copy="…"`.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (b) copy(b.dataset.copy);
});

// A new block that changes what a live screen shows draws it again; a screen
// being written in (Send) is left alone.
session.onChange(() => {
  if (LIVE.has(currentName) && !document.querySelector('#view :focus')) show();
});

// index.html shows the navy band with "Reading the chain…" until the first screen is drawn.
applyTheme();
session.open().catch(() => {}).finally(show);

// Installed, the wallet opens without a network too, and reads the chain once one is back: see sw.js.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

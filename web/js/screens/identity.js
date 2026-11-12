// Identity: who you are on chain, the devices (keys) that act for you, your
// guardians, and changes, which wait the change delay so that a stolen key
// cannot take over at once; the guardian code others scan to link this
// identity as their guardian. And the two ways in: create, or use an existing
// identity.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { qrSvg } from '../../../kit/web/qr.js';
import { idOf } from '../../../kit/web/ting.js';
import { BUDGETS } from '../chain/budgets.js';
import * as registry from '../chain/registry.js';
import { guardianCode, guardianLink, heldLink, hold, readLink } from '../links.js';
import * as p256 from '../p256.js';
import * as passkey from '../passkey.js';
import * as phrase from '../phrase.js';
import { accountBox, fingerprint, isPhraseKey, keyKind, netTag, notices } from '../parts.js';
import { session, slotName } from '../session.js';
import * as store from '../store.js';
import { $, $$, ask, copy, duration, esc, icon, initials, openSheet, problem, short, toast, when } from '../ui.js';
import { bindRecoveringCard, phraseSection, recoveringCard, recoveryWarnings } from './recovery.js';

/** `ting:device?id=…&scheme=webauthn&key=…&net=…`: asks another device to add this browser’s passkey. */
const deviceLink = (id, key) => `ting:device?id=${hex(id)}&scheme=webauthn&key=${hex(key)}&net=${netTag()}`;

/** What this browser calls the guardian `g` (hex): its contact's name, else its short ID. */
const guardianName = (g) => store.contactOfIdentity(g)?.name ?? `Identity ${short(g)}`;

const propose = (ops, summary) => session.propose(ops, summary);

export const identity = {
  render() {
    const saved = session.saved();
    const id = session.identity;
    if (!saved || !id) return '<section class="screen plain"><h1 class="page">Identity</h1></section>';
    const mine = id.keyId;
    const devices = id.keys.map((k) => {
      const kind = keyKind(k);
      const here = k.keyId === mine;
      return `<div class="row"><span class="avatar">${icon(here ? 'check' : 'key')}</span><span class="main">
        <b>${here ? 'This device' : `${kind} #${k.keyId}`}</b><span>${esc(kind)} · ${fingerprint(k.params)}</span></span>
        ${id.keys.length > 1 && !here && mine != null ? `<button class="btn small danger" data-remove="${k.keyId}">Remove</button>` : ''}</div>`;
    }).join('');
    const pending = id.pending.map((c) => {
      const due = Number(c.effectiveAt) <= Date.now() / 1000;
      const text = c.ops.map((op) => opWords(op)).join(', ');
      return `<div class="row"><span class="avatar">${icon('clock')}</span><span class="main"><b>${esc(text)}</b>
        <span>#${c.changeNo} · ${due ? 'ready to apply' : `applies ${esc(when(Number(c.effectiveAt)))}`}</span></span>
        <span class="end">${due ? `<button class="btn small secondary" data-apply="${c.changeNo}">Apply</button>` : ''}
        ${mine != null ? `<button class="btn small danger" data-cancel="${c.changeNo}">Cancel</button>` : ''}</span></div>`;
    }).join('');
    const guardians = (saved.guardians ?? []).map((g) => {
      const linked = id.guardians.some((x) => hex(x) === g);
      const linking = !linked && id.pending.find((c) => c.ops.some((op) => op.kind === 'addGuardian' && hex(op.guardian) === g));
      const state = linked ? 'Linked' : linking ? `Linked once change #${linking.changeNo} applies` : 'Not linked';
      return `<div class="row"><span class="avatar">${icon('shield')}</span><span class="main"><b>${esc(guardianName(g))}</b>
        <span>${esc(state)}</span></span>
        ${linked && mine != null ? `<button class="btn small danger" data-unlink="${g}">Unlink</button>` : ''}</div>`;
    }).join('');
    const core = id.core;
    return `<section>
      <div class="hero">
        <div class="top"><span class="title muted-on-navy">Identity</span></div>
        <div class="who"><span class="avatar lg xl">${esc(initials(saved.name))}</span><div><h1>${esc(saved.name)}</h1>
          <span class="chip ${id.onChain ? 'good' : 'warn'}">${icon(id.onChain ? 'shield' : 'clock')} ${id.onChain ? 'On chain' : 'Waiting for the next block'}</span></div></div>
        <div class="idrow"><button class="chip idchip" data-copy="${hex(id.id)}">ID ${short(id.id)} ${icon('copy')}</button>
          ${id.onChain ? `<button class="chip idchip" data-guardian-code>${icon('qr')} QR code</button>` : ''}</div>
        <div class="split"><div><span>Devices</span><b>${id.keys.length}</b><span>${mine != null ? 'including this one' : 'not this browser yet'}</span></div>
          <div><span>Guardians</span><b>${core ? Number(core.guardianCount) : 0}</b><span>${core && core.guardianCount ? `${Number(core.threshold) || Math.floor(Number(core.guardianCount) / 2) + 1} needed to recover` : 'add someone you trust'}</span></div></div>
      </div>
      <div class="screen narrow">
        <div class="stack mt">${notices()}</div>
        ${mine != null ? recoveryWarnings() : ''}
        ${id.onChain && mine == null ? notThisBrowser(saved) : ''}
        <h2 class="section">Devices</h2>
        <div class="card list">${devices || '<div class="row"><span class="main"><span>None yet</span></span></div>'}</div>
        ${pending ? `<h2 class="section">Pending changes</h2><div class="card list">${pending}</div>
          <p class="muted small">A change waits ${esc(duration(core.changeDelay))}; until then any of your devices can cancel it.</p>` : ''}
        <h2 class="section">Guardians</h2>
        <div class="card list">${guardians || '<div class="row"><span class="main"><b>No guardians linked from here</b><span class="wrap">Guardians are people you trust. Enough of them together can give your identity new keys if you lose every device.</span></span></div>'}</div>
        ${mine != null ? `<a class="link" href="#/add-guardian" data-link-guardian>${icon('shield')} Link a guardian</a>` : ''}
        ${mine != null ? phraseSection(id) : ''}
        <h2 class="section">Accounts</h2>
        <div class="card list">${id.slots.map((d, n) => `<div class="row"><span class="avatar">${icon(d ? 'lock' : 'wallet')}</span><span class="main"><b>${esc(slotName(n))}</b>
          <span>${d ? `withdrawals wait ${esc(duration(d))}` : 'instant'}</span></span></div>`).join('')}</div>
        ${core ? `<h2 class="section">Time locks</h2><div class="card">
          <div class="kv"><span>Changes wait</span><span>${esc(duration(core.changeDelay))}</span></div>
          <div class="kv"><span>A recovery waits</span><span>${esc(duration(core.recoveryDelay))}</span></div></div>` : ''}
      </div>
    </section>`;
  },

  bind(view) {
    const id = session.identity;
    const act = (fn) => async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try {
        const sent = await fn(b);
        if (sent) location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        b.disabled = false;
      }
    };
    $$('[data-remove]', view).forEach((b) => b.addEventListener('click', act(async () =>
      (await ask({ title: `Remove device #${b.dataset.remove}?`, text: `It takes effect after ${duration(id.core.changeDelay)}; until then any of your devices can cancel it.`, confirm: 'Remove device', danger: true }))
        && propose([{ kind: 'removeKey', keyId: BigInt(b.dataset.remove) }], `Remove device #${b.dataset.remove}`))));
    $$('[data-cancel]', view).forEach((b) => b.addEventListener('click', act(async () => {
      const signer = session.signer();
      const input = await registry.cancelInput({ chain: session.chain, registry: session.registry, id: id.id, signer, numbers: [BigInt(b.dataset.cancel)] });
      return session.call(session.registry, input, BUDGETS.execute, `Cancel change #${b.dataset.cancel}`);
    })));
    $$('[data-apply]', view).forEach((b) => b.addEventListener('click', act(() =>
      session.call(session.registry, registry.applyInput(id.id, BigInt(b.dataset.apply)), BUDGETS.execute, `Apply change #${b.dataset.apply}`))));
    $$('[data-unlink]', view).forEach((b) => b.addEventListener('click', act(async () =>
      (await ask({ title: `Unlink ${guardianName(b.dataset.unlink)}?`, text: `They will no longer help recover your identity. It takes effect after ${duration(id.core.changeDelay)}; until then any of your devices can cancel it.`, confirm: 'Unlink', danger: true }))
        && propose([{ kind: 'removeGuardian', guardian: unhex(b.dataset.unlink) }], `Unlink guardian ${guardianName(b.dataset.unlink)}`))));
    // A guardian code held from an earlier scan is not the one to link now.
    $('[data-link-guardian]', view)?.addEventListener('click', () => hold(null));
    $('[data-guardian-code]', view)?.addEventListener('click', () => showGuardianCode());
    $('[data-new-passkey]', view)?.addEventListener('click', act(async () => {
      const saved = session.saved();
      const made = await passkey.create({ name: `${saved.name} · Ting`, handle: crypto.getRandomValues(new Uint8Array(32)) });
      session.keep({ ...saved, publicKey: hex(made.publicKey), credentialId: hex(made.credentialId) });
      dispatchEvent(new HashChangeEvent('hashchange'));
      return null;
    }));
    $('[data-copy-device]', view)?.addEventListener('click', () => copy($('[data-device-link]', view).textContent, 'Link copied'));
    bindRecoveringCard(view);
  },
};

/**
 * For a browser that can't act yet: its guardians' recover code while they
 * recover the identity to it; when a change adding its passkey waits, when it
 * applies; else how to make a passkey here and have another device add it.
 */
function notThisBrowser(saved) {
  if (saved.recovering && saved.publicKey) return recoveringCard(saved);
  const adding = saved.publicKey && session.identity.pending.find((c) => c.ops.some((op) => op.kind === 'addKey' && hex(op.params) === saved.publicKey));
  if (adding) {
    return `<div class="card pad mt stack"><b>This browser’s passkey is being added</b>
      <p class="muted">Change #${adding.changeNo} adds it, and applies ${esc(when(Number(adding.effectiveAt)))}: the node holds it until then. Until it does, this browser shows ${esc(saved.name)} without acting for it.</p>
      <p class="muted small">Any key of the identity can cancel the change meanwhile. If one does, and it was not you, a lost key may be in someone else’s hands: ask your guardians to recover you.</p></div>`;
  }
  if (!saved.publicKey) {
    return `<div class="card pad mt stack"><b>This browser can’t act for ${esc(saved.name)} yet</b>
      <p class="muted">Make a passkey here, then add it from a device that can already act for this identity.</p>
      <button class="btn primary" data-new-passkey>${icon('key')} Make a passkey on this device</button></div>`;
  }
  const link = deviceLink(unhex(saved.id), unhex(saved.publicKey));
  let qr = '';
  try { qr = qrSvg(link); } catch { /* too long */ }
  return `<div class="card pad mt stack"><b>This browser can’t act for ${esc(saved.name)} yet</b>
    <p class="muted">On a device that can, scan this with Ting ID or Ting ID Web (Scan, on the wallet), or paste the link there. This device’s key is <b class="mono">${fingerprint(unhex(saved.publicKey))}</b>: the other device shows the same before it adds it.</p>
    <div class="qr">${qr}</div>
    <div class="mono small" data-device-link>${esc(link)}</div>
    <button class="btn secondary" data-copy-device>${icon('copy')} Copy link</button></div>`;
}

function opWords(op) {
  if (op.kind === 'addKey' && isPhraseKey(op)) return `Add a recovery phrase (${fingerprint(op.params)})`;
  if (op.kind === 'addKey') return `Add a ${keyKind(op).toLowerCase()} (${fingerprint(op.params)})`;
  if (op.kind === 'removeKey') return `Remove device #${op.keyId}`;
  if (op.kind === 'addGuardian') return `Link guardian ${guardianName(hex(op.guardian))}`;
  if (op.kind === 'removeGuardian') return `Unlink guardian ${guardianName(hex(op.guardian))}`;
  if (op.kind === 'threshold') return 'Change how many guardians recover';
  if (op.kind === 'delays') return 'Change the delays';
  if (op.kind === 'slotDelay') return `Change ${slotName(op.slot)}’s lock`;
  return 'A change';
}

/** The user's guardian code: scanned in Ting ID or here, it links this identity as the scanner's guardian. */
function showGuardianCode() {
  const saved = session.saved();
  const link = guardianLink(netTag(), saved.id, saved.name);
  let qr = '';
  try { qr = qrSvg(link); } catch { /* too long: the link can still be copied */ }
  const { dialog, close } = openSheet(`<div class="sheet-body">
    <h2>Be a guardian</h2>
    <p class="muted">Someone who wants you as a guardian scans this with Ting ID or Ting ID Web: Scan on the wallet, or Link a guardian on their Identity.</p>
    <div class="qr">${qr}</div>
    <p class="muted small center mt">If they ever lose their devices, your approval helps them get their identity back. It moves none of your coins.</p>
    <div class="note">${icon('info')}<div>To approve, scan the recover code they show you on the Scan screen.</div></div>
    <div class="sheet-actions"><button class="btn secondary" data-copy-code>${icon('copy')} Copy link</button>
      <button class="btn primary" data-done>Done</button></div></div>`);
  $('[data-copy-code]', dialog).addEventListener('click', () => copy(link, 'Link copied'));
  $('[data-done]', dialog).addEventListener('click', close);
}

/** The screen of a change from a scanned or pasted link, or why it cannot be made. */
const changeScreen = (title, body) => `<section class="screen plain narrow">
  <a class="back" href="#/identity">${icon('back')} Identity</a>
  <h1 class="page">${esc(title)}</h1>${body}</section>`;

const refused = (title, message) => changeScreen(title, `<div class="note bad mt">${icon('warn')}<div>${esc(message)}</div></div>
  <a class="btn secondary mt" href="#/scan">${icon('scan')} Scan a code</a>`);

/**
 * The kinds of key a device link may add, by its `scheme` (Ting ID's
 * LINKS.md): the policy that checks the key on this network, the key in
 * words, and whether a key is a point of its curve.
 */
const DEVICE_SCHEMES = () => ({
  webauthn: { policy: session.net.policyWebauthn, kind: 'Passkey', valid: p256.onCurve },
  secp256k1: { policy: session.net.policySecp256k1, kind: 'Phone key', valid: phrase.isPublicKey },
  p256: { policy: session.net.policyP256, kind: 'P-256 key', valid: p256.onCurve },
});

/** What the held device link asks: `{ scheme, key }`, or the problems that refuse it. */
function deviceAsked(link) {
  const id = session.identity;
  const problems = [];
  let fields = {};
  try {
    fields = readLink(link).fields;
  } catch (e) {
    return { problems: [problem(e)] };
  }
  if (!id?.onChain || id.keyId == null) problems.push('This browser can’t act for an identity yet');
  else if ((fields.id ?? '').toLowerCase() !== hex(id.id)) problems.push('The link is for another identity');
  if ((fields.net ?? '').toLowerCase() !== netTag()) problems.push('The link is for another network');
  const scheme = DEVICE_SCHEMES()[(fields.scheme ?? '').toLowerCase()];
  const keyHex = (fields.key ?? '').toLowerCase();
  const key = /^04[0-9a-f]{128}$/.test(keyHex) ? unhex(keyHex) : null;
  if (!scheme) problems.push('The link names a kind of key Ting ID Web does not know');
  else if (!scheme.policy) problems.push(`${scheme.kind}s do not work on this network`);
  else if (!key || !scheme.valid(key)) problems.push('The link’s key is not a public key');
  else if (id?.keys.some((k) => hex(k.params) === keyHex)) problems.push('That device can already act for this identity');
  return { problems, scheme, key };
}

/**
 * Adding a device from its `ting:device` link, scanned or pasted on the Scan
 * screen: a passkey of Ting ID Web in another browser, or a phone's key of
 * Ting ID. A change that waits the change delay.
 */
export const device = {
  render() {
    const link = heldLink('device');
    if (!link) return refused('Add a device', 'Scan the new device’s code on the Scan screen, or paste its link there.');
    const { problems, scheme, key } = deviceAsked(link);
    if (problems.length) return refused('Add a device', `${problems.join('. ')}.`);
    const id = session.identity;
    return changeScreen('Add a device', `<div class="card mt"><div class="kv"><span>Kind</span><span>${esc(scheme.kind)}</span></div>
        <div class="kv"><span>Key</span><span class="mono">${fingerprint(key)}</span></div></div>
      <div class="note warn">${icon('warn')}<div>Check that the new device shows the same key. Only add a device you hold yourself.</div></div>
      <div class="note">${icon('clock')}<div>Takes effect in ${esc(duration(id.core.changeDelay))}; until then any of your devices can cancel it.</div></div>
      <button class="btn primary mt" data-propose>${icon('key')} Propose</button>`);
  },
  bind(view) {
    const link = heldLink('device');
    const button = $('[data-propose]', view);
    if (!link || !button) return;
    const { scheme, key } = deviceAsked(link);
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const sent = await propose([{ kind: 'addKey', policy: unhex(scheme.policy), params: key }], `Add a device (${scheme.kind.toLowerCase()})`);
        hold(null);
        location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        button.disabled = false;
      }
    });
  },
};

/**
 * Linking a guardian, as Ting ID does: from the code on their Identity
 * (scanned here or on the wallet, or pasted), or their identity ID. The
 * guardian must be an identity on this network, not this one, and not linked
 * already. A name the code gives is only what its maker calls themselves; it
 * becomes a contact, with their Spending account, unless one names them.
 */
export const addGuardian = {
  render() {
    const id = session.identity;
    if (!id?.onChain || id.keyId == null) return refused('Link a guardian', 'This browser can’t act for this identity yet.');
    const held = heldLink('guardian');
    return changeScreen('Link a guardian', `<p class="lead">A guardian is someone you know and trust. Enough of them together can give your identity new keys if you lose every device.</p>
      <div class="card pad stack">
        <a class="btn secondary" href="#/scan">${icon('scan')} Scan their code</a>
        <label class="field boxed"><span>Or paste their code or identity ID</span>
          <textarea name="code" rows="3" spellcheck="false" autocomplete="off" placeholder="ting:guardian?… or 64 hex digits">${esc(held ?? '')}</textarea>
          <span class="hint">Their code is under QR code on their Identity, in Ting ID or Ting ID Web.</span></label>
      </div>
      <div class="stack mt" data-found></div>
      <div class="note">${icon('clock')}<div>Takes effect in ${esc(duration(id.core.changeDelay))}; until then any of your devices can cancel it.</div></div>
      <button class="btn primary mt" data-propose disabled>${icon('shield')} Propose</button>`);
  },

  bind(view) {
    const field = $('[name=code]', view);
    const found = $('[data-found]', view);
    const button = $('[data-propose]', view);
    if (!field) return;
    const me = session.identity;
    // The guardian the field names, once checked on chain: `{ id, name }`.
    let chosen = null;
    let asked = 0;
    const show = (html) => { found.innerHTML = html; };

    async function check() {
      const turn = ++asked;
      chosen = null;
      button.disabled = true;
      const text = field.value.trim();
      if (!text) return show('');
      let code;
      try {
        code = guardianCode(text, netTag());
        if (code.id === hex(me.id)) throw new Error('This is your own identity: a guardian must be someone else');
        if (me.pending.some((c) => c.ops.some((op) => op.kind === 'addGuardian' && hex(op.guardian) === code.id))) {
          throw new Error('A change linking them is already waiting');
        }
      } catch (e) {
        return show(`<div class="note bad">${icon('warn')}<div>${esc(problem(e))}</div></div>`);
      }
      show(`<div class="note">${icon('clock')}<div>Looking them up…</div></div>`);
      let exists;
      let linked;
      try {
        [exists, linked] = await session.pool.storage([
          [session.registry, registry.coreKey(unhex(code.id))],
          [session.registry, registry.guardianKey(me.id, unhex(code.id))],
        ]);
      } catch (e) {
        if (turn === asked) show(`<div class="note bad">${icon('warn')}<div>${esc(problem(e))}</div></div>`);
        return;
      }
      if (turn !== asked) return;
      if (!exists) return show(`<div class="note bad">${icon('warn')}<div>No identity has that ID on this network: a guardian must be an identity, not an account.</div></div>`);
      if (linked) return show(`<div class="note bad">${icon('warn')}<div>${esc(guardianName(code.id))} is your guardian already.</div></div>`);
      chosen = code;
      const contact = store.contactOfIdentity(code.id);
      show(`<div class="card list"><div class="row"><span class="avatar">${icon('shield')}</span><span class="main">
          <b>${esc(contact?.name ?? code.name ?? 'An identity')}</b><span class="mono">Identity ${short(code.id)}</span></span>
          <span class="chip good">${icon('check')} On chain</span></div></div>
        ${contact ? '' : `<label class="field boxed"><span>Their name</span>
          <input name="name" maxlength="60" autocomplete="off" placeholder="Bob" value="${esc(code.name ?? '')}">
          <span class="hint">${code.name ? 'As their code calls them, which Ting ID cannot check. ' : 'Optional: '}Saved as a contact, with their Spending account.</span></label>`}`);
      button.disabled = false;
    }

    let timer = null;
    field.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(check, 250);
    });
    if (field.value.trim()) check();

    button.addEventListener('click', async () => {
      if (!chosen) return;
      const g = chosen;
      const name = $('[name=name]', view)?.value.trim() ?? '';
      const spending = hex(registry.slotAccount(session.registry, unhex(g.id), 0));
      if (name && store.get().contacts.some((c) => c.account !== spending && c.name.toLowerCase() === name.toLowerCase())) {
        return toast(`You have a contact called ${name} already`);
      }
      button.disabled = true;
      try {
        const sent = await propose([{ kind: 'addGuardian', guardian: unhex(g.id) }], `Link guardian ${name || guardianName(g.id)}`);
        // A guardian linked from here stays known here, by name and to unlink.
        if (name) store.saveContact(name, spending, g.id);
        const saved = session.saved();
        session.keep({ ...saved, guardians: [...new Set([...(saved.guardians ?? []), g.id])] });
        hold(null);
        location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        button.disabled = false;
      }
    });
  },
};

/**
 * The time locks of a new identity, as Ting ID sets them: Savings and changes
 * wait 7 days, a recovery 2. The development chain uses minutes, to test them.
 */
const locks = () => (session.net.key === 'development'
  ? { savings: 120, change: 600, recovery: 300 }
  : { savings: registry.DEFAULTS.savingsDelay, change: registry.DEFAULTS.changeDelay, recovery: registry.DEFAULTS.recoveryDelay });

export const create = {
  render() {
    const net = session.net;
    const lock = locks();
    const ready = session.policyReady;
    return `<section class="screen plain narrow">
      <button class="back" data-back>${icon('back')} Back</button>
      <h1 class="page">Create an identity</h1>
      <p class="lead">An instant Spending account, a Savings account whose withdrawals wait, and your passkey to sign. On ${esc(net.name)}.</p>
      ${ready ? '' : `<div class="note warn">${icon('warn')}<div>Ting ID Web is not on ${esc(net.name)} yet: its passkey program has not been deployed there. Choose another network in Settings.</div></div>`}
      <div class="card">
        <label class="field"><span>Name</span><input name="name" placeholder="Your name" maxlength="40" autocomplete="name"></label>
      </div>
      <p class="muted small">Withdrawals from Savings wait ${esc(duration(lock.savings))}, changes to the identity ${esc(duration(lock.change))}, and a recovery by guardians ${esc(duration(lock.recovery))}. You can add guardians later.</p>
      <button class="btn primary mt" data-create ${ready ? '' : 'disabled'}>${icon('key')} Create with a passkey</button>
      <p class="center muted small">Your device asks for Face ID, Touch ID or its PIN to make the passkey. The identity is on chain once the next block includes it.</p>
    </section>`;
  },
  bind(view) {
    $('[data-back]', view).addEventListener('click', () => { location.hash = '#/welcome'; });
    $('[data-create]', view).addEventListener('click', async (e) => {
      const button = e.currentTarget;
      const name = $('[name=name]', view).value.trim() || 'Me';
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Making your passkey';
      try {
        const lock = locks();
        const handle = crypto.getRandomValues(new Uint8Array(32));
        const made = await passkey.create({ name: `${name} · Ting`, handle });
        const creation = registry.creation({
          keys: [{ policy: unhex(session.net.policyWebauthn), params: made.publicKey }],
          slots: [0, lock.savings],
          changeDelay: lock.change,
          recoveryDelay: lock.recovery,
        });
        const id = registry.idOf(creation);
        session.keep({
          id: hex(id), name, publicKey: hex(made.publicKey), credentialId: hex(made.credentialId),
          createdHeight: session.status?.height ?? 1, creation: hex(creation), guardians: [], coins: [],
        });
        await session.call(session.registry, registry.createInput(creation), BUDGETS.execute, `Create ${name}’s identity`);
        await session.refresh(true);
        location.hash = '#/wallet';
      } catch (err) {
        session.forget();
        toast(problem(err));
        button.disabled = false;
        button.innerHTML = `${icon('key')} Create with a passkey`;
      }
    });
  },
};

export const restore = {
  render() {
    return `<section class="screen plain narrow">
      <button class="back" data-back>${icon('back')} Back</button>
      <h1 class="page">Use an existing identity</h1>
      <div class="card list mt">
        <button class="row" data-with-passkey><span class="avatar">${icon('key')}</span><span class="main"><b>With a passkey</b>
          <span class="wrap">One you made for Ting ID Web, synced here or on a security key. Works at once.</span></span>${icon('chevron')}</button>
        <a class="row" href="#/restore-phrase"><span class="avatar">${icon('lock')}</span><span class="main"><b>With your recovery phrase</b>
          <span class="wrap">The 12 words you wrote down. A passkey here can act once the change adding it applies, after 7 days.</span></span>${icon('chevron')}</a>
        <button class="row" data-with-id><span class="avatar">${icon('identity')}</span><span class="main"><b>From another device</b>
          <span class="wrap">Your phone with Ting ID, or another browser with Ting ID Web, adds this one. It can act after 7 days.</span></span>${icon('chevron')}</button>
        <a class="row" href="#/restore-guardians"><span class="avatar">${icon('shield')}</span><span class="main"><b>With your guardians</b>
          <span class="wrap">Lost everything? Enough of your guardians give this device a passkey. It can act 2 days after they approve.</span></span>${icon('chevron')}</a>
      </div>
      <p class="muted small">7 and 2 days are the usual delays: an identity can set its own.</p>
      <div class="stack mt" data-out></div>
    </section>`;
  },
  bind(view) {
    const out = $('[data-out]', view);
    $('[data-back]', view).addEventListener('click', () => { location.hash = '#/welcome'; });
    $('[data-with-passkey]', view).addEventListener('click', async () => {
      if (!session.policyReady) return toast('Ting ID Web is not on this network yet');
      out.innerHTML = `<div class="note">${icon('key')}<div>Choose your passkey…</div></div>`;
      try {
        const signed = await passkey.sign(crypto.getRandomValues(new Uint8Array(32)));
        const candidates = signed.keys();
        const policy = unhex(session.net.policyWebauthn);
        out.innerHTML = `<div class="note">${icon('clock')}<div data-progress>Looking for the identity…</div></div>`;
        const found = await registry.findByKey(session.pool, session.registry, candidates.map((params) => ({ policy, params })),
          (at, of) => { const p = $('[data-progress]', out); if (p) p.textContent = `Looking for the identity · block ${at} of ${of}`; });
        if (!found.length) {
          out.innerHTML = `<div class="note warn">${icon('warn')}<div>No identity on this network lists this passkey. If its identity is still waiting for a block, try again in a moment.</div></div>`;
          return;
        }
        const pick = found[0];
        const read = await registry.readIdentity(session.pool, session.registry, pick.id);
        const key = read.keys.find((k) => hex(k.policy) === session.net.policyWebauthn && candidates.some((c) => hex(c) === hex(k.params)));
        const named = await ask({ title: 'Found your identity', text: `Identity ${short(pick.id)}. What should this device call it?`, fields: [{ name: 'name', label: 'Name', value: 'Me' }], confirm: 'Open it' });
        const name = named?.name.trim() || 'Me';
        session.keep({ id: hex(pick.id), name, publicKey: hex(key.params), credentialId: hex(signed.credentialId), createdHeight: pick.height, guardians: [], coins: [] });
        await session.refresh(true);
        location.hash = '#/wallet';
      } catch (err) {
        out.innerHTML = `<div class="note bad">${icon('warn')}<div>${esc(problem(err))}</div></div>`;
      }
    });
    $('[data-with-id]', view).addEventListener('click', async () => {
      const answer = await ask({
        title: 'From another device',
        text: 'Its ID is on the Identity tab of your other device. This browser then makes a passkey and shows a code for that device to scan.',
        fields: [{ name: 'id', label: 'Identity ID', placeholder: '64 hex digits', multiline: true }, { name: 'name', label: 'Name on this device', value: 'Me' }],
        confirm: 'Continue',
      });
      if (!answer) return;
      const id = idOf(answer.id.replace(/\s+/g, ''));
      if (!id) return toast('An identity ID is 64 hex digits');
      const core = await session.pool.record(session.registry, registry.coreKey(id)).catch(() => null);
      if (!core) return toast('No identity with that ID on this network');
      const name = answer.name.trim() || 'Me';
      session.keep({ id: hex(id), name, publicKey: null, credentialId: null, createdHeight: 1, guardians: [], coins: [] });
      await session.refresh(true);
      location.hash = '#/identity';
    });
  },
};

export { accountBox };

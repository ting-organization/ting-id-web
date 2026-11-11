// Identity: who you are on chain, the devices (keys) that act for you, your
// guardians, and changes, which wait the change delay so that a stolen key
// cannot take over at once. And the two ways in: create, or use an existing
// identity.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { qrSvg } from '../../../kit/web/qr.js';
import { idOf } from '../../../kit/web/ting.js';
import { sha256 } from '../../../kit/web/sha256.js';
import { BUDGETS } from '../chain/budgets.js';
import * as registry from '../chain/registry.js';
import * as passkey from '../passkey.js';
import { accountBox, notices } from '../parts.js';
import { session, slotName } from '../session.js';
import * as store from '../store.js';
import { $, $$, copy, duration, esc, grouped, icon, initials, problem, short, toast, when } from '../ui.js';

const KNOWN_POLICIES = () => ({
  [session.net.policyWebauthn ?? '']: 'Passkey',
  '9558a75642eb797de5ec1be056f01c62d99c492c8f7ec6efed460767588987c9': 'Phone key',
  '19efef33a81067da9465c698f884dbe9049088d5fdb60770e1af3edf2294782a': 'Phone key',
  '35d2b107de4b2a738a8190be18ccfd35d9bac45da094cfa4281a3a4b178852b3': 'P-256 key',
  '34ddc75c0463fd2d1542127fbf0fe92ba41bd4fbfba4e473d3aa941e74ab3b5e': 'P-256 key',
});

/** A device's fingerprint, as Ting ID shows it: the first 8 bytes of SHA-256 of its key. */
const fingerprint = (key) => grouped(hex(sha256(key).subarray(0, 8)));

/** `ting:device?id=…&scheme=webauthn&key=…&net=…`: asks another device to add this browser’s passkey. */
const deviceLink = (id, key) => `ting:device?id=${hex(id)}&scheme=webauthn&key=${hex(key)}&net=${session.net.chainId.slice(0, 8)}`;

async function propose(ops, summary) {
  const signer = session.signer();
  if (!signer) throw new Error('This browser can’t act for this identity yet');
  const id = session.identity;
  const input = await registry.proposeInput({
    chain: session.chain, registry: session.registry, id: id.id, opNonce: id.core.opNonce, signer, ops,
  });
  return session.call(session.registry, input, BUDGETS.execute, summary);
}

export const identity = {
  render() {
    const saved = session.saved();
    const id = session.identity;
    if (!saved || !id) return '<section class="screen plain"><h1 class="page">Identity</h1></section>';
    const names = KNOWN_POLICIES();
    const mine = id.keyId;
    const devices = id.keys.map((k) => {
      const kind = names[hex(k.policy)] ?? 'Key';
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
      const contact = store.get().contacts.find((c) => c.identity === g);
      return `<div class="row"><span class="avatar">${icon('shield')}</span><span class="main"><b>${esc(contact?.name ?? `Identity ${short(g)}`)}</b>
        <span>${linked ? 'Linked' : 'Not linked yet'}</span></span>
        ${linked && mine != null ? `<button class="btn small danger" data-unlink="${g}">Unlink</button>` : ''}</div>`;
    }).join('');
    const core = id.core;
    return `<section>
      <div class="hero">
        <div class="top"><span class="title muted-on-navy">Identity</span></div>
        <div class="who"><span class="avatar lg xl">${esc(initials(saved.name))}</span><div><h1>${esc(saved.name)}</h1>
          <span class="chip ${id.onChain ? 'good' : 'warn'}">${icon(id.onChain ? 'shield' : 'clock')} ${id.onChain ? 'On chain' : 'Waiting for the next block'}</span></div></div>
        <button class="chip idchip" data-copy="${hex(id.id)}">ID ${short(id.id)} ${icon('copy')}</button>
        <div class="split"><div><span>Devices</span><b>${id.keys.length}</b><span>${mine != null ? 'including this one' : 'not this browser yet'}</span></div>
          <div><span>Guardians</span><b>${core ? Number(core.guardianCount) : 0}</b><span>${core && core.guardianCount ? `${Number(core.threshold) || Math.floor(Number(core.guardianCount) / 2) + 1} needed to recover` : 'add someone you trust'}</span></div></div>
      </div>
      <div class="screen narrow">
        <div class="stack mt">${notices()}</div>
        ${id.onChain && mine == null ? notThisBrowser(saved) : ''}
        <h2 class="section">Devices</h2>
        <div class="card list">${devices || '<div class="row"><span class="main"><span>None yet</span></span></div>'}</div>
        ${mine != null ? `<button class="link" data-add-device>${icon('plus')} Add a device</button>` : ''}
        ${pending ? `<h2 class="section">Pending changes</h2><div class="card list">${pending}</div>
          <p class="muted small">A change waits ${esc(duration(core.changeDelay))}; until then any of your devices can cancel it.</p>` : ''}
        <h2 class="section">Guardians</h2>
        <div class="card list">${guardians || '<div class="row"><span class="main"><b>No guardians linked from here</b><span class="wrap">Guardians are people you trust. Enough of them together can give your identity new keys if you lose every device.</span></span></div>'}</div>
        ${mine != null ? `<button class="link" data-link-guardian>${icon('shield')} Link a guardian</button>` : ''}
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
    $$('[data-remove]', view).forEach((b) => b.addEventListener('click', act(() =>
      confirm(`Remove device #${b.dataset.remove}? It takes effect after ${duration(id.core.changeDelay)}.`)
        && propose([{ kind: 'removeKey', keyId: BigInt(b.dataset.remove) }], `Remove device #${b.dataset.remove}`))));
    $$('[data-cancel]', view).forEach((b) => b.addEventListener('click', act(async () => {
      const signer = session.signer();
      const input = await registry.cancelInput({ chain: session.chain, registry: session.registry, id: id.id, signer, numbers: [BigInt(b.dataset.cancel)] });
      return session.call(session.registry, input, BUDGETS.execute, `Cancel change #${b.dataset.cancel}`);
    })));
    $$('[data-apply]', view).forEach((b) => b.addEventListener('click', act(() =>
      session.call(session.registry, registry.applyInput(id.id, BigInt(b.dataset.apply)), BUDGETS.execute, `Apply change #${b.dataset.apply}`))));
    $$('[data-unlink]', view).forEach((b) => b.addEventListener('click', act(() =>
      confirm(`Unlink this guardian? It takes effect after ${duration(id.core.changeDelay)}.`)
        && propose([{ kind: 'removeGuardian', guardian: unhex(b.dataset.unlink) }], 'Unlink a guardian'))));
    $('[data-add-device]', view)?.addEventListener('click', () => { location.hash = '#/scan'; });
    $('[data-link-guardian]', view)?.addEventListener('click', act(async () => {
      const text = prompt('The guardian’s identity ID (64 hex digits). Link only someone you know.');
      const g = idOf((text ?? '').replace(/\s+/g, ''));
      if (!g) return null;
      if (hex(g) === hex(id.id)) throw new Error('An identity cannot guard itself');
      const exists = await session.pool.record(session.registry, registry.coreKey(g));
      if (!exists) throw new Error('No identity has that ID on this network: a guardian must be an identity, not an account');
      const saved = session.saved();
      session.keep({ ...saved, guardians: [...new Set([...(saved.guardians ?? []), hex(g)])] });
      return propose([{ kind: 'addGuardian', guardian: g }], `Link guardian ${short(g)}`);
    }));
    $('[data-new-passkey]', view)?.addEventListener('click', act(async () => {
      const saved = session.saved();
      const made = await passkey.create({ name: `${saved.name} · Ting`, handle: crypto.getRandomValues(new Uint8Array(32)) });
      session.keep({ ...saved, publicKey: hex(made.publicKey), credentialId: hex(made.credentialId) });
      dispatchEvent(new HashChangeEvent('hashchange'));
      return null;
    }));
    $('[data-copy-device]', view)?.addEventListener('click', () => copy($('[data-device-link]', view).textContent, 'Link copied'));
  },
};

function notThisBrowser(saved) {
  if (!saved.publicKey) {
    return `<div class="card pad mt stack"><b>This browser can’t act for ${esc(saved.name)} yet</b>
      <p class="muted">Make a passkey here, then add it from a device that can already act for this identity.</p>
      <button class="btn primary" data-new-passkey>${icon('key')} Make a passkey on this device</button></div>`;
  }
  const link = deviceLink(unhex(saved.id), unhex(saved.publicKey));
  let qr = '';
  try { qr = qrSvg(link); } catch { /* too long */ }
  return `<div class="card pad mt stack"><b>This browser can’t act for ${esc(saved.name)} yet</b>
    <p class="muted">On a device that can, open Identity → Add a device and give it this link. This device’s key is <b class="mono">${fingerprint(unhex(saved.publicKey))}</b>: the other device shows the same before it adds it.</p>
    <div class="qr">${qr}</div>
    <div class="mono small" data-device-link>${esc(link)}</div>
    <button class="btn secondary" data-copy-device>${icon('copy')} Copy link</button></div>`;
}

function opWords(op) {
  if (op.kind === 'addKey') return `Add a device (${fingerprint(op.params)})`;
  if (op.kind === 'removeKey') return `Remove device #${op.keyId}`;
  if (op.kind === 'addGuardian') return `Link guardian ${short(op.guardian)}`;
  if (op.kind === 'removeGuardian') return `Unlink guardian ${short(op.guardian)}`;
  if (op.kind === 'threshold') return 'Change how many guardians recover';
  if (op.kind === 'delays') return 'Change the delays';
  if (op.kind === 'slotDelay') return `Change ${slotName(op.slot)}’s lock`;
  return 'A change';
}

/** Adding a device from its `ting:device` link: a change that waits the change delay. */
export const device = {
  render(link) {
    const f = Object.fromEntries(new URLSearchParams(link.slice(link.indexOf('?') + 1)));
    const id = session.identity;
    const problems = [];
    if (!id?.onChain || id.keyId == null) problems.push('This browser can’t act for an identity yet');
    else if (f.id !== hex(id.id)) problems.push('The link is for another identity');
    if (f.net !== session.net.chainId.slice(0, 8)) problems.push('The link is for another network');
    if (f.scheme !== 'webauthn' || !/^04[0-9a-f]{128}$/.test(f.key ?? '')) problems.push('Ting ID Web adds passkeys (scheme=webauthn) only');
    if (problems.length) {
      return `<section class="screen plain narrow"><h1 class="page">Add a device</h1>
        <div class="note bad mt">${icon('warn')}<div>${esc(problems.join('. '))}.</div></div></section>`;
    }
    return `<section class="screen plain narrow"><h1 class="page">Add a device</h1>
      <div class="card mt"><div class="kv"><span>Kind</span><span>Passkey</span></div>
        <div class="kv"><span>Key</span><span class="mono">${fingerprint(unhex(f.key))}</span></div></div>
      <div class="note warn">${icon('warn')}<div>Check that the new device shows the same key. Only add a device you hold yourself.</div></div>
      <div class="note">${icon('clock')}<div>Takes effect in ${esc(duration(id.core.changeDelay))}; until then any of your devices can cancel it.</div></div>
      <button class="btn primary mt" data-propose>${icon('key')} Propose</button></section>`;
  },
  bind(view, link) {
    const f = Object.fromEntries(new URLSearchParams(link.slice(link.indexOf('?') + 1)));
    $('[data-propose]', view)?.addEventListener('click', async (e) => {
      e.currentTarget.disabled = true;
      try {
        const sent = await propose([{ kind: 'addKey', policy: unhex(session.net.policyWebauthn), params: unhex(f.key) }], 'Add a device');
        location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        e.currentTarget.disabled = false;
      }
    });
  },
};

const createState = { savings: null };

export const create = {
  render() {
    const net = session.net;
    const dev = net.key === 'development';
    const presets = dev ? [[120, '2 minutes'], [3600, '1 hour'], [604_800, '7 days']] : [[86_400, '1 day'], [172_800, '2 days'], [604_800, '7 days'], [2_592_000, '30 days']];
    createState.savings ??= dev ? 120 : 604_800;
    const ready = session.policyReady;
    return `<section class="screen plain narrow">
      <button class="back" data-back>${icon('back')} Back</button>
      <h1 class="page">Create an identity</h1>
      <p class="lead">An instant Spending account, a Savings account whose withdrawals wait, and your passkey to sign. On ${esc(net.name)}.</p>
      ${ready ? '' : `<div class="note warn">${icon('warn')}<div>Ting ID Web is not on ${esc(net.name)} yet: its passkey program has not been deployed there. Choose another network in Settings.</div></div>`}
      <div class="card">
        <label class="field"><span>Name</span><input name="name" placeholder="Your name" maxlength="40" autocomplete="name"></label>
        <div class="field"><span>Savings withdrawals wait</span><div class="seg">${presets.map(([s, label]) => `<button type="button" data-savings="${s}" class="${s === createState.savings ? 'on' : ''}">${label}</button>`).join('')}</div></div>
      </div>
      <p class="muted small">Changes to the identity wait ${dev ? '10 minutes' : '7 days'}, and a recovery by guardians ${dev ? '5 minutes' : '2 days'}. You can add guardians later.</p>
      <button class="btn primary mt" data-create ${ready ? '' : 'disabled'}>${icon('key')} Create with a passkey</button>
      <p class="center muted small">Your device asks for Face ID, Touch ID or its PIN to make the passkey. The identity is on chain once the next block includes it.</p>
    </section>`;
  },
  bind(view) {
    $('[data-back]', view).addEventListener('click', () => { location.hash = '#/welcome'; });
    $$('[data-savings]', view).forEach((b) => b.addEventListener('click', () => {
      createState.savings = Number(b.dataset.savings);
      $$('[data-savings]', view).forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('[data-create]', view).addEventListener('click', async (e) => {
      const button = e.currentTarget;
      const name = $('[name=name]', view).value.trim() || 'Me';
      button.disabled = true;
      button.innerHTML = '<span class="spinner"></span> Making your passkey';
      try {
        const dev = session.net.key === 'development';
        const handle = crypto.getRandomValues(new Uint8Array(32));
        const made = await passkey.create({ name: `${name} · Ting`, handle });
        const creation = registry.creation({
          keys: [{ policy: unhex(session.net.policyWebauthn), params: made.publicKey }],
          slots: [0, createState.savings],
          changeDelay: dev ? 600 : registry.DEFAULTS.changeDelay,
          recoveryDelay: dev ? 300 : registry.DEFAULTS.recoveryDelay,
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
          <span class="wrap">A passkey you made for Ting ID Web, synced here or on a security key.</span></span>${icon('chevron')}</button>
        <button class="row" data-with-id><span class="avatar">${icon('identity')}</span><span class="main"><b>With its identity ID</b>
          <span class="wrap">Then a device that can act for it adds this one.</span></span>${icon('chevron')}</button>
      </div>
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
        const name = prompt('A name for this identity on this device', 'Me')?.trim() || 'Me';
        session.keep({ id: hex(pick.id), name, publicKey: hex(key.params), credentialId: hex(signed.credentialId), createdHeight: pick.height, guardians: [], coins: [] });
        await session.refresh(true);
        location.hash = '#/wallet';
      } catch (err) {
        out.innerHTML = `<div class="note bad">${icon('warn')}<div>${esc(problem(err))}</div></div>`;
      }
    });
    $('[data-with-id]', view).addEventListener('click', async () => {
      const text = prompt('Your identity’s ID (64 hex digits)');
      const id = idOf((text ?? '').replace(/\s+/g, ''));
      if (!id) return text && toast('An identity ID is 64 hex digits');
      const core = await session.pool.record(session.registry, registry.coreKey(id)).catch(() => null);
      if (!core) return toast('No identity with that ID on this network');
      const name = prompt('A name for this identity on this device', 'Me')?.trim() || 'Me';
      session.keep({ id: hex(id), name, publicKey: null, credentialId: null, createdHeight: 1, guardians: [], coins: [] });
      await session.refresh(true);
      location.hash = '#/identity';
    });
  },
};

export { accountBox };

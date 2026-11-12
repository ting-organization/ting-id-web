// Getting back in, and helping someone back in.
//
// A recovery phrase: 12 words, made as Ting ID makes them, whose key is a key
// of the identity. Ting ID Web uses it for one thing only: to restore, by
// signing the change that adds a passkey on a new device. It shows the words
// once, when they are made, and keeps neither them nor their key.
//
// Guardians: when everything is lost, this device makes a passkey and shows a
// recover code; enough guardians approve it, and once the recovery delay has
// passed, the identity's keys are this passkey alone. A guardian approves
// from the code, scanned or pasted in the wallet.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { qrSvg } from '../../../kit/web/qr.js';
import { BUDGETS } from '../chain/budgets.js';
import * as registry from '../chain/registry.js';
import { phraseSigner } from '../chain/signer.js';
import { heldLink, hold, readRecoverLink, recoverLink } from '../links.js';
import * as passkey from '../passkey.js';
import { fingerprint, isPhraseKey, keyKind, netTag } from '../parts.js';
import * as phrase from '../phrase.js';
import { session } from '../session.js';
import * as store from '../store.js';
import { $, $$, copy, duration, esc, icon, problem, short, toast, when } from '../ui.js';

const back = (to) => `<a class="back" href="${to}">${icon('back')} Back</a>`;
const note = (kind, text) => `<div class="note ${kind}">${icon(kind === 'bad' || kind === 'warn' ? 'warn' : 'info')}<div>${text}</div></div>`;

/** What this browser calls the identity `idHex`: its contact's name, else its short ID. */
const nameOfIdentity = (idHex) => store.contactOfIdentity(idHex)?.name ?? `Identity ${short(idHex)}`;

/** The keys of a key list, as rows: their kind and fingerprint. */
const keyRows = (keys) => keys.map((k) => `<div class="row"><span class="avatar">${icon('key')}</span><span class="main">
  <b>${esc(keyKind(k))}</b><span class="mono">${fingerprint(k.params)}</span></span></div>`).join('');

/** A passkey for this device, named for the identity it will act for. */
const newPasskey = (name) => passkey.create({ name: `${name} · Ting`, handle: crypto.getRandomValues(new Uint8Array(32)) });

// ---- Restore with the recovery phrase -----------------------------------------

export const restorePhrase = {
  render() {
    const ready = session.policyReady && session.net.policySecp256k1;
    return `<section class="screen plain narrow">
      ${back('#/restore')}
      <h1 class="page">Restore with your recovery phrase</h1>
      <p class="lead">The 12 words you wrote down. They find your identity and sign one change: adding a passkey on this device.</p>
      ${ready ? '' : note('warn', 'Recovery phrases are not on this network yet.')}
      <div class="card"><label class="field"><span>Your words</span>
        <textarea name="words" rows="4" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="word word word …"></textarea>
        <span class="hint" data-hint>In order, with a space between them.</span></label></div>
      <button class="btn primary mt" data-find disabled>${icon('restore')} Find my identity</button>
      <div class="stack mt" data-out></div>
    </section>`;
  },

  bind(view) {
    const field = $('[name=words]', view);
    const find = $('[data-find]', view);
    const hint = $('[data-hint]', view);
    const out = $('[data-out]', view);
    if (!session.policyReady || !session.net.policySecp256k1) return;
    const check = () => {
      const words = phrase.normalise(field.value);
      const wrong = words.length >= 12 ? phrase.problem(words) : null;
      hint.textContent = wrong ?? `${words.length} word${words.length === 1 ? '' : 's'}. In order, with a space between them.`;
      hint.classList.toggle('bad', Boolean(wrong));
      find.disabled = words.length < 12 || Boolean(wrong);
    };
    field.addEventListener('input', check);
    find.addEventListener('click', async () => {
      find.disabled = true;
      out.innerHTML = `${note('', 'Reading the words…')}<p class="muted small" data-progress></p>`;
      try {
        const key = await phrase.keyOf(phrase.normalise(field.value));
        const policy = unhex(session.net.policySecp256k1);
        const found = await registry.findByKey(session.pool, session.registry, [{ policy, params: key.publicKey }], (at, of) => {
          const p = $('[data-progress]', out);
          if (p) p.textContent = `Looking for your identity · block ${at} of ${of}`;
        });
        if (!found.length) {
          out.innerHTML = note('warn', 'No identity on this network lists this phrase’s key. Check the words and their order. If your guardians recovered the identity, or a change replaced the phrase, its words no longer restore it.');
          find.disabled = false;
          return;
        }
        // Anyone can list a public key in an identity of their own; a key is public only once one lists it, so the first is normally yours.
        // Even a single match is only chosen by the user: once guardians or a new phrase have replaced this key in
        // their identity, the one left listing it may be a stranger's.
        found.sort((a, b) => a.height - b.height);
        out.innerHTML = `<p>${found.length > 1 ? 'More than one identity lists this phrase’s key, the earliest first. Choose the one whose ID you know:' : 'An identity lists this phrase’s key. Check that its ID is the one you know before you go on:'}</p>
          <div class="card list">${found.map((f, i) => `<button class="row" data-pick="${i}"><span class="avatar">${icon('identity')}</span>
          <span class="main"><b class="mono">Identity ${short(f.id)}</b><span>created ${esc(when(f.time))}</span></span>${icon('chevron')}</button>`).join('')}</div>
          ${note('', 'Anyone can list a key they have seen in an identity of their own. If your guardians recovered your identity, or a new phrase replaced this one, these words no longer open it, and an identity listed here may be someone else’s.')}`;
        $$('[data-pick]', out).forEach((b) => b.addEventListener('click', () => chosen(view, found[Number(b.dataset.pick)], key)));
      } catch (err) {
        out.innerHTML = note('bad', esc(problem(err)));
        find.disabled = false;
      }
    });
  },
};

/** The identity the phrase found: name this device, choose lost keys to remove, then make a passkey and propose. */
async function chosen(view, found, key) {
  const out = $('[data-out]', view);
  out.innerHTML = note('', 'Reading the identity…');
  let id;
  try {
    id = await registry.readIdentity(session.pool, session.registry, found.id);
  } catch (err) {
    out.innerHTML = note('bad', esc(problem(err)));
    return;
  }
  const own = id?.keys.find((k) => isPhraseKey(k) && hex(k.params) === hex(key.publicKey));
  if (!own) {
    out.innerHTML = note('warn', 'This identity no longer lists the phrase’s key.');
    return;
  }
  const others = id.keys.filter((k) => k.keyId !== own.keyId);
  $('[data-find]', view).hidden = true;
  $('[name=words]', view).closest('.card').hidden = true;
  out.innerHTML = `<div class="card list"><div class="row"><span class="avatar">${icon('check')}</span><span class="main">
      <b>Found your identity</b><span class="mono">Identity ${short(found.id)}</span></span></div></div>
    <div class="card"><label class="field"><span>Name on this device</span><input name="name" value="Me" maxlength="40" autocomplete="off"></label></div>
    ${others.length ? `<h2 class="section">Remove keys you lost</h2>
    <div class="card list">${others.map((k) => `<label class="row"><span class="avatar">${icon('key')}</span><span class="main">
      <b>${esc(keyKind(k))} #${k.keyId}</b><span class="mono">${fingerprint(k.params)}</span></span>
      <input type="checkbox" data-remove="${k.keyId}" aria-label="Remove ${esc(keyKind(k))} #${k.keyId}"></label>`).join('')}</div>
    <p class="muted small">Tick only a key you lost or that was stolen. A passkey that still syncs to your other devices would stop working there too.</p>` : ''}
    ${note('', `This device makes a passkey, and your phrase proposes adding it. Like every change, it waits ${esc(duration(id.core.changeDelay))}, and any of your keys can cancel it meanwhile. Until then this browser shows your identity without acting for it.`)}
    <button class="btn primary mt" data-propose>${icon('key')} Make a passkey and propose</button>`;
  // The passkey made here: one, however many tries sending the change takes.
  let made = null;
  $('[data-propose]', out).addEventListener('click', async (e) => {
    const button = e.currentTarget;
    const name = $('[name=name]', out).value.trim() || 'Me';
    const removals = $$('[data-remove]', out).filter((c) => c.checked).map((c) => ({ kind: 'removeKey', keyId: BigInt(c.dataset.remove) }));
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> ${made ? 'Sending' : 'Making your passkey'}`;
    try {
      made ??= await newPasskey(name);
      // As the identity is now: an earlier try may have gone through after all, and its nonce moved on.
      const now = await registry.readIdentity(session.pool, session.registry, found.id) ?? id;
      const ours = (k) => hex(k.params) === hex(made.publicKey);
      const sentBefore = now.keys.some(ours) || now.pending.some((c) => c.ops.some((op) => op.kind === 'addKey' && ours(op)));
      if (!sentBefore) {
        const signer = phraseSigner({ secret: key.secret, keyId: own.keyId });
        const ops = [{ kind: 'addKey', policy: unhex(session.net.policyWebauthn), params: made.publicKey }, ...removals];
        const input = await registry.proposeInput({
          chain: session.chain, registry: session.registry, id: found.id, opNonce: now.core.opNonce, signer, ops,
        });
        await session.call(session.registry, input, BUDGETS.execute, 'Add this browser’s passkey, with the recovery phrase');
      }
      // Sent: only now is the identity kept here, and the words and their key let go. Nothing keeps them.
      session.keep({
        id: hex(found.id), name, publicKey: hex(made.publicKey), credentialId: hex(made.credentialId),
        createdHeight: found.height, guardians: [], coins: [], phraseKey: hex(key.publicKey),
      });
      $('[name=words]', view).value = '';
      key.secret = 0n;
      await session.refresh(true);
      location.hash = '#/identity';
    } catch (err) {
      toast(problem(err));
      button.disabled = false;
      button.innerHTML = `${icon('key')} ${made ? 'Try again' : 'Make a passkey and propose'}`;
    }
  });
}

// ---- Restore with guardians ----------------------------------------------------

export const restoreGuardians = {
  render() {
    return `<section class="screen plain narrow">
      ${back('#/restore')}
      <h1 class="page">Restore with your guardians</h1>
      <p class="lead">Lost every passkey and your recovery phrase? Your guardians can give your identity a new passkey: this device’s.</p>
      ${session.policyReady ? '' : note('warn', 'Ting ID Web is not on this network yet.')}
      <div class="card">
        <label class="field"><span>Your identity’s ID</span>
          <textarea name="id" rows="2" spellcheck="false" autocomplete="off" placeholder="64 hex digits"></textarea>
          <span class="hint">Your guardians have it: you are in their contacts, and it is the ID they guard.</span></label>
        <label class="field"><span>Name on this device</span><input name="name" value="Me" maxlength="40" autocomplete="off"></label>
      </div>
      ${note('', 'This device makes a passkey and shows a code. Each guardian scans it and approves. Once enough of them have, and the recovery delay has passed, this passkey is your identity’s only key: your old passkeys and phrase stop working.')}
      <button class="btn primary mt" data-start ${session.policyReady ? '' : 'disabled'}>${icon('key')} Make a passkey here</button>
    </section>`;
  },

  bind(view) {
    $('[data-start]', view).addEventListener('click', async (e) => {
      const button = e.currentTarget;
      const idHex = $('[name=id]', view).value.replace(/\s+/g, '').toLowerCase();
      const name = $('[name=name]', view).value.trim() || 'Me';
      if (!/^[0-9a-f]{64}$/.test(idHex)) return toast('An identity ID is 64 hex digits');
      button.disabled = true;
      try {
        const core = await session.pool.record(session.registry, registry.coreKey(unhex(idHex)));
        if (!core) throw new Error('No identity has that ID on this network');
        if (registry.decodeCore(core).guardianCount === 0n) {
          throw new Error('This identity has no guardians: only its recovery phrase, or a device that can act for it, can let you back in');
        }
        button.innerHTML = '<span class="spinner"></span> Making your passkey';
        const made = await newPasskey(name);
        session.keep({
          id: idHex, name, publicKey: hex(made.publicKey), credentialId: hex(made.credentialId),
          createdHeight: 1, guardians: [], coins: [], recovering: true,
        });
        await session.refresh(true);
        location.hash = '#/identity';
      } catch (err) {
        toast(problem(err));
        button.disabled = false;
        button.innerHTML = `${icon('key')} Make a passkey here`;
      }
    });
  },
};

/** On Identity while guardians recover it to this browser: the code they approve, and how far they are. */
export function recoveringCard(saved) {
  const link = recoverLink(netTag(), saved.id, session.recoveryKeys(saved));
  let qr = '';
  try { qr = qrSvg(link); } catch { /* too long: the link can still be copied */ }
  const r = session.recovery;
  const status = !r ? 'Reading how far your guardians are…'
    : r.dueAt != null ? `Enough guardians approved. It runs ${when(Number(r.dueAt))}: the node holds it until then, and this browser can act once it has.`
      : `${r.approvals} of the ${r.required} approvals it needs.`;
  return `<div class="card pad mt stack"><b>Your guardians recover ${esc(saved.name)} to this device</b>
    <p class="muted">Call each guardian and show them this code. They scan it in Ting ID or Ting ID Web (Scan, on the wallet), or you send them the link to paste there. They should hear from you that it is you, and see this device’s key, <b class="mono">${fingerprint(unhex(saved.publicKey))}</b>.</p>
    <div class="note ${r?.dueAt != null ? 'good' : ''}">${icon('shield')}<div>${esc(status)}</div></div>
    <div class="qr">${qr}</div>
    <div class="mono small" data-recover-link>${esc(link)}</div>
    <button class="btn secondary" data-copy-recover>${icon('copy')} Copy link</button></div>`;
}

export function bindRecoveringCard(view) {
  $('[data-copy-recover]', view)?.addEventListener('click', () => copy($('[data-recover-link]', view).textContent, 'Link copied'));
}

/** On Identity for its owner: recoveries guardians approve now, which a thief may have asked for. */
export function recoveryWarnings() {
  return session.openRecoveries().map((p) => {
    const keys = registry.decodeKeyList(unhex(p.keys));
    return `<div class="card pad mt stack"><b class="bad-text">${icon('warn')} Guardians are approving a recovery of your identity</b>
      <p>${p.approvals} of the ${p.required} approvals it needs. ${p.dueAt != null ? `It can run ${esc(when(Number(p.dueAt)))}, and then these keys replace all of yours:` : 'If it gets them, after the recovery delay these keys replace all of yours:'}</p>
      <div class="card list">${keyRows(keys)}</div>
      <p class="muted">If you did not ask for this, call your guardians now and ask them to withdraw. Your own keys cannot stop a recovery; only guardians can.</p></div>`;
  }).join('');
}

// ---- The recovery phrase on Identity -------------------------------------------

/** The Recovery phrase section of Identity, for a browser that acts for the identity. */
export function phraseSection(id) {
  if (!session.net.policySecp256k1) return '';
  const keys = id.keys.filter(isPhraseKey);
  // Only the phrase this browser made is called one: another secp256k1 key may be a Ting ID phone's.
  const mine = session.saved()?.phraseKey;
  const adding = mine && id.pending.find((c) => c.ops.some((op) => op.kind === 'addKey' && isPhraseKey(op) && hex(op.params) === mine));
  let body;
  if (adding) {
    body = `<div class="row"><span class="avatar">${icon('clock')}</span><span class="main"><b>A recovery phrase is being added</b>
      <span>Its words restore this identity from ${esc(when(Number(adding.effectiveAt)))}</span></span></div>`;
  } else if (keys.length) {
    body = keys.map((k) => `<div class="row"><span class="avatar">${icon('lock')}</span><span class="main"><b>${esc(keyKind(k))} #${k.keyId}</b>
      <span>Its 12 words restore this identity · <span class="mono">${fingerprint(k.params)}</span></span></span></div>`).join('')
      + '<div class="row"><span class="main"><a class="link" href="#/recovery-phrase/new">Make a new recovery phrase</a></span></div>';
  } else {
    body = `<div class="row"><span class="avatar">${icon('lock')}</span><span class="main"><b>No recovery phrase yet</b>
      <span class="wrap">12 words you write down. If you lose your passkeys, they get you back in on a new device.</span></span></div>
      <div class="row"><span class="main"><a class="btn secondary" href="#/recovery-phrase">${icon('plus')} Add a recovery phrase</a></span></div>`;
  }
  return `<h2 class="section">Recovery phrase</h2><div class="card list">${body}</div>`;
}

/**
 * Adding a recovery phrase, or a new one in place of the old: the words are
 * shown once, three of them typed back, and the passkey proposes adding the
 * phrase's key. Nothing keeps the words.
 */
export const recoveryPhrase = {
  render(mode) {
    const id = session.identity;
    if (!id?.onChain || id.keyId == null) return `<section class="screen plain narrow">${back('#/identity')}<h1 class="page">Recovery phrase</h1>${note('bad', 'This browser can’t act for this identity yet.')}</section>`;
    const replacing = mode === 'new';
    const old = id.keys.filter(isPhraseKey);
    const mine = session.saved().phraseKey;
    return `<section class="screen plain narrow">
      ${back('#/identity')}
      <h1 class="page">${replacing ? 'A new recovery phrase' : 'Add a recovery phrase'}</h1>
      <div data-step>
        <p class="lead">12 words that get you back in if you lose your passkeys. Write them on paper and keep it somewhere safe: whoever has the words can act for your identity.</p>
        ${replacing && old.length ? `<h2 class="section">The phrase it replaces</h2><div class="card list">${old.map((k) => `<label class="row"><span class="avatar">${icon('lock')}</span><span class="main">
          <b>${esc(keyKind(k))} #${k.keyId}</b><span class="mono">${fingerprint(k.params)}</span></span>
          <input type="checkbox" data-old="${k.keyId}" ${hex(k.params) === mine ? 'checked' : ''} aria-label="Replace ${esc(keyKind(k))} #${k.keyId}"></label>`).join('')}</div>
          <p class="muted small">A ticked key stops working once the change applies. A phone key of Ting ID is also a phrase: leave it unticked to keep that phone.</p>` : ''}
        ${note('', 'Ting ID Web shows the words once and keeps no copy. They never sign anything here but a restore.')}
        <button class="btn primary mt" data-show>${icon('lock')} Show my words</button>
      </div>
    </section>`;
  },

  bind(view, mode) {
    const step = $('[data-step]', view);
    const start = $('[data-show]', view);
    if (!step || !start) return;
    const id = session.identity;
    let words = [];
    let replaced = [];

    const showWords = () => {
      step.innerHTML = `<p class="lead">Write these down, in order. Not in a photo, a note on this device, or a message.</p>
        <ol class="words">${words.map((w) => `<li>${esc(w)}</li>`).join('')}</ol>
        <button class="btn primary mt" data-written>I wrote them down</button>`;
      $('[data-written]', step).addEventListener('click', askBack);
    };

    // Three of the words, in order, typed back from paper.
    const askBack = () => {
      const places = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b % 12)
        .filter((n, i, all) => all.indexOf(n) === i).slice(0, 3).sort((a, b) => a - b);
      step.innerHTML = `<p class="lead">Type these words from what you wrote down.</p>
        <div class="card">${places.map((n) => `<label class="field"><span>Word ${n + 1}</span>
          <input data-place="${n}" autocomplete="off" autocapitalize="none" spellcheck="false"></label>`).join('')}</div>
        ${note('', `Then your passkey proposes adding the phrase. It works once the change applies, after ${esc(duration(id.core.changeDelay))}.`)}
        <button class="btn primary mt" data-check>${icon('key')} Check and propose</button>
        <button class="link" data-again>Show the words again</button>`;
      $('[data-again]', step).addEventListener('click', showWords);
      $('[data-check]', step).addEventListener('click', async (e) => {
        const button = e.currentTarget;
        const wrong = $$('[data-place]', step).find((f) => f.value.trim().toLowerCase() !== words[Number(f.dataset.place)]);
        if (wrong) return toast(`That is not word ${Number(wrong.dataset.place) + 1}: look at what you wrote down`);
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> Waiting for your passkey';
        try {
          const { publicKey } = await phrase.keyOf(words);
          const ops = [{ kind: 'addKey', policy: unhex(session.net.policySecp256k1), params: publicKey },
            ...replaced.map((keyId) => ({ kind: 'removeKey', keyId }))];
          const sent = await session.propose(ops, mode === 'new' ? 'A new recovery phrase' : 'Add a recovery phrase');
          session.keep({ ...session.saved(), phraseKey: hex(publicKey) });
          words = [];
          location.hash = `#/tx/${sent.id}`;
        } catch (err) {
          toast(problem(err));
          button.disabled = false;
          button.innerHTML = `${icon('key')} Check and propose`;
        }
      });
    };

    start.addEventListener('click', () => {
      replaced = $$('[data-old]', view).filter((c) => c.checked).map((c) => BigInt(c.dataset.old));
      words = phrase.newWords();
      showWords();
    });
  },
};

// ---- Approving someone's recovery as their guardian ------------------------------

const refused = (message) => `<section class="screen plain narrow">${back('#/wallet')}
  <h1 class="page">Approve a recovery</h1>${note('bad', esc(message))}
  <a class="btn secondary mt" href="#/scan">${icon('scan')} Scan a code</a></section>`;

/** What the held recover link asks, checked: `{ target, keys, keyList, status, standing }`, or throws why not. */
async function recoveryAsked() {
  const link = heldLink('recover');
  if (!link) throw new Error('Scan their recover code on the Scan screen, or paste its link there.');
  const me = session.identity;
  if (!me?.onChain || me.keyId == null) throw new Error('This browser can’t act for an identity yet.');
  const { id, keys: keyList } = readRecoverLink(link, netTag());
  if (id === hex(me.id)) throw new Error('This is a recovery of your own identity: your guardians approve it, not you.');
  let keys;
  try {
    keys = registry.decodeKeyList(keyList);
  } catch {
    throw new Error('The link’s keys are not written right.');
  }
  if (!keys.length) throw new Error('The link lists no keys.');
  const target = unhex(id);
  const status = await registry.readRecovery(session.pool, session.registry, target, keyList);
  if (!status) throw new Error('No identity has that ID on this network.');
  const standing = await registry.readGuardianStanding(session.pool, session.registry, target, status.core, me.id, status.proposal);
  if (!standing.linked) throw new Error(`You are not a guardian of ${nameOfIdentity(id)}: only their guardians can approve their recovery.`);
  return { id, target, keys, keyList, status, standing };
}

export const approveRecovery = {
  async render() {
    let a;
    try {
      a = await recoveryAsked();
    } catch (err) {
      return refused(problem(err));
    }
    const { id, keys, status, standing } = a;
    const name = nameOfIdentity(id);
    const approving = standing.approving && hex(standing.approving) !== hex(status.proposal);
    const progress = status.dueAt != null
      ? `Enough guardians approved: it can run ${when(Number(status.dueAt))}.`
      : `${status.approvals} of the ${status.required} approvals it needs.`;
    let action;
    if (standing.mark === 1) {
      action = `${note('good', 'You approve this recovery.')}
        <button class="btn secondary mt" data-withdraw="${hex(status.proposal)}">Withdraw my approval</button>`;
    } else if (standing.mark === 2) {
      action = note('', 'You withdrew from this recovery, so you cannot approve it again.');
    } else if (approving) {
      action = `${note('warn', `You approve another recovery of ${esc(name)}. A guardian approves one at a time: withdraw that one first, then approve this.`)}
        <button class="btn secondary mt" data-withdraw="${hex(standing.approving)}">Withdraw the other approval</button>`;
    } else {
      action = `<button class="btn primary mt" data-approve>${icon('shield')} Approve</button>`;
    }
    return `<section class="screen plain narrow">
      ${back('#/wallet')}
      <h1 class="page">Recover ${esc(name)}</h1>
      <p class="lead">${esc(name)} asks you, their guardian, to give their identity new keys.</p>
      <div class="card list"><div class="row"><span class="avatar">${icon('identity')}</span><span class="main">
        <b>${esc(name)}</b><span class="mono">Identity ${short(id)}</span></span></div></div>
      <h2 class="section">The keys it installs</h2>
      <div class="card list">${keyRows(keys)}</div>
      <p class="muted small">Once enough guardians approve and ${esc(duration(status.core.recoveryDelay))} pass, these keys replace all of theirs.</p>
      ${note(status.dueAt != null ? 'good' : '', esc(progress))}
      ${note('warn', 'Approve only after you have heard from them yourself, by phone or face to face, and they read you the same key. A message alone can come from a thief. Approving moves none of your coins.')}
      ${action}
    </section>`;
  },

  bind(view) {
    const act = (fn, summary) => async (e) => {
      const button = e.currentTarget;
      button.disabled = true;
      try {
        const a = await recoveryAsked();
        const input = await fn(a, button);
        const sent = await session.call(session.registry, input, BUDGETS.execute, `${summary} ${nameOfIdentity(a.id)}`);
        hold(null);
        location.hash = `#/tx/${sent.id}`;
      } catch (err) {
        toast(problem(err));
        button.disabled = false;
      }
    };
    // The standing is read again at the click, and checked: a guardian's wallet never signs an approval
    // while the guardian supports another proposal, since the signature stays valid for anyone to submit
    // once that approval is withdrawn.
    $('[data-approve]', view)?.addEventListener('click', act((a) => {
      if (a.standing.mark === 1) throw new Error('You approve this recovery already');
      if (a.standing.mark === 2) throw new Error('You withdrew from this recovery, so you cannot approve it again');
      if (a.standing.approving) throw new Error('You approve another recovery of them now: withdraw that one first');
      return registry.approveInput({
        chain: session.chain, registry: session.registry, id: a.target, guardian: session.identity.id,
        keyListBytes: a.keyList, recoveryEpoch: a.status.core.recoveryEpoch, signer: session.signer(),
      });
    }, 'Approve the recovery of'));
    $('[data-withdraw]', view)?.addEventListener('click', act((a, button) => {
      if (!a.standing.approving || hex(a.standing.approving) !== button.dataset.withdraw) {
        throw new Error('You no longer approve that recovery: open the code again');
      }
      return registry.withdrawInput({
        chain: session.chain, registry: session.registry, id: a.target, guardian: session.identity.id,
        proposal: unhex(button.dataset.withdraw), signer: session.signer(),
      });
    }, 'Withdraw from the recovery of'));
  },
};

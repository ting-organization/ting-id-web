// The changes waiting to apply to the identity, each to cancel, and to apply
// once due. The wallet shows them as Identity does: a change no device here
// made is how a stolen key starts a takeover, and it can only be stopped
// while it waits. A change that can no longer apply says why, and is offered
// only to cancel.
import { hex } from '../../../kit/web/bytes.js';
import { BUDGETS } from '../chain/budgets.js';
import * as changes from '../chain/changes.js';
import * as registry from '../chain/registry.js';
import { fingerprint, isPhraseKey, keyKind } from '../parts.js';
import { guardianName, session, slotName } from '../session.js';
import { $$, duration, esc, icon, problem, toast, when } from '../ui.js';

/** What an operation of a change does, in words. */
export function opWords(op) {
  // Only the phrase this browser made is called one: this list is where an owner spots a change they did not make.
  if (op.kind === 'addKey' && isPhraseKey(op)) {
    return `${hex(op.params) === session.saved()?.phraseKey ? 'Add your recovery phrase' : 'Add a phrase or phone key'} (${fingerprint(op.params)})`;
  }
  if (op.kind === 'addKey') return `Add a ${keyKind(op).toLowerCase()} (${fingerprint(op.params)})`;
  if (op.kind === 'removeKey') return `Remove device #${op.keyId}`;
  if (op.kind === 'addGuardian') return `Link guardian ${guardianName(hex(op.guardian))}`;
  if (op.kind === 'removeGuardian') return `Unlink guardian ${guardianName(hex(op.guardian))}`;
  if (op.kind === 'threshold') return 'Change how many guardians recover';
  if (op.kind === 'delays') return 'Change the delays';
  if (op.kind === 'slotDelay') return `Change ${slotName(op.slot)}’s lock`;
  return 'A change';
}

/**
 * The identity's pending changes: each with Cancel, and Apply once due and
 * able to apply; nothing while there are none. On the wallet (`wallet`) the
 * heading says they are the identity's.
 */
export function changesList({ wallet = false } = {}) {
  const id = session.identity;
  if (!id?.onChain || !id.pending.length) return '';
  const mine = id.keyId;
  const state = changes.stateOf(id);
  const now = Date.now() / 1000;
  const rows = id.pending.map((c) => {
    const due = Number(c.effectiveAt) <= now;
    const blocked = changes.blockedApply(state, id.pending, c);
    const status = blocked ? (blocked.forGood ? 'cannot apply' : 'cannot apply yet')
      : due ? 'ready to apply' : `applies ${when(Number(c.effectiveAt))}`;
    const words = blocked && changes.blockedWords(blocked.why, false, guardianName);
    // Who proposed it: a change none of this owner's devices made stands out.
    const by = c.proposer === mine ? 'by this device' : `by device #${c.proposer}`;
    const why = !blocked ? ''
      : blocked.forGood ? `${words}, so the registry refuses it.${mine != null ? ' Cancel it.' : ''}`
        : `${words}: it can apply only once another pending change has.`;
    return `<div class="row"><span class="avatar">${icon(blocked ? 'warn' : 'clock')}</span><span class="main"><b>${esc(c.ops.map(opWords).join(', '))}</b>
      <span>#${c.changeNo} · ${esc(by)} · ${esc(status)}</span>${why ? `<span class="wrap bad">${esc(why)}</span>` : ''}</span>
      <span class="end">${due && !blocked ? `<button class="btn small secondary" data-apply-change="${c.changeNo}">Apply</button>` : ''}
      ${mine != null ? `<button class="btn small danger" data-cancel-change="${c.changeNo}">Cancel</button>` : ''}</span></div>`;
  }).join('');
  const n = id.pending.length;
  return `<h2 class="section">${wallet ? `Identity ${n === 1 ? 'change' : 'changes'} waiting (${n})` : 'Pending changes'}</h2>
    <div class="card list ${wallet ? 'warn' : ''}">${rows}</div>
    <p class="muted small">A change waits ${esc(duration(id.core.changeDelay))}; until then any of your devices can cancel it${wallet ? '. Cancel any you did not make' : ''}.</p>`;
}

/** Cancel and Apply of the changes in `changesList`, within `view`: what is sent opens, why it was not shows. */
export function bindChanges(view) {
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
  $$('[data-cancel-change]', view).forEach((b) => b.addEventListener('click', act(async () => {
    const changeNo = BigInt(b.dataset.cancelChange);
    const signer = session.signer();
    if (!signer) throw new Error('This browser can’t act for this identity yet');
    const input = await registry.cancelInput({ chain: session.chain, registry: session.registry, id: session.identity.id, signer, numbers: [changeNo] });
    return session.call(session.registry, input, BUDGETS.execute, `Cancel change #${changeNo}`);
  })));
  $$('[data-apply-change]', view).forEach((b) => b.addEventListener('click', act(() => session.applyChange(BigInt(b.dataset.applyChange)))));
}

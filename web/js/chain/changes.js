// Whether a change to an identity can apply, as the registry decides when it
// is applied: each operation against the identity as the ones before it left
// it, and the identity whole after them all (a key left, a threshold its
// guardians can reach, a recovery shorter than a change). A change that
// cannot apply never will by itself, so Apply would wait forever: it only
// waits to be cancelled. A new change is also checked behind the changes
// already waiting, as if they apply first, so that it is not proposed to fail
// once they do. A change dies with the key that proposed it, so a waiting
// change that removes that key never leaves another stuck behind it: if it
// applies, the other is void. The same rules as Ting ID's.
import { hex } from '../../../kit/web/bytes.js';

/**
 * What decides whether a change applies to `identity` (registry.readIdentity):
 * its core, the ids of its keys, and which guardians are linked, by hex ID
 * (`linked`). A guardian missing from `linked` was not read, and is not
 * checked.
 */
export function stateOf(identity) {
  return {
    id: hex(identity.id),
    core: { ...identity.core },
    keyIds: new Set(identity.keys.map((k) => k.keyId)),
    linked: new Map(identity.linked ?? []),
  };
}

/** `state` after `ops`, applied as the registry would: `{ state }`, or `{ why }` they cannot apply. */
export function after(state, ops) {
  const core = { ...state.core };
  const keyIds = new Set(state.keyIds);
  const linked = new Map(state.linked);
  for (const op of ops) {
    if (op.kind === 'addKey') {
      keyIds.add(core.nextKeyId);
      core.nextKeyId += 1n;
      core.keyCount += 1n;
    } else if (op.kind === 'removeKey') {
      if (!keyIds.delete(op.keyId)) return { why: { kind: 'keyGone', keyId: op.keyId } };
      core.keyCount -= 1n;
    } else if (op.kind === 'addGuardian') {
      const g = hex(op.guardian);
      if (g === state.id) return { why: { kind: 'own' } };
      if (linked.get(g) === true) return { why: { kind: 'linked', guardian: g } };
      linked.set(g, true);
      core.guardianCount += 1n;
    } else if (op.kind === 'removeGuardian') {
      const g = hex(op.guardian);
      if (linked.get(g) === false) return { why: { kind: 'notLinked', guardian: g } };
      linked.set(g, false);
      if (core.guardianCount > 0n) core.guardianCount -= 1n;
    } else if (op.kind === 'threshold') {
      core.threshold = op.threshold;
    } else if (op.kind === 'delays') {
      core.changeDelay = op.changeDelay;
      core.recoveryDelay = op.recoveryDelay;
    } else if (op.kind === 'slotDelay') {
      if (op.slot > core.slotCount) return { why: { kind: 'slot', slot: op.slot } };
      if (op.slot === core.slotCount) core.slotCount += 1n;
    }
  }
  if (core.keyCount < 1n) return { why: { kind: 'noKeys' } };
  if (core.threshold !== 0n && core.threshold > core.guardianCount) {
    return { why: { kind: 'threshold', threshold: core.threshold, guardians: core.guardianCount } };
  }
  if (core.recoveryDelay >= core.changeDelay) return { why: { kind: 'delays' } };
  return { state: { id: state.id, core, keyIds, linked } };
}

/** Why `ops` cannot apply to the identity as `state` has it now; null when they can. */
export const blockedNow = (state, ops) => after(state, ops).why ?? null;

/** Whether `change` removes key `keyId`: once it applies, every change that key proposed is void. */
const removesKey = (change, keyId) => keyId != null && change.ops.some((op) => op.kind === 'removeKey' && op.keyId === keyId);

/**
 * `state` after the `pending` changes, in their order, each one that can
 * apply; leaving out `skip` and every change that removes key `proposer`,
 * which would void a change of that key rather than leave it stuck.
 */
function afterPending(state, pending, proposer, skip = null) {
  let s = state;
  for (const c of [...pending].sort((a, b) => (a.changeNo < b.changeNo ? -1 : 1))) {
    if (c.changeNo === skip || removesKey(c, proposer)) continue;
    s = after(s, c.ops).state ?? s;
  }
  return s;
}

/**
 * Why pending `change` cannot apply to the identity as `state` has it, or
 * null when it can: `{ why, forGood }`. It can apply later (not `forGood`)
 * when it could after the other `pending` changes, each one that can, apply
 * in their order: such as a guardian linked again after a change unlinking
 * them.
 */
export function blockedApply(state, pending, change) {
  const why = blockedNow(state, change.ops);
  if (!why) return null;
  return { why, forGood: Boolean(blockedNow(afterPending(state, pending, change.proposer, change.changeNo), change.ops)) };
}

/**
 * Why `ops`, proposed with key `proposer`, should not be proposed to the
 * identity `state` has: they cannot apply to it as it is, or not after the
 * `pending` changes (`waiting`). A change removing `proposer` is left out:
 * the new change would be void after it, not stuck, as when a thief's key
 * proposes removing this browser's while this browser proposes removing the
 * thief's. Null when they can.
 */
export function blockedBehind(state, pending, ops, proposer) {
  const now = blockedNow(state, ops);
  if (now) return { why: now, waiting: false };
  const later = blockedNow(afterPending(state, pending, proposer), ops);
  return later ? { why: later, waiting: true } : null;
}

/** The guardians `ops` name, as hex, once each. */
export function guardiansNamed(ops) {
  const out = new Set();
  for (const op of ops) if (op.kind === 'addGuardian' || op.kind === 'removeGuardian') out.add(hex(op.guardian));
  return [...out];
}

/**
 * Why a change cannot apply, in words: `name(hex)` names a guardian.
 * `waiting`: the reason is the changes already waiting, for a change being
 * proposed.
 */
export function blockedWords(why, waiting, name) {
  const behind = waiting ? 'with the changes already waiting, ' : '';
  let text;
  switch (why.kind) {
    case 'own': text = 'an identity cannot be its own guardian'; break;
    case 'linked': text = waiting ? `a change linking ${name(why.guardian)} is already waiting` : `${name(why.guardian)} is your guardian already`; break;
    case 'notLinked': text = waiting ? `a change unlinking ${name(why.guardian)} is already waiting` : `${name(why.guardian)} is not your guardian`; break;
    case 'keyGone': text = waiting ? 'a change removing that device is already waiting' : 'that device is no longer on the identity'; break;
    case 'slot': text = `${behind}that account does not exist`; break;
    case 'noKeys': text = `${behind}the identity would have no device left`; break;
    case 'threshold': text = `${behind}a recovery would need ${why.threshold} approval${why.threshold === 1n ? '' : 's'}, with ${why.guardians} guardian${why.guardians === 1n ? '' : 's'} to give them`; break;
    default: text = `${behind}a recovery would no longer wait less than a change`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

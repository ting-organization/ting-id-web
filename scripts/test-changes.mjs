#!/usr/bin/env node
// Whether a change to an identity can apply, as the registry decides
// (web/js/chain/changes.js): the change that waits forever to be applied, and
// the changes that would fail behind the ones already waiting.
//
//   node scripts/test-changes.mjs
import { hex } from '../kit/web/bytes.js';
import { blockedApply, blockedBehind, blockedNow, blockedWords, guardiansNamed, stateOf } from '../web/js/chain/changes.js';

const me = new Uint8Array(32).fill(1);
const anna = new Uint8Array(32).fill(2);
const bo = new Uint8Array(32).fill(3);
const names = { [hex(anna)]: 'Anna', [hex(bo)]: 'Bo' };
const name = (g) => names[g];

/** An identity with keys 0 and 1, the guardians in `linked` of those in `known`, and `threshold`. */
function identity(linked, { known = [anna, bo], threshold = 0n } = {}) {
  return {
    id: me,
    core: {
      opNonce: 3n, changeEpoch: 0n, recoveryEpoch: 0n, keyEpoch: 0n, nextKeyId: 2n, keyCount: 2n,
      guardianCount: BigInt(linked.length), slotCount: 2n, threshold, changeDelay: 604_800n, recoveryDelay: 172_800n, nextChange: 0n,
    },
    keys: [{ keyId: 0n }, { keyId: 1n }],
    linked: known.map((g) => [hex(g), linked.includes(g)]),
  };
}

const change = (changeNo, ...ops) => ({ changeNo, ops });
const words = (b) => b && blockedWords(b.why, b.waiting, name);

let failed = 0;
function expect(what, got, want) {
  if (got !== want) {
    failed++;
    console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// Linking a guardian who is linked already can never apply: the production case.
{
  const s = stateOf(identity([anna]));
  const dead = change(1n, { kind: 'addGuardian', guardian: anna });
  expect('linked again', blockedNow(s, dead.ops)?.kind, 'linked');
  expect('for good', blockedApply(s, [dead], dead)?.forGood, true);
  expect('in words', words(blockedBehind(s, [], dead.ops)), 'Anna is your guardian already');
  expect('own', words(blockedBehind(s, [], [{ kind: 'addGuardian', guardian: me }])), 'An identity cannot be its own guardian');
}

// A second change of the same kind would fail behind the first.
{
  const s = stateOf(identity([anna]));
  expect('link twice', words(blockedBehind(s, [change(1n, { kind: 'addGuardian', guardian: bo })], [{ kind: 'addGuardian', guardian: bo }])),
    'A change linking Bo is already waiting');
  expect('unlink twice', words(blockedBehind(s, [change(1n, { kind: 'removeGuardian', guardian: anna })], [{ kind: 'removeGuardian', guardian: anna }])),
    'A change unlinking Anna is already waiting');
  expect('remove twice', words(blockedBehind(s, [change(1n, { kind: 'removeKey', keyId: 1n })], [{ kind: 'removeKey', keyId: 1n }])),
    'A change removing that device is already waiting');
  expect('remove both', words(blockedBehind(s, [change(1n, { kind: 'removeKey', keyId: 1n })], [{ kind: 'removeKey', keyId: 0n }])),
    'With the changes already waiting, the identity would have no device left');
  expect('remove one', blockedBehind(s, [], [{ kind: 'removeKey', keyId: 0n }]), null);
  // The state read is left as it was.
  expect('state kept', s.keyIds.size, 2);
}

// A threshold the guardians left could not reach.
{
  const s = stateOf(identity([anna, bo]));
  const b = blockedBehind(s, [change(1n, { kind: 'threshold', threshold: 2n })], [{ kind: 'removeGuardian', guardian: bo }]);
  expect('threshold waiting', b?.waiting, true);
  expect('threshold words', words(b), 'With the changes already waiting, a recovery would need 2 approvals, with 1 guardian to give them');
  expect('delays', blockedNow(s, [{ kind: 'delays', changeDelay: 172_800n, recoveryDelay: 604_800n }])?.kind, 'delays');
}

// A change that fails is left out; one that can apply once another has is not dead.
{
  const s = stateOf(identity([anna]));
  expect('dead left out', blockedBehind(s, [change(1n, { kind: 'addGuardian', guardian: anna })], [{ kind: 'removeGuardian', guardian: anna }]), null);
  const unlink = change(1n, { kind: 'removeGuardian', guardian: anna });
  const relink = change(2n, { kind: 'addGuardian', guardian: anna });
  expect('relink later', blockedApply(s, [unlink, relink], relink)?.forGood, false);
  expect('unlink first', blockedApply(s, [unlink, relink], unlink), null);
  expect('in one change', blockedNow(s, [...unlink.ops, ...relink.ops]), null);
}

// Accounts one after another; a guardian not read is not checked.
{
  const s = stateOf(identity([]));
  expect('next account', blockedNow(s, [{ kind: 'slotDelay', slot: 2n, delay: 0n }]), null);
  expect('gap', blockedNow(s, [{ kind: 'slotDelay', slot: 3n, delay: 0n }])?.kind, 'slot');
  const unknown = stateOf(identity([], { known: [] }));
  expect('unread', blockedNow(unknown, [{ kind: 'removeGuardian', guardian: anna }]), null);
  expect('named', guardiansNamed([{ kind: 'addGuardian', guardian: anna }, { kind: 'removeGuardian', guardian: anna }]).join(), hex(anna));
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('changes: all passed');

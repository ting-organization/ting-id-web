#!/usr/bin/env node
// Whether a change to an identity can apply, as the registry decides
// (web/js/chain/changes.js): the change that waits forever to be applied, and
// the changes that would fail behind the ones already waiting.
//
//   node scripts/test-changes.mjs
import { concat, hex, u64, Writer } from '../kit/web/bytes.js';
import { H } from '../kit/web/ting.js';
import { blockedApply, blockedBehind, blockedNow, blockedWords, guardiansNamed, stateOf } from '../web/js/chain/changes.js';
import { coreKey, encodeChange, readIdentity } from '../web/js/chain/registry.js';

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

const change = (changeNo, ...ops) => ({ changeNo, proposer: 0n, ops });
const by = (proposer, c) => ({ ...c, proposer });
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

// A thief's change against this browser's key never blocks removing the thief's key.
{
  // Key 0 is this browser; key 1 was stolen, and the thief proposed removing key 0.
  const s = stateOf(identity([]));
  const thief = by(1n, change(1n, { kind: 'removeKey', keyId: 0n }));
  expect('remove thief', blockedBehind(s, [thief], [{ kind: 'removeKey', keyId: 1n }], 0n), null);
  expect('proposed by key 1', words(blockedBehind(s, [by(0n, change(1n, { kind: 'removeKey', keyId: 0n }))], [{ kind: 'removeKey', keyId: 1n }], 1n)),
    'With the changes already waiting, the identity would have no device left');
  const owner = change(2n, { kind: 'removeKey', keyId: 1n });
  expect('owner pending', blockedApply(s, [thief, owner], owner), null);
}

// The identity read finds a pending change behind more than 40 newer ones, and stops at an earlier epoch.
{
  const registry = new Uint8Array(32).fill(9);
  const record = (kind, index) => hex(H('app/id-v1/record', Uint8Array.of(kind), me, index));
  const records = new Map();
  const core = [3n, 1n, 0n, 0n, 2n, 2n, 0n, 2n, 0n, 604_800n, 172_800n, 100n];
  records.set(hex(coreKey(me)), core.reduce((w, v) => w.u64(v), new Writer().u8(1)).finish());
  for (const k of [0n, 1n]) records.set(record(1, concat(u64(0n), u64(k))), concat(new Uint8Array(32).fill(7), new Uint8Array(65).fill(Number(k))));
  const put = (n, epoch, ops) => records.set(record(4, u64(n)),
    concat(new Writer().u64(epoch).u64(1n).u64(1_000n).u64(2_000n).finish(), encodeChange(ops)));
  put(3n, 0n, [{ kind: 'threshold', threshold: 0n }]);
  put(5n, 1n, [{ kind: 'addGuardian', guardian: bo }]);
  for (let n = 50n; n < 100n; n++) put(n, 1n, [{ kind: 'delays', changeDelay: 604_800n, recoveryDelay: 172_800n }]);
  let asked = 0;
  const pool = {
    record: async (_, key) => records.get(hex(key)) ?? null,
    storage: async (reads) => { asked += reads.length; return reads.map(([, key]) => records.get(hex(key)) ?? null); },
  };
  const read = await readIdentity(pool, registry, me);
  expect('old change found', read.pending[0]?.changeNo, 5n);
  expect('pending count', read.pending.length, 51);
  expect('oldest first', read.pending.at(-1).changeNo, 99n);
  expect('its guardian read', read.linked.get(hex(bo)), false);
  // Core, 2 keys, 2 slots and 40 changes; then 60 numbers further back in one go; then Bo's record.
  expect('reads', asked, 1 + 2 + 2 + 40 + 60 + 1);
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('changes: all passed');

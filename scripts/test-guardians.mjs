#!/usr/bin/env node
// The guardians Identity shows (web/js/chain/guardians.js): the ones the
// identity's history names, checked against the registry's records, so that a
// guardian linked on another device shows here too and one only an event
// claims does not; and how many linked guardians none of them is.
//
//   node scripts/test-guardians.mjs
import { concat, hex, u64, Writer } from '../kit/web/bytes.js';
import { H } from '../kit/web/ting.js';
import { listed, namedIn } from '../web/js/chain/guardians.js';
import { coreKey, encodeChange, readIdentity } from '../web/js/chain/registry.js';

const me = new Uint8Array(32).fill(1);
const anna = new Uint8Array(32).fill(2);
const bo = new Uint8Array(32).fill(3);
const carl = new Uint8Array(32).fill(4);
const dan = new Uint8Array(32).fill(5);
const registry = new Uint8Array(32).fill(9);

let failed = 0;
function expect(what, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.error(`${what}: got ${g}, want ${w}`);
  }
}

// What the activity scan keeps of the registry's events (session.js describe), and the guardians they name.
{
  const proposed = { kind: 'id:change-proposed', changeNo: 4, ops: [
    { kind: 'addGuardian', text: 'Link a guardian', guardian: hex(anna) },
    { kind: 'threshold', text: 'Recovery needs 1 guardians' },
    { kind: 'removeGuardian', text: 'Unlink a guardian', guardian: hex(bo) },
  ] };
  expect('a change', namedIn(proposed), [hex(anna), hex(bo)]);
  expect('an approval', namedIn({ kind: 'id:recovery-approved', proposal: hex(dan), guardian: hex(carl) }), [hex(carl)]);
  expect('a withdrawal', namedIn({ kind: 'id:recovery-withdrawn', proposal: hex(dan), guardian: hex(carl) }), [hex(carl)]);
  expect('a payment', namedIn({ kind: 'received', from: hex(anna), to: hex(bo), amount: '1' }), []);
  expect('a change applied', namedIn({ kind: 'id:change-applied', changeNo: 4 }), []);
  expect('not an id', namedIn({ kind: 'id:change-proposed', ops: [{ kind: 'addGuardian', guardian: 'ab' }] }), []);
}

/** The registry's records of `me`: one key, two slots, `guardians` linked, and `changes` waiting. */
function chain(guardians, changes = []) {
  const record = (kind, index) => hex(H('app/id-v1/record', Uint8Array.of(kind), me, index));
  const records = new Map();
  // op_nonce, change/recovery/key epochs, next key, keys, guardians, slots, threshold, delays, next change
  const core = [1n, 0n, 0n, 0n, 1n, 1n, BigInt(guardians.length), 2n, 0n, 604_800n, 172_800n, BigInt(changes.length)];
  records.set(hex(coreKey(me)), core.reduce((w, v) => w.u64(v), new Writer().u8(1)).finish());
  records.set(record(1, concat(u64(0n), u64(0n))), concat(new Uint8Array(32).fill(7), new Uint8Array(65).fill(4)));
  for (const g of guardians) records.set(record(2, g), Uint8Array.of(1));
  changes.forEach((ops, n) => records.set(record(4, u64(BigInt(n))),
    concat(new Writer().u64(0n).u64(0n).u64(1_000n).u64(2_000n).finish(), encodeChange(ops))));
  return {
    record: async (_, key) => records.get(hex(key)) ?? null,
    storage: async (reads) => reads.map(([, key]) => records.get(hex(key)) ?? null),
  };
}

const no = (change) => (change ? Number(change.changeNo) : null);
const rows = (l) => l.rows.map((r) => [r.guardian.slice(0, 2), r.linked, no(r.linking), no(r.unlinking)]);

// Linked on another device: this browser kept no guardian, and the history names Anna.
{
  const id = await readIdentity(chain([anna]), registry, me, [anna]);
  const l = listed(id, []);
  expect('found in the history', rows(l), [['02', true, null, null]]);
  expect('none unknown', l.unknown, 0);
  // Before the history is read, only the count says there is one.
  const before = listed(await readIdentity(chain([anna]), registry, me, []), []);
  expect('not read yet', [before.rows.length, before.unknown], [0, 1]);
}

// A node's event names Carl, whom the registry does not list: he is not shown, and Bo, linked
// when the identity was created and named nowhere since, is counted but cannot be named.
{
  const id = await readIdentity(chain([anna, bo]), registry, me, [anna, carl]);
  const l = listed(id, []);
  expect('only what the chain proves', rows(l), [['02', true, null, null]]);
  expect('one unknown', l.unknown, 1);
}

// Kept here first, then found, then linked by a waiting change; an unlinking shows on its guardian.
{
  const waiting = [[{ kind: 'addGuardian', guardian: dan }], [{ kind: 'removeGuardian', guardian: anna }]];
  const id = await readIdentity(chain([anna, bo], waiting), registry, me, [anna, bo]);
  const l = listed(id, [hex(bo), hex(carl)]);
  expect('order and states', rows(l), [
    ['03', true, null, null], // kept here, linked
    ['04', false, null, null], // kept here, not linked: its change was cancelled
    ['02', true, null, 1], // found, being unlinked by change #1
    ['05', false, 0, null], // linked once change #0 applies
  ]);
  expect('all known', l.unknown, 0);
}

// An identity not on chain yet has no guardians to show or count.
expect('not on chain', listed({ guardians: [], pending: [] }, []), { rows: [], unknown: 0 });

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log('guardians: all passed');

// The identity registry (Ting wiki: programs/identity), as Ting ID uses it:
// creating an identity, reading it, and its changes, which wait the change
// delay and which any of its keys can cancel meanwhile.
import { concat, framed, hex, Reader, u64, unhex, utf8, Writer } from '../../../kit/web/bytes.js';
import { H, policyAccount } from '../../../kit/web/ting.js';

export const DEFAULTS = {
  changeDelay: 604_800, // 7 days
  recoveryDelay: 172_800, // 2 days
  savingsDelay: 604_800, // 7 days
  threshold: 0, // more than half of the guardians
};

export const TOPICS = Object.fromEntries(
  ['created', 'change-proposed', 'change-cancelled', 'change-applied', 'recovery-approved', 'recovery-withdrawn', 'recovered']
    .map((name) => [name, H(`app/id-v1/event/${name}`)]),
);

/** `u64 count ‖ count × (policy(32) ‖ Bytes(params))` */
export function keyList(keys) {
  const w = new Writer().u64(keys.length);
  for (const k of keys) w.put(k.policy).bytes(k.params);
  return w.finish();
}

/**
 * The creation input after its op byte. Guardians are sorted, as the
 * registry requires; slot 0 is Spending, slot 1 Savings.
 */
export function creation({ keys, guardians = [], threshold = DEFAULTS.threshold, changeDelay = DEFAULTS.changeDelay,
  recoveryDelay = DEFAULTS.recoveryDelay, slots = [0, DEFAULTS.savingsDelay], salt = crypto.getRandomValues(new Uint8Array(32)) }) {
  const sorted = [...guardians].sort((a, b) => (hex(a) < hex(b) ? -1 : 1));
  const w = new Writer().u8(1).put(keyList(keys)).u64(sorted.length);
  for (const g of sorted) w.put(g);
  w.u64(threshold).u64(changeDelay).u64(recoveryDelay).u64(slots.length);
  for (const d of slots) w.u64(d);
  return w.put(salt).finish();
}

export const idOf = (creationBytes) => H('app/id-v1/id', creationBytes);
export const slotParams = (id, slot) => concat(id, u64(slot));
export const slotAccount = (registry, id, slot) => policyAccount(registry, slotParams(id, slot));

/** `H("app/id-v1/record", u8 kind ‖ id ‖ index)` */
const recordKey = (kind, id, index = new Uint8Array()) => H('app/id-v1/record', Uint8Array.of(kind), id, index);
export const coreKey = (id) => recordKey(0, id);
const keyKey = (id, epoch, keyId) => recordKey(1, id, concat(u64(epoch), u64(keyId)));
export const guardianKey = (id, guardian) => recordKey(2, id, guardian);
const slotKey = (id, slot) => recordKey(3, id, u64(slot));
const changeKey = (id, n) => recordKey(4, id, u64(n));

const CORE_FIELDS = ['opNonce', 'changeEpoch', 'recoveryEpoch', 'keyEpoch', 'nextKeyId', 'keyCount', 'guardianCount',
  'slotCount', 'threshold', 'changeDelay', 'recoveryDelay', 'nextChange'];

export function decodeCore(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== 1) throw new Error('an identity record of an unknown version');
  const core = {};
  for (const f of CORE_FIELDS) core[f] = r.u64();
  r.end();
  return core;
}

/** The operations of a change: `u64 count ‖ ops`. */
export function decodeChange(r) {
  const ops = [];
  for (let n = r.u64(); n > 0n; n--) {
    const kind = r.u8();
    if (kind === 1) {
      const policy = r.id();
      ops.push({ kind: 'addKey', policy, params: r.bytes() });
    } else if (kind === 2) ops.push({ kind: 'removeKey', keyId: r.u64() });
    else if (kind === 3) ops.push({ kind: 'addGuardian', guardian: r.id() });
    else if (kind === 4) ops.push({ kind: 'removeGuardian', guardian: r.id() });
    else if (kind === 5) ops.push({ kind: 'threshold', threshold: r.u64() });
    else if (kind === 6) ops.push({ kind: 'delays', changeDelay: r.u64(), recoveryDelay: r.u64() });
    else if (kind === 7) ops.push({ kind: 'slotDelay', slot: r.u64(), delay: r.u64() });
    else throw new Error('a change of an unknown kind');
  }
  return ops;
}

export function encodeChange(ops) {
  const w = new Writer().u64(ops.length);
  for (const op of ops) {
    if (op.kind === 'addKey') w.u8(1).put(op.policy).bytes(op.params);
    else if (op.kind === 'removeKey') w.u8(2).u64(op.keyId);
    else if (op.kind === 'addGuardian') w.u8(3).put(op.guardian);
    else if (op.kind === 'removeGuardian') w.u8(4).put(op.guardian);
    else if (op.kind === 'threshold') w.u8(5).u64(op.threshold);
    else if (op.kind === 'delays') w.u8(6).u64(op.changeDelay).u64(op.recoveryDelay);
    else if (op.kind === 'slotDelay') w.u8(7).u64(op.slot).u64(op.delay);
  }
  return w.finish();
}

/**
 * An identity as the chain holds it now, read with proofs: its core, its
 * current keys with their ids, its slots' delays, its newest changes, and
 * which of `guardians` (candidates the wallet knows) are linked.
 */
export async function readIdentity(pool, registry, id, guardians = []) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const coreBytes = await pool.record(registry, coreKey(id));
    if (!coreBytes) return null;
    const core = decodeCore(coreBytes);
    const keyIds = [];
    for (let k = 0n; k < core.nextKeyId; k++) keyIds.push(k);
    const slots = [];
    for (let s = 0n; s < core.slotCount; s++) slots.push(s);
    const changes = [];
    for (let c = core.nextChange - 1n; c >= 0n && changes.length < 40; c--) changes.push(c);
    const reads = [
      [registry, coreKey(id)],
      ...keyIds.map((k) => [registry, keyKey(id, core.keyEpoch, k)]),
      ...slots.map((s) => [registry, slotKey(id, s)]),
      ...changes.map((c) => [registry, changeKey(id, c)]),
      ...guardians.map((g) => [registry, guardianKey(id, g)]),
    ];
    const values = await pool.storage(reads);
    if (hex(values[0]) !== hex(coreBytes)) continue; // it changed meanwhile: read again
    let at = 1;
    const keys = [];
    for (const keyId of keyIds) {
      const v = values[at++];
      if (v) keys.push({ keyId, policy: v.subarray(0, 32), params: v.subarray(32) });
    }
    const slotDelays = slots.map(() => {
      const v = values[at++];
      return v ? new Reader(v).u64() : 0n;
    });
    const pending = [];
    for (const changeNo of changes) {
      const v = values[at++];
      if (!v) continue;
      const r = new Reader(v);
      const change = { changeNo, epoch: r.u64(), proposer: r.u64(), proposedAt: r.u64(), effectiveAt: r.u64() };
      change.ops = decodeChange(r);
      if (change.epoch === core.changeEpoch && keys.some((k) => k.keyId === change.proposer)) pending.push(change);
    }
    const linked = guardians.filter(() => Boolean(values[at++]));
    return { id, core, keys, slots: slotDelays, pending: pending.reverse(), guardians: linked };
  }
  throw new Error('The identity kept changing while it was read: try again.');
}

/** `Bytes("app/id-v1") ‖ ChainId ‖ registry ‖ id ‖ u64 key_id ‖ body` */
const message = (chain, registry, id, keyId, body) =>
  concat(framed(utf8('app/id-v1')), chain, registry, id, u64(keyId), body);

/** The input proposing `ops` as one change, signed by `signer` (a key of the identity). */
export async function proposeInput({ chain, registry, id, opNonce, signer, ops }) {
  const change = encodeChange(ops);
  const body = concat(Uint8Array.of(2), u64(opNonce), change);
  const witness = await signer.sign(message(chain, registry, id, signer.keyId, body));
  return concat(Uint8Array.of(2), id, u64(opNonce), u64(signer.keyId), framed(witness), change);
}

/** The input cancelling the changes `numbers`, signed by a key of the identity. */
export async function cancelInput({ chain, registry, id, signer, numbers }) {
  const sorted = [...numbers].sort((a, b) => (a < b ? -1 : 1));
  const list = new Writer().u64(sorted.length);
  for (const n of sorted) list.u64(n);
  const tail = list.finish();
  const witness = await signer.sign(message(chain, registry, id, signer.keyId, concat(Uint8Array.of(3), tail)));
  return concat(Uint8Array.of(3), id, u64(signer.keyId), framed(witness), tail);
}

/** Applies a due change: anyone may, unsigned. */
export const applyInput = (id, changeNo) => concat(Uint8Array.of(4), id, u64(changeNo));

/** Creates an identity: `01 ‖ creation`. */
export const createInput = (creationBytes) => concat(Uint8Array.of(1), creationBytes);

/**
 * The identities whose current keys include `key` ({policy, params}), found
 * from the registry's *created* events and checked by proved reads.
 */
export async function findByKey(pool, registry, keysWanted, onProgress) {
  const ids = [];
  let from = 1;
  for (;;) {
    const page = await pool.events(registry, from, TOPICS.created);
    for (const block of page.items) {
      for (const e of block.events) {
        const payload = unhex(e.payload_hex);
        ids.push({ id: payload.subarray(32, 64), height: block.height, time: block.timestamp });
      }
    }
    onProgress?.(Math.min(page.next, page.height), page.height);
    if (!page.items.length || page.next > page.height) break;
    from = page.next;
  }
  const wanted = new Set(keysWanted.map((k) => hex(k.policy) + hex(k.params)));
  const found = [];
  for (let i = 0; i < ids.length; i += 64) {
    const part = ids.slice(i, i + 64);
    const cores = await pool.storage(part.map((x) => [registry, coreKey(x.id)]));
    const reads = [];
    part.forEach((x, j) => {
      if (!cores[j]) return;
      const core = decodeCore(cores[j]);
      for (let k = 0n; k < core.nextKeyId; k++) reads.push({ x, read: [registry, keyKey(x.id, core.keyEpoch, k)] });
    });
    const values = reads.length ? await pool.storage(reads.map((r) => r.read)) : [];
    values.forEach((v, j) => {
      if (v && wanted.has(hex(v.subarray(0, 32)) + hex(v.subarray(32)))) {
        if (!found.some((f) => hex(f.id) === hex(reads[j].x.id))) found.push(reads[j].x);
      }
    });
  }
  return found;
}

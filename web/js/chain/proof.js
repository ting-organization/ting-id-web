// Checking what a node says against the chain itself (Ting wiki:
// data/state-tree, proofs; data/blocks, the header). A storage value counts
// only with a proof against the state root of a header whose hash is the tip,
// whose proof of work holds and whose chain is ours.
import { concat, equal, framed, hex, u16, unhex } from '../../../kit/web/bytes.js';
import { H } from '../../../kit/web/ting.js';

const EMPTY = H('state-empty');

/** Bit `d` of a 32-byte key, the most significant bit of its first byte being bit 0. */
const bit = (key, d) => (key[d >> 3] >> (7 - (d & 7))) & 1;

/**
 * Whether `value` (bytes, or null when absent) is what `contract` stores
 * under `key`, by the proof, in the state whose root is `root`. `others`
 * holds the values of other records a proof may end at, by key in hex.
 */
export function verifyRecord({ contract, key, value, proof, root, others }) {
  const recordKey = H('state-key', Uint8Array.of(2), contract, key);
  if (!proof || proof.record_key !== hex(recordKey)) return false;
  const siblings = (proof.siblings ?? []).map(unhex);
  const n = siblings.length;
  if (n > 256) return false;
  let h;
  if (proof.end === 'present') {
    if (value == null) return false;
    h = H('state-leaf', recordKey, framed(value));
  } else if (proof.end === 'empty') {
    if (value != null) return false;
    h = EMPTY;
  } else if (proof.end === 'other') {
    if (value != null || !proof.other_key || others?.[proof.other_key] == null) return false;
    const other = unhex(proof.other_key);
    if (equal(other, recordKey)) return false;
    for (let d = 0; d < n; d++) if (bit(other, d) !== bit(recordKey, d)) return false;
    h = H('state-leaf', other, framed(unhex(others[proof.other_key])));
  } else {
    return false;
  }
  for (let d = n - 1, i = 0; d >= 0; d--, i++) {
    h = bit(recordKey, d) === 0 ? H('state-node', u16(d), h, siblings[i]) : H('state-node', u16(d), siblings[i], h);
  }
  return equal(h, root);
}

export const HEADER_BYTES = 294;

/** The fields of a block header that a reader checks (Ting wiki: data/blocks). */
export function readHeader(header) {
  const at = (offset, length) => header.subarray(offset, offset + length);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  return {
    version: view.getUint16(0, true),
    chainId: at(2, 32),
    height: view.getBigUint64(34, true),
    timestamp: view.getBigUint64(74, true),
    target: at(82, 32),
    stateRoot: at(178, 32),
  };
}

/** Big-endian comparison of two 32-byte numbers. */
function compare(a, b) {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

/**
 * Checks a header against the tip it should be: its hash is `tip`, it is
 * version 1 on our chain, its work holds (the id is at most the target, which
 * is not zero and no easier than the network allows). Returns the header's
 * fields, or throws.
 */
export function checkHeader(header, tip, net) {
  if (header.length !== HEADER_BYTES) throw new Error('a node sent a header of the wrong size');
  if (!equal(H('block', header), tip)) throw new Error('a node sent a header that is not its tip');
  const h = readHeader(header);
  if (h.version !== 1) throw new Error('a node sent a header of an unknown version');
  if (hex(h.chainId) !== net.chainId) throw new Error('a node follows another chain');
  if (h.target.every((b) => b === 0) || compare(tip, h.target) > 0) throw new Error('a node sent a header without its proof of work');
  if (net.powLimit && compare(h.target, unhex(net.powLimit)) > 0) throw new Error('a node sent a header easier than the network allows');
  return h;
}

export { concat };

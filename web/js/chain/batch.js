// The reference batch program (Ting wiki: programs/batch): calls in one
// transaction, in order, all or none. A payment in a batch is bound to it and
// to the calls before it, so it pays for exactly those calls and cannot be
// taken out and sent alone.
import { concat, framed } from '../../../kit/web/bytes.js';
import { H } from '../../../kit/web/ting.js';

/** `call*`, each `target(32) ‖ Bytes(input)`. */
export const batchInput = (calls) => concat(...calls.map((c) => concat(c.target, framed(c.input))));

/**
 * What the batch vouches for while it makes call `calls.length`: the prefix
 * of the calls before it, `H("app/batch/prefix", prefix ‖ target ‖ Bytes(input))`
 * from `H("app/batch/prefix", "")`.
 */
export function prefixAfter(calls) {
  let prefix = H('app/batch/prefix');
  for (const c of calls) prefix = H('app/batch/prefix', prefix, c.target, framed(c.input));
  return prefix;
}

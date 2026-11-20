// The guardians the wallet can show for an identity. The registry keeps each
// guardian in a record of its own, under a key hashed from the identity and
// the guardian's ID, and only counts them in the core record: a wallet can ask
// whether an ID it names is a guardian, but cannot list them. So the wallet
// names the guardians it knows of, linked from this browser or named in the
// identity's history (its changes and recovery approvals, which the activity
// scan reads), and the chain says, with proofs, which of them are linked now.
// What the history names is only a hint: a node's events carry no proof.
import { hex } from '../../../kit/web/bytes.js';

/** The guardians (hex) an activity item names: in a change linking or unlinking one, or in a recovery approval or withdrawal. */
export function namedIn(item) {
  const out = (item.ops ?? []).filter((op) => op.kind === 'addGuardian' || op.kind === 'removeGuardian').map((op) => op.guardian);
  if (item.kind === 'id:recovery-approved' || item.kind === 'id:recovery-withdrawn') out.push(item.guardian);
  return out.filter((g) => /^[0-9a-f]{64}$/.test(g ?? ''));
}

/**
 * The guardians to show for identity `id`, as readIdentity reads it: those
 * linked from this browser (`kept`, hex) first, then the others the chain
 * says are linked, then those a waiting change links. Each row has the
 * guardian, whether it is linked, and the waiting change that links or
 * unlinks it, if any. `unknown`: how many linked guardians are none of them.
 */
export function listed(id, kept = []) {
  const linked = new Set(id.guardians.map(hex));
  const waiting = (kind, g) => id.pending.find((c) => c.ops.some((op) => op.kind === kind && hex(op.guardian) === g)) ?? null;
  const linking = id.pending.flatMap((c) => c.ops).filter((op) => op.kind === 'addGuardian').map((op) => hex(op.guardian));
  const rows = [...new Set([...kept, ...linked, ...linking])].map((guardian) => {
    const on = linked.has(guardian);
    return { guardian, linked: on, linking: on ? null : waiting('addGuardian', guardian), unlinking: on ? waiting('removeGuardian', guardian) : null };
  });
  return { rows, unknown: id.core ? Math.max(0, Number(id.core.guardianCount) - linked.size) : 0 };
}

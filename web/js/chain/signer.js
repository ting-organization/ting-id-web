// This device's passkey, as a signer for an identity: for one of its slots
// (an account) or for the identity's own changes. What the passkey signs is
// Ting's signing digest of the message; the registry hands the witness to
// policy-webauthn, the key's policy.
import { concat, framed, u64, unhex } from '../../../kit/web/bytes.js';
import { H, policyAccount } from '../../../kit/web/ting.js';
import * as passkey from '../passkey.js';
import * as phrase from '../phrase.js';
import { slotParams } from './registry.js';

/** The passkey's witness for `message`, after the user approves. */
async function passkeyWitness(message, credentialId) {
  const signed = await passkey.sign(H('app/sign-v1', message), credentialId);
  return passkey.witness(signed);
}

/**
 * `{ keyId, sign(message) }` for registry operations, and `slot(n)` for
 * accounts: `{ policy, params, account, witness(message) }`, the shape the
 * coin and TCR-1 code expect.
 */
export function identitySigner({ registry, id, keyId, credentialId }) {
  const credential = credentialId ? unhex(credentialId) : undefined;
  const auth = async (message) => concat(u64(keyId), framed(await passkeyWitness(message, credential)));
  return {
    keyId,
    /** For the registry: the key's own witness; the registry adds the key id. */
    sign: (message) => passkeyWitness(message, credential),
    slot(n) {
      const params = slotParams(id, n);
      return { policy: registry, params, account: policyAccount(registry, params), witness: auth };
    },
  };
}

/**
 * A recovery phrase's key, key `keyId` of an identity, as a signer of one
 * registry operation: its witness is `r ‖ s` over Ting's signing digest, as
 * policy-secp256k1 reads it. The wallet makes one only while a restore signs
 * its change, and never for an account: the phrase moves no coins here.
 */
export function phraseSigner({ secret, keyId }) {
  return { keyId, sign: (message) => phrase.sign(secret, H('app/sign-v1', message)) };
}

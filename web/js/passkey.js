// Passkeys (WebAuthn) as keys of a Ting identity, through the policy-webauthn
// program. A passkey signs Ting's signing digest as its challenge; what it
// actually signs is its authenticator data and a hash of the client data JSON
// that holds the challenge, and the policy checks exactly that:
//
//   witness = Bytes(authenticatorData) ‖ Bytes(clientDataJSON) ‖ r(32) ‖ s(32)
//
// The private key never reaches this page.
import { concat, framed, utf8 } from '../../kit/web/bytes.js';
import { sha256 } from '../../kit/web/sha256.js';
import { fromBig, N, recover, toBig, verify } from './p256.js';

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const bytesOf = (buffer) => new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));

/** Whether this browser can use passkeys at all. */
export const available = () => Boolean(window.PublicKeyCredential && navigator.credentials?.create);

/** The authenticator: the browser's, or on localhost with `?authenticator=software`, a stand-in for tests. */
function authenticator() {
  return window.__tingSoftwareAuthenticator ?? navigator.credentials;
}

/**
 * Creates a passkey for this site. `handle` (at most 64 bytes) travels with
 * it to every device it syncs to, and comes back with each signature. Returns
 * its credential id and its public key, 65 bytes uncompressed.
 */
export async function create({ name, handle }) {
  const credential = await authenticator().create({
    publicKey: {
      rp: { name: 'Ting ID Web' },
      user: { id: handle, name, displayName: name },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: 120_000,
    },
  });
  if (!credential) throw new Error('No passkey was made.');
  const spki = bytesOf(credential.response.getPublicKey());
  if (credential.response.getPublicKeyAlgorithm() !== -7 || spki.length < 65) {
    throw new Error('This authenticator made a key Ting cannot use: it needs P-256.');
  }
  const publicKey = spki.slice(spki.length - 65);
  if (publicKey[0] !== 4) throw new Error('Unexpected public key encoding.');
  return { credentialId: bytesOf(credential.rawId), publicKey };
}

/** `r` and `s` of a DER-encoded ECDSA signature, with `s` in its low form, as policies require. */
export function fromDer(der) {
  let at = 0;
  const expect = (byte) => {
    if (der[at++] !== byte) throw new Error('Malformed signature.');
  };
  const integer = () => {
    expect(0x02);
    const length = der[at++];
    const value = toBig(der.subarray(at, at + length));
    at += length;
    return value;
  };
  expect(0x30);
  at++;
  const r = integer();
  let s = integer();
  if (s > N / 2n) s = N - s;
  return { r, s };
}

const PREFIX = utf8('{"type":"webauthn.get","challenge":"');

/**
 * Asks a passkey to sign `digest`, Ting's 32-byte signing digest: the one
 * with `credentialId`, or any of this site's when none is given. Returns the
 * witness parts, the passkey's id and handle, and its possible public keys.
 */
export async function sign(digest, credentialId) {
  const assertion = await authenticator().get({
    publicKey: {
      challenge: digest,
      allowCredentials: credentialId ? [{ type: 'public-key', id: credentialId }] : [],
      userVerification: 'required',
      timeout: 120_000,
    },
  });
  if (!assertion) throw new Error('The passkey did not sign.');
  const authenticatorData = bytesOf(assertion.response.authenticatorData);
  const clientDataJSON = bytesOf(assertion.response.clientDataJSON);
  const expected = concat(PREFIX, utf8(b64url(digest)), utf8('"'));
  const next = clientDataJSON[expected.length];
  if (!expected.every((b, i) => clientDataJSON[i] === b) || (next !== 0x2c && next !== 0x7d)) {
    throw new Error('This authenticator answers in a form the Ting policy does not accept.');
  }
  if ((authenticatorData[32] & 0x05) !== 0x05) throw new Error('The passkey signed without verifying you.');
  const { r, s } = fromDer(bytesOf(assertion.response.signature));
  const hash = sha256(concat(authenticatorData, sha256(clientDataJSON)));
  return {
    authenticatorData,
    clientDataJSON,
    r,
    s,
    credentialId: bytesOf(assertion.rawId),
    handle: assertion.response.userHandle ? bytesOf(assertion.response.userHandle) : null,
    /** The public keys that could have made this signature: the passkey's is one of them. */
    keys: () => recover(hash, r, s),
    /** Whether `key` made it. */
    by: (key) => verify(key, hash, r, s),
  };
}

/** The witness policy-webauthn checks. */
export const witness = (signed) =>
  concat(framed(signed.authenticatorData), framed(signed.clientDataJSON), fromBig(signed.r), fromBig(signed.s));

// A stand-in passkey authenticator, for development and automated tests only:
// it answers navigator.credentials.create and .get as a platform
// authenticator does (SPKI public keys, DER signatures, authenticator data
// with UP and UV set), with P-256 keys kept in this browser's storage.
//
// It turns itself on only on localhost with ?authenticator=software. Real
// passkeys never use it.
import { concat, utf8 } from '../../kit/web/bytes.js';
import { sha256 } from '../../kit/web/sha256.js';

const STORE = 'ting-id-web/dev-authenticator';
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const load = () => JSON.parse(localStorage.getItem(STORE) || '[]');
const save = (list) => localStorage.setItem(STORE, JSON.stringify(list));

/** DER `SEQUENCE { INTEGER r, INTEGER s }` from WebCrypto's raw `r ‖ s`. */
function der(raw) {
  const integer = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let v = bytes.subarray(i);
    if (v[0] & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(2, v.length), v);
  };
  const body = concat(integer(raw.subarray(0, 32)), integer(raw.subarray(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

const authenticatorData = () => concat(sha256(utf8(location.hostname)), Uint8Array.of(0x05), new Uint8Array(4));

const software = {
  async create({ publicKey: options }) {
    const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    const id = crypto.getRandomValues(new Uint8Array(16));
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    const list = load();
    list.push({
      id: b64url(id),
      handle: b64url(new Uint8Array(options.user.id)),
      name: options.user.name,
      jwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    });
    save(list);
    return {
      rawId: id.buffer,
      response: { getPublicKey: () => spki.buffer, getPublicKeyAlgorithm: () => -7 },
    };
  },

  async get({ publicKey: options }) {
    const allowed = (options.allowCredentials ?? []).map((c) => b64url(new Uint8Array(c.id)));
    const entry = load().filter((e) => !allowed.length || allowed.includes(e.id)).at(-1);
    if (!entry) throw new DOMException('No passkey for this site.', 'NotAllowedError');
    const key = await crypto.subtle.importKey('jwk', entry.jwk, ALGORITHM, false, ['sign']);
    const data = authenticatorData();
    const clientDataJSON = utf8(JSON.stringify({
      type: 'webauthn.get',
      challenge: b64url(new Uint8Array(options.challenge)),
      origin: location.origin,
      crossOrigin: false,
    }));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, concat(data, sha256(clientDataJSON))));
    return {
      rawId: unb64(entry.id).buffer,
      response: {
        authenticatorData: data.buffer,
        clientDataJSON: clientDataJSON.buffer,
        signature: der(raw).buffer,
        userHandle: unb64(entry.handle).buffer,
      },
    };
  },
};

const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
if (local && new URLSearchParams(location.search).get('authenticator') === 'software') {
  window.__tingSoftwareAuthenticator = software;
}

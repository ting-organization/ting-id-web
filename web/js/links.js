// Ting links (Ting ID's LINKS.md) as this wallet reads and writes them:
//
//   ting:<request>?<field>=<value>&…
//
// Text is percent-encoded, `+` reads as a space, the request and field names
// are read without regard to case, and a field given twice is refused.
//
// A device or guardian link asks to let someone in: a device key, or another
// identity that can help recover this one. As in Ting ID, those open only when
// scanned or pasted in the wallet. Opened as an address, from a message or
// another page, they could lead someone into letting a stranger in. A scanned
// or pasted one is held here, in memory, for the screen it opens.

/** Requests that open only from inside the wallet. */
export const INSIDE_ONLY = new Set(['device', 'guardian', 'recover']);

/** The longest name a link carries. */
export const TEXT_MAX = 80;

/** Controls, line breaks, marks that turn text around, invisible ones: any could make a name read as another. */
const HIDING = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/** The request a Ting link makes, in lower case; null when `text` is no Ting link. */
export function requestOf(text) {
  return /^\s*ting:(?:\/\/)?([a-z]+)/i.exec(String(text))?.[1].toLowerCase() ?? null;
}

/** The request and fields of a Ting link; throws, saying why, when `text` is none. */
export function readLink(text) {
  const request = requestOf(text);
  if (!request) throw new Error('This is not a Ting link');
  const t = String(text).trim();
  const q = t.indexOf('?');
  const fields = {};
  for (const part of q < 0 ? [] : t.slice(q + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = (eq < 0 ? part : part.slice(0, eq)).toLowerCase();
    let value;
    try {
      value = decodeURIComponent((eq < 0 ? '' : part.slice(eq + 1)).replace(/\+/g, ' '));
    } catch {
      throw new Error(`The link’s ${key} is not written right`);
    }
    if (Object.hasOwn(fields, key)) throw new Error(`The link gives ${key} twice`);
    fields[key] = value;
  }
  return { request, fields };
}

/** `text` as a link's name: trimmed, not too long, with nothing that hides; else null. */
export function linkText(text) {
  const t = String(text ?? '').trim();
  return t && t.length <= TEXT_MAX && !HIDING.test(t) ? t : null;
}

/**
 * The identity a guardian code names, `{ id, name }` (id in lowercase hex,
 * name null when the code gives none): a `ting:guardian` link for network
 * `net`, or an identity ID on its own. Throws, saying why, for anything else.
 */
export function guardianCode(text, net) {
  const t = String(text).trim();
  const bare = t.replace(/\s+/g, '');
  if (/^[0-9a-f]{64}$/i.test(bare)) return { id: bare.toLowerCase(), name: null };
  const { request, fields } = readLink(t);
  if (request !== 'guardian') throw new Error(`This is a ${request} link, not a guardian code`);
  if (!/^[0-9a-f]{8}$/i.test(fields.net ?? '')) throw new Error('The code has no network');
  if (fields.net.toLowerCase() !== net) throw new Error('This code is for another Ting network');
  if (!/^[0-9a-f]{64}$/i.test(fields.id ?? '')) throw new Error('The code’s identity ID is not 64 hex digits');
  let name = null;
  if (fields.name) {
    if (fields.name.length > TEXT_MAX) throw new Error(`The code’s name is longer than ${TEXT_MAX} characters`);
    if (HIDING.test(fields.name)) throw new Error('The code’s name holds characters that could hide or reorder what it says');
    name = fields.name.trim() || null;
  }
  return { id: fields.id.toLowerCase(), name };
}

/** `ting:guardian?id=…&name=…&net=…`: scanned in Ting ID or here, it links `id` as the scanner's guardian. */
export function guardianLink(net, id, name) {
  const n = linkText(name);
  return `ting:guardian?id=${id}${n ? `&name=${encodeURIComponent(n)}` : ''}&net=${net}`;
}

/** Bytes as base64url without padding (RFC 4648 §5), as links carry longer bytes. */
export function base64url(bytes) {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url back to bytes: unpadded, with no bits left over, or it throws. */
export function fromBase64url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('not base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  if (base64url(bytes) !== text) throw new Error('base64url with bits left over');
  return bytes;
}

/** The fields of a `request` link for network `net`, or it throws, saying why. */
function fieldsOf(text, request, net) {
  const { request: made, fields } = readLink(text);
  if (made !== request) throw new Error(`This is a ${made} link, not a ${request} link`);
  if (!/^[0-9a-f]{8}$/i.test(fields.net ?? '')) throw new Error('The link has no network');
  if (fields.net.toLowerCase() !== net) throw new Error('This link is for another Ting network');
  return fields;
}

function longBytes(fields, name) {
  try {
    return fromBase64url(fields[name] ?? '');
  } catch {
    throw new Error(`The link’s ${name} is not written right`);
  }
}

/** `ting:recover?id=…&keys=…&net=…`: a guardian who scans it in the wallet approves the recovery of `id` to `keys`. */
export const recoverLink = (net, id, keyListBytes) => `ting:recover?id=${id}&keys=${base64url(keyListBytes)}&net=${net}`;

/** A recover link's `{ id, keys }`: the identity in lowercase hex, the key list as bytes. */
export function readRecoverLink(text, net) {
  const fields = fieldsOf(text, 'recover', net);
  if (!/^[0-9a-f]{64}$/i.test(fields.id ?? '')) throw new Error('The link’s identity ID is not 64 hex digits');
  return { id: fields.id.toLowerCase(), keys: longBytes(fields, 'keys') };
}

/**
 * `ting:create?input=…&name=…&net=…`: whoever opens it sends the identity
 * whose creation input is `input` its first coins, and creates it first when
 * no block has yet.
 */
export function createLink(net, input, name) {
  const n = linkText(name);
  return `ting:create?input=${base64url(input)}${n ? `&name=${encodeURIComponent(n)}` : ''}&net=${net}`;
}

/** A create link's `{ input, name, coin, amount }`: the creation input as bytes, the rest as given or null. */
export function readCreateLink(text, net) {
  const fields = fieldsOf(text, 'create', net);
  const input = longBytes(fields, 'input');
  let name = null;
  if (fields.name) {
    name = linkText(fields.name);
    if (!name) throw new Error('The link’s name is too long, or holds characters that could hide what it says');
  }
  if (fields.coin && !/^[0-9a-f]{64}$/i.test(fields.coin)) throw new Error('The link’s coin is not 64 hex digits');
  // An amount with a dot, `12.5`: `1,5` or `1,000` could mean two things.
  if (fields.amount && !/^\d+(\.\d+)?$/.test(fields.amount)) throw new Error('The link’s amount is not written as links write one, like 12.5');
  return { input, name, coin: fields.coin?.toLowerCase() ?? null, amount: fields.amount ?? null };
}

let held = null;

/** Keeps a link scanned or pasted in the wallet for the screen it opens; null forgets it. */
export function hold(link) {
  held = link;
}

/** The link last scanned or pasted in the wallet, when it makes `request`. */
export function heldLink(request) {
  return held && requestOf(held) === request ? held : null;
}

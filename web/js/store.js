// What the wallet keeps in this browser: public things only. The identity's
// id and how to find this device's passkey in it, contacts, coins and the
// node. No key: the passkey holds that, and the chain holds the identity.
const KEY = 'ting-id-web/v1';

const empty = () => ({
  /** The network in use: `production` or `development`. */
  network: null,
  /** Node addresses chosen per network, when not the defaults. */
  nodes: {},
  /**
   * Per network, this browser's identity: `{ id, name, publicKey,
   * credentialId, createdHeight, guardians, coins }`, all public.
   */
  identities: {},
  /** Whether any identity is kept: the tabs open only with one. */
  identity: false,
  contacts: [],
  /** Transactions this browser sent, until a block settles them. */
  pending: [],
  /** Activity read so far, per network and identity. */
  scans: {},
  theme: 'system',
});

let state = load();

function load() {
  try {
    return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return empty();
  }
}

export const get = () => state;

export function set(patch) {
  state = { ...state, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // private browsing without storage: the wallet still works for this visit
  }
  return state;
}

export function forget() {
  state = empty();
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing kept
  }
}

export const contactOf = (accountHex) => state.contacts.find((c) => c.account === accountHex) ?? null;

/** A name for an account: a contact's, or this identity's own account. */
export function nameOf(accountHex, own = []) {
  const slot = own.indexOf(accountHex);
  if (slot === 0) return 'Your Spending';
  if (slot === 1) return 'Your Savings';
  if (slot > 1) return `Your account ${slot + 1}`;
  return contactOf(accountHex)?.name ?? null;
}

/** A contact that is an identity, by its ID (hex). */
export const contactOfIdentity = (idHex) => state.contacts.find((c) => c.identity === idHex) ?? null;

/** Saves a name for `accountHex`; `identityHex` when the account is an identity's Spending, which keeps that too. */
export function saveContact(name, accountHex, identityHex = contactOf(accountHex)?.identity) {
  const contacts = state.contacts.filter((c) => c.account !== accountHex);
  contacts.push({ name: name.trim(), account: accountHex, ...(identityHex ? { identity: identityHex } : {}) });
  contacts.sort((a, b) => a.name.localeCompare(b.name));
  set({ contacts });
}

export function removeContact(accountHex) {
  set({ contacts: state.contacts.filter((c) => c.account !== accountHex) });
}

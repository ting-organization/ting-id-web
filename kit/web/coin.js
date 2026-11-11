// Coins of the coin reference program (Ting wiki: programs/coin): their
// records, payment effects and amounts. Daler (DLR) is one; anyone can deploy
// another and call it anything, so a page trusts a contract as a coin only
// when its CodeHash is the coin program's.
import { concat, fromUtf8, Reader, u128 } from './bytes.js';

/** The CodeHash of the coin reference program. */
export const CODE_HASH = 'c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6';

/** A coin keeps its name, symbol and decimals under the all-zero key. */
export const CONFIG_KEY = new Uint8Array(32);

/** `{ name, symbol, decimals }` from a coin's configuration record. */
export function decodeCoin(bytes) {
  const r = new Reader(bytes);
  r.u8();
  const name = fromUtf8(r.bytes()), symbol = fromUtf8(r.bytes()), decimals = r.u8();
  return { name, symbol, decimals };
}

/**
 * An account's record in a coin, which the coin keys by the account itself:
 * `balance u128 ‖ locked u128 ‖ nonce u64`; absent is all zero.
 */
export function decodeCoinAccount(bytes) {
  if (!bytes) return { balance: 0n, locked: 0n, nonce: 0n, available: 0n };
  const r = new Reader(bytes);
  const balance = r.u128(), locked = r.u128(), nonce = r.u64();
  return { balance, locked, nonce, available: balance - locked };
}

export const burnEffect = (amount) => concat(Uint8Array.of(2), u128(amount));
export const transferEffect = (to, amount) => concat(Uint8Array.of(1), to, u128(amount));

/** `1234500000n, 8` → `"12.345"`, grouped with commas. */
export function formatAmount(amount, decimals, maxFraction = decimals) {
  const negative = amount < 0n;
  const v = negative ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const fraction = (v % unit).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  const text = whole.toLocaleString('en-US') + (fraction ? '.' + fraction : '');
  return (negative ? '−' : '') + text;
}

/** An amount as a call link writes it: decimal with a dot, no grouping. */
export const linkAmount = (amount, decimals) => formatAmount(amount, decimals).replace(/,/g, '');

/** Base units of a decimal amount such as `12.5`, or null. */
export function parseAmount(text, decimals) {
  const m = String(text).trim().replace(/[,_\s]/g, '').match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (m[1] === '' && !m[2])) return null;
  if ((m[2] ?? '').length > decimals) return null;
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}

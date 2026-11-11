// Coins of the coin reference program (Ting wiki: programs/coin), as Ting ID
// moves them: transfers from Spending at once, from Savings scheduled for
// when its lock ends, and the scheduled ones cancelled or run.
import { concat, framed, fromUtf8, Reader, u64, utf8, Writer } from '../../../kit/web/bytes.js';
import { H } from '../../../kit/web/ting.js';

export const CODE_HASH = 'c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6';
export const CONFIG_KEY = new Uint8Array(32);

export const TOPICS = {
  transfer: H('app/coin-v1/event/transfer'),
  scheduled: H('app/coin-v1/event/scheduled'),
  executed: H('app/coin-v1/event/executed'),
  cancelled: H('app/coin-v1/event/cancelled'),
};

/** `u8 1 ‖ Bytes(name) ‖ Bytes(symbol) ‖ u8 decimals ‖ …` */
export function decodeConfig(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== 1) throw new Error('a coin of an unknown version');
  const clean = (text) => text.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '�');
  return { name: clean(fromUtf8(r.bytes())), symbol: clean(fromUtf8(r.bytes())), decimals: r.u8() };
}

/** `u128 balance ‖ u128 locked ‖ u64 nonce`; absent is all zero. */
export function decodeAccount(bytes) {
  if (!bytes) return { balance: 0n, locked: 0n, nonce: 0n, available: 0n };
  const r = new Reader(bytes);
  const balance = r.u128(), locked = r.u128(), nonce = r.u64();
  return { balance, locked, nonce, available: balance - locked };
}

export const scheduledKey = (account, sequence) => H('app/coin-v1/scheduled', account, u64(sequence));

/** `u64 execute_at ‖ u128 reserved ‖ u128 tip ‖ effect` */
export function decodeScheduled(bytes) {
  const r = new Reader(bytes);
  const executeAt = r.u64(), reserved = r.u128(), tip = r.u128();
  const kind = r.u8();
  const effect = kind === 1 ? { kind: 'transfer', to: r.id(), amount: r.u128() }
    : kind === 2 ? { kind: 'burn', amount: r.u128() } : { kind: 'other' };
  return { executeAt, reserved, tip, effect };
}

export const transferEffect = (to, amount) => new Writer().u8(1).put(to).u128(amount).finish();

/** The end of the next UTC day, as Ting ID dates what it signs. */
export const signedExpiry = () => BigInt((Math.floor(Date.now() / 86_400_000) + 2) * 86_400);

/**
 * A coin action of an identity's slot, signed by its passkey: `10 ‖ 00 ‖
 * policy ‖ Bytes(params) ‖ u64 nonce ‖ Bytes(witness) ‖ action`.
 */
export async function actionInput({ chain, coin, signer, nonce, effect, fee = 0n, tip = 0n, notBefore = 0n, validUntil = signedExpiry() }) {
  const action = new Writer().put(effect).u128(fee).u128(tip).u64(notBefore).u64(validUntil).u8(0).finish();
  const message = new Writer().bytes(utf8('app/coin-v1')).put(chain).put(coin).put(signer.account)
    .u8(0x10).u64(nonce).put(action).finish();
  const witness = await signer.witness(message);
  return new Writer().u8(0x10).u8(0).put(signer.policy).bytes(signer.params).u64(nonce).bytes(witness).put(action).finish();
}

/** Cancels scheduled actions of the signer's account: `11 ‖ 00 ‖ policy ‖ Bytes(params) ‖ Bytes(witness) ‖ cancel`. */
export async function cancelInput({ chain, coin, signer, sequences, fee = 0n, validUntil = signedExpiry() }) {
  const sorted = [...sequences].sort((a, b) => (a < b ? -1 : 1));
  const w = new Writer().u64(sorted.length);
  for (const s of sorted) w.u64(s);
  const cancel = w.u128(fee).u64(validUntil).finish();
  const message = new Writer().bytes(utf8('app/coin-v1')).put(chain).put(coin).put(signer.account).u8(0x11).put(cancel).finish();
  const witness = await signer.witness(message);
  return new Writer().u8(0x11).u8(0).put(signer.policy).bytes(signer.params).bytes(witness).put(cancel).finish();
}

/** Runs a due scheduled action: `04 ‖ account ‖ u64 sequence`, anyone, unsigned. */
export const runInput = (account, sequence) => concat(Uint8Array.of(4), account, u64(sequence));

/**
 * The scheduled actions of `account`, newest first: read downward from its
 * nonce until what they reserve adds up to what the account has locked.
 */
export async function readScheduled(pool, coin, account, record) {
  const out = [];
  if (!record.locked) return out;
  let reserved = 0n;
  let s = record.nonce - 1n;
  for (let round = 0; round < 16 && s >= 0n && reserved < record.locked; round++) {
    const batch = [];
    for (let i = 0; i < (round ? 256 : 32) && s >= 0n; i++, s--) batch.push(s);
    const values = await pool.storage(batch.map((seq) => [coin, scheduledKey(account, seq)]));
    values.forEach((v, i) => {
      if (!v) return;
      const item = { sequence: batch[i], ...decodeScheduled(v) };
      reserved += item.reserved;
      out.push(item);
    });
  }
  return out;
}

export { framed };

#!/usr/bin/env node
// A development chain of your own: a private chain with an easy target, in
// dev/, on ports of its own beside any other node, mining a block every few
// seconds.
//
//   node kit/scripts/devchain.mjs start   creates dev/ the first time, starts
//                                         the node and its miner
//   node kit/scripts/devchain.mjs setup   deploys the reference P-256 policy,
//                                         the identity registry and a test coin,
//                                         DLR, whose supply goes to a faucet
//   node kit/scripts/devchain.mjs fund <account> <amount>
//                                         sends test DLR from the faucet
//   node kit/scripts/devchain.mjs stop    stops the node
//
// The ids and the faucet's key are kept in .devchain.json. `ting` must be on
// your PATH: the node of the Ting repository (cargo install --path node).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { equal, utf8, Writer } from '../web/bytes.js';
import { parseAmount } from '../web/coin.js';
import { Key } from '../web/keys.js';
import { Chain, DEVELOPMENT, hex, read, unhex } from './chain.mjs';

export const PORTS = { control: 28450, api: 28451, p2p: 28452 };
export const NODE_URL = `http://127.0.0.1:${PORTS.api}`;
const DATA_DIR = new URL('../../dev', import.meta.url).pathname;
export const STATE = new URL('../../.devchain.json', import.meta.url).pathname;
const DLR = 100_000_000n;

/** Runs `ting` on dev/ only, never on another data directory. */
const ting = (...args) => execFileSync('ting', ['--data-dir', DATA_DIR, ...args], { stdio: 'inherit' });

export function loadState() {
  if (!existsSync(STATE)) throw new Error('no .devchain.json: run `node kit/scripts/devchain.mjs setup` first');
  return JSON.parse(readFileSync(STATE, 'utf8'));
}

export function saveState(state) {
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
}

async function start() {
  if (!existsSync(DATA_DIR)) {
    ting('init', '--dev', '--name', 'devkit', '--api',
      '--control', `127.0.0.1:${PORTS.control}`, '--p2p', `127.0.0.1:${PORTS.p2p}`, '--api-bind', `127.0.0.1:${PORTS.api}`);
    ting('api', 'enable', '--cors');
  }
  ting('start');
  ting('miner', 'start', '--spacing', '2');
  console.log(`\nThe development chain answers at ${NODE_URL}; its explorer is at ${NODE_URL}/`);
}

async function open() {
  const chain = await Chain.open(NODE_URL);
  if (chain.chainHex !== DEVELOPMENT) throw new Error(`${NODE_URL} is not on the development chain`);
  return chain;
}

async function setup() {
  const chain = await open();
  const policy = await chain.deploy(read('kit/programs/policy-p256.wasm'), new Uint8Array());
  if (!equal(policy, chain.policy)) throw new Error('policy-p256 is not at its canonical deployment');
  console.log(`policy-p256  ${hex(policy)}`);
  const registry = await chain.deploy(read('kit/programs/id-registry.wasm'), new Uint8Array());
  console.log(`id-registry  ${hex(registry)}`);
  const faucet = existsSync(STATE) ? await Key.fromJwk(loadState().faucet) : await Key.generate();
  const coinInput = new Writer().u8(1).bytes(utf8('Daler')).bytes(utf8('DLR')).u8(8)
    .u128((1n << 128n) - 1n).u128(0n).u64(0n).u128(0n).put(new Uint8Array(32)) // no cap, rewards or minter
    .u64(1).put(faucet.account(chain.policy)).u128(1_000_000n * DLR).finish();
  const coin = await chain.deploy(read('kit/programs/coin.wasm'), coinInput, [50_000_000, 66, 16_777_216, 16_777_216]);
  console.log(`coin         ${hex(coin)}   (test DLR, 1,000,000 to the faucet)`);
  const state = existsSync(STATE) ? loadState() : {};
  saveState({ ...state, coin: hex(coin), registry: hex(registry), faucet: faucet.jwk });
}

async function fund(accountHex, amountText) {
  if (!/^[0-9a-f]{64}$/.test(accountHex ?? '')) throw new Error('usage: fund <account, 64 hex digits> <amount>');
  const amount = parseAmount(amountText ?? '', 8);
  if (!amount) throw new Error('usage: fund <account> <amount, such as 5 or 0.25>');
  const chain = await open();
  const state = loadState();
  const faucet = (await Key.fromJwk(state.faucet)).signer(chain.policy);
  const r = await chain.transfer(faucet, unhex(state.coin), unhex(accountHex), amount);
  if (r.status !== 0) throw new Error(`transfer failed: ${r.reason}`);
  console.log(`sent ${amountText} DLR to ${accountHex} in block ${r.height}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { start, setup, fund: () => fund(...rest), stop: async () => ting('stop') };
  if (!commands[command]) {
    console.error('usage: node kit/scripts/devchain.mjs start | setup | fund <account> <amount> | stop');
    process.exit(2);
  }
  await commands[command]();
}

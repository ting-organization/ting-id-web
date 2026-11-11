#!/usr/bin/env node
// Readies the development chain for the wallet: deploys program.wasm, the
// policy-webauthn program, and writes web/dev-chain.json, which the wallet
// reads when it runs against the development chain: the chain, the node, the
// identity registry, the policy and the test coin.
//
//   node kit/scripts/devchain.mjs start && node kit/scripts/devchain.mjs setup
//   ./build.sh && node scripts/dev.mjs
//   node kit/scripts/devchain.mjs fund <account> <amount>
import { writeFileSync } from 'node:fs';
import { hex } from '../kit/web/bytes.js';
import { H } from '../kit/web/ting.js';
import { Chain, DEVELOPMENT, read } from '../kit/scripts/chain.mjs';
import { loadState, NODE_URL, saveState } from '../kit/scripts/devchain.mjs';

const chain = await Chain.open(NODE_URL);
if (chain.chainHex !== DEVELOPMENT) throw new Error(`${NODE_URL} is not on the development chain`);
const state = loadState();
const code = read('program.wasm');
const policy = await chain.deploy(code, new Uint8Array());
console.log(`policy-webauthn  ${hex(policy)}   (CodeHash ${hex(H('code', code))})`);
saveState({ ...state, policy: hex(policy) });

const config = {
  chainId: chain.chainHex,
  node: NODE_URL,
  registry: state.registry,
  policyP256: hex(chain.policy),
  policyWebauthn: hex(policy),
  coins: [state.coin],
};
writeFileSync(new URL('../web/dev-chain.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log('wrote web/dev-chain.json');

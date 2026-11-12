#!/usr/bin/env node
// Readies the development chain for the wallet: deploys program.wasm, the
// policy-webauthn program, and the two reference programs the kit does not:
// policy-secp256k1, whose keys recovery phrases give, and batch, which pays
// for a creation. Then writes web/dev-chain.json, which the wallet reads when
// it runs against the development chain: the chain, the node, the identity
// registry, the policies, the batch and the test coin.
//
//   node kit/scripts/devchain.mjs start && node kit/scripts/devchain.mjs setup
//   ./build.sh && node scripts/dev.mjs
//   node kit/scripts/devchain.mjs fund <account> <amount>
import { writeFileSync } from 'node:fs';
import { hex } from '../kit/web/bytes.js';
import { H } from '../kit/web/ting.js';
import { Chain, DEVELOPMENT, read } from '../kit/scripts/chain.mjs';
import { loadState, NODE_URL, saveState } from '../kit/scripts/devchain.mjs';

/** reference/: Ting's reference programs, byte for byte as the Ting repository's programs/ has them. */
const REFERENCE = {
  'policy-secp256k1': '492e5470e3384a0bfa7cdfcf496c2e374a314325ce24327c75670f17e9201dcf',
  batch: '68118bab6c4f9c9a88147a25cbc2327a89b50ea997633e26bfe84e9563438a6e',
};

const chain = await Chain.open(NODE_URL);
if (chain.chainHex !== DEVELOPMENT) throw new Error(`${NODE_URL} is not on the development chain`);
const state = loadState();
const code = read('program.wasm');
const policy = await chain.deploy(code, new Uint8Array());
console.log(`policy-webauthn   ${hex(policy)}   (CodeHash ${hex(H('code', code))})`);

const deployed = {};
for (const [name, codeHash] of Object.entries(REFERENCE)) {
  const bytes = read(`reference/${name}.wasm`);
  if (hex(H('code', bytes)) !== codeHash) throw new Error(`reference/${name}.wasm is not the reference program`);
  deployed[name] = hex(await chain.deploy(bytes, new Uint8Array()));
  console.log(`${name.padEnd(17)} ${deployed[name]}`);
}
saveState({ ...state, policy: hex(policy) });

const config = {
  chainId: chain.chainHex,
  node: NODE_URL,
  registry: state.registry,
  batch: deployed.batch,
  policyP256: hex(chain.policy),
  policyWebauthn: hex(policy),
  policySecp256k1: deployed['policy-secp256k1'],
  coins: [state.coin],
};
writeFileSync(new URL('../web/dev-chain.json', import.meta.url), JSON.stringify(config, null, 2) + '\n');
console.log('wrote web/dev-chain.json');

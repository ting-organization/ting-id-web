#!/usr/bin/env node
// Deploys program.wasm, policy-webauthn, with empty input, as signature
// policies are deployed (Ting wiki: programs, canonical deployment): the same
// code, input and budget give the same ContractId on a chain, so anyone who
// deploys it again finds the first deployment.
//
//   node scripts/deploy.mjs
//       on the development chain
//   node scripts/deploy.mjs --node URL
//       shows the deployment on another network; nothing is sent without --submit
//
// A deployment is permanent and its code can never change: other code is
// another deployment, with another ContractId.
import { hex } from '../kit/web/bytes.js';
import { deployedId, encodeDeploy, H } from '../kit/web/ting.js';
import { Chain, DEPLOY_BUDGET, DEVELOPMENT, read } from '../kit/scripts/chain.mjs';
import { loadState, NODE_URL, saveState } from '../kit/scripts/devchain.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const chain = await Chain.open(option('node', NODE_URL));
const dev = chain.chainHex === DEVELOPMENT;
const state = dev ? loadState() : null;

// A policy needs no setup: its deployment input is empty.
const input = new Uint8Array();

const code = read('program.wasm');
const tx = encodeDeploy(code, input, DEPLOY_BUDGET);
const id = deployedId(chain.chain, tx);
console.log(`Network     ${dev ? 'the development chain' : chain.chainHex}`);
console.log(`CodeHash    ${hex(H('code', code))}   (${code.length} bytes)`);
console.log(`Input       ${hex(input)}`);
console.log(`ContractId  ${hex(id)}`);

if (!dev && !args.includes('--submit')) {
  console.log('\nNothing sent. Add --submit to deploy it: it can never be changed or removed.');
  process.exit(0);
}
await chain.deploy(code, input, DEPLOY_BUDGET);
console.log('Deployed.');
if (dev) saveState({ ...state, program: hex(id) });

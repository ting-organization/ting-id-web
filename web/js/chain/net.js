// The networks the wallet knows. On a network, the reference programs sit at
// their canonical deployments; policy-webauthn is this wallet's own program,
// deployed once per network.

/** The CodeHash of policy-webauthn, built reproducibly by build.sh from program/. */
export const POLICY_CODE_HASH = '91a7b9705abf0ee97947d45f7914cea689034c464e1da9186c0b06ddfb769fea';

export const PRODUCTION = {
  key: 'production',
  name: 'Ting',
  chainId: '15d6549cfacd816f835c632b4c67308d1c63e642f4cbf4049368430670705107',
  nodes: ['https://node1.ting-node.com', 'https://node2.ting-node.com'],
  registry: '1185ab4a07f12fd03e130acfd51211cd9360ec94b89e5f742bbd8f52767714bd',
  batch: '3766a2e88202657e225fa9b7955237004336f57438cbc7f26c2557d2573e1121',
  // Where policy-webauthn sits once deployed canonically (empty input, the
  // reference programs' budget). The wallet uses it only when the contract
  // there runs POLICY_CODE_HASH.
  policyWebauthn: 'cfd585a5d39f59ae50a19a33e972c4daaa18fae0cf989ca00a999ca4bc94619c',
  coins: ['305378d17f6af84a563d0f8a8455084948aff7330b62b4f2f98a44b82ba113c4'],
  /** The easiest target the production chain allows: a header must not claim an easier one. */
  powLimit: '0000000fffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
};

export const DEVELOPMENT = {
  key: 'development',
  name: 'Development chain',
  chainId: '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc',
  nodes: ['http://127.0.0.1:28451'],
  registry: '6b7c6151f4ae6b08c7063e00db5ec0bf9607412a2e11cea536b8d07d58f44334',
  batch: '84df96921d80b9ba85465fe90c004f4c9eb94859d34f743d71e6ab21a75e704d',
  policyWebauthn: 'e76b949606cda5fcd9395733957f33538cde2be059b0fbfd88c6e14371c305af',
  coins: [],
  powLimit: null,
};

const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

/**
 * The networks this page offers. The development chain is offered only on a
 * page served from this computer, and takes its ids from dev-chain.json,
 * which scripts/dev.mjs writes.
 */
export async function networks() {
  const list = [PRODUCTION];
  if (local) {
    try {
      const dev = await (await fetch('dev-chain.json', { cache: 'no-store' })).json();
      if (dev.chainId === DEVELOPMENT.chainId) {
        list.push({
          ...DEVELOPMENT,
          nodes: [dev.node ?? DEVELOPMENT.nodes[0]],
          registry: dev.registry ?? DEVELOPMENT.registry,
          policyWebauthn: dev.policyWebauthn ?? DEVELOPMENT.policyWebauthn,
          coins: dev.coins ?? [],
        });
      }
    } catch {
      // no development chain set up here
    }
  }
  return list;
}

/** Plain http only for this computer or a home network: anything else must be https. */
export function nodeAddress(text) {
  let url;
  try {
    url = new URL(String(text).trim());
  } catch {
    return null;
  }
  const host = url.hostname;
  const privateHost = ['localhost', '127.0.0.1', '[::1]'].includes(host)
    || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost)) return null;
  return url.origin;
}

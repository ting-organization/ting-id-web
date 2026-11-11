// Settings: the network and its nodes, coins, appearance, and this browser.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { idOf } from '../../../kit/web/ting.js';
import * as coins from '../chain/coins.js';
import { nodeAddress } from '../chain/net.js';
import { session } from '../session.js';
import * as store from '../store.js';
import { $, $$, esc, icon, problem, short, toast } from '../ui.js';

export function applyTheme() {
  const theme = store.get().theme ?? 'system';
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = theme;
}

export const settings = {
  render() {
    const net = session.net;
    const saved = session.saved();
    const nodes = session.pool?.nodes ?? [];
    const nodeRows = nodes.map((n) => {
      const tone = n.error ? 'bad' : n.status ? 'good' : '';
      const line = n.error ?? (n.status ? `${n === session.pool.best ? 'In use' : 'Answering'} · block ${n.status.height}` : 'Checking…');
      return `<div class="row"><span class="dot ${tone}"></span><span class="main"><b class="mono small">${esc(n.url)}</b><span>${esc(line)}</span></span>
        ${nodes.length > 1 ? `<button class="copy" data-node-remove="${esc(n.url)}" aria-label="Remove">${icon('x')}</button>` : ''}</div>`;
    }).join('');
    const followed = session.coins.map((c) => `<div class="row"><span class="main"><b>${esc(c.name)} · ${esc(c.symbol)}</b><span class="mono">${short(c.id)}</span></span>
      ${net.coins.includes(c.id) ? '<span class="chip">listed</span>' : `<button class="copy" data-coin-remove="${c.id}" aria-label="Unfollow">${icon('x')}</button>`}</div>`).join('');
    const theme = store.get().theme ?? 'system';
    return `<section class="screen plain narrow">
      <div class="head"><h1>Settings</h1></div>
      <h2 class="section">Network</h2>
      <div class="card">
        <div class="field"><span>Network</span><div class="seg">${session.nets.map((n) => `<button data-net="${n.key}" class="${n.key === net.key ? 'on' : ''}">${esc(n.name)}</button>`).join('')}</div></div>
        <div class="kv"><span>Chain</span><span class="mono small">${short(net.chainId)}</span></div>
        <div class="kv"><span>Height</span><span>${session.status?.height ?? '…'}</span></div>
        <div class="kv"><span>Passkey program</span><span class="mono small">${session.policyReady ? short(net.policyWebauthn) : 'not deployed yet'}</span></div>
      </div>
      <h2 class="section">Nodes</h2>
      <div class="card list">${nodeRows}
        <form class="field" data-node-form><span>Add a node</span><div class="inline"><input name="node" placeholder="https://node.example" autocomplete="off"><button class="btn small secondary">Add</button></div></form>
      </div>
      <p class="muted small">Ting ID Web checks every balance and nonce a node gives with a proof against a block it verified, and with two or more nodes it waits until another node has that block too.</p>
      ${saved ? `<h2 class="section">Coins</h2>
      <div class="card list">${followed || '<div class="row"><span class="main"><span>None followed</span></span></div>'}
        <form class="field" data-coin-form><span>Follow a coin by its contract ID</span><div class="inline"><input name="coin" placeholder="64 hex digits" autocomplete="off" spellcheck="false"><button class="btn small secondary">Add</button></div></form>
      </div>` : ''}
      <h2 class="section">Appearance</h2>
      <div class="card"><div class="field"><div class="seg">${['system', 'light', 'dark'].map((t) => `<button data-theme="${t}" class="${t === theme ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div></div></div>
      ${saved ? `<h2 class="section">This browser</h2>
      <div class="card pad stack"><p class="muted">This browser keeps ${esc(saved.name)}’s identity ID, contacts and activity, all public. The key is your passkey’s; the identity is on chain.</p>
        <button class="btn danger" data-forget>Forget this identity here</button></div>` : ''}
      <h2 class="section">About</h2>
      <div class="card"><div class="kv"><span>Ting ID Web</span><span>0.1.0</span></div>
        <div class="kv"><span>Source</span><span><a href="https://github.com/ting-organization/ting-id-web" rel="noopener">ting-id-web</a></span></div></div>
    </section>`;
  },

  bind(view) {
    $$('[data-net]', view).forEach((b) => b.addEventListener('click', async () => {
      await session.useNetwork(b.dataset.net);
      dispatchEvent(new HashChangeEvent('hashchange'));
    }));
    $$('[data-theme]', view).forEach((b) => b.addEventListener('click', () => {
      store.set({ theme: b.dataset.theme });
      applyTheme();
      $$('[data-theme]', view).forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('[data-node-form]', view)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = nodeAddress(e.target.node.value);
      if (!url) return toast('Plain http is only for a node on this device or your home network. Use the node’s https address.');
      const urls = [...new Set([...session.pool.nodes.map((n) => n.url), url])];
      session.setNodes(urls);
      await session.refresh(true);
      dispatchEvent(new HashChangeEvent('hashchange'));
    });
    $$('[data-node-remove]', view).forEach((b) => b.addEventListener('click', async () => {
      session.setNodes(session.pool.nodes.map((n) => n.url).filter((u) => u !== b.dataset.nodeRemove));
      await session.refresh(true);
      dispatchEvent(new HashChangeEvent('hashchange'));
    }));
    $('[data-coin-form]', view)?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = idOf(e.target.coin.value.replace(/\s+/g, ''));
      if (!id) return toast('A contract ID is 64 hex digits');
      try {
        const contract = await session.pool.contract(id);
        if (contract.code_hash !== coins.CODE_HASH) return toast('That contract does not run the standard coin');
        if (!(await session.pool.record(id, coins.CONFIG_KEY))) return toast('That coin is not set up on this chain');
        const saved = session.saved();
        session.keep({ ...saved, coins: [...new Set([...(saved.coins ?? []), hex(id)])] });
        await session.refresh(true);
        dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (err) {
        toast(problem(err));
      }
    });
    $$('[data-coin-remove]', view).forEach((b) => b.addEventListener('click', async () => {
      const saved = session.saved();
      session.keep({ ...saved, coins: (saved.coins ?? []).filter((c) => c !== b.dataset.coinRemove) });
      await session.refresh(true);
      dispatchEvent(new HashChangeEvent('hashchange'));
    }));
    $('[data-forget]', view)?.addEventListener('click', () => {
      if (!confirm('Forget this identity in this browser? It stays on chain, and your passkey can open it again.')) return;
      session.forget();
      location.hash = '#/welcome';
    });
  },
};

export { unhex };

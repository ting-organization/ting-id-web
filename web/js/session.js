// What the wallet knows right now: the network and its nodes, the identity as
// the chain holds it, the coins and accounts, activity and what this browser
// sent. Screens read it; `refresh` brings it up to date, once per new block.
import { equal, hex, Reader, unhex } from '../../kit/web/bytes.js';
import { encodeCall, transactionId } from '../../kit/web/ting.js';
import { BUDGETS } from './chain/budgets.js';
import * as coins from './chain/coins.js';
import { networks, POLICY_CODE_HASH } from './chain/net.js';
import { Pool } from './chain/pool.js';
import * as registry from './chain/registry.js';
import { identitySigner } from './chain/signer.js';
import * as store from './store.js';

const SLOT_NAMES = ['Spending', 'Savings'];
export const slotName = (n) => SLOT_NAMES[Number(n)] ?? `Account ${Number(n) + 1}`;

export const session = {
  nets: [],
  net: null,
  pool: null,
  status: null,
  identity: null,
  coins: [],
  activity: [],
  problem: null,
  policyReady: false,
  listeners: new Set(),
  tipSeen: null,
  timer: null,

  async open() {
    this.nets = await networks();
    const saved = store.get();
    this.net = this.nets.find((n) => n.key === saved.network) ?? this.nets.find((n) => n.key === 'development') ?? this.nets[0];
    const nodes = saved.nodes?.[this.net.key] ?? this.net.nodes;
    this.pool = new Pool(this.net, nodes);
    this.chain = unhex(this.net.chainId);
    this.registry = unhex(this.net.registry);
    await this.refresh(true);
    // Passkeys work on a network once policy-webauthn runs there: checked by its code.
    this.policyReady = false;
    if (this.net.policyWebauthn) {
      const contract = await this.pool.contract(this.net.policyWebauthn).catch(() => null);
      this.policyReady = contract?.code_hash === POLICY_CODE_HASH;
    }
    clearInterval(this.timer);
    this.timer = setInterval(() => document.hidden || this.refresh().catch(() => {}), 8000);
  },

  async useNetwork(key) {
    store.set({ network: key });
    this.identity = null;
    this.coins = [];
    this.activity = [];
    this.tipSeen = null;
    await this.open();
  },

  setNodes(urls) {
    const nodes = { ...(store.get().nodes ?? {}), [this.net.key]: urls };
    store.set({ nodes });
    this.pool = new Pool(this.net, urls);
    this.tipSeen = null;
  },

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  },

  /** The identity this browser keeps for this network, if any. */
  saved() {
    return store.get().identities?.[this.net?.key] ?? null;
  },

  keep(identity) {
    const identities = { ...(store.get().identities ?? {}), [this.net.key]: identity };
    store.set({ identities, identity: true });
  },

  forget() {
    const identities = { ...(store.get().identities ?? {}) };
    delete identities[this.net.key];
    store.set({ identities, identity: Object.keys(identities).length > 0 });
    this.identity = null;
    this.coins = [];
    this.activity = [];
  },

  signer() {
    const saved = this.saved();
    const keyId = this.identity?.keyId;
    if (!saved || keyId == null) return null;
    return identitySigner({ registry: this.registry, id: unhex(saved.id), keyId, credentialId: saved.credentialId });
  },

  /** Re-reads everything when there is a new block, or when `force` asks. */
  async refresh(force = false) {
    try {
      this.status = await this.pool.refresh();
      this.problem = null;
    } catch (e) {
      this.problem = e.message;
      this.emit();
      return;
    }
    if (!force && this.status.tip === this.tipSeen) return;
    this.tipSeen = this.status.tip;
    const saved = this.saved();
    store.set({ identity: Boolean(saved) });
    if (saved) {
      try {
        await this.readIdentity(saved);
        await this.readCoins(saved);
        this.settleRuns();
        await this.scan(saved);
        await this.watchPending();
      } catch (e) {
        this.problem = e.message;
      }
    }
    this.emit();
  },

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this);
      } catch {
        // a screen that went away
      }
    }
  },

  async readIdentity(saved) {
    const id = unhex(saved.id);
    const guardians = (saved.guardians ?? []).map(unhex);
    const found = await registry.readIdentity(this.pool, this.registry, id, guardians);
    if (!found) {
      this.identity = { id, onChain: false, keys: [], slots: [0n, BigInt(registry.DEFAULTS.savingsDelay)], pending: [], guardians: [] };
      return;
    }
    const mine = saved.publicKey && found.keys.find((k) =>
      this.net.policyWebauthn && hex(k.policy) === this.net.policyWebauthn && hex(k.params) === saved.publicKey);
    this.identity = { ...found, onChain: true, keyId: mine ? mine.keyId : null };
  },

  async readCoins(saved) {
    const id = unhex(saved.id);
    const followed = [...new Set([...this.net.coins, ...(saved.coins ?? [])])];
    const slots = this.identity.slots.map((_, n) => n);
    const reads = [];
    for (const c of followed) {
      reads.push([unhex(c), coins.CONFIG_KEY]);
      for (const n of slots) reads.push([unhex(c), registry.slotAccount(this.registry, id, n)]);
    }
    const values = reads.length ? await this.pool.storage(reads) : [];
    let at = 0;
    const list = [];
    for (const c of followed) {
      const config = values[at++];
      const accounts = slots.map((n) => {
        const record = coins.decodeAccount(values[at++]);
        return { slot: n, name: slotName(n), account: registry.slotAccount(this.registry, id, n), delay: this.identity.slots[n], record, scheduled: [] };
      });
      if (!config) continue;
      list.push({ id: c, ...coins.decodeConfig(config), accounts });
    }
    for (const coin of list) {
      for (const a of coin.accounts) {
        if (a.record.locked) a.scheduled = await coins.readScheduled(this.pool, unhex(coin.id), a.account, a.record);
      }
    }
    this.coins = list;
  },

  /** The accounts of this identity, in hex, to tell its activity apart. */
  accounts() {
    const saved = this.saved();
    if (!saved) return [];
    return this.identity.slots.map((_, n) => hex(registry.slotAccount(this.registry, unhex(saved.id), n)));
  },

  /**
   * Activity: the events of the followed coins and of the registry that touch
   * this identity, from its creation on, read forward as blocks come. Kept in
   * this browser so that only new blocks are read each time.
   */
  async scan(saved) {
    const key = `${this.net.key}:${saved.id}`;
    const scans = store.get().scans ?? {};
    const scan = scans[key] ?? { to: Math.max(0, (saved.createdHeight ?? 1) - 1), items: [] };
    const mine = new Set(this.accounts());
    const contracts = [...this.coins.map((c) => c.id), this.net.registry];
    const height = this.status.height;
    if (scan.to < height) {
      for (const contract of contracts) {
        let from = scan.to + 1;
        for (let pages = 0; pages < 20; pages++) {
          const page = await this.pool.events(contract, from);
          for (const block of page.items) {
            for (const e of block.events) {
              const item = describe(contract, unhex(e.payload_hex), mine, saved.id, this.net.registry);
              if (item) scan.items.push({ ...item, contract, height: block.height, time: block.timestamp, tx: e.transaction });
            }
          }
          if (!page.items.length || page.next > page.height || page.next > height) break;
          from = page.next;
        }
      }
      scan.to = height;
      scan.items.sort((a, b) => b.height - a.height);
      scan.items = scan.items.slice(0, 300);
      store.set({ scans: { ...scans, [key]: scan } });
    }
    this.activity = scan.items;
  },

  /** A held run whose scheduled action no longer exists (it ran, or was cancelled) has nothing left to do. */
  settleRuns() {
    const live = new Set();
    for (const coin of this.coins) for (const a of coin.accounts) for (const s of a.scheduled) live.add(`${coin.id}:${hex(a.account)}:${s.sequence}`);
    const list = store.get().pending ?? [];
    let changed = false;
    for (const p of list) {
      if (p.runOf && p.network === this.net.key && ['pending', 'deferred'].includes(p.state) && !live.has(p.runOf) && Date.now() - p.at > 60_000) {
        p.state = 'dismissed';
        changed = true;
      }
    }
    if (changed) store.set({ pending: list });
  },

  /** What this browser sent and no block has settled yet: watched until 3 blocks deep. */
  pending() {
    return (store.get().pending ?? []).filter((p) => p.network === this.net.key);
  },

  async send(tx, summary, extra = {}) {
    const id = hex(transactionId(this.chain, tx));
    const answer = await this.pool.submit(tx, extra.notBefore);
    if (answer.id && answer.id !== id) throw new Error('A node answered with another transaction id.');
    const item = { id, summary, at: Date.now(), network: this.net.key, hex: hex(tx), state: 'pending', ...extra };
    store.set({ pending: [...(store.get().pending ?? []), item] });
    return item;
  },

  /** Sends a call to `target` with `input` and the budget its kind needs. */
  call(target, input, budget, summary, extra) {
    return this.send(encodeCall(target, input, budget ?? BUDGETS.execute), summary, extra);
  },

  async watchPending() {
    const list = store.get().pending ?? [];
    let changed = false;
    for (const p of list) {
      if (p.network !== this.net.key || ['done', 'failed', 'dismissed'].includes(p.state)) continue;
      const t = await this.pool.transaction(p.id).catch(() => undefined);
      if (t === undefined) continue;
      if (t === null) {
        if (Date.now() - p.at > 120_000 && Date.now() - (p.resent ?? 0) > 120_000 && Date.now() - p.at < 86_400_000) {
          await this.pool.submit(unhex(p.hex), p.notBefore).catch(() => {});
          p.resent = Date.now();
          changed = true;
        }
        continue;
      }
      const last = t.occurrences?.at(-1);
      const next = last
        ? (last.receipt.status === 0 ? (this.status.height - last.height >= 2 ? 'done' : 'included') : 'failed')
        : t.deferred ? 'deferred' : 'pending';
      if (next !== p.state || (last && p.height !== last.height)) {
        p.state = next;
        p.height = last?.height;
        p.reason = last && last.receipt.status !== 0 ? reasonOf(last.receipt) : undefined;
        changed = true;
      }
    }
    if (changed) store.set({ pending: list });
  },

  /** Drops the held run of a scheduled action that was cancelled or already ran. */
  dismissRun(runOf) {
    store.set({ pending: (store.get().pending ?? []).map((p) => (p.runOf === runOf ? { ...p, state: 'dismissed' } : p)) });
  },

  dismiss(id) {
    store.set({ pending: (store.get().pending ?? []).map((p) => (p.id === id ? { ...p, state: 'dismissed' } : p)) });
  },
};

export function reasonOf(receipt) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(unhex(receipt.result_hex)) || receipt.status_name;
  } catch {
    return receipt.status_name;
  }
}

/** An event, as an activity item, when it touches this identity; null otherwise. */
function describe(contract, payload, mine, idHex, registryHex) {
  const topic = payload.subarray(0, 32);
  const r = new Reader(payload.subarray(32));
  const is = (t) => equal(topic, t);
  if (contract === registryHex) {
    if (hex(payload.subarray(32, 64)) !== idHex) return null;
    for (const [name, t] of Object.entries(registry.TOPICS)) {
      if (!is(t)) continue;
      r.id();
      const item = { kind: `id:${name}` };
      if (name.startsWith('change-')) item.changeNo = Number(r.u64());
      if (name === 'change-proposed') {
        item.effectiveAt = Number(r.u64());
        item.ops = registry.decodeChange(r).map(opText);
      }
      return item;
    }
    return null;
  }
  if (is(coins.TOPICS.transfer)) {
    const from = hex(r.id()), to = hex(r.id()), amount = r.u128().toString();
    const fromMine = mine.has(from), toMine = mine.has(to);
    if (!fromMine && !toMine) return null;
    if (amount === '0' && from === to) return null;
    return { kind: fromMine && toMine ? 'moved' : fromMine ? 'sent' : 'received', from, to, amount };
  }
  if (is(coins.TOPICS.scheduled)) {
    const account = hex(r.id());
    if (!mine.has(account)) return null;
    const sequence = r.u64().toString(), executeAt = Number(r.u64());
    r.u128();
    const kind = r.u8();
    const effect = kind === 1 ? { to: hex(r.id()), amount: r.u128().toString() } : {};
    return { kind: 'scheduled', account, sequence, executeAt, ...effect };
  }
  for (const name of ['executed', 'cancelled']) {
    if (!is(coins.TOPICS[name])) continue;
    const account = hex(r.id());
    if (!mine.has(account)) return null;
    return { kind: name, account, sequence: r.u64().toString() };
  }
  return null;
}

function opText(op) {
  switch (op.kind) {
    case 'addKey': return { kind: op.kind, text: 'Add a device', key: hex(op.params) };
    case 'removeKey': return { kind: op.kind, text: `Remove device #${op.keyId}` };
    case 'addGuardian': return { kind: op.kind, text: 'Link a guardian', guardian: hex(op.guardian) };
    case 'removeGuardian': return { kind: op.kind, text: 'Unlink a guardian', guardian: hex(op.guardian) };
    case 'threshold': return { kind: op.kind, text: `Recovery needs ${op.threshold || 'more than half of the'} guardians` };
    case 'delays': return { kind: op.kind, text: 'Change the delays' };
    case 'slotDelay': return { kind: op.kind, text: `Change ${slotName(op.slot)}’s lock` };
    default: return { kind: 'other', text: 'A change' };
  }
}

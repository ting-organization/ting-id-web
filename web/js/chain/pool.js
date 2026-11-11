// The nodes the wallet reads from, trusting none of them alone.
//
// Storage is read with proofs, against the state root of a header the wallet
// checked itself, as Ting ID does. With two or more nodes answering, a read
// counts only once another node has the same block: one node cannot invent
// a chain for the wallet. Blocks, events and transaction lookups carry no
// proofs; the wallet uses them for history and progress, never for balances
// or nonces. Transactions go to every node.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { checkHeader, HEADER_BYTES, verifyRecord } from './proof.js';

export class NodeError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

/** Blocks a read may lag behind the best height a node reported. */
const STALE_BLOCKS = 6;

export class Pool {
  constructor(net, urls) {
    this.net = net;
    this.nodes = urls.map((url) => ({ url, status: null, error: null, at: 0 }));
    this.headers = new Map();
    this.confirmed = new Set();
    this.best = null;
  }

  async request(node, path, body) {
    let response;
    try {
      response = await fetch(node.url + path, body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    } catch {
      throw new NodeError(`Can’t reach ${new URL(node.url).host}`);
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new NodeError(json?.error ?? `${response.status} from ${new URL(node.url).host}`, response.status);
    return json;
  }

  /** Asks every node for its status; the best is the highest on our chain. */
  async refresh() {
    await Promise.all(this.nodes.map(async (node) => {
      try {
        const status = await this.request(node, '/v1/status');
        node.status = status;
        node.error = status.chain_id === this.net.chainId ? null : 'On another chain';
        node.at = Date.now();
      } catch (e) {
        node.error = e.message;
      }
    }));
    const usable = this.usable();
    if (!usable.length) {
      this.best = null;
      throw new NodeError(this.nodes.length ? 'Can’t reach the node. Check its address in Settings.' : 'No node is set. Add one in Settings.');
    }
    this.best = usable.reduce((a, b) => (b.status.height > a.status.height ? b : a));
    return this.best.status;
  }

  usable() {
    return this.nodes.filter((n) => n.status && !n.error);
  }

  get height() {
    return this.best?.status.height ?? 0;
  }

  /** The tip header of `node`, checked: its hash, its work, its chain. */
  async header(node, tip) {
    if (this.headers.has(tip)) return this.headers.get(tip);
    const raw = await this.request(node, `/v1/blocks/${tip}/raw?offset=0&length=${HEADER_BYTES}`);
    const header = checkHeader(unhex(raw.hex), unhex(tip), this.net);
    this.headers.set(tip, header);
    if (this.headers.size > 64) this.headers.delete(this.headers.keys().next().value);
    return header;
  }

  /** Whether a node other than `from` has the block `tip` on its best chain. */
  async confirm(from, tip, height) {
    const others = this.usable().filter((n) => n !== from);
    if (!others.length || this.confirmed.has(tip)) return true;
    for (const node of others) {
      if (node.status.tip === tip) return this.confirmed.add(tip), true;
      if (node.status.height < height) continue;
      try {
        const page = await this.request(node, `/v1/blocks?from=${height}&limit=1`);
        if (page.items?.[0]?.id === tip) return this.confirmed.add(tip), true;
      } catch {
        // ask the next one
      }
    }
    return false;
  }

  /**
   * Records read together from one state, each checked by its proof: values
   * as bytes, null when absent. `reads` is `[[contract, key], …]` as bytes.
   */
  async storage(reads) {
    if (!this.best) await this.refresh();
    const order = [this.best, ...this.usable().filter((n) => n !== this.best)];
    let lastError = null;
    for (const node of order) {
      try {
        return await this.storageFrom(node, reads);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError ?? new NodeError('No node could answer.');
  }

  async storageFrom(node, reads) {
    const out = [];
    for (let i = 0; i < reads.length; i += 256) {
      const part = reads.slice(i, i + 256);
      const answer = await this.request(node, '/v1/storage', {
        reads: part.map(([contract, key]) => ({ contract: hex(contract), key: hex(key) })),
        proof: true,
      });
      const header = await this.header(node, answer.tip);
      if (hex(header.stateRoot) !== answer.state_root) throw new NodeError('A node’s answer does not match its own block.');
      if (Number(header.height) + STALE_BLOCKS < this.height) throw new NodeError('A node answered from an old block.');
      if (!(await this.confirm(node, answer.tip, Number(header.height)))) {
        throw new NodeError('No other node has the block this answer comes from yet.');
      }
      const root = unhex(answer.state_root);
      answer.values.forEach((v, j) => {
        const [contract, key] = part[j];
        const value = v.value_hex == null ? null : unhex(v.value_hex);
        if (!verifyRecord({ contract, key, value, proof: v.proof, root, others: answer.others })) {
          throw new NodeError('A node gave an answer that does not check out.');
        }
        out.push(value);
      });
    }
    return out;
  }

  async record(contract, key) {
    return (await this.storage([[contract, key]]))[0];
  }

  /** An unproved read from the best node, then the others. */
  async get(path) {
    if (!this.best) await this.refresh();
    const order = [this.best, ...this.usable().filter((n) => n !== this.best)];
    let lastError = null;
    for (const node of order) {
      try {
        return await this.request(node, path);
      } catch (e) {
        if (e.status === 404) throw e;
        lastError = e;
      }
    }
    throw lastError;
  }

  /** Sends a transaction to every node; its id, once any one took it. */
  async submit(tx, notBefore) {
    const body = { hex: hex(tx), ...(notBefore ? { not_before: Number(notBefore) } : {}) };
    const answers = await Promise.allSettled(this.usable().map((n) => this.request(n, '/v1/transactions', body)));
    const ok = answers.find((a) => a.status === 'fulfilled');
    if (!ok) throw answers[0]?.reason ?? new NodeError('No node took the transaction.');
    return ok.value;
  }

  /** A transaction's status: pending, deferred, its occurrences; null when no node knows it. */
  async transaction(id) {
    try {
      return await this.get(`/v1/transactions/${id}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }

  contract(id) {
    return this.get(`/v1/contracts/${typeof id === 'string' ? id : hex(id)}`);
  }

  events(contract, from, topic) {
    const c = typeof contract === 'string' ? contract : hex(contract);
    const t = topic ? `&topic=${typeof topic === 'string' ? topic : hex(topic)}` : '';
    return this.get(`/v1/events?contract=${c}${t}&from=${from}&limit=100`);
  }

  blocks(from, limit = 100) {
    return this.get(`/v1/blocks?from=${from}&limit=${limit}`);
  }
}

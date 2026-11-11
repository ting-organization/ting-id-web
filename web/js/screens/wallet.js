// Wallet, the home tab: what you hold, the three actions, and what happened.
import { hex, unhex } from '../../../kit/web/bytes.js';
import { BUDGETS } from '../chain/budgets.js';
import * as coins from '../chain/coins.js';
import { activityList, coinMark, notices, scheduledList, waitingList } from '../parts.js';
import { session } from '../session.js';
import * as store from '../store.js';
import { $$, amount, esc, icon, initials, problem, toast } from '../ui.js';

export function currentCoin() {
  const want = store.get().coin;
  return session.coins.find((c) => c.id === want) ?? session.coins[0] ?? null;
}

function hero() {
  const saved = session.saved();
  const coin = currentCoin();
  const top = `<div class="top"><span class="title">Ting ID</span><a class="avatar lg" href="#/identity" aria-label="Identity">${esc(initials(saved?.name))}</a></div>`;
  if (!coin) {
    return `<div class="hero">${top}<div class="coin">No coin to show yet</div>
      <p class="mt">Follow a coin in Settings to see it here.</p>${actions()}</div>`;
  }
  const total = coin.accounts.reduce((sum, a) => sum + a.record.balance, 0n);
  const tiles = coin.accounts.slice(0, 2).map((a) => `<div>
      <span>${a.delay ? icon('lock') : ''}${esc(a.name)}</span>
      <b>${amount(a.record.available, coin.decimals, 2)}</b>
      ${a.record.locked ? `<span>${amount(a.record.locked, coin.decimals, 2)} reserved</span>` : ''}</div>`).join('');
  const choose = session.coins.length > 1 ? `<button class="link on-navy" data-coins>${icon('chevron')}</button>` : '';
  return `<div class="hero">${top}
    <div class="coin">${coinMark(coin)} ${esc(coin.name)} ${choose}</div>
    <div class="total">${amount(total, coin.decimals, 2)}<small>${esc(coin.symbol)}</small></div>
    <div class="split">${tiles}</div>${actions()}</div>`;
}

const actions = () => `<div class="actions">
  <a class="action main" href="#/send"><span class="disc">${icon('up')}</span>Send</a>
  <a class="action" href="#/receive"><span class="disc">${icon('down')}</span>Receive</a>
  <a class="action" href="#/scan"><span class="disc">${icon('scan')}</span>Scan</a></div>`;

function devHint() {
  if (session.net?.key !== 'development' || !session.coins.length) return '';
  const coin = currentCoin();
  const spending = coin?.accounts[0];
  if (!spending || spending.record.balance) return '';
  return `<div class="note">${icon('info')}<div>Development chain: get test DLR with<br><code class="small">node kit/scripts/devchain.mjs fund ${hex(spending.account)} 10</code></div></div>`;
}

export const wallet = {
  render() {
    return `<section class="wallet">
      <div class="columns">
        <div class="lead-col">${hero()}
          <div class="screen stack mt">${notices()}${devHint()}</div>
          <div class="screen">${scheduledList()}${waitingList()}</div>
        </div>
        <div class="side screen"><h2 class="section">Activity</h2>${activityList()}</div>
      </div>
    </section>`;
  },

  bind(view) {
    // Listen on this render's own element: `view` outlives it.
    view.firstElementChild.addEventListener('click', async (e) => {
      const cancel = e.target.closest('[data-cancel]');
      const run = e.target.closest('[data-run]');
      const dismiss = e.target.closest('[data-dismiss]');
      if (dismiss) {
        e.preventDefault();
        session.dismiss(dismiss.dataset.dismiss);
        return dispatchEvent(new HashChangeEvent('hashchange'));
      }
      if (!cancel && !run) return;
      (cancel ?? run).disabled = true;
      const [coinId, slot, seq] = (cancel ?? run).dataset[cancel ? 'cancel' : 'run'].split(':');
      const coin = session.coins.find((c) => c.id === coinId);
      const account = coin.accounts[Number(slot)];
      try {
        if (run) {
          await session.call(unhex(coinId), coins.runInput(account.account, BigInt(seq)), BUDGETS.claim, `Run a scheduled ${coin.symbol} payment`);
          toast('Sent: it runs in the next block');
        } else {
          const signer = session.signer();
          if (!signer) return toast('This browser can’t act for this identity yet');
          const input = await coins.cancelInput({ chain: session.chain, coin: unhex(coinId), signer: signer.slot(Number(slot)), sequences: [BigInt(seq)] });
          await session.call(unhex(coinId), input, BUDGETS.execute, `Cancel a scheduled ${coin.symbol} payment`);
          session.dismissRun(`${coinId}:${hex(account.account)}:${seq}`);
          toast('Cancelling: it stops once a block includes this');
        }
        session.refresh(true);
      } catch (err) {
        toast(problem(err));
      }
    });
    $$('[data-coins]', view).forEach((b) => b.addEventListener('click', () => {
      const i = session.coins.indexOf(currentCoin());
      store.set({ coin: session.coins[(i + 1) % session.coins.length].id });
      dispatchEvent(new HashChangeEvent('hashchange'));
    }));
  },
};

// The first screen, before there is an identity: what Ting ID is, and the two
// ways in.
import * as passkey from '../passkey.js';
import { icon } from '../ui.js';

export const welcome = {
  render() {
    const ok = passkey.available();
    return `<section>
      <div class="hero">
        <div class="top"><span class="title">Ting ID</span></div>
        <h1>Welcome</h1>
        <p>Your money and your identity, signed with your passkey.</p>
      </div>
      <div class="screen narrow mt">
        <div class="card list">
          <div class="row"><span class="avatar">${icon('wallet')}</span><span class="main"><b>Spending</b><span class="wrap">Pay and get paid at once.</span></span></div>
          <div class="row"><span class="avatar">${icon('lock')}</span><span class="main"><b>Savings</b><span class="wrap">Withdrawals wait a few days, and you can stop them meanwhile.</span></span></div>
          <div class="row"><span class="avatar">${icon('key')}</span><span class="main"><b>Passkey</b><span class="wrap">Face ID, Touch ID or your device PIN signs. Ting ID Web never sees the key.</span></span></div>
        </div>
        ${ok ? '' : `<div class="note bad">${icon('warn')}<div>This browser cannot use passkeys. Open Ting ID in a current Safari, Chrome, Edge or Firefox.</div></div>`}
        <div class="stack mt">
          <a class="btn primary" href="#/create" ${ok ? '' : 'aria-disabled="true"'}>${icon('plus')} Create an identity</a>
          <a class="btn secondary" href="#/restore">${icon('restore')} Use an existing identity</a>
        </div>
        <p class="center muted small mt">With a passkey that syncs, such as iCloud Keychain or Google Password Manager, your identity opens on your other devices too.</p>
      </div>
    </section>`;
  },
};

// People: names for accounts, kept in this browser. A contact is only a name
// for an address; it proves nothing and signs nothing.
import { hex } from '../../../kit/web/bytes.js';
import { idOf } from '../../../kit/web/ting.js';
import * as store from '../store.js';
import { $, esc, grouped, icon, initials, short, toast } from '../ui.js';

export const people = {
  render() {
    const { contacts } = store.get();
    const rows = contacts.map((c) => `
      <a class="row" href="#/person/${c.account}">
        <span class="avatar">${esc(initials(c.name))}</span>
        <span class="main"><b>${esc(c.name)}</b><span class="mono">${short(c.account)}</span></span>
        ${icon('chevron')}
      </a>`).join('');
    return `<section class="screen plain narrow">
      <div class="head"><h1>People</h1><a class="btn small secondary" href="#/person/new">${icon('userplus')} Add</a></div>
      <div class="card list">${rows || '<div class="row"><span class="main"><b>No contacts yet</b><span>Add the people you pay, so their names show instead of addresses.</span></span></div>'}</div>
    </section>`;
  },
};

export const person = {
  render(account) {
    const c = account && account !== 'new' ? store.contactOf(account) : null;
    return `<section class="screen plain narrow">
      <button class="back" data-back>${icon('back')} People</button>
      <h1 class="page">${c ? esc(c.name) : 'New contact'}</h1>
      <form class="card mt" data-form>
        <label class="field"><span>Name</span><input name="name" required maxlength="60" value="${esc(c?.name ?? '')}" autocomplete="off"></label>
        <label class="field"><span>Account</span><textarea name="account" rows="2" required spellcheck="false" placeholder="64 hex digits">${esc(c ? grouped(c.account) : (account && account !== 'new' ? grouped(account) : ''))}</textarea>
          <div class="hint">Check it with the person: anyone can name any address.</div></label>
      </form>
      <div class="stack mt">
        <button class="btn primary" data-save>Save</button>
        ${c ? `<a class="btn secondary" href="#/send/${c.account}">${icon('send')} Send to ${esc(c.name)}</a><button class="btn danger" data-remove>Remove</button>` : ''}
      </div>
    </section>`;
  },
  bind(view, account) {
    const form = $('[data-form]', view);
    $('[data-back]', view).addEventListener('click', () => { location.hash = '#/people'; });
    $('[data-save]', view).addEventListener('click', () => {
      const name = form.name.value.trim();
      const id = idOf(form.account.value.replace(/\s+/g, ''));
      if (!name) return toast('Give the contact a name');
      if (!id) return toast('An account is 64 hex digits');
      if (account && account !== 'new' && account !== hex(id)) store.removeContact(account);
      store.saveContact(name, hex(id));
      toast(`Saved ${name}`);
      location.hash = '#/people';
    });
    $('[data-remove]', view)?.addEventListener('click', () => {
      store.removeContact(account);
      toast('Removed');
      location.hash = '#/people';
    });
  },
};

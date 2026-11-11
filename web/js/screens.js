// Every screen, by the name in the address: `#/send` → send.
import { link } from './screens/call.js';
import { create, identity, restore } from './screens/identity.js';
import { people, person } from './screens/people.js';
import { receive, review, scan, send, tx } from './screens/send.js';
import { settings } from './screens/settings.js';
import { wallet } from './screens/wallet.js';
import { welcome } from './screens/welcome.js';

export const screens = { welcome, create, restore, wallet, send, review, tx, receive, scan, identity, people, person, settings, link };

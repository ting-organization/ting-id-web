// Every screen, by the name in the address: `#/send` → send.
import { link } from './screens/call.js';
import { addGuardian, create, device, identity, restore } from './screens/identity.js';
import { people, person } from './screens/people.js';
import { approveRecovery, recoveryPhrase, restoreGuardians, restorePhrase } from './screens/recovery.js';
import { receive, review, send, tx } from './screens/send.js';
import { scan } from './screens/scan.js';
import { settings } from './screens/settings.js';
import { wallet } from './screens/wallet.js';
import { welcome } from './screens/welcome.js';

export const screens = {
  welcome, create, restore, wallet, send, review, tx, receive, scan, identity, people, person, settings, link,
  'add-guardian': addGuardian, 'add-device': device,
  'restore-phrase': restorePhrase, 'restore-guardians': restoreGuardians,
  'recovery-phrase': recoveryPhrase, 'approve-recovery': approveRecovery,
};

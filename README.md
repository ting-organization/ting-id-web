# Ting ID Web

Ting ID in the browser, signed with a passkey: Face ID, Touch ID, Windows Hello,
your device PIN or a security key. It works on iPhone, Mac, Android, Windows and
Linux, from one static web page, without an app store.

It has the same identity as Ting ID: an instant **Spending** account, a **Savings**
account whose withdrawals wait and can be cancelled meanwhile, devices that act for
you, guardians who can recover you, and changes that wait so that a stolen key
cannot take over at once.

Two pieces:

- **`program/`, policy-webauthn**: a Ting program that makes a passkey a key of an
  account. Consensus does not change: like every policy, it is an ordinary program,
  deployed once per network. Its CodeHash is
  `91a7b9705abf0ee97947d45f7914cea689034c464e1da9186c0b06ddfb769fea`, built by
  `./build.sh`, which gives the same bytes on any machine with the pinned toolchain.
  On the Ting network it is deployed at
  `cfd585a5d39f59ae50a19a33e972c4daaa18fae0cf989ca00a999ca4bc94619c` (November 11,
  2026); `program.wasm` is those bytes.
- **`web/`, the wallet**: plain HTML, CSS and JavaScript, no build step and no
  third-party code. It holds no key: the passkey signs, and the chain holds the
  identity.

This repository grew from the [Ting dev kit](https://github.com/ting-organization/ting-devkit):
`kit/` is the kit's own code, unchanged.

## How a passkey signs for Ting

A passkey cannot sign a Ting message directly: it signs its own authenticator data
together with a hash of the client data, a small JSON that holds the challenge. So
the wallet passes Ting's signing digest, `H("app/sign-v1", message)`, as the
challenge, and policy-webauthn checks the whole assertion:

```text
params  = the passkey's P-256 public key, 65 bytes: 04 ‖ x ‖ y
witness = Bytes(authenticatorData) ‖ Bytes(clientDataJSON) ‖ r(32) ‖ s(32)
```

It answers `01` exactly when:

1. the authenticator data says the user was present and verified (flags UP and UV);
2. the client data starts with `{"type":"webauthn.get","challenge":"` and the
   digest in base64url, followed by `"` and then `,` or `}`;
3. `r` and `s` are in range, with `s` in its low form;
4. the ECDSA signature verifies over `SHA-256(authenticatorData ‖ SHA-256(clientDataJSON))`.

A query whose framing does not decode reverts `bad input`, as policy-p256 does;
anything else answers `00`. The origin and relying party are not checked: a passkey
only ever signs for its own site.

A passkey is a key of an identity of the reference registry, so it acts for the
identity's Spending and Savings accounts and for changes to the identity, exactly as
a phone key of Ting ID does. A payment signed with a passkey costs about 15 M C,
less than one signed through policy-p256 (20.5 M C).

## The wallet

| Tab | |
|---|---|
| Wallet | Balances, Send / Receive / Scan, scheduled withdrawals with Cancel, what is waiting for a block, and activity |
| Send | Review, then one passkey prompt. From Savings it is scheduled for when the lock ends, and the node holds the run until then |
| Identity | Devices (passkeys and phone keys), adding one from its device link, guardians (linked from their code or ID) and your own guardian code, pending changes with Cancel and Apply |
| People | Contacts |
| Settings | Network, nodes, coins, appearance, forgetting the identity in this browser |

Links: `ting:pay` and `ting:call` (TCR-1) open as `https://<wallet>/#ting:call?…`,
so any page can hand a call to the wallet with an ordinary link. A device or
guardian link lets someone into an identity, so, as in Ting ID, it opens only when
scanned or pasted on the Scan screen, never from an address.

**It trusts no node alone.** Every balance, nonce and identity record is read with
a Merkle proof against the state root of a header the wallet checks itself: its hash
is the tip, its proof of work holds, its chain is ours. With two or more nodes it
waits until another node has the same block. Events and transaction lookups, which
carry no proofs, are used only for history and progress.

Not here yet: signing in to sites (TOCS-1), recovering someone as their guardian,
coin tools, and paying fees for identity changes through a batch (they go unpaid,
as they do from Ting ID when no fee is set).

## Develop

You need Rust (the toolchain in `rust-toolchain.toml` installs itself), Node.js 20
or newer, Python 3, and `ting` on your PATH.

```sh
./build.sh                                   # program/ → program.wasm and its CodeHash
cargo test --release                         # 36 tests of the policy on Ting's reference VM
node kit/scripts/devchain.mjs start          # a development chain in dev/, mining
node kit/scripts/devchain.mjs setup          # the reference programs and a test coin
node scripts/dev.mjs                         # deploys the policy, writes web/dev-chain.json
python3 kit/scripts/serve.py 8766            # http://127.0.0.1:8766/web/
node kit/scripts/devchain.mjs fund <account> 10
```

Passkeys need https or `localhost`. On this computer, open
<http://localhost:8766/web/> and your browser's own passkeys work. For automated
tests, `?authenticator=software` (on localhost only) swaps in a stand-in
authenticator that answers exactly as a platform authenticator does, with keys kept
in the page's storage.

The policy's tests cover every check, tampering, framing, a real payment from an
identity through the registry, and a differential test of 14,048 seeded cases
against the p256 crate's own verification, 2,048 of them through the packed module.

## Publishing

`.github/workflows/pages.yml` assembles the site on every push to main with
`scripts/site.sh` (web/ at the top, the kit's modules at kit/web/) and checks it:
every module parses, every import and asset is in the site, the page keeps its
Content Security Policy, and the policy CodeHash the wallet trusts is
`program.wasm`'s. Once GitHub Pages is turned on for the repository (Source:
GitHub Actions), it publishes there, at `wallet.ting-project.com`.

## Safety

The key never reaches the page; what the page asks it to sign is another matter. A
passkey's prompt names the site, not the operation, so whoever can change the page
can ask for a different signature. Keep the wallet on a domain of its own, with
nothing else on it; keep the domain and the account that hosts it locked down; and
treat a passkey as a key for everyday amounts, with Savings and other devices as
the safety net. A passkey that syncs through iCloud Keychain or Google Password
Manager makes that account part of your wallet's security.

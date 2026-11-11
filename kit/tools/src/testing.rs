//! A chain in memory, on Ting's reference VM: deploy your program and the
//! reference coin, and make TCR-1 calls as test users, in plain `cargo test`.
//!
//! Users sign through stub policies that approve every message, so tests need
//! no keys: [`TestChain::user`] is approved at once, [`TestChain::saver`] only
//! after a delay, as a Ting ID Savings account is. Payments go through the
//! real coin program, which checks them exactly as on chain. The development
//! chain (scripts/devchain.mjs) is where real signatures are exercised.
//!
//! ```ignore
//! let mut chain = TestChain::new();
//! let alice = chain.user("alice");
//! let dlr = chain.coin("DLR", 8, &[(&alice, 1_000)]);
//! let program = chain.deploy(&program_wasm(), &input);
//! let r = chain.tcr(&program, &alice, TEMPLATE, &[&values::text("hello")], Pay::Nothing);
//! ok(&r);
//! ```
use crate::Id;
use ting_core::hash::{hash, hash_parts};
use ting_core::meter::Resources;
use ting_core::protocol::{Genesis, Payload, Transaction};
use ting_core::state::State;
use ting_core::vm::{Context, Runtime};

pub use ting_core::protocol::{Event, Receipt, Status};

/// The coin reference program, byte for byte (kit/programs/coin.wasm).
pub const COIN_WASM: &[u8] = include_bytes!("../../programs/coin.wasm");

/// What every test transaction may spend, in C, S, D, G.
pub const BUDGET: Resources = Resources([200_000_000, 4096, 4_000_000, 4_000_000]);

/// The delay a [`TestChain::saver`]'s policy answers with, in seconds.
pub const SAVER_DELAY: u64 = 100;

/// Answers `01` to every policy query, and nothing to its deployment.
const INSTANT_POLICY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\01")
  (func (export "invoke")
    (call $return (i32.const 0)
      (i32.ne (call $input (i32.const 0) (i32.const 0)) (i32.const 0)))))"#;

/// Answers `01 ‖ u64 100`: authorized only 100 seconds ahead.
const DELAYED_POLICY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\01\64\00\00\00\00\00\00\00")
  (func (export "invoke")
    (call $return (i32.const 0)
      (select (i32.const 9) (i32.const 0) (call $input (i32.const 0) (i32.const 0))))))"#;

/// Ting's `H(tag, parts…)`.
pub fn h(tag: &str, parts: &[&[u8]]) -> Id {
    hash_parts(tag, parts)
}

/// `Bytes(x)`: `x` with its u32 length in front.
pub fn framed(x: &[u8]) -> Vec<u8> {
    [&(x.len() as u32).to_le_bytes()[..], x].concat()
}

/// The contract account of `program`: where it keeps coins of its own.
pub fn contract_account(program: &Id) -> Id {
    hash("app/account-v1/contract", program)
}

/// A test user: an account of a stub policy, told apart by its params.
pub struct User {
    pub policy: Id,
    pub params: Vec<u8>,
}

impl User {
    pub fn account(&self) -> Id {
        h(
            "app/account-v1/policy",
            &[&self.policy, &(self.params.len() as u32).to_le_bytes(), &self.params],
        )
    }
}

/// An account to name in a coin's holders or a program's input.
pub trait AsAccount {
    fn as_account(&self) -> Id;
}

impl AsAccount for User {
    fn as_account(&self) -> Id {
        self.account()
    }
}

impl AsAccount for Id {
    fn as_account(&self) -> Id {
        *self
    }
}

/// What a TCR-1 call pays.
pub enum Pay {
    /// No payment: the account's policy approves the call.
    Nothing,
    /// A fee payment in this coin: a transfer of 0 to the program's account,
    /// which is the approval and pays the miner.
    Fee(Id),
    /// A transfer of `amount` of `coin` to `to`, for a template with `{payment}`.
    Transfer { coin: Id, to: Id, amount: u128 },
    /// A burn of `amount` of `coin`, for a template with `{payment}`.
    Burn { coin: Id, amount: u128 },
}

/// The bytes of a template's fields.
pub mod values {
    use super::Id;

    pub fn u8(v: u8) -> Vec<u8> {
        vec![v]
    }
    pub fn u16(v: u16) -> Vec<u8> {
        v.to_le_bytes().to_vec()
    }
    pub fn u32(v: u32) -> Vec<u8> {
        v.to_le_bytes().to_vec()
    }
    /// Also `time` and `duration`.
    pub fn u64(v: u64) -> Vec<u8> {
        v.to_le_bytes().to_vec()
    }
    pub fn u128(v: u128) -> Vec<u8> {
        v.to_le_bytes().to_vec()
    }
    /// `coin`, `account` and `bytes32`.
    pub fn id(v: &Id) -> Vec<u8> {
        v.to_vec()
    }
    pub fn amount(coin: &Id, v: u128) -> Vec<u8> {
        [&coin[..], &v.to_le_bytes()].concat()
    }
    pub fn text(v: &str) -> Vec<u8> {
        super::framed(v.as_bytes())
    }
    pub fn bytes(v: &[u8]) -> Vec<u8> {
        super::framed(v)
    }
    /// An `enum`: the label's index.
    pub fn label(index: u8) -> Vec<u8> {
        vec![index]
    }
    /// A `list`: its count, then the items' bytes.
    pub fn list(items: &[Vec<u8>]) -> Vec<u8> {
        let mut out = (items.len() as u64).to_le_bytes().to_vec();
        for item in items {
            out.extend(item);
        }
        out
    }
}

/// Fails the test unless the transaction succeeded, showing why it did not.
#[track_caller]
pub fn ok(r: &Receipt) {
    assert_eq!(
        r.status,
        Status::Success,
        "{}",
        String::from_utf8_lossy(&r.result)
    );
}

/// Fails the test unless the transaction reverted with `reason`.
#[track_caller]
pub fn reverts(r: &Receipt, reason: &str) {
    assert_eq!(
        r.status,
        Status::Revert,
        "expected a revert with {reason:?}, got {:?}: {}",
        r.status,
        String::from_utf8_lossy(&r.result)
    );
    assert_eq!(String::from_utf8_lossy(&r.result), reason);
}

/// The payloads of the events `contract` emitted that start with `topic`,
/// without the topic.
pub fn events<'a>(r: &'a Receipt, contract: &Id, topic: &Id) -> Vec<&'a [u8]> {
    r.events
        .iter()
        .filter(|e| e.contract == *contract && e.payload.starts_with(topic))
        .map(|e| &e.payload[32..])
        .collect()
}

pub struct TestChain {
    state: State,
    /// The block the next transaction runs in: its height, timestamp, chain.
    pub context: Context,
    instant: Id,
    delayed: Id,
}

impl Default for TestChain {
    fn default() -> Self {
        Self::new()
    }
}

impl TestChain {
    /// An empty chain with the two stub policies deployed.
    pub fn new() -> Self {
        let mut chain = TestChain {
            state: State::default(),
            context: Context::from_genesis(&Genesis::experimental()),
            instant: [0; 32],
            delayed: [0; 32],
        };
        chain.instant = chain.deploy(&wasm(INSTANT_POLICY), &[]);
        chain.delayed = chain.deploy(&wasm(DELAYED_POLICY), &[]);
        chain.context.height += 1;
        chain
    }

    pub fn chain_id(&self) -> Id {
        self.context.chain
    }

    /// Runs one transaction against the chain's state, keeping what it changed.
    pub fn execute(&mut self, payload: Payload) -> Receipt {
        let runtime = Runtime::new(self.state.clone(), self.context.clone());
        let receipt = runtime
            .execute(&Transaction {
                budget: BUDGET,
                payload,
            })
            .unwrap();
        // Against an empty reader, the changes list every record that exists.
        let mut state = State::default();
        for change in runtime.state_changes().unwrap().records {
            if change.after.is_some() {
                state.set(change.key, change.after);
            }
        }
        state.commit();
        self.state = state;
        receipt
    }

    /// Deploys `code` with `input`, and returns its ContractId. Fails the test
    /// when the deployment fails; [`TestChain::try_deploy`] returns the receipt.
    #[track_caller]
    pub fn deploy(&mut self, code: &[u8], input: &[u8]) -> Id {
        let r = self.try_deploy(code, input);
        ok(&r);
        r.result.try_into().unwrap()
    }

    pub fn try_deploy(&mut self, code: &[u8], input: &[u8]) -> Receipt {
        self.execute(Payload::Deploy {
            code: code.to_vec(),
            input: input.to_vec(),
        })
    }

    /// A transaction calling `target` with `input`, as Ting ID or a page would
    /// submit it.
    pub fn call(&mut self, target: &Id, input: &[u8]) -> Receipt {
        self.execute(Payload::Call {
            target: *target,
            input: input.to_vec(),
        })
    }

    /// A record of `contract`, as a page reads it from a node.
    pub fn record(&self, contract: &Id, key: &Id) -> Option<Vec<u8>> {
        Runtime::new(self.state.clone(), self.context.clone()).storage(*contract, *key)
    }

    /// Moves to a later block, `seconds` later.
    pub fn advance(&mut self, seconds: u64) {
        self.context.height += 1;
        self.context.timestamp += seconds;
    }

    /// A user whose account approves at once, like a Ting ID Spending account.
    pub fn user(&self, name: &str) -> User {
        User {
            policy: self.instant,
            params: name.as_bytes().to_vec(),
        }
    }

    /// A user whose account approves only after [`SAVER_DELAY`] seconds, like a
    /// Ting ID Savings account. Its own coin payments are refused.
    pub fn saver(&self, name: &str) -> User {
        User {
            policy: self.delayed,
            params: name.as_bytes().to_vec(),
        }
    }

    /// Deploys a coin of the coin reference program, with what each holder
    /// starts with, in its smallest units.
    pub fn coin(&mut self, symbol: &str, decimals: u8, holders: &[(&dyn AsAccount, u128)]) -> Id {
        let mut input = vec![1];
        input.extend(framed(symbol.as_bytes()));
        input.extend(framed(symbol.as_bytes()));
        input.push(decimals);
        input.extend(u128::MAX.to_le_bytes());
        input.extend([0; 16 + 8 + 16 + 32]);
        input.extend((holders.len() as u64).to_le_bytes());
        for (who, amount) in holders {
            input.extend(who.as_account());
            input.extend(amount.to_le_bytes());
        }
        self.deploy(COIN_WASM, &input)
    }

    /// `account`'s balance of `coin`.
    pub fn balance(&self, coin: &Id, account: &Id) -> u128 {
        self.record(coin, account)
            .map_or(0, |r| u128::from_le_bytes(r[..16].try_into().unwrap()))
    }

    fn coin_nonce(&self, coin: &Id, account: &Id) -> u64 {
        self.record(coin, account)
            .map_or(0, |r| u64::from_le_bytes(r[32..40].try_into().unwrap()))
    }

    /// `account`'s TCR-1 nonce in `program`.
    pub fn nonce(&self, program: &Id, account: &Id) -> u64 {
        self.record(program, &h("app/call-v1/nonce", &[account]))
            .map_or(0, |v| u64::from_le_bytes(v.try_into().unwrap()))
    }

    /// The templates `program` lists.
    pub fn templates(&self, program: &Id) -> Vec<String> {
        let list = self
            .record(program, &h("app/call-v1/templates", &[]))
            .expect("a template list");
        let count = u64::from_le_bytes(list[..8].try_into().unwrap());
        let mut at = 8;
        (0..count)
            .map(|_| {
                let len = u32::from_le_bytes(list[at..at + 4].try_into().unwrap()) as usize;
                at += 4 + len;
                String::from_utf8(list[at - len..at].to_vec()).unwrap()
            })
            .collect()
    }

    /// The input of a TCR-1 call `user` makes in `program`: the operation of
    /// `template` with `values`, approved by `user`'s policy or by `pay`.
    pub fn tcr_input(&self, program: &Id, user: &User, template: &str, values: &[&[u8]], pay: &Pay) -> Vec<u8> {
        let head = [&hash("app/call-v1/template", template.as_bytes())[..], &values.concat()].concat();
        let account = user.account();
        let nonce = self.nonce(program, &account);
        let valid_until = 0u64;
        let message = [
            framed(b"app/call-v1"),
            self.chain_id().to_vec(),
            program.to_vec(),
            account.to_vec(),
            vec![1],
            nonce.to_le_bytes().to_vec(),
            valid_until.to_le_bytes().to_vec(),
            hash("app/call-v1/operation", &head).to_vec(),
        ]
        .concat();
        let digest = hash("app/sign-v1", &message);
        let mut input = [
            &head[..],
            &[0],
            &user.policy,
            &framed(&user.params),
            &nonce.to_le_bytes(),
            &valid_until.to_le_bytes(),
            &framed(b""),
        ]
        .concat();
        let (coin, effect) = match pay {
            Pay::Nothing => {
                input.push(0);
                return input;
            }
            Pay::Fee(coin) => (coin, [&[1][..], &contract_account(program), &0u128.to_le_bytes()].concat()),
            Pay::Transfer { coin, to, amount } => (coin, [&[1][..], to, &amount.to_le_bytes()].concat()),
            Pay::Burn { coin, amount } => (coin, [&[2][..], &amount.to_le_bytes()].concat()),
        };
        let mut action = vec![0x10, 0x00];
        action.extend(user.policy);
        action.extend(framed(&user.params));
        action.extend(self.coin_nonce(coin, &account).to_le_bytes());
        action.extend(framed(b""));
        action.extend(effect);
        action.extend([0; 16 + 16 + 8 + 8]);
        action.push(1);
        action.extend(program);
        action.extend(digest);
        input.push(1);
        input.extend(coin);
        input.extend(framed(&action));
        input
    }

    /// `user` does the operation of `template` with `values` in `program`.
    pub fn tcr(&mut self, program: &Id, user: &User, template: &str, values: &[&[u8]], pay: Pay) -> Receipt {
        let input = self.tcr_input(program, user, template, values, &pay);
        self.call(program, &input)
    }

    /// Runs `account`'s scheduled operation `sequence`, once it is due.
    pub fn run_scheduled(&mut self, program: &Id, account: &Id, sequence: u64) -> Receipt {
        let input = [
            &hash("app/call-v1/run", b"")[..],
            account,
            &sequence.to_le_bytes(),
        ]
        .concat();
        self.call(program, &input)
    }

    /// `user` cancels its scheduled operations `sequences`, in increasing order.
    pub fn cancel(&mut self, program: &Id, user: &User, sequences: &[u64]) -> Receipt {
        let mut input = hash("app/call-v1/cancel", b"").to_vec();
        input.extend(user.policy);
        input.extend(framed(&user.params));
        input.extend(0u64.to_le_bytes());
        input.extend(framed(b""));
        input.extend((sequences.len() as u64).to_le_bytes());
        for s in sequences {
            input.extend(s.to_le_bytes());
        }
        self.call(program, &input)
    }
}

/// A module written in WebAssembly text, packed: for stub programs in tests.
pub fn wasm(text: &str) -> Vec<u8> {
    crate::pack(&wat::parse_str(text).expect("valid WebAssembly text")).expect("a module Ting accepts")
}

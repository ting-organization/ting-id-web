//! TCR-1, Ting Call Requests, the program's side (Ting wiki: standards/tcr-1).
//!
//! A page asks a user to do something in your program with a `ting:call`
//! link. The user's wallet, Ting ID, shows the operation in your program's own
//! words, signs it with the account the user picks, and submits the call. This
//! module checks that call: that the account approved exactly that operation,
//! with its nonce and deadline, through its policy or through a payment it made
//! for it; and it keeps the records and emits the events wallets and pages read.
//!
//! You write a [`Program`]: its templates, what it checks, what it does.
//! [`invoke`] does the rest:
//!
//! - the first invocation is the deployment: it writes the template list and
//!   calls [`Program::deploy`];
//! - a call is decoded exactly, its approval checked, the account's nonce
//!   moved on, a payment run through its coin, and then
//!   [`Program::execute`] does the operation and *executed* is emitted;
//! - an account with a delay, such as a Ting ID's Savings account, is refused,
//!   or with [`Program::SCHEDULES`] its operation is scheduled, to be run once
//!   due or cancelled meanwhile;
//! - any other input goes to [`Program::query`].
use crate::account;
use crate::bytes::{Reader, Writer, framed};
use crate::coin;
use crate::hash::{h, h_const};
use crate::host::{self, fail};
use alloc::vec::Vec;

/// A template declares an operation, its name and fields, then gives the
/// sentence, in the program's own words, that a wallet shows with the values
/// in it:
///
/// ```text
/// give(item:u64,to:account): Give item {item} to {to}
/// ```
///
/// A sentence that shows `{payment}` takes a payment from the acting account:
/// what the wallet shows there is what leaves the account. Field types:
/// `u8` `u16` `u32` `u64` `u128` `amount` `coin` `account` `bytes32` `time`
/// `duration` `text` `bytes`, `enum(a|b|c)`, and `list(name:type,…)` of those.
///
/// The text is what the wallet shows and what the hash covers: change one
/// space and it is another template.
pub struct Template {
    pub text: &'static str,
    /// `T = H("app/call-v1/template", text)`: what a call starts with.
    pub hash: [u8; 32],
    name_len: usize,
    pays: bool,
}

impl Template {
    /// Checks the template's shape when the program is compiled, and computes
    /// its hash.
    pub const fn new(text: &'static str) -> Self {
        let t = text.as_bytes();
        assert!(t.len() <= 512, "a template is at most 512 bytes");
        // The operation's name, up to its `(`.
        let mut i = 0;
        while i < t.len() && t[i] != b'(' {
            let c = t[i];
            assert!(
                c.is_ascii_lowercase() || (i > 0 && (c.is_ascii_digit() || c == b'_')),
                "an operation's name is a-z, then a-z, 0-9 and _"
            );
            i += 1;
        }
        assert!(i > 0 && i <= 32 && i < t.len(), "a template starts with name(");
        let name_len = i;
        // The declaration ends at the `)` that closes the one after the name.
        let mut depth = 0;
        while i < t.len() {
            if t[i] == b'(' {
                depth += 1;
            } else if t[i] == b')' {
                depth -= 1;
                if depth == 0 {
                    break;
                }
            }
            i += 1;
        }
        assert!(
            i + 3 < t.len() && t[i + 1] == b':' && t[i + 2] == b' ',
            "the declaration is followed by \": \" and a sentence"
        );
        // Whether the sentence shows the payment.
        let mut pays = false;
        let slot = b"{payment}";
        let mut s = i + 3;
        while s + slot.len() <= t.len() {
            let mut k = 0;
            while k < slot.len() && t[s + k] == slot[k] {
                k += 1;
            }
            if k == slot.len() {
                pays = true;
            }
            s += 1;
        }
        Template {
            text,
            hash: h_const(b"app/call-v1/template", t),
            name_len,
            pays,
        }
    }

    /// The operation's name: templates in several languages share it.
    pub fn name(&self) -> &'static str {
        &self.text[..self.name_len]
    }

    /// Whether the sentence shows `{payment}`, and so takes a payment.
    pub fn pays(&self) -> bool {
        self.pays
    }

    /// Everything up to and including `"): "`, which templates of the same
    /// operation share.
    fn declaration(&self) -> &'static [u8] {
        let t = self.text.as_bytes();
        let mut depth = 0;
        for (i, c) in t.iter().enumerate() {
            match c {
                b'(' => depth += 1,
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        return &t[..i + 3];
                    }
                }
                _ => {}
            }
        }
        fail(b"bad template")
    }
}

/// One operation of a call: its template and its values, decoded and checked
/// against the template's declaration.
pub struct Operation<'a> {
    pub template: &'static Template,
    /// The fields' bytes, in the order the template declares them.
    pub values: &'a [u8],
    /// `H("app/call-v1/operation", T ‖ values)`: what the *executed* event
    /// names, so a page that made the link finds it done.
    pub id: [u8; 32],
}

impl<'a> Operation<'a> {
    pub fn name(&self) -> &'static str {
        self.template.name()
    }

    /// A reader over the values, field by field in declared order. They were
    /// already checked against the declaration, so reading them cannot fail.
    pub fn values(&self) -> Reader<'a> {
        Reader::new(self.values, b"bad input")
    }
}

/// What a payment does in its coin.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    Transfer { to: [u8; 32], amount: u128 },
    Burn { amount: u128 },
}

/// A coin payment the acting account made for this one operation, checked to
/// be bound to it. The coin checks its signature when it runs.
pub struct Payment<'a> {
    /// The coin's ContractId, one [`Program::accepts`] and running the coin
    /// reference program.
    pub coin: [u8; 32],
    /// Always the acting account.
    pub payer: [u8; 32],
    pub effect: Effect,
    raw: &'a [u8],
}

impl Payment<'_> {
    pub fn amount(&self) -> u128 {
        match self.effect {
            Effect::Transfer { amount, .. } | Effect::Burn { amount } => amount,
        }
    }

    /// The recipient of a transfer; none for a burn.
    pub fn to(&self) -> Option<[u8; 32]> {
        match self.effect {
            Effect::Transfer { to, .. } => Some(to),
            Effect::Burn { .. } => None,
        }
    }
}

/// A program that takes TCR-1 calls.
pub trait Program {
    /// Every template the program accepts. Written to the template list when
    /// the program is deployed, and never changed: a wallet refuses a link
    /// whose template is not in the list.
    const TEMPLATES: &'static [Template];

    /// What an account with a delay gets, such as a Ting ID's Savings account,
    /// which makes everything wait so that a stolen key cannot act at once.
    /// `false`: its operations are refused outright. `true`: they are
    /// scheduled, run by anyone once due, and cancellable meanwhile. A program
    /// that holds assets for accounts should schedule: otherwise what such an
    /// account holds in it can never move.
    const SCHEDULES: bool = false;

    /// What [`Program::check`] hands to [`Program::execute`], such as a record
    /// it already read. `()` when there is nothing.
    type Checked;

    /// The deployment: `input` is the deployment transaction's. Store the
    /// program's configuration here, or revert to refuse a bad one.
    fn deploy(input: &[u8]);

    /// Whether the program takes payments and fee payments in `coin`. The coin
    /// must also run the coin reference program, which is checked apart.
    fn accepts(coin: &[u8; 32]) -> bool {
        let _ = coin;
        false
    }

    /// Any input that is not a call: the program's own reads, for instance.
    /// Its result is the invocation's.
    fn query(input: &[u8]) -> Vec<u8> {
        let _ = input;
        fail(b"bad input")
    }

    /// Checks that the operation can be done, before its approval, which
    /// costs most, is checked: revert with a reason when it cannot. For a
    /// template that shows `{payment}`, check the payment here: its coin, its
    /// amount, and for a transfer its recipient. A scheduled operation is
    /// checked again when it runs.
    fn check(op: &Operation, account: &[u8; 32], payment: Option<&Payment>) -> Self::Checked;

    /// Does the operation for `account`, once it is approved and paid, and
    /// nothing but what its template says.
    fn execute(op: &Operation, account: &[u8; 32], payment: Option<&Payment>, checked: Self::Checked);
}

const TAG_CALL: &[u8] = b"app/call-v1";
const TAG_OPERATION: &[u8] = b"app/call-v1/operation";
const TAG_SIGN: &[u8] = b"app/sign-v1";
/// `u64 count ‖ count × Bytes(template)`, for wallets to read.
pub const TEMPLATES_KEY: [u8; 32] = h_const(b"app/call-v1/templates", b"");
pub const RUN: [u8; 32] = h_const(b"app/call-v1/run", b"");
pub const CANCEL: [u8; 32] = h_const(b"app/call-v1/cancel", b"");
pub const SCHEDULED: [u8; 32] = h_const(b"app/call-v1/event/scheduled", b"");
pub const EXECUTED: [u8; 32] = h_const(b"app/call-v1/event/executed", b"");
pub const CANCELLED: [u8; 32] = h_const(b"app/call-v1/event/cancelled", b"");
/// Holds the digest of the call that is paying, only while it pays: the
/// coin's question `00` is answered from it.
const PAYING_KEY: [u8; 32] = h_const(b"ting-program/paying", b"");

/// An account's nonce in this program: the record's key.
pub fn nonce_key(account: &[u8; 32]) -> [u8; 32] {
    h(b"app/call-v1/nonce", &[account])
}

/// A scheduled operation's record: `u64 execute_at ‖ T ‖ values`.
pub fn scheduled_key(account: &[u8; 32], sequence: u64) -> [u8; 32] {
    h(b"app/call-v1/scheduled", &[account, &sequence.to_le_bytes()])
}

/// The program's entry: call it from `invoke`.
pub fn invoke<P: Program>() -> ! {
    let input = host::read_input();
    // The coin asks `00` while it runs a payment: answer the digest it is bound to.
    if input == [0x00] {
        if let Some(digest) = host::get_fixed::<32>(&PAYING_KEY) {
            host::finish(&digest);
        }
        if deployed() {
            fail(b"not running");
        }
    }
    if !deployed() {
        deploy::<P>(&input);
    }
    if input.len() >= 32 {
        let head: [u8; 32] = input[..32].try_into().unwrap();
        if head == RUN || head == CANCEL {
            if !P::SCHEDULES {
                fail(b"not scheduled");
            }
            if head == RUN {
                run::<P>(&input);
            }
            cancel(&input);
        }
        if let Some(template) = P::TEMPLATES.iter().find(|t| t.hash == head) {
            call::<P>(template, &input);
        }
    }
    host::finish(&P::query(&input))
}

fn deployed() -> bool {
    host::exists(&TEMPLATES_KEY)
}

fn deploy<P: Program>(input: &[u8]) -> ! {
    let templates = P::TEMPLATES;
    for (i, a) in templates.iter().enumerate() {
        for b in &templates[i + 1..] {
            if a.hash == b.hash {
                fail(b"a template is listed twice");
            }
            if a.name() == b.name() && a.declaration() != b.declaration() {
                fail(b"templates of one operation must share their declaration");
            }
        }
    }
    let mut list = Writer::new().u64(templates.len() as u64);
    for t in templates {
        list = list.bytes(t.text.as_bytes());
    }
    host::set(&TEMPLATES_KEY, &list.finish());
    P::deploy(input);
    host::finish(&[])
}

/// `T ‖ values ‖ auth ‖ payments`. `auth` is `00 ‖ policy(32) ‖ Bytes(params)
/// ‖ u64 nonce ‖ u64 valid_until ‖ Bytes(witness)` for a policy account, or
/// `01` for the calling program's own account; `payments` is `00`, or `01 ‖
/// coin(32) ‖ Bytes(coin input)`.
fn call<P: Program>(template: &'static Template, input: &[u8]) -> ! {
    let me = host::self_id();
    let mut r = Reader::new(input, b"bad input");
    r.take(32);
    read_values(template, &mut r);
    let end = r.position();
    let op = Operation {
        template,
        values: &input[32..end],
        id: h(TAG_OPERATION, &[&input[..end]]),
    };
    let signer = match r.u8() {
        0x00 => Some((r.id(), r.bytes(), r.u64(), r.u64(), r.bytes())),
        0x01 => None,
        _ => fail(b"bad input"),
    };
    let paid = match r.u8() {
        0x00 => None,
        0x01 => Some((r.id(), r.bytes())),
        _ => fail(b"bad input"),
    };
    r.end();

    let Some((policy, params, nonce, valid_until, witness)) = signer else {
        // A program acting as its own account, by calling: no nonce, no
        // deadline, no delay and no payment. It keeps its own rules.
        if paid.is_some() {
            fail(b"bad input");
        }
        let Some(caller) = host::caller() else {
            fail(b"no calling contract");
        };
        if template.pays() {
            fail(b"needs payment");
        }
        let account = account::contract(&caller);
        let checked = P::check(&op, &account, None);
        P::execute(&op, &account, None, checked);
        executed(&account, 0, &op.id);
        host::finish(&[]);
    };

    if template.pays() && paid.is_none() {
        fail(b"needs payment");
    }
    if valid_until != 0 && host::now() > valid_until {
        fail(b"expired");
    }
    let account = account::policy(&policy, params);
    let nonce_key = nonce_key(&account);
    if nonce != host::get_u64(&nonce_key) {
        fail(b"bad nonce");
    }
    let mut message = framed(TAG_CALL);
    for part in [
        &host::chain_id()[..],
        &me,
        &account,
        &[0x01],
        &nonce.to_le_bytes(),
        &valid_until.to_le_bytes(),
        &op.id,
    ] {
        message.extend_from_slice(part);
    }
    let digest = h(TAG_SIGN, &[&message]);
    // A payment comes from the acting account and is its approval: the coin
    // checks its signature over a message that holds `digest`. An operation
    // that moves no coins may take a fee payment, a transfer of 0 to the
    // program's own account that carries only the miner's fee.
    let payment = paid.map(|(coin, raw)| {
        if !P::accepts(&coin) {
            fail(b"bad coin");
        }
        coin::check(&coin);
        let payment = decode_payment(coin, raw, &me, &digest);
        if payment.payer != account {
            fail(b"bad payment");
        }
        let fee_only = Effect::Transfer {
            to: account::contract(&me),
            amount: 0,
        };
        if !template.pays() && payment.effect != fee_only {
            fail(b"bad payment");
        }
        if !witness.is_empty() {
            fail(b"bad input");
        }
        payment
    });

    // What the operation needs, checked before the approval, which costs most.
    let checked = P::check(&op, &account, payment.as_ref());

    let delay = match &payment {
        Some(_) => 0,
        None => authorize(&policy, params, &message, witness),
    };
    if delay > 0 && !P::SCHEDULES {
        fail(b"not authorized");
    }
    let Some(next) = nonce.checked_add(1) else {
        fail(b"nonce exhausted");
    };
    host::set(&nonce_key, &next.to_le_bytes());
    if delay > 0 {
        let execute_at = host::now().saturating_add(delay);
        let head = &input[..end];
        host::set(
            &scheduled_key(&account, nonce),
            &[&execute_at.to_le_bytes()[..], head].concat(),
        );
        let event = Writer::new()
            .put(&SCHEDULED)
            .put(&account)
            .u64(nonce)
            .u64(execute_at)
            .put(head);
        host::emit_event(&event.finish());
        host::finish(&[]);
    }
    if let Some(payment) = &payment {
        pay(payment, &digest);
    }
    P::execute(&op, &account, payment.as_ref(), checked);
    executed(&account, nonce, &op.id);
    host::finish(&[])
}

fn executed(account: &[u8; 32], sequence: u64, operation: &[u8; 32]) {
    let event = Writer::new()
        .put(&EXECUTED)
        .put(account)
        .u64(sequence)
        .put(operation);
    host::emit_event(&event.finish());
}

/// Asks a policy, read-only, whether it authorizes `message`: the delay it
/// requires, 0 for none (Ting wiki: programs/conventions, policy interface).
fn authorize(policy: &[u8; 32], params: &[u8], message: &[u8], witness: &[u8]) -> u64 {
    let input = [framed(params), framed(message), framed(witness)].concat();
    let (status, result) = host::call_child(policy, &input, host::READ_ONLY);
    if status != 0 {
        fail(b"not authorized");
    }
    match result.as_slice() {
        [1] => 0,
        [1, rest @ ..] if rest.len() == 8 => match u64::from_le_bytes(rest.try_into().unwrap()) {
            0 => fail(b"not authorized"),
            delay => delay,
        },
        _ => fail(b"not authorized"),
    }
}

/// Decodes a coin action, `10 ‖ 00 ‖ policy ‖ Bytes(params) ‖ u64 nonce ‖
/// Bytes(witness) ‖ effect ‖ fee ‖ tip ‖ not_before ‖ valid_until ‖ 01 ‖
/// program ‖ digest`, exactly as the coin will, and requires it to be bound to
/// this program and to `digest`.
fn decode_payment<'a>(coin: [u8; 32], raw: &'a [u8], me: &[u8; 32], digest: &[u8; 32]) -> Payment<'a> {
    let mut r = Reader::new(raw, b"bad payment");
    if r.u8() != 0x10 || r.u8() != 0x00 {
        fail(b"bad payment");
    }
    let policy = r.id();
    let params = r.bytes();
    r.u64();
    r.bytes();
    let effect = match r.u8() {
        1 => Effect::Transfer {
            to: r.id(),
            amount: r.u128(),
        },
        2 => Effect::Burn { amount: r.u128() },
        _ => fail(b"bad payment"),
    };
    // fee, tip, not_before and valid_until are the coin's to check
    r.take(16 + 16 + 8 + 8);
    if r.u8() != 1 || r.id() != *me || r.id() != *digest {
        fail(b"not bound");
    }
    r.end();
    Payment {
        coin,
        payer: account::policy(&policy, params),
        effect,
        raw,
    }
}

/// Runs a payment through its coin, answering the coin's question for the
/// digest meanwhile.
fn pay(payment: &Payment, digest: &[u8; 32]) {
    host::set(&PAYING_KEY, digest);
    let (status, result) = host::call_child(&payment.coin, payment.raw, host::ORDINARY);
    host::delete(&PAYING_KEY);
    if status != 0 {
        fail(&[b"payment: ".as_slice(), &result].concat());
    }
}

/// `RUN ‖ account(32) ‖ u64 sequence`: anyone may run a scheduled operation
/// once it is due, with the checks of that moment.
fn run<P: Program>(input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    r.take(32);
    let account = r.id();
    let sequence = r.u64();
    r.end();
    let key = scheduled_key(&account, sequence);
    let Some(stored) = host::get(&key) else {
        fail(b"not scheduled");
    };
    let mut s = Reader::new(&stored, b"corrupt");
    if host::now() < s.u64() {
        fail(b"not due");
    }
    let hash = s.id();
    let Some(template) = P::TEMPLATES.iter().find(|t| t.hash == hash) else {
        fail(b"corrupt");
    };
    read_values(template, &mut s);
    s.end();
    let op = Operation {
        template,
        values: &stored[40..],
        id: h(TAG_OPERATION, &[&stored[8..]]),
    };
    let checked = P::check(&op, &account, None);
    P::execute(&op, &account, None, checked);
    host::delete(&key);
    executed(&account, sequence, &op.id);
    host::finish(&[])
}

/// `CANCEL ‖ policy(32) ‖ Bytes(params) ‖ u64 valid_until ‖ Bytes(witness) ‖
/// u64 count ‖ count × u64 sequence`: never delayed, never needing a nonce.
fn cancel(input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    r.take(32);
    let policy = r.id();
    let params = r.bytes();
    let valid_until = r.u64();
    let witness = r.bytes();
    let count = r.u64();
    let list = r.items(count, 8);
    r.end();
    let sequences: Vec<u64> = list
        .chunks_exact(8)
        .map(|s| u64::from_le_bytes(s.try_into().unwrap()))
        .collect();
    if sequences.windows(2).any(|w| w[0] >= w[1]) {
        fail(b"bad input");
    }
    if valid_until != 0 && host::now() > valid_until {
        fail(b"expired");
    }
    let account = account::policy(&policy, params);
    let nonce = host::get_u64(&nonce_key(&account));
    let mut any = false;
    for s in &sequences {
        if *s >= nonce {
            fail(b"not scheduled");
        }
        any |= host::exists(&scheduled_key(&account, *s));
    }
    if !any {
        fail(b"not scheduled");
    }
    let mut message = framed(TAG_CALL);
    for part in [
        &host::chain_id()[..],
        &host::self_id(),
        &account,
        &[0x02],
        &valid_until.to_le_bytes(),
        &count.to_le_bytes(),
        list,
    ] {
        message.extend_from_slice(part);
    }
    authorize(&policy, params, &message, witness);
    for s in sequences {
        let key = scheduled_key(&account, s);
        if host::exists(&key) {
            host::delete(&key);
            let event = Writer::new().put(&CANCELLED).put(&account).u64(s);
            host::emit_event(&event.finish());
        }
    }
    host::finish(&[])
}

// ---- Values, read as the declaration says ---------------------------------------

enum Field {
    Fixed(usize),
    Bytes,
    Text,
    Enum(usize),
    List(Vec<Field>),
}

/// Reads an operation's values exactly as its template declares them: every
/// field, an enum index within its labels, a text in UTF-8, a list's items.
fn read_values(template: &Template, r: &mut Reader) {
    let text = template.text.as_bytes();
    let mut at = template.name_len + 1;
    for field in &fields(text, &mut at) {
        read_field(field, r);
    }
}

fn read_field(field: &Field, r: &mut Reader) {
    match field {
        Field::Fixed(n) => {
            r.take(*n);
        }
        Field::Bytes => {
            r.bytes();
        }
        Field::Text => {
            r.text();
        }
        Field::Enum(labels) => {
            if r.u8() as usize >= *labels {
                r.refuse();
            }
        }
        Field::List(item) => {
            // Every item takes at least a byte, so a count past what is left
            // fails as soon as the bytes run out.
            for _ in 0..r.u64() {
                for f in item {
                    read_field(f, r);
                }
            }
        }
    }
}

/// The fields from `at`, just after a `(`, to its `)`.
fn fields(t: &[u8], at: &mut usize) -> Vec<Field> {
    let mut out = Vec::new();
    if t[*at] == b')' {
        *at += 1;
        return out;
    }
    loop {
        while t[*at] != b':' {
            *at += 1;
        }
        *at += 1;
        out.push(field(t, at));
        match t[*at] {
            b',' => *at += 1,
            b')' => {
                *at += 1;
                return out;
            }
            _ => fail(b"bad template"),
        }
    }
}

fn field(t: &[u8], at: &mut usize) -> Field {
    let start = *at;
    while !matches!(t[*at], b',' | b')' | b'(') {
        *at += 1;
    }
    match &t[start..*at] {
        b"u8" => Field::Fixed(1),
        b"u16" => Field::Fixed(2),
        b"u32" => Field::Fixed(4),
        b"u64" | b"time" | b"duration" => Field::Fixed(8),
        b"u128" => Field::Fixed(16),
        b"coin" | b"account" | b"bytes32" => Field::Fixed(32),
        b"amount" => Field::Fixed(48),
        b"text" => Field::Text,
        b"bytes" => Field::Bytes,
        b"enum" => {
            let mut labels = 1;
            *at += 1;
            while t[*at] != b')' {
                if t[*at] == b'|' {
                    labels += 1;
                }
                *at += 1;
            }
            *at += 1;
            Field::Enum(labels)
        }
        b"list" => {
            *at += 1;
            Field::List(fields(t, at))
        }
        _ => fail(b"bad template"),
    }
}

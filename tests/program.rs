//! policy-webauthn on Ting's reference VM, with assertions made as a browser and
//! an authenticator make them: checked directly, and as the key of an identity
//! paying through the real coin and the real identity registry.
//! Build first: `./build.sh`, then `cargo test`.
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD, URL_SAFE, URL_SAFE_NO_PAD};
use p256::ecdsa::signature::hazmat::{PrehashSigner, PrehashVerifier};
use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::PrimeField;
use p256::elliptic_curve::ops::Reduce;
use p256::elliptic_curve::point::AffineCoordinates;
use p256::elliptic_curve::scalar::IsHigh;
use p256::elliptic_curve::sec1::{FromEncodedPoint, ToEncodedPoint};
use p256::{AffinePoint, EncodedPoint, FieldBytes, ProjectivePoint, Scalar, U256};
use sha2::{Digest, Sha256};
use ting_kit_tools::Id;
use ting_kit_tools::testing::{Receipt, TestChain, framed, h, ok, reverts};

const YES: &[u8] = &[1];
const NO: &[u8] = &[0];

/// User present and user verified, the flags every accepted assertion has.
const UP: u8 = 0x01;
const UV: u8 = 0x04;
/// Backup eligible and backed up: a synced passkey (iCloud Keychain, Google
/// Password Manager).
const BE_BS: u8 = 0x08 | 0x10;
/// Extension data follows the fixed part.
const ED: u8 = 0x80;

/// The order of P-256, n.
const N: &str = "ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551";
/// Its field's prime, p.
const P: &str = "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff";

const ORIGIN: &str = r#","origin":"https://wallet.example","crossOrigin":false"#;
/// What Chrome sometimes appends to clientDataJSON.
const CHROME_EXTRA: &str = r#","other_keys_can_be_added_here":"do not compare clientDataJSON against a template. See https://goo.gl/yabPex""#;

fn policy_wasm() -> Vec<u8> {
    std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../program.wasm"))
        .expect("program.wasm: run ./build.sh first")
}

/// A reference program of the kit, byte for byte.
fn reference(name: &str) -> Vec<u8> {
    std::fs::read(format!(
        "{}/../kit/programs/{name}.wasm",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

fn sha256(x: &[u8]) -> [u8; 32] {
    Sha256::digest(x).into()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// A message as applications write them: their tag, then what is signed.
fn message(text: &str) -> Vec<u8> {
    [framed(b"app/test-v1"), text.as_bytes().to_vec()].concat()
}

/// The signing digest of `message`.
fn digest(message: &[u8]) -> Id {
    h("app/sign-v1", &[message])
}

/// The challenge a wallet passes to `navigator.credentials.get`, as the browser
/// writes it into clientDataJSON: base64url without padding.
fn challenge(message: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(digest(message))
}

/// clientDataJSON as browsers serialise it: type, challenge, then `tail`.
fn client_data(kind: &str, challenge: &str, tail: &str) -> Vec<u8> {
    format!(r#"{{"type":"{kind}","challenge":"{challenge}"{tail}}}"#).into_bytes()
}

/// `rpIdHash ‖ flags ‖ signCount`, as the authenticator writes it.
fn auth_data(flags: u8) -> Vec<u8> {
    [
        &sha256(b"wallet.example")[..],
        &[flags],
        &7u32.to_be_bytes(),
    ]
    .concat()
}

/// A passkey: a P-256 key in an authenticator.
struct Passkey(SigningKey);

impl Passkey {
    fn new(seed: u8) -> Self {
        Passkey(SigningKey::from_slice(&[seed; 32]).unwrap())
    }

    /// The policy's params: the public key, uncompressed.
    fn params(&self) -> Vec<u8> {
        self.0
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec()
    }

    /// What the authenticator signs, ECDSA with SHA-256 over
    /// `authenticatorData ‖ SHA-256(clientDataJSON)`, as the wallet submits
    /// it: `r ‖ s`, with S made low.
    fn sign(&self, auth_data: &[u8], client_data: &[u8]) -> [u8; 64] {
        let signature: Signature = self.0.sign(&[auth_data, &sha256(client_data)].concat());
        signature
            .normalize_s()
            .unwrap_or(signature)
            .to_bytes()
            .as_slice()
            .try_into()
            .unwrap()
    }

    /// An assertion of `auth_data` and `client_data`, signed.
    fn assertion(&self, auth_data: Vec<u8>, client_data: Vec<u8>) -> Assertion {
        let signature = self.sign(&auth_data, &client_data);
        Assertion {
            auth_data,
            client_data,
            signature,
        }
    }

    /// The assertion a browser returns for `message`, with user verification.
    fn assert(&self, message: &[u8]) -> Assertion {
        self.assertion(
            auth_data(UP | UV),
            client_data("webauthn.get", &challenge(message), ORIGIN),
        )
    }
}

struct Assertion {
    auth_data: Vec<u8>,
    client_data: Vec<u8>,
    signature: [u8; 64],
}

impl Assertion {
    /// `Bytes(authenticatorData) ‖ Bytes(clientDataJSON) ‖ r ‖ s`.
    fn witness(&self) -> Vec<u8> {
        [
            framed(&self.auth_data),
            framed(&self.client_data),
            self.signature.to_vec(),
        ]
        .concat()
    }

    /// The same, with the signature's scalars replaced.
    fn with_signature(&self, r: &[u8], s: &[u8]) -> Vec<u8> {
        [
            framed(&self.auth_data),
            framed(&self.client_data),
            r.to_vec(),
            s.to_vec(),
        ]
        .concat()
    }
}

/// The policy query: `Bytes(params) ‖ Bytes(message) ‖ Bytes(witness)`.
fn query(params: &[u8], message: &[u8], witness: &[u8]) -> Vec<u8> {
    [framed(params), framed(message), framed(witness)].concat()
}

/// A chain with policy-webauthn deployed, with empty input.
struct Fixture {
    chain: TestChain,
    policy: Id,
}

fn fixture() -> Fixture {
    let mut chain = TestChain::new();
    let policy = chain.deploy(&policy_wasm(), &[]);
    Fixture { chain, policy }
}

impl Fixture {
    /// The policy's answer to `input`: the call must succeed and emit nothing.
    #[track_caller]
    fn answer(&mut self, input: &[u8]) -> Vec<u8> {
        let r = self.chain.call(&self.policy, input);
        ok(&r);
        assert!(r.events.is_empty());
        r.result
    }

    #[track_caller]
    fn check(&mut self, params: &[u8], message: &[u8], witness: &[u8]) -> Vec<u8> {
        self.answer(&query(params, message, witness))
    }
}

// ---- Deployment -------------------------------------------------------------

#[test]
fn deploys_with_empty_input_and_answers_it_with_nothing() {
    let mut chain = TestChain::new();
    let r = chain.try_deploy(&policy_wasm(), &[]);
    ok(&r);
    assert!(r.events.is_empty());
    let policy: Id = r.result.try_into().unwrap();
    let r = chain.call(&policy, &[]);
    ok(&r);
    assert!(r.result.is_empty() && r.events.is_empty());
}

// ---- What it accepts --------------------------------------------------------

#[test]
fn a_valid_assertion_authorizes() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    assert_eq!(f.check(&key.params(), &m, &key.assert(&m).witness()), YES);
}

#[test]
fn chrome_extra_key_authorizes() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let tail = format!("{ORIGIN}{CHROME_EXTRA}");
    let a = key.assertion(
        auth_data(UP | UV),
        client_data("webauthn.get", &challenge(&m), &tail),
    );
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
}

#[test]
fn a_cross_origin_assertion_authorizes() {
    // An iframe's assertion: crossOrigin true and topOrigin after it.
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let tail = r#","origin":"https://wallet.example","crossOrigin":true,"topOrigin":"https://shop.example""#;
    let a = key.assertion(
        auth_data(UP | UV),
        client_data("webauthn.get", &challenge(&m), tail),
    );
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
}

#[test]
fn the_challenge_may_end_the_object() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let a = key.assertion(
        auth_data(UP | UV),
        client_data("webauthn.get", &challenge(&m), ""),
    );
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
}

#[test]
fn origin_and_relying_party_are_not_checked() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let tail = r#","origin":"https://elsewhere.example","crossOrigin":false"#;
    let mut data = auth_data(UP | UV);
    data[..32].copy_from_slice(&sha256(b"elsewhere.example"));
    let a = key.assertion(data, client_data("webauthn.get", &challenge(&m), tail));
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
}

#[test]
fn synced_passkeys_and_extensions_authorize() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let json = client_data("webauthn.get", &challenge(&m), ORIGIN);
    // Backup flags, as Apple's and Google's passkeys set them.
    let a = key.assertion(auth_data(UP | UV | BE_BS), json.clone());
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
    // Extension outputs after the fixed part: {"credProtect": 2} in CBOR.
    let mut data = auth_data(UP | UV | ED);
    data.extend(unhex("a16b6372656450726f7465637402"));
    let a = key.assertion(data, json);
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
}

// ---- Wrong message, wrong key -----------------------------------------------

#[test]
fn a_wrong_message_is_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let a = key.assert(&message("pay bob 5"));
    assert_eq!(
        f.check(&key.params(), &message("pay bob 500"), &a.witness()),
        NO
    );
}

#[test]
fn a_wrong_key_is_refused() {
    let mut f = fixture();
    let (key, other) = (Passkey::new(1), Passkey::new(2));
    let m = message("pay bob 5");
    assert_eq!(f.check(&other.params(), &m, &key.assert(&m).witness()), NO);
}

// ---- The signature's scalars ------------------------------------------------

/// `n − s`, the other S of a signature.
fn negate(s: &[u8]) -> Vec<u8> {
    let n = unhex(N);
    let mut out = vec![0; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let d = n[i] as i16 - s[i] as i16 - borrow;
        out[i] = d.rem_euclid(256) as u8;
        borrow = (d < 0) as i16;
    }
    out
}

#[test]
fn a_high_s_is_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let a = key.assert(&m);
    let (r, s) = a.signature.split_at(32);
    let high = negate(s);
    // The high form is a valid ECDSA signature all the same.
    let signed = [&a.auth_data[..], &sha256(&a.client_data)].concat();
    let sig = Signature::from_scalars(
        <[u8; 32]>::try_from(r).unwrap(),
        <[u8; 32]>::try_from(&high[..]).unwrap(),
    )
    .unwrap();
    key.0.verifying_key().verify(&signed, &sig).unwrap();
    assert_eq!(f.check(&key.params(), &m, &a.with_signature(r, &high)), NO);
    assert_eq!(f.check(&key.params(), &m, &a.with_signature(r, s)), YES);
}

/// A key for which `(r, s)`, with this `s`, is a valid signature over `e`:
/// pick the nonce, then solve `s = k⁻¹ (e + r d)` for the secret `d`.
fn key_signing_with(s: Scalar, e: &[u8; 32]) -> (SigningKey, [u8; 32], [u8; 32]) {
    let k = Scalar::from(0x5eed_u64);
    let r =
        <Scalar as Reduce<U256>>::reduce_bytes(&(ProjectivePoint::GENERATOR * k).to_affine().x());
    let e = <Scalar as Reduce<U256>>::reduce_bytes(&FieldBytes::from(*e));
    let d = (s * k - e) * r.invert().unwrap();
    let key = SigningKey::from_bytes(&d.to_repr()).unwrap();
    (key, r.to_repr().into(), s.to_repr().into())
}

#[test]
fn s_is_accepted_up_to_half_the_order() {
    let mut f = fixture();
    let m = message("pay bob 5");
    let data = auth_data(UP | UV);
    let json = client_data("webauthn.get", &challenge(&m), ORIGIN);
    let e = sha256(&[&data[..], &sha256(&json)].concat());
    let half = Scalar::from(2u64).invert().unwrap(); // (n + 1) / 2
    for (s, answer) in [(-half, YES), (half, NO)] {
        let (key, r, s) = key_signing_with(s, &e);
        let sig = Signature::from_scalars(r, s).unwrap();
        key.verifying_key().verify_prehash(&e, &sig).unwrap();
        let witness = [framed(&data), framed(&json), r.to_vec(), s.to_vec()].concat();
        let params = key
            .verifying_key()
            .to_encoded_point(false)
            .as_bytes()
            .to_vec();
        assert_eq!(f.check(&params, &m, &witness), answer);
    }
    assert_eq!(
        -half,
        Scalar::from_repr(*FieldBytes::from_slice(&unhex(
            "7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8"
        )))
        .unwrap()
    );
}

#[test]
fn scalars_out_of_range_are_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let a = key.assert(&m);
    let (r, s) = a.signature.split_at(32);
    let (zero, n, max) = (vec![0u8; 32], unhex(N), vec![0xff; 32]);
    let mut n_plus_1 = unhex(N);
    n_plus_1[31] += 1;
    for (r, s) in [
        (&zero[..], s),
        (r, &zero[..]),
        (&n[..], s),
        (r, &n[..]),
        (&n_plus_1[..], s),
        (r, &n_plus_1[..]),
        (&max[..], s),
        (r, &max[..]),
        (s, r),
    ] {
        assert_eq!(f.check(&key.params(), &m, &a.with_signature(r, s)), NO);
    }
}

// ---- The flags --------------------------------------------------------------

#[test]
fn user_verification_is_required() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let json = client_data("webauthn.get", &challenge(&m), ORIGIN);
    let a = key.assertion(auth_data(UP), json.clone());
    assert_eq!(f.check(&key.params(), &m, &a.witness()), NO);
    // Setting UV afterwards breaks the signature.
    let mut forged = a;
    forged.auth_data[32] |= UV;
    assert_eq!(f.check(&key.params(), &m, &forged.witness()), NO);
    let a = key.assertion(auth_data(UP | BE_BS), json);
    assert_eq!(f.check(&key.params(), &m, &a.witness()), NO);
}

#[test]
fn user_presence_is_required() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let json = client_data("webauthn.get", &challenge(&m), ORIGIN);
    for flags in [UV, 0, UV | BE_BS] {
        let a = key.assertion(auth_data(flags), json.clone());
        assert_eq!(f.check(&key.params(), &m, &a.witness()), NO);
    }
}

// ---- clientDataJSON ---------------------------------------------------------

#[test]
fn a_registration_is_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    for kind in ["webauthn.create", "webauthn.GET", "payment.get"] {
        let a = key.assertion(
            auth_data(UP | UV),
            client_data(kind, &challenge(&m), ORIGIN),
        );
        assert_eq!(f.check(&key.params(), &m, &a.witness()), NO);
    }
}

#[test]
fn the_challenge_must_be_the_digest_in_base64url_without_padding() {
    let mut f = fixture();
    let key = Passkey::new(1);
    // A message whose digest's base64url has a `-` or `_`, so that standard
    // base64 differs from it.
    let m = (0..)
        .map(|i| message(&format!("pay bob {i}")))
        .find(|m| challenge(m).contains(['-', '_']))
        .unwrap();
    let d = digest(&m);
    let good = challenge(&m);
    // The last character carries four bits and two zero bits: one with a
    // non-zero bit decodes to the same bytes in lenient decoders.
    const ALPHABET: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let last = ALPHABET.find(good.chars().last().unwrap()).unwrap();
    assert_eq!(last & 3, 0);
    let lenient = format!("{}{}", &good[..42], &ALPHABET[last | 1..][..1]);
    let hex: String = d.iter().map(|b| format!("{b:02x}")).collect();
    for wrong in [
        URL_SAFE.encode(d),
        STANDARD_NO_PAD.encode(d),
        STANDARD.encode(d),
        hex,
        lenient,
        good[..42].to_string(),
        URL_SAFE_NO_PAD.encode(sha256(&m)),
        URL_SAFE_NO_PAD.encode(&m),
        String::new(),
    ] {
        let a = key.assertion(
            auth_data(UP | UV),
            client_data("webauthn.get", &wrong, ORIGIN),
        );
        assert_eq!(
            f.check(&key.params(), &m, &a.witness()),
            NO,
            "challenge {wrong}"
        );
    }
    let a = key.assertion(
        auth_data(UP | UV),
        client_data("webauthn.get", &good, ORIGIN),
    );
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
}

#[test]
fn client_data_must_be_laid_out_as_browsers_write_it() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let c = challenge(&m);
    for json in [
        // Another order of keys, spaces, a missing quote, nothing after it.
        format!(r#"{{"challenge":"{c}","type":"webauthn.get"{ORIGIN}}}"#),
        format!(r#"{{"type": "webauthn.get", "challenge": "{c}"{ORIGIN}}}"#),
        format!(r#"{{"type":"webauthn.get","challenge":"{c}{ORIGIN}}}"#),
        format!(r#"{{"type":"webauthn.get","challenge":"{c}""#),
        format!(r#"{{"type":"webauthn.get","challenge":"{c}" {ORIGIN}}}"#),
        format!(r#"{{"type":"webauthn.get","challenge":"{c}x"{ORIGIN}}}"#),
        format!(r#"{{"type":"webauthn.get","challenge":"{c}"]"#),
        format!(r#"{{"type":"webauthn.get","challenge":"{c}"#),
        r#"{"type":"webauthn.get","challenge":"#.to_string(),
        format!(r#" {{"type":"webauthn.get","challenge":"{c}"{ORIGIN}}}"#),
        String::new(),
    ] {
        let a = key.assertion(auth_data(UP | UV), json.clone().into_bytes());
        assert_eq!(f.check(&key.params(), &m, &a.witness()), NO, "{json}");
    }
}

// ---- Tampering --------------------------------------------------------------

#[test]
fn tampered_authenticator_data_is_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let a = key.assert(&m);
    for (at, bit) in [(0, 1), (31, 0x80), (32, BE_BS), (33, 1), (36, 1)] {
        let mut t = key.assert(&m);
        t.auth_data[at] ^= bit;
        assert_eq!(f.check(&key.params(), &m, &t.witness()), NO);
    }
    // Bytes added after the fixed part, or the fixed part cut short.
    let mut t = key.assert(&m);
    t.auth_data.push(0);
    assert_eq!(f.check(&key.params(), &m, &t.witness()), NO);
    let t = key.assertion(a.auth_data[..36].to_vec(), a.client_data.clone());
    assert_eq!(f.check(&key.params(), &m, &t.witness()), NO);
    let t = key.assertion(Vec::new(), a.client_data.clone());
    assert_eq!(f.check(&key.params(), &m, &t.witness()), NO);
    assert_eq!(f.check(&key.params(), &m, &a.witness()), YES);
}

#[test]
fn client_data_changed_after_signing_is_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let c = challenge(&m);
    let signed = key.assert(&m);
    // Everything after the challenge is free in form, but signed: changing it
    // breaks the signature.
    for json in [
        client_data(
            "webauthn.get",
            &c,
            r#","origin":"https://evil.example","crossOrigin":false"#,
        ),
        client_data("webauthn.get", &c, &format!("{ORIGIN}{CHROME_EXTRA}")),
        client_data("webauthn.get", &c, ""),
        [signed.client_data.clone(), b" ".to_vec()].concat(),
    ] {
        let t = Assertion {
            client_data: json,
            ..key.assert(&m)
        };
        assert_eq!(f.check(&key.params(), &m, &t.witness()), NO);
    }
    assert_eq!(f.check(&key.params(), &m, &signed.witness()), YES);
}

// ---- Framing ----------------------------------------------------------------

#[test]
fn a_witness_that_does_not_decode_exactly_is_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let a = key.assert(&m);
    let w = a.witness();
    let long_len = [&(a.auth_data.len() as u32 + 1).to_le_bytes()[..], &w[4..]].concat();
    let huge_len = [&u32::MAX.to_le_bytes()[..], &w[4..]].concat();
    for witness in [
        w[..w.len() - 1].to_vec(),
        [&w[..], &[0]].concat(),
        long_len,
        huge_len,
        a.signature.to_vec(), // policy-p256's witness, r ‖ s alone
        Vec::new(),
    ] {
        assert_eq!(f.check(&key.params(), &m, &witness), NO);
    }
    assert_eq!(f.check(&key.params(), &m, &w), YES);
}

#[test]
fn a_malformed_query_reverts_like_policy_p256() {
    let mut f = fixture();
    let p256 = f.chain.deploy(&reference("policy-p256"), &[]);
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let q = query(&key.params(), &m, &key.assert(&m).witness());
    // Not exactly three Bytes fields: a revert, with policy-p256's reason.
    for input in [
        [&q[..], &[0]].concat(),
        q[..q.len() - 1].to_vec(),
        [framed(&key.params()), framed(&m)].concat(),
        framed(&key.params()),
        [&u32::MAX.to_le_bytes()[..], &q[4..]].concat(),
        vec![0],
        vec![0; 3],
    ] {
        reverts(&f.chain.call(&f.policy, &input), "bad input");
        reverts(&f.chain.call(&p256, &input), "bad input");
    }
    // Three fields whose content is wrong: an answer, 00.
    for input in [vec![0; 12], query(&key.params(), &m, &[1, 2, 3])] {
        assert_eq!(f.answer(&input), NO);
        let r = f.chain.call(&p256, &input);
        ok(&r);
        assert_eq!(r.result, NO);
    }
    assert_eq!(f.answer(&q), YES);
}

#[test]
fn params_other_than_an_uncompressed_key_are_refused() {
    let mut f = fixture();
    let key = Passkey::new(1);
    let m = message("pay bob 5");
    let w = key.assert(&m).witness();
    let params = key.params();
    let compressed = key
        .0
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();
    let with = |prefix: u8| [&[prefix][..], &params[1..]].concat();
    let mut off_curve = params.clone();
    off_curve[64] ^= 1;
    let x_too_big = [&[4][..], &unhex(P), &params[33..]].concat();
    for wrong in [
        params[1..].to_vec(),
        [&params[..], &[0]].concat(),
        compressed,
        with(0x05),
        with(0x06),
        with(0x07),
        with(0x00),
        off_curve,
        x_too_big,
        [&[4][..], &[0; 64][..]].concat(),
        Vec::new(),
    ] {
        assert_eq!(f.check(&wrong, &m, &w), NO);
    }
    assert_eq!(f.check(&params, &m, &w), YES);
}

// ---- As the key of an identity, paying through the coin ---------------------

fn policy_account(policy: &Id, params: &[u8]) -> Id {
    h("app/account-v1/policy", &[policy, &framed(params)])
}

/// A plain transfer: `01 ‖ to ‖ amount ‖ fee 0 ‖ tip 0 ‖ not_before 0 ‖
/// valid_until 0 ‖ within 00` (Ting wiki: programs/coin).
fn transfer(to: &Id, amount: u128) -> Vec<u8> {
    [
        &[1][..],
        to,
        &amount.to_le_bytes(),
        &[0; 16 + 16 + 8 + 8],
        &[0],
    ]
    .concat()
}

/// The message a policy account signs for `action` in `coin`.
fn coin_message(chain: &TestChain, coin: &Id, account: &Id, nonce: u64, action: &[u8]) -> Vec<u8> {
    [
        &framed(b"app/coin-v1")[..],
        &chain.chain_id(),
        coin,
        account,
        &[0x10],
        &nonce.to_le_bytes(),
        action,
    ]
    .concat()
}

/// `10 ‖ auth ‖ action`, with `auth = 00 ‖ policy ‖ Bytes(params) ‖ u64 nonce ‖ Bytes(witness)`.
fn coin_execute(policy: &Id, params: &[u8], nonce: u64, witness: &[u8], action: &[u8]) -> Vec<u8> {
    [
        &[0x10, 0][..],
        policy,
        &framed(params),
        &nonce.to_le_bytes(),
        &framed(witness),
        action,
    ]
    .concat()
}

fn coin_nonce(chain: &TestChain, coin: &Id, account: &Id) -> u64 {
    chain
        .record(coin, account)
        .map_or(0, |r| u64::from_le_bytes(r[32..40].try_into().unwrap()))
}

/// Creates an identity with one key, `policy` and `params`, and two slots,
/// spending and savings, as Ting ID does; its spending slot's params.
fn create_identity(chain: &mut TestChain, registry: &Id, policy: &Id, params: &[u8]) -> Vec<u8> {
    let creation = [
        &[1][..],            // version
        &1u64.to_le_bytes(), // one key
        policy,
        &framed(params),
        &0u64.to_le_bytes(),       // no guardians
        &0u64.to_le_bytes(),       // threshold
        &600u64.to_le_bytes(),     // change delay
        &300u64.to_le_bytes(),     // recovery delay
        &2u64.to_le_bytes(),       // two slots:
        &0u64.to_le_bytes(),       //   spending, at once
        &604_800u64.to_le_bytes(), //   savings, a week
        &[0x5a; 32],               // salt
    ]
    .concat();
    let r = chain.call(registry, &[&[1][..], &creation].concat());
    ok(&r);
    let id = h("app/id-v1/id", &[&creation]);
    assert_eq!(r.result, id);
    [&id[..], &0u64.to_le_bytes()].concat()
}

/// An identity's witness: `u64 key_id ‖ Bytes(the key's witness)`.
fn key_auth(key_id: u64, witness: &[u8]) -> Vec<u8> {
    [&key_id.to_le_bytes()[..], &framed(witness)].concat()
}

#[test]
fn an_identity_pays_with_a_passkey() {
    let mut chain = TestChain::new();
    let policy = chain.deploy(&policy_wasm(), &[]);
    let registry = chain.deploy(&reference("id-registry"), &[]);
    let key = Passkey::new(1);
    let slot = create_identity(&mut chain, &registry, &policy, &key.params());
    let account = policy_account(&registry, &slot);
    let bob = chain.user("bob").account();
    let dlr = chain.coin("DLR", 8, &[(&account, 1_000)]);

    let action = transfer(&bob, 250);
    let message = coin_message(&chain, &dlr, &account, 0, &action);
    let pay = |witness: &[u8]| coin_execute(&registry, &slot, 0, &key_auth(0, witness), &action);

    // A wrong signature: another passkey's, one for another amount, and a
    // corrupted one.
    let other = Passkey::new(2).assert(&message).witness();
    let other_amount = key
        .assert(&coin_message(
            &chain,
            &dlr,
            &account,
            0,
            &transfer(&bob, 300),
        ))
        .witness();
    let mut corrupted = key.assert(&message);
    corrupted.signature[63] ^= 1;
    for witness in [other, other_amount, corrupted.witness()] {
        reverts(&chain.call(&dlr, &pay(&witness)), "not authorized");
    }
    assert_eq!(chain.balance(&dlr, &account), 1_000);
    assert_eq!(coin_nonce(&chain, &dlr, &account), 0);

    let input = pay(&key.assert(&message).witness());
    ok(&chain.call(&dlr, &input));
    assert_eq!(chain.balance(&dlr, &account), 750);
    assert_eq!(chain.balance(&dlr, &bob), 250);
    assert_eq!(coin_nonce(&chain, &dlr, &account), 1);
    reverts(&chain.call(&dlr, &input), "bad nonce");
}

// ---- Costs ------------------------------------------------------------------

/// policy-p256's witness: `r ‖ s` over the signing digest itself.
fn p256_witness(key: &SigningKey, message: &[u8]) -> Vec<u8> {
    let signature: Signature = key.sign_prehash(&digest(message)).unwrap();
    signature
        .normalize_s()
        .unwrap_or(signature)
        .to_bytes()
        .to_vec()
}

fn show(what: &str, r: &Receipt) {
    ok(r);
    let [c, s, d, g] = r.used.0;
    println!("{what:<46} C {c:>11}  S {s:>4}  D {d:>7}  G {g:>5}");
}

/// Prints what checks and transfers cost, next to policy-p256's:
/// `cargo test --release costs -- --nocapture`.
#[test]
fn costs() {
    let mut chain = TestChain::new();
    let r = chain.try_deploy(&policy_wasm(), &[]);
    show("deployment, policy-webauthn", &r);
    // Within the budget the reference programs are deployed with
    // (kit/scripts/chain.mjs, DEPLOY_BUDGET), which scripts/deploy.mjs uses.
    let deploy_budget = [50_000_000, 64, 16_777_216, 16_777_216];
    assert!((0..4).all(|i| r.used.0[i] <= deploy_budget[i]));
    let webauthn: Id = r.result.try_into().unwrap();
    let p256 = chain.deploy(&reference("policy-p256"), &[]);
    let registry = chain.deploy(&reference("id-registry"), &[]);
    let passkey = Passkey::new(1);
    let device = SigningKey::from_slice(&[3; 32]).unwrap();
    let device_params = device
        .verifying_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec();
    let bob = chain.user("bob").account();

    let m = message("pay bob 5");
    let r = chain.call(
        &webauthn,
        &query(&passkey.params(), &m, &passkey.assert(&m).witness()),
    );
    assert_eq!(r.result, YES);
    show("policy check, policy-webauthn", &r);
    let r = chain.call(
        &p256,
        &query(&device_params, &m, &p256_witness(&device, &m)),
    );
    assert_eq!(r.result, YES);
    show("policy check, policy-p256", &r);

    // Plain transfers from a policy account of each.
    let wa_account = policy_account(&webauthn, &passkey.params());
    let p_account = policy_account(&p256, &device_params);
    let wa_slot = create_identity(&mut chain, &registry, &webauthn, &passkey.params());
    let p_slot = create_identity(&mut chain, &registry, &p256, &device_params);
    let wa_id = policy_account(&registry, &wa_slot);
    let p_id = policy_account(&registry, &p_slot);
    // Bob holds some already, so that no transfer pays for his new record.
    let holders: [(&dyn ting_kit_tools::testing::AsAccount, u128); 5] = [
        (&wa_account, 1_000),
        (&p_account, 1_000),
        (&wa_id, 1_000),
        (&p_id, 1_000),
        (&bob, 1),
    ];
    let dlr = chain.coin("DLR", 8, &holders);
    let action = transfer(&bob, 5);

    let msg = coin_message(&chain, &dlr, &wa_account, 0, &action);
    let input = coin_execute(
        &webauthn,
        &passkey.params(),
        0,
        &passkey.assert(&msg).witness(),
        &action,
    );
    show(
        "transfer, policy-webauthn account",
        &chain.call(&dlr, &input),
    );
    let msg = coin_message(&chain, &dlr, &p_account, 0, &action);
    let input = coin_execute(
        &p256,
        &device_params,
        0,
        &p256_witness(&device, &msg),
        &action,
    );
    show("transfer, policy-p256 account", &chain.call(&dlr, &input));

    let msg = coin_message(&chain, &dlr, &wa_id, 0, &action);
    let witness = key_auth(0, &passkey.assert(&msg).witness());
    show(
        "transfer, identity with a policy-webauthn key",
        &chain.call(
            &dlr,
            &coin_execute(&registry, &wa_slot, 0, &witness, &action),
        ),
    );
    let msg = coin_message(&chain, &dlr, &p_id, 0, &action);
    let witness = key_auth(0, &p256_witness(&device, &msg));
    show(
        "transfer, identity with a policy-p256 key",
        &chain.call(
            &dlr,
            &coin_execute(&registry, &p_slot, 0, &witness, &action),
        ),
    );
}

// ---- Differential: the policy against p256's own ECDSA verification --------
//
// The policy combines p256's arithmetic into ECDSA's verification equation in
// its own code (program/src/verify.rs). These tests compare its answers with
// p256's `VerifyingKey::verify_prehash`, plus policy-p256's key form and low-S
// rule and the WebAuthn checks written again here: natively, on the same
// source compiled for this machine, and on the VM, through the packed module.
// The cases come from a seeded generator, so every run makes the same ones.

#[path = "../program/src/verify.rs"]
mod verify;

/// SplitMix64.
struct Rng(u64);

impl Rng {
    fn u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.u64() % n
    }

    fn bytes<const L: usize>(&mut self) -> [u8; L] {
        let mut out = [0; L];
        for chunk in out.chunks_mut(8) {
            chunk.copy_from_slice(&self.u64().to_le_bytes()[..chunk.len()]);
        }
        out
    }

    fn vec(&mut self, len: usize) -> Vec<u8> {
        (0..len).map(|_| self.u64() as u8).collect()
    }

    /// A scalar from 1 to n − 1.
    fn scalar(&mut self) -> Scalar {
        loop {
            let k = Option::<Scalar>::from(Scalar::from_repr(self.bytes::<32>().into()));
            if let Some(k) = k.filter(|k| *k != Scalar::ZERO) {
                return k;
            }
        }
    }

    fn key(&mut self) -> SigningKey {
        SigningKey::from_bytes(&self.scalar().to_repr()).unwrap()
    }

    /// A 32-byte value that is often an edge of the scalars' range.
    fn edgy(&mut self) -> [u8; 32] {
        let n = order();
        match self.below(10) {
            0 => [0; 32],
            1 => small(1),
            2 => sub(&n, &small(1)),
            3 => n,
            4 => add(&n, &small(1)).unwrap(),
            5 => be(&-Scalar::from(2u64).invert().unwrap()), // (n − 1) / 2
            6 => be(&Scalar::from(2u64).invert().unwrap()),  // (n + 1) / 2
            7 => [0xff; 32],
            8 => small(self.u64()),
            _ => self.bytes(),
        }
    }
}

fn be(k: &Scalar) -> [u8; 32] {
    k.to_repr().into()
}

fn small(t: u64) -> [u8; 32] {
    let mut out = [0; 32];
    out[24..].copy_from_slice(&t.to_be_bytes());
    out
}

fn order() -> [u8; 32] {
    unhex(N).try_into().unwrap()
}

fn prime() -> [u8; 32] {
    unhex(P).try_into().unwrap()
}

/// `a + b`, or none past 2^256.
fn add(a: &[u8; 32], b: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let v = a[i] as u16 + b[i] as u16 + carry;
        out[i] = v as u8;
        carry = v >> 8;
    }
    (carry == 0).then_some(out)
}

/// `a − b`, for `a >= b`.
fn sub(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let v = a[i] as i16 - b[i] as i16 - borrow;
        out[i] = v.rem_euclid(256) as u8;
        borrow = (v < 0) as i16;
    }
    out
}

fn reduce(bytes: &[u8; 32]) -> Scalar {
    <Scalar as Reduce<U256>>::reduce_bytes(&FieldBytes::from(*bytes))
}

/// The point with this x and y of this parity, if there is one.
fn decompress(x: &[u8; 32], odd: bool) -> Option<ProjectivePoint> {
    let bytes = [&[2 + odd as u8][..], x].concat();
    let point = AffinePoint::from_encoded_point(&EncodedPoint::from_bytes(&bytes).ok()?);
    Option::<AffinePoint>::from(point).map(ProjectivePoint::from)
}

fn uncompressed(p: &ProjectivePoint) -> Vec<u8> {
    p.to_affine().to_encoded_point(false).as_bytes().to_vec()
}

fn x_of(p: &ProjectivePoint) -> [u8; 32] {
    p.to_affine().x().into()
}

/// p256's verdict by policy-p256's rules: an uncompressed key, both scalars in
/// range, a low S, and `verify_prehash`.
fn p256_verdict(key: &[u8], e: &[u8; 32], r: &[u8; 32], s: &[u8; 32]) -> bool {
    if key.len() != 65 || key[0] != 0x04 {
        return false;
    }
    let (Ok(key), Ok(signature)) = (
        VerifyingKey::from_sec1_bytes(key),
        Signature::from_scalars(*r, *s),
    ) else {
        return false;
    };
    !bool::from(signature.s().is_high()) && key.verify_prehash(e, &signature).is_ok()
}

/// The policy's answer as this file reads the rules: the witness's fields,
/// the flags, the challenge, then p256's verdict.
fn expected_answer(params: &[u8], message: &[u8], witness: &[u8]) -> &'static [u8] {
    fn field(x: &[u8]) -> Option<(&[u8], &[u8])> {
        let len = u32::from_le_bytes(x.get(..4)?.try_into().unwrap()) as usize;
        (x.len() - 4 >= len).then(|| x[4..].split_at(len))
    }
    let answer = (|| {
        let (auth_data, rest) = field(witness)?;
        let (client_data, signature) = field(rest)?;
        if signature.len() != 64 || auth_data.len() < 37 || auth_data[32] & (UP | UV) != UP | UV {
            return None;
        }
        let head = format!(
            r#"{{"type":"webauthn.get","challenge":"{}""#,
            challenge(message)
        );
        let after = client_data.strip_prefix(head.as_bytes())?;
        if !matches!(after.first(), Some(b',' | b'}')) {
            return None;
        }
        let e = sha256(&[auth_data, &sha256(client_data)].concat());
        let (r, s) = signature.split_at(32);
        p256_verdict(params, &e, r.try_into().unwrap(), s.try_into().unwrap()).then_some(())
    })();
    if answer.is_some() { YES } else { NO }
}

/// A key, unknown to anyone, for which `r ‖ s` is a valid low-S signature over
/// `e` with the nonce point `big_r`: `Q = (R − u1·G) / u2`, with `u1 = e / s`
/// and `u2 = r / s`. Any `e` works, the hash of an assertion too.
fn key_for_nonce_point(
    big_r: &ProjectivePoint,
    s: Scalar,
    e: &[u8; 32],
) -> Option<(Vec<u8>, [u8; 32], [u8; 32])> {
    let r = reduce(&x_of(big_r));
    if r == Scalar::ZERO {
        return None;
    }
    let s = if bool::from(s.is_high()) { -s } else { s };
    let w = s.invert().unwrap();
    let (u1, u2) = (reduce(e) * w, r * w);
    let q = (*big_r - ProjectivePoint::GENERATOR * u1) * u2.invert().unwrap();
    (q != ProjectivePoint::IDENTITY).then(|| (uncompressed(&q), be(&r), be(&s)))
}

/// A valid low-S signature by the point `q`, whose secret is unknown, over an
/// `e` it chooses: `R = a·G + b·Q`, `s = r / b`, `e = a·s`. Its negation
/// `(r, n − s)` is valid over the same `e`, as `−R`.
fn signature_by_point(
    q: &ProjectivePoint,
    a: Scalar,
    b: Scalar,
) -> Option<([u8; 32], [u8; 32], [u8; 32])> {
    let r = reduce(&x_of(&(ProjectivePoint::GENERATOR * a + *q * b)));
    if r == Scalar::ZERO {
        return None;
    }
    let s = r * b.invert().unwrap();
    let e = a * s;
    let s = if bool::from(s.is_high()) { -s } else { s };
    Some((be(&e), be(&r), be(&s)))
}

/// A valid low-S ECDSA signature by `key` over the 32-byte hash `e`.
fn sign_hash(key: &SigningKey, e: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let signature: Signature = key.sign_prehash(e).unwrap();
    let signature = signature.normalize_s().unwrap_or(signature);
    let (r, s) = signature.split_bytes();
    (r.into(), s.into())
}

fn public(key: &SigningKey) -> Vec<u8> {
    key.verifying_key()
        .to_encoded_point(false)
        .as_bytes()
        .to_vec()
}

/// A point whose x is `n + t` for a small `t`, so that `r = x − n`.
fn point_above_order(rng: &mut Rng) -> ProjectivePoint {
    loop {
        let x = add(&order(), &small(rng.u64())).unwrap();
        if let Some(p) = decompress(&x, rng.below(2) == 1) {
            return p;
        }
    }
}

/// A point whose x is small, so that `x + n` is below p.
fn point_with_small_x(rng: &mut Rng) -> (ProjectivePoint, [u8; 32]) {
    loop {
        let x = small(rng.below(1 << 20));
        if let Some(p) = decompress(&x, rng.below(2) == 1) {
            return (p, x);
        }
    }
}

/// A point whose x is just below p.
fn point_near_p(rng: &mut Rng) -> ProjectivePoint {
    loop {
        let x = sub(&prime(), &small(1 + rng.below(1 << 20)));
        if let Some(p) = decompress(&x, rng.below(2) == 1) {
            return p;
        }
    }
}

/// One case for the shared verification core: `key ‖ e ‖ r ‖ s`.
fn core_case(rng: &mut Rng, kind: u64) -> (Vec<u8>, [u8; 32], [u8; 32], [u8; 32]) {
    let g = ProjectivePoint::GENERATOR;
    loop {
        let case = match kind {
            // Valid, then wrong e, wrong key, high S.
            0..=3 => {
                let key = rng.key();
                let e: [u8; 32] = rng.bytes();
                let (r, s) = sign_hash(&key, &e);
                match kind {
                    0 => Some((public(&key), e, r, s)),
                    1 => Some((public(&key), rng.bytes(), r, s)),
                    2 => Some((public(&rng.key()), e, r, s)),
                    _ => Some((public(&key), e, r, negate(&s).try_into().unwrap())),
                }
            }
            // Scalars at and around the ends of their range.
            4 => {
                let key = rng.key();
                let e: [u8; 32] = rng.bytes();
                let (r, s) = sign_hash(&key, &e);
                let (r, s) = match rng.below(3) {
                    0 => (rng.edgy(), s),
                    1 => (r, rng.edgy()),
                    _ => (rng.edgy(), rng.edgy()),
                };
                Some((public(&key), e, r, s))
            }
            // R with x >= n, so r = x − n; and r given as x itself.
            5 => {
                let big_r = point_above_order(rng);
                let e = if rng.below(2) == 0 {
                    rng.edgy()
                } else {
                    rng.bytes()
                };
                key_for_nonce_point(&big_r, rng.scalar(), &e).map(|(key, r, s)| {
                    let r = if rng.below(2) == 0 { x_of(&big_r) } else { r };
                    (key, e, r, s)
                })
            }
            // R with a small x, below p − n; and r given as x + n.
            6 => {
                let (big_r, x) = point_with_small_x(rng);
                let e: [u8; 32] = rng.bytes();
                key_for_nonce_point(&big_r, rng.scalar(), &e).map(|(key, r, s)| {
                    let r = if rng.below(2) == 0 {
                        add(&x, &order()).unwrap()
                    } else {
                        r
                    };
                    (key, e, r, s)
                })
            }
            // Any R, with e at the edges: 0, n, 2^256 − 1, ...
            7 => {
                let e = rng.edgy();
                key_for_nonce_point(&(g * rng.scalar()), rng.scalar(), &e)
                    .map(|(key, r, s)| (key, e, r, s))
            }
            // Keys whose x is just below p, or small; a small x also written
            // as x + p, which is not a coordinate.
            8 | 9 => {
                let (q, alias) = if kind == 8 {
                    (point_near_p(rng), None)
                } else {
                    let (q, x) = point_with_small_x(rng);
                    (q, (rng.below(2) == 0).then(|| add(&x, &prime()).unwrap()))
                };
                signature_by_point(&q, rng.scalar(), rng.scalar()).map(|(e, r, s)| {
                    let mut key = uncompressed(&q);
                    if let Some(x) = alias {
                        key[1..33].copy_from_slice(&x);
                    }
                    (key, e, r, s)
                })
            }
            // Q = G and Q = −G with u1 and u2 alike in their high bits, so that
            // the sum meets P + P and P + (−P) on the way.
            10 | 11 => {
                let a = rng.scalar();
                let mut b = be(&a);
                let low = 1 + rng.below(31) as usize;
                b[32 - low..].copy_from_slice(&rng.vec(low));
                let b = Option::<Scalar>::from(Scalar::from_repr(b.into()))
                    .filter(|b| *b != Scalar::ZERO);
                let q = if kind == 10 { g } else { -g };
                b.and_then(|b| signature_by_point(&q, a, b))
                    .map(|(e, r, s)| (uncompressed(&q), e, r, s))
            }
            // u1·G + u2·Q at infinity: Q = −(u1 / u2)·G.
            12 => {
                let (u1, u2, s) = (rng.scalar(), rng.scalar(), rng.scalar());
                let q = -(g * (u1 * u2.invert().unwrap()));
                Some((uncompressed(&q), be(&(u1 * s)), be(&(u2 * s)), be(&s)))
            }
            // Keys off the curve, or in another form.
            13 => {
                let key = rng.key();
                let e: [u8; 32] = rng.bytes();
                let (r, s) = sign_hash(&key, &e);
                let mut params = public(&key);
                match rng.below(4) {
                    0 => params[1..].copy_from_slice(&rng.vec(64)),
                    1 => params[64] ^= 1 << rng.below(8),
                    2 => params[0] = rng.below(8) as u8,
                    _ => {
                        params = key
                            .verifying_key()
                            .to_encoded_point(true)
                            .as_bytes()
                            .to_vec()
                    }
                }
                Some((params, e, r, s))
            }
            // A valid signature with one bit flipped anywhere.
            _ => {
                let key = rng.key();
                let e: [u8; 32] = rng.bytes();
                let (r, s) = sign_hash(&key, &e);
                let mut all = [public(&key), e.to_vec(), r.to_vec(), s.to_vec()].concat();
                let bit = rng.below(all.len() as u64 * 8) as usize;
                all[bit / 8] ^= 1 << (bit % 8);
                let t = |a: usize| -> [u8; 32] { all[a..a + 32].try_into().unwrap() };
                Some((all[..65].to_vec(), t(65), t(97), t(129)))
            }
        };
        if let Some(case) = case {
            return case;
        }
    }
}

const CORE_KINDS: u64 = 15;

/// `cases` cases of every kind, natively; how many p256 accepted.
fn core_differential(seed: u64, cases: u64) -> u64 {
    let mut rng = Rng(seed);
    let mut accepted = 0;
    for i in 0..cases * CORE_KINDS {
        let kind = i % CORE_KINDS;
        let (key, e, r, s) = core_case(&mut rng, kind);
        let expected = p256_verdict(&key, &e, &r, &s);
        assert_eq!(
            verify::verify(&key, &e, &r, &s),
            expected,
            "case {i} of kind {kind}: key {key:02x?}, e {e:02x?}, r {r:02x?}, s {s:02x?}"
        );
        accepted += expected as u64;
    }
    accepted
}

macro_rules! core_shards {
    ($($name:ident: $seed:expr),*) => {$(
        #[test]
        fn $name() {
            // 15 kinds × 200 = 3,000 cases a shard, about 1,300 of them valid.
            let accepted = core_differential($seed, 200);
            println!("{}: 3,000 cases, {accepted} valid", stringify!($name));
            assert!(accepted > 900 && accepted < 2_100, "{accepted} accepted");
        }
    )*};
}

core_shards!(
    differential_native_1: 0x7469_6e67_0001,
    differential_native_2: 0x7469_6e67_0002,
    differential_native_3: 0x7469_6e67_0003,
    differential_native_4: 0x7469_6e67_0004
);

/// One case for the policy on the VM: `params`, `message`, `witness`.
fn policy_case(rng: &mut Rng, kind: u64) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let len = rng.below(80) as usize;
    let m = [framed(b"app/test-v1"), rng.vec(len)].concat();
    let mut flags = UP | UV | (rng.below(4) as u8) << 3;
    let extension = rng.below(4) == 0;
    if extension {
        flags |= ED;
    }
    let mut data = auth_data(flags);
    data[..32].copy_from_slice(&rng.bytes::<32>());
    data[33..37].copy_from_slice(&rng.bytes::<4>());
    if extension {
        data.extend(unhex("a16b6372656450726f7465637402"));
    }
    let tails = [
        ORIGIN.to_string(),
        format!("{ORIGIN}{CHROME_EXTRA}"),
        String::new(),
        r#","origin":"https://wallet.example","crossOrigin":true,"topOrigin":"https://x.example""#
            .into(),
    ];
    let json = client_data(
        "webauthn.get",
        &challenge(&m),
        &tails[rng.below(4) as usize],
    );
    let e = sha256(&[&data[..], &sha256(&json)].concat());
    let witness =
        |r: &[u8], s: &[u8]| [framed(&data), framed(&json), r.to_vec(), s.to_vec()].concat();
    let key = rng.key();
    let (r, s) = sign_hash(&key, &e);
    let g = ProjectivePoint::GENERATOR;
    loop {
        let case = match kind {
            // Valid, then another message, another key, high S.
            0 => Some((public(&key), m.clone(), witness(&r, &s))),
            1 => Some((
                public(&key),
                [&m[..], &[rng.u64() as u8]].concat(),
                witness(&r, &s),
            )),
            2 => Some((public(&rng.key()), m.clone(), witness(&r, &s))),
            3 => Some((public(&key), m.clone(), witness(&r, &negate(&s)))),
            // Scalars at and around the ends of their range.
            4 => Some((public(&key), m.clone(), witness(&rng.edgy(), &rng.edgy()))),
            // R with x >= n, or with a small x; r also unreduced.
            5 | 6 => {
                let (big_r, x) = if kind == 5 {
                    let p = point_above_order(rng);
                    (p, x_of(&p))
                } else {
                    let (p, x) = point_with_small_x(rng);
                    (p, add(&x, &order()).unwrap())
                };
                key_for_nonce_point(&big_r, rng.scalar(), &e).map(|(key, r, s)| {
                    let r = if rng.below(3) == 0 { x } else { r };
                    (key, m.clone(), witness(&r, &s))
                })
            }
            // Secrets 1, 2, n − 1 and n − 2: Q = ±G, ±2G.
            7 => {
                let d = [
                    Scalar::ONE,
                    Scalar::from(2u64),
                    -Scalar::ONE,
                    -Scalar::from(2u64),
                ];
                let key = SigningKey::from_bytes(&d[rng.below(4) as usize].to_repr()).unwrap();
                let (r, s) = sign_hash(&key, &e);
                Some((public(&key), m.clone(), witness(&r, &s)))
            }
            // u1·G + u2·Q at infinity, for this e.
            8 => {
                let (s, u2) = (rng.scalar(), rng.scalar());
                let u1 = reduce(&e) * s.invert().unwrap();
                let q = -(g * (u1 * u2.invert().unwrap()));
                Some((
                    uncompressed(&q),
                    m.clone(),
                    witness(&be(&(u2 * s)), &be(&s)),
                ))
            }
            // Keys near p, x + p for a small x, or off the curve.
            9 => {
                let params = match rng.below(3) {
                    0 => uncompressed(&point_near_p(rng)),
                    1 => {
                        let (q, x) = point_with_small_x(rng);
                        let mut params = uncompressed(&q);
                        params[1..33].copy_from_slice(&add(&x, &prime()).unwrap());
                        params
                    }
                    _ => [&[4][..], &rng.vec(64)].concat(),
                };
                Some((params, m.clone(), witness(&r, &s)))
            }
            // Signed, but without UP or UV, as a registration, or with
            // another challenge.
            10 => {
                let (data, json) = match rng.below(3) {
                    0 => {
                        let mut d = data.clone();
                        d[32] &= !(if rng.below(2) == 0 { UP } else { UV });
                        (d, json.clone())
                    }
                    1 => (
                        data.clone(),
                        client_data("webauthn.create", &challenge(&m), ORIGIN),
                    ),
                    _ => {
                        let mut c = challenge(&m).into_bytes();
                        let at = rng.below(43) as usize;
                        c[at] =
                            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_+/="
                                [rng.below(67) as usize];
                        (
                            data.clone(),
                            client_data("webauthn.get", std::str::from_utf8(&c).unwrap(), ORIGIN),
                        )
                    }
                };
                let e = sha256(&[&data[..], &sha256(&json)].concat());
                let (r, s) = sign_hash(&key, &e);
                let w = [framed(&data), framed(&json), r.to_vec(), s.to_vec()].concat();
                Some((public(&key), m.clone(), w))
            }
            // A valid case with one bit flipped in the witness, or in the
            // params.
            11 | 12 => {
                let (mut params, mut w) = (public(&key), witness(&r, &s));
                let target = if kind == 11 { &mut w } else { &mut params };
                let bit = rng.below(target.len() as u64 * 8) as usize;
                target[bit / 8] ^= 1 << (bit % 8);
                Some((params, m.clone(), w))
            }
            _ => unreachable!(),
        };
        if let Some(case) = case {
            return case;
        }
    }
}

const POLICY_KINDS: u64 = 13;

/// `cases` cases on the VM, every kind in turn; how many the policy accepted.
fn policy_differential(seed: u64, cases: u64) -> u64 {
    let mut f = fixture();
    let mut rng = Rng(seed);
    let mut accepted = 0;
    for i in 0..cases {
        let kind = i % POLICY_KINDS;
        let (params, message, witness) = policy_case(&mut rng, kind);
        let expected = expected_answer(&params, &message, &witness);
        let answer = f.check(&params, &message, &witness);
        assert_eq!(answer, expected, "case {i} of kind {kind}");
        accepted += (answer == YES) as u64;
    }
    accepted
}

macro_rules! vm_shards {
    ($($name:ident: $seed:expr),*) => {$(
        #[test]
        fn $name() {
            // 256 cases a shard through the packed module, about 70 of them
            // valid.
            let accepted = policy_differential($seed, 256);
            println!("{}: 256 cases, {accepted} valid", stringify!($name));
            assert!(accepted > 50 && accepted < 120, "{accepted} accepted");
        }
    )*};
}

vm_shards!(
    differential_vm_1: 0x7765_6261_0001,
    differential_vm_2: 0x7765_6261_0002,
    differential_vm_3: 0x7765_6261_0003,
    differential_vm_4: 0x7765_6261_0004,
    differential_vm_5: 0x7765_6261_0005,
    differential_vm_6: 0x7765_6261_0006,
    differential_vm_7: 0x7765_6261_0007,
    differential_vm_8: 0x7765_6261_0008
);

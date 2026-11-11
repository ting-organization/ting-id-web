//! policy-webauthn: a WebAuthn passkey (Face ID, Touch ID, Windows Hello, a
//! security key) as a key of a Ting account.
//!
//! A signature policy (Ting wiki: programs/conventions, policy interface). It is
//! called read-only with
//!
//! ```text
//! input   = Bytes(params) ‖ Bytes(message) ‖ Bytes(witness)
//! params  = 04 ‖ x(32) ‖ y(32)            the passkey's P-256 public key, uncompressed
//! witness = Bytes(authenticatorData) ‖ Bytes(clientDataJSON) ‖ r(32) ‖ s(32)
//! ```
//!
//! and answers `01` exactly when the witness is a WebAuthn assertion of that
//! passkey whose challenge is the message's signing digest,
//! `H("app/sign-v1", message)`:
//!
//! 1. the witness decodes exactly; `authenticatorData` holds at least its 37
//!    fixed bytes, and its flags have user presence (UP, `01`) and user
//!    verification (UV, `04`) set;
//! 2. `clientDataJSON` starts with `{"type":"webauthn.get","challenge":"`, the
//!    digest in base64url without padding (43 characters), `"`, and then `,` or
//!    `}`;
//! 3. `1 <= r < n` and `1 <= s <= (n − 1) / 2`: low S only, as policy-p256;
//! 4. `(r, s)` is a valid ECDSA P-256 signature by the key over
//!    `SHA-256(authenticatorData ‖ SHA-256(clientDataJSON))`.
//!
//! Anything else in the params or the witness answers `00`. Input that is not
//! exactly three `Bytes` fields reverts `bad input`, as policy-p256 does; empty
//! input, its deployment, answers nothing. The origin and the relying party are
//! not checked: a passkey signs only for its own relying party. The program
//! keeps no state, emits nothing and never asks for a delay.
#![no_std]

mod verify;

use ting_program::hash::{Sha256, h, sha256};
use ting_program::host;

/// What `clientDataJSON` starts with, up to the challenge: browsers write
/// `type` first and `challenge` second, with no spaces.
const PREFIX: &[u8] = br#"{"type":"webauthn.get","challenge":""#;

/// `rpIdHash(32) ‖ flags ‖ signCount(4)`, the fixed part of `authenticatorData`.
const AUTH_DATA_MIN: usize = 37;
const FLAGS: usize = 32;
/// User present and user verified.
const UP_UV: u8 = 0x01 | 0x04;

#[unsafe(no_mangle)]
pub extern "C" fn invoke() {
    let input = host::read_input();
    if input.is_empty() {
        host::finish(&[]);
    }
    let Some((params, message, witness)) = query(&input) else {
        host::fail(b"bad input");
    };
    host::finish(&[authorized(params, message, witness).is_some() as u8]);
}

/// `Bytes(params) ‖ Bytes(message) ‖ Bytes(witness)`, exactly.
fn query(input: &[u8]) -> Option<(&[u8], &[u8], &[u8])> {
    let mut query = Cursor(input);
    let fields = (query.bytes()?, query.bytes()?, query.bytes()?);
    query.end()?;
    Some(fields)
}

/// `Some` exactly when the witness authorizes the message for the key.
fn authorized(params: &[u8], message: &[u8], witness: &[u8]) -> Option<()> {
    let mut w = Cursor(witness);
    let auth_data = w.bytes()?;
    let client_data = w.bytes()?;
    let r: &[u8; 32] = w.take(32)?.try_into().ok()?;
    let s: &[u8; 32] = w.take(32)?.try_into().ok()?;
    w.end()?;

    if auth_data.len() < AUTH_DATA_MIN || auth_data[FLAGS] & UP_UV != UP_UV {
        return None;
    }

    let digest = h(b"app/sign-v1", &[message]);
    let rest = client_data.strip_prefix(PREFIX)?;
    let rest = rest.strip_prefix(&base64url(&digest)[..])?;
    if !matches!(rest, [b'"', b',' | b'}', ..]) {
        return None;
    }

    let mut signed = Sha256::new();
    signed.update(auth_data);
    signed.update(&sha256(client_data));
    verify::verify(params, &signed.finish(), r, s).then_some(())
}

/// The 32 bytes in base64url, without padding: 43 characters.
fn base64url(bytes: &[u8; 32]) -> [u8; 43] {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = [0; 43];
    // Ten groups of three bytes, four characters each, then the last two bytes:
    // three characters, the last of which ends in two zero bits.
    for i in 0..11 {
        let b = |k: usize| bytes.get(3 * i + k).map_or(0, |&b| b as u32);
        let group = b(0) << 16 | b(1) << 8 | b(2);
        for j in 0..4 {
            if let Some(c) = out.get_mut(4 * i + j) {
                *c = ALPHABET[(group >> (18 - 6 * j)) as usize & 63];
            }
        }
    }
    out
}

/// Reads the encodings exactly, answering `None` instead of reverting.
struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(n)?;
        self.0 = rest;
        Some(head)
    }

    /// `Bytes(x)`.
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = u32::from_le_bytes(self.take(4)?.try_into().ok()?);
        self.take(usize::try_from(len).ok()?)
    }

    fn end(&self) -> Option<()> {
        self.0.is_empty().then_some(())
    }
}

//! Coins of the coin reference program (Ting wiki: programs/coin). Daler (DLR)
//! is one; anyone can deploy another and call it anything, so a program trusts
//! a contract as a coin only when it runs the coin program's code.
use crate::host::{self, fail};
use alloc::vec;

/// The CodeHash of the coin reference program.
pub const CODE: [u8; 32] = unhex("c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6");

/// Whether `coin` runs the coin reference program.
pub fn is_coin(coin: &[u8; 32]) -> bool {
    host::code_of(coin) == Some(CODE)
}

/// Reverts `bad coin` unless `coin` runs the coin reference program. A
/// contract that only claims to be a coin could report a payment it never made.
pub fn check(coin: &[u8; 32]) {
    if !is_coin(coin) {
        fail(b"bad coin");
    }
}

/// Sends `amount` of `coin` from this program's own account to `to`: a coin
/// action of a contract account, with no fee and no binding.
pub fn send(coin: &[u8; 32], to: &[u8; 32], amount: u128) {
    let mut input = vec![0x10, 0x01, 0x01];
    input.extend_from_slice(to);
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(&[0; 16 + 16 + 8 + 8 + 1]);
    let (status, result) = host::call_child(coin, &input, host::ORDINARY);
    if status != 0 {
        fail(&[b"coin: ".as_slice(), &result].concat());
    }
}

/// Burns `amount` of `coin` from this program's own account.
pub fn burn(coin: &[u8; 32], amount: u128) {
    let mut input = vec![0x10, 0x01, 0x02];
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(&[0; 16 + 16 + 8 + 8 + 1]);
    let (status, result) = host::call_child(coin, &input, host::ORDINARY);
    if status != 0 {
        fail(&[b"coin: ".as_slice(), &result].concat());
    }
}

/// 64 hex digits as 32 bytes, at compile time.
pub const fn unhex(text: &str) -> [u8; 32] {
    let t = text.as_bytes();
    assert!(t.len() == 64, "an id is 64 hex digits");
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = digit(t[2 * i]) << 4 | digit(t[2 * i + 1]);
        i += 1;
    }
    out
}

const fn digit(c: u8) -> u8 {
    match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        _ => panic!("lowercase hex only"),
    }
}

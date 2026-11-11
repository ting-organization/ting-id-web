//! Accounts (Ting wiki: programs/conventions#accounts). An account is 32
//! bytes that a coin, or any program, keys its records by:
//!
//! ```text
//! policy account   = H("app/account-v1/policy",   policy ‖ Bytes(params))
//! contract account = H("app/account-v1/contract", program)
//! ```
//!
//! A policy account belongs to whoever its policy program approves: a key, or a
//! Ting ID's slot. A contract account belongs to one program, which acts for it
//! by calling: it is where a program keeps coins of its own.
use crate::hash::h;

pub fn policy(policy: &[u8; 32], params: &[u8]) -> [u8; 32] {
    h(
        b"app/account-v1/policy",
        &[policy, &(params.len() as u32).to_le_bytes(), params],
    )
}

pub fn contract(program: &[u8; 32]) -> [u8; 32] {
    h(b"app/account-v1/contract", &[program])
}

/// This program's own account.
pub fn own() -> [u8; 32] {
    contract(&crate::host::self_id())
}

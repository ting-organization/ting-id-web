//! Writing a Ting program in Rust.
//!
//! A Ting program is a WebAssembly module that imports host functions from
//! module `ting`, exports `invoke` and its `memory` (Ting wiki:
//! applications/writing-programs). This crate gives it:
//!
//! - [`host`]: the host functions, with safe wrappers;
//! - [`hash`]: SHA-256 and Ting's domain-separated hash `H(tag, x)`, usable in
//!   `const` items;
//! - [`bytes`]: reading and writing Ting's encodings;
//! - [`account`] and [`coin`]: accounts, and sending coins from the program's
//!   own account;
//! - [`tcr`]: TCR-1, Ting Call Requests: how a page asks a user to do
//!   something in the program, and how the program checks that the user
//!   agreed. You declare templates and say what each operation does; it
//!   handles nonces, signatures, payments, delays and events;
//! - with the default `runtime` feature, a memory allocator and a panic handler.
//!
//! Programs are deterministic and integer-only: no floats, no clock, no
//! randomness, nothing but what the host gives.
#![no_std]

extern crate alloc;

pub mod account;
pub mod bytes;
pub mod coin;
pub mod hash;
pub mod host;
#[cfg(feature = "runtime")]
mod runtime;
pub mod tcr;

/// What most programs use.
pub mod prelude {
    pub use crate::bytes::{Reader, Writer};
    pub use crate::hash::{h, h_const};
    pub use crate::host::{self, fail};
    pub use crate::tcr::{self, Operation, Payment, Program, Template};
    pub use alloc::{vec, vec::Vec};
}

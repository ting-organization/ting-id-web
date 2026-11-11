//! The host functions of module `ting`, and safe wrappers around them (Ting
//! wiki: vm/host). Only the functions a program calls end up imported.
//!
//! Every host call is metered: reading and writing storage, calling another
//! program and emitting events cost budget (Ting wiki: resources/prices).
use alloc::vec::Vec;
use core::arch::wasm32;

#[link(wasm_import_module = "ting")]
unsafe extern "C" {
    fn input(out: *mut u8, capacity: u32) -> u32;
    fn context(selector: u32, out: *mut u8, capacity: u32) -> u32;
    fn storage_get(key: *const u8, out: *mut u8, capacity: u32) -> u32;
    fn storage_set(key: *const u8, value: *const u8, len: u32);
    fn storage_delete(key: *const u8);
    fn code_hash(target: *const u8, out: *mut u8, capacity: u32) -> u32;
    fn call(target: *const u8, input: *const u8, len: u32, budget: *const u8, flags: u32) -> u32;
    fn call_result(out: *mut u8, capacity: u32) -> u32;
    fn emit(payload: *const u8, len: u32);
    #[link_name = "return"]
    fn host_return(result: *const u8, len: u32);
    fn revert(result: *const u8, len: u32);
}

/// What a caller holds back from a child's budget, in C, S, D, G (Ting wiki:
/// programs/conventions, the budget reserve), so that it can still finish
/// after the child has spent everything it was given.
pub const RESERVE: [u64; 4] = [500_000, 64, 65_536, 65_536];

/// A call that may write, emit and pay.
pub const ORDINARY: u32 = 0;
/// A call that may only read: a write, deployment or event fails it.
pub const READ_ONLY: u32 = 1;

const ABSENT: u32 = u32::MAX;

/// The input the program was invoked with: the transaction's, or its caller's.
pub fn read_input() -> Vec<u8> {
    let len = unsafe { input(core::ptr::null_mut(), 0) } as usize;
    let mut out = Vec::with_capacity(len);
    unsafe {
        input(out.as_mut_ptr(), len as u32);
        out.set_len(len);
    }
    out
}

fn context_bytes<const N: usize>(selector: u32) -> [u8; N] {
    let mut out = [0; N];
    unsafe { context(selector, out.as_mut_ptr(), N as u32) };
    out
}

/// The ChainId of the network: different on the production network and on a
/// development chain.
pub fn chain_id() -> [u8; 32] {
    context_bytes(0)
}

/// The TransactionId of the transaction this invocation is part of.
pub fn transaction_id() -> [u8; 32] {
    context_bytes(1)
}

/// The program's own ContractId.
pub fn self_id() -> [u8; 32] {
    context_bytes(2)
}

/// The ContractId of the program that called this one, or none when a
/// transaction invoked it directly.
pub fn caller() -> Option<[u8; 32]> {
    let tagged: [u8; 33] = context_bytes(3);
    if tagged[0] != 1 {
        return None;
    }
    let mut id = [0; 32];
    id.copy_from_slice(&tagged[1..]);
    Some(id)
}

/// The height of the block being built.
pub fn height() -> u64 {
    u64::from_le_bytes(context_bytes(4))
}

/// The block's timestamp, in Unix seconds. Miners set it within limits, so it
/// is close to real time, not exact.
pub fn now() -> u64 {
    u64::from_le_bytes(context_bytes(5))
}

/// What is left of this invocation's budget, in C, S, D, G.
pub fn budget_left() -> [u64; 4] {
    let left: [u8; 32] = context_bytes(8);
    let mut out = [0; 4];
    for (i, word) in out.iter_mut().enumerate() {
        *word = u64::from_le_bytes(left[i * 8..i * 8 + 8].try_into().unwrap());
    }
    out
}

/// Reads a record into `out` in one access: its length, or none when absent.
/// A record longer than `out` is not copied, and its length says so: pass an
/// empty `out` to learn only whether it exists and how long it is.
pub fn get_into(key: &[u8; 32], out: &mut [u8]) -> Option<usize> {
    let len = unsafe { storage_get(key.as_ptr(), out.as_mut_ptr(), out.len() as u32) };
    (len != ABSENT).then_some(len as usize)
}

/// A record of any length, in two accesses; none when absent.
pub fn get(key: &[u8; 32]) -> Option<Vec<u8>> {
    let len = get_into(key, &mut [])?;
    let mut out = alloc::vec![0; len];
    get_into(key, &mut out);
    Some(out)
}

/// A record of exactly `N` bytes, in one access. A record of another length
/// reverts `corrupt`: it means the program wrote something it did not mean to.
pub fn get_fixed<const N: usize>(key: &[u8; 32]) -> Option<[u8; N]> {
    let mut out = [0; N];
    match get_into(key, &mut out) {
        None => None,
        Some(len) if len == N => Some(out),
        Some(_) => fail(b"corrupt"),
    }
}

/// A `u64` record, 0 when absent.
pub fn get_u64(key: &[u8; 32]) -> u64 {
    get_fixed(key).map_or(0, u64::from_le_bytes)
}

pub fn exists(key: &[u8; 32]) -> bool {
    get_into(key, &mut []).is_some()
}

/// Writes a record. An empty value is a record that exists and is empty; use
/// [`delete`] to remove one.
pub fn set(key: &[u8; 32], value: &[u8]) {
    unsafe { storage_set(key.as_ptr(), value.as_ptr(), value.len() as u32) }
}

pub fn delete(key: &[u8; 32]) {
    unsafe { storage_delete(key.as_ptr()) }
}

/// The CodeHash of the contract `target`, or none when there is no such
/// contract: how a program checks which code another one runs before it
/// trusts it.
pub fn code_of(target: &[u8; 32]) -> Option<[u8; 32]> {
    let mut out = [0u8; 32];
    let len = unsafe { code_hash(target.as_ptr(), out.as_mut_ptr(), 32) };
    (len == 32).then_some(out)
}

/// Calls `target` with everything left but the standard reserve, and returns
/// the child's status and result: status 0 is success. Reverts
/// `insufficient budget` when less than the reserve is left.
pub fn call_child(target: &[u8; 32], input: &[u8], flags: u32) -> (u32, Vec<u8>) {
    let left = budget_left();
    let mut budget = [0u8; 32];
    for i in 0..4 {
        let Some(child) = left[i].checked_sub(RESERVE[i]) else {
            fail(b"insufficient budget");
        };
        budget[i * 8..i * 8 + 8].copy_from_slice(&child.to_le_bytes());
    }
    let status = unsafe {
        call(
            target.as_ptr(),
            input.as_ptr(),
            input.len() as u32,
            budget.as_ptr(),
            flags,
        )
    };
    if status == 128 {
        fail(b"insufficient budget");
    }
    let len = unsafe { call_result(core::ptr::null_mut(), 0) } as usize;
    let mut result = Vec::with_capacity(len);
    unsafe {
        call_result(result.as_mut_ptr(), len as u32);
        result.set_len(len);
    }
    (status, result)
}

/// Emits an event: anyone can read it from a node, by program and by its first
/// 32 bytes, its topic (Ting wiki: start/explore). Events are how pages learn
/// what happened; they cost budget like storage but are not state.
pub fn emit_event(payload: &[u8]) {
    unsafe { emit(payload.as_ptr(), payload.len() as u32) }
}

/// Ends the invocation successfully, with `result` for the caller.
pub fn finish(result: &[u8]) -> ! {
    unsafe { host_return(result.as_ptr(), result.len() as u32) };
    wasm32::unreachable()
}

/// Reverts with `reason`: every change the invocation made is undone, and the
/// reason is what the caller and the transaction's receipt show.
pub fn fail(reason: &[u8]) -> ! {
    unsafe { revert(reason.as_ptr(), reason.len() as u32) };
    wasm32::unreachable()
}

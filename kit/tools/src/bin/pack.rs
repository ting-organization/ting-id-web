//! `pack <linked.wasm> <out.wasm>`: the deployable module, checked against
//! Ting's execution profile, and its CodeHash.
use std::{env, fs, process};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: pack <linked.wasm> <out.wasm>");
        process::exit(2);
    }
    let linked = fs::read(&args[1]).unwrap_or_else(|e| {
        eprintln!("pack: {}: {e}", args[1]);
        process::exit(1);
    });
    let packed = ting_kit_tools::pack(&linked).unwrap_or_else(|e| {
        eprintln!("pack: {e}");
        process::exit(1);
    });
    fs::write(&args[2], &packed).expect("write the packed module");
    println!(
        "{}: {} bytes, CodeHash {}",
        args[2],
        packed.len(),
        ting_core::hash::hex(&ting_kit_tools::code_hash(&packed))
    );
}

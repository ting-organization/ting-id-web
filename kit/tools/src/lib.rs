//! The kit's tools: [`pack`] makes the module you deploy, and [`testing`] runs
//! programs on Ting's reference VM in your tests.
use wasm_encoder::reencode::{self, Reencode};

pub mod testing;

pub use ting_core;

/// A 32-byte id: a ContractId, an account, a hash.
pub type Id = [u8; 32];

struct Pack;

impl Reencode for Pack {
    type Error = std::convert::Infallible;

    fn parse_custom_section(
        &mut self,
        _: &mut wasm_encoder::Module,
        _: wasmparser::CustomSectionReader<'_>,
    ) -> Result<(), reencode::Error<Self::Error>> {
        Ok(())
    }

    fn parse_export(
        &mut self,
        exports: &mut wasm_encoder::ExportSection,
        export: wasmparser::Export<'_>,
    ) -> Result<(), reencode::Error<Self::Error>> {
        if export.name == "invoke" || export.name == "memory" {
            reencode::utils::parse_export(self, exports, export)?;
        }
        Ok(())
    }
}

/// Packs a linked module for deployment: drops custom sections and every
/// export but `invoke` and `memory`, re-encodes everything in its shortest
/// form (Ting wiki: vm/profile, one encoding), and checks the result against
/// Ting's execution profile.
pub fn pack(linked: &[u8]) -> Result<Vec<u8>, String> {
    let mut module = wasm_encoder::Module::new();
    reencode::utils::parse_core_module(&mut Pack, &mut module, wasmparser::Parser::new(0), linked)
        .map_err(|e| format!("cannot re-encode the module: {e}"))?;
    let packed = module.finish();
    ting_core::vm::profile::validate(&packed)
        .map_err(|e| format!("the module is outside Ting's profile: {e}"))?;
    Ok(packed)
}

/// `H("code", module)`: what `code_hash` answers for a contract running it,
/// and how a page or a program checks which code a contract runs.
pub fn code_hash(module: &[u8]) -> Id {
    ting_core::hash::hash("code", module)
}

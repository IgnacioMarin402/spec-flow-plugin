//! The engine: every hook and every command, as the binary in `main.rs`
//! runs them, and the readers this repository's own checks use.

pub mod agents;
pub mod cli;
pub mod hooks;
pub mod humanturn;
pub mod jsre;
pub mod payload;
pub mod repo;
pub mod shell;
pub mod spec;
pub mod state;
pub mod tracelines;

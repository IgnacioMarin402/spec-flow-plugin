//! The engine's behaviour, as a session, a terminal and CI see it. See
//! harness.rs for how a case runs the engine.

#[macro_use]
pub mod helpers;
pub mod harness;

mod coldstart;
mod crlf;
mod gate;
mod init;
mod launcher;
mod models;
mod package;
mod readers;
mod resume;
mod runner_output;
mod smoke1;
mod smoke2;
mod smoke3;
mod smoke4;
mod smoke5;
mod smoke6;
mod stats;
mod token;
mod trace1;
mod trace2;
mod trace3;

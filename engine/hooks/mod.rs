//! Every hook this plugin registers, run as `spec-flow hook <name>`.
//!
//! `guards` decide: each can deny a tool call. `record` never deny: they
//! record what happened, or reset what a dead run left. Every hook fails open
//! on a crash: a panic is reported on stderr and the hook exits 0.

mod guards;
mod record;

use std::io::{Read, Write};
use std::panic;
use std::sync::OnceLock;

use serde::de::DeserializeOwned;

use crate::payload::{self, Unreadable};

/// How a hook ends.
pub enum Exit {
    /// Exit 0, nothing said.
    Pass,
    /// Exit 0, this on stdout as it stands.
    Say(String),
    /// Exit 0, this on stderr as it stands: the call goes through, and the
    /// transcript says why something changed.
    Note(String),
    /// The PreToolUse denial: the message on stderr as it stands, exit 2.
    Fail(String),
}

/// One hook invocation: its stdin, read once, when the hook first asks.
pub struct Input {
    raw: OnceLock<Vec<u8>>,
}

impl Input {
    /// The payload as `T`, or why it is not one.
    pub fn read<T: DeserializeOwned>(&self) -> Result<T, Unreadable> {
        let raw = self.raw.get_or_init(|| {
            let mut b = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut b);
            b
        });
        payload::parse(raw)
    }
}

pub type Main = fn(&Input) -> Exit;

/// The hook registered as `name`.
pub fn find(name: &str) -> Option<Main> {
    match name {
        "arm-gate" => Some(guards::arm_gate::run),
        "dispatch-guard" => Some(record::dispatch_guard::run),
        "human-turn" => Some(record::human_turn::run),
        "model-route" => Some(guards::model_route::run),
        "no-gate-cmds" => Some(guards::no_gate_cmds::run),
        "opus-budget" => Some(guards::opus_budget::run),
        "preflight" => Some(guards::preflight::run),
        "register-agent" => Some(record::register_agent::run),
        "session-start" => Some(record::session_start::run),
        "stale-resume" => Some(guards::stale_resume::run),
        _ => None,
    }
}

/// Runs `main` and returns the exit code. A crash exits 0: hooks fail open.
pub fn run(main: Main) -> i32 {
    // Always on stderr: a report that sends a human to it has to find it there.
    panic::set_hook(Box::new(|info| {
        let _ = writeln!(std::io::stderr(), "[spec-flow] hook error: {info}");
    }));
    let input = Input {
        raw: OnceLock::new(),
    };
    match panic::catch_unwind(panic::AssertUnwindSafe(|| main(&input))) {
        Ok(Exit::Pass) | Err(_) => 0,
        Ok(Exit::Note(note)) => {
            let _ = std::io::stderr().write_all(note.as_bytes());
            0
        }
        Ok(Exit::Say(out)) => {
            let _ = std::io::stdout().write_all(out.as_bytes());
            0
        }
        Ok(Exit::Fail(message)) => {
            let _ = std::io::stderr().write_all(message.as_bytes());
            2
        }
    }
}

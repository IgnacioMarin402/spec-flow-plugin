//! Every hook this plugin registers, run as `spec-flow hook <name>`.
//!
//! `guards` decide: each can deny a tool call. Every hook fails open on a
//! crash: a panic is reported on stderr and the hook exits 0.

mod guards;

use std::io::{Read, Write};
use std::panic;
use std::sync::OnceLock;

use serde::de::DeserializeOwned;

use crate::payload::{self, Unreadable};

/// How a hook ends.
pub enum Exit {
    /// Exit 0, nothing said.
    Pass,
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
        "no-gate-cmds" => Some(guards::no_gate_cmds::run),
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
        Ok(Exit::Fail(message)) => {
            let _ = std::io::stderr().write_all(message.as_bytes());
            2
        }
    }
}

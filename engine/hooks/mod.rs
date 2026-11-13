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

/// The PreToolUse denial as every guard words it.
pub fn deny(message: &str) -> Exit {
    Exit::Fail(format!("[spec-flow] Denied: {message}\n"))
}

thread_local! {
    static QUIET: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// `f`, or the message of the panic it raised, which the hook then says in
/// its own words: not reported on stderr as the hook's own crash.
pub fn quietly<T>(f: impl FnOnce() -> T) -> Result<T, String> {
    QUIET.with(|q| q.set(true));
    let out = panic::catch_unwind(panic::AssertUnwindSafe(f)).map_err(|p| panic_text(p.as_ref()));
    QUIET.with(|q| q.set(false));
    out
}

/// What a hook's protocol needs said after its crash, given the panic's
/// message.
pub type OnError = fn(&str) -> Exit;

/// The hook registered as `name`, and its crash handler.
pub fn find(name: &str) -> Option<(Main, Option<OnError>)> {
    let main: Main = match name {
        "arm-gate" => guards::arm_gate::run,
        "dispatch-guard" => record::dispatch_guard::run,
        // The one hook that fails CLOSED: an uncaught failure in a Stop hook
        // is indistinguishable from a pass to whoever waits on it.
        "gate" => return Some((guards::gate::run, Some(guards::gate::fail_closed))),
        "human-turn" => record::human_turn::run,
        "lint-on-write" => guards::lint_on_write::run,
        "model-route" => guards::model_route::run,
        "no-gate-cmds" => guards::no_gate_cmds::run,
        "opus-budget" => guards::opus_budget::run,
        "orchestrator-scope" => guards::orchestrator_scope::run,
        "phase-guard" => guards::phase_guard::run,
        "preflight" => guards::preflight::run,
        "register-agent" => record::register_agent::run,
        "session-start" => record::session_start::run,
        "stale-resume" => guards::stale_resume::run,
        _ => return None,
    };
    Some((main, None))
}

/// The message a panic carried.
fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "a panic with no message".into()
    }
}

/// Writes how a hook ends and returns its exit code.
fn finish(exit: Exit) -> i32 {
    match exit {
        Exit::Pass => 0,
        Exit::Note(note) => {
            let _ = std::io::stderr().write_all(note.as_bytes());
            0
        }
        Exit::Say(out) => {
            let _ = std::io::stdout().write_all(out.as_bytes());
            0
        }
        Exit::Fail(message) => {
            let _ = std::io::stderr().write_all(message.as_bytes());
            2
        }
    }
}

/// Runs `main` and returns the exit code. A crash exits 0: hooks fail open,
/// and `on_error` says what that hook's protocol needs said.
pub fn run(main: Main, on_error: Option<OnError>) -> i32 {
    // Always, a handler or not: a report that sends a human to the stack on
    // stderr has to find it there.
    panic::set_hook(Box::new(|info| {
        if QUIET.with(|q| q.get()) {
            return;
        }
        let stack = std::backtrace::Backtrace::force_capture();
        let _ = writeln!(std::io::stderr(), "[spec-flow] hook error: {info}\n{stack}");
    }));
    let input = Input {
        raw: OnceLock::new(),
    };
    match panic::catch_unwind(panic::AssertUnwindSafe(|| main(&input))) {
        Ok(exit) => finish(exit),
        Err(payload) => {
            let Some(handler) = on_error else { return 0 };
            let text = panic_text(payload.as_ref());
            // The handler must not be why this hook goes silent.
            match panic::catch_unwind(|| handler(&text)) {
                Ok(exit) => {
                    finish(exit);
                    0
                }
                Err(_) => 0,
            }
        }
    }
}

//! `session-start` resets a phase a dead run left behind. A run in progress
//! rewrites the phase on every step, so only an abandoned one is old. Every
//! phase that arms anything is reset — preflight arms on all of them, and an
//! abandoned `plan` would refuse every spawn in the repository. `blocked` too:
//! a wait nobody touched for hours is one nobody is coming back to.

use serde::de::IgnoredAny;

use crate::hooks::{Exit, Input};
use crate::state;

const STALE_HOURS: f64 = 6.0;

pub fn run(input: &Input) -> Exit {
    // Nothing in it is read, but it is read: a writer that is never read from
    // can block on a full pipe.
    let _ = input.read::<IgnoredAny>();
    let root = state::project_dir();
    let phase_file = state::phase_path(&root);
    let Some(age) = state::age(&phase_file) else {
        return Exit::Pass;
    };
    // `read_phase`, never the owner check: this hook's subject is a phase
    // whose owner is gone. A committed phase reads as none and is left alone.
    let phase = state::read_phase(&root);
    if !state::is_run_phase(&phase) {
        return Exit::Pass;
    }
    let hours = age.as_secs_f64() / 3600.0;
    if hours < STALE_HOURS {
        return Exit::Pass;
    }
    let dir = state::state_dir(&root);
    state::write_file(&phase_file, "idle");
    state::write_file(&dir.join("gate_attempts"), "0");
    // The seal names a session never coming back; left, it would stand every
    // later session down.
    state::release_phase(&root);
    // The position arms nothing, so it is kept: "start over" becomes "this run
    // was at Mk, and its plan is still on disk".
    let position = state::read_file_or_default(&dir.join("current-milestone"), "");
    let at: Vec<&str> = position.split_whitespace().collect();
    let mut msg = format!(
        "[spec-flow] Phase was '{phase}' and untouched for {}h, so it was treated as an \
         abandoned run and reset to 'idle'. The lint/test gate is disarmed.",
        hours.floor()
    );
    if let [change, milestone, ..] = at[..] {
        msg += &format!(
            " That run was implementing {milestone} of \"{change}\"; its plan is still at \
             specflow/{change}/, and specflow/{change}/milestones/{milestone}.md is where it stopped."
        );
    }
    msg += " To pick it up rather than start over, run /spec-flow:resume — it reads where the \
            run stopped off disk.\n";
    Exit::Say(msg)
}

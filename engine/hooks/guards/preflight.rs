//! `preflight` — PreToolUse on a spawn and on SendMessage — refuses a run the
//! engine cannot finish, at its first agent, where a denial costs nothing. A
//! hook, because a preflight the model must remember is not one. It checks
//! only what stops a run dead: the repository, the contract, the base, and no
//! live change the base already holds (ADR-032). Stands down outside a run.

use serde::de::IgnoredAny;

use crate::hooks::{Exit, Input};
use crate::repo::canrun;
use crate::state;

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // Reads only, and fires on every spawn: creates nothing.
    let phase = state::read_phase(&root);
    if matches!(phase.as_str(), "" | "idle" | "done") {
        return Exit::Pass;
    }
    // Nothing in it is read, but it is read: a writer that is never read
    // from can block on a full pipe.
    let _ = input.read::<IgnoredAny>();
    // The check phase-guard makes at the start (ADR-028), but the settings.
    let Err(refusal) = canrun::check(&root) else {
        return Exit::Pass;
    };
    let what = match refusal.kind {
        "no-repository" => "this directory is in no git repository.",
        "not-root" => "this directory is not the root of its repository.",
        "contract" => "the contract could not be read.",
        "base" => "the base branch could not be resolved.",
        "foreign-change" => "a change the base branch already has is live in specflow/.",
        _ => "this engine cannot run here.",
    };
    let init_helps = if refusal.kind == "contract" {
        " `spec-flow init` regenerates the contract from this repo; `spec-flow init --force` overwrites an existing one."
    } else {
        ""
    };
    Exit::Fail(format!(
        "[spec-flow] PREFLIGHT FAILED — {what}\n\n{}\n\n\
         At a run's first agent nothing has run yet, which is the point of checking here: the same problem would otherwise \
         surface at the first gate, after the planner and an implementer had already been spent on a \
         milestone this engine could not have verified. Past it, something changed under the run, and what it produced stands.\n\n\
         Fix it, then start the run again — or, past its first agent, pick it up with `/spec-flow:resume`.{init_helps}\n",
        // Fires at every spawn, and nothing it reads tells the first from a
        // later one: the message names both.
        refusal.msg
    ))
}

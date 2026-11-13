//! `stale-resume` — PreToolUse on SendMessage — denies resuming one of this
//! plugin's agents whose prompt cache has expired: the message would first
//! re-send its whole context (ADR-025). Outside a run it stands down.

use crate::agents;
use crate::hooks::{Exit, Input};
use crate::payload::{AgentCall, js_string};
use crate::state;

pub fn run(input: &Input) -> Exit {
    if !state::is_run_phase(&state::read_phase(&state::project_dir())) {
        return Exit::Pass;
    }
    // A message this cannot read is one it lets through: a guess would deny
    // work.
    let Ok(call) = input.read::<AgentCall>() else {
        return Exit::Pass;
    };
    let to = js_string(call.input().get("to"));
    let Some(cold) = agents::cold_resume(&to, &call.transcript()) else {
        return Exit::Pass;
    };
    Exit::Fail(format!(
        "[spec-flow] not resuming {agent} {to}: its last turn was {age} minutes ago and its \
         prompt cache lasts {ttl}, so this message would first re-send its whole ~{k}k-token \
         context. Start a NEW {agent} with an Agent call instead: the same inputs its \
         predecessor was given, plus what this message says. The run's state is on disk, not \
         in that agent's context (ADR-025).\n",
        agent = cold.agent,
        to = cold.to,
        age = cold.age_min.round(),
        ttl = cold.ttl_min,
        k = (cold.context as f64 / 1000.0).round(),
    ))
}

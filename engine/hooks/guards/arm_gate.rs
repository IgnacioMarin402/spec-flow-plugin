//! `arm-gate` — PreToolUse on a spawn and on SendMessage — arms the gate when
//! the implementer is put to work: the event that makes the gate necessary is
//! the one that arms it, as the gate writes `blocked` itself at its cap. The
//! orchestrator still writes `implement`; this is the backstop. Its write must
//! be one phase-guard would allow: out of `spec` it denies over a spec that
//! fails (ADR-030, ADR-035). It alone denies engaging the implementer over an
//! unanswered case 3, because it moves the phase and sibling hooks run in
//! parallel (ADR-036). Outside a run it denies this flow's implementer
//! (ADR-044); a person's own `implementer` is theirs.

use std::sync::LazyLock;

use regex::Regex;

use crate::agents;
use crate::hooks::{Exit, Input};
use crate::humanturn;
use crate::payload::AgentCall;
use crate::spec::time;
use crate::state;

/// This flow's implementer, by its namespaced name only: outside a run is
/// where people use their own.
static OWN_AGENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^spec-flow:implementer$").unwrap());

/// Every name the call gives its agent: the input's fields, and for a
/// SendMessage the type the session recorded at the spawn.
fn named(call: &AgentCall) -> Vec<String> {
    let mut named = agents::nameish_fields(&call.input());
    named.push(
        agents::recipient_record(&call.to(), &call.transcript())
            .map_or_else(String::new, |r| agents::recipient_type(&r)),
    );
    named
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // A phase the REPOSITORY committed is no run to advance (ADR-017).
    let read = state::read_phase(&root);
    if (read == "done" || read == "idle") && !state::state_is_tracked(&root) {
        // A call this cannot read names no implementer to deny.
        let Ok(call) = input.read::<AgentCall>() else {
            return Exit::Pass;
        };
        if !named(&call).iter().any(|t| OWN_AGENT.is_match(t)) {
            return Exit::Pass;
        }
        agents::record_dispatch(&root, &call, &read, "implementer", "deny", "no-run", &[]);
        return Exit::Fail(format!(
            "[spec-flow] Denied: no run is in progress (phase '{read}'), and the implementer works only inside one — its work order is a \
             run's plan.md and milestone, and outside a run the gate, lint-on-write and the command deny stand down. To change code \
             now, run `/spec-fix <what is wrong>` (a weak test the fold named is its case 2), or `/spec-flow <feature>` for new behaviour (ADR-044).\n"
        ));
    }
    let phase = if read.is_empty() { "idle".into() } else { read };
    if !state::is_run_phase(&phase) {
        return Exit::Pass;
    }
    // Inside a run, a call this cannot read engages nothing it could arm.
    let Ok(call) = input.read::<AgentCall>() else {
        return Exit::Pass;
    };
    let agent = agents::match_agent(&named(&call), &["implementer"]);
    if agent != "implementer" {
        return Exit::Pass;
    }
    // In every run phase: a re-triage inside `implement` can make a case 3,
    // and no phase write follows it (ADR-036).
    let unconfirmed = humanturn::unconfirmed(&root);
    if !unconfirmed.is_empty() {
        agents::record_dispatch(
            &root,
            &call,
            &phase,
            &agent,
            "deny",
            "case-3-unanswered",
            &[],
        );
        return Exit::Fail(format!(
            "[spec-flow] Denied: {}\n",
            humanturn::denial(&unconfirmed, "engaging the implementer")
        ));
    }
    if phase == "implement" {
        return Exit::Pass; // already armed
    }
    if phase == "spec" {
        let found = time::leaving_spec(&root);
        if !found.is_empty() {
            agents::record_dispatch(&root, &call, &phase, &agent, "deny", "spec-not-ready", &[]);
            return Exit::Fail(format!(
                "[spec-flow] Denied: engaging the implementer while the phase is 'spec' leaves spec, and the spec is not ready to build from:\n  - {}\n\n\
                 Hand these to a new spec-writer with specflow/<SLUG>/ (MODE=TRIAGE for a /spec-fix brief). Then write the next phase \
                 yourself — phase-guard judges it — and engage the implementer (ADR-030).\n",
                found.join("\n  - ")
            ));
        }
    }
    agents::record_dispatch(&root, &call, &phase, &agent, "armed", "phase", &[]);
    state::write_file(&state::phase_path(&root), "implement");
    // This hook performs the transition, so it knows who drove it.
    state::claim_phase(&root, &call.session());
    // Informational, not a block: the call goes through, armed.
    Exit::Note(format!(
        "[spec-flow] Phase was '{phase}' while the implementer was being engaged; armed the gate (phase -> implement). \
         The orchestrator should have written this itself — the hook is the backstop, not the protocol.\n"
    ))
}

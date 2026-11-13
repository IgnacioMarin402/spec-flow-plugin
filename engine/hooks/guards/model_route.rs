//! `model-route` — PreToolUse on a spawn — rewrites a spawn of this plugin's
//! agents: the project's routing into its `model` (ADR-014), and
//! `run_in_background: true` in an attended session (ADR-023). Both rewrites
//! live here because each sibling hook is handed the ORIGINAL input. No
//! permissionDecision: a hook that picks a model has no business answering
//! that. Not gated on the phase: routing is the project's standing answer.

use serde_json::{Value, json};

use crate::agents::{self, Source};
use crate::hooks::{Exit, Input};
use crate::payload::AgentCall;
use crate::state;

pub fn run(input: &Input) -> Exit {
    // A spawn this cannot read names no agent of this plugin's: untouched.
    let Ok(call) = input.read::<AgentCall>() else {
        return Exit::Pass;
    };
    let spawn = call.input();
    let shipped = agents::shipped_routing();
    if shipped.is_empty() {
        return Exit::Pass;
    }
    let names: Vec<&String> = shipped.keys().collect();
    let agent = agents::match_agent(&agents::nameish_fields(&spawn), &names);
    if agent.is_empty() {
        return Exit::Pass; // another plugin's agent, or the harness's
    }
    let root = state::project_dir();
    let (model, source, problems) = agents::resolve_model(&root, &agent, &shipped);
    if !problems.is_empty() {
        return Exit::Fail(format!(
            "[spec-flow] the model routing in .claude/spec-flow.config.json cannot be applied:\n\n  - {}\
             \n\nFix the file, or remove its \"agents\" block to fall back to the routing this plugin ships. \
             This is a denial rather than a shrug because a routing block that reads as though it works and \
             routes nothing is the failure this engine exists to close.\n",
            problems.join("\n  - ")
        ));
    }
    let re_routed = source == Source::Project && !model.is_empty();
    if re_routed {
        let default = shipped.get(&agent).filter(|d| !d.is_empty());
        state::append_unique(
            &state::state_dir(&root).join("model-routes.log"),
            &format!(
                "{agent} -> {model} (project override; shipped default is {})",
                default.map_or("none", String::as_str)
            ),
        );
    }
    // `claude -p` terminates background agents 600 s after its turn ends, and
    // runs hooks with CLAUDE_CODE_SESSION_ATTENDED=0 (ADR-023).
    let attended = std::env::var_os("CLAUDE_CODE_SESSION_ATTENDED").is_none_or(|v| v != "0");
    if !re_routed && !attended {
        return Exit::Pass;
    }
    let mut updated = spawn;
    if re_routed {
        updated.insert("model".into(), Value::String(model));
    }
    if attended {
        updated.insert("run_in_background".into(), Value::Bool(true));
    }
    Exit::Say(
        json!({"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": updated}})
            .to_string(),
    )
}

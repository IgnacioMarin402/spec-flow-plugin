//! `opus-budget` — PreToolUse on a spawn and on SendMessage — holds the
//! flow's two escalation roles to their caps, one each: planner
//! (`max_opus_calls`) and architect (`max_architect_calls`) (ADR-038). A
//! budget the model must remember to count is not a budget. It counts roles,
//! not models: what runs away is the escalation loop, whatever tier it sits on
//! (ADR-014).
//!
//! A SendMessage counts too. An unrecognised recipient is allowed uncounted
//! and leaves its field NAMES — never content — in
//! opus-budget-unmatched.log. `max_opus_calls` keeps its name: a rename would
//! read a configured cap as absent. Two inaccuracies err small and cannot
//! disarm it: it counts the INTENT to spawn, and read-then-write is not
//! atomic.

use std::collections::HashMap;

use serde_json::json;

use crate::agents;
use crate::hooks::{Exit, Input};
use crate::payload::{AgentCall, keys_json};
use crate::state;

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // A call this cannot read names no role it could charge.
    let Ok(call) = input.read::<AgentCall>() else {
        return Exit::Pass;
    };
    // The owner check is safe here: only an orchestrating session spawns
    // (ADR-017).
    let phase = state::read_owned_phase(&root, &call.session());
    if matches!(phase.as_str(), "" | "idle" | "done") {
        return Exit::Pass;
    }
    let dir = state::state_dir(&root);
    let spawn = call.input();
    let nameish = agents::nameish_fields(&spawn);
    let mut agent = agents::match_agent(&nameish, &["planner", "architect"]);
    if agent.is_empty() {
        // register-agent maps opaque ids back to the type they were spawned as.
        let registry: HashMap<String, String> = state::read_text(&dir.join("agent-registry"))
            .unwrap_or_default()
            .lines()
            .filter_map(|l| {
                let mut f = l.split_whitespace();
                Some((f.next()?.to_string(), f.next()?.to_string()))
            })
            .collect();
        if let Some(t) = nameish
            .iter()
            .filter_map(|v| registry.get(v))
            .find(|t| *t == "planner" || *t == "architect")
        {
            agent = t.clone();
        }
    }
    if agent.is_empty() {
        let log = dir.join("opus-budget-unmatched.log");
        if call.tool() == "SendMessage" {
            // Keys ONLY: values embed per-session ids, which would defeat the
            // dedup.
            state::append_unique(&log, &format!(r#"{{"keys":{}}}"#, keys_json(&spawn)));
        } else {
            // Usually a cheap agent doing its job; a RENAMED Opus agent looks
            // the same.
            let mut shape = nameish.join(" ");
            if shape.is_empty() {
                let mut keys: Vec<&String> = spawn.keys().collect();
                keys.sort();
                shape = keys
                    .iter()
                    .map(|k| k.as_str())
                    .collect::<Vec<_>>()
                    .join(",");
            }
            state::append_unique(&log, &json!({ "unmatched-spawn": shape }).to_string());
        }
        return Exit::Pass;
    }
    // A resume stale-resume denies is not a consult: its replacement is
    // charged.
    if call.tool() == "SendMessage" && agents::cold_resume(&call.to(), &call.transcript()).is_some()
    {
        return Exit::Pass;
    }
    let Some(budget) = agents::budget(&agent) else {
        return Exit::Pass;
    };
    let count_file = dir.join(budget.counter);
    let config = state::read_file_or_default(&agents::project_config_path(&root), "");
    let max = agents::budget_cap(&config, &agent);
    let (key, counter) = (budget.key, budget.counter);
    if max < 0 {
        return Exit::Fail(format!(
            "[spec-flow] {key} in .claude/spec-flow.config.json is not a number of calls, so no count of {agent} calls can be held to it. \
             Do not spawn or message the {agent}. Tell the human: they set {key} to a whole number ({} by default) or remove it.\n",
            budget.fallback
        ));
    }
    let used = leading_int(&state::read_file_or_default(&count_file, "0"));
    if used >= max {
        return Exit::Fail(format!(
            "[spec-flow] escalation budget exhausted: {used}/{max} calls to the {agent} this run.\n\n\
             Stop the loop. Do NOT spawn or message another {agent}. Summarize for the \
             human (HITL): which milestone is stuck, what the gate reported, and what you \
             would ask the {agent} if you could. Then wait.\n\n\
             If the run legitimately needs more, the human can raise {key} in \
             .claude/spec-flow.config.json or reset the counter:\n  printf '0' > .claude/state/{counter}\n"
        ));
    }
    state::write_file(&count_file, &(used + 1).to_string());
    Exit::Pass
}

/// The count a counter file holds, as Go's `fmt.Sscan` read it: an optional
/// sign and the digits that follow; 0 when there are none.
fn leading_int(s: &str) -> i64 {
    let (sign, digits) = match s.strip_prefix('-') {
        Some(rest) => (-1, rest),
        None => (1, s.strip_prefix('+').unwrap_or(s)),
    };
    let end = digits.bytes().take_while(u8::is_ascii_digit).count();
    digits[..end].parse::<i64>().map_or(0, |n| sign * n)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_counter_reads_its_leading_number() {
        for (text, want) in [
            ("3", 3),
            ("3\n", 3),
            ("12abc", 12),
            ("", 0),
            ("x", 0),
            ("-2", -2),
        ] {
            assert_eq!(super::leading_int(text), want, "{text:?}");
        }
    }
}

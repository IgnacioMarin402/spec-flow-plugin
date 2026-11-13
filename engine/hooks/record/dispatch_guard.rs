//! `dispatch-guard` — PreToolUse on a spawn and on SendMessage — records what
//! the orchestrator dispatches that the commands do not describe, and lets it
//! through: the rules are read off prose, and a guard denying a step a real
//! run needed stalls it with a human waiting (ADR-035). Outside a run it
//! records one thing: this flow's agent put to work with no run (ADR-040).

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::agents;
use crate::hooks::{Exit, Input};
use crate::payload::AgentCall;
use crate::state;

// Go's `\w`, `\s` and `\b`: ASCII, as the Go engine read them.
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9A-Za-z_]+://[^\t\n\x0C\r ]+").unwrap());
static VAR_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{?[0-9A-Za-z_]+\}?/[^\t\n\x0C\r ]*").unwrap());
static NAMED_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?:^|[\t\n\x0C\r "'`(])((?:[A-Za-z]:)?(?:\./|/)?[0-9A-Za-z_.~-]+(?:/[0-9A-Za-z_.~-]+)+\.[0-9A-Za-z_]{1,8})(?-u:\b)"#,
    )
    .unwrap()
});
static PLAN_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"specflow/[0-9A-Za-z_.-]+/plan\.md").unwrap());
static MILESTONE_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"specflow/[0-9A-Za-z_.-]+/milestones/M[0-9]+\.md").unwrap());
static DRIVE_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:").unwrap());
static OWN_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^spec-flow:([a-z][a-z-]*)$").unwrap());

/// Repository paths a prompt names, past URLs and `${CLAUDE_PLUGIN_ROOT}`
/// paths.
fn named_paths(text: &str, root: &str) -> Vec<String> {
    let repo = format!("{}/", root.replace('\\', "/").trim_end_matches('/'));
    let plain = URL.replace_all(text, "");
    let plain = VAR_PATH.replace_all(&plain, "");
    let mut out: Vec<String> = Vec::new();
    for m in NAMED_PATH.captures_iter(&plain) {
        let p = &m[1];
        let p = match p.strip_prefix(&repo) {
            Some(rel) => rel,
            None => p.strip_prefix("./").unwrap_or(p),
        };
        if !p.starts_with('/') && !DRIVE_START.is_match(p) && !out.iter().any(|o| o == p) {
            out.push(p.into());
        }
    }
    out
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    let phase = state::read_phase(&root);
    let dispatched = agents::dispatched_in(&phase);
    // Outside a run, only where the engine has run before.
    if dispatched.is_none() && !root.join(".claude").join("state").exists() {
        return Exit::Pass;
    }
    // A call this cannot read is one it has nothing to record of.
    let Ok(call) = input.read::<AgentCall>() else {
        return Exit::Pass;
    };
    if matches!(&call.agent_id, Some(Value::String(s)) if !s.is_empty()) {
        return Exit::Pass; // a subagent's call is not the orchestrator dispatching
    }
    let tool = call.tool();
    let spawn = call.input();
    let roles = agents::roles();
    let record = |phase: &str, agent: &str, why: &str, extra: &[(&str, &str)]| {
        agents::record_dispatch(&root, &call, phase, agent, "record", why, extra);
    };

    let (agent, exact_type) = if tool == "SendMessage" {
        let Some(rec) = agents::recipient_record(&call.to(), &call.transcript()) else {
            return Exit::Pass;
        };
        let typ = agents::recipient_type(&rec);
        let exact = if typ.is_empty() {
            rec.to.clone()
        } else {
            typ.clone()
        };
        let mut agent = agents::match_agent(std::slice::from_ref(&exact), &roles);
        if agent.is_empty() {
            agent = typ;
        }
        if agent.is_empty() {
            // An agent this session spawned has a transcript beside its own.
            if dispatched.is_some() && !rec.file.exists() {
                record(&phase, "-", "unknown-target", &[("to", &rec.to)]);
            }
            return Exit::Pass;
        }
        (agent, exact)
    } else {
        let exact = ["subagent_type", "subagentType", "agent_type"]
            .iter()
            .find_map(|k| spawn.get(*k)?.as_str())
            .unwrap_or_default()
            .to_string();
        let agent = agents::match_agent(std::slice::from_ref(&exact), &roles);
        (
            if agent.is_empty() {
                exact.clone()
            } else {
                agent
            },
            exact,
        )
    };

    let Some(dispatched) = dispatched else {
        // By the namespaced name only: outside a run is where people use
        // their own.
        let own = OWN_NAME
            .captures(&exact_type)
            .map_or_else(String::new, |m| m[1].to_lowercase());
        if own == "implementer" && (phase == "done" || phase == "idle") {
            return Exit::Pass; // arm-gate's, which denies it (ADR-044)
        }
        if roles.contains(&own) && !state::state_is_tracked(&root) {
            let phase = if phase.is_empty() { "-" } else { &phase };
            record(phase, &own, "no-run", &[]);
        }
        return Exit::Pass;
    };

    let mut why: Vec<&str> = Vec::new();
    let mut files = String::new();
    if tool != "SendMessage" && agent == "implementer" {
        let parts: Vec<&str> = ["prompt", "description"]
            .iter()
            .filter_map(|k| spawn.get(*k)?.as_str())
            .collect();
        let text = parts.join("\n").replace('\\', "/");
        let plan = PLAN_REF.find(&text).map_or("", |m| m.as_str());
        let milestone = MILESTONE_REF.find(&text).map_or("", |m| m.as_str());
        if plan.is_empty() {
            why.push("no-plan");
        }
        if milestone.is_empty() {
            why.push("no-milestone");
        }
        // The gate's logs are what a respawn after a red gate is handed.
        let other: Vec<String> = named_paths(&text, &root.to_string_lossy())
            .into_iter()
            .filter(|p| p != plan && p != milestone && !p.starts_with(".claude/state/"))
            .collect();
        if !other.is_empty() {
            why.push("other-files");
            files = other.join(",");
        }
    }
    if !roles.contains(&agent) {
        why.push("not-this-flow");
    } else if agent != "implementer" && !dispatched.contains(&agent.as_str()) {
        why.push("phase");
    }
    if !why.is_empty() {
        let agent = if agent.is_empty() { "-" } else { &agent };
        let extra: &[(&str, &str)] = if files.is_empty() {
            &[]
        } else {
            &[("files", &files)]
        };
        record(&phase, agent, &why.join(","), extra);
    }
    Exit::Pass
}

#[cfg(test)]
mod tests {
    #[test]
    fn named_paths_are_the_repositorys() {
        let text = "read /repo/app/a.ts and ./app/b.ts, `lib/c.js`, see https://x.dev/d/e.md and ${CLAUDE_PLUGIN_ROOT}/agents/f.md, not /etc/g.conf or C:/h/i.txt";
        assert_eq!(
            super::named_paths(text, "/repo"),
            ["app/a.ts", "app/b.ts", "lib/c.js"]
        );
    }
}

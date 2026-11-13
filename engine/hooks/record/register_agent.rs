//! `register-agent` — PostToolUse on a spawn — records which session id
//! belongs to which agent: the request names the type and the response the
//! id, and a later SendMessage carries only the id. Phase-independent, so an
//! architect spawned just before the phase flips is still charged; but a
//! repository with no phase never ran this engine and is left alone.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::agents;
use crate::hooks::{Exit, Input};
use crate::payload::keys_json;
use crate::state;

static SESSION_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{16,32}$").unwrap()); // observed ids: 17 hex chars
static LABELED_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:agent[_ ]?id|session[_ ]?id|session|agent|id|name)[^0-9a-f]{0,5}([0-9a-f]{16,32})(?-u:\b)").unwrap()
});
static FAILURE_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?-u:\b)(error|failed|failure|exception|traceback)(?-u:\b)").unwrap()
});
static BARE_HEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)[0-9a-f]{16,32}(?-u:\b)").unwrap());

/// What a response is to JavaScript's `typeof`, for one that is no object.
fn type_name(v: &Value) -> &'static str {
    match v {
        Value::String(_) => "string",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        _ => "object",
    }
}

/// The id the response names: a field holding one, else the text after a
/// label, else — only where nothing failed — any hex run.
fn session_id(res: &Value) -> Option<String> {
    if let Value::Object(m) = res {
        let named = [
            "agent_id",
            "agentId",
            "session_id",
            "sessionId",
            "agentSessionId",
            "id",
            "name",
        ]
        .iter()
        .find_map(|k| m.get(*k)?.as_str().filter(|s| SESSION_ID.is_match(s)));
        if let Some(id) = named {
            return Some(id.into());
        }
    }
    let text = match res {
        Value::String(s) => s.clone(),
        v => v.to_string(),
    };
    if let Some(m) = LABELED_ID.captures(&text) {
        return Some(m[1].into());
    }
    // The bare match is the weakest link — any hex run wins, an MD5 in an
    // error message included — so it is skipped on a failure: a wrong id
    // attributes a LATER SendMessage to the wrong agent.
    if FAILURE_WORD.is_match(&text) {
        return None;
    }
    BARE_HEX.find(&text).map(|m| m.as_str().into())
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // Read as an object of anything: what this records when it finds no id is
    // the payload's keys, so a build that renamed one can be seen.
    let Ok(p) = input.read::<Map<String, Value>>() else {
        return Exit::Pass;
    };
    let spawn = p.get("tool_input").and_then(Value::as_object);
    let types: Vec<String> = ["subagent_type", "subagentType", "agent_type"]
        .iter()
        .filter_map(|k| spawn?.get(*k)?.as_str().map(String::from))
        .collect();
    let agent = agents::match_agent(&types, &["planner", "architect", "implementer"]);
    if agent.is_empty() || state::read_phase(&root).is_empty() {
        return Exit::Pass;
    }
    let dir = state::state_dir(&root);
    let res = [
        "tool_response",
        "tool_result",
        "tool_output",
        "response",
        "output",
    ]
    .iter()
    .find_map(|k| p.get(*k).filter(|v| !v.is_null()))
    .cloned()
    .unwrap_or_else(|| Value::Object(Map::new()));
    let id = session_id(&res);
    // The run's resumable position: written from the SPAWN, by the one
    // reading of a work order. A SendMessage carries no milestone and must not
    // blank it.
    if agent == "implementer"
        && let Some((change, milestone)) =
            agents::milestone_ref(spawn.and_then(|s| s.get("prompt")))
        && !change.is_empty()
    {
        let mut pos = format!("{change} {milestone}");
        if let Some(id) = &id {
            pos += &format!(" {id}");
        }
        state::write_file(&dir.join("current-milestone"), &pos);
    }
    if let Some(id) = id {
        state::append_unique(&dir.join("agent-registry"), &format!("{id} {agent}"));
        return Exit::Pass;
    }
    let keys = match &res {
        Value::Object(m) => keys_json(m),
        v => format!("\"{}\"", type_name(v)),
    };
    state::append_unique(
        &dir.join("register-agent-unmatched.log"),
        &format!(
            r#"{{"payload_keys":{},"response_keys":{keys}}}"#,
            keys_json(&p)
        ),
    );
    Exit::Pass
}

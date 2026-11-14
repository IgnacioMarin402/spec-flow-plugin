//! `human-turn` — Stop, UserPromptSubmit and PostToolUse on AskUserQuestion —
//! records when the turn ends and when a prompt or an answer arrives, for the
//! case 3 check (ADR-036). Never what was said. A prompt opening with a tag is
//! what the harness delivers and is recorded under the tag's name;
//! `<pasted_content>` is a person. Only where the engine was adopted: the
//! prompt that starts a run arrives before its phase is written.

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::Value;

use crate::hooks::{Exit, Input};
use crate::humanturn::LOG;
use crate::payload::js_string;
use crate::state;

// `\s` and `\w` spelled out as ASCII: the Go engine's were.
static PROMPT_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\t\n\x0C\r ]*<([A-Za-z0-9_-]+)").unwrap());

#[derive(Deserialize)]
struct Event {
    hook_event_name: Option<Value>,
    tool_name: Option<Value>,
    prompt: Option<Value>,
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    if !root.join(".spec-flow").join("config.json").exists() {
        return Exit::Pass;
    }
    // One this cannot read records nothing: a missing line holds a case 3,
    // and the check stands down when no answer was ever recorded.
    let Ok(e) = input.read::<Event>() else {
        return Exit::Pass;
    };
    let line = match js_string(e.hook_event_name.as_ref()).as_str() {
        "Stop" => "turn-end".to_string(),
        "PostToolUse"
            if e.tool_name.as_ref().and_then(Value::as_str) == Some("AskUserQuestion") =>
        {
            "prompt from=question".into()
        }
        "UserPromptSubmit" => {
            let prompt = js_string(e.prompt.as_ref());
            let from = match PROMPT_TAG.captures(&prompt) {
                Some(m) if &m[1] != "pasted_content" => m[1].to_string(),
                _ => "human".into(),
            };
            format!("prompt from={from}")
        }
        _ => return Exit::Pass,
    };
    state::append_line(
        &state::state_dir(&root).join(LOG),
        &format!("{} {line}", state::now_iso()),
    );
    Exit::Pass
}

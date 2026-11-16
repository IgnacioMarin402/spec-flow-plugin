//! `human-turn` — Stop, UserPromptSubmit and PostToolUse on AskUserQuestion —
//! records when the turn ends and when a prompt or an answer arrives, for the
//! case 3 check (ADR-036). Never what was said. A prompt opening with a tag is
//! what the harness delivers and is recorded under the tag's name;
//! `<pasted_content>` is a person. Only where the engine was adopted: the
//! prompt that starts a run arrives before its phase is written.
//!
//! A prompt typed as a command's short name is also answered, adopted or
//! not, since answering writes nothing: see [`SHORT_NAME`].

use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::hooks::{Exit, Input};
use crate::humanturn::LOG;
use crate::payload::js_string;
use crate::state;

// `\s` and `\w` spelled out as ASCII: this regex crate's are Unicode.
static PROMPT_TAG: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\t\n\x0C\r ]*<([A-Za-z0-9_-]+)").unwrap());

/// `/spec-flow` and `/spec-fix` without the plugin's namespace. Under
/// `claude -p` the short name is no command, and the prompt reaches the model
/// as text: it does the work itself, with no phase, so no hook armed and no
/// gate. The payload carries the prompt as typed whether it expanded or not,
/// and the transcript is not yet written, so this cannot tell which: it
/// answers with context, never a block — a block would refuse the form
/// wherever it does resolve. `/spec-flow:spec-flow` starts with `:`, not
/// whitespace, and is not matched.
static SHORT_NAME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/(spec-flow|spec-fix)(?:[\t\n\x0C\r ]|$)").unwrap());

fn short_name_notice(command: &str) -> String {
    format!(
        "[spec-flow] This prompt opens with `/{command}`, the command's short name, which a session may not run as a command: under `claude -p` it reaches you as plain text. If no spec-flow command instructions arrived with this prompt, no run has started — no phase is written, so no hook is armed and no gate will judge what is written. Do not carry out the request yourself. Tell the person the command did not run, and that `/spec-flow:{command}` followed by the same text is the form that does."
    )
}

#[derive(Deserialize)]
struct Event {
    hook_event_name: Option<Value>,
    tool_name: Option<Value>,
    prompt: Option<Value>,
}

pub fn run(input: &Input) -> Exit {
    // One this cannot read records nothing: a missing line holds a case 3,
    // and the check stands down when no answer was ever recorded.
    let Ok(e) = input.read::<Event>() else {
        return Exit::Pass;
    };
    let event = js_string(e.hook_event_name.as_ref());
    let said = match SHORT_NAME.captures(&js_string(e.prompt.as_ref())) {
        Some(m) if event == "UserPromptSubmit" => Exit::Say(
            json!({"hookSpecificOutput": {"hookEventName": event, "additionalContext": short_name_notice(&m[1])}})
                .to_string(),
        ),
        _ => Exit::Pass,
    };
    let root = state::project_dir();
    if !root.join(".spec-flow").join("config.json").exists() {
        return said;
    }
    let line = match event.as_str() {
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
        _ => return said,
    };
    state::append_line(
        &state::state_dir(&root).join(LOG),
        &format!("{} {line}", state::now_iso()),
    );
    said
}

//! What a stopped subagent handed its caller. run-trace records it and
//! agent-gate judges it.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::state;

/// Long past the lag measured between a stop and its handback line, short
/// beside a hook's timeout (ADR-050).
pub const HANDBACK_WAIT: Duration = Duration::from_millis(2000);
const HANDBACK_POLL: Duration = Duration::from_millis(25);

#[derive(Deserialize)]
struct Entry {
    message: EntryMessage,
}

#[derive(Deserialize)]
struct EntryMessage {
    #[serde(default)]
    content: Vec<Value>,
}

/// The `message` of the last SubagentHandback call in a transcript.
fn handback_in(path: &Path) -> Option<String> {
    let text = state::read_text(path)?;
    for line in text.split('\n').rev() {
        if !line.contains(r#""SubagentHandback""#) {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Entry>(line) else {
            continue;
        };
        for c in entry.message.content.iter().rev() {
            let Some(c) = c.as_object() else { continue };
            if c.get("type").and_then(Value::as_str) != Some("tool_use")
                || c.get("name").and_then(Value::as_str) != Some("SubagentHandback")
            {
                continue;
            }
            // An input that is no object is a call this cannot read: an
            // earlier one may still be.
            let input = match c.get("input") {
                None | Some(Value::Null) => None,
                Some(Value::Object(i)) => Some(i),
                Some(_) => continue,
            };
            if let Some(msg) = input.and_then(|i| i.get("message")?.as_str()) {
                return Some(msg.into());
            }
            break;
        }
    }
    None
}

/// The report a stopped subagent handed its caller: the last
/// SubagentHandback's `message` in its transcript, else its last message. A
/// stop with neither yet is waited on, briefly: the line can land after the
/// stop fires (ADR-050).
pub fn handed_back(payload: &Map<String, Value>) -> String {
    let text = |k: &str| {
        payload
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let (path, last) = (
        text("agent_transcript_path"),
        text("last_assistant_message"),
    );
    if path.is_empty() {
        return last;
    }
    let path = Path::new(&path);
    if let Some(found) = handback_in(path) {
        return found;
    }
    if !last.trim().is_empty() {
        return last;
    }
    let deadline = Instant::now() + HANDBACK_WAIT;
    while Instant::now() < deadline {
        std::thread::sleep(HANDBACK_POLL);
        if let Some(late) = handback_in(path) {
            return late;
        }
    }
    last
}

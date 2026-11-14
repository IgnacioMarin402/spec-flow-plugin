//! Whether a human has answered since a case 3 brief was written (ADR-036).
//! A case 3 rewrites a requirement to agree with the code, which reads in a
//! diff exactly like rewriting it to agree with the bug. The `human-turn`
//! hook records turn ends and prompts — never what was said — and this reads
//! that record. phase-guard and arm-gate share it.

use std::path::Path;
use std::sync::LazyLock;
use std::time::SystemTime;

use crate::jsre::Re;
use crate::spec::{shape, time};
use crate::state;

/// The record's file under `.claude/state/`.
pub const LOG: &str = "human-turn.log";

struct Event {
    /// Milliseconds since the epoch: what the record's timestamps resolve.
    at: i64,
    /// `turn-end`, or a prompt's source.
    kind: String,
}

static EVENT_LINE: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^(\S+Z) (turn-end|prompt from=(\S+))\s*$", "m"));

fn millis(t: SystemTime) -> i64 {
    match t.duration_since(SystemTime::UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

fn events(root: &Path) -> Vec<Event> {
    let Some(text) = state::read_text(&root.join(".claude").join("state").join(LOG)) else {
        return Vec::new();
    };
    EVENT_LINE
        .exec_all(&text)
        .iter()
        .filter_map(|m| {
            let at = state::parse_rfc3339(m.group(1))? as i64;
            let kind = if m.group(3).is_empty() {
                m.group(2)
            } else {
                m.group(3)
            };
            Some(Event {
                at,
                kind: kind.into(),
            })
        })
        .collect()
}

/// A typed prompt counts only after a turn end that also follows `since`: a
/// background agent's report-back fires the same hook as a person, and what
/// proves the session stopped to wait is the turn having ended first. A
/// question's answer arrives inside the turn, by nature.
fn answered_since(log: &[Event], since: i64) -> bool {
    let ended = log.iter().find(|e| e.kind == "turn-end" && e.at > since);
    log.iter().any(|e| {
        (e.kind == "question" && e.at > since)
            || (e.kind == "human" && ended.is_some_and(|t| e.at > t.at))
    })
}

/// A live fix brief correcting a requirement nobody has answered.
pub struct Brief {
    pub slug: String,
    pub ids: Vec<String>,
}

/// The live fix briefs that correct a requirement and that no human has
/// answered since their last write. Stands down — and says so in
/// human-turn-unmatched.log — while the log holds no answer at all: a build
/// that never fires the hook would otherwise hold every case 3 forever.
pub fn unconfirmed(root: &Path) -> Vec<Brief> {
    let dir = root.join("specflow");
    let mut briefs = Vec::new();
    for slug in time::subdirs(&dir).into_iter().filter(|s| s != "archive") {
        let spec = dir.join(&slug).join("spec.md");
        let Some(written) = std::fs::metadata(&spec)
            .ok()
            .and_then(|m| m.modified().ok())
        else {
            continue;
        };
        let body = state::read_text(&spec).unwrap_or_default();
        if !shape::is_fix_brief(&body) {
            continue;
        }
        let ids: Vec<String> = shape::changed_deltas(&body)
            .into_iter()
            .filter(|c| c.kind == "correction")
            .map(|c| c.id)
            .collect();
        if !ids.is_empty() {
            briefs.push((Brief { slug, ids }, millis(written)));
        }
    }
    if briefs.is_empty() {
        return Vec::new();
    }
    let log = events(root);
    if !log
        .iter()
        .any(|e| e.kind == "human" || e.kind == "question")
    {
        let slugs: Vec<&str> = briefs.iter().map(|(b, _)| b.slug.as_str()).collect();
        state::append_line(
            &state::state_dir(root).join("human-turn-unmatched.log"),
            &format!(
                "{} case-3 check stood down: no answer recorded — {}",
                state::now_iso(),
                slugs.join(", ")
            ),
        );
        return Vec::new();
    }
    briefs
        .into_iter()
        .filter(|(_, written)| !answered_since(&log, *written))
        .map(|(b, _)| b)
        .collect()
}

/// Names the briefs and the step the command describes, never the record:
/// what is wanted is the human's answer.
pub fn denial(found: &[Brief], doing: &str) -> String {
    let what: Vec<String> = found
        .iter()
        .map(|f| format!("specflow/{}/spec.md corrects {}", f.slug, f.ids.join(", ")))
        .collect();
    format!(
        "{doing} while {} — a case 3 — and no human has answered since that brief was last written. \
         Rewriting a requirement to agree with the code reads, in a diff, exactly like rewriting it to agree with the bug, so a person confirms it first. \
         Show the human each requirement id, its current body, the corrected body and the triage's evidence, then end your turn and wait for their answer. \
         If they say the requirement was right after all, send the defect back to a new triage (ADR-036).",
        what.join("; ")
    )
}

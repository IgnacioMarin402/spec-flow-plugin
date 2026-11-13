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

/// `2026-11-13T10:00:00.000Z` as milliseconds since the epoch; the fraction
/// may be any length or absent.
fn parse_iso(s: &str) -> Option<i64> {
    let s = s.strip_suffix('Z')?;
    let (date, clock) = s.split_once('T')?;
    let mut d = date.splitn(3, '-').map(|p| p.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let mut t = hms.splitn(3, ':').map(|p| p.parse::<i64>().ok());
    let (h, mi, se) = (t.next()??, t.next()??, t.next()??);
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&mo)
        || da < 1
        || da > month_days[(mo - 1) as usize]
        || h > 23
        || mi > 59
        || se > 59
    {
        return None;
    }
    if !frac.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let ms = if frac.is_empty() {
        0
    } else {
        format!("{frac:0<3}")[..3].parse::<i64>().ok()?
    };
    // Howard Hinnant's days_from_civil.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) * 1000) + ms)
}

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
            let at = parse_iso(m.group(1))?;
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

#[cfg(test)]
mod tests {
    #[test]
    fn parse_iso_reads_what_iso_writes() {
        use std::time::{Duration, UNIX_EPOCH};
        for ms in [0u64, 951_782_400_123, 1_794_614_400_999] {
            let t = UNIX_EPOCH + Duration::from_millis(ms);
            assert_eq!(super::parse_iso(&crate::state::iso(t)), Some(ms as i64));
        }
        assert_eq!(
            super::parse_iso("2026-11-13T10:00:00Z"),
            Some(1_794_564_000_000)
        );
        assert_eq!(
            super::parse_iso("2026-11-13T10:00:00.5Z"),
            Some(1_794_564_000_500)
        );
        for bad in [
            "not a time",
            "2026-02-30T10:00:00Z",
            "2026-11-13T10:00:60Z",
            "2026-11-13T10:00:00.x1Z",
        ] {
            assert_eq!(super::parse_iso(bad), None, "{bad}");
        }
    }
}

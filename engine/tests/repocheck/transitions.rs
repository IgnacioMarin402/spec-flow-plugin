//! Transitions measures how much HISTORY sits in this engine's comments.
//! `.claude/skills/engine-comments` splits reasoning three ways, and a
//! transition is the one that does not belong where it is written: git holds
//! it with the diff attached, and cannot drift from what happened.
//!
//! The measure is transition TEXT, not comment density. The count is
//! asserted EQUAL to TRANSITIONS_EXPECTED, not capped: a ceiling only notices
//! the direction that gets worse, and a count drifting below it is the stale
//! number this check replaces. Zero is deliberately not the target: where an
//! old shape is a trap someone is likely to reintroduce, one line naming it
//! is an invariant.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::{Report, read_rel, walk};

/// Engine source, the tests included: no file is outside the rule.
pub const TRANSITION_DIRS: [&str; 2] = ["hooks", "engine"];

/// The measured count over TRANSITION_DIRS. Change it in the commit that
/// changes the comments, saying which way it moved and why. A baseline, not
/// a census: its job is to MOVE when someone lets history back in. This
/// file's own comments are counted too.
pub const TRANSITIONS_EXPECTED: usize = 0;

/// Narrow by measurement: a wider pattern matched ordinary English inside an
/// invariant. A miss keeps the number flat; a false positive makes it
/// unreadable.
static TRANSITION: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\bused to\b|\bpreviously\b|\bthe old\b|\bthis replaced\b|\bno longer\b|\bhad been\b|\bfor a while\b|\bonce before\b|\bshipped in exactly\b").unwrap()
});
static COMMENT_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(//|\*|/\*)").unwrap());

/// The comment lines that read as history, as `file:line  text`, and how many
/// files were read.
pub fn transition_lines(root: &Path) -> (Vec<String>, usize) {
    let all: Vec<String> = TRANSITION_DIRS
        .iter()
        .flat_map(|d| walk(root, d, &[".rs", ".ts", ".tsx"], &[]))
        .collect();
    let mut hits = Vec::new();
    for f in &all {
        for (i, line) in read_rel(root, f).split('\n').enumerate() {
            if COMMENT_LINE.is_match(line) && TRANSITION.is_match(line) {
                hits.push(format!("{f}:{}  {}", i + 1, line.trim()));
            }
        }
    }
    (hits, all.len())
}

pub fn transitions(root: &Path) -> Report {
    let mut r = Report::new("comment-transitions");
    let (hits, files) = transition_lines(root);
    // A scan that reached nothing reports exactly as a clean engine does.
    if files == 0 {
        r.problems.push(format!("found no engine source under {}. A scan that reaches nothing passes exactly as a clean one does, so this is a failure rather than a quiet OK.", TRANSITION_DIRS.join(", ")));
        return r;
    }
    if hits.len() != TRANSITIONS_EXPECTED {
        let mut by: BTreeMap<String, usize> = BTreeMap::new();
        for h in &hits {
            *by.entry(h.split(':').next().unwrap_or_default().to_string())
                .or_default() += 1;
        }
        let mut worst: Vec<(&String, &usize)> = by.iter().collect();
        worst.sort_by(|a, b| b.1.cmp(a.1));
        let most: Vec<String> = worst
            .iter()
            .take(5)
            .map(|(f, n)| format!("{n:3}  {f}"))
            .collect();
        let why = if hits.len() > TRANSITIONS_EXPECTED {
            "Something's history moved back into a comment. Git already holds it with the diff attached: put it in the commit message instead, and see .claude/skills/engine-comments for the one case where naming an old shape IS an invariant. If this line is that case, raise TRANSITIONS_EXPECTED and say why in the commit.".to_string()
        } else {
            format!(
                "Fewer than recorded, which is the direction this rule wants, but TRANSITIONS_EXPECTED in engine/tests/repocheck/transitions.rs is now stale. Lower it to {} in the same commit.",
                hits.len()
            )
        };
        r.problems.push(format!(
            "{} transition line(s), and TRANSITIONS_EXPECTED says {TRANSITIONS_EXPECTED}. {why}\n    Most, by file:\n      {}\n    Every line counted:\n      {}",
            hits.len(),
            most.join("\n      "),
            hits.join("\n      ")
        ));
    }
    r.ok = format!(
        "{} transition line(s) across {files} engine source file(s), matching what this check records.",
        hits.len()
    );
    r
}

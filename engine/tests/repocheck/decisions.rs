//! Decisions binds `decisions/` to the code, both directions. A record is
//! trusted on two conditions: it claims a MOMENT, not a present state, and it
//! is REACHABLE from the code it governs with every citation resolving. A
//! citation with no record sends a reader to nothing; a record with no
//! citation is not found at the moment someone is about to undo it.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::{Report, read_rel, surfaces};

/// Where a citation may appear. `decisions/` is deliberately absent: a record
/// citing another is a cross-reference, and counting it would let a record
/// keep itself alive.
pub const CITE_DIRS: [&str; 7] = [
    "hooks",
    "engine",
    "commands",
    "agents",
    "modes",
    ".claude/skills",
    "skills",
];
pub const CITE_EXTS: [&str; 5] = [".rs", ".md", ".json", ".ts", ".tsx"];
pub const CITE_FILES: [&str; 5] = [
    "README.md",
    "REFERENCE.md",
    "CLAUDE.md",
    "BACKLOG.md",
    ".github/workflows/ci.yml",
];

const DECISIONS_SELF: &str = "engine/tests/repocheck/decisions.rs";

/// Three digits, so a year or an id cannot match.
static CITATION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\bADR-(\d{3})\b").unwrap());
static RECORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\d{3})-[a-z0-9-]+\.md$").unwrap());

pub fn decisions(root: &Path) -> Report {
    let mut r = Report::new("decisions");
    let mut records: BTreeMap<String, String> = BTreeMap::new();
    let mut names: Vec<String> = std::fs::read_dir(root.join("decisions"))
        .map(|es| {
            es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for name in names.into_iter().filter(|n| n != "README.md") {
        let Some(m) = RECORD.captures(&name) else {
            r.problems.push(format!("decisions/{name} is not named like a record. Use NNN-a-short-slug.md — the number is what a citation resolves against, so a file without one cannot be cited."));
            continue;
        };
        let n = m[1].to_string();
        if let Some(prev) = records.get(&n) {
            r.problems.push(format!(
                "decisions/ has two records numbered {n}: {prev} and {name}."
            ));
            continue;
        }
        records.insert(n, name);
    }
    let mut cited: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in surfaces(
        root,
        &CITE_DIRS,
        &CITE_EXTS,
        &CITE_FILES,
        DECISIONS_SELF,
        &[],
    ) {
        for m in CITATION.captures_iter(&read_rel(root, &f)) {
            let by = cited.entry(m[1].to_string()).or_default();
            if !by.contains(&f) {
                by.push(f.clone());
            }
        }
    }
    for (n, by) in &cited {
        if !records.contains_key(n) {
            r.problems.push(format!("ADR-{n} is cited by {} but decisions/ has no record numbered {n}. A reader following that citation finds nothing, which is worse than no citation at all.", by.join(", ")));
        }
    }
    for (n, file) in &records {
        if !cited.contains_key(n) {
            r.problems.push(format!("decisions/{file} is cited by nothing. A decision unreachable from the code it governs will not be found at the moment someone is about to undo it. Cite it (`see ADR-{n}`) from the file it constrains, or delete it."));
        }
    }
    r.ok = format!(
        "{} record(s), every one cited; {} citation(s), every one resolving.",
        records.len(),
        cited.len()
    );
    r
}

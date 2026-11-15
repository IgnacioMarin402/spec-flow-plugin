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

// ---- record shas -----------------------------------------------------------

/// The first four records name the commit they were decided in; records since
/// ADR-005 name what they govern instead. Two of those four once named
/// commits that did not exist, and were corrected by hand.
static RECORD_SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\*\*Record:\*\*\s*`([^`]*)`").unwrap());
static SHA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,40}$").unwrap());

fn git(root: &Path, args: &[&str]) -> Option<std::process::Output> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .ok()
}

fn git_ok(root: &Path, args: &[&str]) -> bool {
    git(root, args).is_some_and(|o| o.status.success())
}

/// Every `Record:` sha names a commit HEAD contains. A shallow clone cannot
/// say, and is a problem rather than a pass: a check that reads green where it
/// could not look is the failure this engine exists to close. CI fetches the
/// whole history: a few seconds more than a depth-1 clone.
pub fn record_shas(root: &Path) -> Report {
    let mut r = Report::new("record-shas");
    let shallow = git(root, &["rev-parse", "--is-shallow-repository"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true");
    let mut checked = 0;
    for name in crate::md_in(root, "decisions") {
        let text = read_rel(root, &format!("decisions/{name}"));
        for m in RECORD_SHA.captures_iter(&text) {
            let sha = &m[1];
            let at = format!("decisions/{name} names Record `{sha}`");
            if !SHA.is_match(sha) {
                r.problems.push(format!(
                    "{at}, which is not an abbreviated commit sha (7 to 40 lowercase hex digits)."
                ));
                continue;
            }
            checked += 1;
            let commit = format!("{sha}^{{commit}}");
            let Some(found) = git(root, &["rev-parse", "--verify", "--quiet", &commit]) else {
                r.problems
                    .push(format!("{at}, and git could not be run to resolve it."));
                continue;
            };
            if !found.status.success() {
                r.problems.push(match shallow {
                    Some(true) => format!("{at}, which this shallow clone cannot resolve. Fetch the whole history (`git fetch --unshallow`) and run it again."),
                    Some(false) => format!("{at}, which names no commit in this repository, or more than one. Name the commit the decision landed in: `git log --format='%h %s' -- decisions/{name}` lists the candidates."),
                    None => format!("{at}, and {} is not a git checkout to resolve it in.", root.display()),
                });
                continue;
            }
            let full = String::from_utf8_lossy(&found.stdout).trim().to_string();
            if !git_ok(root, &["merge-base", "--is-ancestor", &full, "HEAD"]) {
                r.problems.push(format!("{at}, a commit HEAD does not contain: it lives only on a branch that was never merged, so a reader following it from this branch finds nothing."));
            }
        }
    }
    r.ok = format!("{checked} Record sha(s), each a commit HEAD contains.");
    r
}

#[cfg(test)]
mod record_sha_cases {
    use super::*;
    use crate::Tree;

    fn run(root: &Path, args: &[&str]) -> String {
        let o = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .env("GIT_AUTHOR_NAME", "fixture")
            .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
            .env("GIT_COMMITTER_NAME", "fixture")
            .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
            .output()
            .unwrap();
        assert!(
            o.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&o.stderr)
        );
        String::from_utf8_lossy(&o.stdout).trim().to_string()
    }

    fn record(sha: &str) -> String {
        format!(
            "# ADR-001 — a record\n\n**Date:** 2026-08-15 · **Status:** accepted · **Record:** `{sha}`\n"
        )
    }

    /// A repository whose first commit is the one a record names.
    fn repo() -> (Tree, String) {
        let t = Tree::new([("src.txt", "one\n")]);
        run(&t.0, &["init", "-q", "-b", "main"]);
        run(&t.0, &["add", "-A"]);
        run(&t.0, &["commit", "-q", "-m", "the decision"]);
        let sha = run(&t.0, &["rev-parse", "--short=7", "HEAD"]);
        (t, sha)
    }

    fn commit_record(t: &Tree, sha: &str) {
        std::fs::create_dir_all(t.0.join("decisions")).unwrap();
        std::fs::write(t.0.join("decisions/001-a-record.md"), record(sha)).unwrap();
        run(&t.0, &["add", "-A"]);
        run(&t.0, &["commit", "-q", "-m", "record it"]);
    }

    #[test]
    fn a_sha_head_contains_passes() {
        let (t, sha) = repo();
        commit_record(&t, &sha);
        let r = record_shas(&t.0);
        assert!(r.problems.is_empty(), "{r}");
        assert!(r.ok.starts_with("1 "), "the record was not read: {r}");
    }

    /// The value ADR-002 carried until 2653425 corrected it by hand.
    #[test]
    fn a_sha_that_names_no_commit_is_reported() {
        let (t, _) = repo();
        commit_record(&t, "021b71d");
        let r = record_shas(&t.0);
        assert!(r.to_string().contains("names no commit"), "{r}");
    }

    #[test]
    fn a_sha_only_an_unmerged_branch_holds_is_reported() {
        let (t, _) = repo();
        run(&t.0, &["checkout", "-q", "-b", "side"]);
        std::fs::write(t.0.join("src.txt"), "side\n").unwrap();
        run(&t.0, &["commit", "-q", "-am", "never merged"]);
        let side = run(&t.0, &["rev-parse", "--short=7", "HEAD"]);
        run(&t.0, &["checkout", "-q", "main"]);
        commit_record(&t, &side);
        let r = record_shas(&t.0);
        assert!(r.to_string().contains("HEAD does not contain"), "{r}");
    }

    #[test]
    fn a_shallow_clone_is_a_problem_not_a_pass() {
        let (t, sha) = repo();
        commit_record(&t, &sha);
        let shallow = Tree::new([]);
        let src = t.0.to_string_lossy().replace('\\', "/");
        let dest = shallow.0.join("clone");
        run(
            &shallow.0,
            &[
                "clone",
                "-q",
                "--no-local",
                "--depth",
                "1",
                &src,
                &dest.to_string_lossy(),
            ],
        );
        let r = record_shas(&dest);
        assert!(r.to_string().contains("git fetch --unshallow"), "{r}");
    }

    #[test]
    fn a_record_value_that_is_no_sha_is_reported() {
        let (t, _) = repo();
        commit_record(&t, "see the PR");
        let r = record_shas(&t.0);
        assert!(
            r.to_string().contains("not an abbreviated commit sha"),
            "{r}"
        );
    }
}

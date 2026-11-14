//! NoRepoRefs fails if any engine file couples itself to one consuming repo:
//! its vocabulary, or the reasoning pattern only its history supports. The
//! engine depends on a contract the repo implements (`.spec-flow/config.json`),
//! never on the repo; this is what makes that arrow verifiable.
//!
//! - vocabulary tokens couple the engine to one codebase. Under ADR-007 the
//!   line is one repo's vocabulary, not one ecosystem's: a test runner's name
//!   is not coupling, its package manager, framework and layer names are.
//! - a "read the archive for precedent" INSTRUCTION couples the engine to one
//!   repo's HISTORY: plan quality becomes a function of how long the repo has
//!   existed. `planner.md` keeps the archive out of a plan (ADR-026). Narrower
//!   than banning `specflow/archive`, the engine's own convention.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::{Report, read_rel, surfaces};

/// The surfaces it claims. Every prose doc goes in NO_REPO_FILES: the moment
/// a reference doc is split out of the README, an unscanned one is the path
/// of least resistance for the vocabulary this keeps out. Both skill
/// directories: `.claude/skills` is this repo's own, `skills` ships to
/// adopters (ADR-006).
pub const NO_REPO_DIRS: [&str; 9] = [
    "hooks",
    "engine",
    "commands",
    "agents",
    "modes",
    ".claude/skills",
    "skills",
    "decisions",
    "evals",
];
pub const NO_REPO_EXTS: [&str; 7] = [".rs", ".md", ".json", ".ts", ".tsx", ".sh", ".yaml"];
pub const NO_REPO_FILES: [&str; 8] = [
    "README.md",
    "REFERENCE.md",
    "CLAUDE.md",
    "LICENSE",
    "BACKLOG.md",
    ".github/workflows/ci.yml",
    "bin/spec-flow",
    "Cargo.toml",
];

/// It names what it bans, necessarily.
pub const NO_REPO_SELF: &str = "engine/tests/repocheck/norepo.rs";

/// Written by each `claude plugin eval` run and gitignored: a model's output.
const EVAL_RESULTS: &str = "evals/results";

/// Whole-word or path-shaped: a substring match on "application" would also
/// flag the English word.
static BANNED: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    [
        (r"\bsrc/", "src/"),
        (r"\bapplication/|\bapplication layer\b|application/use-cases", "application (the hexagonal layer)"),
        (r"\binfrastructure/|\binfrastructure layer\b", "infrastructure (the hexagonal layer)"),
        (r"\bdomain/(services|interfaces|value-objects|models)?\b", "domain/ (the hexagonal layer)"),
        (r"\bpnpm run\b", "pnpm run"),
        (r"\beslint\.config\.mjs\b", "eslint.config.mjs"),
        (r"(?i)\bNestJS\b", "NestJS"),
        (r"\bdomain-service-trace\b", "domain-service-trace"),
        // Proximity, not a path-string ban.
        (
            r"(?i)\barchive\b[^.]{0,60}\b(precedent|inspiration)\b|\b(precedent|inspiration)\b[^.]{0,60}\barchive\b",
            "reads the archive for precedent/inspiration — shape guidance from one repo's history, not this repo's job",
        ),
    ]
    .into_iter()
    .map(|(p, l)| (Regex::new(p).unwrap(), l))
    .collect()
});

pub fn no_repo_refs(root: &Path) -> Report {
    let files = surfaces(
        root,
        &NO_REPO_DIRS,
        &NO_REPO_EXTS,
        &NO_REPO_FILES,
        NO_REPO_SELF,
        &[EVAL_RESULTS],
    );
    let mut r = Report::new("no-repo-refs");
    r.advice = "The engine must run identically against any consuming repo. A value that belongs to one repo goes in that repo's .spec-flow/config.json, not in this file.";
    for f in &files {
        for (i, line) in read_rel(root, f).split('\n').enumerate() {
            for (re, label) in BANNED.iter() {
                if re.is_match(line) {
                    r.problems
                        .push(format!("{f}:{}  {label}\n    {}", i + 1, line.trim()));
                }
            }
        }
    }
    r.ok = format!(
        "{} file(s) clean of repo-specific vocabulary and history.",
        files.len()
    );
    r
}

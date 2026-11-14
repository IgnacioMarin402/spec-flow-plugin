//! Whether this engine can run in a directory: what preflight asks at a
//! run's first spawn and phase-guard at the write that starts one (ADR-028).
//! One copy, so the two cannot drift.

use std::path::Path;

use crate::agents;
use crate::repo::contract;
use crate::repo::gitscope::{self, Refusal};

/// What in `.claude/spec-flow.config.json` cannot be applied: a cap
/// opus-budget denies every call at, a route model-route denies every spawn
/// over, or a file none of whose settings apply.
pub fn settings_problems(root: &Path) -> Vec<String> {
    let text = match std::fs::read(agents::project_config_path(root)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            return vec![format!(
                "could not be read ({e}), so none of its settings apply"
            )];
        }
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
    };
    let (settings, problem) = agents::project_config(&text);
    if !problem.is_empty() {
        return vec![problem];
    }
    let mut out = Vec::new();
    for role in agents::BUDGET_ROLES {
        if agents::budget_cap(&text, role) < 0 {
            let key = agents::budget(role).map_or("", |b| b.key);
            let v = settings
                .get(key)
                .map_or_else(|| "null".into(), |v| v.to_string());
            out.push(format!(
                "\"{key}\": {v} is not a whole number of calls, so opus-budget would deny every {role} call."
            ));
        }
    }
    let (_, routing) = agents::project_routing(root, &agents::shipped_routing());
    out.extend(routing);
    out
}

/// The first failure, its kind naming it: `no-repository` and `not-root`,
/// then `contract`, `base`, `foreign-change`. The repository first: a
/// contract read from a subdirectory is the wrong one (ADR-027).
pub fn check(root: &Path) -> Result<(), Refusal> {
    gitscope::assert_repo_root(root)?;
    let config = contract::load(root).map_err(|msg| Refusal {
        kind: "contract",
        msg,
    })?;
    let base =
        gitscope::resolve_base(root, Some(&config)).map_err(|msg| Refusal { kind: "base", msg })?;
    // A run here could never be marked done: `done` needs every change folder
    // archived, and this one is no run of this branch to archive (ADR-032).
    let foreign = gitscope::changes_at_base(root, &base);
    if !foreign.is_empty() {
        let folders: Vec<String> = foreign.iter().map(|s| format!("specflow/{s}/")).collect();
        let (are, them) = if foreign.len() > 1 {
            ("are", "them")
        } else {
            ("is", "it")
        };
        return Err(Refusal {
            kind: "foreign-change",
            msg: format!(
                "{} {are} live, and the base branch already has {them}, so no run on this branch created {them}. \
                 A folder under specflow/ is a change in flight, and a run is not done while one is unarchived. \
                 A plan nobody has run belongs outside specflow/; a change that was dropped or shipped gets its **Status:** stamp and moves to specflow/archive/. \
                 Either is the human's call, best made on the base branch so the next branch does not inherit it.",
                folders.join(", ")
            ),
        });
    }
    Ok(())
}

/// `check` and the settings: what phase-guard asks of the write that starts
/// a run. Not preflight at each spawn: mid-run each hook applies what it can,
/// and a refusal there would stop every spawn (ADR-049).
pub fn check_start(root: &Path) -> Result<(), Refusal> {
    check(root)?;
    let s = settings_problems(root);
    if !s.is_empty() {
        return Err(Refusal {
            kind: "settings",
            msg: format!(
                ".claude/spec-flow.config.json cannot be applied:\n  - {}\nFix each, or remove the setting to take its default.",
                s.join("\n  - ")
            ),
        });
    }
    Ok(())
}

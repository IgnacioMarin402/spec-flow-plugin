//! A live change spec held to what spec-trace checks at the gate, plus what
//! only its writing is held to: its assumptions (ADR-030), the shape of its
//! deltas and its name. phase-guard and arm-gate deny leaving `spec` on them.

use std::path::Path;

use crate::spec::shape;
use crate::state;

/// The names of the directories directly under `dir`, sorted.
pub fn subdirs(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .filter_map(|e| {
            let e = e.ok()?;
            e.file_type().ok()?.is_dir().then_some(())?;
            e.file_name().into_string().ok()
        })
        .collect();
    out.sort();
    out
}

/// The change folders under `specflow/archive/`.
pub fn archived_slugs(root: &Path) -> Vec<String> {
    subdirs(&root.join("specflow").join("archive"))
}

/// One message per problem across `slugs`, each naming its spec. The deltas'
/// shape is held here, not at every gate: a run signed off before a spelling
/// was refused must not fail its milestones over it (ADR-048). The name
/// (`clash`) only while nothing names the folder yet.
pub fn problems(root: &Path, slugs: &[String], clash: bool) -> Vec<String> {
    let specflow = root.join("specflow");
    let archived = archived_slugs(root);
    let bodies: Vec<String> = archived
        .iter()
        .filter_map(|slug| state::read_text(&specflow.join("archive").join(slug).join("spec.md")))
        .collect();
    let mut found = Vec::new();
    for slug in slugs {
        let Some(body) = state::read_text(&specflow.join(slug).join("spec.md")) else {
            continue; // a folder mid-write is not a failure
        };
        let spec = format!("specflow/{slug}/spec.md");
        if clash {
            let taken = shape::archive_clash(slug, &archived);
            if !taken.is_empty() {
                found.push(taken);
            }
        }
        let a = shape::assumptions_problem(&body);
        if !a.is_empty() {
            found.push(format!("{spec} {a}."));
        }
        let s = shape::deltas_section_problem(&body, true);
        if !s.is_empty() {
            found.push(format!("{spec} {s}"));
        }
        for u in shape::unread_deltas(&body) {
            found.push(format!("{spec}: {}", shape::explain_unread(&u)));
        }
        let has_proposal = specflow.join(slug).join("proposal.md").exists();
        found.extend(shape::live_spec_problems(
            slug,
            &body,
            has_proposal,
            &bodies,
        ));
    }
    found
}

/// What leaving `spec` is held to: every live change with no plan yet, and
/// every fix brief, whose triage writes its plan inside `spec` (ADR-033).
/// phase-guard and arm-gate both ask it, so they cannot disagree.
pub fn leaving_spec(root: &Path) -> Vec<String> {
    let dir = root.join("specflow");
    let unplanned: Vec<String> = subdirs(&dir)
        .into_iter()
        .filter(|slug| slug != "archive")
        .filter(|slug| {
            !dir.join(slug).join("plan.md").exists()
                || state::read_text(&dir.join(slug).join("spec.md"))
                    .is_some_and(|b| shape::is_fix_brief(&b))
        })
        .collect();
    problems(root, &unplanned, true)
}

#[cfg(test)]
mod tests {
    /// What leaving `spec` is held to reaches every check a spec is written
    /// to, each naming its spec; a planned feature is not held, a fix brief is.
    #[test]
    fn leaving_spec_holds_each_unplanned_change() {
        let root = std::env::temp_dir().join(format!("spec-flow-leaving-{}", std::process::id()));
        let change = |slug: &str, body: &str, plan: bool| {
            let dir = root.join("specflow").join(slug);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("spec.md"), body).unwrap();
            std::fs::write(dir.join("proposal.md"), "why\n").unwrap();
            if plan {
                std::fs::write(dir.join("plan.md"), "plan\n").unwrap();
            }
        };
        let bare = "# Spec — x\n\n## Requirement deltas\n- ADDED REQ-A-001 — export\n";
        change("unplanned", bare, false);
        change("planned", bare, true);
        change(
            "fix",
            "# Fix — x\n\n## Case\n2 WEAK-TEST\n\n## Requirement deltas\n- ADDED REQ-A-02 — x\n",
            true,
        );
        std::fs::create_dir_all(root.join("specflow").join("archive").join("Unplanned")).unwrap();
        let found = super::leaving_spec(&root);
        let _ = std::fs::remove_dir_all(&root);
        let has = |s: &str| found.iter().any(|f| f.contains(s));
        assert!(
            has("specflow/unplanned/spec.md has no `## Assumptions` section."),
            "{found:#?}"
        );
        assert!(
            has("specflow/unplanned/ has the name of an archived change"),
            "{found:#?}"
        );
        assert!(
            has("specflow/fix/spec.md: \"- ADDED REQ-A-02 — x\" names REQ-A-02"),
            "{found:#?}"
        );
        assert!(
            !has("specflow/planned/"),
            "a planned change was held: {found:#?}"
        );
        assert!(
            !has("specflow/fix/spec.md has no `## Assumptions`"),
            "a fix brief was held to assumptions"
        );
    }

    /// A file under the archive is no change: a live change named like it
    /// would be refused over a clash with nothing the fold could land in.
    #[test]
    fn archived_slugs_are_folders() {
        let root = std::env::temp_dir().join(format!("spec-flow-archive-{}", std::process::id()));
        let archive = root.join("specflow").join("archive");
        std::fs::create_dir_all(archive.join("add-users")).unwrap();
        std::fs::write(archive.join("fix-login"), "a file, not a change\n").unwrap();
        let got = super::archived_slugs(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(got, ["add-users"]);
    }
}

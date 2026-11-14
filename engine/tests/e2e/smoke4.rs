//! phase-guard: quoting, the ends of a run, and leaving `spec` (ADR-030).

use std::path::Path;

use serde_json::json;

use crate::harness::*;
use crate::helpers::*;
use crate::smoke1::bash;
use crate::smoke2::write_change;
use crate::smoke3::{phase_bash, post_tool, seed_gate_history};

fn unmatched_log(repo: &Path) -> String {
    read(state_path(repo, "phase-guard-unmatched.log"))
        .trim()
        .to_string()
}

/// A commit message naming a phase write is no write, and an escape or a
/// heredoc does not hide a real write next to it.
#[test]
fn phase_guard_reads_quoted_text_a_heredoc_body_and_a_comment_as_text() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    for c in [
        r#"git commit -m "note: printf done > .claude/state/phase comes later""#,
        "git commit -m 'printf done | tee .claude/state/phase' && git push",
        r#"git commit -m "a > b" -m "then printf done > .claude/state/phase""#,
        "git commit -m \"$(cat <<'EOF'\nnote: printf done >\n.claude/state/phase comes later\nEOF\n)\"",
        "git commit -F - <<'EOF'\nnote: printf done > .claude/state/phase\nEOF",
        r#"git commit -m "step 1; cd .claude/state" && printf done > phase"#,
        "echo checked # then printf done > .claude/state/phase",
    ] {
        expect_status(
            &run_hook("phase-guard", bash(c), &repo),
            0,
            &format!("`{c}` was denied as a phase write"),
        );
    }
    assert_eq!(
        unmatched_log(&repo),
        "",
        "text was logged as a write that got past"
    );
}

#[test]
fn phase_guard_reads_a_phase_write_the_quoting_beside_it_does_not_hide() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    for c in [
        r#"git commit -m "x > y" && printf done > .claude/state/phase"#,
        r#"printf "done" > ".claude/state/phase""#,
        r#"printf done > "$CLAUDE_PROJECT_DIR"/.claude/state/phase"#,
        r"git commit -m 'it'\''s done' && printf done > .claude/state/phase",
        r#"git commit -m "a \"b" && printf done > .claude/state/phase && echo "c""#,
        "git commit -m \"$(cat <<'EOF'\nfix: the \"reviewer's\" verdict\nEOF\n)\" && printf done > .claude/state/phase",
        r#"echo "M3 -> done" && printf done > .claude/state/phase"#,
        "echo implement > /tmp/note && printf done > .claude/state/phase",
        r#"x="$(printf done > .claude/state/phase)""#,
        "bash <<'EOF'\nprintf done > .claude/state/phase\nEOF",
        "x=$((1 << 2))\nprintf done > .claude/state/phase",
    ] {
        expect_status(
            &run_hook("phase-guard", bash(c), &repo),
            2,
            &format!("`{c}` wrote an unearned done"),
        );
    }
}

#[test]
fn phase_guard_logs_a_phase_write_handed_to_a_shell_as_text() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    for c in [
        "sh -c 'printf done > .claude/state/phase'",
        "eval 'printf done > .claude/state/phase'",
    ] {
        run_hook("phase-guard", bash(c), &repo);
    }
    assert_eq!(
        unmatched_log(&repo),
        "sh\neval",
        "want sh and eval logged as writes that got past"
    );
}

#[test]
fn run_trace_closes_a_run_on_a_phase_write_never_on_text_that_names_one() {
    let repo = repo_in("done");
    let post = |c: &str| {
        run_hook(
            "run-trace",
            post_tool("s", "Bash", json!({"command": c})),
            &repo,
        );
    };
    for c in [
        r#"git commit -m "note: printf done > .claude/state/phase comes later""#,
        "git commit -F - <<'EOF'\nnote: printf done > .claude/state/phase\nEOF",
    ] {
        post(c);
        assert_eq!(trace_text(&repo), "", "`{c}` closed the run");
    }
    for c in [
        r#"git commit -m "x > y" && printf done > ".claude/state/phase""#,
        r#"printf done > "$CLAUDE_PROJECT_DIR"/.claude/state/phase"#,
        "sh -c 'printf done > .claude/state/phase'",
    ] {
        let _ = std::fs::remove_file(state_path(&repo, "run-trace.log"));
        post(c);
        must_match(
            "(?m) phase=done session=s closed tool=Bash$",
            &trace_text(&repo),
            &format!("`{c}` left no closing line"),
        );
    }
}

#[test]
fn a_cd_makes_no_other_file_named_phase_nor_another_state_file_a_phase_write() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    for c in [
        "cd .claude/state && printf 0 > gate_attempts",
        "cd docs && printf done > phase",
        "echo cd .claude/state && printf done > phase",
        "cd .claude/state && cat phase > /tmp/p",
    ] {
        expect_status(
            &run_hook("phase-guard", bash(c), &repo),
            0,
            &format!("`{c}` was denied as a phase write"),
        );
    }
    assert!(
        !exists(state_path(&repo, "phase-guard-unmatched.log")),
        "logged as an unread phase write: {}",
        unmatched_log(&repo)
    );
}

#[test]
fn a_phase_write_it_cannot_read_after_a_cd_is_logged_under_its_writer_not_cd() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "phase-guard",
        bash("cd .claude/state && cat /tmp/x > phase"),
        &repo,
    );
    assert_eq!(unmatched_log(&repo), "cat", "want the writer cat logged");
}

#[test]
fn phase_guard_denies_done_when_no_gate_ever_judged_the_current_commit() {
    let repo = make_repo(RepoOpts::default());
    let r = run_hook(
        "phase-guard",
        json!({"tool_name": "Write", "tool_input": {"file_path": ".claude/state/phase", "content": "done"}}),
        &repo,
    );
    expect_status(&r, 2, "done was allowed with no gate verdict at all");
}

#[test]
fn phase_guard_denies_idle_mid_implement() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    expect_status(
        &run_hook("phase-guard", phase_bash("idle"), &repo),
        2,
        "idle was allowed from implement after a red gate",
    );
}

#[test]
fn phase_guard_denies_idle_over_a_change_folder_that_was_never_recorded() {
    let repo = repo_in("spec");
    std::fs::create_dir_all(repo.join("specflow/my-change")).unwrap();
    let r = run_hook("phase-guard", phase_bash("idle"), &repo);
    expect_status(
        &r,
        2,
        "idle was allowed with specflow/my-change/ still live",
    );
    must_match(
        "my-change",
        &r.stderr,
        "the denial does not name the folder",
    );
}

// Guards: the protocol's own paths to idle must keep passing.

#[test]
fn phase_guard_allows_idle_once_the_rejection_is_archived() {
    let repo = repo_in("spec");
    std::fs::create_dir_all(repo.join("specflow/archive/my-change")).unwrap();
    expect_status(
        &run_hook("phase-guard", phase_bash("idle"), &repo),
        0,
        "the protocol's own rejection path was denied",
    );
}

#[test]
fn phase_guard_allows_idle_from_blocked() {
    let repo = repo_in("blocked");
    std::fs::create_dir_all(repo.join("specflow/my-change")).unwrap();
    expect_status(
        &run_hook("phase-guard", phase_bash("idle"), &repo),
        0,
        "a human abandoning a blocked run was refused",
    );
}

// ---- leaving `spec` needs a spec its first gate would accept (ADR-030) ----

pub const SIGNED_SPEC: &str = "# Spec — my-change: x\n\n## Requirement deltas\n- ADDED REQ-USER-001 — a thing\n\n## Assumptions\n- none\n\n## Out of scope\n- nothing\n";

pub fn write_phase(repo: &Path, value: &str) -> Output {
    run_hook("phase-guard", phase_bash(value), repo)
}

fn without_assumptions() -> String {
    SIGNED_SPEC.replacen("## Assumptions\n- none\n\n", "", 1)
}

#[test]
fn leaving_spec_denies_plan_while_the_spec_says_nothing_of_what_it_assumed() {
    let repo = repo_in("spec");
    write_change(&repo, &without_assumptions(), true, "");
    let r = write_phase(&repo, "plan");
    expect_status(&r, 2, "plan was allowed over a spec with no Assumptions");
    must_match(
        r"my-change/spec\.md has no `## Assumptions`",
        &r.stderr,
        "the denial does not name the spec and the section",
    );
    must_match(
        "sign-off again",
        &r.stderr,
        "the denial does not send the change back to sign-off",
    );
}

#[test]
fn leaving_spec_denies_plan_over_what_spec_trace_would_reject_at_the_first_gate() {
    let repo = repo_in("spec");
    write_change(
        &repo,
        &SIGNED_SPEC.replacen(
            "## Out of scope",
            "## Decision\nchosen\n\n## Out of scope",
            1,
        ),
        false,
        "",
    );
    let r = write_phase(&repo, "plan");
    expect_status(
        &r,
        2,
        "plan was allowed over a spec carrying ## Decision with no proposal.md",
    );
    must_match("## Decision", &r.stderr, "the denial misses ## Decision");
    must_match(
        r"no proposal\.md",
        &r.stderr,
        "the denial misses the proposal",
    );
}

#[test]
fn leaving_spec_denies_plan_over_an_added_that_pairs_a_prohibition_with_another_claim() {
    let repo = repo_in("spec");
    write_change(
        &repo,
        &SIGNED_SPEC.replacen("a thing", "filters by A and B, never by C", 1),
        true,
        "",
    );
    let r = write_phase(&repo, "plan");
    expect_status(&r, 2, "plan was allowed over a prohibition sharing its id");
    must_match(
        "REQ-USER-001",
        &r.stderr,
        "the denial does not name the delta",
    );
    must_match(
        "id of its own",
        &r.stderr,
        "the denial does not name the split",
    );
}

#[test]
fn leaving_spec_denies_plan_over_a_delta_line_the_engine_does_not_read() {
    let repo = repo_in("spec");
    write_change(
        &repo,
        &SIGNED_SPEC.replacen(
            "- ADDED REQ-USER-001 — a thing",
            "- **ADDED** REQ-USER-001 — a thing",
            1,
        ),
        true,
        "",
    );
    let r = write_phase(&repo, "plan");
    expect_status(&r, 2, "plan was allowed over a delta no check reads");
    must_match(
        "names REQ-USER-001, which no delta line",
        &r.stderr,
        "the denial does not quote the line",
    );
}

#[test]
fn leaving_spec_denies_plan_over_deltas_no_check_reads() {
    for (name, body, says) in [
        (
            "a heading spelled another way",
            SIGNED_SPEC.replacen("## Requirement deltas", "## Requirement Deltas", 1),
            "has \"## Requirement Deltas\"",
        ),
        (
            "deltas outside their section",
            SIGNED_SPEC.replacen(
                "## Requirement deltas\n- ADDED REQ-USER-001 — a thing",
                "## ADDED Requirements\n### REQ-USER-001 — a thing",
                1,
            ),
            "declares a delta outside",
        ),
        (
            "no deltas section",
            SIGNED_SPEC.replacen(
                "## Requirement deltas\n- ADDED REQ-USER-001 — a thing\n",
                "",
                1,
            ),
            "has no `## Requirement deltas` section",
        ),
        (
            "a section saying nothing the engine reads",
            SIGNED_SPEC.replacen(
                "- ADDED REQ-USER-001 — a thing",
                "This change adds the export.",
                1,
            ),
            "says nothing the engine reads",
        ),
    ] {
        let repo = repo_in("spec");
        write_change(&repo, &body, true, "");
        let r = write_phase(&repo, "plan");
        expect_status(&r, 2, &format!("plan was allowed over {name}"));
        assert!(
            r.stderr.contains(says),
            "{name}: the denial does not say {says:?}: {}",
            r.stderr
        );
    }
}

fn archived(repo: &Path) {
    write(
        repo.join("specflow/archive/my-change/spec.md"),
        "# Spec — my-change\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
    );
}

#[test]
fn leaving_spec_denies_plan_over_a_change_named_like_an_archived_one() {
    let repo = repo_in("spec");
    write_change(&repo, SIGNED_SPEC, true, "");
    archived(&repo);
    let r = write_phase(&repo, "plan");
    expect_status(
        &r,
        2,
        "plan was allowed over a change the fold would move inside another",
    );
    must_match(
        "has the name of an archived change",
        &r.stderr,
        "the denial does not name the clash",
    );
}

/// On a case-insensitive filesystem the fold moves My-Change into my-change.
#[test]
fn leaving_spec_denies_plan_over_a_name_the_archive_has_in_another_case() {
    let repo = repo_in("spec");
    write_change(&repo, SIGNED_SPEC, true, "My-Change");
    archived(&repo);
    let r = write_phase(&repo, "plan");
    expect_status(
        &r,
        2,
        "plan was allowed over a name differing from an archived one only in case",
    );
    must_match(
        "has the name of an archived change",
        &r.stderr,
        "the denial does not name the clash",
    );
}

#[test]
fn leaving_spec_allows_each_prohibition_on_its_own_id() {
    let repo = repo_in("spec");
    write_change(
        &repo,
        &SIGNED_SPEC.replacen(
            "- ADDED REQ-USER-001 — a thing",
            "- ADDED REQ-USER-001 — filters by A and B\n- ADDED REQ-USER-002 — never filters by C",
            1,
        ),
        true,
        "",
    );
    expect_status(
        &write_phase(&repo, "plan"),
        0,
        "a prohibition on its own id was denied",
    );
}

const UNREADY: &str = "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — now right\n";

#[test]
fn leaving_spec_denies_implement_over_a_fix_brief_whose_changed_says_no_kind() {
    let repo = repo_in("spec");
    write_change(&repo, UNREADY, false, "");
    expect_status(
        &write_phase(&repo, "implement"),
        2,
        "implement was allowed over a CHANGED with no kind",
    );
}

/// The triage writes a fix's plan inside `spec` (ADR-033).
#[test]
fn leaving_spec_holds_a_fix_brief_to_its_spec_time_checks_even_once_its_triage_wrote_the_plan() {
    let repo = repo_in("spec");
    write_change(&repo, UNREADY, false, "");
    write(
        repo.join("specflow/my-change/plan.md"),
        "# Plan — my-change\n",
    );
    expect_status(
        &write_phase(&repo, "implement"),
        2,
        "implement was allowed over a fix brief with a CHANGED of no kind, because it had a plan",
    );
}

#[test]
fn leaving_spec_allows_a_signed_off_spec_and_a_fix_brief_without_assumptions() {
    let repo = repo_in("spec");
    write_change(&repo, SIGNED_SPEC, true, "");
    write_change(
        &repo,
        "# Fix — a-fix\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-002 (correction) — now right\n",
        false,
        "a-fix",
    );
    expect_status(
        &write_phase(&repo, "plan"),
        0,
        "a ready spec and a ready fix brief were denied",
    );
}

#[test]
fn leaving_spec_does_not_hold_the_change_being_signed_off_to_another_one_already_planned() {
    let repo = repo_in("spec");
    write_change(&repo, &without_assumptions(), true, "planned-before");
    write(repo.join("specflow/planned-before/plan.md"), "# Plan\n");
    write_change(&repo, SIGNED_SPEC, true, "");
    expect_status(
        &write_phase(&repo, "plan"),
        0,
        "plan was denied over a change that already has a plan",
    );
}

#[test]
fn leaving_spec_does_not_hold_a_run_already_past_spec_to_the_assumptions_rule() {
    let repo = repo_in("plan");
    write_change(&repo, &without_assumptions(), true, "");
    expect_status(
        &write_phase(&repo, "review"),
        0,
        "a run planned before the section existed was denied review",
    );
}

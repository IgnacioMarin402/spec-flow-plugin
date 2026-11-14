//! arm-gate out of `spec`, lint-on-write, scope globs as the gate reads them,
//! and whose state a phase is (ADR-017).

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;
use crate::smoke1::bash;
use crate::smoke2::write_change;

const UNREADY_BRIEF: &str = "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — now right\n";

pub fn engage_implementer(repo: &Path) -> Output {
    run_hook(
        "arm-gate",
        json!({"session_id": "s", "tool_name": "Agent", "tool_input": {"subagent_type": "implementer", "prompt": "specflow/my-change/plan.md specflow/my-change/milestones/M1.md"}}),
        repo,
    )
}

/// arm-gate writes `implement` itself, and that write never passes phase-guard.
#[test]
fn arm_gate_does_not_carry_a_brief_out_of_spec_that_phase_guard_would_hold_there() {
    let repo = repo_in("spec");
    write_change(&repo, UNREADY_BRIEF, false, "");
    write(
        repo.join("specflow/my-change/plan.md"),
        "# Plan — my-change\n",
    );
    let r = engage_implementer(&repo);
    assert_eq!(
        phase_of(&repo),
        "spec",
        "engaging the implementer moved the phase over a CHANGED with no kind"
    );
    expect_status(
        &r,
        2,
        "the implementer was engaged over a brief that is not ready",
    );
    must_match("CHANGED", &r.stderr, "the denial does not name the problem");
    must_match("spec-writer", &r.stderr, "the denial does not route it");
}

/// Guard: the backstop still holds when the orchestrator forgets the write.
#[test]
fn arm_gate_still_arms_from_spec_over_a_brief_that_is_ready() {
    let repo = repo_in("spec");
    write_change(
        &repo,
        &UNREADY_BRIEF.replacen("REQ-USER-001 —", "REQ-USER-001 (correction) —", 1),
        false,
        "",
    );
    write(
        repo.join("specflow/my-change/plan.md"),
        "# Plan — my-change\n",
    );
    expect_status(&engage_implementer(&repo), 0, "a ready brief was denied");
    assert_eq!(
        phase_of(&repo),
        "implement",
        "the implementer would run with the gate disarmed"
    );
}

#[test]
fn phase_guard_denies_blocked_from_anything_but_the_gate() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "phase-guard",
            json!({"tool_name": "Write", "tool_input": {"file_path": ".claude/state/phase", "content": "blocked"}}),
            &repo,
        ),
        2,
        "a tool wrote blocked",
    );
}

#[test]
fn phase_guard_ignores_an_unrelated_command() {
    let repo = make_repo(RepoOpts::default());
    write(repo.join("specflow/my-change/.keep"), "");
    expect_status(
        &run_hook("phase-guard", bash("git status"), &repo),
        0,
        "an unrelated command",
    );
}

pub fn lint_marker(repo: &Path) -> Value {
    tool_json(&[&format!("write={}=x", repo.join("LINTER-RAN").display())])
}

#[test]
fn lint_on_write_ignores_an_out_of_scope_file() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "lint-on-write",
            json!({"tool_input": {"file_path": "README.md"}}),
            &repo,
        ),
        0,
        "lint-on-write",
    );
}

#[test]
fn lint_on_write_is_transparent_outside_implement() {
    let repo = repo_in("idle");
    expect_status(
        &run_hook(
            "lint-on-write",
            json!({"tool_input": {"file_path": "example/thing.ts"}}),
            &repo,
        ),
        0,
        "lint-on-write",
    );
}

/// The linter leaves evidence: one that exits 0 silently looks the same as
/// one never run.
#[test]
fn lint_on_write_runs_the_linter_when_the_phase_came_from_a_run() {
    let repo = make_repo(RepoOpts::default());
    let marker = lint_marker(&repo);
    edit_contract(&repo, |c| c["verify"]["lint_no_fix"] = marker);
    write(repo.join("thing.ts"), "export const a = 1;\n");
    expect_status(
        &run_hook(
            "lint-on-write",
            json!({"tool_input": {"file_path": repo.join("thing.ts")}}),
            &repo,
        ),
        0,
        "lint-on-write",
    );
    assert!(
        exists(repo.join("LINTER-RAN")),
        "the linter never ran on an in-scope write mid-implement"
    );
}

/// A linter that ran and failed is said to the agent that wrote the file,
/// with what it said: one that ran in silence looks like one that passed.
#[test]
fn lint_on_write_hands_the_linters_findings_back_when_it_fails_on_the_file() {
    let repo = make_repo(RepoOpts::default());
    edit_contract(&repo, |c| {
        c["verify"]["lint_no_fix"] = tool_json(&["out=thing.ts:1 no-unused-vars", "exit=1"])
    });
    write(repo.join("thing.ts"), "export const a = 1;\n");
    let r = run_hook(
        "lint-on-write",
        json!({"tool_input": {"file_path": repo.join("thing.ts")}}),
        &repo,
    );
    expect_status(&r, 2, "a failing linter was read as a pass");
    must_match(
        "no-unused-vars",
        &r.stderr,
        "the linter's findings were not handed back",
    );
}

/// `scope_globs` are git pathspecs, from the repository root, for the
/// write-time readers as for the gate: the absolute path Claude Code sends is
/// read from there.
fn scoped(globs: &[&str]) -> Dir {
    let repo = make_repo(RepoOpts::default());
    let marker = lint_marker(&repo);
    let globs = json!(globs);
    edit_contract(&repo, |c| {
        c["verify"]["scope_globs"] = globs;
        c["verify"]["lint_no_fix"] = marker;
    });
    write(repo.join("lib/a/b.ts"), "export const a = 1;\n");
    repo
}

fn write_b(repo: &Path) -> Value {
    json!({"tool_name": "Write", "tool_input": {"file_path": repo.join("lib/a/b.ts")}})
}

#[test]
fn scope_globs_are_read_as_the_gate_reads_them() {
    for globs in [&["lib/*.ts"][..], &["lib"], &["*.ts"]] {
        let repo = scoped(globs);
        run_hook("lint-on-write", write_b(&repo), &repo);
        assert!(
            exists(repo.join("LINTER-RAN")),
            "{globs:?} selects lib/a/b.ts for the gate and not for the write-time linter"
        );
        let repo = scoped(globs);
        run_hook("run-trace", write_b(&repo), &repo);
        must_match(
            r"write file=.*lib[\\/]a[\\/]b\.ts",
            &trace_text(&repo),
            &format!("{globs:?}: the write was not traced"),
        );
    }
}

#[test]
fn a_path_outside_the_repository_is_in_no_scope() {
    let repo = scoped(&["*.ts"]);
    let other = temp_dir();
    run_hook(
        "lint-on-write",
        json!({"tool_input": {"file_path": other.join("x.ts")}}),
        &repo,
    );
    assert!(
        !exists(repo.join("LINTER-RAN")),
        "a file outside the repository was linted"
    );
}

// ---- ADR-017: whose state is this? ----------------------------------------

fn committed() -> Dir {
    make_repo(RepoOpts {
        commit_phase: true,
        ..Default::default()
    })
}

#[test]
fn a_committed_phase_does_not_arm_the_whole_repo_deny() {
    let repo = committed();
    expect_status(
        &run_hook("no-gate-cmds", bash("npm run test"), &repo),
        0,
        "a committed phase denied a command",
    );
}

#[test]
fn a_committed_phase_does_not_arm_the_phase_guard() {
    let repo = committed();
    expect_status(
        &run_hook(
            "phase-guard",
            json!({"tool_name": "Write", "tool_input": {"file_path": ".claude/state/phase", "content": "triage"}}),
            &repo,
        ),
        0,
        "a committed phase denied a write",
    );
}

#[test]
fn a_committed_phase_does_not_arm_the_write_time_linter() {
    let repo = committed();
    let marker = lint_marker(&repo);
    edit_contract(&repo, |c| c["verify"]["lint_no_fix"] = marker);
    write(repo.join("thing.ts"), "export const a = 1;\n");
    expect_status(
        &run_hook(
            "lint-on-write",
            json!({"tool_input": {"file_path": repo.join("thing.ts")}}),
            &repo,
        ),
        0,
        "lint-on-write",
    );
    assert!(
        !exists(repo.join("LINTER-RAN")),
        "the repository's own argv ran off a phase git tracks"
    );
}

#[test]
fn a_committed_phase_is_not_flipped_to_implement_by_arm_gate() {
    let repo = make_repo(RepoOpts {
        phase: "plan",
        commit_phase: true,
        ..Default::default()
    });
    expect_status(
        &run_hook(
            "arm-gate",
            json!({"tool_input": {"subagent_type": "implementer"}}),
            &repo,
        ),
        0,
        "arm-gate",
    );
    assert_eq!(phase_of(&repo), "plan", "arm-gate rewrote a tracked file");
}

#[test]
fn a_committed_phase_is_left_alone_by_session_start_rather_than_dirtying_the_repo() {
    let repo = committed();
    age(state_path(&repo, "phase"), Duration::from_secs(8 * 3600));
    expect_status(
        &run_hook("session-start", json!({}), &repo),
        0,
        "session-start",
    );
    assert_eq!(
        phase_of(&repo),
        "implement",
        "session-start wrote over a file git tracks"
    );
    must_not_match(
        r"state[\\/]phase",
        &git(&repo, &["status", "--porcelain"]),
        "the repo is dirty on a tracked file it did not touch",
    );
}

fn opus_spawn(session: Option<&str>) -> Value {
    let mut p = json!({"tool_name": "Task", "tool_input": {"subagent_type": "planner"}});
    if let Some(s) = session {
        p["session_id"] = json!(s);
    }
    p
}

// Only the gate and the budget ask about the seal; the rest fire inside
// subagents too (ADR-017).

#[test]
fn a_phase_sealed_to_another_session_does_not_spend_that_runs_opus_budget() {
    let repo = make_repo(RepoOpts::default());
    write(
        repo.join(".claude/spec-flow.config.json"),
        r#"{"max_opus_calls":2}"#,
    );
    write(state_path(&repo, "opus_calls"), "1");
    write(state_path(&repo, "phase.session"), "session-a");
    expect_status(
        &run_hook("opus-budget", opus_spawn(Some("session-b")), &repo),
        0,
        "session B was denied against session A's budget",
    );
    assert_eq!(
        read(state_path(&repo, "opus_calls")),
        "1",
        "session B charged session A's budget"
    );
}

/// The fail-closed rule: the owner is charged, and so is a payload naming nobody.
#[test]
fn a_phase_sealed_to_this_session_still_charges_it_and_so_does_one_sealed_to_nobody() {
    let repo = make_repo(RepoOpts::default());
    write(
        repo.join(".claude/spec-flow.config.json"),
        r#"{"max_opus_calls":9}"#,
    );
    write(state_path(&repo, "phase.session"), "session-a");
    run_hook("opus-budget", opus_spawn(Some("session-a")), &repo);
    assert_eq!(
        read(state_path(&repo, "opus_calls")),
        "1",
        "the owning session was not charged for its own spawn"
    );
    run_hook("opus-budget", opus_spawn(None), &repo);
    assert_eq!(
        read(state_path(&repo, "opus_calls")),
        "2",
        "a payload with no session_id was not charged — the seal must fail CLOSED"
    );
}

#[test]
fn phase_guard_seals_the_phase_to_the_session_whose_write_it_allowed() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "phase-guard",
            json!({"session_id": "session-a", "tool_name": "Write", "tool_input": {"file_path": ".claude/state/phase", "content": "implement"}}),
            &repo,
        ),
        0,
        "a legitimate phase write was denied",
    );
    assert_eq!(read(state_path(&repo, "phase.session")), "session-a");
}

#[test]
fn phase_guard_seals_nothing_when_it_denied_the_write() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "phase-guard",
            json!({"session_id": "session-a", "tool_name": "Write", "tool_input": {"file_path": ".claude/state/phase", "content": "triage"}}),
            &repo,
        ),
        2,
        "an invented phase was allowed",
    );
    assert!(
        !exists(state_path(&repo, "phase.session")),
        "a denied write claimed the phase"
    );
}

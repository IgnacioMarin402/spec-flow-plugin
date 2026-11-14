//! The step `resume` names, for every state a run can be left in. A wrong
//! verdict is a resumed run that repeats a milestone, skips one, or plans
//! over a spec nobody approved.

use std::path::Path;
use std::time::{Duration, SystemTime};

use regex::Regex;

use crate::harness::*;
use crate::helpers::*;

const RESUME_SPEC: &str = "# Spec — add-cities: cities\n\n## Requirement deltas\n- ADDED   REQ-CITY-001 — a city has a name\n";
const RESUME_FIX: &str = "# Fix — fix-empty-filter: an empty filter\n\n## Case\n1 UNSPECIFIED\n";
const RESUME_PROPOSAL: &str = "# Proposal — add-cities: cities\n\n## Source\nAdd cities.\n";
const RESUME_PLAN: &str = "# Plan — add-cities\n";

/// The stamp a fold or a rejection writes: directly under the heading.
fn stamped(text: &str, status: &str) -> String {
    let (heading, rest) = text.split_once('\n').unwrap_or((text, ""));
    format!("{heading}\n\n**Status:** {status} 2026-09-27\n{rest}")
}

#[derive(Default)]
struct RunState {
    files: Files,
    dirty: Files,
    phase: Option<&'static str>,
    milestone: &'static str,
    verdict: &'static str,
    verdict_age: Option<Duration>,
    started_age: Option<Duration>,
}

const MIN: Duration = Duration::from_secs(60);

/// A repository in one run state: files committed, dirty written after, and
/// a gate verdict stamped on HEAD verdict_age ago.
fn resume_repo(s: RunState) -> Dir {
    let dir = temp_dir();
    git(&dir, &["init", "-q", "."]);
    git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    write(dir.join(".gitignore"), ".claude/state/\n");
    write_files(&dir, &s.files);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "state"]);
    write_files(&dir, &s.dirty);
    std::fs::create_dir_all(dir.join(".claude/state")).unwrap();
    write(state_path(&dir, "phase"), s.phase.unwrap_or("implement"));
    if !s.milestone.is_empty() {
        let at = state_path(&dir, "current-milestone");
        write(&at, &format!("{} abc123def4567890a", s.milestone));
        age(&at, s.started_age.unwrap_or(60 * MIN));
    }
    if !s.verdict.is_empty() {
        let sha = git(&dir, &["rev-parse", "--short", "HEAD"]);
        let at = iso_ms(SystemTime::now() - s.verdict_age.unwrap_or(5 * MIN));
        let at = format!("{}Z", &at[..19]);
        write(
            state_path(&dir, "gate-history.log"),
            &format!(
                "{at} {sha} cc=? engine=fixture phase=implement attempt=0 result={} lint=0 test=0 spec=0 files=1\n",
                s.verdict
            ),
        );
    }
    dir
}

struct Resumed {
    code: i32,
    out: String,
    next: String,
    why: String,
}

fn resume(dir: &Path, args: &[&str]) -> Resumed {
    let mut all = vec!["resume"];
    all.extend(args);
    let r = run(
        &std::env::temp_dir(),
        &[format!("CLAUDE_PROJECT_DIR={}", dir.display())],
        "",
        &cli_argv(engine_dir(), &all),
    );
    let line = |key: &str| {
        Regex::new(&format!("(?m)^{key}: (.+)$"))
            .unwrap()
            .captures(&r.stdout)
            .map(|m| m[1].to_string())
            .unwrap_or_default()
    };
    Resumed {
        code: r.status,
        next: line("NEXT"),
        why: line("WHY"),
        out: r.stdout.clone(),
    }
}

#[track_caller]
fn expect_next(r: &Resumed, next: &str) {
    assert_eq!(r.code, 0, "a report must always exit 0\n{}", r.out);
    assert_eq!(r.next, next, "NEXT\n{}", r.out);
}

fn feature(extra: Files) -> Files {
    let mut f = files! {"specflow/add-cities/spec.md" => RESUME_SPEC, "specflow/add-cities/proposal.md" => RESUME_PROPOSAL};
    f.extend(extra);
    f
}

fn planned(extra: Files) -> Files {
    let mut f = files! {"specflow/add-cities/plan.md" => RESUME_PLAN, "specflow/add-cities/milestones/M1.md" => "# M1\n", "specflow/add-cities/milestones/M2.md" => "# M2\n"};
    f.extend(extra);
    feature(f)
}

fn fix_order() -> Files {
    files! {"specflow/fix-empty-filter/spec.md" => RESUME_FIX, "specflow/fix-empty-filter/plan.md" => RESUME_PLAN, "specflow/fix-empty-filter/milestones/M1.md" => "# M1\n"}
}

/// A plan committed on the base and never run is not a run of a branch off it
/// (ADR-032): offered as one, resume enters a run phase-guard refuses to start.
fn parked_repo(own: Files) -> Dir {
    let dir = resume_repo(RunState {
        files: files! {".spec-flow/config.json" => smoke_contract(None), "specflow/parked/spec.md" => RESUME_SPEC, "specflow/parked/proposal.md" => RESUME_PROPOSAL, "specflow/parked/plan.md" => RESUME_PLAN},
        phase: Some("idle"),
        ..Default::default()
    });
    git(&dir, &["checkout", "-q", "-b", "feature"]);
    write_files(&dir, &own);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "--allow-empty", "-m", "own"]);
    dir
}

// ---- before any code

#[test]
fn no_change_in_flight_none() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                phase: Some("idle"),
                ..Default::default()
            }),
            &[],
        ),
        "NONE",
    );
}

#[test]
fn a_spec_and_its_proposal_with_no_plan_sign_off_the_one_step_no_file_records() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: feature(vec![]),
                phase: Some("idle"),
                ..Default::default()
            }),
            &[],
        ),
        "SIGN-OFF",
    );
}

/// phase-guard refuses to leave `spec` with a spec lacking `## Assumptions`.
#[test]
fn a_sign_off_over_a_spec_phase_guard_would_refuse_says_the_spec_writer_revises_it_first() {
    let r = resume(
        &resume_repo(RunState {
            files: feature(vec![]),
            phase: Some("idle"),
            ..Default::default()
        }),
        &[],
    );
    expect_next(&r, "SIGN-OFF");
    assert!(
        r.why.contains("revises it first") && r.why.contains("## Assumptions"),
        "WHY does not name the problem and the revision: {}",
        r.why
    );
}

#[test]
fn a_sign_off_over_a_ready_spec_asks_for_nothing_else() {
    let r = resume(
        &resume_repo(RunState {
            files: feature(
                files! {"specflow/add-cities/spec.md" => format!("{RESUME_SPEC}\n## Assumptions\n- none\n")},
            ),
            phase: Some("idle"),
            ..Default::default()
        }),
        &[],
    );
    expect_next(&r, "SIGN-OFF");
    must_not_match("revises", &r.why, "a ready spec was sent back");
}

#[test]
fn a_spec_without_its_proposal_spec_the_spec_step_never_finished() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: files! {"specflow/add-cities/spec.md" => RESUME_SPEC},
                phase: Some("spec"),
                ..Default::default()
            }),
            &[],
        ),
        "SPEC",
    );
}

#[test]
fn a_fix_brief_with_no_work_order_work_order_not_a_sign_off() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: files! {"specflow/fix-empty-filter/spec.md" => RESUME_FIX},
                phase: Some("spec"),
                ..Default::default()
            }),
            &[],
        ),
        "WORK-ORDER",
    );
}

#[test]
fn a_plan_with_no_milestone_ever_started_review() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: planned(vec![]),
                phase: Some("review"),
                ..Default::default()
            }),
            &[],
        ),
        "REVIEW",
    );
}

/// The triage writes the work order inside `spec` (ADR-033): until an
/// implementer starts, the fix re-enters at the HITL step.
#[test]
fn a_fix_work_order_with_no_implementer_ever_spawned_work_order_so_a_case_3_is_confirmed_again() {
    let r = resume(
        &resume_repo(RunState {
            files: fix_order(),
            ..Default::default()
        }),
        &[],
    );
    expect_next(&r, "WORK-ORDER");
    must_match(
        "case 3 is confirmed",
        &r.why,
        "WHY does not say the case 3 OK is asked again",
    );
}

#[test]
fn a_fix_work_order_whose_implementer_started_implement_m1() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: fix_order(),
                milestone: "fix-empty-filter M1",
                ..Default::default()
            }),
            &[],
        ),
        "IMPLEMENT M1",
    );
}

// ---- during the milestones

#[test]
fn m1_passed_on_head_after_it_started_implement_m2() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: planned(vec![]),
                milestone: "add-cities M1",
                verdict: "pass",
                ..Default::default()
            }),
            &[],
        ),
        "IMPLEMENT M2",
    );
}

#[test]
fn the_last_milestone_passed_fold() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: planned(vec![]),
                milestone: "add-cities M2",
                verdict: "pass",
                ..Default::default()
            }),
            &[],
        ),
        "FOLD",
    );
}

#[test]
fn a_pass_stamped_before_the_milestone_started_is_the_previous_ones_implement_m2_again() {
    let s = RunState {
        files: planned(vec![]),
        milestone: "add-cities M2",
        verdict: "pass",
        verdict_age: Some(90 * MIN),
        started_age: Some(30 * MIN),
        ..Default::default()
    };
    expect_next(&resume(&resume_repo(s), &[]), "IMPLEMENT M2");
}

#[test]
fn a_milestone_in_flight_on_a_dirty_tree_implement_it_and_say_the_tree_holds_the_dead_sessions_work()
 {
    let r = resume(
        &resume_repo(RunState {
            files: planned(vec![]),
            milestone: "add-cities M1",
            dirty: files! {"wip/half-written.txt" => "half\n"},
            ..Default::default()
        }),
        &[],
    );
    expect_next(&r, "IMPLEMENT M1");
    must_match(
        "uncommitted",
        &r.why,
        "WHY does not mention the uncommitted work",
    );
}

#[test]
fn a_gate_failure_on_head_implement_that_milestone_pointing_at_the_failure_log() {
    let r = resume(
        &resume_repo(RunState {
            files: planned(vec![]),
            milestone: "add-cities M1",
            verdict: "fail",
            ..Default::default()
        }),
        &[],
    );
    expect_next(&r, "IMPLEMENT M1");
    must_match(
        r"gate-failure\.log",
        &r.why,
        "WHY does not say where the failure is",
    );
}

#[test]
fn a_milestone_of_another_change_in_the_position_file_is_not_this_changes() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: planned(vec![]),
                milestone: "other-change M1",
                verdict: "pass",
                ..Default::default()
            }),
            &[],
        ),
        "REVIEW",
    );
}

// ---- closing

#[test]
fn a_shipped_stamp_on_a_live_folder_fold_the_archive_never_happened() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: planned(
                    files! {"specflow/add-cities/spec.md" => stamped(RESUME_SPEC, "SHIPPED")},
                ),
                ..Default::default()
            }),
            &[],
        ),
        "FOLD",
    );
}

#[test]
fn a_rejected_stamp_on_a_live_folder_archive_rejected() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: feature(
                    files! {"specflow/add-cities/spec.md" => stamped(RESUME_SPEC, "REJECTED")},
                ),
                phase: Some("spec"),
                ..Default::default()
            }),
            &[],
        ),
        "ARCHIVE-REJECTED",
    );
}

#[test]
fn an_archived_change_whose_run_never_wrote_done_done() {
    let s = RunState {
        files: files! {"specflow/archive/add-cities/spec.md" => stamped(RESUME_SPEC, "SHIPPED"), "specflow/archive/add-cities/proposal.md" => RESUME_PROPOSAL},
        milestone: "add-cities M2",
        ..Default::default()
    };
    expect_next(&resume(&resume_repo(s), &[]), "DONE");
}

#[test]
fn an_archived_change_the_run_did_close_is_not_resumed() {
    let s = RunState {
        files: files! {"specflow/archive/add-cities/spec.md" => stamped(RESUME_SPEC, "SHIPPED")},
        milestone: "add-cities M2",
        phase: Some("done"),
        ..Default::default()
    };
    expect_next(&resume(&resume_repo(s), &[]), "NONE");
}

// ---- which change, and what it may not do

#[test]
fn two_live_changes_choose_and_naming_one_resumes_it() {
    let dir = resume_repo(RunState {
        files: feature(
            files! {"specflow/other/spec.md" => RESUME_SPEC, "specflow/other/proposal.md" => RESUME_PROPOSAL, "specflow/other/plan.md" => RESUME_PLAN},
        ),
        phase: Some("idle"),
        ..Default::default()
    });
    expect_next(&resume(&dir, &[]), "CHOOSE");
    expect_next(&resume(&dir, &["other"]), "REVIEW");
}

#[test]
fn a_plan_the_base_branch_already_has_is_not_offered_as_the_run_to_resume() {
    let r = resume(&parked_repo(vec![]), &[]);
    expect_next(&r, "NONE");
    assert!(
        r.out.contains("the base branch has them: parked"),
        "the parked plan is not named:\n{}",
        r.out
    );
}

#[test]
fn a_plan_the_base_branch_has_does_not_stand_beside_this_branchs_own_change() {
    expect_next(&resume(&parked_repo(feature(vec![])), &[]), "SIGN-OFF");
}

#[test]
fn a_blocked_run_blocked_a_human_decides_not_a_resume() {
    expect_next(
        &resume(
            &resume_repo(RunState {
                files: planned(vec![]),
                milestone: "add-cities M1",
                phase: Some("blocked"),
                ..Default::default()
            }),
            &[],
        ),
        "BLOCKED",
    );
}

#[test]
fn state_it_cannot_read_still_ends_on_a_next_line_with_exit_0() {
    let dir = resume_repo(RunState {
        phase: Some("idle"),
        ..Default::default()
    });
    write(dir.join("specflow"), "a file where a directory belongs\n");
    expect_next(&resume(&dir, &[]), "UNKNOWN");
}

#[test]
fn it_creates_nothing_in_a_repository_that_never_ran_the_flow() {
    let dir = temp_dir();
    let r = resume(&dir, &[]);
    assert_eq!(r.code, 0);
    assert!(
        !exists(dir.join(".claude")),
        "created .claude/ in a repository with no run"
    );
}

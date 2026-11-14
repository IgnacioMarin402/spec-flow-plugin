//! spec-trace: proof comes from what the runner REPORTED as executed
//! (ADR-001), opting out honestly, and a SHIPPED change's deltas landing in
//! specs/ (ADR-048).

use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;

fn junit_report() -> Option<Value> {
    Some(json!({"format": "junit", "path": "reports/junit.xml"}))
}

// ==== proof comes from what the runner REPORTED as executed (ADR-001) ======

trace_case!(
    a_vendored_dependency_tree_does_not_register_as_this_repos_proof,
    files! {"specs/user.md" => user_spec(), "tests/user.test.ts" => "it('REQ-USER-001 x', () => {});\n", "venv/lib/site-packages/pkg/tests/vendored.test.ts" => "it('REQ-USER-999 a third party proves its own thing', () => {});\n"},
    |r| {
        must_not_match(
            "REQ-USER-999",
            &r.out(),
            "a vendored test became this repo's problem",
        );
        passes(r, "a repo whose own specs and tests agree was blocked");
    }
);

trace_case!(
    /// The shape observed from a real reporter that concatenates suite titles.
    a_name_built_from_a_suite_path_proves_a_requirement,
    files! {".spec-flow/config.json" => trace_contract(&["auth > rejects > REQ-USER-001 the user can do the thing"]), "specs/user.md" => user_spec()},
    |r| {
        passes(r, "an executed test whose reported name nests the id was read as absent");
    }
);

trace_case!(
    /// `_` read as `-`: a title written the way identifiers are still binds.
    an_id_written_with_underscores_still_binds,
    files! {
        ".spec-flow/config.json" => report_contract(junit_report()),
        "specs/user.md" => user_spec(),
        "reports/junit.xml" => "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<testsuites><testsuite name=\"suite\" tests=\"1\" failures=\"0\"><testcase classname=\"test/user.test.ts\" name=\"test_REQ_USER_001_the_user_can_do_the_thing\" time=\"0.001\"/></testsuite></testsuites>\n",
    },
    |r| {
        passes(r, "a test that ran and passed was reported as absent over its spelling");
    }
);

trace_case!(
    a_junit_report_proves_a_requirement,
    files! {".spec-flow/config.json" => report_contract(junit_report()), "reports/junit.xml" => JUNIT_RAN, "specs/user.md" => user_spec()},
    |r| {
        passes(
            r,
            "an executed test named in a junit report was reported as absent",
        );
    }
);

trace_case!(
    /// `<skipped/>` is in the JUnit schema: "did it run" is answered without
    /// the runner.
    a_test_that_is_skipped_in_the_report_does_not_prove_its_requirement,
    files! {".spec-flow/config.json" => report_contract(junit_report()), "reports/junit.xml" => JUNIT_SKIPPED, "specs/user.md" => user_spec()},
    |r| {
        fails_with(r, "has no test", "a skipped test proved a requirement");
        must_not_match("reported no tests at all", &r.out(), "a report with one skipped case read as saying nothing at all");
    }
);

trace_case!(
    a_report_file_that_was_never_written_is_a_refusal_not_has_no_test,
    files! {".spec-flow/config.json" => report_contract(junit_report()), "specs/user.md" => user_spec()},
    |r| {
        fails_with(
            r,
            "reporter flag|does not exist",
            "the refusal did not name the likely cause",
        );
        must_not_match(
            "has no test",
            &r.out(),
            "a missing report read as an unproven requirement",
        );
    }
);

// ---- opting out, and the one thing that makes it honest ------------------

fn failing_source() -> String {
    trace_config(Some(&|tr: &mut Value| {
        tr["executed_tests"] = tool_json(&["exit=3"])
    }))
}

trace_case!(
    no_source_and_no_requirements_is_a_pass_that_says_why_it_passed,
    files! {".spec-flow/config.json" => report_contract(None)},
    |r| {
        passes(r, "a repo with nothing to prove was blocked");
        must_match(
            "(?i)not configured",
            &r.out(),
            "it passed without saying it was unarmed",
        );
    }
);

trace_case!(
    no_source_with_requirements_is_refused,
    files! {".spec-flow/config.json" => report_contract(None), "specs/user.md" => user_spec()},
    |r| {
        fails_with(
            r,
            r"opt-in|opted out|trace\.report",
            "an opt-out that survives its own precondition is a disarmed gate",
        );
    }
);

trace_case!(
    /// Every adopter's first run: init writes trace.report before the flag lands.
    a_declared_report_that_has_not_landed_yet_with_nothing_to_prove_is_not_a_refusal,
    files! {".spec-flow/config.json" => report_contract(junit_report())},
    |r| {
        passes(r, "the contract init writes failed on a repo with no requirements");
        must_match("(?i)nothing to bind|no requirement", &r.out(), "it passed without saying it was unarmed");
    }
);

trace_case!(
    an_unarmed_source_never_reports_requirements_as_proven,
    files! {".spec-flow/config.json" => report_contract(junit_report()), "specs/user.md" => "<!-- spec-scope: modules/user -->\n\n# User\n\nNo requirement declared yet.\n"},
    |r| {
        passes(r, "a spec file with no requirement blocked the check");
        must_not_match(
            "every one proven by a test",
            &r.out(),
            "it claimed proof while nothing was read",
        );
    }
);

trace_case!(
    the_same_grace_covers_the_other_proof_source,
    files! {".spec-flow/config.json" => failing_source()},
    |r| {
        passes(
            r,
            "a report source producing nothing blocked a repo with no requirements",
        );
    }
);

trace_case!(
    the_unarmed_grace_does_not_swallow_the_other_checks,
    files! {".spec-flow/config.json" => report_contract(junit_report()), "specflow/archive/old-change/spec.md" => "# Old change\n\nNo status line anywhere.\n"},
    |r| {
        fails_with(
            r,
            "(?i)no status",
            "an archived change with no status passed under the grace",
        );
    }
);

trace_case!(
    declaring_both_sources_is_refused_by_the_contract_not_resolved_silently,
    files! {".spec-flow/config.json" => trace_config(Some(&|tr: &mut Value| tr["report"] = json!({"format": "junit", "path": "reports/junit.xml"}))), "specs/user.md" => user_spec()},
    |r| {
        fails_with(
            r,
            "(?i)both",
            "two answers to \"which tests ran\" were accepted",
        );
    }
);

trace_case!(
    /// "Nothing was proven" and "I could not tell" both exit 1: the message
    /// tells them apart.
    an_empty_report_with_requirements_is_a_named_refusal_not_has_no_test,
    files! {".spec-flow/config.json" => trace_contract(&[]), "specs/user.md" => user_spec()},
    |r| {
        fails_with(r, "(?i)report|executed_tests|no tests", "the refusal did not name the report");
        must_not_match("has no test", &r.out(), "an empty report read as an unproven requirement");
    }
);

trace_case!(
    a_report_command_that_fails_is_a_refusal_not_an_absence_of_proof,
    files! {".spec-flow/config.json" => failing_source(), "specs/user.md" => user_spec()},
    |r| {
        assert_ne!(r.status, 0, "a broken report command passed: {}", r.out());
        must_not_match(
            "has no test",
            &r.out(),
            "a broken report command read as an unproven requirement",
        );
    }
);

// ---- a SHIPPED change's deltas landed in specs/ (ADR-048) --------------------

fn in_run() -> BranchOpts<'static> {
    BranchOpts {
        state: files! {"phase" => "implement"},
        ..Default::default()
    }
}

fn none() -> BranchOpts<'static> {
    BranchOpts::default()
}

fn user() -> Files {
    files! {"specs/user.md" => user_spec()}
}

fn with_user(extra: Files) -> Files {
    let mut f = user();
    f.extend(extra);
    f
}

branch_case!(
    an_added_id_a_shipped_change_of_this_branch_never_wrote_into_specs_is_reported,
    user(),
    [
        files! {"specflow/archive/add-export/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"])}
    ],
    none(),
    |r| {
        fails_with(
            r,
            r"REQ-USER-002 is ADDED by specflow/archive/add-export/spec\.md",
            "a shipped requirement nothing proves passed",
        );
    }
);

branch_case!(
    a_removed_id_a_shipped_change_of_this_branch_left_in_specs_is_reported,
    files! {"specs/user.md" => two_reqs(), ".spec-flow/config.json" => trace_contract(&["tests/user.test.ts::REQ-USER-001 a", "tests/user.test.ts::REQ-USER-002 b"])},
    [
        files! {"specflow/archive/drop-export/spec.md" => shipped_spec(&["REMOVED REQ-USER-002 — export is gone"])}
    ],
    none(),
    |r| {
        fails_with(
            r,
            r"REQ-USER-002 is REMOVED by specflow/archive/drop-export/spec\.md",
            "a removal that never reached specs/ passed",
        );
    }
);

branch_case!(
    /// ADR-032: judged on its own branch; a run here does not answer for it.
    a_shipped_change_the_base_branch_already_has_is_not_held_here,
    with_user(files! {"specflow/archive/old/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — from before"])}),
    [files! {"README.md" => "unrelated\n"}],
    none(),
    |r| {
        passes(r, "this branch was blocked over a change it inherited");
    }
);

branch_case!(
    /// Ids are permanent, so one a later change REMOVED is retired.
    an_added_id_another_change_of_this_branch_removed_is_retired_not_missing,
    user(),
    [files! {"specflow/archive/add-export/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"]), "specflow/archive/drop-export/spec.md" => shipped_spec(&["REMOVED REQ-USER-002 — export is gone"])}],
    none(),
    |r| {
        passes(r, "a requirement added and then retired was reported missing");
    }
);

branch_case!(
    /// Until the fold its own change is live: an earlier run's is said, not failed.
    before_the_fold_a_change_the_branch_shipped_earlier_is_said_not_failed,
    user(),
    two_runs(),
    in_run(),
    |r| {
        passes(r, "run two's milestone gate failed over run one's change");
        must_match("(?s)held from the fold's gate on.*REQ-USER-002", &r.out(), "run one's drift went unsaid");
        must_not_match("every one proven", &r.out(), "it still says every requirement is proven");
    }
);

branch_case!(
    from_the_fold_on_an_earlier_runs_change_is_held,
    user(),
    [
        files! {"specflow/archive/run-one/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"]), "specflow/archive/run-two/spec.md" => shipped_spec(&["CHANGED REQ-USER-001 (wording) — clearer"])}
    ],
    BranchOpts {
        state: files! {"phase" => "implement", "current-milestone" => "run-two M1 a-implementer"},
        ..Default::default()
    },
    |r| {
        fails_with(
            r,
            "REQ-USER-002 is ADDED by specflow/archive/run-one",
            "the fold passed over run one's drift",
        );
    }
);

branch_case!(
    /// current-milestone is written best-effort and cleared by nothing.
    a_stale_current_milestone_does_not_exempt_the_runs_own_change,
    user(),
    [files! {"specflow/archive/run-one/spec.md" => shipped_spec(&["CHANGED REQ-USER-001 (wording) — clearer"]), "specflow/archive/run-two/spec.md" => shipped_spec(&["ADDED REQ-USER-003 — the user can import data"])}],
    BranchOpts { state: files! {"phase" => "implement", "current-milestone" => "run-one M2 a-implementer"}, ..Default::default() },
    |r| {
        fails_with(r, "REQ-USER-003 is ADDED by specflow/archive/run-two", "the run's own change escaped under a stale milestone");
    }
);

branch_case!(
    /// A folder is live with a spec in it, and only one the base lacks.
    an_empty_folder_its_fold_left_does_not_make_the_runs_own_change_an_earlier_runs,
    user(),
    own_fold(),
    BranchOpts { state: files! {"phase" => "implement"}, dirs: vec!["specflow/run-one"], ..Default::default() },
    |r| {
        holds_own_fold(r);
    }
);

branch_case!(
    a_plan_parked_on_the_base_does_not_make_the_runs_own_change_an_earlier_runs,
    with_user(
        files! {"specflow/parked/spec.md" => "# Spec — parked\n\n## Requirement deltas\n- none\n", "specflow/parked/proposal.md" => "# Proposal\n\nWhy.\n"}
    ),
    own_fold(),
    in_run(),
    |r| {
        holds_own_fold(r);
    }
);

fn other_change() -> Files {
    files! {"specflow/other/spec.md" => "# Spec — other\n\n## Requirement deltas\n- none\n", "specflow/other/proposal.md" => "# Proposal\n\nWhy.\n"}
}

branch_case!(
    a_live_change_created_before_the_fold_does_not_make_the_runs_own_change_an_earlier_runs,
    user(),
    [vec![other_change()], own_fold()].concat(),
    in_run(),
    |r| {
        holds_own_fold(r);
    }
);

branch_case!(
    /// A live change is as old as its first write.
    a_live_change_edited_after_the_fold_is_as_old_as_its_first_write,
    user(),
    [vec![other_change()], own_fold(), vec![files! {"specflow/other/spec.md" => "# Spec — other\n\n## Requirement deltas\n- none — edited after the fold\n"}]].concat(),
    in_run(),
    |r| {
        holds_own_fold(r);
    }
);

branch_case!(
    /// A fold and the next run's spec in one commit have no order: held as
    /// this run's.
    a_fold_committed_with_the_next_run_is_held_as_that_runs,
    user(),
    [two_runs().concat()],
    in_run(),
    |r| {
        fails_with(r, "(?m)^ {2}- REQ-USER-002 is ADDED by specflow/archive/run-one", "a fold committed with the next run passed as an earlier run's");
    }
);

branch_case!(
    /// Outside a run — CI, `check` — no change is an earlier run's.
    outside_a_run_a_change_the_branch_shipped_earlier_is_held,
    user(),
    two_runs(),
    none(),
    |r| {
        fails_with(r, "(?m)^ {2}- REQ-USER-002 is ADDED by specflow/archive/run-one", "outside a run, run one's drift was not held");
        must_not_match("held from the fold's gate on", &r.out(), "it was said as an earlier run's");
    }
);

branch_case!(
    an_inherited_change_edited_and_not_yet_committed_is_this_branchs,
    with_user(
        files! {"specflow/archive/old/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — from before"])}
    ),
    [files! {"README.md" => "unrelated\n"}],
    BranchOpts {
        uncommitted: files! {"specflow/archive/old/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — from before, typo fixed"])},
        ..Default::default()
    },
    |r| {
        fails_with(
            r,
            "REQ-USER-002 is ADDED by specflow/archive/old",
            "an edit not yet committed left the change inherited",
        );
    }
);

branch_case!(
    /// Mid-run a milestone writes its delta when it delivers it; only the
    /// stamp claims all landed.
    a_live_change_is_not_held_to_its_added_ids_before_it_is_shipped,
    user(),
    [files! {"specflow/add-export/spec.md" => "# Spec — add export\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the user can export their data\n", "specflow/add-export/proposal.md" => "# Proposal\n\nWhy.\n"}],
    none(),
    |r| {
        passes(r, "a milestone not yet delivered was blocked");
    }
);

branch_case!(
    a_rejected_or_superseded_change_of_this_branch_is_not_held_to_its_deltas,
    user(),
    [files! {
        "specflow/archive/turned-down/spec.md" => "# Spec — x\n\n**Status:** REJECTED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-002 — export\n",
        "specflow/archive/replaced/spec.md" => "# Spec — y\n\n**Status:** SUPERSEDED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-003 — import\n",
    }],
    none(),
    |r| {
        passes(
            r,
            "a change that asserts nothing landed was held to its deltas",
        );
    }
);

branch_case!(
    an_added_id_a_live_change_of_this_branch_removes_is_retired_not_missing,
    user(),
    [files! {
        "specflow/archive/add-export/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"]),
        "specflow/drop-export/spec.md" => "# Spec — drop export\n\n## Requirement deltas\n- REMOVED REQ-USER-002 — export is gone\n",
        "specflow/drop-export/proposal.md" => "# Proposal\n\nWhy.\n",
    }],
    none(),
    |r| {
        passes(
            r,
            "a requirement this branch is removing was reported missing",
        );
    }
);

branch_case!(
    /// git quotes a non-ASCII name; read quoted, it matches no folder.
    a_shipped_change_the_base_holds_under_a_non_ascii_name_is_not_held_here,
    with_user(files! {"specflow/archive/añadir-exportación/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — from before"])}),
    [files! {"README.md" => "unrelated\n"}],
    none(),
    |r| {
        passes(r, "this branch was blocked over a change it inherited");
    }
);

branch_case!(
    /// The folder name is the base's; the change in it is this branch's.
    a_shipped_change_written_over_a_folder_the_base_archived_is_held_here,
    with_user(files! {"specflow/archive/fix-login/spec.md" => shipped_spec(&["CHANGED REQ-USER-001 (wording) — clearer"])}),
    [files! {"specflow/archive/fix-login/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can log in again"])}],
    none(),
    |r| {
        fails_with(r, r"REQ-USER-002 is ADDED by specflow/archive/fix-login/spec\.md", "a change this branch shipped escaped under a reused name");
    }
);

branch_case!(
    a_project_below_the_repository_top_tells_inherited_changes_from_its_own,
    with_user(
        files! {"specflow/archive/old/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — from before"])}
    ),
    [
        files! {"specflow/archive/add-import/spec.md" => shipped_spec(&["ADDED REQ-USER-003 — the user can import data"])}
    ],
    BranchOpts {
        under: "pkg",
        ..Default::default()
    },
    |r| {
        must_not_match("REQ-USER-002", &r.out(), "an inherited change was held");
        must_match(
            "REQ-USER-003 is ADDED",
            &r.out(),
            "this branch's change was not held",
        );
    }
);

/// `check` and the gate fail with no base; the checks that need one fail with
/// them.
#[test]
fn with_no_base_to_resolve_a_shipped_change_and_a_nested_spec_fail_alike_with_the_reason() {
    let (r, _dir) = trace_repo(
        files! {
            "specs/user.md" => user_spec(),
            "specflow/archive/add-export/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"]),
            "specflow/archive/old/spec.md" => shipped_spec(&["CHANGED REQ-USER-001 (wording) — clearer"]),
            "specflow/archive/old/old/spec.md" => shipped_spec(&["CHANGED REQ-USER-001 (wording) — clearer still"]),
        },
        &[],
    );
    assert_ne!(r.status, 0, "a repo with no base passed: {}", r.out());
    let named = regex::Regex::new(r"- (.*): whether these are this branch's or inherited needs the base, and no base branch could be resolved").unwrap().captures(&r.out()).map(|m| m[1].to_string()).unwrap_or_default();
    assert!(
        named.contains("archive/add-export/spec.md") && named.contains("archive/old/old/spec.md"),
        "not both named, or not the reason: {}",
        r.out()
    );
    must_match(
        "fetch-depth: 0",
        &r.out(),
        "the failure does not say how to fetch the base",
    );
    must_match(
        r"refs/heads/\*:refs/remotes/origin/\*",
        &r.out(),
        "the failure does not say how to fetch the base",
    );
    must_not_match(
        "every one proven",
        &r.out(),
        "it still says every requirement is proven",
    );
}

//! spec-trace: binding requirements to the tests that ran, both directions,
//! the archive's shape, and headings on a branch.

use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;

const USER_TEST: &str = "it('REQ-USER-001 x', () => {});\n";

fn with_user(extra: Files) -> Files {
    let mut f = files! {"specs/user.md" => user_spec()};
    f.extend(extra);
    f
}

fn skills_milestone(fields: &str, contract: String) -> Files {
    files! {
        "specflow/add-users/spec.md" => "# Spec — add users\n\nDeltas.\n",
        "specflow/add-users/proposal.md" => "# Proposal\n\nWhy.\n",
        "specflow/add-users/milestones/M1.md" => format!("# M1 — first\n\n{fields}"),
        ".spec-flow/config.json" => contract,
    }
}

trace_case!(
    /// Where a test lives is no evidence; location is not consulted at all.
    a_reported_test_proves_its_requirement_wherever_it_lives,
    with_user(files! {".spec-flow/config.json" => trace_contract(&["somewhere/nobody/would/guess::REQ-USER-001 the user can do the thing"])}),
    |r| {
        passes(r, "a test the runner reported was rejected for where it lives");
    }
);

trace_case!(
    /// Where a test goes is the anatomy statement's to say (ADR-026).
    an_unproven_requirement_is_sent_to_the_proof_surface_not_to_a_path_composed_from_the_scope,
    with_user(files! {".spec-flow/config.json" => trace_contract(&["tests/other.test.ts::an unrelated test that did run"])}),
    |r| {
        fails_with(r, r"\btests\b", "the remedy does not name the proof surface");
        must_match(r"\.test\.ts", &r.out(), "the remedy does not name the proof surface");
        must_not_match("modules/user/tests", &r.out(), "the remedy composed a directory nothing declared");
    }
);

trace_case!(
    a_rejected_change_keeps_the_grace_it_asserts_nothing_landed,
    files! {
        "specflow/archive/turned-down/spec.md" => "# Spec — turned down\n\n**Status:** REJECTED 2026-07-30\n\nDeltas.\n",
        "specflow/archive/turned-down/proposal.md" => "# Proposal\n\nWhy not.\n",
        ".spec-flow/config.json" => trace_contract(&["an unrelated test that proves no requirement"]),
    },
    |r| {
        passes(
            r,
            "a rejected change blocked a repo that has shipped nothing",
        );
    }
);

trace_case!(
    /// The adoption grace covers the binding and nothing else.
    the_empty_specs_grace_does_not_swallow_the_other_checks,
    files! {"specflow/mine/spec.md" => "# Spec — mine\n\n## Decision\nThis belongs in proposal.md.\n", "tests/placeholder.test.ts" => "it(\"unrelated\", () => {});\n"},
    |r| {
        fails_with(r, r"proposal\.md", "a leaked ## Decision and no proposal.md passed");
    }
);

// ---- the Skills field, when the contract asks for it: `none` is an answer;
// absent or empty cannot be told from a planner that never looked.

trace_case!(
    a_live_milestone_with_no_skills_field_fails,
    skills_milestone(
        "- Objective: do the thing\n- Files to add/change: lib/a.ts\n",
        skills_required()
    ),
    |r| {
        fails_with(r, "Skills", "a milestone said nothing about skills");
    }
);

trace_case!(
    skills_none_is_a_legitimate_answer_and_passes,
    skills_milestone(
        "- Objective: do the thing\n- Skills: none\n",
        skills_required()
    ),
    |r| {
        passes(r, r#""none" was rejected"#);
    }
);

trace_case!(
    a_skills_field_with_nothing_after_the_colon_fails_like_the_absent_one_it_is,
    skills_milestone(
        "- Objective: do the thing\n- Skills:\n- Files to add/change: lib/a.ts\n",
        skills_required()
    ),
    |r| {
        fails_with(r, "Skills", "an empty Skills field passed");
    }
);

trace_case!(
    a_skills_field_holding_only_whitespace_fails_too,
    skills_milestone(
        "- Objective: do the thing\n- **Skills**:   \n",
        skills_required()
    ),
    |r| {
        assert_ne!(
            r.status,
            0,
            r#""Skills:" plus spaces passed as an answer: {}"#,
            r.out()
        );
    }
);

trace_case!(
    /// Skills reach a session from places this engine cannot read, so the
    /// default asks nothing.
    a_milestone_with_no_skills_field_passes_when_the_contract_never_asked_for_one,
    skills_milestone("- Objective: do the thing\n- Files to add/change: lib/a.ts\n", trace_contract(&[])),
    |r| {
        passes(r, "a project was failed for a field it never asked for");
    }
);

trace_case!(
    /// The flag decides whether a gate can fail: a value to interpret is refused.
    a_non_boolean_require_skills_field_is_refused_not_coerced,
    with_user(files! {"tests/user.test.ts" => USER_TEST, ".spec-flow/config.json" => trace_config(Some(&|tr: &mut Value| tr["require_skills_field"] = json!("false")))}),
    |r| {
        fails_with(r, "require_skills_field", r#"a quoted "false" was accepted"#);
    }
);

// ---- the happy path, and the separators a requirement heading may use

trace_case!(
    a_requirement_proven_by_a_test_title_passes_in_both_directions,
    with_user(
        files! {"tests/user.test.ts" => "it('REQ-USER-001 lets the user do the thing', () => {});\n"}
    ),
    |r| {
        passes(r, "a fully proven spec was reported as drift");
        must_match(
            "1 requirement",
            &r.out(),
            "did not report the requirement it checked",
        );
    }
);

trace_case!(
    a_heading_shaped_like_a_requirement_and_not_read_as_one_is_reported,
    files! {"specs/user.md" => user_spec() + "\n### REQ-USER-10 — export to CSV\n\nThe system exports.\n\n#### REQ-USER-011 — import\n\nThe system imports.\n"},
    |r| {
        for h in [
            "### REQ-USER-10 — export to CSV",
            "#### REQ-USER-011 — import",
        ] {
            assert!(
                r.status != 0
                    && r.out()
                        .contains(&format!("\"{h}\" is no requirement the engine reads")),
                "not reported: {h}. {}",
                r.out()
            );
        }
    }
);

trace_case!(
    a_sub_heading_naming_a_declared_id_a_word_like_req_and_a_fenced_example_are_not_reported,
    files! {"specs/user.md" => user_spec() + "\n#### REQ-USER-001 — examples\n\nGiven a user.\n\n## Req-to-Pay\n\nThe flow.\n\n```\n### REQ-USER-10 — not like this\n```\n"},
    |r| {
        passes(r, "a correct capability spec was refused");
    }
);

trace_case!(
    a_requirement_heading_parses_with_an_em_dash_a_hyphen_or_a_colon,
    files! {"specs/user.md" => "<!-- spec-scope: modules/user -->\n\n### REQ-USER-001 — em dash\n\n### REQ-USER-002 - hyphen\n\n### REQ-USER-003: colon\n", ".spec-flow/config.json" => trace_contract(&["REQ-USER-001 a", "REQ-USER-002 b", "REQ-USER-003 c"])},
    |r| {
        passes(r, "one of the three separators failed to parse");
        must_match(
            "3 requirement",
            &r.out(),
            "expected all 3 headings to parse",
        );
    }
);

// ---- both directions

trace_case!(
    a_requirement_with_no_test_is_reported,
    with_user(files! {".spec-flow/config.json" => trace_contract(&["an unrelated test"])}),
    |r| {
        fails_with(r, "REQ-USER-001", "an unproven requirement passed");
    }
);

trace_case!(
    a_test_tag_with_no_requirement_behind_it_is_reported,
    with_user(
        files! {".spec-flow/config.json" => trace_contract(&["REQ-USER-001 ok", "REQ-USER-999 orphan"])}
    ),
    |r| {
        fails_with(r, "REQ-USER-999", "an orphan test tag passed");
    }
);

trace_case!(
    /// A table-driven test reports one line per case, already expanded.
    a_parameterised_test_proves_through_its_expanded_names,
    with_user(files! {".spec-flow/config.json" => trace_contract(&["REQ-USER-001 handles 1", "REQ-USER-001 handles 2"])}),
    |r| {
        passes(r, "a table-driven test did not register as proof");
    }
);

trace_case!(
    /// No source file is read at all, so an id anywhere in one proves nothing.
    an_id_present_in_source_but_absent_from_the_report_is_not_proof,
    with_user(files! {
        ".spec-flow/config.json" => trace_contract(&["tests/user.test.ts::something else entirely"]),
        "tests/user.test.ts" => "// REQ-USER-001 is mentioned here\nconst describeThing = (a) => (b) => a + b;\ndescribeThing('x')('REQ-USER-001 this is not a test');\nit('REQ-USER-001 a real declaration that the runner did not report', () => {});\n",
    }),
    |r| {
        fails_with(r, "REQ-USER-001", "an id no reported test carried registered as proof");
    }
);

trace_case!(
    /// Whatever a language calls skipping, a skipped test is absent from the report.
    a_test_that_exists_in_every_skipped_form_is_not_proof,
    with_user(files! {
        ".spec-flow/config.json" => trace_contract(&["tests/other.test.ts::an unrelated test that did run"]),
        "tests/user.test.ts" => "it.skip('REQ-USER-001 skipped', () => {});\n",
        "tests/todo.test.ts" => "test.todo('REQ-USER-001 not written yet');\n",
        "tests/suite.test.ts" => "describe.skip('REQ-USER-001', () => { it('x', () => {}); });\n",
        "tests/runtime.test.ts" => "it('REQ-USER-001', (t) => { t.skip('not today'); });\n",
    }),
    |r| {
        fails_with(r, "REQ-USER-001", "a skipped test registered as proof");
    }
);

trace_case!(
    tests_the_runner_reports_as_executed_count_as_proof,
    files! {"specs/user.md" => "<!-- spec-scope: modules/user -->\n\n### REQ-USER-001 — a\n\n### REQ-USER-002 — b\n", ".spec-flow/config.json" => trace_contract(&["REQ-USER-001 runs", "REQ-USER-002 runs"])},
    |r| {
        passes(r, "a running test was rejected as proof");
    }
);

trace_case!(
    a_requirement_id_that_does_not_match_its_spec_filename_is_reported,
    files! {"specs/user.md" => cap_spec("REQ-BILLING-001", "", ""), "tests/user.test.ts" => "it('REQ-BILLING-001 x', () => {});\n"},
    |r| {
        fails_with(
            r,
            "REQ-USER-",
            "an id that drifted from its filename passed",
        );
    }
);

trace_case!(
    a_spec_with_no_scope_marker_is_reported,
    files! {"specs/user.md" => "# User\n\n### REQ-USER-001 — no marker\n", "tests/user.test.ts" => USER_TEST},
    |r| {
        fails_with(r, "scope marker", "a spec with no scope marker passed");
    }
);

trace_case!(
    a_repo_with_no_specs_and_nothing_archived_says_what_it_is_not_checking,
    files! {".spec-flow/config.json" => trace_contract(&[])},
    |r| {
        passes(r, "an unconfigured repo failed");
        must_match(
            "no requirements to bind",
            &r.out(),
            r#"silence here reads as "all proven""#,
        );
        must_match(
            "still checked",
            &r.out(),
            "it did not say the grace covers only the binding",
        );
    }
);

trace_case!(
    /// No tree is read, so a dependency's tests cannot be this repo's whatever
    /// its directory.
    a_dependencys_own_tests_are_never_judged_as_this_repos,
    with_user(files! {"tests/user.test.ts" => USER_TEST, "node_modules/pkg/tests/dep.test.ts" => "it('REQ-USER-404 from a dependency', () => {});\n"}),
    |r| {
        passes(r, "a dependency's own test files were judged");
    }
);

// ---- the archive

fn proven(extra: Files) -> Files {
    let mut f = files! {"specs/user.md" => user_spec(), "tests/user.test.ts" => USER_TEST};
    f.extend(extra);
    f
}

fn live(slug: &str, spec: &str) -> Files {
    files! {"specs/user.md" => user_spec(), format!("specflow/{slug}/spec.md") => spec, format!("specflow/{slug}/proposal.md") => "# Proposal\n\nWhy.\n"}
}

fn plus(mut a: Files, b: Files) -> Files {
    a.extend(b);
    a
}

trace_case!(
    an_archived_change_with_a_status_passes,
    proven(
        files! {"specflow/archive/add-user/spec.md" => "# Add user\n\n**Status:** SHIPPED 2026-07-30\n"}
    ),
    |r| {
        passes(r, "a stamped archive entry was reported");
        must_match(
            "1 archived change",
            &r.out(),
            "the archive entry was not counted",
        );
    }
);

trace_case!(
    an_archived_change_with_no_status_is_reported,
    proven(files! {"specflow/archive/add-user/spec.md" => "# Add user\n\nNo status line here.\n"}),
    |r| {
        fails_with(
            r,
            "no status",
            "an archived change with no recorded outcome passed",
        );
    }
);

trace_case!(
    an_archived_folder_with_no_spec_md_at_all_is_reported,
    proven(files! {"specflow/archive/add-user/notes.md" => "stray\n"}),
    |r| {
        assert_ne!(
            r.status,
            0,
            "an archived folder with no spec.md passed: {}",
            r.out()
        );
    }
);

// ---- a live change spec stays light; the rationale lives next to it

trace_case!(
    a_live_change_spec_carrying_a_decision_heading_is_reported,
    proven(
        files! {"specflow/add-user/spec.md" => "# Add user\n\n## Decision\n\nWe chose X.\n", "specflow/add-user/proposal.md" => "# Why\n"}
    ),
    |r| {
        fails_with(
            r,
            "Decision",
            "a change spec carrying the rationale headings passed",
        );
    }
);

trace_case!(
    a_live_change_with_no_proposal_md_is_reported,
    proven(files! {"specflow/add-user/spec.md" => "# Add user\n\nJust the delta.\n"}),
    |r| {
        fails_with(
            r,
            r"proposal\.md",
            "a change with no recorded reasoning passed",
        );
    }
);

trace_case!(
    a_fix_brief_is_exempt_from_the_split_rule,
    proven(
        files! {"specflow/fix-thing/spec.md" => "# Fix\n\n## Case\n\n## Decision\n\nInline, and allowed here.\n", "specflow/fix-thing/proposal.md" => "# Why\n"}
    ),
    |r| {
        passes(r, "a /spec-fix brief was held to the split rule");
    }
);

// ---- ADR-009: CHANGED is proven by nothing, so it says which kind it is.

trace_case!(
    a_changed_delta_with_no_kind_is_reported,
    live(
        "widen",
        "# Spec — widen\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — also locks the account after three failures\n"
    ),
    |r| {
        fails_with(
            r,
            "REMOVED REQ-USER-001",
            "the failure did not name the decomposition that makes the change provable",
        );
    }
);

trace_case!(
    a_changed_marked_wording_passes,
    live(
        "tidy",
        "# Spec — tidy\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (wording) — present tense, same meaning\n"
    ),
    |r| {
        passes(r, "a re-wording that moves no proof was blocked");
    }
);

trace_case!(
    /// `(correction)` claims the human review only `/spec-fix` stops for.
    a_changed_marked_correction_outside_a_fix_brief_is_reported,
    live("feature", "# Spec — feature\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — the old text was wrong\n"),
    |r| {
        fails_with(r, "spec-fix", "a feature spec claimed the fix flow's correction");
    }
);

trace_case!(
    a_changed_marked_correction_inside_a_fix_brief_passes,
    live(
        "fix-wrong-req",
        "# Fix — wrong req\n\n## Case\n3 WRONG-SPEC\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — said 30 days, the system has always done one hour\n"
    ),
    |r| {
        passes(r, "case 3 was blocked");
    }
);

trace_case!(
    /// The fix-brief exemption is for the split, never the delta.
    a_bare_changed_inside_a_fix_brief_is_still_reported,
    live("fix-thing", "# Fix — thing\n\n## Case\n3 WRONG-SPEC\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — rewritten\n"),
    |r| {
        assert_ne!(r.status, 0, "the fix-brief exemption swallowed the delta rule: {}", r.out());
    }
);

trace_case!(
    an_invented_kind_is_reported_rather_than_accepted,
    live(
        "odd",
        "# Spec — odd\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (minor) — a kind nobody defined\n"
    ),
    |r| {
        assert_ne!(r.status, 0, "an unrecognised kind passed: {}", r.out());
    }
);

trace_case!(
    a_changed_named_in_prose_outside_the_deltas_section_is_not_a_delta,
    live(
        "prose",
        "# Spec — prose\n\n## Requirement deltas\n- none — infrastructure only\n\n## Out of scope\n- CHANGED REQ-USER-001 — deliberately NOT part of this change\n"
    ),
    |r| {
        passes(
            r,
            "a sentence outside the deltas section was read as a delta",
        );
    }
);

// ---- ADR-045: a prohibition shares no id with what the requirement allows

trace_case!(
    an_added_that_pairs_a_prohibition_with_another_claim_is_reported_at_the_gate,
    live(
        "filters",
        "# Spec — filters\n\n## Requirement deltas\n- ADDED REQ-USER-001 — filters by A and B, never by C\n"
    ),
    |r| {
        fails_with(
            r,
            "id of its own",
            "a prohibition proven by a test of what it allows passed",
        );
    }
);

trace_case!(
    an_added_that_is_only_a_prohibition_passes_at_the_gate,
    live(
        "filters",
        "# Spec — filters\n\n## Requirement deltas\n- ADDED REQ-USER-001 — only an admin may filter by C\n"
    ),
    |r| {
        passes(r, "a prohibition on its own id was blocked");
    }
);

// ---- an ADDED id is new: ids are permanent so that retiring one is safe

trace_case!(
    an_added_id_a_shipped_change_removed_is_reported,
    plus(
        live(
            "reuse",
            "# Spec — reuse\n\n## Requirement deltas\n- ADDED REQ-USER-001 — a different reset flow\n"
        ),
        files! {"specflow/archive/drop/spec.md" => "# Spec — drop\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- REMOVED REQ-USER-001 — the old reset flow is gone\n", "specflow/archive/drop/proposal.md" => "# Proposal\n\nWhy.\n"}
    ),
    |r| {
        fails_with(
            r,
            "ADDs REQ-USER-001",
            "a retired id was handed to a new requirement",
        );
    }
);

trace_case!(
    an_added_id_the_same_spec_removes_is_reported,
    live(
        "swap",
        "# Spec — swap\n\n## Requirement deltas\n- REMOVED REQ-USER-001 — old meaning\n- ADDED REQ-USER-001 — new meaning\n"
    ),
    |r| {
        fails_with(
            r,
            "ADDs REQ-USER-001",
            "REMOVED plus ADDED on one id passed",
        );
    }
);

trace_case!(
    /// A REJECTED change removed nothing.
    an_added_id_that_only_a_rejected_change_removed_passes,
    plus(
        live("later", "# Spec — later\n\n## Requirement deltas\n- ADDED REQ-USER-001 — the thing\n"),
        files! {"specflow/archive/no/spec.md" => "# Spec — no\n\n**Status:** REJECTED 2026-07-30 — not wanted\n\n## Requirement deltas\n- REMOVED REQ-USER-001 — proposed, never done\n", "specflow/archive/no/proposal.md" => "# Proposal\n\nWhy.\n"}
    ),
    |r| {
        passes(r, "an id retired by nothing was reported as reused");
    }
);

// ---- headings on a branch

/// ADR-048: renumbering a heading the base has is a spec call, not this branch's.
#[test]
fn a_malformed_requirement_heading_the_base_branch_already_has_is_said_not_failed() {
    let r = trace_branch(
        files! {"specs/user.md" => user_spec() + "\n### REQ-USER-10 — legacy export\n\nThe system exports.\n"},
        &[files! {"README.md" => "unrelated\n"}],
        BranchOpts {
            under: "pkg",
            ..Default::default()
        },
    );
    passes(&r, "this branch was blocked over a heading it inherited");
    must_match(
        r#####"not failed — the base branch already has it.*"### REQ-USER-10 — legacy export""#####,
        &r.out(),
        "the inherited heading went unsaid",
    );
}

#[test]
fn a_malformed_requirement_heading_this_branch_writes_or_rewrites_fails_beside_one_it_inherited() {
    let legacy = user_spec()
        + "\n### REQ-USER-10 — legacy export\n\nThe system exports.\n\n### REQ-USER-20 — legacy import\n\nThe system imports.\n";
    let renamed = legacy.replacen("legacy import", "legacy import, renamed", 1);
    let r = trace_branch(
        files! {"specs/user.md" => legacy},
        &[files! {"specs/user.md" => renamed.clone()}],
        BranchOpts {
            uncommitted: files! {"specs/user.md" => renamed + "\n#### REQ-USER-011 — sync\n\nThe system syncs.\n"},
            ..Default::default()
        },
    );
    assert_ne!(
        r.status,
        0,
        "headings this branch wrote passed: {}",
        r.out()
    );
    for h in [
        r#####""### REQ-USER-20 — legacy import, renamed""#####,
        r#####""#### REQ-USER-011 — sync""#####,
    ] {
        assert!(
            r.out().contains(&format!("{h} is no requirement")),
            "not reported: {h}. {}",
            r.out()
        );
    }
    let out = r.out();
    let inherited: Vec<&str> = out
        .lines()
        .filter(|l| l.contains(r#####""### REQ-USER-10 — legacy export""#####))
        .collect();
    assert!(
        !inherited.is_empty(),
        "the inherited heading went unsaid: {out}"
    );
    assert!(
        inherited.iter().all(|l| l.contains("not failed")),
        "the inherited heading was failed with them: {out}"
    );
}

/// An archived change predates the rule; re-stamping history would rewrite the record.
#[test]
fn an_archived_change_keeps_its_bare_changed() {
    let r = trace_branch(
        files! {"specs/user.md" => user_spec()},
        &[
            files! {"specflow/archive/old/spec.md" => "# Spec — old\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — from before this rule\n", "specflow/archive/old/proposal.md" => "# Proposal\n\nWhy.\n"},
        ],
        BranchOpts::default(),
    );
    passes(
        &r,
        "an archived change was held to a rule written after it shipped",
    );
}

/// Skipped where the OS refuses the link: the case is about the walk.
#[test]
fn a_circular_symlink_does_not_hang_or_crash_the_walk() {
    let dir = temp_dir();
    write_files(
        &dir,
        &files! {".spec-flow/config.json" => trace_config(None), "specs/user.md" => user_spec(), "tests/user.test.ts" => USER_TEST},
    );
    std::fs::create_dir_all(dir.join("tests/nested")).unwrap();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(dir.join("tests"), dir.join("tests/nested/loop"));
    #[cfg(windows)]
    let linked =
        std::os::windows::fs::symlink_dir(dir.join("tests"), dir.join("tests/nested/loop"));
    if let Err(e) = linked {
        eprintln!("skipped: no symlink privilege here: {e}");
        return;
    }
    passes(&run_trace(&dir, &[]), "a circular symlink broke the walk");
}

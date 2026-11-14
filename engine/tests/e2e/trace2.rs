//! spec-trace: every delta line is one the engine reads (ADR-048), a change
//! has an archive folder of its own, and the spec layer's own cases.

use crate::harness::*;
use crate::helpers::*;

/// The wanted texts the output does not report in `format` (`%s` is the text).
fn not_reported(out: &str, want: &[&str], format: &str) -> Vec<String> {
    want.iter()
        .filter(|w| !matches(&format.replace("%s", &regex::escape(w)), out))
        .map(|w| w.to_string())
        .collect()
}

fn one(section: &str) -> [Files; 1] {
    [files! {"specflow/archive/add/spec.md" => shipped_with(section)}]
}

fn user() -> Files {
    files! {"specs/user.md" => user_spec()}
}

fn with_user(extra: Files) -> Files {
    let mut f = user();
    f.extend(extra);
    f
}

fn none() -> BranchOpts<'static> {
    BranchOpts::default()
}

// ---- every delta line is one the engine reads (ADR-048) --------------------

branch_case!(
    a_shipped_change_of_this_branch_with_a_delta_the_engine_does_not_read_is_reported,
    user(),
    one(
        "  - ADDED REQ-USER-002 — indented\n- **ADDED** REQ-USER-003 — bold\n- ADDED: REQ-USER-004 — colon\n- ADDED `REQ-USER-005` — backticks\n| ADDED | REQ-USER-006 | table |\n- [ADDED] REQ-USER-007 — bracketed\n- REQ-USER-008 (ADDED) — after\n- [x] ADDED REQ-USER-009 — checkbox\n- added REQ-USER-010 — lowercase\n### ADDED\n- ADDED\n  REQ-USER-011 — wrapped\n"
    ),
    none(),
    |r| {
        assert_ne!(r.status, 0, "deltas no check reads passed: {}", r.out());
        let m = not_reported(
            &r.out(),
            &[
                "indented",
                "bold",
                "colon",
                "backticks",
                "table |",
                "bracketed",
                "after",
                "checkbox",
                "lowercase",
                "wrapped",
            ],
            r#"%s" names REQ-USER-0\d\d, which no delta line"#,
        );
        assert!(m.is_empty(), "not reported: {m:?}. {}", r.out());
    }
);

branch_case!(
    a_shipped_change_of_this_branch_naming_two_ids_or_a_range_in_one_delta_is_reported,
    user(),
    one(
        "- ADDED REQ-USER-002, REQ-USER-003 — export and import\n- ADDED REQ-USER-004 and REQ-USER-005 — sync\n- ADDED REQ-USER-006; REQ-USER-007 — reports\n- ADDED REQ-USER-008 to REQ-USER-009 — audit\n- ADDED REQ-USER-010–012 — archive\n- ADDED REQ-USER-013..REQ-USER-014 — restore\n- ADDED REQ-USER-015 - REQ-USER-016 purge\n"
    ),
    none(),
    |r| {
        let m = not_reported(
            &r.out(),
            &[
                "REQ-USER-002,",
                "REQ-USER-004 and",
                "REQ-USER-006;",
                "REQ-USER-008 to",
                "REQ-USER-010–012",
                "REQ-USER-013..",
                "REQ-USER-015 -",
            ],
            r#""- ADDED %s[^"]*" names more than one id"#,
        );
        assert!(
            r.status != 0 && m.is_empty(),
            "not reported: {m:?}. {}",
            r.out()
        );
    }
);

branch_case!(
    /// A verb later in a line is prose; a note need not be a delta; a separator
    /// starts the text.
    in_a_shipped_change_prose_notes_quotes_fences_and_an_id_in_the_text_are_not_deltas,
    files! {"specs/user.md" => two_reqs()},
    [files! {"specflow/archive/tidy/spec.md" => shipped_with("> What this change does to `specs/`.\n- CHANGED REQ-USER-001 (wording), tense fixed\n- CHANGED REQ-USER-002 (wording) — REQ-USER-001 says the rest\n  - Changed from the old phrasing, which read as two claims\n- ADDED REQ-USER-004 — the new flow\n  which replaces what the REMOVED REQ-USER-001 did\n- Added a note to the README\n- Changed: none\n> Note: the ADDED REQ-USER-002 is behind a flag.\n```\n- ADDED REQ-USER-099 — an example, not a delta\n| ADDED | REQ-USER-098 |\n```\n")}],
    none(),
    |r| {
        must_not_match("which no delta line|more than one id|REQ-USER-09[89]", &r.out(), "a line that is not a delta was refused");
        must_match("REQ-USER-004 is ADDED by", &r.out(), "the check that refuses never ran");
    }
);

branch_case!(
    a_shipped_change_of_this_branch_with_its_deltas_under_another_heading_or_outside_the_section_is_reported,
    user(),
    [files! {
        "specflow/archive/capital/spec.md" => "# Spec — a\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement Deltas\n- ADDED REQ-USER-002 — export\n",
        "specflow/archive/deeper/spec.md" => "# Spec — b\n\n**Status:** SHIPPED 2026-10-17\n\n### Requirement deltas\n- ADDED REQ-USER-003 — import\n",
        "specflow/archive/openspec/spec.md" => "# Spec — c\n\n**Status:** SHIPPED 2026-10-17\n\n## ADDED Requirements\n### REQ-USER-004 — sync\n",
        "specflow/archive/elsewhere/spec.md" => "# Spec — d\n\n**Status:** SHIPPED 2026-10-17\n\n## Deltas\n- ADDED REQ-USER-005 — audit\n",
    }],
    none(),
    |r| {
        for (slug, said) in [
            ("capital", "has \"## Requirement Deltas\""),
            ("deeper", "has \"### Requirement deltas\""),
            ("openspec", "declares a delta outside `## Requirement deltas` (\"## ADDED Requirements\")"),
            ("elsewhere", "declares a delta outside `## Requirement deltas` (\"- ADDED REQ-USER-005"),
        ] {
            assert!(r.out().contains(&format!("specflow/archive/{slug}/spec.md {said}")), "not reported: {slug}. {}", r.out());
        }
    }
);

branch_case!(
    a_shipped_changes_example_in_a_code_fence_declares_nothing,
    user(),
    one("- none — infrastructure only\n```\n- ADDED REQ-USER-099 — an example, not a delta\n```\n"),
    none(),
    |r| {
        passes(r, "an example in a fence was held as a delta");
    }
);

branch_case!(
    a_shipped_change_of_this_branch_naming_a_second_id_after_a_space_or_a_second_number_is_reported,
    user(),
    one(
        "- ADDED REQ-USER-002 REQ-USER-003 — export and import\n- ADDED REQ-USER-004, 005 — sync\n- ADDED REQ-USER-006 to 007 — reports\n"
    ),
    none(),
    |r| {
        let m = not_reported(
            &r.out(),
            &[
                "REQ-USER-002 REQ-USER-003",
                "REQ-USER-004, 005",
                "REQ-USER-006 to 007",
            ],
            r#""- ADDED %s — [^"]*" names more than one id"#,
        );
        assert!(
            r.status != 0 && m.is_empty(),
            "not reported: {m:?}. {}",
            r.out()
        );
    }
);

branch_case!(
    a_shipped_change_with_its_verb_after_the_id_another_bullet_a_quote_or_another_verb_is_reported,
    user(),
    one(
        "| REQ-USER-002 | Export to CSV | ADDED |\n- REQ-USER-003 ADDED — export\n– ADDED REQ-USER-004 — an en dash\n> - ADDED REQ-USER-005 — quoted\n- MODIFIED REQ-USER-001 — now also PDF\n- DELETED REQ-USER-001 — gone\n"
    ),
    none(),
    |r| {
        for w in [
            "Export to CSV | ADDED |",
            "REQ-USER-003 ADDED — export",
            "an en dash",
            "quoted",
            "now also PDF",
            "gone",
        ] {
            assert!(
                r.out().contains(&format!("{w}\" names REQ-USER-")),
                "not reported: {w}. {}",
                r.out()
            );
        }
    }
);

branch_case!(
    a_shipped_changes_comment_nested_fence_or_indented_example_declares_nothing,
    user(),
    one(
        "- none — infrastructure only\n<!--\n- ADDED REQ-USER-003 — dropped\n-->\n````md\n```\n- ADDED REQ-USER-099 — an example\n```\n````\n~~~\n```\n- ADDED REQ-USER-098 — an example\n```\n~~~\n\nFor example:\n\n    - ADDED REQ-USER-097 — an example\n"
    ),
    none(),
    |r| {
        passes(r, "an example was held as a delta");
    }
);

branch_case!(
    a_shipped_change_with_a_fence_never_closed_or_lines_ended_by_cr_alone_is_still_held,
    user(),
    [
        files! {"specflow/archive/open/spec.md" => shipped_with("```\n- ADDED REQ-USER-002 — export\n"), "specflow/archive/cr/spec.md" => shipped_with("- ADDED REQ-USER-003 — import\n").replace('\n', "\r")}
    ],
    none(),
    |r| {
        fails_with(
            r,
            "REQ-USER-002 is ADDED by specflow/archive/open",
            "a delta in an unclosed fence went unread",
        );
        must_match(
            "REQ-USER-003 is ADDED by specflow/archive/cr",
            &r.out(),
            "a delta ended by CR went unread",
        );
    }
);

branch_case!(
    /// Outside the section, a word in capitals that names no id is not a delta.
    outside_its_deltas_a_shipped_change_may_lead_a_line_with_a_word_in_capitals,
    user(),
    [files! {"specflow/archive/cart/spec.md" => "# Spec — cart\n\n**Status:** SHIPPED 2026-10-17\n\n## Non-functional / constraints\n- `REMOVED` items never reappear after a sync\n\n## Notes\nADDED in response to issue #12.\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the cart syncs\n"}],
    none(),
    |r| {
        must_not_match("outside `## Requirement deltas`", &r.out(), "a constraint was refused as a delta");
        must_match("REQ-USER-002 is ADDED by", &r.out(), "the check that refuses never ran");
    }
);

branch_case!(
    a_shipped_change_of_this_branch_that_names_an_id_and_has_no_deltas_section_is_reported,
    user(),
    [
        files! {"specflow/archive/add/spec.md" => "# Spec — add\n\n**Status:** SHIPPED 2026-10-17\n\nThe user can export their data (REQ-USER-002).\n"}
    ],
    none(),
    |r| {
        fails_with(
            r,
            r"specflow/archive/add/spec\.md has no `## Requirement deltas` section",
            "a SHIPPED change with no deltas section passed",
        );
    }
);

branch_case!(
    /// An id is what a check binds: a line naming one no delta reads is
    /// refused, whatever its verb's case.
    a_shipped_change_with_a_table_row_in_title_case_beside_a_delta_is_reported,
    user(),
    one("- ADDED REQ-USER-001 — import\n| REQ-USER-002 | Added | export to CSV |\n| added | REQ-USER-003 | sync |\n"),
    none(),
    |r| {
        fails_with(r, r#""\| REQ-USER-002 \| Added \| export to CSV \|" names REQ-USER-002"#, "a row naming an id no delta reads passed");
        must_match(r#""\| added \| REQ-USER-003 \| sync \|" names REQ-USER-003"#, &r.out(), "a row naming an id no delta reads passed");
    }
);

branch_case!(
    a_shipped_change_whose_delta_text_quotes_a_comment_marker_hides_no_delta,
    user(),
    [
        files! {"specflow/archive/html/spec.md" => shipped_with("- ADDED REQ-USER-001 — strips `<!--` from names\n- ADDED REQ-USER-002 — export\n- ADDED REQ-USER-003 — strips `-->` too\n")}
    ],
    none(),
    |r| {
        fails_with(
            r,
            "REQ-USER-002 is ADDED by specflow/archive/html",
            "deltas between quoted comment markers went unread",
        );
        must_match(
            "REQ-USER-003 is ADDED by specflow/archive/html",
            &r.out(),
            "deltas between quoted comment markers went unread",
        );
    }
);

branch_case!(
    in_a_shipped_change_http_words_crud_headings_and_numbers_in_the_text_are_not_deltas,
    files! {"specs/user.md" => two_reqs()},
    [
        files! {"specflow/archive/api/spec.md" => "# Spec — api\n\n**Status:** SHIPPED 2026-10-17\n\n## Constraints\n| /users/:id | DELETE | REQ-USER-001 |\n- REQ-USER-001 (deleted users are hidden) is unchanged\n\n## Requirement deltas\n### Update\n- ADDED REQ-USER-002 - 404 or 410 for a deleted user\n  - REQ-USER-002 DELETE /users/:id answers 204\n  - UPDATE statements run in one transaction\n### Delete\n- ADDED REQ-USER-009 — the check runs\n"}
    ],
    none(),
    |r| {
        must_not_match(
            "which no delta line|more than one id|outside `## Requirement deltas`",
            &r.out(),
            "a correct line was refused",
        );
        must_match(
            "REQ-USER-009 is ADDED by",
            &r.out(),
            "the check that refuses never ran",
        );
        must_not_match(
            "REQ-USER-002 is ADDED by",
            &r.out(),
            "a declared id was held",
        );
    }
);

branch_case!(
    /// `REQ-USER-10` is no id: copied into specs/ and a test, it binds nothing.
    a_shipped_change_with_a_malformed_id_in_a_delta_line_is_reported,
    user(),
    one("- ADDED REQ-USER-001 — import\n- ADDED REQ-USER-10 — export to CSV\n"),
    none(),
    |r| {
        fails_with(r, r#""- ADDED REQ-USER-10 — export to CSV" names REQ-USER-10, which no check reads as an id"#, "a malformed id passed");
    }
);

branch_case!(
    a_shipped_change_whose_delta_text_starts_with_a_dash_and_names_another_id_holds_one_delta,
    files! {"specs/user.md" => two_reqs(), ".spec-flow/config.json" => trace_contract(&["tests/user.test.ts::REQ-USER-001 a", "tests/user.test.ts::REQ-USER-002 b"])},
    [
        files! {"specflow/archive/drop/spec.md" => shipped_with("- REMOVED REQ-USER-003 – superseded by REQ-USER-002\n")}
    ],
    none(),
    |r| {
        passes(r, "a delta whose text names an id after a dash was refused");
    }
);

branch_case!(
    a_shipped_fix_brief_that_says_it_has_no_delta_in_other_words_passes,
    user(),
    [
        files! {"specflow/archive/fix-thing/spec.md" => "# Fix — thing\n\n**Status:** SHIPPED 2026-10-17\n\n## Case\n2 WEAK-TEST\n\n## Requirement deltas\nNo change — REQ-USER-001 is right; its test missed a case\n"}
    ],
    none(),
    |r| {
        passes(r, "a section that says it has no delta was refused");
    }
);

branch_case!(
    /// Ids are permanent: what a later change removed stays removed.
    an_id_an_inherited_change_removed_later_is_retired_not_missing,
    with_user(files! {"specflow/archive/old/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export"]), "specflow/archive/drop/spec.md" => shipped_spec(&["REMOVED REQ-USER-002 — export is gone"])}),
    [files! {"specflow/archive/old/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"])}],
    none(),
    |r| {
        passes(r, "a requirement a shipped change removed was reported missing");
    }
);

branch_case!(
    an_added_id_an_archived_change_retired_in_another_spelling_is_a_reused_id,
    with_user(
        files! {"specflow/archive/old/spec.md" => shipped_with("- REMOVED REQ-USER-003, REQ-USER-004 — both gone\n")}
    ),
    [
        files! {"specflow/again/spec.md" => "# Spec — again\n\n## Requirement deltas\n- ADDED REQ-USER-004 — back again\n", "specflow/again/proposal.md" => "# Proposal\n\nWhy.\n"}
    ],
    none(),
    |r| {
        fails_with(
            r,
            "ADDs REQ-USER-004, which this spec or a shipped change REMOVED",
            "a retired id was given to a new requirement",
        );
    }
);

// ---- a change has a folder of its own in the archive

branch_case!(
    a_change_folded_inside_another_changes_archive_folder_is_reported,
    user(),
    [files! {
        "specflow/archive/fix-login/spec.md" => "# Fix — login\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
        "specflow/archive/fix-login/fix-login/spec.md" => "# Fix — login again\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-002 — x\n",
    }],
    none(),
    |r| {
        fails_with(
            r,
            "specflow/archive/fix-login/fix-login/ holds a change spec inside another change's folder",
            "a nested change passed",
        );
    }
);

branch_case!(
    a_folder_nested_inside_an_archived_change_the_base_already_had_is_not_held_here,
    with_user(files! {
        "specflow/archive/old/spec.md" => "# Spec — old\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
        "specflow/archive/old/old/spec.md" => "# Spec — old again\n\n**Status:** SHIPPED 2026-08-01\n\n## Requirement deltas\n- none\n",
    }),
    [files! {"README.md" => "unrelated\n"}],
    none(),
    |r| {
        passes(r, "this branch was blocked over a fold it inherited");
    }
);

fn fix_login_base() -> Files {
    with_user(
        files! {"specflow/archive/fix-login/spec.md" => "# Fix — login\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n"},
    )
}

fn fix_login_nested() -> Files {
    files! {"specflow/archive/fix-login/fix-login/spec.md" => "# Fix — login again\n\n**Status:** REJECTED 2026-10-17\n\n## Requirement deltas\n- none\n"}
}

branch_case!(
    a_folder_this_branch_nested_inside_an_archived_change_the_base_had_is_reported,
    fix_login_base(),
    [fix_login_nested()],
    none(),
    |r| {
        fails_with(
            r,
            "fix-login/fix-login/ holds a change spec",
            "a fold this branch made inside another change passed",
        );
    }
);

branch_case!(
    /// The base's own change is still the base's when this branch nests a fold in it.
    a_fold_nested_inside_the_bases_change_does_not_make_that_change_this_branchs,
    with_user(files! {"specflow/archive/foo/spec.md" => shipped_spec(&["ADDED REQ-USER-005 — drift from before"])}),
    [files! {"specflow/archive/foo/foo/spec.md" => "# Spec — foo again\n\n**Status:** REJECTED 2026-10-17\n\n## Requirement deltas\n- none\n"}],
    none(),
    |r| {
        must_not_match("REQ-USER-005", &r.out(), "the base's change was blamed on this branch");
        must_match("foo/foo/ holds a change spec", &r.out(), "the nested fold was not reported");
    }
);

/// A fold an earlier run nested is that run's: said until this run's fold.
#[test]
fn before_the_fold_a_fold_an_earlier_run_of_this_branch_nested_is_said_not_failed() {
    let r = trace_branch(
        fix_login_base(),
        &[fix_login_nested(), two_runs()[1].clone()],
        BranchOpts {
            state: files! {"phase" => "implement"},
            ..Default::default()
        },
    );
    passes(&r, "run two's milestone gate failed over run one's fold");
    must_match(
        "(?s)held from the fold's gate on.*fix-login/fix-login/ holds a change spec",
        &r.out(),
        "the nested fold went unsaid",
    );
}

/// Only where a filesystem tells the two apart can both be written.
#[test]
fn two_archived_folders_a_case_apart_are_reported_unless_both_are_the_bases() {
    let probe = temp_dir();
    write(probe.join("Aa"), "");
    if exists(probe.join("aA")) {
        eprintln!("skipped: this filesystem folds case");
        return;
    }
    let archived_as = |name: &str| files! {format!("specflow/archive/{name}/spec.md") => format!("# Fix — {name}\n\n**Status:** REJECTED 2026-07-30\n\n## Requirement deltas\n- none\n")};
    let r = trace_branch(
        with_user(archived_as("Fix-Login")),
        &[archived_as("fix-login")],
        none(),
    );
    fails_with(
        &r,
        "specflow/archive/Fix-Login/ and specflow/archive/fix-login/ differ only in case",
        "a case-variant fold of this branch passed",
    );
    let mut both = with_user(archived_as("Fix-Login"));
    both.extend(archived_as("fix-login"));
    let r = trace_branch(both, &[files! {"README.md" => "unrelated\n"}], none());
    passes(&r, "this branch was blocked over a pair it inherited");
}

trace_case!(
    /// A run signed off before a spelling was refused builds on; its fold is
    /// held to it.
    a_live_spec_with_a_delta_the_engine_does_not_read_does_not_fail_a_milestone_gate,
    with_user(files! {"specflow/add-io/spec.md" => "# Spec — add io\n\n## Requirement deltas\n- ADDED REQ-USER-002, REQ-USER-003 — export and import\n- **ADDED** REQ-USER-004 — sync\n", "specflow/add-io/proposal.md" => "# Proposal\n\nWhy.\n"}),
    |r| {
        passes(r, "a milestone gate failed over a spelling its run was signed off with");
    }
);

trace_case!(
    /// A name the archive gains mid-run is refused at spec time, never at a
    /// milestone gate.
    a_live_change_named_like_an_archived_one_is_not_failed_at_a_milestone_gate,
    with_user(files! {
        "specflow/archive/fix-login/spec.md" => "# Fix — login\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
        "specflow/fix-login/spec.md" => "# Spec — fix login again\n\n## Requirement deltas\n- none\n",
        "specflow/fix-login/proposal.md" => "# Proposal\n\nWhy.\n",
    }),
    |r| {
        passes(r, "a milestone gate failed over a clash its run cannot rename its way out of");
    }
);

trace_case!(
    an_archived_changes_own_milestones_and_telemetry_are_not_changes,
    with_user(files! {
        "specflow/archive/add-users/spec.md" => "# Spec — add users\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- none\n",
        "specflow/archive/add-users/milestones/M1.md" => "# M1\n",
        "specflow/archive/add-users/telemetry/run-trace.log" => "x\n",
    }),
    |r| {
        passes(r, "a change's own files were read as a nested change");
    }
);

// ---- an empty spec layer: grace while adopting, contradiction after a ship

trace_case!(
    an_empty_spec_layer_passes_while_nothing_has_shipped_yet,
    files! {".spec-flow/config.json" => trace_contract(&["an unrelated test that proves no requirement"])},
    |r| {
        passes(r, "a repo mid-adoption was blocked");
        must_match("no requirements to bind", &r.out(), "unexpected output");
    }
);

trace_case!(
    an_empty_spec_layer_fails_once_a_change_ships_a_requirement_it_claims_landed,
    files! {
        "specflow/archive/add-users/spec.md" => "# Spec — add users\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- ADDED REQ-USER-001 — the user can do the thing\n",
        "specflow/archive/add-users/proposal.md" => "# Proposal\n\nWhy.\n",
        "tests/placeholder.test.ts" => "it(\"unrelated\", () => {});\n",
    },
    |r| {
        fails_with(
            r,
            "SHIPPED",
            "a change claims its deltas landed in an empty specs/, and spec-trace reported green",
        );
    }
);

trace_case!(
    /// `/spec-fix` case 4 and any wiring-only change ship with no deltas, by
    /// contract.
    a_shipped_change_with_no_requirement_deltas_keeps_the_grace,
    files! {
        "specflow/archive/wiring-only/spec.md" => "# Fix — wiring only\n\n**Status:** SHIPPED 2026-08-14\n\n## Case\ncase 4 — INFRA\n\n## Requirement deltas\n- none — infrastructure only\n",
        "specflow/archive/wiring-only/proposal.md" => "# Proposal\n\nWhy.\n",
        ".spec-flow/config.json" => trace_contract(&["an unrelated test that proves no requirement"]),
    },
    |r| {
        passes(r, "an infrastructure fix with no deltas blocked the gate");
    }
);

trace_case!(
    /// A stale artifact cannot be REPORTED as having run; no build-directory
    /// skip list is wanted.
    a_stale_test_surviving_only_in_build_output_does_not_prove_a_requirement,
    with_user(files! {".spec-flow/config.json" => trace_contract(&["tests/other.test.ts::an unrelated test that did run"]), "dist/tests/user.test.ts" => "it('REQ-USER-001 lets the user do the thing', () => {});\n"}),
    |r| {
        fails_with(r, "REQ-USER-001", "a build artifact counted as proof");
    }
);

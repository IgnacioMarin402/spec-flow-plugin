//! The gate is what every other guarantee rests on, so it is tested by
//! running it: a throwaway repository, the engine installed apart from it,
//! and what the real hook did. A Stop hook blocks by printing a decision and
//! exiting 0 — a non-zero exit is no failure at all — so "did it say block,
//! and did it write down what it judged" is the assertion, never the exit.
//!
//! Two properties of the scaffolding are load-bearing: every case has a real
//! base and a commit changing a tracked file, so the scope is NON-EMPTY, and
//! the base branch is a parameter, never one name.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;
use crate::smoke1::bash;
use crate::smoke2::jsonl;
use crate::smoke3::seed_gate_history;

fn red() -> Value {
    tool_json(&["exit=1"])
}

const JUNIT_PROVES: &str = "<testsuites><testcase name=\"REQ-FIX-001 the fix\"/></testsuites>\n";
const JUNIT_SKIPS: &str =
    "<testsuites><testcase name=\"REQ-FIX-001 the fix\"><skipped/></testcase></testsuites>\n";
const FIX_SPEC: &str = "<!-- spec-scope: modules/fix -->\n\n# Fix\n\n### REQ-FIX-001 — the fix\n\nThe system is fixed.\n";

/// A suite that writes body as its report, as a real one does on every run:
/// the gate removes the previous report first.
fn suite_writing(body: &str) -> Value {
    tool_json(&[&format!("write=reports/junit.xml={body}")])
}

fn junit_report(path: &str) -> Option<Value> {
    Some(json!({"format": "junit", "path": path}))
}

fn fix_specs() -> Option<Files> {
    Some(files! {"specs/fix.md" => FIX_SPEC})
}

/// A gate history to seed, given the commit the gate will judge.
pub type History = Option<Box<dyn Fn(&str) -> String>>;

#[derive(Default)]
pub struct GateOpts {
    pub phase: &'static str,
    pub spec_trace_red: bool,
    pub dirty: bool,
    pub extra_checks: Vec<Value>,
    pub contract_version: i64,
    pub crash: bool,
    pub gate_attempts: &'static str,
    pub history: History,
    pub lint: Option<Value>,
    pub test: Option<Value>,
    /// Commit real work, none of it in scope.
    pub no_scope_change: bool,
    pub base_branch: &'static str,
    pub scope_globs: Option<Vec<&'static str>>,
    pub engine_checkout: bool,
    pub commit_phase: bool,
    pub phase_owner: &'static str,
    pub base_ref: &'static str,
    pub stay_on_base: bool,
    pub report: Option<Value>,
    pub specs: Option<Files>,
    pub open_at: &'static str,
}

pub struct GateRepo {
    pub engine: PathBuf,
    pub repo: PathBuf,
    pub git_dir: Dir,
    _engine_copy: Option<Dir>,
}

/// An engine whose unscoped checks panic: the shipped engine's own source
/// with one panic added (cargo's `gatecrash` feature), built here unless CI
/// built it already.
pub fn crashing_engine() -> Dir {
    static BUILT: OnceLock<Result<PathBuf, String>> = OnceLock::new();
    let engine = copy_engine();
    let crash = match std::env::var_os("SPEC_FLOW_CRASH_BINARY").filter(|c| !c.is_empty()) {
        Some(c) => PathBuf::from(c),
        None => BUILT
            .get_or_init(|| {
                let target = std::env::temp_dir().join("spec-flow-gatecrash");
                let out = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
                    .args(["build", "--release", "--locked", "--features", "gatecrash"])
                    .current_dir(&SETUP.repo_root)
                    .env("CARGO_TARGET_DIR", &target)
                    .output()
                    .map_err(|e| e.to_string())?;
                if !out.status.success() {
                    return Err(format!(
                        "building the crashing engine: {}",
                        String::from_utf8_lossy(&out.stderr)
                    ));
                }
                Ok(target.join("release").join(exe("spec-flow")))
            })
            .clone()
            .unwrap_or_else(|e| panic!("{e}")),
    };
    let b = std::fs::read(&crash)
        .unwrap_or_else(|e| panic!("the crashing engine {}: {e}", crash.display()));
    write_mode(&binary(&engine), &b, 0o755);
    engine
}

pub fn gate_fixture(o: &GateOpts) -> GateRepo {
    let phase = if o.phase.is_empty() {
        "implement"
    } else {
        o.phase
    };
    let base_branch = if o.base_branch.is_empty() {
        "main"
    } else {
        o.base_branch
    };
    let globs = o.scope_globs.clone().unwrap_or(vec!["*.ts"]);
    let contract_version = if o.contract_version == 0 {
        1
    } else {
        o.contract_version
    };
    let gate_attempts = if o.gate_attempts.is_empty() {
        "0"
    } else {
        o.gate_attempts
    };
    let git_dir = temp_dir();
    let engine_copy = if o.crash {
        Some(crashing_engine())
    } else if o.engine_checkout {
        let e = copy_engine();
        for args in [
            &["init", "-q", "."][..],
            &["symbolic-ref", "HEAD", "refs/heads/main"],
            &["config", "core.autocrlf", "false"],
            &["add", "-A"],
            &["commit", "-qm", "engine at its first revision"],
        ] {
            git(&e, args);
        }
        Some(e)
    } else {
        None
    };
    let engine = engine_copy
        .as_ref()
        .map_or(engine_dir().to_path_buf(), |e| e.to_path_buf());
    let repo = if o.open_at.is_empty() {
        git_dir.to_path_buf()
    } else {
        git_dir.join(o.open_at)
    };
    let head = format!("refs/heads/{base_branch}");
    for args in [
        &["init", "-q", "."][..],
        &["symbolic-ref", "HEAD", &head],
        &["config", "user.email", "fixture@example.com"],
        &["config", "user.name", "fixture"],
        &["config", "core.autocrlf", "false"],
    ] {
        git(&git_dir, args);
    }
    let mut verify = json!({"scope_globs": globs, "lint": o.lint.clone().unwrap_or_else(noop), "lint_no_fix": noop(), "test": o.test.clone().unwrap_or_else(noop),
        "test_name": "fixture-test", "lint_name": "fixture-lint", "lint_config_hint": "fixture.config"});
    if !o.base_ref.is_empty() {
        verify["base_ref"] = json!(o.base_ref);
    }
    let mut trace = json!({"specs_dir": "specs", "proof_dir": "tests", "proof_suffix": ".spec.ts", "not_a_capability": []});
    match &o.report {
        Some(r) => trace["report"] = r.clone(),
        None => trace["executed_tests"] = noop(),
    }
    let contract = json!({"contract_version": contract_version, "verify": verify, "trace": trace, "extra_checks": o.extra_checks,
        "unscoped_denied": {"scripts": [], "tools": [], "scoped_allowed": [], "scoped_alternative": "", "scoped_examples": []}});
    write(
        repo.join(".spec-flow/config.json"),
        &serde_json::to_string_pretty(&contract).unwrap(),
    );
    write(repo.join(".gitignore"), ".claude/state/\n");
    write(repo.join("a.ts"), "export const a = 1;\n");
    // A requirement nothing reports a test for: the real spec-trace, red.
    let specs = o.specs.clone().or_else(|| {
        o.spec_trace_red
            .then(|| files! {"specs/fix.md" => FIX_SPEC})
    });
    write_files(&repo, &specs.unwrap_or_default());
    git(&git_dir, &["add", "-A"]);
    git(
        &git_dir,
        &["commit", "-qm", &format!("baseline on {base_branch}")],
    );
    // The base every case diffs against is a real ancestor, never HEAD itself.
    if !o.stay_on_base {
        git(&git_dir, &["checkout", "-q", "-b", "feature"]);
        if o.no_scope_change {
            write(
                repo.join("notes.md"),
                "# notes\n\nReal work, none of it matching scope_globs.\n",
            );
        } else {
            write(repo.join("b.ts"), "export const changed = 1;\n");
        }
        git(&git_dir, &["add", "-A"]);
        git(&git_dir, &["commit", "-qm", "change"]);
    }
    if o.dirty {
        write(repo.join("dirty.txt"), "uncommitted\n");
    }
    write(state_path(&repo, "phase"), phase);
    write(state_path(&repo, "gate_attempts"), gate_attempts);
    if !o.phase_owner.is_empty() {
        write(state_path(&repo, "phase.session"), o.phase_owner);
    }
    if o.commit_phase {
        let p = if o.open_at.is_empty() {
            ".claude/state/phase".to_string()
        } else {
            format!("{}/.claude/state/phase", o.open_at)
        };
        git(&git_dir, &["add", "-f", "--", &p]);
        git(
            &git_dir,
            &["commit", "-qm", "a phase this repository committed"],
        );
    }
    // After the commits: a history has to name the commit the gate judges.
    if let Some(h) = &o.history {
        write(
            state_path(&repo, "gate-history.log"),
            &h(&git(&git_dir, &["rev-parse", "--short", "HEAD"])),
        );
    }
    GateRepo {
        engine,
        repo,
        git_dir,
        _engine_copy: engine_copy,
    }
}

pub struct GateRun {
    pub r: Output,
    pub history: String,
    pub failure_log: String,
    pub lint_argv: Option<String>,
}

impl std::ops::Deref for GateRun {
    type Target = Output;
    fn deref(&self) -> &Output {
        &self.r
    }
}

impl GateRun {
    /// A block that is a GATE FAILED, never a pass reported through the same
    /// channel (ADR-010).
    pub fn rejected(&self) -> bool {
        self.blocked() && !self.reason().contains("spec-flow: gate PASSED")
    }
}

pub fn run_gate(b: &GateRepo, payload: Value, env: &[&str]) -> GateRun {
    let r = Hook {
        engine: Some(b.engine.clone()),
        env: env.iter().map(|s| s.to_string()).collect(),
    }
    .run("gate", payload, &b.repo);
    let lint = state_path(&b.repo, "lint-argv.log");
    GateRun {
        r,
        history: read(state_path(&b.repo, "gate-history.log"))
            .trim()
            .to_string(),
        failure_log: read(state_path(&b.repo, "gate-failure.log"))
            .trim()
            .to_string(),
        lint_argv: exists(&lint).then(|| read(&lint)),
    }
}

fn with_gate(o: GateOpts) -> GateRun {
    let b = gate_fixture(&o);
    run_gate(&b, json!({}), &[])
}

/// Kept in step with the gate's by hand: a drift turns one of the two streak
/// cases red, loudly.
const MAX_DIRTY_SKIPS: usize = 10;

fn skip_dirty_history(n: usize) -> History {
    Some(Box::new(move |sha: &str| {
        (0..n).map(|i| format!("2026-08-01T00:00:{i:02}Z {sha} phase=implement attempt=0 result=skip-dirty lint=- test=- unscoped=- files=1\n")).collect()
    }))
}

fn judged_history() -> History {
    Some(Box::new(|sha: &str| {
        format!(
            "2026-08-01T00:00:00Z {sha} phase=implement attempt=0 result=pass lint=0 test=0 unscoped=0 files=1\n"
        )
    }))
}

fn dead_running() -> History {
    Some(Box::new(|_: &str| {
        "2026-08-01T00:00:00Z abc1234 phase=implement attempt=0 result=running lint=- test=- unscoped=- files=-\n".into()
    }))
}

/// One gate case: a fixture built from the options, the gate run once on it.
macro_rules! gate_case {
    ($(#[$doc:meta])* $name:ident, { $($opt:ident : $val:expr),* $(,)? }, |$r:ident| $body:block) => {
        $(#[$doc])*
        #[test]
        fn $name() {
            #[allow(clippy::needless_update)]
            let $r = with_gate(GateOpts { $($opt: $val,)* ..Default::default() });
            $body
        }
    };
}

// ---- the reason this exists: engine and repo are never one directory

gate_case!(
    reads_claude_project_dir_never_its_own_install_location,
    {},
    |r| {
        assert!(
            !r.rejected(),
            "the gate rejected a green tree: {}",
            r.stderr
        );
        must_match(
            "result=pass",
            &r.history,
            "no pass recorded in the REPO's own state",
        );
    }
);

gate_case!(
    /// If this reads files=0, base resolution stopped finding main and every
    /// case is back to never invoking lint.
    a_green_run_against_real_changes_reports_the_real_scope,
    {},
    |r| {
        must_match(r"files=1\b", &r.history, "expected files=1");
    }
);

gate_case!(
    /// The failure this engine keeps having: a hook that dies allows the stop.
    an_unexpected_throw_inside_the_engine_blocks_the_stop_and_records_it,
    { crash: true },
    |r| {
        assert!(r.blocked(), "the gate threw and ALLOWED the stop — a milestone nothing checked would read as a clean pass");
        must_match("result=fail:hook-error", &r.history, "blocked, but left no hook-error line");
    }
);

gate_case!(
    /// The block sends a human to the stack on stderr: it has to be there.
    an_unexpected_throw_inside_the_engine_leaves_its_stack_on_stderr,
    { crash: true },
    |r| {
        must_match("simulated engine defect", &r.stderr, "stderr does not say what threw");
        must_match("unscoped[./-]", &r.stderr, "stderr carries no stack naming where it threw");
    }
);

gate_case!(
    /// A timed-out hook renders no decision; a surviving `running` line is
    /// the evidence.
    an_armed_gate_records_the_attempt_before_it_runs_anything,
    {},
    |r| {
        must_not_match("result=running", &r.history, "the run left its own `running` line behind");
        must_match("result=pass", &r.history, "expected the running line replaced by the outcome");
    }
);

gate_case!(a_gate_killed_mid_judgement_is_reported_by_the_next_one_not_forgotten, { history: dead_running() }, |r| {
    assert!(r.blocked(), "a previous gate died without judging and this one allowed the stop: {}", r.history);
    must_match("result=fail:killed", &r.history, "the kill was not recorded as such");
    must_match("(?i)timeout|time budget", &r.stdout, "the block does not name the likely cause");
});

gate_case!(the_report_clears_the_evidence_so_it_does_not_block_forever, { history: dead_running() }, |r| {
    must_not_match(" result=running ", &r.history, "the dangling line survived its own report");
});

// ---- the one deliberate fail-CLOSED case

gate_case!(an_unrecognized_contract_version_blocks_loudly_instead_of_falling_back_to_defaults, { contract_version: 999 }, |r| {
    assert!(r.blocked(), "a contract version this engine does not understand did not block the stop");
    must_match("fail:contract", &r.history, "history did not record a contract failure");
});

gate_case!(a_red_unscoped_check_blocks_the_stop_and_records_why, { spec_trace_red: true }, |r| {
    assert!(r.blocked(), "the gate did not block for a failing check");
    must_match("result=fail", &r.history, "history did not record the failure");
    assert!(r.failure_log.contains("spec-trace"), "the failure log does not name the check that failed");
});

gate_case!(
    /// A traceability failure on a green suite is an edit, not a re-plan.
    spec_trace_alone_with_lint_and_the_suite_green_takes_the_cheap_route,
    { spec_trace_red: true },
    |r| {
        must_match("result=fail:lint/trace", &r.history, "a traceability failure must classify as lint/trace");
        must_match("test=0", &r.history, "the suite was meant to be green");
        must_match("the tests pass, so the plan is NOT in question", &r.reason(), "the block did not route to the direct fix");
        assert!(!(matches("(?i)re-?plan", &r.reason()) && !r.reason().contains("Do NOT re-plan")), "the block asked for a re-plan on a green suite: {}", r.reason());
    }
);

gate_case!(
    a_green_run_is_never_rejected_and_always_records_the_pass,
    {},
    |r| {
        assert!(
            !r.rejected(),
            "the gate rejected a tree where every check passed"
        );
        must_match("result=pass", &r.history, "expected a pass line");
        must_match(
            "spec=0",
            &r.history,
            "the declared check did not report its field",
        );
    }
);

gate_case!(
    /// A first pass wakes the orchestrator on the channel that reaches a
    /// human (ADR-010).
    a_green_run_on_a_new_commit_wakes_the_orchestrator,
    {},
    |r| {
        assert!(r.blocked(), "a first-time pass did not block — nothing will advance the run: {}", r.stdout);
        must_match("spec-flow: gate PASSED", &r.reason(), "the block does not announce a pass");
        must_match("(?i)next milestone|MODE=FOLD|'done'", &r.reason(), "the pass block does not say what to do next");
        must_not_match("^GATE FAILED", &r.reason(), "a pass block reads like a failure block");
    }
);

gate_case!(
    a_real_junit_report_proving_the_requirement_wakes_the_orchestrator_and_tells_it_what_passed,
    { report: junit_report("reports/junit.xml"), test: Some(suite_writing(JUNIT_PROVES)), specs: fix_specs() },
    |r| {
        assert!(r.blocked(), "a real JUnit report proving the requirement did not wake the run: {}", r.stdout);
        must_match("result=pass", &r.history, "expected a pass line");
        must_match("spec-flow: gate PASSED", &r.reason(), "passed without telling the human");
    }
);

gate_case!(
    /// A skip is "ran, and did not run", never "the report never appeared".
    a_real_junit_report_marking_the_requirement_skipped_blocks_as_an_unproven_requirement,
    { report: junit_report("reports/junit.xml"), test: Some(suite_writing(JUNIT_SKIPS)), specs: fix_specs() },
    |r| {
        assert!(r.blocked(), "a requirement whose only test was <skipped/> passed the gate");
        must_match("result=fail", &r.history, "history did not record the failure");
        must_match("spec=[1-9]", &r.history, "spec-trace did not report itself as the failing check");
        assert!(r.failure_log.contains("REQ-FIX-001") && r.failure_log.contains("has no test"), "the failure does not name the unproven requirement: {}", r.failure_log);
        must_not_match("reporter flag|does not exist", &r.failure_log, "a skip was reported as a missing report file");
        must_not_match("reported no tests at all", &r.failure_log, "a report with one skipped case read as saying nothing");
    }
);

gate_case!(
    /// The path is the adopter's: one naming a source file must never cost
    /// them that file.
    a_report_path_naming_a_file_that_is_not_a_report_never_loses_that_file,
    { report: junit_report("a.ts"), specs: fix_specs() },
    |r| {
        assert!(r.rejected(), "a report path naming a source file passed the gate: {}", r.stdout);
    }
);

gate_case!(
    /// Every spawn runs in the background (ADR-023): a stop ends a turn, not
    /// a milestone.
    a_dirty_tree_on_a_commit_already_judged_is_skipped_not_judged_and_says_nothing,
    { spec_trace_red: true, dirty: true, history: judged_history() },
    |r| {
        assert!(!r.blocked(), "a dirty tree was judged; an implementer mid-write would be reported as a failure");
        must_match("result=skip-dirty", &r.history, "expected skip-dirty");
        assert!(r.stdout.trim().is_empty(), "the gate spoke about a tree it did not judge: {}", r.stdout);
    }
);

gate_case!(
    /// The orchestrator committed and waits for a verdict nothing will
    /// deliver (ADR-012).
    a_dirty_tree_on_a_commit_nothing_has_judged_wakes_the_run,
    { dirty: true },
    |r| {
        assert!(r.blocked(), "the gate skipped a commit nothing has judged and said nothing: {}", r.history);
        must_match("(?i)dirty", &r.reason(), "the block does not say what is wrong");
        must_match("result=skip-dirty", &r.history, "expected the skip still recorded");
    }
);

gate_case!(the_wake_fires_once_per_commit_not_on_every_stop_the_tree_is_dirty, { dirty: true, history: skip_dirty_history(1) }, |r| {
    assert!(!r.blocked() && r.stdout.trim().is_empty(), "the same unjudged commit was reported twice: {}", r.stdout);
});

gate_case!(a_tree_that_has_stayed_dirty_for_a_whole_streak_wakes_the_run, { dirty: true, history: skip_dirty_history(MAX_DIRTY_SKIPS - 1) }, |r| {
    assert!(r.blocked(), "the {MAX_DIRTY_SKIPS}th skip in a row said nothing: {}", r.history);
    must_match("(?i)dirty", &r.reason(), "the block does not say what is wrong");
    must_match("result=skip-dirty", &r.history, "expected the skip still recorded");
});

gate_case!(the_escalation_fires_once_per_streak_not_on_every_stop_past_the_threshold, { dirty: true, history: skip_dirty_history(MAX_DIRTY_SKIPS) }, |r| {
    assert!(!r.blocked() && r.stdout.trim().is_empty(), "the gate spoke twice about the same unbroken streak: {}", r.stdout);
});

gate_case!(
    /// Transparent means silent too: every session in every repository fires Stop.
    outside_an_implement_phase_the_hook_is_transparent,
    { phase: "idle", spec_trace_red: true },
    |r| {
        assert!(!r.blocked() && r.history.is_empty() && r.stdout.trim().is_empty(), "the gate acted outside a run: {} {}", r.stdout, r.history);
    }
);

gate_case!(
    a_repos_own_extra_checks_are_read_from_the_contract_and_appear_in_the_history_line,
    { extra_checks: vec![json!({"name": "fixture-extra", "field": "extra", "green": "(fixture extra ok)", "hint": "fixture hint", "cmd": tool_json(&["out=fixture-extra: OK"]), "class": "lint/trace"})] },
    |r| {
        assert!(!r.rejected(), "an all-green tree with an extra check was rejected: {}", r.stderr);
        must_match("extra=0", &r.history, "the declared extra check's field did not appear");
    }
);

gate_case!(
    /// A runner treats trailing paths as a filter over TEST files: scoping
    /// the suite is a false red.
    verify_test_runs_with_no_file_arguments,
    { test: Some(tool_json(&["failargs", "--"])) },
    |r| {
        assert!(!r.rejected(), "verify.test is scoped to changed files: {}", r.failure_log);
        must_match("result=pass", &r.history, "expected a pass line");
    }
);

gate_case!(
    verify_lint_stays_scoped_to_changed_files_and_never_receives_untouched_debt,
    { lint: Some(tool_json(&["argsto=.claude/state/lint-argv.log", "--"])) },
    |r| {
        let argv = r.lint_argv.as_deref().expect("the lint stand-in never ran");
        assert!(argv.contains("b.ts") && !argv.contains("a.ts"), "verify.lint received {argv:?}");
    }
);

gate_case!(
    /// A base that cannot be resolved is a REFUSAL, never an empty scope.
    an_unresolvable_base_branch_blocks_loudly_instead_of_silently_checking_nothing,
    { base_branch: "release/7.x", lint: Some(red()), test: Some(red()) },
    |r| {
        assert!(r.blocked(), "the gate allowed the stop with no base: {}", r.history);
        must_match("result=fail:base", &r.history, "expected fail:base");
        must_match("base_ref", &r.stdout, "the block does not name the contract field that fixes this");
    }
);

gate_case!(verify_base_ref_resolves_a_base_no_candidate_in_the_ladder_could_find, { base_branch: "release/7.x", base_ref: "release/7.x" }, |r| {
    assert!(!r.rejected(), "an explicit base_ref was rejected: {}", r.stdout);
    must_match("result=pass", &r.history, "expected a pass line");
    must_match(r"files=1\b", &r.history, "base_ref was declared but not read");
});

gate_case!(
    /// `files=` separates the two fail:base doors in the record.
    a_declared_base_ref_that_git_cannot_resolve_blocks_rather_than_falling_back,
    { base_ref: "origin/does-not-exist", lint: Some(red()), test: Some(red()) },
    |r| {
        assert!(r.blocked(), "a bogus base_ref fell back to an empty scope: {}", r.history);
        must_match("result=fail:base", &r.history, "expected fail:base");
        must_match("files=-", &r.history, "nothing was counted here; a count reads as the other door");
    }
);

gate_case!(
    /// An empty diff is a fact about the diff, never grounds to skip the
    /// suite (ADR-008).
    a_milestone_that_changed_no_file_in_scope_still_runs_the_suite,
    { no_scope_change: true, test: Some(red()) },
    |r| {
        assert!(r.blocked(), "no file in scope changed, so the suite was skipped: {}", r.history);
        must_match("result=fail:behaviour", &r.history, "expected fail:behaviour");
        must_match(r"files=0\b", &r.history, "expected files=0");
    }
);

gate_case!(an_empty_scope_reports_lint_as_not_run_never_as_clean, { no_scope_change: true, test: Some(red()) }, |r| {
    must_match("lint=-", &r.history, "history claims a lint result for a linter never invoked");
    must_not_match(r"\(clean\)", &r.failure_log, "the failure log reports the linter as clean over files it never received");
});

gate_case!(
    /// Work done ON the base branch: the scope is empty for every milestone
    /// of the run.
    a_base_that_resolves_to_head_itself_is_refused_not_read_as_an_empty_milestone,
    { stay_on_base: true },
    |r| {
        assert!(r.blocked(), "the base resolved to HEAD and the gate passed anyway: {}", r.history);
        must_match("result=fail:base", &r.history, "expected fail:base");
        must_match(r"files=0\b", &r.history, "this door counted an empty scope");
    }
);

gate_case!(the_refusal_names_the_branch_it_is_standing_on_and_what_to_do_about_it, { stay_on_base: true }, |r| {
    must_match("base_ref", &r.stdout, "the block does not point at the field that fixes it");
    must_match("(?i)branch", &r.stdout, "the block does not mention branching");
});

gate_case!(an_empty_scope_on_a_real_branch_still_passes, { no_scope_change: true }, |r| {
    assert!(!r.rejected(), "real work outside scope_globs was refused as a degenerate base: {}", r.stdout);
    must_match("result=pass", &r.history, "expected a pass line");
    must_match(r"files=0\b", &r.history, "expected files=0");
});

gate_case!(
    /// `**/*.ts` skips the repository root, where b.ts is.
    a_scope_globs_spelled_the_npm_way_is_refused_by_the_contract,
    { scope_globs: Some(vec!["**/*.ts"]), lint: Some(red()) },
    |r| {
        assert!(r.blocked(), "a linter that exits 1 was never invoked and the stop was allowed: {}", r.history);
        must_match("result=fail:contract", &r.history, "expected fail:contract");
        must_match("scope_globs", &r.reason(), "the block never names the field");
        must_match(r#""\*\.ts""#, &r.reason(), "the block does not spell out the form that works");
    }
);

gate_case!(a_scope_that_matches_nothing_the_repo_tracks_is_refused, { scope_globs: Some(vec!["nope/*.ts"]), lint: Some(red()) }, |r| {
    assert!(r.blocked(), "an inert scope passed with the linter never invoked: {}", r.history);
    must_match("result=fail:scope", &r.history, "expected fail:scope");
    must_match(r"files=0\b", &r.history, "expected files=0");
    must_match("scope_globs", &r.stdout, "the block never names the field");
});

gate_case!(
    /// The unit of a run is the repository (ADR-027).
    a_project_directory_inside_the_repository_but_not_at_its_root_is_refused,
    { open_at: "back", lint: Some(red()) },
    |r| {
        assert!(r.rejected(), "a subdirectory was judged as the repository: {}", r.history);
        must_match("result=fail:root", &r.history, "expected fail:root");
        must_match("repository root", &r.stdout, "the block does not say where to open the repository");
    }
);

gate_case!(
    /// A phase git tracks came with the repository, not from a run (ADR-017).
    a_phase_the_repository_committed_arms_nothing,
    { commit_phase: true, lint: Some(red()), test: Some(red()) },
    |r| {
        assert!(!r.blocked() && r.history.is_empty(), "a committed phase armed the gate: {} {}", r.stdout, r.history);
    }
);

gate_case!(a_payload_with_no_session_id_arms_a_sealed_phase_rather_than_standing_down, { phase_owner: "session-a", lint: Some(red()) }, |r| {
    assert!(r.blocked(), "an absent session_id disarmed the gate: {}", r.history);
});

gate_case!(
    /// A red test on attempt 1 goes to the implementer; only a second is
    /// evidence against the plan.
    a_red_test_on_attempt_1_routes_to_the_implementer_directly,
    { test: Some(red()) },
    |r| {
        must_match("result=fail:behaviour", &r.history, "expected fail:behaviour");
        must_not_match("MODE=REPLAN", &r.stdout, "attempt 1 already told the orchestrator to REPLAN");
        must_match("attempt 1", &r.stdout, "the block did not name attempt 1");
    }
);

gate_case!(a_red_test_that_survives_one_attempt_routes_to_replan, { test: Some(red()), gate_attempts: "1" }, |r| {
    must_match("result=fail:behaviour", &r.history, "expected fail:behaviour");
    must_match("MODE=REPLAN", &r.stdout, "attempt 2 did not route to REPLAN");
});

gate_case!(
    /// The cap: the fifth failure in a row hands the run to a human instead
    /// of looping again.
    the_fifth_failure_in_a_row_stops_the_loop_and_blocks_the_run_for_a_human,
    { test: Some(red()), gate_attempts: "4" },
    |r| {
        must_match("attempt=5 result=fail:behaviour", &r.history, "the fifth failure was not recorded as attempt 5");
        must_match("GATE FAILED 5 times", &r.reason(), "the fifth failure did not stop the loop");
        must_match("phase is now 'blocked'", &r.reason(), "the fifth failure did not hand the run to a human");
        must_not_match("MODE=REPLAN", &r.reason(), "the fifth failure looped back to REPLAN");
    }
);

gate_case!(
    an_extra_check_declared_class_behaviour_routes_like_a_red_test_not_like_lint,
    { extra_checks: vec![json!({"name": "fixture-behaviour-check", "field": "beh", "green": "(ok)", "hint": "fixture hint", "cmd": tool_json(&["exit=1"]), "class": "behaviour"})] },
    |r| {
        must_match("result=fail:behaviour", &r.history, "expected fail:behaviour");
        must_not_match("MODE=REPLAN", &r.stdout, "attempt 1 of a behaviour-classed check routed to REPLAN");
    }
);

#[test]
fn a_repo_whose_default_branch_is_not_main_is_still_judged() {
    for branch in ["master", "develop", "trunk"] {
        let r = with_gate(GateOpts {
            base_branch: branch,
            lint: Some(red()),
            test: Some(red()),
            ..Default::default()
        });
        assert!(
            r.blocked() && !r.history.contains("result=pass"),
            "a red tree read as a pass on {branch}: {}",
            r.history
        );
        must_match(
            r"files=1\b",
            &r.history,
            &format!("{branch}: the base is still unresolved"),
        );
    }
}

#[test]
fn a_report_path_naming_a_source_file_leaves_it_untouched() {
    let b = gate_fixture(&GateOpts {
        report: junit_report("a.ts"),
        specs: fix_specs(),
        ..Default::default()
    });
    run_gate(&b, json!({}), &[]);
    assert_eq!(
        read(b.repo.join("a.ts")),
        "export const a = 1;\n",
        "the gate deleted or changed a.ts, a tracked source file the report path named"
    );
}

#[test]
fn a_stop_while_a_subagent_is_still_running_judges_nothing() {
    for (name, tasks, pass) in [
        (
            "a stop while a subagent is still running judges nothing",
            json!([{"id": "a0123456789abcdef", "type": "subagent", "status": "running", "agent_type": "spec-flow:implementer"}]),
            false,
        ),
        (
            "a subagent that has finished does not hold the gate",
            json!([{"id": "a0123456789abcdef", "type": "subagent", "status": "completed"}]),
            true,
        ),
        (
            "a background shell does not hold the gate: it may never finish",
            json!([{"id": "b1", "type": "shell", "status": "running"}]),
            true,
        ),
    ] {
        let b = gate_fixture(&GateOpts::default());
        let r = run_gate(&b, json!({"background_tasks": tasks}), &[]);
        if pass {
            must_match(
                "result=pass",
                &r.history,
                &format!("{name}: it kept the gate from judging"),
            );
        } else {
            assert!(
                !r.blocked() && r.history.is_empty(),
                "{name}: the gate judged a commit while its implementer was still running: {} {}",
                r.stdout,
                r.history
            );
        }
    }
}

fn commit(b: &GateRepo, file: &str) {
    write(b.repo.join(file), "export const c = 1;\n");
    git(&b.git_dir, &["add", "--", file]);
    git(&b.git_dir, &["commit", "-qm", "the next milestone"]);
}

/// Stop fires more than once over one clean tree; waking on each would thrash.
#[test]
fn a_second_stop_on_the_same_commit_does_not_re_wake_the_model() {
    let b = gate_fixture(&GateOpts::default());
    assert!(
        run_gate(&b, json!({}), &[]).blocked(),
        "the first pass did not wake the orchestrator"
    );
    let second = run_gate(&b, json!({}), &[]);
    assert!(
        !second.blocked(),
        "a second stop with no new commit re-blocked: {}",
        second.stdout
    );
    assert!(
        !second.reason().is_empty(),
        "the second stop said nothing at all, reading like a hung run: {}",
        second.stdout
    );
}

/// Counted, not timed: a stopwatch on a loaded box flips either way.
#[test]
fn a_repeat_stop_on_a_commit_already_passed_does_not_run_the_suite_again() {
    let b = gate_fixture(&GateOpts {
        test: Some(tool_json(&["append=.claude/state/ran.log=x"])),
        ..Default::default()
    });
    run_gate(&b, json!({}), &[]);
    assert_eq!(
        read(state_path(&b.repo, "ran.log")).len(),
        1,
        "the suite ran a wrong number of times on the first stop"
    );
    let second = run_gate(&b, json!({}), &[]);
    assert!(
        !second.blocked() && !second.reason().is_empty(),
        "the repeat stop re-woke the model or said nothing: {}",
        second.stdout
    );
    assert_eq!(
        read(state_path(&b.repo, "ran.log")).len(),
        1,
        "the suite ran again on a stop whose only outcome was \"already reported\""
    );
}

#[test]
fn a_new_commit_is_judged_even_though_the_one_before_it_just_passed() {
    let b = gate_fixture(&GateOpts {
        test: Some(tool_json(&["append=.claude/state/ran.log=x"])),
        ..Default::default()
    });
    run_gate(&b, json!({}), &[]);
    commit(&b, "c.ts");
    let second = run_gate(&b, json!({}), &[]);
    assert_eq!(
        read(state_path(&b.repo, "ran.log")).len(),
        2,
        "the suite did not run for the new commit: {}",
        second.history
    );
    assert!(
        second.blocked(),
        "the new commit's pass did not wake the orchestrator"
    );
}

/// The report is what the gate's own suite writes: read as dirt, every other
/// milestone goes unjudged.
#[test]
fn the_report_the_suite_writes_does_not_read_as_a_dirty_tree_at_the_next_stop() {
    let b = gate_fixture(&GateOpts {
        report: junit_report("reports/junit.xml"),
        specs: fix_specs(),
        test: Some(suite_writing(JUNIT_PROVES)),
        ..Default::default()
    });
    must_match(
        "result=pass",
        &run_gate(&b, json!({}), &[]).history,
        "the first milestone was not judged",
    );
    commit(&b, "c.ts");
    let second = run_gate(&b, json!({}), &[]);
    must_not_match(
        "result=skip-dirty",
        &second.history,
        "the second milestone was skipped over the gate's own report",
    );
    must_match(
        "result=pass",
        &second.history,
        "the second milestone was not judged",
    );
}

/// The previous run's report names a test this run never ran.
#[test]
fn a_report_the_suite_no_longer_writes_is_not_proof() {
    let b = gate_fixture(&GateOpts {
        report: junit_report("reports/junit.xml"),
        specs: fix_specs(),
        test: Some(suite_writing(JUNIT_PROVES)),
        ..Default::default()
    });
    must_match(
        "result=pass",
        &run_gate(&b, json!({}), &[]).history,
        "the first milestone did not pass",
    );
    edit_contract(&b.repo, |c| c["verify"]["test"] = noop());
    git(&b.git_dir, &["add", "--", ".spec-flow/config.json"]);
    git(
        &b.git_dir,
        &["commit", "-qm", "the suite stops writing its report"],
    );
    let second = run_gate(&b, json!({}), &[]);
    must_not_match(
        "result=pass",
        second.history.lines().last().unwrap_or(""),
        "the gate passed on a report written by the PREVIOUS run",
    );
    assert!(
        second.rejected(),
        "the gate did not reject the milestone: {}",
        second.stdout
    );
    must_match(
        "does not exist",
        &second.failure_log,
        "the refusal does not say the report was never written",
    );
}

/// Two sessions in one repository share `.claude/state/` (ADR-017).
#[test]
fn a_phase_sealed_to_another_session_is_not_this_sessions_business() {
    let b = gate_fixture(&GateOpts {
        phase_owner: "session-a",
        lint: Some(red()),
        test: Some(red()),
        ..Default::default()
    });
    let r = run_gate(&b, json!({"session_id": "session-b"}), &[]);
    assert!(
        !r.blocked() && r.history.is_empty(),
        "session B judged session A's milestone: {} {}",
        r.stdout,
        r.history
    );
}

#[test]
fn the_session_that_owns_the_phase_is_still_judged() {
    let b = gate_fixture(&GateOpts {
        phase_owner: "session-a",
        lint: Some(red()),
        ..Default::default()
    });
    let r = run_gate(&b, json!({"session_id": "session-a"}), &[]);
    must_match(
        "result=fail:lint/trace",
        &r.history,
        "the owning session's red lint was not caught",
    );
}

/// engine= is a revision: a value two builds cannot both answer (ADR-018).
#[test]
fn engine_names_a_revision_and_moves_when_the_engine_does() {
    let b = gate_fixture(&GateOpts {
        engine_checkout: true,
        lint: Some(red()),
        ..Default::default()
    });
    run_gate(&b, json!({}), &[]);
    git(
        &b.engine,
        &["commit", "--allow-empty", "-qm", "a second engine revision"],
    );
    let second = run_gate(&b, json!({}), &[]);
    let engines: Vec<String> = Regex::new(r" engine=(\S+)")
        .unwrap()
        .captures_iter(&second.history)
        .map(|m| m[1].to_string())
        .collect();
    assert!(
        engines.len() == 2 && matches("^[0-9a-f]{7,40}$", &engines[0]) && engines[0] != engines[1],
        "want two different revisions, got {engines:?}"
    );
}

/// cc= is the Claude Code that ran the session, read off the transcript (ADR-041).
#[test]
fn gate_claude_code_version() {
    let lying = "CLAUDE_CODE_VERSION=2.1.42";
    let mut long: Vec<Value> = (0..400).map(|_| json!({"type": "user", "version": "2.1.293", "message": {"content": "y".repeat(1000)}})).collect();
    long.extend([
        json!({"type": "user", "version": "2.1.296"}),
        json!({"type": "ai-title"}),
    ]);
    let missing = std::env::temp_dir().join("spec-flow-no-such-transcript.jsonl");
    type Case<'a> = (&'a str, Option<Vec<Value>>, Option<&'a Path>, &'a str);
    let cases: Vec<Case> = vec![
        (
            "the last version the transcript carries, never CLAUDE_CODE_VERSION",
            Some(vec![
                json!({"type": "user", "version": "2.1.293"}),
                json!({"type": "assistant", "version": "2.1.296", "toolUseResult": {"version": "0.1.0"}}),
                json!({"type": "ai-title"}),
            ]),
            None,
            "2.1.296",
        ),
        ("? when the Stop names no transcript", None, None, "?"),
        (
            "? when the transcript cannot be read",
            None,
            Some(&missing),
            "?",
        ),
        (
            "? when no line of the transcript carries a version",
            Some(vec![json!({"type": "ai-title"}), json!({"type": "mode"})]),
            None,
            "?",
        ),
        (
            "the build a resumed session runs on now, past its older lines",
            Some(long),
            None,
            "2.1.296",
        ),
        (
            "read from a last line longer than the tail the gate reads first",
            Some(vec![
                json!({"type": "user", "version": "2.1.293"}),
                json!({"type": "user", "version": "2.1.296", "message": {"content": "x".repeat(600_000)}}),
            ]),
            None,
            "2.1.296",
        ),
    ];
    for (name, entries, path, want) in cases {
        let dir = temp_dir();
        let mut payload = json!({});
        if let Some(entries) = entries {
            let t = dir.join("session.jsonl");
            write(&t, &jsonl(&entries));
            payload["transcript_path"] = json!(t);
        } else if let Some(p) = path {
            payload["transcript_path"] = json!(p);
        }
        let b = gate_fixture(&GateOpts::default());
        let r = run_gate(&b, payload, &[lying]);
        must_match(
            &format!(" cc={} ", regex::escape(want)),
            &r.history,
            &format!("{name}: cc="),
        );
    }
}

/// `done` disarms every hook, so it is earned or refused: an engine defect in
/// the checks that judge it is no evidence it was earned.
#[test]
fn a_done_is_not_earned_by_an_engine_defect_with_no_gate_pass_on_head() {
    let engine = crashing_engine();
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    let r = Hook {
        engine: Some(engine.to_path_buf()),
        ..Default::default()
    }
    .run(
        "phase-guard",
        bash("printf 'done' > .claude/state/phase"),
        &repo,
    );
    expect_status(&r, 2, "an unearned done went through a crash");
    must_match(
        "gate has not passed",
        &r.stderr,
        "the checks after the crash did not run",
    );
}

#[test]
fn a_done_is_not_earned_by_an_engine_defect_and_with_the_gate_passed_the_checks_that_could_not_run_are_said()
 {
    let engine = crashing_engine();
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "pass");
    let r = Hook {
        engine: Some(engine.to_path_buf()),
        ..Default::default()
    }
    .run(
        "phase-guard",
        bash("printf 'done' > .claude/state/phase"),
        &repo,
    );
    expect_status(
        &r,
        2,
        "done went through with the project's checks never run",
    );
    must_match(
        "could not run",
        &r.stderr,
        "the refusal does not say the checks could not run",
    );
}

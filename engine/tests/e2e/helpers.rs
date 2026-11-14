//! The repositories a case runs in, and the assertions every file shares.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;

/// A file map, in the order written: later entries replace earlier ones.
pub type Files = Vec<(String, String)>;

/// `files! { "a.md" => text, ... }`
#[macro_export]
macro_rules! files {
    ($($k:expr => $v:expr),* $(,)?) => {
        vec![$(($k.to_string(), $v.to_string())),*] as $crate::helpers::Files
    };
}

/// A contract edit.
pub type Edit<'a> = Option<&'a dyn Fn(&mut Value)>;

pub fn smoke_contract(edit: Edit) -> String {
    let mut c = json!({
        "contract_version": 1,
        "verify": {
            "scope_globs": ["*.ts"],
            "lint": tool_json(&["exit=0"]),
            "lint_no_fix": tool_json(&["exit=0"]),
            "test": tool_json(&["exit=0"]),
            "test_name": "ftest",
            "lint_name": "flint",
            "lint_config_hint": "f.config",
        },
        "trace": {
            "specs_dir": "specs",
            "proof_dir": "tests",
            "proof_suffix": ".spec.ts",
            "executed_tests": tool_json(&["exit=0"]),
            "not_a_capability": [],
        },
        "extra_checks": [],
        "unscoped_denied": {
            "scripts": ["test", "lint"],
            "tools": ["eslint", "ftest"],
            "scoped_allowed": ["check"],
            "scoped_alternative": "npm run check",
            "scoped_examples": ["npm run check"],
        },
    });
    if let Some(edit) = edit {
        edit(&mut c);
    }
    c.to_string()
}

/// The contract and the phase under dir: what a run arms on.
pub fn write_run(dir: &Path, phase: &str, edit: Edit) {
    write(dir.join(".spec-flow/config.json"), &smoke_contract(edit));
    write(dir.join(".claude/state/phase"), phase);
}

/// `git init` and one commit on main, so a merge-base exists.
pub fn init_repo(dir: &Path, commit_phase: bool, commit: bool) {
    git_quiet(dir, &["init", "-q", "."]);
    git_quiet(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    git_quiet(dir, &["config", "user.email", "smoke@example.com"]);
    git_quiet(dir, &["config", "user.name", "smoke"]);
    git_quiet(dir, &["config", "core.autocrlf", "false"]);
    if commit {
        git_quiet(dir, &["commit", "-q", "--allow-empty", "-m", "baseline"]);
    }
    // The shape a repository the user did not write can arrive in (ADR-017).
    if commit_phase {
        git_quiet(dir, &["add", "-f", "--", ".claude/state/phase"]);
        git_quiet(
            dir,
            &["commit", "-q", "-m", "a phase this repository committed"],
        );
    }
}

/// The throwaway repository a case runs in.
#[derive(Default)]
pub struct RepoOpts<'a> {
    pub phase: &'a str,
    pub no_contract: bool,
    pub no_git: bool,
    pub commit_phase: bool,
    pub no_commit: bool,
    pub contract_edit: Edit<'a>,
}

pub fn make_repo(o: RepoOpts) -> Dir {
    let repo = temp_dir();
    let phase = if o.phase.is_empty() {
        "implement"
    } else {
        o.phase
    };
    std::fs::create_dir_all(repo.join("specflow")).unwrap();
    if o.no_contract {
        write(repo.join(".claude/state/phase"), phase);
    } else {
        write_run(&repo, phase, o.contract_edit);
    }
    if !o.no_git {
        init_repo(&repo, o.commit_phase, !o.no_commit);
    }
    repo
}

/// A repository in `phase`, with the default contract and one commit.
pub fn repo_in(phase: &str) -> Dir {
    make_repo(RepoOpts {
        phase,
        ..Default::default()
    })
}

pub fn state_path(repo: &Path, name: &str) -> PathBuf {
    repo.join(".claude").join("state").join(name)
}

pub fn phase_of(repo: &Path) -> String {
    read(state_path(repo, "phase"))
}

pub fn set_phase(repo: &Path, phase: &str) {
    write(state_path(repo, "phase"), phase);
}

pub fn counter_of(repo: &Path, name: &str) -> String {
    let v = read(state_path(repo, name)).trim().to_string();
    if v.is_empty() { "0".into() } else { v }
}

pub fn trace_text(repo: &Path) -> String {
    read(state_path(repo, "run-trace.log"))
}

/// Rewrites repo's contract through edit.
pub fn edit_contract(repo: &Path, edit: impl FnOnce(&mut Value)) {
    let path = repo.join(".spec-flow/config.json");
    let mut c: Value = serde_json::from_str(&read(&path)).unwrap();
    edit(&mut c);
    write(&path, &c.to_string());
}

#[track_caller]
pub fn expect_status(r: &Output, want: i32, why: &str) {
    assert_eq!(
        r.status, want,
        "{why}: exit {}, want {want}\nstdout: {}\nstderr: {}",
        r.status, r.stdout, r.stderr
    );
}

#[track_caller]
pub fn must_match(pattern: &str, text: &str, why: &str) {
    assert!(
        Regex::new(pattern).unwrap().is_match(text),
        "{why}: no {pattern:?} in:\n{text}"
    );
}

#[track_caller]
pub fn must_not_match(pattern: &str, text: &str, why: &str) {
    assert!(
        !Regex::new(pattern).unwrap().is_match(text),
        "{why}: {pattern:?} found in:\n{text}"
    );
}

pub fn matches(pattern: &str, text: &str) -> bool {
    Regex::new(pattern).unwrap().is_match(text)
}

/// A SubagentStop payload as Claude Code 2.1.283 delivers it.
pub fn subagent_stop(extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "SubagentStop", "session_id": "spawner-session", "agent_id": "a0123456789abcdef", "agent_type": "spec-flow:reviewer"});
    merge(&mut p, extra);
    p
}

/// extra's keys written over p's.
pub fn merge(p: &mut Value, extra: Value) {
    if let (Some(p), Value::Object(extra)) = (p.as_object_mut(), extra) {
        p.extend(extra);
    }
}

/// One spec-trace case over a repository built from files.
macro_rules! trace_case {
    ($(#[$doc:meta])* $name:ident, $files:expr, |$r:ident| $body:block) => {
        $(#[$doc])*
        #[test]
        fn $name() {
            let ($r, _dir) = trace_repo($files, &[]);
            let $r = &$r;
            $body
        }
    };
}

/// One spec-trace case over a branch: base on main, then commits on feat.
macro_rules! branch_case {
    ($(#[$doc:meta])* $name:ident, $base:expr, $commits:expr, $opts:expr, |$r:ident| $body:block) => {
        $(#[$doc])*
        #[test]
        fn $name() {
            let $r = trace_branch($base, &$commits, $opts);
            let $r = &$r;
            $body
        }
    };
}

// ---- spec-trace ------------------------------------------------------------
//
// spec-trace is what makes `specs/` authoritative: it binds a requirement id
// to the test that proves it, in both directions. Each case builds a
// repository from a file map, runs the real check against it, and asserts a
// problem is REPORTED — exit 1 and named — never merely survived: a parser
// that matches nothing looks exactly like a repository where everything is
// proven.

/// Opts a default file out of a case's repository.
pub const OMIT: &str = "\x00omit";

pub fn trace_config(edit: Option<&dyn Fn(&mut Value)>) -> String {
    let mut trace = json!({"specs_dir": "specs", "proof_dir": "tests", "proof_suffix": ".test.ts",
        "executed_tests": ran(&["tests/user.test.ts::REQ-USER-001 the user can do the thing"]), "report": null, "not_a_capability": ["README.md"]});
    if let Some(edit) = edit {
        edit(&mut trace);
    }
    serde_json::to_string_pretty(&json!({
        "contract_version": 1,
        "verify": {"scope_globs": ["*.ts"], "lint": noop(), "lint_no_fix": noop(), "test": noop(),
            "test_name": "fixture-test", "lint_name": "fixture-lint", "lint_config_hint": "fixture.config"},
        "trace": trace,
        "extra_checks": [],
        "unscoped_denied": {"scripts": [], "tools": [], "scoped_allowed": [], "scoped_alternative": "", "scoped_examples": []},
    }))
    .unwrap()
}

/// A command that does nothing and succeeds.
pub fn noop() -> Value {
    tool_json(&["exit=0"])
}

/// A proof source reporting exactly these lines as the tests that RAN.
pub fn ran(lines: &[&str]) -> Value {
    let ops: Vec<String> = lines.iter().map(|l| format!("out={l}")).collect();
    tool_json(&ops.iter().map(String::as_str).collect::<Vec<_>>())
}

/// The default contract whose report is these lines; none is a suite that
/// ran and reported nothing.
pub fn trace_contract(lines: &[&str]) -> String {
    let ran = ran(lines);
    trace_config(Some(&move |tr: &mut Value| {
        tr["executed_tests"] = ran.clone()
    }))
}

/// The proof source replaced by a report FILE, or by nothing.
pub fn report_contract(report: Option<Value>) -> String {
    trace_config(Some(&move |tr: &mut Value| {
        tr.as_object_mut().unwrap().remove("executed_tests");
        if let Some(r) = &report {
            tr["report"] = r.clone();
        }
    }))
}

pub fn cap_spec(id: &str, title: &str, scope: &str) -> String {
    let id = if id.is_empty() { "REQ-USER-001" } else { id };
    let title = if title.is_empty() {
        "the user can do the thing"
    } else {
        title
    };
    let scope = if scope.is_empty() {
        "modules/user"
    } else {
        scope
    };
    format!(
        "<!-- spec-scope: {scope} -->\n\n# User\n\n### {id} — {title}\n\nThe system does the thing.\n"
    )
}

pub fn user_spec() -> String {
    cap_spec("", "", "")
}

pub const JUNIT_RAN: &str = r#"<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="fixture" tests="1" failures="0">
    <testsuite name="tests/user.test.ts" tests="1" failures="0">
        <testcase classname="tests/user.test.ts" name="REQ-USER-001 the user can do the thing" time="0.001">
        </testcase>
    </testsuite>
</testsuites>
"#;

pub const JUNIT_SKIPPED: &str = r#"<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="fixture" tests="1" failures="0">
    <testsuite name="tests/user.test.ts" tests="1" failures="0" skipped="1">
        <testcase classname="tests/user.test.ts" name="REQ-USER-001 the user can do the thing" time="0">
            <skipped/>
        </testcase>
    </testsuite>
</testsuites>
"#;

/// Asks for the milestone field, and reports nothing.
pub fn skills_required() -> String {
    trace_config(Some(&|tr: &mut Value| {
        tr["require_skills_field"] = json!(true);
        tr["executed_tests"] = ran(&[]);
    }))
}

pub fn write_files(dir: &Path, files: &Files) {
    for (rel, content) in files {
        if content != OMIT {
            write(dir.join(rel), content);
        }
    }
}

/// The real spec-trace, run against project.
pub fn run_trace(project: &Path, args: &[&str]) -> Output {
    let mut all = vec!["trace"];
    all.extend(args);
    run(
        &std::env::temp_dir(),
        &[format!("CLAUDE_PROJECT_DIR={}", project.display())],
        "",
        &cli_argv(engine_dir(), &all),
    )
}

/// The default contract followed by files, last one winning.
fn with_contract(files: &Files) -> Files {
    let mut all: BTreeMap<String, String> = BTreeMap::new();
    all.insert(".spec-flow/config.json".into(), trace_config(None));
    all.extend(files.iter().cloned());
    all.into_iter().collect()
}

/// A repository built from files, the contract merged in unless the case
/// wrote its own, and spec-trace run there.
pub fn trace_repo(files: Files, args: &[&str]) -> (Output, Dir) {
    let dir = temp_dir();
    write_files(&dir, &with_contract(&files));
    (run_trace(&dir, args), dir)
}

#[derive(Default)]
pub struct BranchOpts<'a> {
    pub under: &'a str,
    pub state: Files,
    pub dirs: Vec<&'a str>,
    pub uncommitted: Files,
}

/// Commits base on main, then each map of commits in turn on feat off it,
/// where spec-trace runs: the base resolves to main. After the commits:
/// uncommitted written over the tree, dirs left as empty folders and state
/// under `.claude/state/`, as a run leaves it.
pub fn trace_branch(base: Files, commits: &[Files], o: BranchOpts) -> Output {
    let repo = temp_dir();
    let project = if o.under.is_empty() {
        repo.to_path_buf()
    } else {
        repo.join(o.under)
    };
    git(&repo, &["init", "-q", "."]);
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(&repo, &["config", "core.autocrlf", "false"]);
    write_files(&project, &with_contract(&base));
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-q", "-m", "base"]);
    git(&repo, &["checkout", "-q", "-b", "feat"]);
    for (i, c) in commits.iter().enumerate() {
        for (rel, content) in c {
            if content == OMIT {
                let _ = std::fs::remove_file(project.join(rel));
            }
        }
        write_files(&project, c);
        git(&repo, &["add", "-A"]);
        git(
            &repo,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                &format!("branch {i}"),
            ],
        );
    }
    write_files(&project, &o.uncommitted);
    for d in &o.dirs {
        std::fs::create_dir_all(project.join(d)).unwrap();
    }
    for (name, text) in &o.state {
        write(state_path(&project, name), text);
    }
    run_trace(&project, &[])
}

pub fn shipped_spec(deltas: &[&str]) -> String {
    let mut s =
        "# Spec — x\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n".to_string();
    for d in deltas {
        s += &format!("- {d}\n");
    }
    s
}

pub fn shipped_with(section: &str) -> String {
    format!("# Spec — x\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n{section}")
}

pub fn two_reqs() -> String {
    user_spec() + "\n### REQ-USER-002 — the user can do another thing\n\nThe system does it.\n"
}

/// A branch that shipped run one's change, then started run two's.
pub fn two_runs() -> Vec<Files> {
    vec![
        files! {"specflow/archive/run-one/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"])},
        files! {"specflow/run-two/spec.md" => "# Spec — run two\n\n## Requirement deltas\n- ADDED REQ-USER-003 — the user can import data\n", "specflow/run-two/proposal.md" => "# Proposal\n\nWhy.\n"},
    ]
}

/// Run one's change, then its fold, whose ADDED id never reached specs/.
pub fn own_fold() -> Vec<Files> {
    vec![
        files! {"specflow/run-one/spec.md" => "# Spec — run one\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the user can export their data\n", "specflow/run-one/proposal.md" => "# Proposal\n\nWhy.\n"},
        files! {"specflow/run-one/spec.md" => OMIT, "specflow/run-one/proposal.md" => OMIT,
        "specflow/archive/run-one/spec.md" => shipped_spec(&["ADDED REQ-USER-002 — the user can export their data"]), "specflow/archive/run-one/proposal.md" => "# Proposal\n\nWhy.\n"},
    ]
}

#[track_caller]
pub fn holds_own_fold(r: &Output) {
    assert!(
        r.status != 0
            && matches(
                r"(?m)^ {2}- REQ-USER-002 is ADDED by specflow/archive/run-one",
                &r.out()
            )
            && !matches("held from the fold's gate on", &r.out()),
        "the fold's gate passed over the run's own drift: {}",
        r.out()
    );
}

#[track_caller]
pub fn fails_with(r: &Output, pattern: &str, why: &str) {
    assert!(r.status != 0, "{why}: it passed: {}", r.out());
    must_match(pattern, &r.out(), why);
}

#[track_caller]
pub fn passes(r: &Output, why: &str) {
    assert!(r.status == 0, "{why}: {}", r.out());
}

#[track_caller]
pub fn want_all(out: &str, texts: &[&str]) {
    for s in texts {
        assert!(
            out.contains(s),
            "expected the report to contain {s:?}.\n--- report ---\n{out}"
        );
    }
}

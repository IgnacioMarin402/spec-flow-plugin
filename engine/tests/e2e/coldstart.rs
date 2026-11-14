//! Cold start: a Node repository, from nothing to a green `spec-flow check`,
//! through the route the README documents. Every other test exercises a
//! piece; this is the claim a reader forms from the front page, and the only
//! check that fails when adoption breaks for a reason no single piece owns.
//! Nothing is installed and nothing is hand-written: the suite is `node
//! --test`, whose JUnit report is written by the runner itself.

use std::path::Path;

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;
use crate::init::{argv, have_node, read_written};

/// `<engine>/bin/spec-flow <args>`, run from dir with no CLAUDE_PROJECT_DIR:
/// a real adopter in a terminal has none.
pub fn documented(dir: &Path, args: &[&str]) -> Output {
    run(
        dir,
        &["CLAUDE_PROJECT_DIR="],
        "",
        &launch(engine_dir(), args),
    )
}

/// An ordinary Node repository, committed on main; None where there is no node.
pub fn node_repo(scripts: Value, files: &Files) -> Option<Dir> {
    if !have_node() {
        eprintln!("skipped: a Node repository's own suite needs node");
        return None;
    }
    let repo = temp_dir();
    write(
        repo.join("package.json"),
        &(json!({"name": "cold-start", "version": "1.0.0", "type": "module", "scripts": scripts})
            .to_string()
            + "\n"),
    );
    write_files(&repo, files);
    git(&repo, &["init", "-q", "."]);
    git(&repo, &["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "baseline"]);
    Some(repo)
}

pub fn edit_json(path: &Path, edit: impl FnOnce(&mut Value)) {
    let mut m: Value =
        serde_json::from_str(&read(path)).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    edit(&mut m);
    write(path, &(m.to_string() + "\n"));
}

/// Commits what is there, then a change on a feature branch.
pub fn branch_off(repo: &Path, file: &str, text: &str) {
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-qm", "adopt spec-flow"]);
    git(repo, &["checkout", "-qb", "feature"]);
    write(repo.join(file), text);
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-qm", "work"]);
}

fn missing_lines(out: &str) -> Vec<&str> {
    out.lines()
        .filter(|l| l.trim().starts_with("MISSING"))
        .collect()
}

#[test]
fn cold_start() {
    let mut files = files! {
        // A real linter, installing nothing: `node --check` fails on a syntax error.
        "lint.js" => "import { execFileSync } from 'node:child_process';\nfor (const file of process.argv.slice(2)) execFileSync(process.execPath, ['--check', file]);\n",
        "lib/login.js" => "export const login = (user, password) => password === \"right\";\n",
        "test/auth.test.js" => "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { login } from '../lib/login.js';\n\ntest('REQ-AUTH-001 a bad password is rejected', () => {\n  assert.equal(login('u', 'wrong'), false);\n});\n",
    };
    // Enough files for the scope globs to be a reading rather than a guess.
    for name in ["session", "token", "user", "audit"] {
        files.push((
            format!("lib/{name}.js"),
            format!("export const {name} = () => '{name}';\n"),
        ));
    }
    // Through an interpreter on purpose: `node` names no runner, so both the
    // runner name and the reporter flag must be read from the argv.
    let Some(repo) = node_repo(
        json!({"test": "node --test", "lint": "node lint.js"}),
        &files,
    ) else {
        return;
    };

    let init = documented(&repo, &["init"]);
    let path = repo.join(".spec-flow/config.json");
    assert!(exists(&path), "init wrote no contract:\n{}", init.out());
    let w = read_written(&repo);
    let report_path = w["trace"]["report"]["path"]
        .as_str()
        .unwrap_or("")
        .to_string();
    assert!(
        w["trace"]["report"]["format"]
            .as_str()
            .is_some_and(|f| !f.is_empty())
            && !report_path.is_empty(),
        "init did not declare a readable report source: {}",
        w["trace"]
    );
    assert!(
        argv(&w["verify"]["test"])
            .iter()
            .any(|t| t.contains(&report_path)),
        "verify.test does not write the report the contract points at: {}",
        w["verify"]["test"]
    );
    assert!(
        !exists(repo.join(".spec-flow/tests-that-ran.mjs")),
        "a translator stub was written though nothing points at it"
    );
    // Counted so that growth in adoption cost is visible rather than absorbed.
    let m = missing_lines(&init.out())
        .into_iter()
        .map(String::from)
        .collect::<Vec<_>>();
    assert!(
        m.len() <= 2,
        "a Node repo is now asked for {} fields:\n{}",
        m.len(),
        m.join("\n")
    );
    assert_eq!(w["verify"]["test_name"], "node --test");

    // The adopter fills in only what init NAMED.
    edit_json(&path, |c| {
        c["verify"]["scope_globs"] = json!(["*.js"]);
        c["verify"]["lint_name"] = json!("fixture-lint");
        c["verify"]["lint_config_hint"] = json!("package.json");
    });
    write(
        repo.join("specs/auth.md"),
        "<!-- spec-scope: lib -->\n\n# Auth\n\n### REQ-AUTH-001 — a bad password is rejected\n\nThe system rejects a login whose password does not match.\n",
    );
    branch_off(
        &repo,
        "lib/login.js",
        "export const login = (user, password) => password === \"right\"; // changed\n",
    );

    let green = documented(&repo, &["check"]);
    assert_eq!(
        green.status,
        0,
        "spec-flow check failed on a repo init configured:\n{}",
        green.out()
    );
    must_match(
        "every one proven by a test",
        &green.out(),
        "spec-trace did not report the requirement as proven",
    );
    assert!(
        exists(repo.join(&report_path)),
        "no report at {report_path} after the suite ran — the appended flag does not produce one"
    );

    // From a subdirectory the contract is not where the engine looks (ADR-027).
    let inside = documented(&repo.join("lib"), &["check"]);
    assert_ne!(
        inside.status,
        0,
        "the check went green from lib/, judging a subdirectory as the repository:\n{}",
        inside.out()
    );
    must_match(
        "repository root",
        &inside.out(),
        "the refusal from lib/ does not name the root",
    );

    // The test still exists and names the requirement; the runner reports it skipped.
    write(
        repo.join("test/auth.test.js"),
        "import { test } from 'node:test';\n\ntest('REQ-AUTH-001 a bad password is rejected', { skip: 'wip' }, () => {});\n",
    );
    let skipped = documented(&repo, &["check"]);
    assert_ne!(
        skipped.status,
        0,
        "a requirement stayed proven after its test stopped running:\n{}",
        skipped.out()
    );
    must_match(
        "REQ-AUTH-001",
        &skipped.out(),
        "the failure did not name the requirement whose proof disappeared",
    );
}

/// The setup skill is prose a model acts on: the route it prescribes, the
/// buckets it tells the model to read and the fields it tells it to fill are
/// claims about this engine that go stale silently. ADR-006 says why the
/// runner knowledge is in the skill; this binds what remains to the engine.
/// What CI cannot check — whether a model picks the right flag — is
/// survivable only because a wrong flag fails LOUDLY, which the last part
/// holds.
#[test]
fn skill_contract() {
    let skill = read(SETUP.repo_root.join("skills/spec-flow-setup/SKILL.md"));
    assert!(
        !skill.is_empty(),
        "skills/spec-flow-setup/SKILL.md does not exist"
    );
    let mut wrong = Vec::new();
    for step in ["bin/spec-flow init", "bin/spec-flow check"] {
        if !skill.contains(step) {
            wrong.push(format!(
                "the skill no longer tells anyone to run {step}, so its procedure has a hole there"
            ));
        }
    }
    // A repository producing all three buckets: something detected, a runner
    // that cannot be named, and no report flag.
    let Some(repo) = node_repo(
        json!({"test": "node --test", "lint": "node lint.js"}),
        &files! {"lint.js" => "process.exit(0);\n", "lib/a.js" => "export const a = 1;\n", "test/a.test.js" => "import { test } from 'node:test';\ntest('REQ-CORE-001 holds', () => {});\n"},
    ) else {
        return;
    };
    let init = documented(&repo, &["init"]);
    for label in ["detected", "REVIEW", "MISSING"] {
        if !matches(&format!(r"(?m)^\s*{label}\b"), &init.out()) {
            wrong.push(format!(
                "init printed no {label} line on a repo built to produce all three:\n{}",
                init.out()
            ));
        }
        if !skill.contains(label) {
            wrong.push(format!(
                "init prints {label} and the skill never mentions it, so that bucket has no reader"
            ));
        }
    }
    // A dotted field in the skill is an instruction to write that key; a typo
    // ships a config the loader ignores and the model reports as configured.
    let path = repo.join(".spec-flow/config.json");
    let written: Value = serde_json::from_str(&read(&path))
        .expect("init wrote no contract to check the skill against");
    let named: std::collections::BTreeSet<String> =
        Regex::new(r"`((?:verify|trace)\.[a-z_]+(?:\.[a-z_]+)*)`")
            .unwrap()
            .captures_iter(&skill)
            .map(|m| m[1].to_string())
            .collect();
    if named.is_empty() {
        wrong.push("the skill names no `verify.*` or `trace.*` field, so its step 2 tells the model nothing specific".into());
    }
    // trace.executed_tests is the documented alternative to trace.report.
    for field in named.iter().filter(|f| *f != "trace.executed_tests") {
        let node = field.split('.').fold(&written, |n, k| &n[k]);
        if node.is_null() {
            wrong.push(format!(
                "the skill tells the model to set {field}, which is not in the contract init writes"
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    // The flag stripped back out: a test command that runs clean and writes
    // nothing, as a wrong reporter flag leaves it. It must not pass quietly.
    edit_json(&path, |c| {
        let v = &mut c["verify"];
        v["scope_globs"] = json!(["*.js"]);
        v["test_name"] = json!("fixture-runner");
        v["lint_name"] = json!("fixture-linter");
        v["lint_config_hint"] = json!("fixture.config");
        v["test"] = json!(["node", "--test"]);
    });
    write(
        repo.join("specs/core.md"),
        "<!-- spec-scope: lib -->\n\n# Core\n\n### REQ-CORE-001 — it holds\n\nThe system holds.\n",
    );
    branch_off(&repo, "lib/a.js", "export const a = 2;\n");
    let red = documented(&repo, &["check"]);
    assert_ne!(
        red.status,
        0,
        "the route went green with a declared requirement and no report on disk:\n{}",
        red.out()
    );
    must_match(
        r"reporter flag|does not exist|trace\.report",
        &red.out(),
        "the refusal does not name the report, so nothing sends the model to its flag",
    );
    must_not_match(
        "has no test",
        &red.out(),
        "a missing report read as a requirement with no test",
    );
}

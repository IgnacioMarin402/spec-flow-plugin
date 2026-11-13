//! Every command a terminal, CI or the orchestrator runs: `spec-flow
//! <command>`. A terminal and CI have neither `${CLAUDE_PLUGIN_ROOT}` nor
//! Claude Code, so each command resolves the repository it judges itself.

use std::path::Path;

use crate::repo::{contract, engine, gitscope, proc, unscoped};
use crate::spec::trace;
use crate::state;

pub type Command = fn(&[String]) -> i32;

/// `spec-flow <name>`, by name, sorted.
pub const COMMANDS: [(&str, Command); 3] =
    [("check", check), ("config", config), ("trace", trace_cmd)];

/// `spec-flow trace [--list]`.
fn trace_cmd(args: &[String]) -> i32 {
    let list = args.iter().any(|a| a == "--list");
    trace::run(
        &state::project_dir(),
        list,
        &mut std::io::stdout(),
        &mut std::io::stderr(),
    )
}

/// `spec-flow config`: the contract as every hook reads it, or why it does
/// not load.
fn config(_: &[String]) -> i32 {
    let root = state::project_dir();
    let cfg = match contract::load(&root) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("spec-flow config: {e}");
            return 1;
        }
    };
    let mut checks: Vec<&str> = cfg.extra_checks.iter().map(|c| c.name.as_str()).collect();
    if checks.is_empty() {
        checks.push("(none)");
    }
    println!(
        "spec-flow config: OK — contract v{}, read from {} ({}).",
        cfg.version,
        cfg.source,
        root.display()
    );
    println!(
        "  lint:  {}\n  test:  {}\n  scope: {}\n  extra checks: {}",
        cfg.verify.lint.join(" "),
        cfg.verify.test.join(" "),
        cfg.verify.scope_globs.join(", "),
        checks.join(", ")
    );
    0
}

fn inherit(root: &Path, argv: &[String]) -> i32 {
    let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
    proc::inherit(root, &argv)
}

/// `spec-flow check [--no-fix]`: lint over the files this branch changed,
/// the whole suite, then the unscoped checks — in the gate's order, so "same
/// files, same commands, same result" holds by construction.
fn check(args: &[String]) -> i32 {
    let root = state::project_dir();
    let fix = !args.iter().any(|a| a == "--no-fix");
    if let Err(e) = gitscope::assert_repo_root(&root) {
        eprintln!("spec-flow check: {}", e.msg);
        return 1;
    }
    let cfg = match contract::load(&root) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("spec-flow check: {e}"); // unguarded: a version it cannot read stops it
            return 1;
        }
    };
    let base = match gitscope::resolve_base(&root, Some(&cfg)) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("spec-flow check: {e}");
            return 1;
        }
    };
    let v = &cfg.verify;
    let files = gitscope::changed_files(&root, &v.scope_globs, &base);
    let mut lint_rc = 0;
    if files.is_empty() {
        let head = proc::git(&root, &["rev-parse", "HEAD"]);
        if head.ok() && head.stdout.trim() == base {
            println!(
                "No changed files in scope: the base resolved to HEAD itself, so the diff is empty by construction — {} is not sitting this out because nothing changed. Work on a branch off your base, or declare verify.base_ref in .spec-flow/config.json. The gate blocks on this.",
                v.lint_name
            );
        } else if gitscope::scope_matches_nothing(&root, &v.scope_globs) {
            println!(
                "No changed files in scope — and verify.scope_globs ({}) matches no file this repository tracks at all, so {} can never run on any commit. These are git pathspecs: `*` already crosses `/`, so \"*.ts\" covers every depth and \"**/*.ts\" skips the repo root. Fix \"scope_globs\" under \"verify\" in .spec-flow/config.json, or re-run `spec-flow init`. The gate blocks on this.",
                v.scope_globs.join(", "),
                v.lint_name
            );
        } else {
            println!("No changed files in scope vs {base} — skipping lint.");
        }
    } else {
        println!("Checking {} changed file(s) vs {base}:", files.len());
        for f in &files {
            println!("  {f}");
        }
        println!();
        let (lint, label) = if fix {
            (&v.lint, "")
        } else {
            (&v.lint_no_fix, "(no fix)")
        };
        println!("--- {} {label} ---", v.lint_name);
        // With no linter the files appended would be the command itself.
        if lint.is_empty() {
            println!(
                "verify.lint_no_fix is not declared in .spec-flow/config.json, so --no-fix has no report-only linter to run. Declare it, or run `spec-flow check` without --no-fix."
            );
            lint_rc = 1;
        } else {
            let argv: Vec<String> = lint.iter().chain(&files).cloned().collect();
            lint_rc = inherit(&root, &argv);
        }
        println!();
    }
    println!("--- {} ---", v.test_name);
    contract::prepare_report(&root, &cfg);
    let test_rc = if v.test.is_empty() {
        1
    } else {
        inherit(&root, &v.test)
    };
    println!();
    let result = unscoped::run(&root, &cfg);
    for c in &result.checks {
        println!("--- {} ---\n{}\n", c.check.name, c.out);
    }
    println!("engine {}", engine::revision(&engine::root()));
    if lint_rc == 0 && test_rc == 0 && result.all_pass {
        println!(
            "OK — lint, tests and the unscoped checks pass ({}).",
            unscoped::summary(&result)
        );
        return 0;
    }
    println!(
        "FAILED — lint rc={lint_rc}, tests rc={test_rc}, {}",
        unscoped::summary(&result)
    );
    1
}

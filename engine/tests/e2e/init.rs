//! What init writes is held to the claim it makes: that it VALIDATES, through
//! the same reader every hook uses, so a contract change turns this red
//! rather than reaching an adopter whose gate will not start. Every case
//! builds a throwaway repository, runs the real CLI against it, and reads
//! back the file.

use std::path::Path;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::harness::*;
use crate::helpers::*;

#[derive(Clone)]
pub struct Bin {
    pub name: &'static str,
    pub pkg: &'static str,
    pub entry: &'static str,
}

const fn bin(name: &'static str, pkg: &'static str, entry: &'static str) -> Bin {
    Bin { name, pkg, entry }
}

/// What npm publishes for the host platform: on POSIX `node_modules/.bin/x`
/// is a symlink to the package's entrypoint; on Windows it is a `#!/bin/sh`
/// script beside `x.cmd`, which node cannot parse.
pub fn install_bin(dir: &Path, b: &Bin) {
    write(
        dir.join("node_modules").join(b.pkg).join(b.entry),
        "process.exit(0);\n",
    );
    write(
        dir.join("node_modules").join(b.pkg).join("package.json"),
        &json!({"name": b.pkg, "version": "1.0.0", "bin": {b.name: format!("./{}", b.entry)}})
            .to_string(),
    );
    let shim = dir.join("node_modules/.bin").join(b.name);
    std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
    let rel = format!("../{}/{}", b.pkg, b.entry);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&rel, &shim).unwrap();
    #[cfg(windows)]
    {
        // The `$basedir/../<pkg>/<entry>` token is the only part a resolver
        // reads; the rest is npm's, so a resolver cannot pass on a shape npm
        // never writes.
        write(
            &shim,
            &format!(
                "#!/bin/sh\nbasedir=$(dirname \"$(echo \"$0\" | sed -e 's,\\\\,/,g')\")\n\nif [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \"$basedir/{rel}\" \"$@\"\nelse\n  exec node  \"$basedir/{rel}\" \"$@\"\nfi\n"
            ),
        );
        write(
            shim.with_extension("cmd"),
            &format!(
                "@ECHO off\r\nnode  \"%~dp0\\{}\" %*\r\n",
                rel.replace('/', "\\")
            ),
        );
    }
}

#[derive(Clone, Default)]
pub struct InitOpts {
    pub scripts: Vec<(&'static str, &'static str)>,
    pub files: Files,
    /// Empty placeholders: enough for init to PREFER the local path.
    pub bins: Vec<&'static str>,
    pub installed: Vec<Bin>,
    pub gitignore: Option<&'static str>,
    pub existing: Option<&'static str>,
    pub no_git: bool,
    pub no_commit: bool,
    pub no_pkg_json: bool,
    /// package.json's own extra keys.
    pub pkg_extra: Option<Value>,
}

fn scripts_json(scripts: &[(&str, &str)]) -> Value {
    Value::Object(
        scripts
            .iter()
            .map(|(k, v)| (k.to_string(), json!(v)))
            .collect::<Map<_, _>>(),
    )
}

pub fn init_repo2(o: &InitOpts) -> Dir {
    let dir = temp_dir();
    let mut pkg = json!({"name": "fixture", "scripts": scripts_json(&o.scripts)});
    if let Some(extra) = &o.pkg_extra {
        merge(&mut pkg, extra.clone());
    }
    write(dir.join("package.json"), &pkg.to_string());
    write_files(&dir, &o.files);
    for b in &o.bins {
        write(dir.join("node_modules/.bin").join(b), "");
    }
    for b in &o.installed {
        install_bin(&dir, b);
    }
    if let Some(g) = o.gitignore {
        write(dir.join(".gitignore"), g);
    }
    if let Some(e) = o.existing {
        write(dir.join(".spec-flow/config.json"), e);
    }
    // A real repository with a real base branch: scope is a merge-base diff.
    if !o.no_git {
        git(&dir, &["init", "-q", "."]);
        git(&dir, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        if !o.no_commit {
            git(&dir, &["add", "-A"]);
            git(&dir, &["commit", "-qm", "baseline"]);
        }
    }
    if o.no_pkg_json {
        std::fs::remove_file(dir.join("package.json")).unwrap();
    }
    dir
}

pub fn run_init(dir: &Path, args: &[&str]) -> Output {
    let mut all = vec!["init"];
    all.extend(args);
    run(
        dir,
        &[format!("CLAUDE_PROJECT_DIR={}", dir.display())],
        "",
        &cli_argv(engine_dir(), &all),
    )
}

/// The contract init wrote.
pub fn read_written(dir: &Path) -> Value {
    let text = read(dir.join(".spec-flow/config.json"));
    serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("the contract does not parse: {e}\n{text}"))
}

pub fn argv(v: &Value) -> Vec<String> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a.as_str().map(String::from))
        .collect()
}

fn joined(v: &Value) -> String {
    argv(v).join(" ")
}

/// Validates dir's contract through the reader every hook uses.
fn loads_through_the_engine(dir: &Path) -> Result<(), String> {
    let r = run(
        dir,
        &[format!("CLAUDE_PROJECT_DIR={}", dir.display())],
        "",
        &cli_argv(engine_dir(), &["config"]),
    );
    if r.status == 0 { Ok(()) } else { Err(r.out()) }
}

pub fn have_node() -> bool {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

fn missing_lines(out: &str) -> Vec<&str> {
    out.lines()
        .filter(|l| l.trim().starts_with("MISSING"))
        .collect()
}

pub fn has_token(argv: &[String], s: &str) -> bool {
    argv.iter().any(|a| a == s)
}

const ESLINT: &str = "node node_modules/eslint/bin/eslint.js";

/// A repository with everything discoverable: scripts, local bins, a lint
/// config, tests in their own directory.
pub fn complete() -> InitOpts {
    InitOpts {
        scripts: vec![
            ("test", "vitest run"),
            ("lint", "eslint ."),
            ("lint:fix", "eslint . --fix"),
        ],
        installed: vec![
            bin("eslint", "eslint", "bin/eslint.js"),
            bin("vitest", "vitest", "dist/cli.js"),
        ],
        files: files! {"eslint.config.js" => "", "lib/a.ts" => "export const a = 1;\n", "lib/b.ts" => "export const b = 2;\n", "lib/c.ts" => "export const c = 3;\n",
        "test/a.test.ts" => "it(\"a\", () => {});\n", "test/b.test.ts" => "it(\"b\", () => {});\n"},
        ..Default::default()
    }
}

fn with_scripts(scripts: &[(&'static str, &'static str)]) -> InitOpts {
    InitOpts {
        scripts: scripts.to_vec(),
        ..complete()
    }
}

/// One init case: the repository the options describe, handed to the body.
macro_rules! init_case {
    ($(#[$doc:meta])* $name:ident, $opts:expr, |$dir:ident| $body:block) => {
        $(#[$doc])*
        #[test]
        fn $name() {
            let $dir = init_repo2(&$opts);
            let $dir: &Path = &$dir;
            $body
        }
    };
}

init_case!(
    /// A fully discoverable repository gets a contract with no field left to
    /// write; and init must not present an INFERENCE as a reading.
    init_finishes_with_no_field_left_to_write_and_calls_the_inferred_path_an_inference,
    complete(),
    |dir| {
        let res = run_init(dir, &[]);
        assert_eq!(res.status, 0, "init refused to finish a repo it could read completely: {}", res.stdout);
        let m = missing_lines(&res.stdout);
        assert!(m.is_empty(), "a fully discoverable repo still has fields the adopter must supply:\n{}", m.join("\n"));
        let reviews = Regex::new(r"(?m)^\s*REVIEW\s+(trace\.report|verify\.test)\b").unwrap().find_iter(&res.stdout).count();
        assert_eq!(reviews, 1, "the report source was not flagged for review, so an inference reads as a reading: {}", res.stdout);
        let w = read_written(dir);
        let report = &w["trace"]["report"];
        let path = report["path"].as_str().unwrap_or("");
        assert!(report["format"] == "junit" && !path.is_empty(), "the contract does not declare a readable report source: {report}");
        assert!(argv(&w["verify"]["test"]).iter().any(|t| t.contains(path)), "init said it appended a reporter flag and verify.test does not name {path}: {}", w["verify"]["test"]);
        // A file nothing references is a file nobody maintains.
        assert!(!exists(dir.join(".spec-flow/tests-that-ran.mjs")), "a translator stub was written though the contract points at a report file");
        assert!(w["trace"].get("executed_tests").is_none_or(Value::is_null), "init declared both proof sources, which the contract rejects");
        if let Err(e) = loads_through_the_engine(dir) {
            panic!("the contract init wrote is one the hooks' own reader rejects: {e}");
        }
    }
);

init_case!(
    /// A guard: a fresh stub reports nothing, so a stub that exits 0 would
    /// turn every requirement unproven with no edit to blame.
    the_translator_escape_hatch_is_still_there_one_flag_away_and_still_refuses_until_finished,
    complete(),
    |dir| {
        if !have_node() {
            eprintln!("skipped: needs node");
            return;
        }
        run_init(dir, &["--translator"]);
        let translator = dir.join(".spec-flow/tests-that-ran.mjs");
        assert!(exists(&translator), "a repo whose runner has no standard report has no way to declare what ran");
        let stub = run(dir, &[] as &[&str], "", &["node".to_string(), translator.to_string_lossy().into_owned()]);
        assert_ne!(stub.status, 0, "an unfinished translator exited 0");
        must_match("tests-that-ran", &stub.out(), "the stub's refusal does not name itself");
    }
);

init_case!(
    re_running_init_does_not_overwrite_a_translator_someone_finished,
    complete(),
    |dir| {
        run_init(dir, &["--translator"]);
        let translator = dir.join(".spec-flow/tests-that-ran.mjs");
        let mine = "console.log(\"tests/a.test.ts::REQ-USER-001 mine\");\n";
        write(&translator, mine);
        run_init(dir, &["--force", "--translator"]);
        assert_eq!(
            read(&translator),
            mine,
            "a finished translator was replaced by a fresh stub"
        );
    }
);

init_case!(
    it_reads_the_runner_and_linter_out_of_the_repos_own_scripts,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        let test = argv(&w["verify"]["test"]);
        assert!(
            w["verify"]["test_name"] == "vitest"
                && test.join(" ").contains("vitest")
                && has_token(&test, "run"),
            "test: {test:?} named {}",
            w["verify"]["test_name"]
        );
        assert_eq!(w["verify"]["lint_name"], "eslint");
        assert_ne!(
            joined(&w["verify"]["lint"]),
            joined(&w["verify"]["lint_no_fix"]),
            "lint and lint_no_fix are identical though the repo declares an autofix script"
        );
    }
);

init_case!(
    it_prefers_the_locally_installed_binary_over_a_bare_command_name,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let test = argv(&read_written(dir)["verify"]["test"]);
        assert!(
            test.len() >= 2 && test[0] == "node" && test[1].starts_with("node_modules/"),
            "verify.test does not point at the local install: {test:?}"
        );
    }
);

init_case!(
    /// A native binary has no entrypoint to name: the bare name still
    /// resolves through PATH the way the repo's own script does.
    a_local_bin_with_no_javascript_behind_it_falls_back_to_the_bare_name,
    InitOpts { installed: vec![], bins: vec!["vitest", "eslint"], ..complete() },
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        let (test, lint) = (argv(&w["verify"]["test"]), argv(&w["verify"]["lint"]));
        assert!(test.first().is_some_and(|t| t == "vitest") && lint.first().is_some_and(|l| l == "eslint"), "expected the bare names, got test {test:?} lint {lint:?}");
    }
);

init_case!(
    it_finds_the_proof_surface_when_tests_live_in_their_own_directory,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        assert!(
            w["trace"]["proof_dir"] == "test" && w["trace"]["proof_suffix"] == ".test.ts",
            "proof_dir {}, proof_suffix {}",
            w["trace"]["proof_dir"],
            w["trace"]["proof_suffix"]
        );
    }
);

init_case!(
    /// `verify.lint` gets the changed files APPENDED: `eslint .` plus a file
    /// lints the whole repo, which silently undoes lint scoping.
    a_lint_scripts_target_is_dropped_so_appending_a_file_cannot_widen_the_scope,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        let (lint, no_fix) = (argv(&w["verify"]["lint"]), argv(&w["verify"]["lint_no_fix"]));
        assert!(!has_token(&lint, ".") && !has_token(&no_fix, "."), "a target survived: lint {lint:?}, lint_no_fix {no_fix:?}");
        assert!(has_token(&lint, "--fix"), "the autofix flag was dropped along with the target: {lint:?}");
    }
);

init_case!(
    dropping_a_target_is_reported_never_silent,
    complete(),
    |dir| {
        must_match(
            r"(?s)REVIEW.*verify\.lint dropped",
            &run_init(dir, &[]).stdout,
            "init changed the linter invocation without saying so",
        );
    }
);

init_case!(
    a_flags_value_that_looks_like_a_path_is_not_mistaken_for_a_target,
    with_scripts(&[
        ("test", "vitest run"),
        ("lint", "eslint --ignore-path .gitignore --ext .ts")
    ]),
    |dir| {
        run_init(dir, &[]);
        let no_fix = argv(&read_written(dir)["verify"]["lint_no_fix"]);
        for tok in ["--ignore-path", ".gitignore", "--ext", ".ts"] {
            assert!(
                has_token(&no_fix, tok),
                "{tok:?} was stripped out of a flag pair: {no_fix:?}"
            );
        }
    }
);

// ---- an inference is offered for review, never as a reading

init_case!(
    colocated_tests_yield_a_review_line_not_a_silent_guess,
    InitOpts {
        files: files! {"eslint.config.js" => "", "lib/a.ts" => "export const a = 1;\n", "lib/b.ts" => "export const b = 2;\n", "lib/c.ts" => "export const c = 3;\n",
        "lib/a.test.ts" => "it(\"a\", () => {});\n", "lib/b.test.ts" => "it(\"b\", () => {});\n"},
        ..complete()
    },
    |dir| {
        let out = run_init(dir, &[]).stdout;
        must_match(
            "REVIEW",
            &out,
            "no segment identifies a test, yet init presented proof_dir as settled",
        );
        must_match(
            "proof_dir",
            &out,
            "the REVIEW line does not name the field it is about",
        );
    }
);

init_case!(
    /// A plausible wrong default runs; a missing one is reported.
    an_undetectable_runner_is_left_empty_and_reported_never_defaulted,
    with_scripts(&[("lint", "eslint .")]),
    |dir| {
        let res = run_init(dir, &[]);
        let test = argv(&read_written(dir)["verify"]["test"]);
        assert!(test.is_empty(), "init invented a test command for a repo that declares none: {test:?}");
        must_match("MISSING", &res.stdout, "nothing told the human the runner is missing");
        assert_ne!(res.status, 0, "init exited 0 having written a contract that cannot validate");
    }
);

init_case!(
    a_compound_test_script_is_left_to_the_human_rather_than_half_parsed,
    with_scripts(&[
        ("test", "npm run build && vitest run"),
        ("lint", "eslint .")
    ]),
    |dir| {
        run_init(dir, &[]);
        let test = argv(&read_written(dir)["verify"]["test"]);
        assert!(
            test.is_empty(),
            "init took one half of a chained script as the whole test command: {test:?}"
        );
    }
);

init_case!(
    /// The engine spawns the argv with no shell: a quote kept is a literal
    /// the runner matches no file with — a green gate over zero tests.
    a_quoted_argument_reaches_the_argv_as_the_shell_would_pass_it_never_with_its_quotes,
    with_scripts(&[("test", r#"mocha --spec "test/**/*.spec.js""#), ("lint", "eslint --rulesdir './my rules' src")]),
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        for field in ["test", "lint", "lint_no_fix"] {
            let a = argv(&w["verify"][field]);
            assert!(!a.iter().any(|t| t.contains(['"', '\''])), "verify.{field} carries shell quotes as literal text: {a:?}");
        }
        let (test, no_fix) = (argv(&w["verify"]["test"]), argv(&w["verify"]["lint_no_fix"]));
        assert!(has_token(&test, "test/**/*.spec.js") && has_token(&no_fix, "./my rules"), "a quoted word did not arrive as one: test {test:?} lint_no_fix {no_fix:?}");
    }
);

init_case!(
    a_quoted_pipe_is_one_argument_not_a_chain,
    with_scripts(&[
        ("test", "vitest run -t 'login|logout'"),
        ("lint", "eslint .")
    ]),
    |dir| {
        run_init(dir, &[]);
        let test = argv(&read_written(dir)["verify"]["test"]);
        assert!(has_token(&test, "login|logout"), "verify.test: {test:?}");
    }
);

init_case!(
    /// A framework scaffold's own scripts.
    a_scaffolds_quoted_lint_script_is_read_and_the_report_path_is_where_jest_junit_writes,
    InitOpts {
        scripts: vec![("build", "nest build"), ("format", r#"prettier --write "lib/**/*.ts" "test/**/*.ts""#), ("lint", r#"eslint "{src,apps,libs,test}/**/*.ts" --fix"#), ("test", "jest")],
        installed: vec![bin("eslint", "eslint", "bin/eslint.js")],
        ..complete()
    },
    |dir| {
        let res = run_init(dir, &[]);
        let w = read_written(dir);
        assert!(joined(&w["verify"]["lint_no_fix"]) == ESLINT && joined(&w["verify"]["lint"]) == format!("{ESLINT} --fix"), "lint {}, lint_no_fix {}", w["verify"]["lint"], w["verify"]["lint_no_fix"]);
        must_not_match(r"MISSING\s+verify\.lint\b", &res.stdout, "the lint script was still refused");
        assert_eq!(w["trace"]["report"]["path"], "junit.xml", "trace.report is not where jest-junit writes by default");
        assert!(!read(dir.join("package.json")).contains("jest-junit"), "init configured the repo's jest-junit");
    }
);

init_case!(
    a_lint_fix_script_with_no_lint_script_is_the_linter_its_fix_flag_set_aside,
    with_scripts(&[("test", "vitest run"), ("lint:fix", "eslint . --fix")]),
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        assert!(
            joined(&w["verify"]["lint_no_fix"]) == ESLINT
                && joined(&w["verify"]["lint"]) == format!("{ESLINT} --fix"),
            "lint {}, lint_no_fix {}",
            w["verify"]["lint"],
            w["verify"]["lint_no_fix"]
        );
    }
);

init_case!(
    /// `node` as test_name would deny every node invocation while implementing.
    an_interpreter_is_never_taken_as_the_runner_name,
    with_scripts(&[("test", "node run-my-tests.mjs"), ("lint", "eslint .")]),
    |dir| {
        let res = run_init(dir, &[]);
        let w = read_written(dir);
        assert!(w["verify"]["test_name"] != "node" && !has_token(&argv(&w["unscoped_denied"]["tools"]), "node"), "node was taken as the runner: test_name {}, tools {}", w["verify"]["test_name"], w["unscoped_denied"]["tools"]);
        assert_eq!(joined(&w["verify"]["test"]), "node run-my-tests.mjs", "the argv itself should still be correct");
        must_match("(?s)MISSING.*test_name", &res.stdout, "nothing reported test_name as needing a human");
    }
);

init_case!(
    /// Node's own runner is `node` plus the flag that makes it a test run.
    a_node_test_project_finishes_named_for_the_runner_and_never_for_node,
    InitOpts { scripts: vec![("test", "node --test"), ("lint", "eslint ."), ("lint:fix", "eslint . --fix")], installed: vec![bin("eslint", "eslint", "bin/eslint.js")], ..complete() },
    |dir| {
        let res = run_init(dir, &[]);
        assert!(res.status == 0 && missing_lines(&res.stdout).is_empty(), "init did not finish a bare node --test project (exit {}): {}", res.status, res.stdout);
        let w = read_written(dir);
        assert_eq!(w["verify"]["test_name"], "node --test");
        let tools = argv(&w["unscoped_denied"]["tools"]);
        assert!(!tools.iter().any(|t| matches(r"^node\b", t)), "a node name reached unscoped_denied.tools: {tools:?}");
        assert!(has_token(&argv(&w["verify"]["test"]), "--test-reporter=junit"), "the JUnit flag was not appended: {}", w["verify"]["test"]);
    }
);

init_case!(
    a_runtime_that_really_is_the_runner_keeps_its_name,
    with_scripts(&[("test", "bun test"), ("lint", "eslint .")]),
    |dir| {
        run_init(dir, &[]);
        assert_eq!(
            read_written(dir)["verify"]["test_name"],
            "bun",
            "here the runtime IS the runner"
        );
    }
);

fn plus(mut o: InitOpts, scripts: &[(&'static str, &'static str)]) -> InitOpts {
    for (k, v) in scripts {
        o.scripts.retain(|(n, _)| n != k);
        o.scripts.push((k, v));
    }
    o
}

init_case!(
    /// typescript declares its bin without an extension: the entry must still
    /// name the file node runs, since a bare `tsc` spawned with no shell is
    /// never found.
    the_repos_build_and_typecheck_scripts_become_extra_checks_entries,
    {
        let mut o = plus(complete(), &[("build", "tsc -p tsconfig.build.json"), ("typecheck", "tsc --noEmit")]);
        o.installed.push(bin("tsc", "typescript", "bin/tsc"));
        o
    },
    |dir| {
        let res = run_init(dir, &[]);
        assert_eq!(res.status, 0, "init did not finish: {}", res.stdout);
        let checks = read_written(dir)["extra_checks"].clone();
        for (name, args) in [("build", &["-p", "tsconfig.build.json"][..]), ("typecheck", &["--noEmit"])] {
            let e = checks.as_array().unwrap().iter().find(|e| e["name"] == name).unwrap_or_else(|| panic!("no {name:?} entry in extra_checks: {checks}"));
            let mut want = vec!["node".to_string(), "node_modules/typescript/bin/tsc".into()];
            want.extend(args.iter().map(|a| a.to_string()));
            assert!(e["field"] == name && argv(&e["cmd"]) == want, "the {name:?} entry: {e}, want cmd {want:?}");
            must_match(&format!(r#"REVIEW\s+extra_checks — offered "{name}""#), &res.stdout, "a check at every gate was written with no REVIEW line");
        }
    }
);

init_case!(
    a_repo_with_neither_script_keeps_extra_checks_empty,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let checks = read_written(dir)["extra_checks"].clone();
        assert!(
            checks.as_array().is_some_and(Vec::is_empty),
            "init wrote a check the repo never declared: {checks}"
        );
    }
);

init_case!(
    /// `extra_checks` is optional: an unreadable script must not hold the
    /// exit code, nor vanish unsaid.
    a_build_script_only_a_shell_can_run_is_reported_not_half_parsed_and_init_still_finishes,
    plus(complete(), &[("build", "tsc && node bundle.mjs")]),
    |dir| {
        let res = run_init(dir, &[]);
        assert_eq!(res.status, 0, "an unreadable optional script held init's exit code: {}", res.stdout);
        let checks = read_written(dir)["extra_checks"].clone();
        assert!(checks.as_array().is_some_and(Vec::is_empty), "init wrote part of a chained script as a check: {checks}");
        must_match(r#"REVIEW\s+extra_checks — the "build" script .* was not offered: it chains"#, &res.stdout, "nothing said the build script will not run during a run");
    }
);

init_case!(
    /// `build:lib` is a script name, and a package manager on Windows is a
    /// `.cmd` no shell-less spawn finds.
    a_script_that_hands_off_to_another_package_script_is_reported_not_offered,
    plus(complete(), &[("build", "npm run build:lib"), ("build:lib", "tsc -p ."), ("typecheck", "pnpm -r typecheck")]),
    |dir| {
        let res = run_init(dir, &[]);
        assert_eq!(res.status, 0, "an optional script init cannot run held its exit code: {}", res.stdout);
        let checks = read_written(dir)["extra_checks"].clone();
        assert!(checks.as_array().is_some_and(Vec::is_empty), "init offered a command that cannot be spawned: {checks}");
        for name in ["build", "typecheck"] {
            must_match(&format!(r#"REVIEW\s+extra_checks — the "{name}" script .* was not offered: it runs a package script"#), &res.stdout, "nothing said the script will not run during a run");
        }
    }
);

init_case!(
    /// The reader treats base_ref as optional; when resolution fails here it
    /// fails at the first gate too, so "valid" would be a half-truth.
    an_unresolvable_base_is_reported_and_holds_the_exit_code_though_the_reader_allows_it,
    InitOpts { no_commit: true, ..complete() },
    |dir| {
        let res = run_init(dir, &[]);
        must_match("(?s)MISSING.*base_ref", &res.stdout, "base_ref was not reported as missing");
        assert_ne!(res.status, 0, "init exited 0 over a base the first gate will refuse to resolve");
    }
);

init_case!(
    spec_flow_init_through_the_cli_actually_writes_the_contract,
    complete(),
    |dir| {
        let res = run_init(dir, &[]);
        assert!(
            exists(dir.join(".spec-flow/config.json")),
            "the CLI exited {} and wrote nothing: {}",
            res.status,
            res.stdout
        );
    }
);

// ---- scaffolding

init_case!(
    it_creates_the_directories_and_the_gitignore_line,
    complete(),
    |dir| {
        run_init(dir, &[]);
        for p in ["specs", "specflow/archive"] {
            assert!(exists(dir.join(p)), "{p} was not created");
        }
        must_match(
            r"(?m)^\s*\.claude/state/\s*$",
            &read(dir.join(".gitignore")),
            ".claude/state/ is not gitignored, so the quiescence guard skips every run after the first",
        );
    }
);

init_case!(
    /// Two agent contracts tell their reader that `specs/README.md` has the contract.
    it_scaffolds_the_capability_spec_contract_the_agents_defer_to,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let text = read(dir.join("specs/README.md"));
        assert!(!text.is_empty(), "specs/README.md was not created, and two agent contracts point at it");
        for (what, re) in [("the filename to id-prefix binding", "REQ-USER-"), ("the three-digit id format", "(?i)three digits"), ("the scope marker", "spec-scope")] {
            must_match(re, &text, &format!("the contract does not state {what}"));
        }
    }
);

init_case!(
    it_never_overwrites_a_specs_contract_the_repo_already_wrote,
    {
        let mut o = complete();
        o.files.push(("specs/README.md".into(), "# ours\n".into()));
        o
    },
    |dir| {
        run_init(dir, &["--force"]);
        assert_eq!(
            read(dir.join("specs/README.md")),
            "# ours\n",
            "a repo's own spec conventions were overwritten"
        );
    }
);

init_case!(
    /// `scoped_alternative` is the only thing no-gate-cmds offers an
    /// implementer it denied.
    the_scoped_alternative_init_writes_names_a_command_the_repo_actually_has,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let alt = read_written(dir)["unscoped_denied"]["scoped_alternative"].as_str().unwrap_or("").to_string();
        let m = Regex::new(r"^\S+\s+run\s+(\S+)").unwrap().captures(&alt).unwrap_or_else(|| panic!(r#"scoped_alternative is not a "<pm> run <script>" invocation: {alt:?}"#));
        let pkg: Value = serde_json::from_str(&read(dir.join("package.json"))).unwrap();
        assert!(pkg["scripts"][&m[1]].as_str().is_some_and(|s| !s.is_empty()), "scoped_alternative is {alt:?} and package.json declares no {:?} script: {}", &m[1], pkg["scripts"]);
    }
);

init_case!(
    a_check_script_the_repo_already_wrote_is_never_replaced,
    plus(complete(), &[("check", "make verify")]),
    |dir| {
        run_init(dir, &["--force"]);
        let pkg: Value = serde_json::from_str(&read(dir.join("package.json"))).unwrap();
        assert_eq!(
            pkg["scripts"]["check"], "make verify",
            "the repo's own check script was overwritten"
        );
    }
);

init_case!(
    /// The suite writes trace.report.path at every gate: left untracked it
    /// dirties the tree, and the quiescence guard stops judging.
    it_gitignores_the_report_it_just_told_the_suite_to_write,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        let declared = w["trace"]["report"]["path"].as_str().filter(|p| !p.is_empty()).expect("this repo got no trace.report, so the case is testing nothing — fix the fixture, not the engine");
        let first = format!("{}/", declared.split('/').next().unwrap());
        let lines: Vec<String> = read(dir.join(".gitignore")).split('\n').map(|l| l.trim().to_string()).collect();
        assert!(has_token(&lines, &first) || has_token(&lines, declared), "neither {first} nor {declared} is gitignored: {lines:?}");
    }
);

init_case!(
    it_does_not_duplicate_a_gitignore_line_the_repo_already_has,
    InitOpts {
        gitignore: Some("node_modules/\n.claude/state/\n"),
        ..complete()
    },
    |dir| {
        run_init(dir, &[]);
        let n = Regex::new(r"(?m)^\s*\.claude/state/\s*$")
            .unwrap()
            .find_iter(&read(dir.join(".gitignore")))
            .count();
        assert_eq!(n, 1, "expected exactly one .claude/state/ line");
    }
);

// ---- never destroy a contract a human has already tuned

init_case!(
    an_existing_contract_is_never_overwritten_without_force,
    InitOpts {
        existing: Some(r#"{"mine":true}"#),
        ..complete()
    },
    |dir| {
        let res = run_init(dir, &[]);
        assert_eq!(
            read_written(dir)["mine"],
            true,
            "init overwrote a contract that was already there"
        );
        assert_eq!(
            res.status, 0,
            "init failed instead of declining politely: {}",
            res.stdout
        );
        must_match(
            "--force",
            &res.stdout,
            "it did not say how to overwrite on purpose",
        );
    }
);

init_case!(
    force_overwrites_it,
    InitOpts {
        existing: Some(r#"{"mine":true}"#),
        ..complete()
    },
    |dir| {
        run_init(dir, &["--force"]);
        assert!(
            read_written(dir).get("mine").is_none(),
            "--force left the old contract in place"
        );
    }
);

// ---- the contract is a file the team COMMITS: what it names must run on a
// machine other than the one that wrote it.

init_case!(
    the_contract_names_a_runnable_entrypoint_not_the_bin_shim,
    complete(),
    |dir| {
        run_init(dir, &[]);
        let w = read_written(dir);
        for field in ["lint", "test"] {
            let a = argv(&w["verify"][field]);
            assert!(
                !matches(r"node_modules[\\/]\.bin", &a.join(" ")),
                "verify.{field} points into node_modules/.bin ({a:?}): a symlink on POSIX, a sh script on Windows"
            );
            if !have_node() {
                continue;
            }
            // The interpreter and its entrypoint only: the rest is the repo's own.
            let r = run(dir, &[] as &[&str], "", &a[..2]);
            assert_eq!(
                r.status,
                0,
                "verify.{field} does not execute as written ({} {}): {}",
                a[0],
                a[1],
                r.out()
            );
        }
    }
);

init_case!(
    /// On POSIX a guard: only the platform with a second separator can fail it.
    the_contract_carries_no_host_os_path_separator,
    complete(),
    |dir| {
    run_init(dir, &[]);
    let w = read_written(dir);
    for field in ["lint", "lint_no_fix", "test"] {
        let a = argv(&w["verify"][field]);
        assert!(!a.iter().any(|t| t.contains('\\')), "verify.{field} = {a:?}: the generating machine's separator, in a file the whole team reads");
    }
    }
);

init_case!(
    /// ADR-027: a contract inside one package is one no gate runs against.
    init_refuses_to_write_a_contract_inside_a_subdirectory_of_the_repository,
    complete(),
    |dir| {
        let back = dir.join("back");
        write(back.join("package.json"), &json!({"name": "back", "scripts": scripts_json(&complete().scripts)}).to_string());
        let res = run_init(&back, &[]);
        assert!(!exists(back.join(".spec-flow/config.json")), "a contract was written inside back/");
        assert_ne!(res.status, 0, "init reported success from a subdirectory of the repository: {}", res.stdout);
        must_match("repository root", &res.out(), "the refusal does not name the root to run from");
    }
);

init_case!(
    init_refuses_a_directory_that_is_in_no_repository_and_writes_nothing_there,
    InitOpts {
        no_git: true,
        ..complete()
    },
    |dir| {
        let res = run_init(dir, &[]);
        assert!(
            !exists(dir.join(".spec-flow/config.json")),
            "a contract was written into a directory that is no repository"
        );
        assert_ne!(
            res.status, 0,
            "init reported success outside any repository: {}",
            res.stdout
        );
        must_match(
            "not inside a git repository",
            &res.out(),
            "the refusal does not name the missing repository",
        );
    }
);

// ---- a repo with nothing to read still gets a starting point

init_case!(
    a_repo_with_no_package_json_still_gets_a_file_and_a_full_missing_list,
    InitOpts {
        no_pkg_json: true,
        ..Default::default()
    },
    |dir| {
        let res = run_init(dir, &[]);
        assert!(
            exists(dir.join(".spec-flow/config.json")),
            "no contract was written at all"
        );
        assert_ne!(
            res.status, 0,
            "init reported success for a contract with every required field empty"
        );
        must_match(
            "MISSING",
            &res.stdout,
            "nothing named the fields a human has to fill",
        );
    }
);

/// A lint script that writes its own fixes is never lint_no_fix: there
/// `spec-flow check --no-fix` would rewrite a file and print OK.
#[test]
fn a_lint_script_that_already_fixes_is_never_the_report_only_variant() {
    for lint in ["eslint --fix .", "eslint . --fix"] {
        let dir = init_repo2(&with_scripts(&[("test", "vitest run"), ("lint", lint)]));
        let res = run_init(&dir, &[]);
        let w = read_written(&dir);
        let (l, nf) = (
            argv(&w["verify"]["lint"]),
            argv(&w["verify"]["lint_no_fix"]),
        );
        assert!(
            !has_token(&nf, "--fix") && has_token(&l, "--fix"),
            "{lint}: lint {l:?}, lint_no_fix {nf:?}"
        );
        assert!(
            !has_token(&l, ".") && !has_token(&nf, "."),
            "{lint}: the target \".\" was kept after a flag that takes no value: lint {l:?}, lint_no_fix {nf:?}"
        );
        must_match(
            r#"REVIEW\s+verify\.lint_no_fix — the "lint" script carries --fix"#,
            &res.stdout,
            "the dropped flag was not reported",
        );
        must_not_match(
            "no autofix script was declared",
            &res.stdout,
            "init says no autofix was declared over a script that carries one",
        );
    }
}

#[test]
fn a_script_only_a_shell_can_read_is_left_to_the_human_with_the_reason() {
    const EXPANDS: &str = "expands something only a shell can";
    for (scripts, field, why) in [
        (
            vec![("test", "vitest run"), ("lint", r#"eslint "$PWD/src""#)],
            "lint",
            EXPANDS,
        ),
        (
            vec![("test", "jest $JEST_FLAGS"), ("lint", "eslint .")],
            "test",
            EXPANDS,
        ),
        (
            vec![("test", "jest `cat list.txt`"), ("lint", "eslint .")],
            "test",
            EXPANDS,
        ),
        (
            vec![("test", "vitest run"), ("lint", "eslint lib # the sources")],
            "lint",
            EXPANDS,
        ),
        (
            vec![
                ("test", r#"NODE_OPTIONS="--experimental-vm-modules" jest"#),
                ("lint", "eslint ."),
            ],
            "test",
            "sets an environment variable",
        ),
        (
            vec![("test", "NODE_ENV=test vitest run"), ("lint", "eslint .")],
            "test",
            "sets an environment variable",
        ),
        (
            vec![
                ("test", "npm run test:unit"),
                ("test:unit", "vitest run"),
                ("lint", "eslint ."),
            ],
            "test",
            "runs a package script through the package manager",
        ),
    ] {
        let dir = init_repo2(&with_scripts(&scripts));
        let res = run_init(&dir, &[]);
        let a = argv(&read_written(&dir)["verify"][field]);
        assert!(a.is_empty(), "init wrote verify.{field} {a:?}");
        must_match(
            &format!(r"MISSING\s+verify\.{field}.*{}", regex::escape(why)),
            &res.stdout,
            "the refusal does not say why",
        );
    }
}

#[test]
fn the_report_path_is_read_from_the_jest_junit_key_the_repo_wrote_never_written_over() {
    for (key, want) in [
        (json!({"outputDirectory": "out"}), "out/junit.xml"),
        (
            json!({"outputDirectory": "out", "outputName": "results.xml"}),
            "out/results.xml",
        ),
        (
            json!({"outputFile": "./test-results/jest.xml"}),
            "test-results/jest.xml",
        ),
        (json!({"outputDirectory": "<rootDir>/out"}), ""),
    ] {
        let dir = init_repo2(&InitOpts {
            scripts: vec![("test", "jest"), ("lint", "eslint .")],
            pkg_extra: Some(json!({"jest-junit": key})),
            ..complete()
        });
        let res = run_init(&dir, &[]);
        let pkg: Value = serde_json::from_str(&read(dir.join("package.json"))).unwrap();
        assert_eq!(pkg["jest-junit"], key, "the repo's own key was changed");
        if want.is_empty() {
            must_match(
                r#"MISSING\s+trace\.report\.path — the "jest-junit" key"#,
                &res.stdout,
                "a path only jest resolves was not reported",
            );
            continue;
        }
        assert_eq!(read_written(&dir)["trace"]["report"]["path"], want, "{key}");
    }
}

/// A fix script running another command than the lint script's is no autofix
/// of it: taken as one, the gate would run a formatter on every changed file.
#[test]
fn a_formatter_is_never_taken_as_the_linter_or_as_its_autofix() {
    type Problem = fn(&[String], &str) -> bool;
    let cases: Vec<(Vec<(&'static str, &'static str)>, Problem)> = vec![
        (
            vec![("lint", "eslint lib"), ("format", "prettier --write lib")],
            |l, out| {
                l.join(" ").contains("prettier")
                    || !matches(r#"REVIEW\s+verify\.lint — the "format" script"#, out)
            },
        ),
        (
            vec![
                ("lint", "biome lint ./lib"),
                ("format", "biome format --write ./lib"),
            ],
            |l, _| has_token(l, "format"),
        ),
        (vec![("format", "prettier --write .")], |l, out| {
            !l.is_empty() || !out.contains(r#""format" is not read as one"#)
        }),
        (
            vec![
                ("lint", "eslint . && prettier --check ."),
                ("format", "prettier --write ."),
            ],
            |l, _| !l.is_empty(),
        ),
    ];
    for (scripts, problem) in cases {
        let mut all = vec![("test", "vitest run")];
        all.extend(scripts.iter().copied());
        let dir = init_repo2(&with_scripts(&all));
        let res = run_init(&dir, &[]);
        let lint = argv(&read_written(&dir)["verify"]["lint"]);
        assert!(
            !problem(&lint, &res.stdout),
            "{scripts:?}: lint: {lint:?}\n{}",
            res.stdout
        );
    }
}

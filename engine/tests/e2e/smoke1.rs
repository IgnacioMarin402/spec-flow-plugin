//! Preflight, session-start, arm-gate, the Opus budget, no-gate-cmds and the
//! run trace, each through its hook.

use std::path::Path;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;

pub fn spawn_spec_writer() -> Value {
    json!({"tool_input": {"subagent_type": "spec-writer"}})
}

// ---- preflight: the run refuses to start rather than dying at the gate ----

#[test]
fn preflight_allows_a_valid_setup() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook("preflight", spawn_spec_writer(), &repo),
        0,
        "a valid setup was denied",
    );
}

#[test]
fn preflight_denies_an_unusable_contract() {
    let repo = make_repo(RepoOpts {
        no_contract: true,
        phase: "spec",
        ..Default::default()
    });
    let r = run_hook("preflight", spawn_spec_writer(), &repo);
    expect_status(&r, 2, "expected the PreToolUse denial");
    must_match(
        "PREFLIGHT FAILED",
        &r.stderr,
        "the denial does not say what happened",
    );
}

#[test]
fn preflight_denies_with_no_base() {
    let repo = make_repo(RepoOpts {
        no_commit: true,
        phase: "spec",
        ..Default::default()
    });
    let r = run_hook("preflight", spawn_spec_writer(), &repo);
    expect_status(&r, 2, "a run with no resolvable base was allowed to start");
    must_match(
        "base branch",
        &r.stderr,
        "the denial does not name the base as the problem",
    );
}

/// A workspace directory holding several repositories has no base either,
/// and that is not what is wrong with it (ADR-027).
#[test]
fn preflight_denies_outside_any_repository() {
    let repo = make_repo(RepoOpts {
        no_git: true,
        phase: "spec",
        ..Default::default()
    });
    let r = run_hook("preflight", spawn_spec_writer(), &repo);
    expect_status(&r, 2, "a run outside any repository was allowed to start");
    must_match(
        "not inside a git repository",
        &r.stderr,
        "the denial blames something other than the missing repository",
    );
    must_match(
        "PREFLIGHT FAILED — this directory is in no git repository",
        &r.stderr,
        "the heading names something else",
    );
    must_not_match(
        "spec-flow init` regenerates",
        &r.stderr,
        "it sends a human to run init where init refuses for the same reason",
    );
}

#[test]
fn preflight_denies_a_subdirectory_of_its_repository() {
    let outer = temp_dir();
    init_repo(&outer, false, true);
    let back = outer.join("back");
    write_run(&back, "spec", None);
    let r = run_hook("preflight", spawn_spec_writer(), &back);
    expect_status(
        &r,
        2,
        "a run opened at back/ of a repository was allowed to start",
    );
    must_match(
        "repository root",
        &r.stderr,
        "the denial does not say where to open the repository",
    );
}

/// A guard on the rule's edge: a package that is its own repository IS a root.
#[test]
fn preflight_allows_a_package_that_is_its_own_repository() {
    let outer = temp_dir();
    init_repo(&outer, false, true);
    let back = outer.join("back");
    write_run(&back, "spec", None);
    init_repo(&back, false, true);
    expect_status(
        &run_hook("preflight", spawn_spec_writer(), &back),
        0,
        "a package that is its own repository was refused",
    );
}

#[test]
fn preflight_is_transparent_outside_a_run() {
    let repo = make_repo(RepoOpts {
        no_contract: true,
        no_git: true,
        phase: "idle",
        ..Default::default()
    });
    expect_status(
        &run_hook(
            "preflight",
            json!({"tool_input": {"subagent_type": "anything"}}),
            &repo,
        ),
        0,
        "it denied a subagent spawned outside the flow",
    );
}

#[test]
fn session_start_resets_a_stale_plan_phase() {
    let repo = repo_in("plan");
    age(state_path(&repo, "phase"), Duration::from_secs(72 * 3600));
    expect_status(
        &run_hook("session-start", json!({}), &repo),
        0,
        "session-start",
    );
    assert_eq!(phase_of(&repo), "idle", "a three-day-old 'plan' survived");
}

/// Every hook hooks.json registers, read off the file Claude Code reads.
pub fn registered_hooks() -> Vec<String> {
    let manifest = read(SETUP.repo_root.join("hooks/hooks.json"));
    let mut names: Vec<String> = Regex::new(r#"spec-flow\\?" hook ([a-z-]+)"#)
        .unwrap()
        .captures_iter(&manifest)
        .map(|m| m[1].to_string())
        .collect();
    names.sort();
    names.dedup();
    assert!(
        !names.is_empty(),
        "hooks/hooks.json registers no hook this case can read"
    );
    names
}

/// Standing down must leave nothing on disk, in every repository the user opens.
#[test]
fn no_hook_creates_state_outside_the_flow() {
    let bare = temp_dir();
    write(bare.join("package.json"), "{}");
    for n in registered_hooks() {
        run_hook(
            &n,
            json!({"tool_name": "Task", "tool_input": {"subagent_type": "planner", "command": "ls"}}),
            &bare,
        );
    }
    assert!(
        !exists(bare.join(".claude")),
        "the hooks created .claude/ in a repo with no phase file and no contract"
    );
}

#[test]
fn arm_gate_matches_whatever_the_casing() {
    let repo = repo_in("plan");
    expect_status(
        &run_hook(
            "arm-gate",
            json!({"tool_input": {"subagent_type": "Implementer"}}),
            &repo,
        ),
        0,
        "arm-gate",
    );
    assert_eq!(
        phase_of(&repo),
        "implement",
        "a capitalised agent type left every guard disarmed, silently"
    );
}

#[test]
fn whole_repo_denial_hands_no_disarm() {
    let repo = make_repo(RepoOpts::default());
    let r = run_hook(
        "no-gate-cmds",
        json!({"tool_input": {"command": "npm run test"}}),
        &repo,
    );
    expect_status(&r, 2, "expected a denial");
    must_not_match(
        r"state[\\/]phase",
        &r.stderr,
        "the denial quotes the phase file to an agent mid-milestone",
    );
}

#[test]
fn arm_gate_flips_phase_on_an_implementer_spawn() {
    let repo = repo_in("plan");
    expect_status(
        &run_hook(
            "arm-gate",
            json!({"tool_input": {"subagent_type": "implementer"}}),
            &repo,
        ),
        0,
        "arm-gate",
    );
    assert_eq!(phase_of(&repo), "implement");
}

#[test]
fn arm_gate_ignores_another_spawn() {
    let repo = repo_in("plan");
    expect_status(
        &run_hook(
            "arm-gate",
            json!({"tool_input": {"subagent_type": "reviewer"}}),
            &repo,
        ),
        0,
        "arm-gate",
    );
    assert_eq!(phase_of(&repo), "plan", "phase changed");
}

pub fn spawn_of(typ: &str) -> Value {
    json!({"tool_name": "Task", "tool_input": {"subagent_type": typ}})
}

#[test]
fn opus_budget() {
    type Check = fn(&Path, &Output, &str);
    type Case<'a> = (&'a str, &'a str, Vec<(&'a str, &'a str)>, &'a str, Check);
    let cases: Vec<Case> = vec![
        (
            "counts a planner spawn",
            r#"{"max_opus_calls":6}"#,
            vec![],
            "planner",
            |repo, r, name| {
                expect_status(r, 0, name);
                assert_eq!(read(state_path(repo, "opus_calls")), "1", "{name}");
            },
        ),
        (
            "denies past the cap",
            r#"{"max_opus_calls":2}"#,
            vec![("opus_calls", "2")],
            "planner",
            |_, r, name| {
                expect_status(r, 2, name);
                must_match("budget exhausted", &r.stderr, name);
            },
        ),
        (
            "does not count a non-escalation spawn",
            r#"{"max_opus_calls":6}"#,
            vec![],
            "implementer",
            |repo, r, name| {
                expect_status(r, 0, name);
                assert_eq!(
                    counter_of(repo, "opus_calls"),
                    "0",
                    "{name}: counted a spawn that is not an escalation"
                );
            },
        ),
        (
            "charges the architect to its own counter",
            "",
            vec![],
            "spec-flow:architect",
            |repo, r, name| {
                expect_status(r, 0, name);
                assert!(
                    counter_of(repo, "architect_calls") == "1"
                        && counter_of(repo, "opus_calls") == "0",
                    "{name}: architect_calls {}, opus_calls {}",
                    counter_of(repo, "architect_calls"),
                    counter_of(repo, "opus_calls")
                );
            },
        ),
        (
            "reads max_architect_calls from the config",
            r#"{"max_architect_calls":1}"#,
            vec![("architect_calls", "1")],
            "architect",
            |_, r, name| {
                expect_status(
                    r,
                    2,
                    &format!("{name}: max_architect_calls 1 let a second call through"),
                );
            },
        ),
        (
            "denies while its cap is not a number of calls",
            r#"{"max_opus_calls":"six"}"#,
            vec![],
            "planner",
            |_, r, name| {
                expect_status(
                    r,
                    2,
                    &format!("{name}: a planner spawn went through under a cap no count can reach"),
                );
                must_match(
                    "max_opus_calls",
                    &r.stderr,
                    "the denial does not name the key to fix",
                );
            },
        ),
        (
            "denies an architect under a cap that is no number, and charges nothing",
            r#"{"max_architect_calls":"three"}"#,
            vec![],
            "spec-flow:architect",
            |repo, r, name| {
                expect_status(
                    r,
                    2,
                    &format!(
                        "{name}: an architect spawn went through under a cap no count can reach"
                    ),
                );
                assert!(
                    !exists(state_path(repo, "architect_calls")),
                    "a denied spawn was charged"
                );
                must_match(
                    "max_architect_calls",
                    &r.stderr,
                    "the denial does not name the key to fix",
                );
            },
        ),
        (
            "reads a cap written as a numeric string",
            r#"{"max_architect_calls":"1"}"#,
            vec![("architect_calls", "1")],
            "architect",
            |_, r, name| {
                expect_status(
                    r,
                    2,
                    &format!(r#"{name}: a cap of "1" did not stop a second call"#),
                );
                must_match("budget exhausted", &r.stderr, "no budget message");
            },
        ),
        // Some editors open a JSON file with a byte-order mark; every reader drops it.
        (
            "reads a cap written after a byte-order mark",
            "\u{feff}{\"max_architect_calls\":1}",
            vec![("architect_calls", "1")],
            "architect",
            |_, r, name| {
                expect_status(
                    r,
                    2,
                    &format!(
                        "{name}: a cap of 1 behind a byte-order mark let a second call through"
                    ),
                );
                must_match("budget exhausted", &r.stderr, "no budget message");
            },
        ),
    ];
    for (name, config, counts, spawn, check) in cases {
        let repo = make_repo(RepoOpts::default());
        if !config.is_empty() {
            write(repo.join(".claude/spec-flow.config.json"), config);
        }
        for (k, v) in counts {
            write(state_path(&repo, k), v);
        }
        check(
            &repo,
            &run_hook("opus-budget", spawn_of(spawn), &repo),
            name,
        );
    }
    // Stops the architect at 3 by default while the planner still has budget.
    let repo = make_repo(RepoOpts::default());
    write(state_path(&repo, "architect_calls"), "3");
    let a = run_hook("opus-budget", spawn_of("architect"), &repo);
    expect_status(&a, 2, "a fourth architect call went through");
    must_match(
        "max_architect_calls",
        &a.stderr,
        "the denial does not name max_architect_calls",
    );
    expect_status(
        &run_hook("opus-budget", spawn_of("planner"), &repo),
        0,
        "the planner was denied by the architect's budget",
    );
}

#[test]
fn register_agent_records_an_opus_session_id() {
    let repo = make_repo(RepoOpts::default());
    let r = run_hook(
        "register-agent",
        json!({"tool_input": {"subagent_type": "planner"}, "tool_response": {"agent_id": "a1b2c3d4e5f6a7b8"}}),
        &repo,
    );
    expect_status(&r, 0, "register-agent");
    let reg = read(state_path(&repo, "agent-registry"));
    assert!(
        reg.contains("a1b2c3d4e5f6a7b8 planner"),
        "registry has: {reg:?}"
    );
}

pub fn bash(cmd: &str) -> Value {
    json!({"tool_name": "Bash", "tool_input": {"command": cmd}})
}

/// Each command through no-gate-cmds in the default repository.
#[track_caller]
fn denies(cases: &[(&str, i32)]) {
    for (cmd, want) in cases {
        let repo = make_repo(RepoOpts::default());
        expect_status(&run_hook("no-gate-cmds", bash(cmd), &repo), *want, cmd);
    }
}

#[test]
fn no_gate_cmds() {
    denies(&[
        ("npm run test", 2),
        ("npm run check", 0),
        ("eslint example/thing.ts", 0),
        ("eslint", 2),
        // `run` is no scope: `ftest run` puts the whole suite in context.
        ("npx ftest run", 2),
        ("eslint --max-warnings 0", 2),
        ("npx ftest run tests/a.spec.ts", 0),
        (r#"git commit -m "fix; ftest covers it""#, 0),
        (r#"ftest "tests/a.spec.ts""#, 0),
    ]);
    // Does not tell the implementer to skip its red run.
    let repo = make_repo(RepoOpts::default());
    let r = run_hook("no-gate-cmds", bash("npm run test"), &repo);
    must_not_match(
        "do not need to run anything",
        &r.stderr,
        "it tells the implementer to run nothing",
    );
    must_match(
        "test file's path",
        &r.stderr,
        "the denial never names the scoped form a red run takes",
    );
    // A runtime that is also the runner is denied only for its test subcommand.
    let repo = make_repo(RepoOpts {
        contract_edit: Some(&|c: &mut Value| c["unscoped_denied"]["tools"] = json!(["bun"])),
        ..Default::default()
    });
    expect_status(
        &run_hook("no-gate-cmds", bash("bun add zod"), &repo),
        0,
        "`bun add` was denied as a whole-suite run",
    );
    expect_status(
        &run_hook("no-gate-cmds", bash("bun test"), &repo),
        2,
        "an unscoped `bun test` was allowed",
    );
    // Transparent outside implement.
    let repo = repo_in("idle");
    expect_status(
        &run_hook("no-gate-cmds", bash("npm run test"), &repo),
        0,
        "outside a run",
    );
}

/// The denial redirects an implementer that cannot install anything, so the
/// install-free route it names must be a file this engine ships.
#[test]
fn no_gate_cmds_names_an_install_free_check_that_exists() {
    let repo = make_repo(RepoOpts::default());
    let r = run_hook("no-gate-cmds", bash("npm run test"), &repo);
    let m = Regex::new(r"(?m)^\s*(\S+/bin/spec-flow) check\s*$")
        .unwrap()
        .captures(&r.stderr)
        .unwrap_or_else(|| panic!("the denial names no install-free route:\n{}", r.stderr));
    assert!(exists(&m[1]), "it names {}, which does not exist", &m[1]);
}

/// A whole-repo script handed a path is scoped, as the tool run on a path
/// is, and a leading assignment does not hide the program.
#[test]
fn no_gate_cmds_reads_a_script_handed_a_path_and_an_assigned_environment() {
    denies(&[
        ("npm test -- tests/a.spec.ts", 0),
        ("npm run test -- tests/a.spec.ts", 0),
        ("npm test -- --watch", 2),
        ("NODE_ENV=test ftest run", 2),
        ("NODE_ENV=test ftest run tests/a.spec.ts", 0),
    ]);
}

/// A redirection names where the output goes, not what the run covers.
#[test]
fn no_gate_cmds_reads_no_redirection_as_a_scope() {
    denies(&[
        ("npm test > out.log", 2),
        ("npm test 2>&1 > /tmp/t.txt", 2),
        ("npm run test >out.log; cat out.log", 2),
        ("npm test -- --watch >> run.log", 2),
        ("ftest run > out.log", 2),
        ("ftest run &> /tmp/all.txt", 2),
        ("ftest tests/a.spec.ts > out.log", 0),
        ("npm test -- tests/a.spec.ts 2>&1 > out.log", 0),
    ]);
}

/// Quotes read through the shell's own scanner. Text handed to a shell is a
/// command, and an escaped quote does not close its string.
#[test]
fn no_gate_cmds_reads_quoting_as_the_shell_does() {
    denies(&[
        ("sh -c 'npm run test'", 2),
        (r#"git commit -m "a \"b" && npm run test && echo "c""#, 2),
        (r#"echo "npm run test" | bash"#, 2),
        (r#"bash -c 'git commit -m "fix; ftest covers it"'"#, 0),
        ("sh -c 'npx ftest run tests/a.spec.ts'", 0),
        (
            r#"git commit -m "npm run test is green" && bash scripts/release.sh"#,
            0,
        ),
        // A heredoc a shell reads is a script, wherever the shell takes it from.
        ("bash <<EOF\nnpm run test\nEOF", 2),
        ("sh <<'EOF'\nnpm run test\nEOF", 2),
        ("cat <<EOF | sh\nnpm run test\nEOF", 2),
        (r#"bash <<< "npm run test""#, 2),
        (r#"sudo -u ci bash -lc "npm run test""#, 2),
        // Only what the program runs as a shell command is one: an argument to
        // a script, and text a perl or awk program reads, are text.
        (r#"echo "npm run test" | perl -ne 'print'"#, 0),
        (r#"bash scripts/release.sh "npm run test""#, 0),
        (r#"awk '{print "npm run test"}' log.txt"#, 0),
        (r#"echo "npm run test" | bash scripts/notify.sh"#, 0),
        ("npm run \\\n  test -- tests/a.spec.ts", 0),
    ]);
}

#[test]
fn run_trace_logs_a_source_write() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "run-trace",
            json!({"tool_name": "Write", "tool_input": {"file_path": "example/thing.ts"}}),
            &repo,
        ),
        0,
        "run-trace",
    );
    assert!(
        trace_text(&repo).contains("write file=example/thing.ts"),
        "log: {}",
        trace_text(&repo)
    );
}

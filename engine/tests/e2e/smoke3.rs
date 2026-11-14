//! The turn that closes a run, session-start, the position a resume needs,
//! and phase-guard: what starts a run, the vocabulary, and an earned `done`.

use std::path::Path;
use std::time::Duration;

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;
use crate::smoke1::bash;
use crate::smoke2::all_of;

pub fn usage_entry(out: i64) -> String {
    json!({"type": "assistant", "message": {"id": format!("m{out}"), "role": "assistant", "model": "model-alpha",
        "usage": {"input_tokens": 1, "output_tokens": out, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}})
    .to_string()
        + "\n"
}

pub fn post_tool(session: &str, tool: &str, input: Value) -> Value {
    json!({"session_id": session, "hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": input})
}

pub fn non_empty_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

pub fn any_line(lines: &[String], pattern: &str) -> bool {
    let re = Regex::new(pattern).unwrap();
    lines.iter().any(|l| re.is_match(l))
}

// ---- the turn that closes a run (ADR-043) ----------------------------------

fn phase_write(repo: &Path) -> Value {
    json!({"file_path": state_path(repo, "phase"), "content": "done"})
}

fn token_stop(repo: &Path, session: &str, transcript: &Path) {
    run_hook(
        "token-trace",
        json!({"session_id": session, "hook_event_name": "Stop", "transcript_path": transcript}),
        repo,
    );
}

#[test]
fn the_turn_that_writes_done_leaves_a_line_with_its_tokens_and_the_turns_after_it_none() {
    let repo = make_repo(RepoOpts::default());
    let session = repo.join("sess.jsonl");
    write(&session, &usage_entry(100));
    token_stop(&repo, "s", &session);
    set_phase(&repo, "done");
    run_hook(
        "run-trace",
        post_tool("s", "Write", phase_write(&repo)),
        &repo,
    );
    append_to(&session, &usage_entry(7));
    token_stop(&repo, "s", &session);
    append_to(&session, &usage_entry(3));
    token_stop(&repo, "s", &session);
    let lines = non_empty_lines(&trace_text(&repo));
    assert!(
        any_line(&lines, " phase=done session=s closed tool=Write$"),
        "no line for the write that closed the run:\n{}",
        trace_text(&repo)
    );
    assert!(
        any_line(&lines, " phase=done .* tokens .* out=7 "),
        "the closing turn's tokens were dropped:\n{}",
        trace_text(&repo)
    );
    assert!(
        !any_line(&lines, " out=3 "),
        "a turn after the run was charged to it:\n{}",
        trace_text(&repo)
    );
}

#[test]
fn a_run_closed_from_bash_leaves_its_line_and_a_read_of_the_phase_none() {
    let repo = repo_in("done");
    run_hook(
        "run-trace",
        post_tool("s", "Bash", json!({"command": "cat .claude/state/phase"})),
        &repo,
    );
    assert_eq!(
        trace_text(&repo),
        "",
        "a read of the phase file closed the run"
    );
    run_hook(
        "run-trace",
        post_tool(
            "s",
            "Bash",
            json!({"command": "printf done > .claude/state/phase"}),
        ),
        &repo,
    );
    must_match(
        "(?m) phase=done session=s closed tool=Bash$",
        &trace_text(&repo),
        "no line for a run closed from Bash",
    );
}

#[test]
fn a_run_is_closed_by_each_way_the_phase_file_is_written_and_by_nothing_else() {
    let repo = repo_in("done");
    let post = |tool: &str, input: Value| {
        run_hook("run-trace", post_tool("s", tool, input), &repo);
    };
    post(
        "Write",
        json!({"file_path": repo.join("README.md"), "content": "x"}),
    );
    post("Read", json!({"file_path": state_path(&repo, "phase")}));
    post(
        "Bash",
        json!({"command": "git status --short > /tmp/st.txt; cat .claude/state/phase"}),
    );
    assert_eq!(
        trace_text(&repo),
        "",
        "a call that did not write the phase closed the run"
    );
    post(
        "Bash",
        json!({"command": "printf 'done' | tee .claude/state/phase"}),
    );
    post(
        "Bash",
        json!({"command": "echo done >| .claude/state/phase"}),
    );
    post(
        "Bash",
        json!({"command": r#"printf done > "/Users/First Last/My Projects/app/.claude/state/phase""#}),
    );
    post(
        "Edit",
        json!({"file_path": state_path(&repo, "phase"), "old_string": "implement", "new_string": "done"}),
    );
    post(
        "Write",
        json!({"file_path": r"C:\Users\someone\app\.claude\state\phase", "content": "done"}),
    );
    post(
        "Write",
        json!({"filePath": state_path(&repo, "phase"), "content": "done"}),
    );
    assert_eq!(
        all_of(r"(?m) closed tool=(\S+)$", &trace_text(&repo)),
        "Bash,Bash,Bash,Edit,Write,Write",
        "{}",
        trace_text(&repo)
    );
}

#[test]
fn a_run_closed_after_a_cd_into_claude_state_leaves_its_line() {
    let repo = repo_in("done");
    for c in [
        "cd .claude/state && printf done > phase",
        "cd .claude/state/ && printf done | tee phase",
    ] {
        run_hook(
            "run-trace",
            post_tool("s", "Bash", json!({"command": c})),
            &repo,
        );
    }
    let n = Regex::new(r"(?m) closed tool=Bash$")
        .unwrap()
        .find_iter(&trace_text(&repo))
        .count();
    assert_eq!(n, 2, "want two closes after a cd:\n{}", trace_text(&repo));
}

#[test]
fn another_sessions_turn_after_the_run_closed_is_not_charged_and_the_closers_still_is() {
    let repo = make_repo(RepoOpts::default());
    let (a, b) = (repo.join("a.jsonl"), repo.join("b.jsonl"));
    write(&a, &usage_entry(100));
    token_stop(&repo, "sa", &a);
    set_phase(&repo, "done");
    run_hook(
        "run-trace",
        post_tool("sa", "Write", phase_write(&repo)),
        &repo,
    );
    write(&b, &usage_entry(50));
    token_stop(&repo, "sb", &b);
    append_to(&a, &usage_entry(7));
    token_stop(&repo, "sa", &a);
    let lines = non_empty_lines(&trace_text(&repo));
    assert!(
        !any_line(&lines, " session=sb .*tokens"),
        "another session's turn was charged to the run:\n{}",
        trace_text(&repo)
    );
    assert!(
        any_line(&lines, " phase=done session=sa .*tokens .* out=7 "),
        "the closing turn was not charged:\n{}",
        trace_text(&repo)
    );
}

/// A committed `.claude/state/` is content: its log may link out (ADR-040).
#[test]
fn a_run_closed_in_a_repository_that_committed_claude_state_leaves_no_line_in_it() {
    let repo = make_repo(RepoOpts {
        phase: "done",
        commit_phase: true,
        ..Default::default()
    });
    let shipped = "2026-01-01T00:00:00.000Z phase=done session=s closed tool=Write\n";
    write(state_path(&repo, "run-trace.log"), shipped);
    git_quiet(&repo, &["add", "-f", "--", ".claude/state/run-trace.log"]);
    git_quiet(
        &repo,
        &["commit", "-q", "-m", "a log this repository committed"],
    );
    let session = repo.join("sess.jsonl");
    write(&session, &usage_entry(5));
    run_hook(
        "run-trace",
        post_tool("s", "Write", phase_write(&repo)),
        &repo,
    );
    token_stop(&repo, "s", &session);
    assert_eq!(
        trace_text(&repo),
        shipped,
        "wrote into a .claude/state the repository committed"
    );
}

#[test]
fn session_start_resets_a_stale_phase() {
    let repo = make_repo(RepoOpts::default());
    age(state_path(&repo, "phase"), Duration::from_secs(8 * 3600));
    expect_status(
        &run_hook("session-start", json!({}), &repo),
        0,
        "session-start",
    );
    assert_eq!(phase_of(&repo), "idle");
}

#[test]
fn a_stale_phase_reset_disarms_the_run_without_forgetting_where_it_was() {
    let repo = make_repo(RepoOpts::default());
    write(
        state_path(&repo, "current-milestone"),
        "add-users M2 abc123def4567890a",
    );
    age(state_path(&repo, "phase"), Duration::from_secs(8 * 3600));
    let r = run_hook("session-start", json!({}), &repo);
    expect_status(&r, 0, "session-start");
    assert_eq!(phase_of(&repo), "idle", "the stale phase was not disarmed");
    assert!(
        exists(state_path(&repo, "current-milestone")),
        "the reset erased the position too, so the run is still unresumable"
    );
    must_match(
        "M2",
        &r.stdout,
        "the message did not say where the run stopped",
    );
    must_match(
        "add-users",
        &r.stdout,
        "the message did not say where the run stopped",
    );
    must_not_match(
        "re-run /spec-flow",
        &r.stdout,
        "it tells the user to start over though it knows where the run was",
    );
    must_match(
        "/spec-flow:resume",
        &r.stdout,
        "it does not name the command that picks the run up (ADR-024)",
    );
}

#[test]
fn session_start_leaves_a_fresh_phase_alone() {
    let repo = make_repo(RepoOpts::default());
    run_hook("session-start", json!({}), &repo);
    assert_eq!(
        phase_of(&repo),
        "implement",
        "expected implement (untouched)"
    );
}

// ---- the position a resume needs survives -----------------------------------

pub fn implementer_spawn(input: Value, resp: Value) -> Value {
    let mut tool_input = json!({"subagent_type": "implementer"});
    merge(&mut tool_input, input);
    json!({"tool_name": "Agent", "tool_input": tool_input, "tool_response": resp})
}

fn at(repo: &Path) -> String {
    read(state_path(repo, "current-milestone"))
        .trim()
        .to_string()
}

#[test]
fn register_agent_records_the_milestone_and_session_an_implementer_was_given() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "register-agent",
            implementer_spawn(
                json!({"prompt": "implement specflow/add-users/milestones/M2.md per the plan"}),
                json!({"session_id": "abc123def4567890a"}),
            ),
            &repo,
        ),
        0,
        "register-agent",
    );
    assert_eq!(at(&repo), "add-users M2 abc123def4567890a");
}

/// However the session spells a path, and whether or not an id comes back.
#[test]
fn register_agent_records_the_milestone_from_a_windows_path_and_with_no_id_in_the_response() {
    let repo = make_repo(RepoOpts::default());
    write(
        state_path(&repo, "current-milestone"),
        "add-users M1 abc123def4567890a",
    );
    run_hook(
        "register-agent",
        implementer_spawn(
            json!({"prompt": r"implement C:\repo\specflow\add-users\milestones\M2.md per the plan"}),
            json!({"session_id": "abc123def4567890b"}),
        ),
        &repo,
    );
    assert_eq!(
        at(&repo),
        "add-users M2 abc123def4567890b",
        "a backslashed path"
    );
    run_hook(
        "register-agent",
        implementer_spawn(
            json!({"prompt": "implement specflow/add-users/milestones/M3.md per the plan"}),
            json!({}),
        ),
        &repo,
    );
    assert_eq!(at(&repo), "add-users M3", "a response with no id");
}

/// The live view finds the agent by the milestone it read off the same spawn.
#[test]
fn register_agent_records_the_work_order_its_prompt_names_not_one_its_description_or_another_path_names()
 {
    let repo = make_repo(RepoOpts::default());
    let spawn = |input: Value| {
        run_hook("register-agent", implementer_spawn(input, json!({})), &repo);
    };
    spawn(
        json!({"description": "redo specflow/add-users/milestones/M1.md", "prompt": "implement specflow/add-users/milestones/M2.md per the plan"}),
    );
    assert_eq!(at(&repo), "add-users M2", "a description naming M1");
    spawn(
        json!({"prompt": "see docs/milestones/M1.md, then implement specflow/add-users/milestones/M3.md"}),
    );
    assert_eq!(
        at(&repo),
        "add-users M3",
        "a milestone file named before the work order"
    );
    spawn(json!({"prompt": "resume, with plan.md and milestones/M4.md"}));
    assert_eq!(at(&repo), "add-users M3", "a work order naming no change");
}

// ---- a run that cannot run here does not start (ADR-028) ---------------------

pub fn phase_write_by(repo: &Path, session: &str, content: &str) -> Value {
    json!({"session_id": session, "tool_name": "Write", "tool_input": {"file_path": state_path(repo, "phase"), "content": content}})
}

pub fn start_run(repo: &Path) -> Output {
    run_hook(
        "phase-guard",
        phase_write_by(repo, "session-a", "spec"),
        repo,
    )
}

pub fn change_folder(repo: &Path, slug: &str) {
    write(
        repo.join("specflow").join(slug).join("spec.md"),
        &format!("# Spec — {slug}\n"),
    );
    git_quiet(repo, &["add", "-f", "--", &format!("specflow/{slug}")]);
    git_quiet(repo, &["commit", "-q", "-m", &format!("add {slug}")]);
}

/// A change folder committed on the base, then a branch off it.
pub fn parked_on_base(repo: &Path, slug: &str) {
    change_folder(repo, if slug.is_empty() { "parked" } else { slug });
    git_quiet(repo, &["checkout", "-q", "-b", "feature"]);
}

/// One gate line judging the repository's current HEAD.
pub fn seed_gate_history(repo: &Path, result: &str) {
    let sha = git(repo, &["rev-parse", "--short", "HEAD"]);
    write(
        state_path(repo, "gate-history.log"),
        &format!(
            "2026-01-01T00:00:00Z {sha} cc=? engine=smoke phase=implement attempt=0 result={result} lint=0 test=0 spec=0 files=1\n"
        ),
    );
}

#[test]
fn phase_guard_refuses_the_write_that_starts_a_run_where_the_engine_cannot_run_and_leaves_nothing_armed()
 {
    let repo = make_repo(RepoOpts {
        no_contract: true,
        phase: " ",
        ..Default::default()
    });
    let r = start_run(&repo);
    expect_status(&r, 2, "a run was started in a repository with no contract");
    must_match(
        "Nothing has started",
        &r.stderr,
        "the denial does not say that nothing is armed",
    );
    assert!(
        !exists(state_path(&repo, "phase.session")),
        "a refused start sealed the phase to the session anyway"
    );
}

/// A start that skips the seal is a run no gate owns (ADR-017).
#[test]
fn phase_guard_lets_a_run_start_where_the_engine_can_run_and_seals_it() {
    let repo = repo_in(" ");
    expect_status(&start_run(&repo), 0, "a valid repository was refused a run");
    assert_eq!(
        read(state_path(&repo, "phase.session")),
        "session-a",
        "the start of a run was not sealed to the session that wrote it"
    );
}

/// From idle it would be a run nobody started and no gate capped.
#[test]
fn phase_guard_denies_blocked_outside_a_run_too_it_is_the_gates_alone() {
    let repo = make_repo(RepoOpts {
        no_contract: true,
        phase: " ",
        ..Default::default()
    });
    expect_status(
        &run_hook("phase-guard", phase_write_by(&repo, "", "blocked"), &repo),
        2,
        "a tool wrote blocked from idle",
    );
}

// ---- a change the base branch already has is not this run's (ADR-032)

#[test]
fn phase_guard_refuses_to_start_a_run_over_a_change_the_base_branch_already_has() {
    let repo = repo_in(" ");
    parked_on_base(&repo, "");
    let r = start_run(&repo);
    expect_status(
        &r,
        2,
        "a run started with specflow/parked/ inherited from the base",
    );
    must_match(
        "specflow/parked/",
        &r.stderr,
        "the refusal does not name the folder",
    );
    must_not_match(
        "spec-flow init",
        &r.stderr,
        "the refusal sends the human to init, which fixes nothing here",
    );
}

#[test]
fn phase_guard_lets_a_run_start_over_a_change_this_branch_created_the_one_a_resume_picks_up() {
    let repo = repo_in(" ");
    git_quiet(&repo, &["checkout", "-q", "-b", "feature"]);
    change_folder(&repo, "mine");
    expect_status(
        &start_run(&repo),
        0,
        "a resume of this branch's own change was refused",
    );
}

/// git quotes a non-ASCII name; read quoted, the base's folder matches nothing.
#[test]
fn phase_guard_refuses_to_start_over_a_change_the_base_has_under_a_non_ascii_name() {
    let repo = repo_in(" ");
    parked_on_base(&repo, "añadir-exportación");
    expect_status(
        &start_run(&repo),
        2,
        "a run started over specflow/añadir-exportación/ inherited from the base",
    );
}

/// A setting a hook would refuse mid-run is refused before anything is armed.
#[test]
fn phase_guard_refuses_to_start_over_settings_a_hook_would_refuse() {
    for (name, settings, names) in [
        (
            "a cap that is not a whole number of calls",
            r#"{"max_architect_calls":"three"}"#,
            "max_architect_calls",
        ),
        (
            "a cap of null",
            r#"{"max_opus_calls":null}"#,
            "max_opus_calls",
        ),
        (
            "a file that does not parse",
            r#"{ "max_opus_calls": 2, }"#,
            "does not parse as JSON",
        ),
        (
            "a route to an agent this plugin does not ship",
            r#"{"agents":{"plannr":"sonnet"}}"#,
            "plannr",
        ),
    ] {
        let repo = repo_in(" ");
        write(repo.join(".claude/spec-flow.config.json"), settings);
        let r = start_run(&repo);
        expect_status(&r, 2, &format!("a run started over {name}"));
        assert!(
            r.stderr.contains(names),
            "{name}: the refusal does not name what to fix: {}",
            r.stderr
        );
        must_not_match(
            "spec-flow init",
            &r.stderr,
            "the refusal sends the human to init, which does not write this file",
        );
        assert!(
            !exists(state_path(&repo, "phase.session")),
            "{name}: a refused start sealed the phase anyway"
        );
    }
}

#[test]
fn phase_guard_refuses_to_start_over_a_settings_file_it_cannot_read() {
    let repo = repo_in(" ");
    std::fs::create_dir_all(repo.join(".claude/spec-flow.config.json")).unwrap();
    let r = start_run(&repo);
    expect_status(&r, 2, "a run started over a settings file no hook can read");
    must_match(
        "could not be read",
        &r.stderr,
        "the refusal does not say the file could not be read",
    );
}

#[test]
fn phase_guard_lets_a_run_start_with_caps_and_a_routing_every_hook_can_apply() {
    let repo = repo_in(" ");
    write(
        repo.join(".claude/spec-flow.config.json"),
        "\u{feff}{\"max_opus_calls\":\"4\",\"max_architect_calls\":0,\"agents\":{\"architect\":\"fable\"}}",
    );
    expect_status(
        &start_run(&repo),
        0,
        "a run was refused over settings every hook applies",
    );
}

#[test]
fn phase_guard_leaves_the_phase_files_siblings_alone() {
    let repo = make_repo(RepoOpts::default());
    let r = run_hook(
        "phase-guard",
        json!({"tool_name": "Write", "tool_input": {"file_path": state_path(&repo, "phase.session"), "content": "abc123def456"}}),
        &repo,
    );
    expect_status(
        &r,
        0,
        "a write to phase.session was judged as a phase write",
    );
}

/// A start this hook cannot read goes through to preflight (ADR-028); the
/// blind-spot log says the guard was bypassed, outside a run too.
#[test]
fn phase_guard_records_a_start_it_could_not_read() {
    let repo = make_repo(RepoOpts {
        no_contract: true,
        phase: " ",
        ..Default::default()
    });
    run_hook(
        "phase-guard",
        bash("printf 'spec' | tee .claude/state/phase"),
        &repo,
    );
    assert!(
        read(state_path(&repo, "phase-guard-unmatched.log")).contains("tee"),
        "an unreadable start left no line in phase-guard-unmatched.log"
    );
}

/// The value is read as the shell writes it and the phase reader reads it
/// back — printf's escapes applied, trimmed.
#[test]
fn phase_guard_refuses_a_start_written_with_a_trailing_newline_where_the_engine_cannot_run() {
    for c in [
        r"printf 'spec\n' > .claude/state/phase",
        r#"printf "spec\n" > .claude/state/phase"#,
        r"echo -e 'spec\n' > .claude/state/phase",
    ] {
        let repo = make_repo(RepoOpts {
            no_contract: true,
            no_git: true,
            phase: "idle",
            ..Default::default()
        });
        let r = run_hook("phase-guard", bash(c), &repo);
        expect_status(&r, 2, &format!("{c} started a run the engine cannot run"));
        must_match("Nothing has started", &r.stderr, "not refused as a start");
    }
}

#[test]
fn phase_guard_judges_a_done_written_with_a_trailing_newline_as_done() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    let r = run_hook(
        "phase-guard",
        bash(r"printf 'done\n' > .claude/state/phase"),
        &repo,
    );
    expect_status(&r, 2, "an unearned done went through");
    must_match(
        "gate has not passed",
        &r.stderr,
        "it was not judged as a done",
    );
    must_not_match(
        "not a phase this engine knows",
        &r.stderr,
        "it was denied as an unknown phase",
    );
}

/// Each escape writes a byte, and a phase holding one is no phase any hook
/// reads: let through, the write would disarm the run it claims.
#[test]
fn phase_guard_refuses_an_escape_that_writes_a_byte_no_phase_holds() {
    for c in [
        r"printf 'implement\a' > .claude/state/phase",
        r"printf 'implement\e' > .claude/state/phase",
        r"printf 'implement\b' > .claude/state/phase",
        r"printf '\0' > .claude/state/phase",
        r"printf 'implement\007' > .claude/state/phase",
        r"printf 'implement\x07' > .claude/state/phase",
        r"echo -e 'implement\a' > .claude/state/phase",
    ] {
        let repo = repo_in("plan");
        expect_status(
            &run_hook("phase-guard", bash(c), &repo),
            2,
            &format!("{c} wrote a phase no hook reads"),
        );
    }
}

#[test]
fn phase_guard_takes_a_literal_backslash_bash_echo_writes_for_no_phase() {
    let repo = make_repo(RepoOpts {
        no_contract: true,
        no_git: true,
        phase: "idle",
        ..Default::default()
    });
    let r = run_hook(
        "phase-guard",
        bash(r"echo 'spec\n' > .claude/state/phase"),
        &repo,
    );
    expect_status(
        &r,
        0,
        r"bash's echo writes `spec\n` literally, which arms nothing",
    );
}

/// Mid-run each hook applies what it can (ADR-028, ADR-049).
#[test]
fn settings_mid_run() {
    let repo = make_repo(RepoOpts::default());
    let cfg = repo.join(".claude/spec-flow.config.json");
    write(&cfg, r#"{ "max_opus_calls": 8, }"#);
    for agent in ["spec-flow:implementer", "Explore"] {
        expect_status(
            &run_hook(
                "preflight",
                json!({"tool_name": "Agent", "tool_input": {"subagent_type": agent}}),
                &repo,
            ),
            0,
            &format!("preflight denied {agent} over a file every hook reads as the defaults"),
        );
    }
    expect_status(
        &run_hook(
            "opus-budget",
            json!({"tool_name": "Agent", "tool_input": {"subagent_type": "planner"}}),
            &repo,
        ),
        0,
        "the planner was denied under the default cap",
    );
    write(&cfg, r#"{"max_architect_calls":"three"}"#);
    expect_status(
        &run_hook(
            "preflight",
            json!({"tool_name": "Agent", "tool_input": {"subagent_type": "Explore"}}),
            &repo,
        ),
        0,
        "preflight denied an unrelated agent over the architect's cap",
    );
    expect_status(
        &run_hook(
            "opus-budget",
            json!({"tool_name": "Agent", "tool_input": {"subagent_type": "architect"}}),
            &repo,
        ),
        2,
        "the architect went through under a cap no count can reach",
    );
}

#[test]
fn preflight_refuses_a_spawn_while_a_change_the_base_branch_has_is_live() {
    let repo = repo_in("plan");
    parked_on_base(&repo, "");
    let r = run_hook(
        "preflight",
        json!({"tool_name": "Agent", "tool_input": {"subagent_type": "planner"}}),
        &repo,
    );
    expect_status(
        &r,
        2,
        "a spawn went through with specflow/parked/ from the base live",
    );
    must_match(
        "a change the base branch already has",
        &r.stderr,
        "the refusal is not headed with what failed",
    );
}

#[test]
fn preflight_past_a_runs_first_agent_says_how_to_pick_the_run_up() {
    let repo = make_repo(RepoOpts::default());
    parked_on_base(&repo, "");
    let r = run_hook(
        "preflight",
        json!({"tool_name": "Agent", "tool_input": {"subagent_type": "implementer"}}),
        &repo,
    );
    expect_status(
        &r,
        2,
        "a spawn went through with specflow/parked/ from the base live",
    );
    must_match(
        "/spec-flow:resume",
        &r.stderr,
        "a run under way is told only to start again",
    );
    must_not_match(
        "(?m)^Nothing has run yet",
        &r.stderr,
        "it says nothing has run, mid-run",
    );
}

pub fn phase_bash(value: &str) -> Value {
    bash(&format!("printf '{value}' > .claude/state/phase"))
}

/// This branch ships add-export, ADDING REQ-USER-002; specs/ declares ids,
/// and a test ran for each.
fn shipped_export(repo: &Path, ids: &[&str]) -> Output {
    git_quiet(repo, &["checkout", "-q", "-b", "feature"]);
    let ops: Vec<String> = ids
        .iter()
        .map(|id| format!("out=tests/user.spec.ts::{id} x"))
        .collect();
    let heads: String = ids
        .iter()
        .map(|id| format!("### {id} — a thing\n\n"))
        .collect();
    let cmd = tool_json(&ops.iter().map(String::as_str).collect::<Vec<_>>());
    edit_contract(repo, |c| c["trace"]["executed_tests"] = cmd);
    write(
        repo.join("specs/user.md"),
        &format!("<!-- spec-scope: modules/user -->\n\n# User\n\n{heads}"),
    );
    write(
        repo.join("specflow/archive/add-export/spec.md"),
        "# Spec — add export\n\n**Status:** SHIPPED 2026-10-17\n\n## Requirement deltas\n- ADDED REQ-USER-002 — the user can export their data\n",
    );
    seed_gate_history(repo, "pass");
    run_hook("phase-guard", phase_write_by(repo, "", "done"), repo)
}

#[test]
fn done_refusal_says_a_change_the_base_branch_has_is_not_this_runs_to_fold() {
    let repo = make_repo(RepoOpts::default());
    parked_on_base(&repo, "");
    seed_gate_history(&repo, "pass");
    let r = run_hook("phase-guard", phase_write_by(&repo, "", "done"), &repo);
    expect_status(&r, 2, "done was allowed over an unarchived change");
    assert!(
        r.stderr
            .contains("parked (the base branch has it: not this run's change)"),
        "the refusal does not say the folder is not this run's: {}",
        r.stderr
    );
}

/// spec-trace binds only what specs/ declares (ADR-048).
#[test]
fn phase_guard_refuses_done_over_a_shipped_change_of_this_branch_whose_added_id_never_reached_specs()
 {
    let repo = make_repo(RepoOpts::default());
    let r = shipped_export(&repo, &["REQ-USER-001"]);
    expect_status(
        &r,
        2,
        "done was allowed over a shipped requirement no spec declares",
    );
    assert!(
        r.stderr
            .contains("REQ-USER-002 is ADDED by specflow/archive/add-export/spec.md"),
        "the refusal does not name the id and the change: {}",
        r.stderr
    );
}

#[test]
fn phase_guard_allows_done_once_the_added_id_is_in_specs_with_a_test_that_ran() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &shipped_export(&repo, &["REQ-USER-001", "REQ-USER-002"]),
        0,
        "a run whose shipped requirement is declared and proven was refused",
    );
}

#[test]
fn phase_guard_denies_a_phase_outside_the_closed_set() {
    let repo = make_repo(RepoOpts::default());
    let r = run_hook("phase-guard", phase_bash("triage"), &repo);
    expect_status(&r, 2, "an invented phase was allowed");
    must_match(
        "(?i)closed set",
        &r.stderr,
        "the denial does not explain the vocabulary",
    );
}

#[test]
fn phase_guard_denies_an_invented_phase_written_with_write_not_just_bash() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook("phase-guard", phase_write_by(&repo, "", "verify"), &repo),
        2,
        "a Write of an unknown phase was allowed",
    );
}

#[test]
fn phase_guard_allows_every_phase_the_orchestrator_writes_mid_run() {
    let repo = make_repo(RepoOpts::default());
    for v in ["spec", "plan", "review", "implement"] {
        expect_status(
            &run_hook("phase-guard", phase_bash(v), &repo),
            0,
            &format!("{v} is in the vocabulary and was denied"),
        );
    }
}

#[test]
fn phase_guard_does_not_deny_a_command_that_merely_reads_the_phase_file() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook("phase-guard", bash("cat .claude/state/phase"), &repo),
        0,
        "reading the phase file was denied",
    );
}

/// The blind spot it cannot see into, made observable — the program, never
/// its content.
#[test]
fn phase_guard_lets_an_unreadable_write_through_and_records_that_it_did() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "phase-guard",
            bash("printf 'done' | tee .claude/state/phase"),
            &repo,
        ),
        0,
        "a form the guard cannot read was denied",
    );
    let body = read(state_path(&repo, "phase-guard-unmatched.log"));
    must_match(r"\btee\b", &body, "the log does not name what got past");
    must_not_match("done", &body, "the log captured the command's content");
}

#[test]
fn phase_guard_does_not_record_a_command_that_only_reads_the_phase_file() {
    let repo = make_repo(RepoOpts::default());
    for c in [
        "cat .claude/state/phase",
        "cat .claude/state/phase | grep implement",
    ] {
        run_hook("phase-guard", bash(c), &repo);
    }
    must_not_match(
        r"\bcat\b",
        &read(state_path(&repo, "phase-guard-unmatched.log")),
        "a read was logged as an unreadable write",
    );
}

#[test]
fn phase_guard_denies_done_with_an_unarchived_specflow_folder() {
    let repo = make_repo(RepoOpts::default());
    std::fs::create_dir_all(repo.join("specflow/my-change")).unwrap();
    let r = run_hook("phase-guard", phase_bash("done"), &repo);
    expect_status(&r, 2, "done with an unarchived folder");
    must_match("unarchived", &r.stderr, "no unarchived in the denial");
}

#[test]
fn phase_guard_allows_an_earned_done() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "pass");
    expect_status(
        &run_hook("phase-guard", phase_bash("done"), &repo),
        0,
        "an earned done was denied",
    );
}

// ---- a run does not end itself without a verdict (ADR-022)

#[test]
fn phase_guard_denies_done_while_the_gate_has_not_passed_the_current_commit() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    let r = run_hook("phase-guard", phase_bash("done"), &repo);
    expect_status(
        &r,
        2,
        "done was allowed over a commit whose last verdict was fail:behaviour",
    );
    must_match(
        "gate has not passed",
        &r.stderr,
        "the denial does not say what is missing",
    );
}

/// After a `cd` the file is named relative to it.
#[test]
fn phase_guard_reads_a_phase_write_made_after_a_cd() {
    let repo = make_repo(RepoOpts::default());
    seed_gate_history(&repo, "fail:behaviour");
    for c in [
        "cd .claude/state && printf done > phase",
        "cd .claude; echo done > state/phase",
        "cd .claude && cd state && printf done > phase",
        "cd .claude/state && printf 'done' > ./phase",
        "cd .claude/state/ && printf done > phase",
        "cd .claude/ && printf done > state/phase",
        r#"cd "$CLAUDE_PROJECT_DIR"/.claude/state && printf done > phase"#,
        "cd ${CLAUDE_PROJECT_DIR}/.claude/state/ && printf done > phase",
        r#"cd ".claude/state" && printf done > phase"#,
        "(cd .claude/state && printf done > phase)",
        r#"cd "My Projects/app/.claude/state" && printf done > phase"#,
        "cd .claude/state || exit 1; printf done > phase",
        "cd .claude/state\nprintf done > phase",
        r#"printf done > "/Users/First Last/app/.claude/state/phase""#,
        "echo done >| .claude/state/phase",
    ] {
        expect_status(
            &run_hook("phase-guard", bash(c), &repo),
            2,
            &format!("`{c}` wrote an unearned done"),
        );
    }
}

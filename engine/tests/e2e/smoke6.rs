//! model-route, stale-resume, orchestrator-scope (ADR-034), dispatch-guard
//! (ADR-035), this flow's agents outside a run (ADR-040, ADR-044), a case 3
//! waiting for a human (ADR-036), and the config and check commands.

use std::path::Path;
use std::time::{Duration, SystemTime};

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;
use crate::smoke2::write_change;
use crate::smoke3::{any_line, non_empty_lines};
use crate::smoke4::write_phase;
use crate::smoke5::engage_implementer;

/// model-route's rewritten input, or Null when it emitted nothing.
fn routed(r: &Output) -> Value {
    serde_json::from_str::<Value>(r.stdout.trim())
        .map(|v| v["hookSpecificOutput"]["updatedInput"].clone())
        .unwrap_or(Value::Null)
}

fn with_routing(repo: &Path, agents: Value) {
    write(
        repo.join(".claude/spec-flow.config.json"),
        &json!({"max_opus_calls": 6, "agents": agents}).to_string(),
    );
}

/// A tier the reviewer does not ship with, read off the frontmatter under
/// test: routing there is a re-route whatever its tier becomes.
fn reviewer_elsewhere() -> &'static str {
    let text = read(engine_dir().join("agents/reviewer.md"));
    let shipped = Regex::new(r"(?m)^model:[ \t]*(\S+)")
        .unwrap()
        .captures(&text)
        .map(|m| m[1].to_string());
    ["haiku", "sonnet", "opus"]
        .into_iter()
        .find(|t| shipped.as_deref() != Some(t))
        .unwrap()
}

pub fn agent_spawn(typ: &str, extra: Value) -> Value {
    let mut input = json!({"subagent_type": typ});
    merge(&mut input, extra);
    json!({"tool_name": "Agent", "tool_input": input})
}

fn model_route(repo: &Path, p: Value, attended: &str) -> Output {
    let mut h = Hook::default();
    if !attended.is_empty() {
        h.env = vec![format!("CLAUDE_CODE_SESSION_ATTENDED={attended}")];
    }
    h.run("model-route", p, repo)
}

#[test]
fn model_route_leaves_the_model_alone_when_the_project_declares_no_routing() {
    let repo = make_repo(RepoOpts::default());
    let r = model_route(&repo, agent_spawn("planner", json!({})), "");
    expect_status(&r, 0, "model-route");
    assert!(
        routed(&r).get("model").is_none(),
        "set a model for a repo that configured nothing: {}",
        r.stdout
    );
}

/// ADR-023: a foreground spawn blocks the chat with no sign of progress.
#[test]
fn model_route_runs_every_spawn_of_this_plugin_in_the_background() {
    let repo = make_repo(RepoOpts::default());
    let r = model_route(
        &repo,
        agent_spawn(
            "spec-flow:spec-writer",
            json!({"prompt": "x", "run_in_background": false}),
        ),
        "1",
    );
    let input = routed(&r);
    assert!(
        input["run_in_background"] == true && input["prompt"] == "x",
        "the spawn was left in the foreground, or lost its input: {}",
        r.stdout
    );
}

/// `claude -p` terminates background agents 600 s after its turn ends.
#[test]
fn model_route_leaves_an_unattended_session_in_the_foreground() {
    let repo = make_repo(RepoOpts::default());
    let spawn = agent_spawn("spec-flow:spec-writer", json!({"prompt": "x"}));
    assert!(
        routed(&model_route(&repo, spawn.clone(), "0"))["run_in_background"] != true,
        "an unattended spawn was sent to the background"
    );
    with_routing(&repo, json!({"spec-writer": "opus"}));
    let input = routed(&model_route(&repo, spawn, "0"));
    assert!(
        input["model"] == "opus" && input["run_in_background"] != true,
        "want opus in the foreground, got {input}"
    );
}

#[test]
fn model_route_rewrites_the_spawn_the_project_re_routed() {
    let elsewhere = reviewer_elsewhere();
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"reviewer": elsewhere}));
    let input = routed(&model_route(
        &repo,
        agent_spawn("reviewer", json!({"prompt": "x"})),
        "",
    ));
    assert!(
        input["model"] == elsewhere && input["prompt"] == "x",
        "want model {elsewhere} with the input kept, got {input}"
    );
}

#[test]
fn model_route_sends_the_architect_to_fable_when_the_project_routes_it_there() {
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"architect": "fable"}));
    let input = routed(&model_route(
        &repo,
        agent_spawn(
            "spec-flow:architect",
            json!({"prompt": "Which port owns this?"}),
        ),
        "",
    ));
    assert!(
        input["model"] == "fable" && input["prompt"] == "Which port owns this?",
        "got {input}"
    );
}

#[test]
fn model_route_leaves_the_model_of_an_agent_the_project_did_not_re_route_alone() {
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"reviewer": reviewer_elsewhere()}));
    assert!(
        routed(&model_route(&repo, agent_spawn("planner", json!({})), ""))
            .get("model")
            .is_none(),
        "re-routed a spawn nobody re-routed"
    );
}

#[test]
fn model_route_treats_restating_the_shipped_default_as_no_re_route() {
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"planner": "opus"}));
    assert!(
        routed(&model_route(&repo, agent_spawn("planner", json!({})), ""))
            .get("model")
            .is_none(),
        "reported a change nobody made"
    );
    assert!(
        !exists(state_path(&repo, "model-routes.log")),
        "logged a re-route nobody made"
    );
}

#[test]
fn model_route_denies_a_routing_block_naming_an_agent_that_does_not_exist() {
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"reviwer": "sonnet"}));
    let r = model_route(&repo, agent_spawn("reviewer", json!({})), "");
    expect_status(&r, 2, "a name nothing matches routes nothing");
    must_match(
        "reviwer",
        &r.stderr,
        "denied without naming the entry that is wrong",
    );
    must_match(
        "reviewer",
        &r.stderr,
        "denied without naming the agents that do exist",
    );
}

#[test]
fn model_route_denies_a_full_model_id_where_the_tool_call_would_have() {
    let repo = make_repo(RepoOpts::default());
    with_routing(
        &repo,
        json!({"reviewer": (["claude", "haiku", "4-5"].join("-"))}),
    );
    expect_status(
        &model_route(&repo, agent_spawn("reviewer", json!({})), ""),
        2,
        "a pinned id fails the spawn's own schema",
    );
}

#[test]
fn model_route_reads_a_routing_written_after_a_byte_order_mark_and_denies_the_entry_that_is_wrong()
{
    let repo = make_repo(RepoOpts::default());
    write(
        repo.join(".claude/spec-flow.config.json"),
        "\u{feff}{\"agents\":{\"reviwer\":\"sonnet\"}}",
    );
    let r = model_route(&repo, agent_spawn("reviewer", json!({})), "");
    expect_status(&r, 2, "behind a byte-order mark the routing was never read");
    must_match(
        "reviwer",
        &r.stderr,
        "denied without naming the entry that is wrong",
    );
}

#[test]
fn model_route_reads_a_file_that_is_not_a_json_object_as_no_routing_and_does_not_crash_on_it() {
    let repo = make_repo(RepoOpts::default());
    for text in ["null", "[]", "6"] {
        write(repo.join(".claude/spec-flow.config.json"), text);
        let r = model_route(&repo, agent_spawn("reviewer", json!({})), "");
        expect_status(&r, 0, text);
        must_not_match(
            "hook error",
            &r.stderr,
            &format!("{text}: the hook crashed"),
        );
    }
}

#[test]
fn model_route_passes_through_an_agent_this_plugin_does_not_ship() {
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"reviewer": reviewer_elsewhere()}));
    let r = model_route(&repo, agent_spawn("general-purpose", json!({})), "");
    expect_status(&r, 0, "an unrelated agent must never be touched");
    assert!(
        r.stdout.trim().is_empty(),
        "rewrote a spawn that is none of this plugin's business"
    );
}

#[test]
fn model_route_does_not_block_unrelated_work_over_its_own_broken_config() {
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"reviwer": "sonnet"}));
    expect_status(
        &model_route(&repo, agent_spawn("general-purpose", json!({})), ""),
        0,
        "a broken routing block blocked unrelated work",
    );
}

#[test]
fn model_route_applies_outside_a_run_unlike_the_budget() {
    let repo = repo_in("idle");
    with_routing(&repo, json!({"architect": "sonnet"}));
    assert!(
        routed(&model_route(&repo, agent_spawn("architect", json!({})), ""))["model"] == "sonnet",
        "a one-off question to the architect ignored the routing"
    );
}

#[test]
fn model_route_leaves_a_deduped_trace_of_what_it_re_routed() {
    let elsewhere = reviewer_elsewhere();
    let repo = make_repo(RepoOpts::default());
    with_routing(&repo, json!({"reviewer": elsewhere}));
    model_route(&repo, agent_spawn("reviewer", json!({})), "");
    model_route(&repo, agent_spawn("reviewer", json!({})), "");
    let lines = non_empty_lines(&read(state_path(&repo, "model-routes.log")));
    assert!(
        lines.len() == 1 && lines[0].contains(&format!("reviewer -> {elsewhere}")),
        "want one line naming the re-route, got {lines:?}"
    );
}

pub struct OnDisk<'a> {
    pub id: &'a str,
    pub typ: &'a str,
    pub ttl: &'a str,
    pub context: i64,
    pub age_min: f64,
}

impl Default for OnDisk<'_> {
    fn default() -> Self {
        OnDisk {
            id: "a0123456789abcdef",
            typ: "spec-flow:spec-writer",
            ttl: "5m",
            context: 206_000,
            age_min: 0.0,
        }
    }
}

/// The shape a run leaves: the session transcript, and beside it the agent's
/// own with its .meta.json, last written age_min ago.
pub fn subagent_on_disk(repo: &Path, o: OnDisk) -> Value {
    let session = repo.join("sess.jsonl");
    write(&session, "");
    let dir = repo.join("sess/subagents");
    let file = dir.join(format!("agent-{}.jsonl", o.id));
    let mut split = json!({"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 0});
    split[format!("ephemeral_{}_input_tokens", o.ttl)] = json!(998);
    let usage = json!({"input_tokens": 2, "cache_read_input_tokens": o.context - 1000, "cache_creation_input_tokens": 998, "cache_creation": split});
    write(&file, &(json!({"type": "assistant", "isSidechain": true, "message": {"id": "msg_1", "model": "model-alpha", "usage": usage}}).to_string() + "\n"));
    write(
        dir.join(format!("agent-{}.meta.json", o.id)),
        &json!({"agentType": o.typ}).to_string(),
    );
    age(&file, Duration::from_secs_f64(o.age_min * 60.0));
    json!({"transcript_path": session, "tool_name": "SendMessage", "tool_input": {"to": o.id, "message": "close the gap", "summary": "close the gap"}})
}

fn on_disk(typ: &str, age_min: f64) -> OnDisk<'_> {
    OnDisk {
        typ,
        age_min,
        ..Default::default()
    }
}

#[test]
fn stale_resume_denies_resuming_an_agent_whose_cache_expired_and_says_the_cost_and_the_way_out() {
    let repo = make_repo(RepoOpts::default());
    let r = run_hook(
        "stale-resume",
        subagent_on_disk(
            &repo,
            OnDisk {
                age_min: 30.0,
                ..Default::default()
            },
        ),
        &repo,
    );
    expect_status(&r, 2, "a 30-minute-old spec-writer was resumed");
    must_match(
        "206k",
        &r.stderr,
        "the denial does not say what the resume would have re-sent",
    );
    must_match(
        "NEW spec-writer",
        &r.stderr,
        "the denial does not name the way out",
    );
}

#[test]
fn stale_resume_lets_a_warm_agent_or_another_plugins_be_resumed() {
    for (name, o) in [
        (
            "lets a warm agent be resumed",
            OnDisk {
                age_min: 1.0,
                ..Default::default()
            },
        ),
        (
            "reads the TTL off the agent: a 1-hour cache at 30 minutes is warm",
            OnDisk {
                age_min: 30.0,
                ttl: "1h",
                ..Default::default()
            },
        ),
        (
            "leaves an agent that is not this plugin's alone",
            OnDisk {
                age_min: 30.0,
                typ: "Explore",
                ..Default::default()
            },
        ),
    ] {
        let repo = make_repo(RepoOpts::default());
        expect_status(
            &run_hook("stale-resume", subagent_on_disk(&repo, o), &repo),
            0,
            name,
        );
    }
}

#[test]
fn stale_resume_stands_down_outside_a_run() {
    let repo = repo_in("idle");
    expect_status(
        &run_hook(
            "stale-resume",
            subagent_on_disk(
                &repo,
                OnDisk {
                    age_min: 30.0,
                    ..Default::default()
                },
            ),
            &repo,
        ),
        0,
        "a message outside any run was denied",
    );
}

#[test]
fn stale_resume_allows_a_recipient_it_cannot_see() {
    let repo = make_repo(RepoOpts::default());
    let mut p = subagent_on_disk(
        &repo,
        OnDisk {
            age_min: 30.0,
            ..Default::default()
        },
    );
    p["tool_input"] = json!({"to": "someone-else", "message": "x"});
    expect_status(
        &run_hook("stale-resume", p, &repo),
        0,
        "a message was denied over a transcript that does not exist",
    );
}

#[test]
fn opus_budget_charges_a_warm_planner_resume_and_not_one_stale_resume_denies() {
    let repo = make_repo(RepoOpts::default());
    write(
        state_path(&repo, "agent-registry"),
        "a0123456789abcdef planner\n",
    );
    run_hook(
        "opus-budget",
        subagent_on_disk(&repo, on_disk("spec-flow:planner", 30.0)),
        &repo,
    );
    assert_eq!(
        counter_of(&repo, "opus_calls"),
        "0",
        "a resume stale-resume denies was charged"
    );
    run_hook(
        "opus-budget",
        subagent_on_disk(&repo, on_disk("spec-flow:planner", 1.0)),
        &repo,
    );
    assert_eq!(
        counter_of(&repo, "opus_calls"),
        "1",
        "a warm planner resume was charged wrongly"
    );
}

#[test]
fn opus_budget_denies_a_warm_planner_resume_while_its_cap_is_not_a_number_of_calls() {
    let repo = make_repo(RepoOpts::default());
    write(
        state_path(&repo, "agent-registry"),
        "a0123456789abcdef planner\n",
    );
    write(
        repo.join(".claude/spec-flow.config.json"),
        r#"{"max_opus_calls":"six"}"#,
    );
    let r = run_hook(
        "opus-budget",
        subagent_on_disk(&repo, on_disk("spec-flow:planner", 1.0)),
        &repo,
    );
    expect_status(
        &r,
        2,
        "a resume went through under a cap no count can reach",
    );
    must_match(
        "max_opus_calls",
        &r.stderr,
        "the denial does not name the key",
    );
}

// ---- the orchestrator routes, and a hook keeps it routing (ADR-034) ------

fn attributed(repo: &Path) {
    write(
        state_path(repo, "run-trace.log"),
        &format!(
            "2026-01-01T00:00:00Z phase=implement session=s read file={} agent_id=writer1\n",
            repo.join("specs/user.md").display()
        ),
    );
}

fn scope(repo: &Path, p: Value) -> Output {
    run_hook("orchestrator-scope", p, repo)
}

fn session_write(repo: &Path, rel: &str) -> Output {
    scope(
        repo,
        json!({"session_id": "s", "tool_name": "Write", "tool_input": {"file_path": repo.join(rel), "content": "x"}}),
    )
}

fn session_read(repo: &Path, path: &Path) -> Output {
    scope(
        repo,
        json!({"session_id": "s", "tool_name": "Read", "tool_input": {"file_path": path}}),
    )
}

fn session_bash(repo: &Path, cmd: &str) -> Output {
    scope(
        repo,
        json!({"session_id": "s", "tool_name": "Bash", "tool_input": {"command": cmd}}),
    )
}

fn armed() -> Dir {
    let repo = make_repo(RepoOpts::default());
    attributed(&repo);
    repo
}

#[test]
fn orchestrator_scope_denies_the_session_writing_code_during_a_run_and_names_who_does_it() {
    let repo = armed();
    let r = session_write(&repo, "lib/a.ts");
    expect_status(&r, 2, "the session wrote lib/a.ts mid-run");
    must_match(
        "implementer",
        &r.stderr,
        "the denial does not route the work",
    );
}

#[test]
fn orchestrator_scope_lets_a_subagent_write_code() {
    let repo = armed();
    expect_status(
        &scope(
            &repo,
            json!({"session_id": "s", "agent_id": "impl1", "tool_name": "Edit", "tool_input": {"file_path": repo.join("lib/a.ts"), "old_string": "a", "new_string": "b"}}),
        ),
        0,
        "an implementer's edit was denied",
    );
}

#[test]
fn orchestrator_scope_lets_the_session_write_its_state_and_the_change_folder() {
    let repo = armed();
    for rel in [".claude/state/gate_attempts", "specflow/my-change/spec.md"] {
        expect_status(
            &session_write(&repo, rel),
            0,
            &format!("the session was denied {rel}"),
        );
    }
}

#[test]
fn orchestrator_scope_denies_the_session_reading_code_and_lets_it_read_specs_the_change_the_root_docs_and_anything_outside()
 {
    let repo = armed();
    expect_status(
        &session_read(&repo, &repo.join("lib/a.ts")),
        2,
        "the session read lib/a.ts mid-run",
    );
    for p in [
        repo.join("specs/user.md"),
        repo.join("specflow/my-change/spec.md"),
        repo.join("CLAUDE.md"),
        std::env::temp_dir().join("elsewhere/commands/spec-flow.md"),
    ] {
        expect_status(
            &session_read(&repo, &p),
            0,
            &format!("the session was denied {}", p.display()),
        );
    }
}

#[test]
fn orchestrator_scope_reads_each_bash_command_by_where_it_writes() {
    for (name, cmds, want) in [
        (
            "denies a Bash move of a human's plan out of specflow/",
            vec!["git mv specflow/city-gym docs/backlog/city-gym"],
            2,
        ),
        (
            "denies a redirect or a sed -i into code",
            vec!["echo x > lib/a.ts", "sed -i 's/a/b/' lib/a.ts"],
            2,
        ),
        (
            "lets the session's own Bash steps through",
            vec![
                "printf 0 > .claude/state/gate_attempts && printf 0 > .claude/state/opus_calls && printf 0 > .claude/state/architect_calls && spec-flow telemetry --mark",
                r#"git add -A && git commit -m "move lib/a.ts into lib/b" && git push"#,
                "git mv specflow/my-change specflow/archive/my-change",
                "spec-flow stats 2>&1 > /dev/null",
            ],
            0,
        ),
        // A quoted `>` read as a redirect denied a real run's milestone commit.
        (
            "reads quoted text as text, not as a redirect or a second command",
            vec![
                r#"git add -A && git commit -m "map RETURNED_TO_SENDER -> RETURNED" && git push"#,
                "git commit -m \"feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nRefs: #12\"",
                "git commit -m 'run lint; rm lib/a.ts is not run' && git push",
                r#"git commit -m "a | tee lib/a.ts, and a << b" && git push"#,
            ],
            0,
        ),
        (
            "still denies a redirect into code after quoted text, and one whose target is quoted",
            vec![
                r#"git log -1 --format="%s -> %b" > lib/a.ts"#,
                r#"echo hi > "lib/my file.ts""#,
                r#"printf "a > b" | tee lib/a.ts"#,
            ],
            2,
        ),
        // Quoting read as text must not hide a write.
        (
            "reads a write to code handed to a shell, past an escaped quote or after a heredoc",
            vec![
                "sh -c 'echo x > lib/a.ts'",
                r#"eval "echo x > lib/a.ts""#,
                r#"git commit -m "a \"b" && echo x > lib/a.ts && echo "c""#,
                "cat > specflow/notes.md <<'EOF'\nnotes\nEOF\necho x > lib/a.ts",
            ],
            2,
        ),
        (
            "reads a heredoc body and a comment as text",
            vec![
                "git commit -F - <<'EOF'\nmap RETURNED_TO_SENDER -> RETURNED\nEOF",
                "tee specflow/notes.md <<'EOF'\nrm lib/a.ts; echo x > lib/b.ts\nEOF",
                "git status # then echo x > lib/a.ts",
            ],
            0,
        ),
        (
            "denies the session writing a log the hooks decide on",
            vec![
                r#"echo "x prompt from=human" >> .claude/state/human-turn.log"#,
                "printf 'x result=pass ' >> .claude/state/gate-history.log",
            ],
            2,
        ),
    ] {
        let repo = armed();
        for cmd in cmds {
            expect_status(&session_bash(&repo, cmd), want, &format!("{name}: `{cmd}`"));
        }
    }
}

#[test]
fn orchestrator_scope_denies_a_write_over_a_log_the_hooks_decide_on() {
    let repo = armed();
    expect_status(
        &session_write(&repo, ".claude/state/run-trace.log"),
        2,
        "a Write over run-trace.log went through",
    );
}

/// The same reader as phase-guard's: a write after a cd lands under it.
#[test]
fn orchestrator_scope_reads_a_write_after_a_cd_where_it_lands() {
    let repo = armed();
    expect_status(
        &session_bash(
            &repo,
            "cd .claude/state && printf 0 > gate_attempts && printf 0 > opus_calls",
        ),
        0,
        "the session's counter reset after a cd was denied",
    );
    expect_status(
        &session_bash(&repo, "cd lib/deep && printf x > ../a.ts"),
        2,
        "a write into lib/ after a cd went through",
    );
}

#[test]
fn orchestrator_scope_stands_down_outside_a_run() {
    let repo = armed();
    set_phase(&repo, "idle");
    expect_status(
        &session_write(&repo, "lib/a.ts"),
        0,
        "an edit outside any run was denied",
    );
}

#[test]
fn orchestrator_scope_stands_down_until_the_trace_shows_this_build_attributes_calls_and_says_so() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &session_write(&repo, "lib/a.ts"),
        0,
        "it denied with no evidence that subagent calls carry an agent_id",
    );
    assert!(
        exists(state_path(&repo, "orchestrator-scope-unmatched.log")),
        "it stood down without recording why"
    );
}

// ---- what the orchestrator dispatches, recorded before it is denied (ADR-035)

fn dispatches(repo: &Path) -> Vec<String> {
    trace_text(repo)
        .split('\n')
        .filter(|l| l.contains(" dispatch "))
        .map(String::from)
        .collect()
}

fn spawn_to(repo: &Path, typ: &str, prompt: &str, extra: Value) -> Output {
    let mut p = json!({"session_id": "s", "tool_name": "Agent", "tool_input": {"subagent_type": typ, "description": "x", "prompt": prompt}});
    merge(&mut p, extra);
    run_hook("dispatch-guard", p, repo)
}

const IMPL_ORDER: &str =
    "Implement specflow/my-change/milestones/M1.md; the approach is in specflow/my-change/plan.md.";

fn first(lines: &[String]) -> String {
    lines.first().cloned().unwrap_or_default()
}

#[test]
fn arm_gate_arms_on_a_message_that_resumes_the_implementer_by_its_id() {
    let repo = repo_in("blocked");
    expect_status(
        &run_hook(
            "arm-gate",
            subagent_on_disk(&repo, on_disk("spec-flow:implementer", 1.0)),
            &repo,
        ),
        0,
        "arm-gate",
    );
    assert_eq!(
        phase_of(&repo),
        "implement",
        "the implementer was put back to work with the gate disarmed"
    );
}

#[test]
fn arm_gate_records_each_time_it_arms_the_gate_for_the_orchestrator() {
    let repo = repo_in("plan");
    run_hook(
        "arm-gate",
        json!({"session_id": "s", "tool_name": "Agent", "tool_input": {"subagent_type": "implementer", "prompt": IMPL_ORDER}}),
        &repo,
    );
    must_match(
        " phase=plan .*dispatch agent=implementer tool=Agent result=armed why=phase",
        &first(&dispatches(&repo)),
        "no record of the backstop arming",
    );
}

#[test]
fn dispatch_guard_records_an_agent_put_to_work_in_a_phase_the_commands_do_not_dispatch_it_in_and_lets_it_through()
 {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &spawn_to(&repo, "spec-flow:reviewer", "", json!({})),
        0,
        "a recorded dispatch was denied",
    );
    must_match(
        " phase=implement .*dispatch agent=reviewer tool=Agent result=record why=phase",
        &first(&dispatches(&repo)),
        "no record of a reviewer mid-implement",
    );
}

#[test]
fn dispatch_guard_records_an_implementer_handed_more_than_its_work_order_or_less() {
    let repo = make_repo(RepoOpts::default());
    spawn_to(
        &repo,
        "spec-flow:implementer",
        &format!(
            "{IMPL_ORDER} Start from lib/orders/place.ts and read specflow/my-change/spec.md."
        ),
        json!({}),
    );
    spawn_to(
        &repo,
        "spec-flow:implementer",
        "Implement specflow/my-change/plan.md.",
        json!({}),
    );
    let d = dispatches(&repo);
    assert_eq!(d.len(), 2, "want two lines, got {d:?}");
    must_match(
        r"why=other-files files=lib/orders/place\.ts,specflow/my-change/spec\.md",
        &d[0],
        "files beyond the work order were not recorded",
    );
    must_match(
        "why=no-milestone",
        &d[1],
        "an implementer with no milestone was not recorded",
    );
}

#[test]
fn dispatch_guard_records_a_message_to_an_agent_this_session_never_spawned() {
    let repo = make_repo(RepoOpts::default());
    let mut p = subagent_on_disk(&repo, on_disk("spec-flow:implementer", 1.0));
    p["tool_input"]["to"] = json!("b0123456789abcdef");
    run_hook("dispatch-guard", p, &repo);
    must_match(
        "dispatch agent=- tool=SendMessage result=record why=unknown-target to=b0123456789abcdef",
        &first(&dispatches(&repo)),
        "no record of a message to nobody",
    );
}

#[test]
fn dispatch_guard_records_an_agent_that_is_not_this_flow_put_to_work_mid_run() {
    let repo = make_repo(RepoOpts::default());
    spawn_to(
        &repo,
        "Explore",
        "read lib/ and summarize the orders module",
        json!({}),
    );
    must_match(
        "dispatch agent=Explore tool=Agent result=record why=not-this-flow",
        &first(&dispatches(&repo)),
        "no record of a general agent mid-run",
    );
}

/// Guards: what the commands dispatch, as they write it, leaves no line.
#[test]
fn dispatch_guard_leaves_no_line_for_the_commands_own_dispatches() {
    let repo = make_repo(RepoOpts::default());
    set_phase(&repo, "spec");
    spawn_to(
        &repo,
        "spec-flow:spec-writer",
        "MODE=TRIAGE the login fails",
        json!({}),
    );
    set_phase(&repo, "review");
    spawn_to(&repo, "spec-flow:planner", "MODE=CONSULT", json!({}));
    set_phase(&repo, "implement");
    spawn_to(&repo, "spec-flow:implementer", IMPL_ORDER, json!({}));
    spawn_to(
        &repo,
        "spec-flow:implementer",
        &format!(
            "{} and {}, with .claude/state/gate-failure.log",
            repo.join("specflow/my-change/plan.md").display(),
            repo.join("specflow/my-change/milestones/M2.md").display()
        ),
        json!({}),
    );
    spawn_to(
        &repo,
        "spec-flow:architect",
        "Which port owns this?",
        json!({}),
    );
    spawn_to(
        &repo,
        "spec-flow:spec-writer",
        "MODE=FOLD specflow/my-change/spec.md",
        json!({}),
    );
    run_hook(
        "dispatch-guard",
        subagent_on_disk(&repo, on_disk("spec-flow:implementer", 1.0)),
        &repo,
    );
    let d = dispatches(&repo);
    assert!(
        d.is_empty(),
        "the commands' own dispatches were recorded:\n{}",
        d.join("\n")
    );
}

#[test]
fn dispatch_guard_leaves_a_subagents_call_and_another_flows_agent_outside_a_run_alone() {
    let repo = make_repo(RepoOpts::default());
    spawn_to(&repo, "Explore", "", json!({"agent_id": "impl1"}));
    set_phase(&repo, "idle");
    spawn_to(&repo, "Explore", "", json!({}));
    spawn_to(&repo, "code-reviewer", "review my diff", json!({}));
    // A bare name is a person's own agent: the harness namespaces this plugin's.
    spawn_to(&repo, "reviewer", "review my diff", json!({}));
    spawn_to(&repo, "other-plugin:planner", "plan this", json!({}));
    spawn_to(
        &repo,
        "spec-flow:planner",
        "plan this",
        json!({"agent_id": "impl1"}),
    );
    let mut p = subagent_on_disk(&repo, on_disk("spec-flow:implementer", 1.0));
    p["tool_input"]["to"] = json!("b0123456789abcdef");
    run_hook("dispatch-guard", p, &repo);
    let d = dispatches(&repo);
    assert!(
        d.is_empty(),
        "recorded outside the orchestrator's run:\n{}",
        d.join("\n")
    );
}

// ---- this flow's agent with no run phase (ADR-040), and the implementer (ADR-044)

fn implementer_call() -> Value {
    json!({"session_id": "s", "tool_name": "Agent", "tool_input": {"subagent_type": "spec-flow:implementer", "prompt": "strengthen tests/a.spec.ts"}})
}

#[test]
fn dispatch_guard_records_this_flows_agent_put_to_work_with_no_run_phase_and_lets_it_through() {
    let repo = repo_in("done");
    expect_status(
        &spawn_to(
            &repo,
            "spec-flow:planner",
            "Plan specflow/my-change/spec.md",
            json!({}),
        ),
        0,
        "a recorded dispatch was denied",
    );
    spawn_to(
        &repo,
        "spec-flow:reviewer",
        "Review specflow/my-change/plan.md",
        json!({}),
    );
    set_phase(&repo, "idle");
    spawn_to(
        &repo,
        "spec-flow:spec-writer",
        "add a refund endpoint",
        json!({}),
    );
    std::fs::remove_file(state_path(&repo, "phase")).unwrap();
    spawn_to(
        &repo,
        "spec-flow:Architect",
        "Which port owns this?",
        json!({}),
    );
    let d = dispatches(&repo);
    for (phase, agent) in [
        ("done", "planner"),
        ("done", "reviewer"),
        ("idle", "spec-writer"),
        ("-", "architect"),
    ] {
        assert!(
            any_line(
                &d,
                &format!(
                    " phase={phase} .*dispatch agent={agent} tool=Agent result=record why=no-run$"
                )
            ),
            "no record of the {agent} put to work with phase {phase:?}:\n{}",
            d.join("\n")
        );
    }
    assert_eq!(d.len(), 4, "expected four lines:\n{}", d.join("\n"));
}

#[test]
fn dispatch_guard_records_a_message_to_this_flows_agent_with_no_run_phase() {
    let repo = repo_in("done");
    run_hook(
        "dispatch-guard",
        subagent_on_disk(&repo, on_disk("spec-flow:spec-writer", 1.0)),
        &repo,
    );
    must_match(
        " phase=done .*dispatch agent=spec-writer tool=SendMessage result=record why=no-run$",
        &first(&dispatches(&repo)),
        "no record of the message",
    );
}

#[test]
fn arm_gate_denies_this_flows_implementer_outside_a_run_and_says_what_to_run_instead() {
    let repo = repo_in("done");
    for ph in ["done", "idle"] {
        set_phase(&repo, ph);
        let r = run_hook("arm-gate", implementer_call(), &repo);
        expect_status(&r, 2, &format!("an implementer was put to work on {ph}"));
        must_match("/spec-fix", &r.stderr, "the denial does not name /spec-fix");
    }
    expect_status(
        &run_hook(
            "arm-gate",
            subagent_on_disk(&repo, on_disk("spec-flow:implementer", 1.0)),
            &repo,
        ),
        2,
        "a message resumed an implementer on idle",
    );
    // dispatch-guard runs on the same call: the denial is recorded once, by arm-gate.
    run_hook("dispatch-guard", implementer_call(), &repo);
    let d = dispatches(&repo);
    assert_eq!(
        d.len(),
        3,
        "want three denials, one per call:\n{}",
        d.join("\n")
    );
    for l in &d {
        must_match(
            r" dispatch agent=implementer tool=\w+ result=deny why=no-run$",
            l,
            "not a denial",
        );
    }
}

#[test]
fn arm_gate_leaves_outside_a_run_a_persons_own_implementer_the_architect_and_a_repo_with_no_phase()
{
    let repo = repo_in("done");
    for typ in ["implementer", "spec-flow:architect"] {
        expect_status(
            &run_hook("arm-gate", agent_spawn(typ, json!({"prompt": "x"})), &repo),
            0,
            &format!("{typ} was denied on done"),
        );
    }
    std::fs::remove_file(state_path(&repo, "phase")).unwrap();
    expect_status(
        &run_hook("arm-gate", implementer_call(), &repo),
        0,
        "an implementer was denied in a repo with no phase",
    );
}

#[test]
fn arm_gate_leaves_alone_a_repository_that_committed_claude_state() {
    let repo = make_repo(RepoOpts {
        phase: "done",
        commit_phase: true,
        ..Default::default()
    });
    expect_status(
        &run_hook("arm-gate", implementer_call(), &repo),
        0,
        "denied over a phase the repository committed",
    );
}

#[test]
fn dispatch_guard_appends_nothing_outside_a_run_to_a_claude_state_the_repository_committed() {
    let repo = make_repo(RepoOpts {
        phase: "done",
        commit_phase: true,
        ..Default::default()
    });
    spawn_to(
        &repo,
        "spec-flow:architect",
        "Which port owns this?",
        json!({}),
    );
    assert!(
        !exists(state_path(&repo, "run-trace.log")),
        "a committed phase file was taken for a run the engine kept:\n{}",
        trace_text(&repo)
    );
    std::fs::remove_file(state_path(&repo, "phase")).unwrap();
    write(state_path(&repo, "run-trace.log"), "shipped\n");
    git_quiet(&repo, &["add", "-f", "--", ".claude/state/run-trace.log"]);
    git_quiet(
        &repo,
        &["commit", "-q", "-m", "a log this repository committed"],
    );
    spawn_to(
        &repo,
        "spec-flow:architect",
        "Which port owns this?",
        json!({}),
    );
    assert_eq!(
        trace_text(&repo),
        "shipped\n",
        "a line was appended to a log the repository committed"
    );
}

#[test]
fn dispatch_guard_writes_a_phase_outside_the_vocabulary_as_one_field() {
    let repo = repo_in("done");
    set_phase(&repo, "x\necho from-the-phase-file\n#");
    spawn_to(
        &repo,
        "spec-flow:architect",
        "Which port owns this?",
        json!({}),
    );
    let lines = non_empty_lines(&trace_text(&repo));
    assert!(
        lines.len() == 1 && matches(" phase=xechofrom-the-phase-file# .*why=no-run$", &lines[0]),
        "the phase file's text split the line:\n{}",
        trace_text(&repo)
    );
}

#[test]
fn dispatch_guard_leaves_a_repository_the_engine_never_ran_in_without_a_claude_state() {
    let dir = temp_dir();
    run_hook(
        "dispatch-guard",
        json!({"session_id": "s", "tool_name": "Agent", "tool_input": {"subagent_type": "spec-flow:planner", "prompt": "x"}}),
        &dir,
    );
    assert!(
        !exists(dir.join(".claude")),
        "a spawn outside any run created .claude/ in a repository the engine never ran in"
    );
}

// ---- a case 3 waits for a human's answer (ADR-036) -------------------------

const CORRECTION: &str = "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — now right\n";

fn turn_log(repo: &Path, minutes_ago: f64, event: &str) {
    let at = SystemTime::now() - Duration::from_secs_f64(minutes_ago * 60.0);
    append_to(
        state_path(repo, "human-turn.log"),
        &format!("{} {event}\n", iso_ms(at)),
    );
}

/// The session ended its turn, then a person typed.
fn answered_at(repo: &Path, minutes_ago: f64) {
    turn_log(repo, minutes_ago + 0.5, "turn-end");
    turn_log(repo, minutes_ago, "prompt from=human");
}

fn correction_brief(repo: &Path, written_minutes_ago: f64) {
    write_change(repo, CORRECTION, false, "");
    write(
        repo.join("specflow/my-change/plan.md"),
        "# Plan — my-change\n",
    );
    age(
        repo.join("specflow/my-change/spec.md"),
        Duration::from_secs_f64(written_minutes_ago * 60.0),
    );
}

#[test]
fn phase_guard_holds_a_case_3_in_spec_until_a_human_has_answered_since_the_brief_was_written() {
    let repo = repo_in("spec");
    answered_at(&repo, 10.0);
    correction_brief(&repo, 5.0);
    let r = write_phase(&repo, "implement");
    expect_status(
        &r,
        2,
        "implement was written over a correction no human answered",
    );
    must_not_match(
        "human-turn|turn-end",
        &r.stderr,
        "the denial names the record instead of asking for the answer",
    );
    must_match(
        "REQ-USER-001",
        &r.stderr,
        "the denial does not name the correction",
    );
    must_match(
        "end your turn",
        &r.stderr,
        "the denial does not name the stop",
    );
}

#[test]
fn arm_gate_does_not_engage_the_implementer_over_a_case_3_no_human_has_answered() {
    let repo = repo_in("spec");
    answered_at(&repo, 10.0);
    correction_brief(&repo, 5.0);
    for ph in ["spec", "implement"] {
        set_phase(&repo, ph);
        expect_status(
            &engage_implementer(&repo),
            2,
            &format!("{ph}: the implementer was engaged over a correction no human answered"),
        );
        assert_eq!(
            phase_of(&repo),
            ph,
            "{ph}: the denied engagement still moved the phase"
        );
    }
}

/// The triage's own report-back fires the prompt hook after the brief.
#[test]
fn a_prompt_with_no_turn_end_after_the_brief_or_a_harness_notification_is_not_an_answer() {
    let repo = repo_in("spec");
    turn_log(&repo, 8.0, "turn-end");
    correction_brief(&repo, 5.0);
    turn_log(&repo, 2.0, "prompt from=human");
    expect_status(
        &write_phase(&repo, "implement"),
        2,
        "a prompt without a stop after the brief counted as an answer",
    );
    turn_log(&repo, 1.5, "turn-end");
    turn_log(&repo, 1.0, "prompt from=task-notification");
    expect_status(
        &write_phase(&repo, "implement"),
        2,
        "a task notification counted as a person's answer",
    );
}

#[test]
fn human_turn_records_turn_ends_prompts_by_source_and_answered_questions_and_nothing_where_the_engine_was_never_adopted()
 {
    let repo = make_repo(RepoOpts::default());
    let hook = |mut p: Value, at: &Path| {
        p["session_id"] = json!("s");
        run_hook("human-turn", p, at);
    };
    hook(
        json!({"hook_event_name": "UserPromptSubmit", "prompt": "yes, the requirement was wrong"}),
        &repo,
    );
    hook(
        json!({"hook_event_name": "UserPromptSubmit", "prompt": "<task-notification>\n<task-id>a1</task-id>"}),
        &repo,
    );
    hook(
        json!({"hook_event_name": "UserPromptSubmit", "prompt": "<pasted_content id=\"p1\">\nlog\n</pasted_content> ok"}),
        &repo,
    );
    hook(json!({"hook_event_name": "Stop"}), &repo);
    hook(
        json!({"hook_event_name": "PostToolUse", "tool_name": "AskUserQuestion", "tool_input": {}, "tool_response": {}}),
        &repo,
    );
    let got: Vec<String> = non_empty_lines(&read(state_path(&repo, "human-turn.log")))
        .iter()
        .map(|l| l.split_once(' ').unwrap().1.to_string())
        .collect();
    assert_eq!(
        got,
        [
            "prompt from=human",
            "prompt from=task-notification",
            "prompt from=human",
            "turn-end",
            "prompt from=question"
        ]
    );
    assert!(
        !read(state_path(&repo, "human-turn.log")).contains("requirement was wrong"),
        "the record copied what the person said"
    );
    let bare = temp_dir();
    hook(
        json!({"hook_event_name": "UserPromptSubmit", "prompt": "hi"}),
        &bare,
    );
    assert!(
        !exists(bare.join(".claude")),
        "it wrote state into a repository that never adopted the engine"
    );
}

// Guards: an answered case 3 goes on, and a build that never records an
// answer is not held forever.

#[test]
fn a_case_3_goes_on_once_a_human_has_answered_since_the_brief_typed_after_a_turn_end_or_through_a_question()
 {
    let repo = repo_in("spec");
    correction_brief(&repo, 5.0);
    answered_at(&repo, 1.0);
    expect_status(
        &write_phase(&repo, "implement"),
        0,
        "implement was denied after the human answered",
    );
    expect_status(
        &engage_implementer(&repo),
        0,
        "the implementer was denied after the human answered",
    );
    correction_brief(&repo, 0.5);
    turn_log(&repo, 0.2, "prompt from=question");
    expect_status(
        &engage_implementer(&repo),
        0,
        "an answered question did not count",
    );
}

#[test]
fn the_case_3_check_stands_down_and_says_so_where_no_answer_was_ever_recorded() {
    let repo = repo_in("spec");
    correction_brief(&repo, 5.0);
    expect_status(
        &write_phase(&repo, "implement"),
        0,
        "a build with no recorded answer held the case 3",
    );
    assert!(
        exists(state_path(&repo, "human-turn-unmatched.log")),
        "it stood down without recording why"
    );
}

/// The contract as the hooks read it, for a person inspecting it.
#[test]
fn config_shows_the_contract_as_the_hooks_read_it() {
    let repo = make_repo(RepoOpts::default());
    let r = run(
        &repo,
        &["CLAUDE_PROJECT_DIR="],
        "",
        &cli_argv(engine_dir(), &["config"]),
    );
    expect_status(&r, 0, "a contract that loads");
    must_match(
        "spec-flow config: OK — contract v1, read from file",
        &r.out(),
        "the contract it read",
    );
    must_match(r"(?m)^  scope: \*\.ts$", &r.out(), "the scope it read");
    write(repo.join(".spec-flow/config.json"), "{ not json");
    let r = run(
        &repo,
        &["CLAUDE_PROJECT_DIR="],
        "",
        &cli_argv(engine_dir(), &["config"]),
    );
    assert_ne!(
        r.status,
        0,
        "a contract that does not parse was shown as read: {}",
        r.out()
    );
}

/// With no report-only linter declared, `--no-fix` has nothing to run: the
/// changed files are never the command, and the check never reads green.
#[test]
fn check_no_fix_with_no_report_only_linter() {
    let repo = make_repo(RepoOpts {
        contract_edit: Some(&|c: &mut Value| {
            c["verify"].as_object_mut().unwrap().remove("lint_no_fix");
            c["verify"]["scope_globs"] = json!(["*.sh"]);
        }),
        ..Default::default()
    });
    git(&repo, &["checkout", "-q", "-b", "feature"]);
    write(repo.join("scripts/deploy.sh"), "");
    write_mode(
        &repo.join("scripts/deploy.sh"),
        b"#!/bin/sh\ntouch DEPLOY-SCRIPT-RAN\n",
        0o755,
    );
    git(&repo, &["add", "-A"]);
    git(&repo, &["commit", "-qm", "work"]);
    let r = run(
        &repo,
        &["CLAUDE_PROJECT_DIR="],
        "",
        &cli_argv(engine_dir(), &["check", "--no-fix"]),
    );
    assert!(
        !exists(repo.join("DEPLOY-SCRIPT-RAN")),
        "a changed file ran as the linter:\n{}",
        r.out()
    );
    assert_ne!(
        r.status,
        0,
        "check --no-fix passed with no linter run:\n{}",
        r.out()
    );
    must_match(
        "lint_no_fix",
        &r.out(),
        "the refusal does not name the field to declare",
    );
}

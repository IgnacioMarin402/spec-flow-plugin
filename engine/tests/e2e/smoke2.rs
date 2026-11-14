//! agent-gate: a return the orchestrator cannot route is sent back (ADR-031),
//! what a spec-writer hands back (ADR-030), and the manifest's entries run
//! as written.

use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;
use crate::runner_output::*;

pub fn gate_return(repo: &Path, extra: Value) -> Output {
    run_hook("agent-gate", subagent_stop(extra), repo)
}

pub fn write_change(repo: &Path, body: &str, proposal: bool, slug: &str) {
    let slug = if slug.is_empty() { "my-change" } else { slug };
    write(repo.join("specflow").join(slug).join("spec.md"), body);
    if proposal {
        write(
            repo.join("specflow").join(slug).join("proposal.md"),
            "# Proposal — x\n",
        );
    }
}

// ---- agent-gate: a return the orchestrator cannot route is sent back (ADR-031)

#[test]
fn agent_gate_sends_back_a_first_reply_with_no_status_and_an_undeclared_status() {
    let repo = repo_in("review");
    for (reply, why) in [
        ("Looks fine to me.", "no-status"),
        ("STATUS: SPEC_READY", "undeclared-status"),
    ] {
        let r = gate_return(
            &repo,
            json!({"agent_id": format!("a-{why}"), "last_assistant_message": reply}),
        );
        assert!(
            r.status == 0 && r.blocked(),
            "{reply:?} was not sent back (exit {}): {}",
            r.status,
            r.out()
        );
        must_match(
            &format!(
                "agent-check agent=spec-flow:reviewer result=block why={why} agent_id=a-{why}"
            ),
            &trace_text(&repo),
            "no agent-check line",
        );
    }
}

#[test]
fn agent_gate_lets_an_empty_reply_through_and_records_it() {
    let repo = repo_in("review");
    let r = gate_return(&repo, json!({"last_assistant_message": ""}));
    assert!(!r.blocked(), "an empty reply was sent back: {}", r.stdout);
    must_match("result=skip why=empty", &trace_text(&repo), "no skip line");
}

#[test]
fn agent_gate_lets_a_resumed_agent_answer_in_prose() {
    let repo = repo_in("implement");
    write(
        state_path(&repo, "run-trace.log"),
        "2026-01-01T00:00:00Z phase=implement agent type=spec-flow:implementer status=IMPLEMENTED agent_id=impl1\n",
    );
    let r = gate_return(
        &repo,
        json!({"agent_type": "spec-flow:implementer", "agent_id": "impl1", "last_assistant_message": "Fixed both lint violations in lib/a.ts."}),
    );
    assert!(
        !r.blocked(),
        "a resumed implementer's prose answer was sent back: {}",
        r.stdout
    );
}

#[test]
fn agent_gate_reads_a_status_and_a_path_the_way_a_model_decorates_them() {
    let repo = repo_in("plan");
    write(repo.join("specflow/x/plan.md"), "# Plan\n");
    for (i, reply) in [
        "**STATUS:** PLAN_READY\n**PLAN_PATH:** specflow/x/plan.md",
        "STATUS: PLAN_READY\nPLAN_PATH: specflow/x/plan.md (index + 3 milestones)",
        "STATUS: PLAN_READY\nPLAN_PATH: [plan.md](specflow/x/plan.md)",
        "Round two; the last one ended with STATUS: NEEDS_INPUT.\n\nSTATUS: PLAN_READY\nPLAN_PATH: `specflow/x/plan.md`",
    ]
    .into_iter()
    .enumerate()
    {
        let r = gate_return(&repo, json!({"agent_type": "spec-flow:planner", "agent_id": format!("p{i}"), "last_assistant_message": reply}));
        assert!(!r.blocked(), "a well-formed return was sent back: {reply:?} -> {}", r.stdout);
    }
}

#[test]
fn agent_gate_sends_back_a_path_to_a_file_that_is_not_there_and_passes_one_that_is() {
    let repo = repo_in("plan");
    let mut plan = json!({"agent_type": "spec-flow:planner", "last_assistant_message": "```\nSTATUS: PLAN_READY\nPLAN_PATH: specflow/x/plan.md\n```"});
    let r = gate_return(&repo, plan.clone());
    assert!(
        r.blocked() && r.stdout.contains("PLAN_PATH"),
        "a missing PLAN_PATH was not sent back: {}",
        r.stdout
    );
    write(repo.join("specflow/x/plan.md"), "# Plan\n");
    plan["agent_id"] = json!("another-agent");
    let r = gate_return(&repo, plan);
    assert!(
        !r.blocked(),
        "an existing PLAN_PATH was sent back: {}",
        r.stdout
    );
}

#[test]
fn agent_gate_passes_a_declared_status_and_writes_nothing() {
    let repo = repo_in("review");
    let r = gate_return(
        &repo,
        json!({"last_assistant_message": "STATUS: APPROVED\nNOTES: none"}),
    );
    assert!(
        r.status == 0 && r.stdout.is_empty(),
        "a declared status was not let through (exit {}): {}",
        r.status,
        r.stdout
    );
    must_not_match(
        "agent-check",
        &trace_text(&repo),
        "a clean return left a line",
    );
}

#[test]
fn agent_gate_sends_an_agent_back_at_most_twice_then_lets_it_through_and_says_so() {
    let repo = repo_in("review");
    for n in 1..=2 {
        assert!(
            gate_return(&repo, json!({"last_assistant_message": "no block"})).blocked(),
            "block {n} did not happen"
        );
    }
    assert!(
        !gate_return(
            &repo,
            json!({"last_assistant_message": "no block", "stop_hook_active": true})
        )
        .blocked(),
        "a third stop was sent back: the cap is two"
    );
    must_match(
        "result=cap why=no-status",
        &trace_text(&repo),
        "the cap left no line",
    );
}

#[test]
fn agent_gate_with_no_agent_id_blocks_only_a_first_stop() {
    let repo = repo_in("review");
    let no_id = |extra: Value| {
        let mut p = subagent_stop(extra);
        p.as_object_mut().unwrap().remove("agent_id");
        run_hook("agent-gate", p, &repo)
    };
    assert!(
        no_id(json!({"last_assistant_message": "STATUS: SPEC_READY"})).blocked(),
        "a first stop was let through"
    );
    assert!(
        !no_id(json!({"last_assistant_message": "STATUS: SPEC_READY", "stop_hook_active": true}))
            .blocked(),
        "a stop the hook already continued was sent back again, with nothing to count blocks by"
    );
    assert!(
        !no_id(json!({"last_assistant_message": "prose"})).blocked(),
        "prose with no agent id was judged as a first reply"
    );
}

/// ADR-017 keeps the owner check to hooks certain to run in the sealing session.
#[test]
fn agent_gate_judges_a_return_whatever_session_sealed_the_phase() {
    let repo = repo_in("review");
    write(state_path(&repo, "phase.session"), "someone-else");
    assert!(
        gate_return(
            &repo,
            json!({"last_assistant_message": "STATUS: SPEC_READY"})
        )
        .blocked(),
        "the owner seal stood the agent gate down"
    );
}

#[test]
fn agent_gate_leaves_alone_another_plugins_agent_and_a_return_outside_a_run() {
    let repo = repo_in("review");
    for typ in ["spec-writer", "other:reviewer", "spec-flow:nobody"] {
        assert!(
            !gate_return(
                &repo,
                json!({"agent_type": typ, "last_assistant_message": "prose"})
            )
            .blocked(),
            "{typ} was judged against spec-flow's contracts"
        );
    }
    set_phase(&repo, "idle");
    assert!(
        !gate_return(&repo, json!({"last_assistant_message": "prose"})).blocked(),
        "a return outside any run was sent back"
    );
}

#[test]
fn agent_gate_that_crashes_lets_the_return_through() {
    let repo = repo_in("review");
    let engine = copy_engine();
    std::fs::remove_file(engine.join("agents/reviewer.md")).unwrap();
    std::fs::create_dir_all(engine.join("agents/reviewer.md")).unwrap(); // reading it fails
    let r = Hook {
        engine: Some(engine.to_path_buf()),
        ..Default::default()
    }
    .run(
        "agent-gate",
        subagent_stop(json!({"last_assistant_message": "prose"})),
        &repo,
    );
    must_match("hook error", &r.stderr, "the crash path was not reached");
    assert!(
        r.status == 0 && !r.blocked(),
        "a crash blocked the agent (exit {}): {}",
        r.status,
        r.stdout
    );
}

// ---- agent-gate: what a spec-writer hands back (ADR-030) ------------------

pub fn writer_spec(deltas: &str) -> String {
    format!(
        "# Spec — my-change: x\n\n## Requirement deltas\n{deltas}\n\n## Assumptions\n- none\n\n## Out of scope\n- nothing\n"
    )
}

pub fn spec_ready(extra: Value) -> Value {
    let mut p = json!({"agent_type": "spec-flow:spec-writer", "agent_id": "writer1",
        "last_assistant_message": "```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/my-change/spec.md\nPROPOSAL_PATH: specflow/my-change/proposal.md\nSUMMARY: x\n```"});
    merge(&mut p, extra);
    p
}

/// specs/ with its contract and one capability, and the change.
pub fn writer_repo(repo: &Path, deltas: &str) {
    let deltas = if deltas.is_empty() {
        "- ADDED REQ-USER-002 — another thing"
    } else {
        deltas
    };
    write(repo.join("specs/README.md"), "# specs\n");
    write(
        repo.join("specs/user.md"),
        "<!-- spec-scope: lib/user -->\n### REQ-USER-001 — a thing\n",
    );
    write_change(repo, &writer_spec(deltas), true, "");
}

pub fn read_by(repo: &Path, agent_id: &str, files: &[&str]) {
    let mut b = String::new();
    for f in files {
        b += &format!(
            "2026-01-01T00:00:00Z phase=spec session=spawner-session read file={} agent_id={agent_id}\n",
            repo.join(f).display()
        );
    }
    write(state_path(repo, "run-trace.log"), &b);
}

pub const TRIAGED_CASE3: &str = "STATUS: TRIAGED\nCASE: 3\nSPEC_PATH: specflow/my-change/spec.md";
pub const WORK_ORDER: &str =
    "\nPLAN_PATH: specflow/my-change/plan.md\nWORK_ORDER_PATH: specflow/my-change/milestones/M1.md";

/// A fix brief and the work order its triage writes (ADR-033).
pub fn write_fix(repo: &Path, with_order: bool) {
    write_change(
        repo,
        "# Fix — my-change\n\n## Case\n3 SPEC-WRONG\n\n## Requirement deltas\n- CHANGED REQ-USER-001 (correction) — now right\n",
        false,
        "",
    );
    if with_order {
        write(
            repo.join("specflow/my-change/plan.md"),
            "# Plan — my-change\n",
        );
        write(
            repo.join("specflow/my-change/milestones/M1.md"),
            "# M1\n- Skills: none\n",
        );
    }
}

fn retriage(repo: &Path) -> Output {
    writer_repo(repo, "");
    write_change(
        repo,
        "# Fix — my-change\n\n## Case\n2 WEAK-TEST\n\n## Requirement deltas\n- none — the test was incomplete\n",
        false,
        "",
    );
    write(
        repo.join("specflow/my-change/plan.md"),
        "# Plan\n\none milestone: M1\n",
    );
    write(repo.join("specflow/my-change/milestones/M1.md"), "# M1\n");
    write(
        repo.join("specflow/archive/My-Change/spec.md"),
        "# Fix — My-Change\n\n**Status:** REJECTED 2026-07-30\n\n## Requirement deltas\n- none\n",
    );
    gate_return(
        repo,
        json!({"agent_type": "spec-flow:spec-writer",
        "last_assistant_message": "STATUS: TRIAGED\nCASE: 2 WEAK-TEST\nSPEC_PATH: specflow/my-change/spec.md\nPLAN_PATH: specflow/my-change/plan.md\nWORK_ORDER_PATH: specflow/my-change/milestones/M1.md"}),
    )
}

#[test]
fn spec_writer_holds_a_needs_input_round_to_one_to_three_questions_options_not_counted() {
    let repo = repo_in("spec");
    let ask = |items: &[&str]| {
        gate_return(
            &repo,
            json!({"agent_type": "spec-flow:spec-writer", "agent_id": format!("w{}", items.len()), "last_assistant_message": format!("STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n{}", items.join("\n"))}),
        )
    };
    let r = ask(&["- a?", "- b?", "- c?", "- d?"]);
    assert!(
        r.blocked() && r.stdout.contains("at most 3"),
        "four questions were let through: {}",
        r.stdout
    );
    assert!(
        ask(&[]).blocked(),
        "a NEEDS_INPUT with no question was let through"
    );
    let r = ask(&["- a?", "  - (1) this", "  - (2) that", "- b?", "- c?"]);
    assert!(
        !r.blocked(),
        "three questions with options were sent back: {}",
        r.stdout
    );
}

#[test]
fn spec_writer_sends_back_a_spec_ready_whose_spec_phase_guard_would_not_let_leave_spec() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write_change(
        &repo,
        &writer_spec("- ADDED REQ-USER-002 — x").replacen("## Assumptions\n- none\n\n", "", 1),
        true,
        "",
    );
    read_by(&repo, "writer1", &["specs/README.md", "specs/user.md"]);
    let r = gate_return(&repo, spec_ready(json!({})));
    assert!(
        r.blocked() && r.stdout.contains("## Assumptions"),
        "a spec with no Assumptions was let through: {}",
        r.stdout
    );
}

#[test]
fn spec_writer_sends_back_a_changed_or_removed_on_an_id_specs_never_declared() {
    let repo = repo_in("spec");
    writer_repo(
        &repo,
        "- CHANGED REQ-USER-009 (wording) — clearer\n- REMOVED REQ-USER-001 — gone",
    );
    read_by(&repo, "writer1", &["specs/README.md", "specs/user.md"]);
    let r = gate_return(&repo, spec_ready(json!({})));
    assert!(
        r.blocked() && r.stdout.contains("CHANGED REQ-USER-009"),
        "an unknown CHANGED id was let through: {}",
        r.stdout
    );
    must_not_match(
        "REMOVED REQ-USER-001",
        &r.stdout,
        "a declared REMOVED id was reported",
    );
}

#[test]
fn spec_writer_sends_back_a_spec_ready_written_without_reading_the_capability_its_deltas_touch() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    read_by(&repo, "writer1", &["specs/README.md"]);
    let r = gate_return(&repo, spec_ready(json!({})));
    assert!(
        r.blocked() && r.stdout.contains("specs/user.md") && !r.stdout.contains("README"),
        "the unread capability was not the one named: {}",
        r.stdout
    );
    read_by(&repo, "writer1", &["specs/README.md", "specs/user.md"]);
    let r = gate_return(&repo, spec_ready(json!({})));
    assert!(
        !r.blocked(),
        "a spec-writer that read both was sent back: {}",
        r.stdout
    );
}

/// token-trace takes agent ids from transcript names, not tool payloads.
#[test]
fn spec_writer_does_not_take_a_token_line_as_proof_that_reads_are_attributed() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write(
        state_path(&repo, "run-trace.log"),
        &format!(
            "2026-01-01T00:00:00Z phase=spec read file={}\n2026-01-01T00:00:01Z phase=spec tokens model=m sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=2 agent_id=writer1\n",
            repo.join("specs/user.md").display()
        ),
    );
    let r = gate_return(&repo, spec_ready(json!({})));
    assert!(
        !r.blocked(),
        "reads with no agent id were judged: {}",
        r.stdout
    );
}

#[test]
fn spec_writer_does_not_demand_a_read_of_another_capability_for_a_new_one() {
    let repo = repo_in("spec");
    writer_repo(&repo, "- ADDED REQ-USER-PROFILE-001 — a profile");
    read_by(&repo, "writer1", &["specs/README.md"]);
    let r = gate_return(&repo, spec_ready(json!({})));
    assert!(
        !r.blocked(),
        "specs/user.md was demanded for REQ-USER-PROFILE-001: {}",
        r.stdout
    );
}

#[test]
fn spec_writer_lets_a_case_5_brief_through_it_is_rejected_not_built() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write_change(
        &repo,
        "# Fix — my-change\n\n## Case\n5 NOT-A-FIX\n\n## Requirement deltas\n- CHANGED REQ-USER-001 — would stop cascading\n",
        false,
        "",
    );
    let r = gate_return(
        &repo,
        json!({"agent_type": "spec-flow:spec-writer", "last_assistant_message": "STATUS: TRIAGED\nCASE: 5 NOT-A-FIX\nSPEC_PATH: specflow/my-change/spec.md"}),
    );
    assert!(
        !r.blocked(),
        r#"a case 5 brief was held to "ready to build": {}"#,
        r.stdout
    );
}

#[test]
fn spec_writer_sends_back_a_case_5_brief_named_like_an_archived_change() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write_change(
        &repo,
        "# Fix — my-change\n\n## Case\n5 NOT-A-FIX\n\n## Requirement deltas\n- none\n",
        false,
        "",
    );
    write(
        repo.join("specflow/archive/my-change/spec.md"),
        "# Fix — my-change\n\n**Status:** REJECTED 2026-07-30\n\n## Requirement deltas\n- none\n",
    );
    let r = gate_return(
        &repo,
        json!({"agent_type": "spec-flow:spec-writer", "last_assistant_message": "STATUS: TRIAGED\nCASE: 5 NOT-A-FIX\nSPEC_PATH: specflow/my-change/spec.md"}),
    );
    assert!(
        r.blocked() && r.stdout.contains("has the name of an archived change"),
        "a case 5 the orchestrator would archive inside another change went through: {}",
        r.stdout
    );
}

/// A re-triage mid-run works on the folder the run's milestone names.
#[test]
fn spec_writer_does_not_send_a_re_triage_mid_run_to_rename_the_folder_its_milestone_names() {
    let repo = repo_in("implement");
    let r = retriage(&repo);
    assert!(
        !r.blocked(),
        "a re-triage during implement was sent back: {}",
        r.stdout
    );
}

#[test]
fn spec_writer_sends_back_a_triage_in_spec_named_like_an_archived_change() {
    let repo = repo_in("spec");
    let r = retriage(&repo);
    assert!(
        r.blocked() && r.stdout.contains("has the name of an archived change"),
        "a brief the fold would move inside another change went through: {}",
        r.stdout
    );
}

#[test]
fn spec_writer_does_not_judge_reads_it_cannot_attribute_and_says_so() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write(
        state_path(&repo, "run-trace.log"),
        &format!(
            "2026-01-01T00:00:00Z phase=spec read file={}\n",
            repo.join("specs/README.md").display()
        ),
    );
    let r = gate_return(&repo, spec_ready(json!({})));
    assert!(!r.blocked(), "unattributed reads were judged: {}", r.stdout);
    must_match(
        "agent-check agent=spec-flow:spec-writer result=skip why=unattributed",
        &trace_text(&repo),
        "no skip line",
    );
}

#[test]
fn spec_writer_lets_a_ready_fix_brief_through_without_the_reads_or_the_assumptions_a_change_spec_owes()
 {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write_fix(&repo, true);
    read_by(&repo, "someone-else", &["specs/README.md"]);
    let r = gate_return(
        &repo,
        json!({"agent_type": "spec-flow:spec-writer", "last_assistant_message": format!("{TRIAGED_CASE3}{WORK_ORDER}")}),
    );
    assert!(
        !r.blocked(),
        "a ready fix brief was sent back: {}",
        r.stdout
    );
}

/// The orchestrator writing the work order would read the code again (ADR-033).
#[test]
fn spec_writer_sends_back_a_triage_of_case_1_to_4_that_names_no_work_order() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write_fix(&repo, true);
    let r = gate_return(
        &repo,
        json!({"agent_type": "spec-flow:spec-writer", "last_assistant_message": TRIAGED_CASE3}),
    );
    assert!(
        r.blocked() && r.stdout.contains("PLAN_PATH") && r.stdout.contains("WORK_ORDER_PATH"),
        "a triage with no work order went through, or the reason does not name both lines: {}",
        r.stdout
    );
}

#[test]
fn spec_writer_sends_back_a_triage_naming_a_work_order_that_is_not_on_disk() {
    let repo = repo_in("spec");
    writer_repo(&repo, "");
    write_fix(&repo, false);
    assert!(gate_return(&repo, json!({"agent_type": "spec-flow:spec-writer", "last_assistant_message": format!("{TRIAGED_CASE3}{WORK_ORDER}")})).blocked(), "a triage naming files it never wrote went through");
}

pub fn jsonl(entries: &[Value]) -> String {
    entries.iter().map(|e| format!("{e}\n")).collect()
}

pub fn assistant_text(text: &str) -> Value {
    json!({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
}

pub fn handback(message: &str) -> Value {
    json!({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "SubagentHandback", "input": {"message": message}}]}})
}

/// A stop whose handback line lands after the stop fires (ADR-050), appended
/// by someone else while the hook runs.
fn late_handback(transcript: &Path, message: &str, after: Duration) -> std::thread::JoinHandle<()> {
    write(transcript, &jsonl(&[assistant_text("working")]));
    let (transcript, line) = (transcript.to_path_buf(), jsonl(&[handback(message)]));
    std::thread::spawn(move || {
        std::thread::sleep(after);
        append_to(&transcript, &line);
    })
}

#[test]
fn run_trace_logs_a_subagent_status() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "run-trace",
            subagent_stop(json!({"last_assistant_message": "STATUS: APPROVED"})),
            &repo,
        ),
        0,
        "run-trace",
    );
    must_match(
        "agent type=spec-flow:reviewer status=APPROVED",
        &trace_text(&repo),
        "no return line",
    );
}

/// The orchestrator's prompts name the statuses they expect back.
#[test]
fn run_trace_takes_no_status_from_a_spawn_whose_response_echoes_the_prompt() {
    let repo = make_repo(RepoOpts::default());
    let prompt = "If anything is ambiguous, return STATUS: NEEDS_INPUT.";
    for resp in [
        json!({"isAsync": true, "status": "async_launched", "agentId": "a0123456789abcdef", "prompt": prompt}),
        json!({"status": "completed", "prompt": prompt, "agentId": "a0123456789abcdef", "content": [{"type": "text", "text": "STATUS: SPEC_READY"}]}),
    ] {
        expect_status(
            &run_hook(
                "run-trace",
                json!({"tool_name": "Agent", "tool_input": {"subagent_type": "spec-flow:spec-writer", "prompt": prompt}, "tool_response": resp}),
                &repo,
            ),
            0,
            "run-trace",
        );
    }
    must_not_match(
        "agent type=",
        &trace_text(&repo),
        "a spawn's tool response was recorded as the agent's return",
    );
}

#[test]
fn run_trace_reads_a_report_handed_back_through_subagent_handback_not_the_line_after_it() {
    let repo = make_repo(RepoOpts::default());
    let transcript = repo.join("agent-a0123456789abcdef.jsonl");
    write(
        &transcript,
        &jsonl(&[
            handback("STATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md"),
            assistant_text("Report delivered to the orchestrator via SubagentHandback."),
        ]),
    );
    expect_status(
        &run_hook(
            "run-trace",
            subagent_stop(
                json!({"agent_type": "spec-flow:spec-writer", "last_assistant_message": "Report delivered to the orchestrator via SubagentHandback.", "agent_transcript_path": transcript}),
            ),
            &repo,
        ),
        0,
        "run-trace",
    );
    must_match(
        "agent type=spec-flow:spec-writer status=SPEC_READY",
        &trace_text(&repo),
        "the report the caller received was not recorded",
    );
}

#[test]
fn run_trace_and_agent_gate_read_a_handback_written_after_the_stop_fires() {
    let repo = repo_in("review");
    let for_trace = repo.join("agent-trace.jsonl");
    let late = late_handback(
        &for_trace,
        "STATUS: APPROVED\nNOTES: none",
        Duration::from_millis(300),
    );
    expect_status(
        &run_hook(
            "run-trace",
            subagent_stop(json!({"agent_id": "late1", "agent_transcript_path": for_trace})),
            &repo,
        ),
        0,
        "run-trace",
    );
    late.join().unwrap();
    must_match(
        "agent type=spec-flow:reviewer status=APPROVED .*agent_id=late1",
        &trace_text(&repo),
        "run-trace lost a return that landed 300 ms after the stop",
    );
    let for_gate = repo.join("agent-gate.jsonl");
    let late = late_handback(
        &for_gate,
        "STATUS: APPROVED\nNOTES: none",
        Duration::from_millis(300),
    );
    expect_status(
        &run_hook(
            "agent-gate",
            subagent_stop(json!({"agent_id": "late2", "agent_transcript_path": for_gate})),
            &repo,
        ),
        0,
        "agent-gate",
    );
    late.join().unwrap();
    must_not_match(
        "agent-check .*why=empty agent_id=late2",
        &trace_text(&repo),
        "agent-gate skipped a return that landed 300 ms after the stop",
    );
}

#[test]
fn run_trace_waits_a_bounded_time_for_a_handback_that_never_comes_then_reads_it_as_empty() {
    let repo = repo_in("review");
    let transcript = repo.join("agent-none.jsonl");
    write(&transcript, &jsonl(&[assistant_text("working")]));
    let start = Instant::now();
    expect_status(
        &run_hook(
            "run-trace",
            subagent_stop(json!({"agent_id": "never", "agent_transcript_path": transcript})),
            &repo,
        ),
        0,
        "run-trace",
    );
    let took = start.elapsed();
    assert!(
        took <= Duration::from_secs(5),
        "run-trace held a stop {took:?} for a handback that never came"
    );
    must_not_match(
        "agent type=",
        &trace_text(&repo),
        "a line was written with no status to put on it",
    );
    assert!(
        read(state_path(&repo, "run-trace-unmatched.log")).contains(r#""report":"empty""#),
        "the empty return left no record of its shape"
    );
}

#[test]
fn run_trace_writes_one_line_per_agent_a_resumed_session_stopping_again_under_the_same_id() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        subagent_stop(json!({"last_assistant_message": "STATUS: CHANGES_REQUESTED"})),
        &repo,
    );
    run_hook(
        "run-trace",
        subagent_stop(json!({"last_assistant_message": "STATUS: APPROVED"})),
        &repo,
    );
    let trace = trace_text(&repo);
    let lines: Vec<&str> = trace
        .lines()
        .filter(|l| l.contains("agent type="))
        .collect();
    assert!(
        lines.len() == 1 && lines[0].contains("status=CHANGES_REQUESTED"),
        "want the first return alone, got:\n{}",
        lines.join("\n")
    );
}

#[test]
fn run_trace_records_the_shape_of_a_return_that_carries_no_status() {
    let repo = make_repo(RepoOpts::default());
    expect_status(
        &run_hook(
            "run-trace",
            subagent_stop(json!({"last_assistant_message": "all done"})),
            &repo,
        ),
        0,
        "run-trace",
    );
    must_not_match(
        "agent type=",
        &trace_text(&repo),
        "a line was written with no status to put on it",
    );
    assert!(
        exists(state_path(&repo, "run-trace-unmatched.log")),
        "a return the trace could not read left no record of its shape"
    );
}

/// The one observable that had nowhere to go but prose.
#[test]
fn run_trace_records_a_reported_skill_routing_miss() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        subagent_stop(
            json!({"agent_type": "spec-flow:implementer", "last_assistant_message": "STATUS: IMPLEMENTED\nSKILL_MISS: where does it live\nNOTES: fine"}),
        ),
        &repo,
    );
    must_match(
        "skill_miss=where-does-it-live",
        &trace_text(&repo),
        "the miss did not reach the trace",
    );
    must_match(
        "status=IMPLEMENTED",
        &trace_text(&repo),
        "the status field was lost",
    );
}

#[test]
fn run_trace_writes_no_skill_miss_field_when_none_was_reported() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        subagent_stop(
            json!({"agent_type": "spec-flow:implementer", "last_assistant_message": "STATUS: IMPLEMENTED"}),
        ),
        &repo,
    );
    must_not_match(
        "skill_miss",
        &trace_text(&repo),
        "an empty field was written",
    );
}

#[test]
fn run_trace_records_the_effort_an_agent_ran_at_on_its_return_line() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        subagent_stop(
            json!({"last_assistant_message": "STATUS: APPROVED", "effort": {"level": "low"}}),
        ),
        &repo,
    );
    must_match(
        "status=APPROVED effort=low agent_id=",
        &trace_text(&repo),
        "no effort on the return line",
    );
}

pub fn read_of(file: &str, extra: Value) -> Value {
    let mut p = json!({"tool_name": "Read", "tool_input": {"file_path": file}});
    merge(&mut p, extra);
    p
}

#[test]
fn run_trace_logs_a_read_path() {
    let repo = make_repo(RepoOpts::default());
    run_hook("run-trace", read_of("specs/user.md", json!({})), &repo);
    must_match(
        r"read file=specs/user\.md",
        &trace_text(&repo),
        "no read line",
    );
}

/// Without it a path read twice is one observation with two opposite readings.
#[test]
fn run_trace_records_which_session_read_a_file() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        read_of("specs/user.md", json!({"session_id": "abc123def456"})),
        &repo,
    );
    must_match(
        "session=abc123def456",
        &trace_text(&repo),
        "the read was recorded with no session",
    );
    must_match(
        r"read file=specs/user\.md",
        &trace_text(&repo),
        "the path was lost",
    );
}

/// Absent, not empty: an empty field reads as one session downstream.
#[test]
fn run_trace_writes_no_session_field_when_the_payload_names_none() {
    let repo = make_repo(RepoOpts::default());
    run_hook("run-trace", read_of("specs/user.md", json!({})), &repo);
    must_not_match(
        "session=",
        &trace_text(&repo),
        "a session field was written over a payload that named none",
    );
}

#[test]
fn run_trace_attributes_a_read_made_inside_a_subagent_to_that_agent() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        read_of(
            "specs/user.md",
            json!({"session_id": "spawner-session", "agent_id": "a0123456789abcdef", "agent_type": "spec-flow:spec-writer"}),
        ),
        &repo,
    );
    must_match(
        r"read file=specs/user\.md agent_id=a0123456789abcdef",
        &trace_text(&repo),
        "the read names no agent",
    );
}

#[test]
fn run_trace_gives_an_agent_whose_reads_carry_its_id_its_return_line() {
    let repo = make_repo(RepoOpts::default());
    let mut p =
        subagent_stop(json!({"tool_name": "Read", "tool_input": {"file_path": "specs/user.md"}}));
    p.as_object_mut().unwrap().remove("hook_event_name");
    run_hook("run-trace", p, &repo);
    run_hook(
        "run-trace",
        subagent_stop(json!({"last_assistant_message": "STATUS: APPROVED"})),
        &repo,
    );
    must_match(
        "agent type=spec-flow:reviewer status=APPROVED",
        &trace_text(&repo),
        "the agent's own read suppressed its return",
    );
}

#[test]
fn run_trace_names_no_agent_for_a_read_in_the_main_session() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        read_of("specs/user.md", json!({"session_id": "main"})),
        &repo,
    );
    must_not_match(
        "agent_id=",
        &trace_text(&repo),
        "a main-session read was charged to an agent",
    );
}

/// A Bash call that exited non-zero, as Claude Code 2.1.294 delivers it: no
/// tool_response.
pub fn bash_failure(command: &str, err: &str, extra: Value) -> Value {
    let mut p = json!({"hook_event_name": "PostToolUseFailure", "tool_name": "Bash", "tool_input": {"command": command}, "error": err, "is_interrupt": false});
    merge(&mut p, extra);
    p
}

fn bash_piped(command: &str, stdout: &str) -> Value {
    json!({"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "tool_response": {"stdout": stdout, "stderr": ""}})
}

pub fn verdict_of(repo: &Path) -> String {
    Regex::new(r"test verdict=(\S+)")
        .unwrap()
        .captures(&trace_text(repo))
        .map_or("(nothing traced)".into(), |m| m[1].to_string())
}

pub fn all_of(pattern: &str, text: &str) -> String {
    Regex::new(pattern)
        .unwrap()
        .captures_iter(text)
        .map(|m| m[1].to_string())
        .collect::<Vec<_>>()
        .join(",")
}

/// What jest prints for a test written ahead of its module, from a real run.
const JEST_SUITE_FAILED: &str = "FAIL tests/a.spec.ts\n  ● Test suite failed to run\n\n    tests/a.spec.ts:1:20 - error TS2307: Cannot find module './a' or its corresponding type declarations.\n\nTest Suites: 1 failed, 1 total\nTests:       0 total\nSnapshots:   0 total";

/// A test that failed, as this hook reads one: the runner's own count of the
/// tests that failed, here in vitest's words.
const FTEST_RED: &str = "Exit code 1\nexpected 3, got undefined\n\n Test Files  1 failed (1)\n      Tests  1 failed (1)";

pub fn with_runner(name: &str) -> Dir {
    let name = name.to_string();
    make_repo(RepoOpts {
        contract_edit: Some(&move |c: &mut Value| c["verify"]["test_name"] = json!(name)),
        ..Default::default()
    })
}

/// A non-zero exit never reaches PostToolUse: read only from there, no red run.
#[test]
fn run_trace_logs_a_failing_scoped_test_run_as_red() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure("npx ftest run tests/a.spec.ts", FTEST_RED, json!({})),
        &repo,
    );
    must_match(
        r"test verdict=red target=tests/a\.spec\.ts",
        &trace_text(&repo),
        "a failing test run was not recorded as red",
    );
}

/// A test written ahead of its module meets one of two outcomes: its file
/// does not load, and none of its tests ran; or it loads and one fails.
#[test]
fn run_trace_tells_a_file_that_did_not_load_from_a_test_that_failed_in_each_runner() {
    for (runner, test_name, cmd, out, want) in [
        (
            "jest 30.5.2",
            "jest",
            "npx jest tests/load.test.js",
            JEST_LOAD,
            "absent",
        ),
        (
            "jest 30.5.2",
            "jest",
            "npx jest tests/fail.test.js",
            JEST_FAIL,
            "red",
        ),
        (
            "vitest 5.1.0",
            "vitest",
            "npx vitest run vt/load.spec.mjs",
            VITEST_LOAD,
            "absent",
        ),
        (
            "vitest 5.1.0",
            "vitest",
            "npx vitest run vt/fail.spec.mjs",
            VITEST_FAIL,
            "red",
        ),
        (
            "mocha 12.0.3",
            "mocha",
            "npx mocha mo/load.spec.js",
            MOCHA_LOAD,
            "absent",
        ),
        (
            "mocha 12.0.3",
            "mocha",
            "npx mocha mo/fail.spec.js",
            MOCHA_FAIL,
            "red",
        ),
        (
            "node 24.22.2",
            "node --test",
            "node --test tests/load.test.mjs",
            NODE24_LOAD,
            "absent",
        ),
        (
            "node 24.22.2",
            "node --test",
            "node --test tests/fail.test.mjs",
            NODE24_FAIL,
            "red",
        ),
        (
            "node 22.23.4",
            "node --test",
            "node --test tests/load.test.mjs",
            NODE22_LOAD,
            "absent",
        ),
        (
            "node 22.23.4",
            "node --test",
            "node --test tests/fail.test.mjs",
            NODE22_FAIL,
            "red",
        ),
    ] {
        let repo = with_runner(test_name);
        run_hook(
            "run-trace",
            bash_failure(cmd, &format!("Exit code 1\n{out}"), json!({})),
            &repo,
        );
        let got = verdict_of(&repo);
        assert_eq!(got, want, "{runner}: {cmd}: {}", trace_text(&repo));
    }
}

/// node --test names a file it could not load by the path it was handed,
/// less a leading `./`; given a glob, the shell hands it each file matched.
#[test]
fn node_test_a_file_that_did_not_load_is_absent_however_its_path_was_written() {
    let repo = with_runner("node --test");
    for cmd in [
        "node --test ./tests/load.test.mjs",
        "node --test tests/*.test.mjs",
    ] {
        run_hook(
            "run-trace",
            bash_failure(cmd, &format!("Exit code 1\n{NODE24_LOAD}"), json!({})),
            &repo,
        );
    }
    assert_eq!(
        all_of(r"test verdict=(\S+)", &trace_text(&repo)),
        "absent,absent"
    );
}

#[test]
fn node_test_a_test_that_failed_beside_a_file_that_did_not_load_is_red() {
    let repo = with_runner("node --test");
    run_hook(
        "run-trace",
        bash_failure(
            "node --test tests/*.test.mjs",
            &format!("Exit code 1\n{NODE24_MIXED}"),
            json!({}),
        ),
        &repo,
    );
    assert_eq!(verdict_of(&repo), "red", "{}", trace_text(&repo));
}

/// Said as context on the event that carried the run: PostToolUseFailure for
/// a failing exit, PostToolUse when a pipe hid it. Both reach the model
/// (measured on 2.1.318).
#[test]
fn run_trace_answers_a_run_whose_test_file_did_not_load_with_how_to_make_it_red() {
    let repo = with_runner("jest");
    for (event, payload) in [
        (
            "PostToolUseFailure",
            bash_failure(
                "npx jest tests/load.test.js",
                &format!("Exit code 1\n{JEST_LOAD}"),
                json!({}),
            ),
        ),
        (
            "PostToolUse",
            bash_piped("npx jest tests/load.test.js 2>&1 | tail -20", JEST_LOAD),
        ),
    ] {
        let r = run_hook("run-trace", payload, &repo);
        let out: Value = serde_json::from_str(&r.stdout).unwrap_or(Value::Null);
        let h = &out["hookSpecificOutput"];
        assert!(
            r.status == 0
                && h["hookEventName"] == event
                && h["additionalContext"]
                    .as_str()
                    .unwrap_or("")
                    .contains("write its signature first"),
            "{event}: status {}, stdout {:?}",
            r.status,
            r.stdout
        );
    }
    assert_eq!(
        all_of(r"test verdict=(\S+)", &trace_text(&repo)),
        "absent,absent",
        "the answered runs were not recorded"
    );
}

#[test]
fn run_trace_answers_a_red_run_or_one_it_cannot_judge_with_nothing() {
    let repo = with_runner("jest");
    for out in [JEST_FAIL, "expected 3, got undefined"] {
        let r = run_hook(
            "run-trace",
            bash_failure(
                "npx jest tests/fail.test.js",
                &format!("Exit code 1\n{out}"),
                json!({}),
            ),
            &repo,
        );
        assert!(
            r.stdout.is_empty() && r.status == 0,
            "answered a run that loaded: status {}, {:?}",
            r.status,
            r.stdout
        );
    }
}

/// The hook reads a red run off the runner's count; a failure it cannot read
/// could as well be a file that did not load.
#[test]
fn run_trace_leaves_a_failure_that_names_no_failed_test_unjudged() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure(
            "npx ftest run tests/a.spec.ts",
            "Exit code 1\nError: Cannot find module './a'",
            json!({}),
        ),
        &repo,
    );
    must_match(
        r"test verdict=\? target=tests/a\.spec\.ts why=no-summary",
        &trace_text(&repo),
        "a failure the hook cannot read was given a verdict",
    );
}

#[test]
fn run_trace_targets_only_what_the_runner_ran_in_a_chain_of_commands() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure(
            "npx ftest run tests/a.spec.ts >/dev/null\nnpx eslint tests/c.spec.ts; eslint tests/b.spec.ts && node node_modules/eslint/bin/eslint.js lib/b.ts",
            "Exit code 1\nexpected 3, got undefined",
            json!({}),
        ),
        &repo,
    );
    assert_eq!(
        all_of(r" target=(\S+)", &trace_text(&repo)),
        "tests/a.spec.ts"
    );
}

#[test]
fn run_trace_targets_the_path_through_a_continued_line_a_subshell_quotes_and_a_directory_named_for_the_runner()
 {
    let repo = make_repo(RepoOpts::default());
    for c in [
        "npx ftest \\\n  tests/a.spec.ts \\\n  --verbose",
        "(cd sub && npx ftest run tests/a.spec.ts)",
        r#"npx ftest run "tests/a.spec.ts""#,
        "npx ftest run tests/ftest-utils/a.spec.ts",
    ] {
        run_hook(
            "run-trace",
            bash_failure(c, "Exit code 1\nexpected 3, got undefined", json!({})),
            &repo,
        );
    }
    assert_eq!(
        all_of(r" target=(\S+)", &trace_text(&repo)),
        "tests/a.spec.ts,tests/a.spec.ts,tests/a.spec.ts,tests/ftest-utils/a.spec.ts"
    );
}

/// A run handed to a shell, in an argument or a heredoc, and one after an
/// escaped quote, are runs.
#[test]
fn run_trace_reads_a_run_through_a_shell_and_past_an_escaped_quote() {
    let repo = make_repo(RepoOpts::default());
    for c in [
        "sh -c 'npx ftest run tests/a.spec.ts'",
        r#"git commit -m "a \"b" && npx ftest run tests/a.spec.ts && echo "c""#,
        "bash <<EOF\nnpx ftest run tests/a.spec.ts\nEOF",
        "sh -c 'npx ftest run'",
        r#"git commit -m "a \"b" && npx ftest run && echo "c""#,
    ] {
        run_hook("run-trace", bash_failure(c, FTEST_RED, json!({})), &repo);
    }
    assert_eq!(
        all_of(r"test (verdict=\S+ target=\S+)", &trace_text(&repo)),
        "verdict=red target=tests/a.spec.ts,verdict=red target=tests/a.spec.ts,verdict=red target=tests/a.spec.ts,verdict=red target=-,verdict=red target=-"
    );
}

#[test]
fn run_trace_takes_a_commit_message_naming_the_runner_for_no_run() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure(
            r#"git commit -m "ftest tests/a.spec.ts" && false"#,
            "Exit code 1",
            json!({}),
        ),
        &repo,
    );
    assert_eq!(
        verdict_of(&repo),
        "(nothing traced)",
        "{}",
        trace_text(&repo)
    );
}

#[test]
fn run_trace_does_not_call_an_interrupted_test_run_red() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure(
            "npx ftest run tests/a.spec.ts",
            "Interrupted",
            json!({"is_interrupt": true}),
        ),
        &repo,
    );
    must_match(
        r"test verdict=\? target=tests/a\.spec\.ts",
        &trace_text(&repo),
        "an interrupted run was given a verdict",
    );
}

/// A red verdict credits test-first, so red only when the runner reports a
/// test that failed.
#[test]
fn run_trace_does_not_take_a_failing_command_that_only_names_the_runner_for_a_red_run() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure("grep -n ftest package.json", "Exit code 1", json!({})),
        &repo,
    );
    assert_ne!(
        verdict_of(&repo),
        "red",
        "grep was traced as a failing test run: {}",
        trace_text(&repo)
    );
}

#[test]
fn run_trace_does_not_call_a_runner_not_found_or_a_run_that_passed_every_test_red() {
    for (name, cmd, err) in [
        (
            "a runner the shell could not find is not a red run",
            "ftest tests/a.spec.ts",
            "Exit code 127\nbash: line 1: ftest: command not found",
        ),
        (
            "a failing run whose own summary says every test passed is not red",
            "npx ftest run tests/a.spec.ts",
            "Exit code 1\n      Tests  3 passed (3)\nERROR: Coverage for lines (12%) does not meet global threshold (80%)",
        ),
    ] {
        let repo = make_repo(RepoOpts::default());
        run_hook("run-trace", bash_failure(cmd, err, json!({})), &repo);
        assert_eq!(verdict_of(&repo), "?", "{name}: {}", trace_text(&repo));
    }
}

#[test]
fn run_trace_calls_a_failing_run_that_found_no_test_file_none_in_vitest_and_node_wording() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure(
            "npx ftest run tests/typo.spec.ts",
            "Exit code 1\nNo test files found, exiting with code 1",
            json!({}),
        ),
        &repo,
    );
    run_hook(
        "run-trace",
        bash_failure(
            "npx ftest run tests/typo.spec.ts",
            "Exit code 1\nCould not find '/x/tests/typo.spec.ts'",
            json!({}),
        ),
        &repo,
    );
    assert_eq!(
        all_of(r"test verdict=(\S+)", &trace_text(&repo)),
        "none,none"
    );
}

/// A pipe's exit status is its last command's; the runner's count is still read.
#[test]
fn run_trace_reads_the_runners_count_when_a_pipe_hid_the_exit_status() {
    for (name, out, want) in [
        (
            "a suite that failed to run is absent, never red, even when a pipe hid the exit status",
            JEST_SUITE_FAILED,
            "absent",
        ),
        (
            "a test that failed is red even when a pipe hid the exit status",
            JEST_FAIL,
            "red",
        ),
    ] {
        let repo = make_repo(RepoOpts::default());
        run_hook(
            "run-trace",
            bash_piped("npx ftest tests/a.spec.ts 2>&1 | tail -20", out),
            &repo,
        );
        assert_eq!(verdict_of(&repo), want, "{name}: {}", trace_text(&repo));
    }
}

/// init writes the runner as `node <entrypoint>`, the implementer runs what
/// the contract names, and this hook must recognise it — checked against
/// what init actually writes. Recognised, a failure it cannot read is
/// unjudged; another program's would be excused as not-the-runner.
#[test]
fn run_trace_takes_the_test_argv_init_writes_run_on_a_path_and_failing_for_the_runners_run() {
    let repo = make_repo(RepoOpts::default());
    write(
        repo.join("node_modules/jest/bin/jest.js"),
        "process.exit(0);\n",
    );
    let shim = repo.join("node_modules/.bin/jest");
    std::fs::create_dir_all(shim.parent().unwrap()).unwrap();
    #[cfg(windows)]
    write(
        &shim,
        "#!/bin/sh\nexec node \"$basedir/../jest/bin/jest.js\" \"$@\"\n",
    );
    #[cfg(unix)]
    std::os::unix::fs::symlink("../jest/bin/jest.js", &shim).unwrap();
    write(repo.join("package.json"), r#"{"scripts":{"test":"jest"}}"#);
    let smoke = read(repo.join(".spec-flow/config.json"));
    let init = cli(&repo, &[], &["init", "--force"]);
    let written: Value =
        serde_json::from_str(&read(repo.join(".spec-flow/config.json"))).unwrap_or(Value::Null);
    let test: Vec<String> = written["verify"]["test"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| a.as_str().map(String::from))
        .collect();
    assert!(
        written["verify"]["test_name"] == "jest" && test.first().is_some_and(|a| a == "node"),
        "init did not write jest as `node <entrypoint>` — this case tests nothing: {written} {}",
        init.out()
    );
    let mut c: Value = serde_json::from_str(&smoke).unwrap();
    c["verify"]["test"] = json!(test);
    c["verify"]["test_name"] = written["verify"]["test_name"].clone();
    write(repo.join(".spec-flow/config.json"), &c.to_string());
    let cmd = format!("{} tests/a.spec.ts", test.join(" "));
    run_hook(
        "run-trace",
        bash_failure(&cmd, "Exit code 1\nexpected 3, got undefined", json!({})),
        &repo,
    );
    assert_eq!(
        all_of(r"test verdict=\? \S+ why=(\S+)", &trace_text(&repo)),
        "no-summary",
        "for `{cmd}`: {}",
        trace_text(&repo)
    );
}

#[test]
fn run_trace_does_not_take_node_running_a_script_that_is_not_the_runner_for_a_red_run() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure(
            "node scripts/build.mjs --then ftest tests/a.spec.ts",
            "Exit code 1\nbuild failed",
            json!({}),
        ),
        &repo,
    );
    assert_ne!(
        verdict_of(&repo),
        "red",
        "a build script was traced as a failing test run: {}",
        trace_text(&repo)
    );
}

/// A `?` says what the hook was not given.
#[test]
fn run_trace_says_why_it_cannot_judge_a_run() {
    let repo = make_repo(RepoOpts::default());
    run_hook(
        "run-trace",
        bash_failure(
            "npx ftest run tests/a.spec.ts",
            "Interrupted",
            json!({"is_interrupt": true}),
        ),
        &repo,
    );
    run_hook(
        "run-trace",
        bash_failure(
            "ftest tests/a.spec.ts",
            "Exit code 127\nbash: line 1: ftest: command not found",
            json!({}),
        ),
        &repo,
    );
    run_hook(
        "run-trace",
        bash_piped("npx ftest tests/a.spec.ts | tail -5", "some output"),
        &repo,
    );
    run_hook(
        "run-trace",
        bash_failure("grep -rn ftest tests/a.spec.ts", "Exit code 1", json!({})),
        &repo,
    );
    run_hook(
        "run-trace",
        bash_failure(
            "node --experimental-vm-modules node_modules/ftest/bin/ftest.js tests/a.spec.ts",
            "Exit code 1\nexpected 3, got undefined",
            json!({}),
        ),
        &repo,
    );
    assert_eq!(
        all_of(r"test verdict=\? \S+ why=(\S+)", &trace_text(&repo)),
        "interrupted,not-found,pipe,not-the-runner,no-summary"
    );
}

#[test]
fn run_trace_is_silent_outside_a_run() {
    let repo = repo_in("idle");
    run_hook(
        "run-trace",
        json!({"tool_name": "Write", "tool_input": {"file_path": "example/thing.ts"}}),
        &repo,
    );
    assert!(
        !exists(state_path(&repo, "run-trace.log")),
        "traced while idle"
    );
}

/// The plugin's hook registrations: event -> groups of {matcher, hooks}.
pub fn hooks_json() -> serde_json::Map<String, Value> {
    let m: Value = serde_json::from_str(&read(SETUP.repo_root.join("hooks/hooks.json"))).unwrap();
    m["hooks"].as_object().unwrap().clone()
}

/// Each entry of the manifest, with its event.
pub fn hook_entries() -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for (event, groups) in hooks_json() {
        for g in groups.as_array().unwrap() {
            for h in g["hooks"].as_array().unwrap() {
                out.push((event.clone(), h.clone()));
            }
        }
    }
    out
}

static LAUNCHER_COMMAND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^"\$\{CLAUDE_PLUGIN_ROOT\}/bin/spec-flow" hook ([a-z-]+)$"#).unwrap()
});

/// Whether a manifest entry runs hook name.
pub fn runs_hook(h: &Value, name: &str) -> bool {
    LAUNCHER_COMMAND
        .captures(h["command"].as_str().unwrap_or(""))
        .is_some_and(|m| &m[1] == name)
}

#[test]
fn hooks_json_registers_run_trace_for_a_failing_bash_call() {
    let bash = Regex::new(r"(^|\|)Bash(\||$)").unwrap();
    let found = hooks_json()["PostToolUseFailure"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|e| {
            bash.is_match(e["matcher"].as_str().unwrap_or(""))
                && e["hooks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|h| runs_hook(h, "run-trace"))
        });
    assert!(
        found,
        "no PostToolUseFailure entry runs run-trace on Bash — a red test run is never traced"
    );
}

/// How Claude Code runs a shell-form hook here: `sh -c` on macOS and Linux,
/// Git Bash on Windows.
pub fn shell_of() -> Vec<String> {
    if cfg!(windows) {
        vec![git_bash().to_string_lossy().into_owned(), "-c".into()]
    } else {
        vec!["sh".into(), "-c".into()]
    }
}

/// The manifest is a call site like any other: each entry, run exactly as
/// Claude Code runs it — through the shell, the plugin root substituted —
/// reaches a hook, which outside a run lets the call through.
#[test]
fn every_hooks_json_entry_runs_as_written() {
    let repo = temp_dir();
    let engine = engine_dir().to_string_lossy().replace('\\', "/");
    let mut wrong = Vec::new();
    for (event, h) in hook_entries() {
        let command = h["command"].as_str().unwrap();
        let mut argv = shell_of();
        argv.push(command.replace("${CLAUDE_PLUGIN_ROOT}", &engine));
        let env = [
            format!("CLAUDE_PROJECT_DIR={}", repo.display()),
            format!("CLAUDE_PLUGIN_ROOT={}", engine_dir().display()),
        ];
        let r = run(
            &std::env::temp_dir(),
            &env,
            &json!({"hook_event_name": event, "session_id": "s"}).to_string(),
            &argv,
        );
        if r.status != 0 {
            wrong.push(format!(
                "{event} {command:?} exited {}: {}",
                r.status,
                r.out()
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// Every hook runs the launcher in a shell, the only spawn that is the same
/// documented one on every platform (ADR-052). Where Windows has no Git Bash
/// the shell is PowerShell, which cannot run it: a PreToolUse hook failing
/// there blocks the call unless it says to continue, and the engine would
/// stop every Read, Write and spawn instead of standing down.
#[test]
fn every_hook_runs_the_launcher_and_a_pre_tool_use_hook_continues_where_it_cannot_run() {
    let mut wrong = Vec::new();
    for (event, h) in hook_entries() {
        let command = h["command"].as_str().unwrap_or("");
        if h.get("args").is_some()
            || h.get("shell").is_some()
            || !LAUNCHER_COMMAND.is_match(command)
        {
            wrong.push(format!(
                "{event}: {command:?} is not the launcher in the default shell"
            ));
        }
        if event == "PreToolUse" && h["onFailure"] != "continue" {
            wrong.push(format!(
                "{event} {command:?}: onFailure is {}, not \"continue\"",
                h["onFailure"]
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

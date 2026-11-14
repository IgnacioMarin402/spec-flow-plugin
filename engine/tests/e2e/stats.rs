//! stats exports nothing, gates nothing and always exits 0: its whole surface
//! is what it prints, so every case runs it against a synthetic repository.
//!
//! The case that carries the design is "a file read in two DIFFERENT
//! milestones is not a re-read": a fresh session per milestone is the
//! contract, so only a repeat INSIDE one is the cold-start cost.

use std::path::Path;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

use regex::Regex;
use serde_json::json;

use crate::harness::*;
use crate::helpers::*;
use crate::runner_output::{JEST_FAIL, JEST_LOAD};
use crate::smoke2::{bash_failure, with_runner};

/// Minutes past a fixed origin, so a case reads as an ordering.
pub fn stamp(minute: u32) -> String {
    let total = 600 + minute;
    format!("2026-08-21T{:02}:{:02}:00Z", total / 60, total % 60)
}

pub fn read_at(minute: u32, file: &str, session: &str) -> String {
    let s = if session.is_empty() {
        String::new()
    } else {
        format!(" session={session}")
    };
    format!("{} phase=implement{s} read file={file}", stamp(minute))
}

pub fn read_in(minute: u32, phase: &str, file: &str) -> String {
    format!("{} phase={phase} read file={file}", stamp(minute))
}

fn agent_at(minute: u32, kind: &str, session: &str) -> String {
    let s = if session.is_empty() {
        String::new()
    } else {
        format!(" session={session}")
    };
    format!(
        "{} phase=implement{s} agent type={kind} status=DONE",
        stamp(minute)
    )
}

fn pass_at(minute: u32) -> String {
    format!(
        "{} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1",
        stamp(minute)
    )
}

#[derive(Clone, Default)]
pub struct Snapshot {
    pub slug: &'static str,
    pub gate: Vec<String>,
    pub trace: Vec<String>,
}

#[derive(Default)]
pub struct StatsRun {
    pub trace: Vec<String>,
    pub gate: Vec<String>,
    pub archived: Vec<Snapshot>,
    pub files: Files,
    pub trace_for: Option<fn(&Path) -> Vec<String>>,
}

fn lines(ls: &[String]) -> String {
    if ls.is_empty() {
        String::new()
    } else {
        ls.join("\n") + "\n"
    }
}

/// What stats printed over a repository holding exactly these lines. A
/// snapshot is a slice of the live log, so the same lines in both tiers is
/// what a run taken on this machine looks like on disk.
pub fn stats_report(s: StatsRun) -> Output {
    let repo = temp_dir();
    write(repo.join(".spec-flow/config.json"), &smoke_contract(None));
    write(state_path(&repo, "phase"), "implement");
    let mut live = s.trace.clone();
    if let Some(f) = s.trace_for {
        live.extend(f(&repo));
    }
    write(state_path(&repo, "run-trace.log"), &lines(&live));
    write(state_path(&repo, "gate-history.log"), &lines(&s.gate));
    write_files(&repo, &s.files);
    for snap in &s.archived {
        let dir = repo
            .join("specflow/archive")
            .join(snap.slug)
            .join("telemetry");
        // CRLF on purpose: a snapshot committed from Windows reaches a reader
        // as CRLF while the live log it was sliced from is LF.
        for (file, body) in [
            ("gate-history.log", &snap.gate),
            ("run-trace.log", &snap.trace),
        ] {
            if !body.is_empty() {
                write(dir.join(file), &(body.join("\r\n") + "\r\n"));
            }
        }
    }
    run(
        &repo,
        &[format!("CLAUDE_PROJECT_DIR={}", repo.display())],
        "",
        &cli_argv(engine_dir(), &["stats"]),
    )
}

#[track_caller]
fn want_none(out: &str, why: &str, texts: &[&str]) {
    for s in texts {
        assert!(!out.contains(s), "{why} ({s:?}).\n--- report ---\n{out}");
    }
}

/// The report CLAIMING a cross-session split, as opposed to explaining that
/// it could not make one.
static CLAIMS_SPLIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\d+ across sessions|re-read across sessions:").unwrap());

static TEST_FIRST_SECTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^Test-first\n((?s:.*?))\n\n").unwrap());

/// The Test-first section alone: the warnings below it carry other sections' words.
fn test_first(out: &str) -> String {
    TEST_FIRST_SECTION
        .captures(out)
        .map(|m| m[1].to_string())
        .unwrap_or_default()
}

fn write_at(minute: u32, file: &str) -> String {
    format!("{} phase=implement write file={file}", stamp(minute))
}

fn ran_on(minute: u32, verdict: &str, target: &str, why: &str) -> String {
    let w = if why.is_empty() {
        String::new()
    } else {
        format!(" why={why}")
    };
    format!(
        "{} phase=implement test verdict={verdict} target={target}{w}",
        stamp(minute)
    )
}

fn ran_place(minute: u32, verdict: &str, why: &str) -> String {
    ran_on(minute, verdict, "tests/orders/place.spec.ts", why)
}

/// Three tests written, then the runs, then the three modules.
fn three_pairs(runs: Vec<String>) -> Vec<String> {
    let mut out = vec![
        write_at(1, "tests/orders/place.spec.ts"),
        write_at(2, "tests/orders/cancel.spec.ts"),
        write_at(3, "tests/orders/ship.spec.ts"),
    ];
    out.extend(runs);
    out.extend([
        write_at(20, "lib/orders/place.ts"),
        write_at(21, "lib/orders/cancel.ts"),
        write_at(22, "lib/orders/ship.ts"),
    ]);
    out
}

pub const ORDERS_SPEC: &str = "<!-- spec-scope: lib/orders -->\n\n# Orders\n\n### REQ-ORDERS-001 — an order is placed\n\nThe system places it.\n";

pub fn change_files(base: &str) -> Files {
    files! {
        format!("{base}/spec.md") => "# Spec — ship-orders: ship an order\n\n## User stories\n- **US-1** — as a clerk I ship an order\n\n## Requirement deltas\n- ADDED REQ-ORDERS-002 — an order ships\n\n## Out of scope\nnone\n",
        format!("{base}/milestones/M1.md") => "# M1 — ship (covers US-1)\n\n- Objective: ship\n- Skills: none\n- Files to add/change: lib/orders/ship.ts, tests/orders-ship.spec.ts\n- Steps: one\n- Spec deltas: ADDED REQ-ORDERS-002\n- Tests to add/change: tests/orders-ship.spec.ts — REQ-ORDERS-002 ships\n- What this could break: nothing outside the deltas, it adds a file\n- Depends on: none\n",
    }
}

fn tok_line(minute: u32, phase: &str, rest: &str) -> String {
    format!(
        "{} phase={phase} tokens model=model-alpha {rest}",
        stamp(minute)
    )
}

fn ago(d: Duration) -> String {
    iso_ms(SystemTime::now() - d)
}

fn gate_fail(minute: u32, class: &str) -> String {
    format!(
        "{} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result={class} lint=0 test=1 unscoped=ok files=1",
        stamp(minute)
    )
}

fn gate_dirty(minute: u32) -> String {
    format!(
        "{} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=0 result=skip-dirty lint=- test=- unscoped=- files=1",
        stamp(minute)
    )
}

fn agent_check(minute: u32, result: &str, why: &str) -> String {
    format!(
        "{} phase=review agent-check agent=spec-flow:reviewer result={result} why={why} agent_id=a1",
        stamp(minute)
    )
}

fn dispatch(minute: u32, phase: &str, who: &str, result: &str, why: &str) -> String {
    format!(
        "{} phase={phase} session=s dispatch agent={who} tool=Agent result={result} why={why}",
        stamp(minute)
    )
}

fn no_run(minute: u32, phase: &str, who: &str) -> String {
    dispatch(minute, phase, who, "record", "no-run")
}

fn orders(base: &str) -> Files {
    let mut f = files! {"specs/orders.md" => ORDERS_SPEC};
    f.extend(change_files(base));
    f
}

/// One stats case: the report over the run described, handed to the body.
macro_rules! stats_case {
    ($(#[$doc:meta])* $name:ident, $run:expr, |$r:ident| $body:block) => {
        $(#[$doc])*
        #[test]
        fn $name() {
            let $r = stats_report($run);
            let $r = $r.out();
            let $r: &str = &$r;
            $body
        }
    };
}

#[test]
fn one_implementer_session_and_no_repeat_reads_is_the_clean_case() {
    let r = stats_report(StatsRun {
        trace: vec![
            read_at(1, "x/one.ts", ""),
            agent_at(2, "implementer", ""),
            read_at(3, "x/two.ts", ""),
        ],
        gate: vec![pass_at(4)],
        ..Default::default()
    });
    expect_status(&r, 0, "this command must always exit 0");
    want_all(
        &r.out(),
        &["milestone 1: 1 implementer session(s), no file read twice"],
    );
    want_none(
        &r.out(),
        "warned about spawns when there was only one",
        &["spawned the implementer"],
    );
}

#[test]
fn a_second_implementer_spawn_inside_one_milestone_is_reported_and_warned() {
    let r = stats_report(StatsRun {
        trace: vec![
            agent_at(1, "implementer", ""),
            read_at(2, "x/one.ts", ""),
            agent_at(3, "implementer", ""),
            read_at(4, "x/one.ts", ""),
        ],
        gate: vec![pass_at(5)],
        ..Default::default()
    });
    expect_status(&r, 0, "this command must always exit 0");
    want_all(
        &r.out(),
        &[
            "milestone 1: 2 implementer session(s)",
            "spawned the implementer 2 times",
        ],
    );
}

stats_case!(
    /// Every real trace line carries `spec-flow:<role>`.
    a_namespaced_implementer_is_counted_in_its_milestone,
    StatsRun { trace: vec![agent_at(1, "spec-flow:implementer", ""), read_at(2, "x/one.ts", ""), agent_at(3, "spec-flow:implementer", "")], gate: vec![pass_at(5)], ..Default::default() },
    |r| {
        want_all(r, &["milestone 1: 2 implementer session(s)"]);
    }
);

stats_case!(
    a_namespaced_reviewer_is_the_reviewer_so_its_rubber_stamp_check_runs,
    StatsRun {
        trace: (1..=3)
            .map(|m| format!(
                "{} phase=review agent type=spec-flow:reviewer status=APPROVED",
                stamp(m)
            ))
            .collect(),
        ..Default::default()
    },
    |r| {
        want_all(
            r,
            &[
                "reviewer: 3 APPROVED",
                "the reviewer approved all 3 plan(s)",
            ],
        );
    }
);

stats_case!(
    the_same_file_read_twice_inside_one_milestone_counts_as_a_re_read,
    StatsRun {
        trace: vec![
            agent_at(1, "implementer", ""),
            read_at(2, "x/one.ts", ""),
            read_at(3, "x/one.ts", ""),
            read_at(4, "x/one.ts", "")
        ],
        gate: vec![pass_at(5)],
        ..Default::default()
    },
    |r| {
        want_all(
            r,
            &[
                "1 file(s) re-read, 2 extra read(s)",
                "most re-read: one.ts +2",
            ],
        );
    }
);

stats_case!(
    a_file_read_in_two_different_milestones_is_not_a_re_read,
    StatsRun {
        trace: vec![
            agent_at(1, "implementer", ""),
            read_at(2, "x/one.ts", ""),
            agent_at(5, "implementer", ""),
            read_at(6, "x/one.ts", "")
        ],
        gate: vec![pass_at(3), pass_at(7)],
        ..Default::default()
    },
    |r| {
        want_all(
            r,
            &[
                "milestone 1: 1 implementer session(s), no file read twice",
                "milestone 2: 1 implementer session(s), no file read twice",
            ],
        );
        want_none(
            r,
            "counted a cross-milestone read as a re-read",
            &["most re-read:"],
        );
    }
);

stats_case!(
    work_after_the_last_pass_is_still_a_milestone_marked_as_unfinished,
    StatsRun {
        trace: vec![
            agent_at(1, "implementer", ""),
            read_at(2, "x/one.ts", ""),
            agent_at(4, "implementer", ""),
            read_at(5, "x/two.ts", "")
        ],
        gate: vec![pass_at(3)],
        ..Default::default()
    },
    |r| {
        want_all(
            r,
            &["milestone 2 (never reached a PASS): 1 implementer session(s)"],
        );
    }
);

// ---- attribution: which SESSION did the re-reading. The number is the same
// in all four; only the session ids tell them apart.

stats_case!(
    a_file_re_read_by_two_sessions_inside_one_milestone_is_the_cold_start_cost,
    StatsRun {
        trace: vec![
            agent_at(1, "implementer", "s1"),
            read_at(2, "x/one.ts", "s1"),
            agent_at(3, "implementer", "s1"),
            read_at(4, "x/one.ts", "s2")
        ],
        gate: vec![pass_at(5)],
        ..Default::default()
    },
    |r| {
        want_all(
            r,
            &[
                "1 across sessions",
                "re-read across sessions: one.ts x1",
                "the only re-read a cache could remove",
            ],
        );
    }
);

stats_case!(
    the_same_session_re_reading_its_own_file_is_not_counted_across_sessions,
    StatsRun {
        trace: vec![
            agent_at(1, "implementer", "s1"),
            read_at(2, "x/one.ts", "s1"),
            read_at(3, "x/one.ts", "s1")
        ],
        gate: vec![pass_at(4)],
        ..Default::default()
    },
    |r| {
        want_all(r, &["1 file(s) re-read, 1 extra read(s)"]);
        assert!(
            !CLAIMS_SPLIT.is_match(r),
            "one session's own re-read was reported as a cold start.\n{r}"
        );
    }
);

stats_case!(
    a_trace_with_no_session_ids_reports_attribution_as_unavailable_not_as_zero,
    StatsRun {
        trace: vec![
            agent_at(1, "implementer", ""),
            read_at(2, "x/one.ts", ""),
            read_at(3, "x/one.ts", "")
        ],
        gate: vec![pass_at(4)],
        ..Default::default()
    },
    |r| {
        want_all(r, &["attribution: UNAVAILABLE"]);
        assert!(
            !CLAIMS_SPLIT.is_match(r),
            "claimed a split over a trace that carries no session id.\n{r}"
        );
    }
);

stats_case!(
    /// Whether a subagent's payload carries its own session id or its
    /// parent's is undocumented: read as perfect reuse, this is wrong.
    one_session_id_across_several_spawns_is_reported_as_unmeasured_not_as_reuse,
    StatsRun { trace: vec![agent_at(1, "implementer", "s1"), read_at(2, "x/one.ts", "s1"), agent_at(3, "architect", "s1"), read_at(4, "x/one.ts", "s1")], gate: vec![pass_at(5)], ..Default::default() },
    |r| {
        want_all(r, &["attribution: ONE session id across 2 subagent spawn(s)", "treat those numbers as unmeasured, not as zero"]);
    }
);

stats_case!(
    /// A subagent's tool call carries its parent's session id and its own agent_id.
    reads_attributed_to_two_agents_under_one_spawner_session_are_two_sessions,
    StatsRun { trace: vec![agent_at(1, "implementer", "s1"), read_at(2, "x/one.ts", "s1") + " agent_id=a1", agent_at(3, "implementer", "s1"), read_at(4, "x/one.ts", "s1") + " agent_id=a2"], gate: vec![pass_at(5)], ..Default::default() },
    |r| {
        want_all(r, &["re-read across sessions: one.ts x1", "across 2 session(s)"]);
    }
);

stats_case!(
    /// Token lines name the agent; the return line names its role and effort.
    a_runs_tokens_are_reported_by_role_with_the_orchestrator_apart,
    StatsRun {
        trace: vec![
            agent_at(1, "spec-flow:reviewer", "s1") + " effort=low agent_id=a1",
            tok_line(2, "implement", "sidechain=true in=10 out=300 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=12000 agent_id=a1"),
            tok_line(3, "implement", "sidechain=false in=10 out=900 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=12000"),
            tok_line(4, "implement", "sidechain=true in=10 out=50 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=12000 agent_id=a9"),
        ],
        gate: vec![pass_at(5)],
        ..Default::default()
    },
    |r| {
        want_all(r, &["orchestrator  model-alpha  in 10  out ≥900", "reviewer (1 agent(s), effort low)  model-alpha  in 10  out ≥300", "unattributed (1 agent(s))  model-alpha  in 10  out ≥50", "largest prompt 12k"]);
    }
);

stats_case!(
    /// A role's cost is its messages times the prompt each re-read.
    each_role_reports_its_messages_and_its_average_prompt_per_message,
    StatsRun {
        trace: vec![
            agent_at(1, "spec-flow:reviewer", "s1") + " agent_id=a1",
            tok_line(2, "implement", "sidechain=false in=10 out=100 cache_read=100000 cache_write=10000 think=0 msgs=2 max_prompt=60000"),
            tok_line(3, "implement", "sidechain=false in=10 out=100 cache_read=200000 cache_write=20000 think=0 msgs=3 max_prompt=60000"),
            tok_line(4, "implement", "sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=9 agent_id=a1"),
        ],
        gate: vec![pass_at(5)],
        ..Default::default()
    },
    |r| {
        want_all(r, &["largest prompt 60k  5 msg, ~66k prompt/msg"]);
    }
);

stats_case!(
    /// An advisor is billed at its own model's rates, outside the request that
    /// consulted it.
    an_advisors_tokens_are_reported_apart_under_the_role_that_consulted_it,
    StatsRun {
        trace: vec![
            format!("{} phase=plan agent type=spec-flow:planner status=PLAN_READY effort=high agent_id=a1", stamp(1)),
            format!("{} phase=plan tokens model=model-alpha sidechain=true in=10 out=300 cache_read=0 cache_write=0 msgs=1 max_prompt=9 think=0 agent_id=a1", stamp(2)),
            format!("{} phase=plan tokens model=model-gamma sidechain=true advisor=true in=10 out=1612 cache_read=0 cache_write=0 msgs=1 max_prompt=9 agent_id=a1", stamp(3)),
            format!("{} phase=plan tokens model=model-gamma sidechain=false advisor=true in=10 out=40 cache_read=0 cache_write=0 msgs=1 max_prompt=9", stamp(4)),
        ],
        gate: vec![pass_at(5)],
        ..Default::default()
    },
    |r| {
        want_all(r, &["planner (1 agent(s), effort high)  model-alpha  in 10  out ≥300", "advisor ← planner (1 agent(s))  model-gamma  in 10  out ≥2k", "advisor ← orchestrator  model-gamma  in 10  out ≥40", "model-gamma  advisor   in 20  out ≥2k  cache_read 0  think ?"]);
    }
);

stats_case!(
    /// A 1-hour write costs 2× input and a 5-minute one 1.25×: priced only
    /// once split.
    a_roles_cache_writes_are_split_by_ttl_where_every_line_of_it_carries_the_split,
    StatsRun {
        trace: vec![
            agent_at(1, "spec-flow:reviewer", "s1") + " agent_id=a1",
            tok_line(2, "implement", "sidechain=true in=10 out=1 cache_read=0 cache_write=1200 think=0 cache_write_5m=1200 cache_write_1h=0 msgs=1 max_prompt=9 agent_id=a1"),
            tok_line(3, "implement", "sidechain=true in=10 out=1 cache_read=0 cache_write=300 think=0 cache_write_5m=100 cache_write_1h=200 msgs=1 max_prompt=9 agent_id=a1"),
            tok_line(4, "implement", "sidechain=false in=10 out=1 cache_read=0 cache_write=700 think=0 cache_write_5m=0 cache_write_1h=700 msgs=1 max_prompt=9"),
            tok_line(5, "implement", "sidechain=false in=10 out=1 cache_read=0 cache_write=50 think=0 msgs=1 max_prompt=9"),
        ],
        gate: vec![pass_at(6)],
        ..Default::default()
    },
    |r| {
        must_not_match(r"orchestrator .*\(5m ", r, "a split was printed for a role with a line that carried none");
        want_all(r, &["cache_write 2k (5m 1k, 1h 200)"]);
    }
);

stats_case!(
    /// A PASS with no failure since the previous PASS; skip-dirty is no failure.
    passed_the_first_time_counts_a_pass_with_no_failure_since_the_previous_one,
    StatsRun { gate: vec![gate_fail(1, "fail"), pass_at(2), gate_dirty(3), pass_at(4), gate_fail(5, "fail"), gate_fail(6, "fail"), pass_at(7)], ..Default::default() },
    |r| {
        want_all(r, &["passed the first time: 1 of 3 PASS(es)"]);
    }
);

stats_case!(
    /// The gate never writes a bare `fail`: every refusal is `fail:<class>`.
    passed_the_first_time_counts_the_failures_the_gate_writes,
    StatsRun { gate: vec![gate_fail(1, "fail:behaviour"), pass_at(2), gate_dirty(3), pass_at(4), gate_fail(5, "fail:lint/trace"), gate_fail(6, "fail:killed"), pass_at(7)], ..Default::default() },
    |r| {
        want_all(r, &["passed the first time: 1 of 3 PASS(es)"]);
    }
);

stats_case!(
    returns_the_agent_gate_sent_back_are_counted_by_why_and_so_are_the_ones_let_through_or_not_fully_judged,
    StatsRun {
        trace: vec![agent_check(1, "block", "no-status"), agent_check(2, "block", "no-status"), agent_check(3, "cap", "no-status"), agent_check(4, "skip", "unattributed"), agent_at(5, "spec-flow:reviewer", "s1") + " agent_id=a1"],
        gate: vec![pass_at(6)],
        ..Default::default()
    },
    |r| {
        want_all(r, &["agent gate: 2 return(s) sent back (no-status x2), 1 let through at the cap (no-status x1), 1 not fully judged (unattributed x1).", "reviewer: 1 DONE"]);
    }
);

stats_case!(
    /// ADR-035: the guard's records by agent and reason, and how often
    /// arm-gate moved the phase.
    dispatches_off_the_commands_contract_are_counted_by_agent_and_reason_and_so_are_the_gates_armings,
    StatsRun {
        trace: vec![
            dispatch(1, "implement", "reviewer", "record", "phase"),
            dispatch(2, "implement", "implementer", "record", "no-milestone,other-files"),
            dispatch(3, "plan", "implementer", "armed", "phase"),
            dispatch(4, "spec", "implementer", "deny", "case-3-unanswered"),
        ],
        gate: vec![pass_at(5)],
        ..Default::default()
    },
    |r| {
        want_all(r, &[
            "dispatch: 2 off the commands' contract (reviewer:phase x1, implementer:no-milestone x1, implementer:other-files x1), recorded, not denied; the gate armed by arm-gate 1 time(s), the implementer denied 1 time(s) (implementer:case-3-unanswered x1).",
            "read the `dispatch` lines with --raw",
        ]);
    }
);

stats_case!(
    /// ADR-040: told apart from the rules ADR-035 weighs.
    a_spec_writer_or_planner_with_no_run_phase_reads_as_a_run_that_skipped_step_0,
    StatsRun { trace: vec![no_run(1, "done", "spec-writer"), no_run(2, "done", "planner")], gate: vec![pass_at(3)], ..Default::default() },
    |r| {
        want_none(r, "no-run dispatches were reported as rules to weigh", &["read the `dispatch` lines with --raw"]);
        want_all(r, &["dispatch: 0 off the commands' contract, recorded, not denied", "2 spec-writer or planner spawn(s) with no run phase (spec-writer:no-run x1, planner:no-run x1)"]);
    }
);

stats_case!(
    /// A question between runs lands before the next `--mark`, in
    /// `(current)` for good.
    any_other_agent_outside_a_run_is_reported_not_warned_about_and_is_no_run,
    StatsRun {
        trace: vec![no_run(9, "done", "architect"), no_run(10, "done", "implementer")],
        archived: vec![Snapshot { slug: "refunds", gate: vec![pass_at(5)], trace: vec![agent_at(4, "spec-flow:implementer", "")] }],
        ..Default::default()
    },
    |r| {
        want_none(r, "a question between runs read as a skipped step 0", &["skipped writing `spec`"]);
        want_none(r, "the slice holding only outside-run lines was counted as a run", &["across 2 run(s)"]);
        want_all(r, &["outside a run: 2 of this flow's agent(s) put to work (architect:no-run x1, implementer:no-run x1)"]);
    }
);

stats_case!(
    /// ADR-034: a run where orchestrator-scope never armed is not one where
    /// nothing was denied.
    a_run_where_orchestrator_scope_or_the_case_3_check_stood_down_says_so,
    StatsRun {
        gate: vec![pass_at(1)],
        files: files! {".claude/state/orchestrator-scope-unmatched.log" => "x phase=spec tool=Read unattributed\n", ".claude/state/human-turn-unmatched.log" => "x case-3 check stood down\n"},
        ..Default::default()
    },
    |r| {
        want_all(r, &["note: 1 session calls orchestrator-scope let through", "note: 1 case 3 checks that stood down"]);
    }
);

#[test]
fn no_telemetry_at_all_says_so_and_still_exits_0() {
    let r = stats_report(StatsRun::default());
    expect_status(&r, 0, "this command must always exit 0");
    want_all(&r.out(), &["Session reuse", "no run trace yet"]);
}

// ---- reads against the change's scope, read off the deltas and the milestone
// paths: over a scope of nothing, the answer is UNKNOWN.

stats_case!(
    reads_are_split_against_the_scope_read_off_the_deltas_and_the_milestone_paths,
    StatsRun {
        files: orders("specflow/archive/ship-orders"),
        archived: vec![Snapshot {
            slug: "ship-orders",
            trace: vec![
                read_in(1, "plan", "lib/orders/place.ts"),
                read_in(2, "plan", "lib/billing/invoice.ts"),
                read_in(3, "plan", "lib/billing/tax.ts"),
                read_in(4, "plan", "lib/billing/refund.ts"),
                read_in(5, "plan", "specs/orders.md"),
                read_in(6, "plan", "/opt/elsewhere/engine/scripts/gate.mjs"),
            ],
            ..Default::default()
        }],
        ..Default::default()
    },
    |r| {
        want_all(
            r,
            &[
                "ship-orders: scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))",
                "plan: 6 read(s), 4 outside the scope — lib/billing x3, (outside the repository) x1",
                "the planner read more outside the change's scope (4) than inside it (2)",
            ],
        );
    }
);

stats_case!(
    a_planner_reading_mostly_inside_the_scope_is_reported_and_not_warned_about,
    StatsRun {
        files: orders("specflow/archive/ship-orders"),
        archived: vec![Snapshot {
            slug: "ship-orders",
            trace: vec![
                read_in(1, "plan", "lib/orders/place.ts"),
                read_in(2, "plan", "lib/orders/cancel.ts"),
                read_in(3, "plan", "lib/billing/tax.ts")
            ],
            ..Default::default()
        }],
        ..Default::default()
    },
    |r| {
        want_all(
            r,
            &["plan: 3 read(s), 1 outside the scope — lib/billing x1"],
        );
        want_none(
            r,
            "warned about a planner that mostly stayed inside the scope",
            &["read more outside"],
        );
    }
);

stats_case!(
    a_change_whose_scope_cannot_be_derived_reports_unknown_not_zero,
    StatsRun {
        files: files! {"specflow/archive/mystery/spec.md" => "# Spec — mystery\n\n## Requirement deltas\n- none — wiring only\n"},
        archived: vec![Snapshot {
            slug: "mystery",
            trace: vec![read_in(1, "plan", "lib/billing/tax.ts")],
            ..Default::default()
        }],
        ..Default::default()
    },
    |r| {
        want_all(r, &["mystery: scope UNKNOWN"]);
        want_none(
            r,
            "counted reads against a scope that could not be derived",
            &["outside the scope"],
        );
    }
);

stats_case!(
    an_absolute_path_under_the_repo_is_the_repos_own_file_whichever_slashes_it_carries_and_a_live_change_scopes_the_current_run,
    StatsRun {
        files: orders("specflow/ship-orders"),
        trace_for: Some(|repo| vec![read_in(1, "plan", &repo.join("lib").join("orders").join("place.ts").to_string_lossy()), read_in(2, "plan", &repo.join("lib").join("billing").join("tax.ts").to_string_lossy())]),
        ..Default::default()
    },
    |r| {
        want_all(r, &["scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))", "plan: 2 read(s), 1 outside the scope — lib/billing x1"]);
    }
);

// ---- the two tiers overlap: a snapshot is a slice of the live log, so
// reading both as runs inflates every number invisibly.

stats_case!(
    a_snapshot_that_duplicates_the_live_log_is_one_invocation_not_two,
    StatsRun {
        gate: vec![pass_at(4)],
        archived: vec![Snapshot {
            slug: "shipped",
            gate: vec![pass_at(4)],
            ..Default::default()
        }],
        ..Default::default()
    },
    |r| {
        want_all(r, &["1 invocation(s)"]);
        want_none(
            r,
            "counted one gate invocation twice, once per tier",
            &["2 invocation(s)"],
        );
    }
);

stats_case!(
    a_live_line_with_no_snapshot_yet_is_still_counted,
    StatsRun {
        gate: vec![pass_at(4), pass_at(6)],
        archived: vec![Snapshot {
            slug: "shipped",
            gate: vec![pass_at(4)],
            ..Default::default()
        }],
        ..Default::default()
    },
    |r| {
        want_all(r, &["2 invocation(s)"]);
        want_none(r, "double-counted the archived line", &["3 invocation(s)"]);
    }
);

stats_case!(
    a_milestone_held_in_both_tiers_is_reported_once,
    {
        let (trace, gate) = (
            vec![
                agent_at(1, "implementer", ""),
                read_at(2, "x/one.ts", ""),
                read_at(3, "x/one.ts", ""),
            ],
            vec![pass_at(4)],
        );
        StatsRun {
            trace: trace.clone(),
            gate: gate.clone(),
            archived: vec![Snapshot {
                slug: "shipped",
                trace,
                gate,
            }],
            ..Default::default()
        }
    },
    |r| {
        assert_eq!(
            r.matches("milestone 1:").count(),
            1,
            "milestone 1 was reported more than once; the run happened once.\n{r}"
        );
    }
);

stats_case!(
    /// Recorded on Windows under another user's directory, every read would
    /// point "outside the repository" from here.
    an_archived_run_recorded_under_another_root_reads_as_this_repo,
    StatsRun {
        files: orders("specflow/archive/ship-orders"),
        archived: vec![Snapshot {
            slug: "ship-orders",
            trace: vec![
                read_in(1, "plan", r"C:\Users\someone\work\shop\specflow\ship-orders\spec.md"),
                read_in(2, "plan", r"C:\Users\someone\work\shop\lib\orders\place.ts"),
                read_in(3, "plan", r"C:\Users\someone\work\shop\lib\billing\tax.ts"),
                read_in(4, "plan", r"C:\Users\someone\AppData\engine\scripts\gate.mjs"),
            ],
            ..Default::default()
        }],
        ..Default::default()
    },
    |r| {
        want_all(r, &["plan: 4 read(s), 2 outside the scope — lib/billing x1, (outside the repository) x1"]);
    }
);

// ---- test-first: a test written, run red, then the code

fn trace(lines: Vec<String>) -> StatsRun {
    StatsRun {
        trace: lines,
        ..Default::default()
    }
}

stats_case!(
    a_test_written_run_red_then_its_code_is_red_first,
    trace(vec![
        write_at(1, "tests/orders/place.spec.ts"),
        ran_place(2, "red", ""),
        write_at(3, "lib/orders/place.ts")
    ]),
    |r| {
        want_all(&test_first(r), &["OK   lib/orders/place.ts  (red-first)"]);
    }
);

stats_case!(
    code_written_before_its_test_is_code_first,
    trace(vec![
        write_at(1, "lib/orders/place.ts"),
        write_at(2, "tests/orders/place.spec.ts")
    ]),
    |r| {
        want_all(&test_first(r), &["MISS lib/orders/place.ts  (code-first)"]);
    }
);

stats_case!(
    /// Read long after both were written, a module and its test would read as
    /// "code first".
    a_module_and_its_test_that_were_only_read_are_not_paired,
    trace(vec![read_at(1, "lib/orders/place.ts", ""), read_at(2, "tests/orders/place.spec.ts", ""), write_at(3, "lib/other.ts")]),
    |r| {
        want_none(&test_first(r), "paired two files that were only read", &["place.ts"]);
    }
);

stats_case!(
    /// A run the trace could not judge is not a run that did not happen.
    a_test_run_with_no_readable_verdict_is_unmeasured_not_missed,
    trace(vec![write_at(1, "tests/orders/place.spec.ts"), ran_place(2, "?", "pipe"), write_at(3, "lib/orders/place.ts")]),
    |r| {
        want_none(&test_first(r), "reported an unreadable run as no red run", &["no-red-run"]);
        want_all(&test_first(r), &["?    lib/orders/place.ts  (a test run the trace could not judge: pipe)"]);
        want_all(r, &["unmeasured, not missed"]);
    }
);

stats_case!(
    /// A file that did not load ran none of its tests: no test was seen to fail.
    a_test_run_only_while_its_file_did_not_load_is_not_red_first,
    trace(vec![write_at(1, "tests/orders/place.spec.ts"), ran_place(2, "absent", ""), write_at(3, "lib/orders/place.ts")]),
    |r| {
        want_all(&test_first(r), &["MISS lib/orders/place.ts  (did-not-load)"]);
        want_all(r, &["1 of 1 source file(s) had their test run before the code only while the test file could not load"]);
        want_none(r, "called a run that did not load a missing run", &["show no red test run"]);
    }
);

stats_case!(
    /// The stub the implementer writes so its test loads is not the code.
    a_stub_then_a_red_run_then_the_code_is_red_first,
    trace(vec![write_at(1, "tests/orders/place.spec.ts"), write_at(2, "lib/orders/place.ts"), ran_place(3, "red", ""), write_at(4, "lib/orders/place.ts")]),
    |r| {
        want_all(&test_first(r), &["OK   lib/orders/place.ts  (red-first)"]);
    }
);

stats_case!(
    a_red_run_after_the_codes_last_write_is_not_before_the_code,
    trace(vec![
        write_at(1, "tests/orders/place.spec.ts"),
        write_at(2, "lib/orders/place.ts"),
        ran_place(3, "red", "")
    ]),
    |r| {
        want_all(&test_first(r), &["MISS lib/orders/place.ts  (no-red-run)"]);
    }
);

stats_case!(
    /// A milestone that passed is done: a later edit of its code does not
    /// reopen it.
    a_red_run_after_the_code_first_passed_is_not_before_the_code,
    StatsRun { trace: vec![write_at(1, "tests/orders/place.spec.ts"), write_at(2, "lib/orders/place.ts"), ran_place(4, "red", ""), write_at(5, "lib/orders/place.ts")], gate: vec![pass_at(3)], ..Default::default() },
    |r| {
        want_all(&test_first(r), &["MISS lib/orders/place.ts  (no-red-run)"]);
    }
);

stats_case!(
    a_red_run_after_one_that_did_not_load_is_red_first,
    trace(vec![
        write_at(1, "tests/orders/place.spec.ts"),
        ran_place(2, "absent", ""),
        ran_place(3, "red", ""),
        write_at(4, "lib/orders/place.ts")
    ]),
    |r| {
        want_all(&test_first(r), &["OK   lib/orders/place.ts  (red-first)"]);
    }
);

stats_case!(
    /// Only a run of this test speaks for it, and one that did not load says
    /// nothing of another.
    a_run_that_did_not_load_of_other_tests_or_a_glob_leaves_the_test_missed,
    trace(three_pairs(vec![ran_on(10, "absent", "tests/orders/place.spec.ts", ""), ran_on(11, "absent", "tests/orders/*.spec.ts", "")])),
    |r| {
        want_all(&test_first(r), &["MISS lib/orders/place.ts  (did-not-load)", "MISS lib/orders/ship.ts  (no-red-run)"]);
    }
);

stats_case!(
    a_question_mark_with_no_why_is_unmeasured_too,
    trace(vec![
        write_at(1, "tests/orders/place.spec.ts"),
        ran_place(2, "?", ""),
        write_at(3, "lib/orders/place.ts")
    ]),
    |r| {
        want_all(
            &test_first(r),
            &["(a test run the trace could not judge: not-recorded)"],
        );
    }
);

stats_case!(
    a_question_mark_that_was_not_a_failed_test_run_leaves_the_miss_standing,
    trace(vec![
        write_at(1, "tests/orders/place.spec.ts"),
        ran_place(2, "?", "not-the-runner"),
        write_at(3, "lib/orders/place.ts")
    ]),
    |r| {
        want_all(&test_first(r), &["MISS lib/orders/place.ts  (no-red-run)"]);
    }
);

stats_case!(
    the_test_first_warning_counts_source_files_and_the_runs_they_span,
    {
        let one = vec![
            write_at(1, "tests/orders/place.spec.ts"),
            write_at(2, "lib/orders/place.ts"),
        ];
        let two = one.iter().map(|l| l.replacen("10:0", "11:0", 1)).collect();
        StatsRun {
            archived: vec![
                Snapshot {
                    slug: "one",
                    trace: one,
                    ..Default::default()
                },
                Snapshot {
                    slug: "two",
                    trace: two,
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    },
    |r| {
        want_all(
            r,
            &["2 of 2 source file(s) across 2 runs show no red test run before the code"],
        );
    }
);

stats_case!(
    /// A verdict is evidence for the test it ran, not for every test written
    /// before it.
    a_red_run_of_one_test_credits_that_test_alone,
    trace(three_pairs(vec![ran_on(10, "red", "tests/orders/place.spec.ts", "")])),
    |r| {
        want_all(&test_first(r), &["OK   lib/orders/place.ts  (red-first)", "MISS lib/orders/cancel.ts  (no-red-run)", "MISS lib/orders/ship.ts  (no-red-run)"]);
    }
);

stats_case!(
    an_unreadable_run_of_one_test_leaves_the_others_missed_not_unmeasured,
    trace(three_pairs(vec![ran_on(
        10,
        "?",
        "tests/orders/place.spec.ts",
        "pipe"
    )])),
    |r| {
        want_all(
            &test_first(r),
            &[
                "?    lib/orders/place.ts  (a test run the trace could not judge: pipe)",
                "MISS lib/orders/ship.ts  (no-red-run)",
            ],
        );
    }
);

stats_case!(
    a_red_run_of_the_tests_directory_credits_each_test_under_it,
    trace(three_pairs(vec![ran_on(10, "red", "tests/orders", "")])),
    |r| {
        want_all(
            &test_first(r),
            &[
                "OK   lib/orders/place.ts  (red-first)",
                "OK   lib/orders/cancel.ts  (red-first)",
                "OK   lib/orders/ship.ts  (red-first)",
            ],
        );
    }
);

stats_case!(
    a_red_run_that_names_no_path_is_unjudged_not_credited,
    trace(three_pairs(vec![ran_on(10, "red", "-", "")])),
    |r| {
        want_all(
            &test_first(r),
            &["?    lib/orders/ship.ts  (a test run the trace could not judge: no-path)"],
        );
    }
);

stats_case!(
    /// A whole-suite run with its output thrown away, as an older trace
    /// recorded it.
    a_target_holding_only_a_redirection_names_no_path,
    trace(three_pairs(vec![ran_on(10, "red", ">/dev/null;", "")])),
    |r| {
        want_all(&test_first(r), &["?    lib/orders/ship.ts  (a test run the trace could not judge: no-path)"]);
    }
);

stats_case!(
    /// jest and vitest match an argument anywhere in a path: `place.spec.ts`
    /// runs `replace.spec.ts` too.
    a_name_found_inside_a_tests_name_not_at_a_path_segment_is_unjudged,
    trace(vec![write_at(1, "tests/orders/replace.spec.ts"), ran_on(2, "red", "place.spec.ts", ""), write_at(3, "lib/orders/replace.ts")]),
    |r| {
        want_all(&test_first(r), &["?    lib/orders/replace.ts  (a test run the trace could not judge: pattern)"]);
    }
);

stats_case!(
    /// A run that loaded a config or a module, or matched a glob, ran a suite
    /// the trace cannot see into.
    a_run_naming_only_a_config_a_module_or_a_glob_is_unjudged_never_a_miss,
    trace(three_pairs(vec![ran_on(10, "red", "config/unit.json", ""), ran_on(11, "red", "ts-node/register", ""), ran_on(12, "red", "tests/orders/*.spec.ts", "")])),
    |r| {
        want_all(&test_first(r), &["?    lib/orders/ship.ts  (a test run the trace could not judge: no-test-path,glob)"]);
    }
);

stats_case!(
    a_run_of_another_directory_of_tests_is_not_a_run_of_these,
    trace(three_pairs(vec![ran_on(10, "red", "tests/billing", "")])),
    |r| {
        want_all(&test_first(r), &["MISS lib/orders/ship.ts  (no-red-run)"]);
    }
);

stats_case!(
    a_target_is_matched_past_dot_slash_dot_dot_a_subshell_paren_and_from_git_bash,
    {
        let at = |p: &str| format!(r"C:\Users\i\repo\{}", p.replace('/', "\\"));
        let mut lines = vec![
            write_at(1, &at("tests/orders/place.spec.ts")),
            write_at(2, &at("tests/orders/cancel.spec.ts")),
            write_at(3, &at("tests/orders/ship.spec.ts")),
            write_at(4, &at("tests/orders/pack.spec.ts")),
            ran_on(5, "red", "./tests/orders/place.spec.ts", ""),
            ran_on(6, "red", "../tests/orders/cancel.spec.ts)", ""),
            ran_on(7, "red", "/c/Users/i/repo/tests/orders/ship.spec.ts", ""),
            ran_on(8, "red", r"tests\\orders\\pack.spec.ts", ""),
        ];
        for (i, m) in ["place", "cancel", "ship", "pack"].iter().enumerate() {
            lines.push(write_at(10 + i as u32, &at(&format!("lib/orders/{m}.ts"))));
        }
        trace(lines)
    },
    |r| {
        want_all(
            &test_first(r),
            &[
                "place.ts  (red-first)",
                "cancel.ts  (red-first)",
                "ship.ts  (red-first)",
                "pack.ts  (red-first)",
            ],
        );
    }
);

stats_case!(
    /// Two changes in one log can each write a `utils.spec.ts`.
    a_source_is_credited_by_a_red_run_of_any_test_under_its_tests_name,
    trace(vec![write_at(1, "tests/item/utils.spec.ts"), write_at(2, "lib/item/utils.ts"), write_at(3, "tests/city/utils.spec.ts"), ran_on(4, "red", "tests/city/utils.spec.ts", ""), write_at(5, "lib/city/utils.ts")]),
    |r| {
        want_all(&test_first(r), &["OK   lib/city/utils.ts  (red-first)", "MISS lib/item/utils.ts  (no-red-run)"]);
    }
);

stats_case!(
    /// The shape a real run left: Windows paths written, a relative target
    /// run, and a target that kept another command's words beside the runner's.
    a_target_is_matched_to_a_windows_path_and_past_what_another_command_left_in_it,
    trace(vec![
        write_at(1, r"C:\Users\someone\repo\tests\orders\place.spec.ts"),
        write_at(2, r"C:\Users\someone\repo\tests\orders\ship.spec.ts"),
        ran_on(3, "red", "tests/orders/place.spec.ts;,>/dev/null;,node_modules/eslint/bin/eslint.js", ""),
        write_at(4, r"C:\Users\someone\repo\lib\orders\place.ts"),
        write_at(5, r"C:\Users\someone\repo\lib\orders\ship.ts"),
    ]),
    |r| {
        want_all(&test_first(r), &["place.ts  (red-first)"]);
        want_none(&test_first(r), "credited a test no run named", &["ship.ts  (red-first)"]);
    }
);

// ---- the gate: a PASS followed by nothing. The next milestone's implementer
// works as long as it takes; the next gate line comes after.

stats_case!(
    a_pass_followed_by_the_next_milestone_working_is_not_a_stall,
    StatsRun {
        archived: vec![Snapshot {
            slug: "shipped",
            gate: vec![pass_at(0), pass_at(11)],
            trace: vec![
                agent_at(1, "implementer", ""),
                read_at(2, "lib/orders/place.ts", ""),
                read_at(9, "lib/orders/ship.ts", "")
            ]
        }],
        ..Default::default()
    },
    |r| {
        want_none(
            r,
            "called a working milestone a stall",
            &["had to be nudged"],
        );
    }
);

stats_case!(
    a_pass_followed_by_nothing_at_all_is_a_stall,
    StatsRun {
        archived: vec![Snapshot {
            slug: "shipped",
            gate: vec![pass_at(0), pass_at(15)],
            trace: vec![read_at(15, "lib/orders/place.ts", "")]
        }],
        ..Default::default()
    },
    |r| {
        want_all(r, &["had to be nudged"]);
    }
);

stats_case!(
    /// A closed run's last PASS is followed by the line that closed it.
    a_pass_followed_by_the_run_closing_is_no_stall_whenever_the_next_run_starts,
    StatsRun { archived: vec![Snapshot { slug: "two-runs", gate: vec![pass_at(0), pass_at(200)], trace: vec![format!("{} phase=done session=s closed tool=Write", stamp(1)), read_at(200, "lib/orders/place.ts", "")] }], ..Default::default() },
    |r| {
        want_none(r, "called a finished run a stall", &["had to be nudged"]);
    }
);

stats_case!(
    /// What the closing turn costs lands in `(current)` after the snapshot.
    the_closing_turns_tokens_left_in_current_are_no_run_of_their_own,
    StatsRun {
        trace: vec![format!("{} phase=done session=s tokens model=model-alpha sidechain=false in=10 out=7 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=900", stamp(30))],
        archived: vec![Snapshot { slug: "refunds", gate: vec![pass_at(5)], trace: vec![read_at(4, "lib/orders/place.ts", "")] }],
        ..Default::default()
    },
    |r| {
        want_none(r, "the closing turn was counted as a run", &["across 2 run(s)"]);
        want_all(r, &["1 invocation(s): 1 pass"]);
    }
);

stats_case!(
    a_closed_run_shows_no_open_milestone_and_its_closing_turn_is_charged_to_it,
    StatsRun {
        trace: vec![format!(
            "{} phase=done session=s1 tokens model=model-alpha sidechain=false in=10 out=7 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=900",
            stamp(7)
        )],
        archived: vec![Snapshot {
            slug: "refunds",
            gate: vec![pass_at(5)],
            trace: vec![
                format!(
                    "{} phase=plan session=s1 tokens model=model-alpha sidechain=true in=1 out=1 cache_read=0 cache_write=0 think=0 msgs=1 max_prompt=9 agent_id=a1",
                    stamp(3)
                ),
                format!(
                    "{} phase=plan session=s1 agent type=spec-flow:planner status=PLAN_READY agent_id=a1",
                    stamp(3)
                ),
                read_at(4, "lib/orders/place.ts", ""),
                format!("{} phase=done session=s1 closed tool=Write", stamp(6)),
            ],
        }],
        ..Default::default()
    },
    |r| {
        want_none(
            r,
            "a closed run shows an open milestone",
            &["never reached a PASS"],
        );
        want_none(r, "the closing turn stayed in (current)", &["[(current)]"]);
        must_match(
            r"(?s)by role \[refunds\]:.*?orchestrator\s+model-alpha\s+in 10\s+out ≥7 ",
            r,
            "the closing turn was not charged to its run",
        );
    }
);

stats_case!(
    a_live_pass_with_an_implementer_still_working_is_not_stalled_right_now,
    StatsRun {
        gate: vec![format!(
            "{} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1",
            ago(Duration::from_secs(30 * 60))
        )],
        trace: vec![format!(
            "{} phase=implement read file=lib/orders/place.ts agent_id=a1",
            ago(Duration::from_secs(60))
        )],
        ..Default::default()
    },
    |r| {
        want_none(
            r,
            "called a working milestone stalled",
            &["stalled RIGHT NOW"],
        );
    }
);

stats_case!(
    a_live_pass_with_nothing_since_is_stalled_right_now,
    StatsRun {
        gate: vec![format!(
            "{} abc1234 cc=1.0 engine=0.1.0 phase=implement attempt=1 result=pass lint=0 test=0 unscoped=ok files=1",
            ago(Duration::from_secs(30 * 60))
        )],
        ..Default::default()
    },
    |r| {
        want_all(r, &["the run looks stalled RIGHT NOW"]);
    }
);

fn wrote(repo: &Path, file: &str) {
    run_hook(
        "run-trace",
        json!({"hook_event_name": "PostToolUse", "tool_name": "Write", "tool_input": {"file_path": repo.join(file)}}),
        repo,
    );
}

fn test_first_of(repo: &Path) -> String {
    test_first(
        &run(
            repo,
            &[format!("CLAUDE_PROJECT_DIR={}", repo.display())],
            "",
            &cli_argv(engine_dir(), &["stats"]),
        )
        .out(),
    )
}

/// End to end, hook to report: a test written ahead of its module and run
/// while its file could not load, then the module. Whatever the test
/// asserts, none of it ran, so the run cannot have shown that it can fail.
#[test]
fn a_test_run_while_its_file_did_not_load_is_not_red_first() {
    let repo = with_runner("jest");
    wrote(&repo, "tests/orders/place.spec.ts");
    run_hook(
        "run-trace",
        bash_failure(
            "npx jest tests/orders/place.spec.ts",
            &format!("Exit code 1\n{JEST_LOAD}"),
            json!({}),
        ),
        &repo,
    );
    wrote(&repo, "lib/orders/place.ts");
    let out = test_first_of(&repo);
    want_none(
        &out,
        "credited a run whose file did not load as red-first",
        &["red-first"],
    );
    want_all(
        &out,
        &[&format!(
            "MISS {}  (did-not-load)",
            repo.join("lib/orders/place.ts").display()
        )],
    );
}

/// What run-trace's answer to that run asks for, hook to report: the test, a
/// run that did not load, a stub so it loads, a run that fails, then the code.
#[test]
fn a_stub_then_a_red_run_is_red_first() {
    let repo = with_runner("jest");
    wrote(&repo, "tests/orders/place.spec.ts");
    run_hook(
        "run-trace",
        bash_failure(
            "npx jest tests/orders/place.spec.ts",
            &format!("Exit code 1\n{JEST_LOAD}"),
            json!({}),
        ),
        &repo,
    );
    wrote(&repo, "lib/orders/place.ts");
    run_hook(
        "run-trace",
        bash_failure(
            "npx jest tests/orders/place.spec.ts",
            &format!("Exit code 1\n{JEST_FAIL}"),
            json!({}),
        ),
        &repo,
    );
    wrote(&repo, "lib/orders/place.ts");
    want_all(
        &test_first_of(&repo),
        &[&format!(
            "OK   {}  (red-first)",
            repo.join("lib/orders/place.ts").display()
        )],
    );
}

//! token-trace reads a file this engine does not write — Claude Code's
//! session transcript — so every field it depends on is an observation about
//! another program. These cases pin the shape read off a real transcript:
//! `message.usage`, `message.model`, `message.id`, a top-level `isSidechain`,
//! and each subagent in a file of its own beside the session's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use regex::Regex;
use serde_json::{Value, json};

use crate::harness::*;
use crate::helpers::*;

/// One assistant entry's fields. Model names are deliberately not real ones:
/// the hook treats the value as opaque. ttl adds the split by TTL a current
/// build writes beside the sum; iterations is where an advisor's
/// consultations are.
#[derive(Default, Clone)]
struct Usage {
    model: &'static str,
    sidechain: bool,
    out: i64,
    input: i64,
    cache_read: i64,
    cache_write: i64,
    think: i64,
    id: &'static str,
    ttl: Option<[i64; 2]>,
    iterations: Option<Vec<Value>>,
}

fn entry(u: Usage) -> String {
    let model = if u.model.is_empty() {
        "model-alpha"
    } else {
        u.model
    };
    let out = if u.out == 0 { 100 } else { u.out };
    let input = if u.input == 0 { 10 } else { u.input };
    let mut us = json!({"input_tokens": input, "output_tokens": out, "cache_read_input_tokens": u.cache_read,
        "cache_creation_input_tokens": u.cache_write, "output_tokens_details": {"thinking_tokens": u.think}});
    if let Some([m5, h1]) = u.ttl {
        us["cache_creation"] =
            json!({"ephemeral_5m_input_tokens": m5, "ephemeral_1h_input_tokens": h1});
    }
    if let Some(it) = u.iterations {
        us["iterations"] = json!(it);
    }
    let mut msg = json!({"role": "assistant", "model": model, "usage": us});
    if !u.id.is_empty() {
        msg["id"] = json!(u.id);
    }
    json!({"type": "assistant", "isSidechain": u.sidechain, "timestamp": "2026-08-31T00:00:00.000Z", "message": msg}).to_string() + "\n"
}

fn usage(out: i64) -> Usage {
    Usage {
        out,
        ..Default::default()
    }
}

fn side(out: i64) -> Usage {
    Usage {
        out,
        sidechain: true,
        ..Default::default()
    }
}

/// A consultation as `usage.iterations` reports it: its own model, and counts
/// the message's top-level usage leaves out.
fn advisor_call(input: i64, out: i64) -> Value {
    json!({"type": "advisor_message", "model": "model-gamma", "input_tokens": input, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": out})
}

/// The executor's own step, which the top-level usage already sums.
fn executor_step(out: i64) -> Value {
    json!({"type": "message", "input_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": out})
}

fn token_repo(phase: Option<&str>) -> Dir {
    let repo = temp_dir();
    if let Some(p) = phase {
        write(state_path(&repo, "phase"), &format!("{p}\n"));
    }
    repo
}

fn transcript(repo: &Path, lines: &[String]) -> PathBuf {
    let path = repo.join("transcript.jsonl");
    write(&path, &lines.concat());
    path
}

/// Where the harness puts a subagent's own transcript: beside the session's.
fn subagent_transcript(session: &Path, name: &str, lines: &[String]) -> PathBuf {
    let path = session
        .with_extension("")
        .join("subagents")
        .join(format!("agent-{name}.jsonl"));
    write(&path, &lines.concat());
    path
}

struct Stopped {
    code: i32,
    stderr: String,
    lines: Vec<String>,
}

fn stop(repo: &Path, transcript: Option<&Path>, extra: Value) -> Stopped {
    let mut payload = json!({"session_id": "sess-1", "hook_event_name": "Stop"});
    if let Some(t) = transcript {
        payload["transcript_path"] = json!(t);
    }
    merge(&mut payload, extra);
    let r = run_hook("token-trace", payload, repo);
    Stopped {
        code: r.status,
        stderr: r.stderr,
        lines: read(state_path(repo, "run-trace.log"))
            .split('\n')
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect(),
    }
}

/// key's value on a trace line, if it is there.
fn field(line: &str, key: &str) -> Option<String> {
    Regex::new(&format!(r"(?:^| ){}=(\S+)", regex::escape(key)))
        .unwrap()
        .captures(line)
        .map(|m| m[1].to_string())
}

fn f(line: &str, key: &str) -> String {
    field(line, key).unwrap_or_default()
}

fn line_where(lines: &[String], ok: impl Fn(&str) -> bool) -> String {
    lines.iter().find(|l| ok(l)).cloned().unwrap_or_default()
}

#[track_caller]
fn want_fields(line: &str, want: &[(&str, &str)]) {
    let wrong: Vec<String> = want
        .iter()
        .filter(|(k, v)| f(line, k) != *v)
        .map(|(k, v)| format!("{k}: want {v}, got {:?}", f(line, k)))
        .collect();
    assert!(
        wrong.is_empty(),
        "{}\n--- line ---\n{line}",
        wrong.join("\n")
    );
}

#[track_caller]
fn want_lines(s: &Stopped, n: usize, why: &str) {
    assert_eq!(s.lines.len(), n, "{why}:\n{}", s.lines.join("\n"));
}

const AGENT_A: &str = "a0123456789abcdef";

fn sidechain(l: &str) -> bool {
    f(l, "sidechain") == "true"
}

fn main_line(l: &str) -> bool {
    f(l, "sidechain") == "false"
}

/// One token case, in a repository whose phase is `implement`.
macro_rules! token_case {
    ($(#[$doc:meta])* $name:ident, |$repo:ident| $body:block) => {
        $(#[$doc])*
        #[test]
        fn $name() {
            let $repo = token_repo(Some("implement"));
            let $repo: &Path = &$repo;
            $body
        }
    };
}

// ---- the shape it reads

token_case!(
    a_transcript_with_usage_produces_one_line_per_model_carrying_every_counter,
    |repo| {
        let s = stop(
            repo,
            Some(&transcript(
                repo,
                &[entry(Usage {
                    out: 100,
                    input: 10,
                    cache_read: 5000,
                    cache_write: 700,
                    think: 40,
                    ..Default::default()
                })],
            )),
            json!({}),
        );
        assert_eq!(s.code, 0, "an observer must always exit 0");
        want_lines(&s, 1, "one model");
        want_fields(
            &s.lines[0],
            &[
                ("model", "model-alpha"),
                ("sidechain", "false"),
                ("in", "10"),
                ("out", "100"),
                ("cache_read", "5000"),
                ("cache_write", "700"),
                ("think", "40"),
                ("msgs", "1"),
            ],
        );
    }
);

token_case!(
    a_subagent_and_its_spawner_are_counted_apart_not_merged_into_one_total,
    |repo| {
        let s = stop(
            repo,
            Some(&transcript(
                repo,
                &[entry(usage(100)), entry(side(30)), entry(side(70))],
            )),
            json!({}),
        );
        let (m, sub) = (
            line_where(&s.lines, main_line),
            line_where(&s.lines, sidechain),
        );
        assert!(
            !m.is_empty() && !sub.is_empty(),
            "expected a main line and a subagent line, got:\n{}",
            s.lines.join("\n")
        );
        want_fields(&m, &[("out", "100")]);
        want_fields(&sub, &[("out", "100"), ("msgs", "2")]);
    }
);

token_case!(
    two_models_in_one_turn_are_two_lines_a_whitespace_split_log_cannot_hold_a_repeated_key,
    |repo| {
        let s = stop(
            repo,
            Some(&transcript(
                repo,
                &[
                    entry(Usage {
                        model: "model-alpha",
                        ..Default::default()
                    }),
                    entry(Usage {
                        model: "model-beta",
                        ..Default::default()
                    }),
                ],
            )),
            json!({}),
        );
        want_lines(&s, 2, "two models");
        assert_ne!(
            f(&s.lines[0], "model"),
            f(&s.lines[1], "model"),
            "expected two lines naming two models:\n{}",
            s.lines.join("\n")
        );
    }
);

// ---- what Claude Code writes

token_case!(
    a_subagent_transcript_beside_the_session_transcript_is_counted_as_a_sidechain,
    |repo| {
        let tr = transcript(repo, &[entry(usage(100))]);
        subagent_transcript(&tr, AGENT_A, &[entry(side(30)), entry(side(70))]);
        let sub = line_where(&stop(repo, Some(&tr), json!({})).lines, sidechain);
        assert!(
            !sub.is_empty(),
            "no subagent line — every subagent the flow spawns is missing from the cost"
        );
        want_fields(&sub, &[("out", "100"), ("msgs", "2")]);
    }
);

token_case!(
    a_message_written_over_several_lines_is_counted_once,
    |repo| {
        let b = Usage {
            id: "msg_1",
            out: 100,
            input: 3,
            cache_read: 60000,
            cache_write: 900,
            ..Default::default()
        };
        let s = stop(
            repo,
            Some(&transcript(
                repo,
                &[entry(b.clone()), entry(b.clone()), entry(b)],
            )),
            json!({}),
        );
        want_lines(&s, 1, "one message");
        want_fields(
            &s.lines[0],
            &[
                ("msgs", "1"),
                ("in", "3"),
                ("cache_read", "60000"),
                ("cache_write", "900"),
                ("out", "100"),
            ],
        );
    }
);

token_case!(
    a_messages_output_is_the_largest_count_its_lines_carry_not_their_sum,
    |repo| {
        let s = stop(
            repo,
            Some(&transcript(
                repo,
                &[
                    entry(Usage {
                        id: "msg_1",
                        out: 3,
                        ..Default::default()
                    }),
                    entry(Usage {
                        id: "msg_1",
                        out: 150,
                        think: 120,
                        ..Default::default()
                    }),
                ],
            )),
            json!({}),
        );
        want_lines(&s, 1, "one message");
        want_fields(&s.lines[0], &[("out", "150"), ("think", "120")]);
    }
);

token_case!(
    a_message_whose_lines_straddle_two_stops_is_counted_once,
    |repo| {
        let tr = transcript(
            repo,
            &[entry(Usage {
                id: "msg_1",
                out: 3,
                cache_read: 5000,
                ..Default::default()
            })],
        );
        stop(repo, Some(&tr), json!({}));
        append_to(
            &tr,
            &(entry(Usage {
                id: "msg_1",
                out: 40,
                cache_read: 5000,
                ..Default::default()
            }) + &entry(Usage {
                id: "msg_2",
                out: 7,
                cache_read: 5100,
                ..Default::default()
            })),
        );
        let s = stop(repo, Some(&tr), json!({}));
        want_lines(&s, 2, "a second stop");
        want_fields(
            &s.lines[1],
            &[("msgs", "1"), ("cache_read", "5100"), ("out", "44")],
        );
    }
);

token_case!(
    cache_writes_are_recorded_by_ttl_as_the_transcript_splits_them,
    |repo| {
        let h1 = Usage {
            id: "msg_1",
            cache_write: 700,
            ttl: Some([0, 700]),
            ..Default::default()
        };
        let tr = transcript(
            repo,
            &[
                entry(h1.clone()),
                entry(h1),
                entry(Usage {
                    id: "msg_2",
                    cache_write: 50,
                    ttl: Some([0, 50]),
                    ..Default::default()
                }),
            ],
        );
        subagent_transcript(
            &tr,
            AGENT_A,
            &[entry(Usage {
                sidechain: true,
                cache_write: 300,
                ttl: Some([300, 0]),
                ..Default::default()
            })],
        );
        let s = stop(repo, Some(&tr), json!({}));
        want_fields(
            &line_where(&s.lines, main_line),
            &[("cache_write_5m", "0"), ("cache_write_1h", "750")],
        );
        want_fields(
            &line_where(&s.lines, sidechain),
            &[("cache_write_5m", "300"), ("cache_write_1h", "0")],
        );
    }
);

token_case!(
    an_advisor_consultation_is_a_group_of_its_own_by_its_model_and_the_agent_that_consulted_it,
    |repo| {
        let tr = transcript(
            repo,
            &[entry(Usage {
                input: 1760,
                out: 531,
                iterations: Some(vec![
                    executor_step(89),
                    advisor_call(823, 1612),
                    executor_step(442),
                ]),
                ..Default::default()
            })],
        );
        subagent_transcript(
            &tr,
            AGENT_A,
            &[entry(Usage {
                sidechain: true,
                iterations: Some(vec![advisor_call(100, 50)]),
                ..Default::default()
            })],
        );
        let s = stop(repo, Some(&tr), json!({}));
        let executor = line_where(&s.lines, |l| f(l, "model") == "model-alpha" && main_line(l));
        let mine = line_where(&s.lines, |l| f(l, "advisor") == "true" && main_line(l));
        let agents = line_where(&s.lines, |l| f(l, "advisor") == "true" && sidechain(l));
        assert!(
            !mine.is_empty() && !agents.is_empty(),
            "no advisor group — its tokens are counted nowhere:\n{}",
            s.lines.join("\n")
        );
        let mut wrong = Vec::new();
        if field(&executor, "advisor").is_some()
            || f(&executor, "in") != "1760"
            || f(&executor, "out") != "531"
        {
            wrong.push(format!("the executor's line changed: {executor}"));
        }
        if field(&mine, "agent_id").is_some()
            || f(&mine, "model") != "model-gamma"
            || f(&mine, "in") != "823"
            || f(&mine, "out") != "1612"
            || f(&mine, "msgs") != "1"
        {
            wrong.push(format!("the session's consultation: {mine}"));
        }
        if f(&agents, "agent_id") != AGENT_A
            || f(&agents, "in") != "100"
            || f(&agents, "out") != "50"
        {
            wrong.push(format!("the subagent's consultation: {agents}"));
        }
        if let Some(v) = field(&mine, "think") {
            wrong.push(format!(
                "an advisor's thinking is not reported apart, yet its line says think={v}"
            ));
        }
        assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    }
);

token_case!(
    a_consultation_repeated_on_later_lines_of_its_message_or_after_a_stop_is_counted_once,
    |repo| {
        let tr = transcript(
            repo,
            &[
                entry(Usage {
                    id: "msg_1",
                    out: 5,
                    iterations: Some(vec![executor_step(5)]),
                    ..Default::default()
                }),
                entry(Usage {
                    id: "msg_1",
                    out: 40,
                    iterations: Some(vec![executor_step(5), advisor_call(823, 1612)]),
                    ..Default::default()
                }),
            ],
        );
        stop(repo, Some(&tr), json!({}));
        append_to(
            &tr,
            &(entry(Usage {
                id: "msg_1",
                out: 90,
                iterations: Some(vec![
                    executor_step(5),
                    advisor_call(823, 1612),
                    executor_step(50),
                ]),
                ..Default::default()
            }) + &entry(Usage {
                id: "msg_2",
                out: 3,
                iterations: Some(vec![advisor_call(7, 3)]),
                ..Default::default()
            })),
        );
        let calls: Vec<String> = stop(repo, Some(&tr), json!({}))
            .lines
            .iter()
            .filter(|l| f(l, "advisor") == "true")
            .map(|l| format!("{}:{}", f(l, "msgs"), f(l, "in")))
            .collect();
        assert_eq!(calls.join(","), "1:823,1:7", "consultations by stop");
    }
);

token_case!(each_subagent_transcript_keeps_its_own_offset, |repo| {
    let tr = transcript(repo, &[entry(usage(100))]);
    let sub = subagent_transcript(&tr, AGENT_A, &[entry(side(30))]);
    stop(repo, Some(&tr), json!({}));
    append_to(&sub, &entry(side(5)));
    let s = stop(repo, Some(&tr), json!({}));
    want_lines(&s, 3, "one new line for the subagent's delta");
    want_fields(&s.lines[2], &[("sidechain", "true"), ("out", "5")]);
});

// ---- the offset

token_case!(
    an_offset_saved_in_the_one_transcript_shape_is_honoured_not_re_read_from_0,
    |repo| {
        let tr = transcript(repo, &[entry(usage(100))]);
        write(
            state_path(repo, "token-offset"),
            &(json!({"path": tr, "bytes": read(&tr).len()}).to_string() + "\n"),
        );
        append_to(&tr, &entry(usage(7)));
        let s = stop(repo, Some(&tr), json!({}));
        want_lines(&s, 1, "the saved offset");
        want_fields(&s.lines[0], &[("out", "7")]);
    }
);

token_case!(
    a_second_stop_over_an_unchanged_transcript_writes_nothing,
    |repo| {
        let tr = transcript(repo, &[entry(Usage::default())]);
        stop(repo, Some(&tr), json!({}));
        want_lines(
            &stop(repo, Some(&tr), json!({})),
            1,
            "the same bytes were counted again",
        );
    }
);

token_case!(
    a_later_stop_counts_only_what_was_appended_since_the_last_one,
    |repo| {
        let tr = transcript(repo, &[entry(usage(100))]);
        stop(repo, Some(&tr), json!({}));
        append_to(&tr, &entry(usage(7)));
        let s = stop(repo, Some(&tr), json!({}));
        want_lines(&s, 2, "a second line");
        want_fields(&s.lines[1], &[("out", "7")]);
    }
);

token_case!(
    a_transcript_replaced_by_a_shorter_one_is_read_from_the_start_not_from_a_stale_offset,
    |repo| {
        let tr = transcript(
            repo,
            &[entry(usage(100)), entry(usage(100)), entry(usage(100))],
        );
        stop(repo, Some(&tr), json!({}));
        write(&tr, &entry(usage(42))); // a new session at the same path
        let s = stop(repo, Some(&tr), json!({}));
        want_lines(&s, 2, "the shorter file");
        want_fields(&s.lines[1], &[("out", "42")]);
    }
);

token_case!(
    a_half_written_last_line_is_not_consumed_and_is_counted_once_it_completes,
    |repo| {
        let tr = transcript(repo, &[entry(usage(100))]);
        let partial = entry(usage(55));
        append_to(&tr, &partial[..30]); // the writer is mid-append
        want_lines(
            &stop(repo, Some(&tr), json!({})),
            1,
            "the partial line was read as data",
        );
        append_to(&tr, &partial[30..]);
        let s = stop(repo, Some(&tr), json!({}));
        want_lines(&s, 2, "the completed line was skipped for good");
        want_fields(&s.lines[1], &[("out", "55")]);
    }
);

// ---- what it refuses to guess

token_case!(
    a_usage_record_with_no_model_is_dropped_rather_than_absorbed_into_a_total,
    |repo| {
        let bare = json!({"type": "assistant", "isSidechain": false, "message": {"role": "assistant", "usage": {"output_tokens": 999}}}).to_string() + "\n";
        let s = stop(
            repo,
            Some(&transcript(repo, &[entry(usage(100)), bare])),
            json!({}),
        );
        want_lines(&s, 1, "one line");
        want_fields(&s.lines[0], &[("out", "100")]);
    }
);

token_case!(
    a_cache_write_with_no_split_by_ttl_leaves_the_split_unwritten_never_a_zero,
    |repo| {
        let s = stop(
            repo,
            Some(&transcript(
                repo,
                &[
                    entry(Usage {
                        cache_write: 700,
                        ..Default::default()
                    }),
                    entry(Usage {
                        cache_write: 50,
                        ttl: Some([0, 50]),
                        ..Default::default()
                    }),
                ],
            )),
            json!({}),
        );
        want_lines(&s, 1, "one line");
        want_fields(&s.lines[0], &[("cache_write", "750")]);
        must_not_match(
            "cache_write_(5m|1h)=",
            &s.lines[0],
            "a split was written that the transcript did not give",
        );
    }
);

token_case!(an_unreadable_line_does_not_stop_the_readable_ones, |repo| {
    let s = stop(
        repo,
        Some(&transcript(
            repo,
            &[
                entry(usage(100)),
                "not json at all\n".into(),
                entry(usage(5)),
            ],
        )),
        json!({}),
    );
    assert_eq!(s.code, 0, "the hook failed on a line it could not parse");
    want_lines(&s, 1, "one line");
    want_fields(&s.lines[0], &[("out", "105")]);
});

token_case!(
    a_payload_with_no_transcript_path_records_nothing_a_missing_count_is_never_a_zero,
    |repo| {
        let s = stop(repo, None, json!({}));
        assert_eq!(s.code, 0);
        want_lines(&s, 0, "no transcript to read");
    }
);

token_case!(
    a_transcript_path_that_does_not_exist_records_nothing_and_does_not_throw,
    |repo| {
        let s = stop(repo, Some(&repo.join("gone.jsonl")), json!({}));
        assert_eq!(s.code, 0, "{}", s.stderr);
        want_lines(&s, 0, "a file it could not open");
    }
);

token_case!(
    a_corrupt_offset_counts_nothing_rather_than_counting_a_prefix_twice,
    |repo| {
        let tr = transcript(repo, &[entry(usage(100))]);
        stop(repo, Some(&tr), json!({}));
        write(state_path(repo, "token-offset"), "not json\n");
        append_to(&tr, &entry(usage(5)));
        want_lines(
            &stop(repo, Some(&tr), json!({})),
            1,
            "the first 100 was counted again",
        );
        must_match(
            "offset_unreadable",
            &read(state_path(repo, "token-trace-unmatched.log")),
            "the skipped slice left no record",
        );
    }
);

token_case!(
    a_resynchronised_offset_picks_the_next_slice_up_cleanly,
    |repo| {
        let tr = transcript(repo, &[entry(usage(100))]);
        stop(repo, Some(&tr), json!({}));
        write(state_path(repo, "token-offset"), "not json\n");
        append_to(&tr, &entry(usage(5)));
        stop(repo, Some(&tr), json!({})); // the slice that is lost
        append_to(&tr, &entry(usage(9)));
        let s = stop(repo, Some(&tr), json!({}));
        want_lines(&s, 2, "the run resumes counting");
        want_fields(&s.lines[1], &[("out", "9")]);
    }
);

token_case!(
    a_payload_with_no_transcript_path_records_its_shape_so_a_moved_field_is_visible,
    |repo| {
        stop(repo, None, json!({}));
        let missed = read(state_path(repo, "token-trace-unmatched.log"));
        assert!(
            missed.contains("no_transcript_path") && missed.contains("session_id"),
            "the record names no payload keys:\n{missed}"
        );
    }
);

token_case!(an_unreadable_transcript_records_its_shape_too, |repo| {
    stop(repo, Some(&repo.join("gone.jsonl")), json!({}));
    must_match(
        "transcript_unreadable",
        &read(state_path(repo, "token-trace-unmatched.log")),
        "the record does not name the cause",
    );
});

token_case!(
    the_miss_log_is_deduped_one_moved_field_is_one_line_not_one_per_stop,
    |repo| {
        for _ in 0..3 {
            stop(repo, None, json!({}));
        }
        let n = read(state_path(repo, "token-trace-unmatched.log"))
            .trim_end_matches('\n')
            .matches('\n')
            .count()
            + 1;
        assert_eq!(n, 1, "lines for one repeated cause");
    }
);

// ---- whose cost it is

token_case!(
    a_subagent_transcript_is_charged_to_the_agent_its_file_names,
    |repo| {
        let tr = transcript(repo, &[entry(usage(100))]);
        subagent_transcript(&tr, AGENT_A, &[entry(side(30))]);
        subagent_transcript(&tr, "b0123456789abcdef", &[entry(side(70))]);
        let s = stop(repo, Some(&tr), json!({}));
        let by: BTreeMap<String, String> = s
            .lines
            .iter()
            .filter_map(|l| field(l, "agent_id").map(|id| (id, f(l, "out"))))
            .collect();
        assert!(
            by.get(AGENT_A).is_some_and(|o| o == "30")
                && by.get("b0123456789abcdef").is_some_and(|o| o == "70"),
            "two agents were not told apart:\n{}",
            s.lines.join("\n")
        );
        let m = line_where(&s.lines, main_line);
        assert!(
            !m.is_empty() && !m.contains("agent_id="),
            "the session's own line was charged to an agent: {m}"
        );
    }
);

token_case!(
    a_group_reports_its_largest_single_prompt_not_a_sum,
    |repo| {
        let s = stop(
            repo,
            Some(&transcript(
                repo,
                &[
                    entry(Usage {
                        id: "m1",
                        input: 10,
                        cache_read: 90000,
                        cache_write: 5000,
                        ..Default::default()
                    }),
                    entry(Usage {
                        id: "m2",
                        input: 20,
                        cache_read: 120000,
                        cache_write: 1000,
                        ..Default::default()
                    }),
                ],
            )),
            json!({}),
        );
        want_lines(&s, 1, "one group");
        want_fields(&s.lines[0], &[("max_prompt", "121020")]);
    }
);

token_case!(
    a_second_session_in_the_repo_does_not_record_tokens_against_the_run,
    |repo| {
        write(state_path(repo, "phase.session"), "sess-owner");
        want_lines(
            &stop(
                repo,
                Some(&transcript(repo, &[entry(usage(100))])),
                json!({"session_id": "sess-other"}),
            ),
            0,
            "another session's turn was charged to the run",
        );
    }
);

// ---- where it must not fire: the phases run-trace stands down on

#[test]
fn a_phase_that_arms_nothing_records_nothing() {
    for phase in ["", "idle", "done"] {
        let repo = token_repo(Some(phase));
        want_lines(
            &stop(
                &repo,
                Some(&transcript(&repo, &[entry(Usage::default())])),
                json!({}),
            ),
            0,
            &format!("fired on phase {phase:?}, which arms nothing"),
        );
    }
}

#[test]
fn a_repo_that_never_adopted_this_engine_gets_no_claude_directory() {
    let repo = token_repo(None);
    assert_eq!(
        stop(
            &repo,
            Some(&transcript(&repo, &[entry(Usage::default())])),
            json!({})
        )
        .code,
        0
    );
    assert!(
        !exists(repo.join(".claude")),
        "created .claude/ in a repo with no phase file"
    );
}

#[test]
fn turns_taken_between_runs_are_not_charged_to_the_next_run() {
    let repo = token_repo(Some("idle"));
    let tr = transcript(&repo, &[entry(usage(1000))]);
    stop(&repo, Some(&tr), json!({}));
    set_phase(&repo, "spec\n");
    append_to(&tr, &entry(usage(7)));
    let s = stop(&repo, Some(&tr), json!({}));
    want_lines(&s, 1, "the run's first stop charged the idle turns too");
    want_fields(&s.lines[0], &[("out", "7")]);
}

#[test]
fn one_sessions_stop_keeps_another_sessions_offsets() {
    let repo = token_repo(Some("idle"));
    let a = transcript(&repo, &[entry(usage(100))]);
    let b = repo.join("other.jsonl");
    write(&b, &entry(usage(50)));
    stop(&repo, Some(&a), json!({"session_id": "sess-a"}));
    stop(&repo, Some(&b), json!({"session_id": "sess-b"}));
    set_phase(&repo, "spec\n");
    append_to(&a, &entry(usage(7)));
    let s = stop(&repo, Some(&a), json!({"session_id": "sess-a"}));
    want_lines(
        &s,
        1,
        "session a re-read its whole transcript after session b's stop",
    );
    want_fields(&s.lines[0], &[("out", "7")]);
}

fn report(repo: &Path, command: &str) -> String {
    run(
        &std::env::temp_dir(),
        &[format!("CLAUDE_PROJECT_DIR={}", repo.display())],
        "",
        &cli_argv(engine_dir(), &[command]),
    )
    .stdout
}

// ---- the readers agree

#[test]
fn token_readers_agree() {
    let repo = token_repo(Some("implement"));
    stop(
        &repo,
        Some(&transcript(
            &repo,
            &[
                entry(side(1234)),
                entry(Usage {
                    out: 4321,
                    iterations: Some(vec![advisor_call(823, 1612)]),
                    ..Default::default()
                }),
            ],
        )),
        json!({}),
    );
    let rows = |out: &str| {
        let mut r: Vec<String> =
            Regex::new(r"model-\S+\s+(?:main|subagent|advisor)\s+in \S+\s+out \S+")
                .unwrap()
                .find_iter(out)
                .map(|m| m.as_str().to_string())
                .collect();
        r.sort();
        r
    };
    let (status, stats) = (
        rows(&report(&repo, "status")),
        rows(&report(&repo, "stats")),
    );
    assert!(
        !status.is_empty(),
        "status reported no token rows at all:\n{}",
        report(&repo, "status")
    );
    assert_eq!(status, stats, "the two readers disagree about one log");
}

#[test]
fn every_output_count_is_a_floor() {
    // One run whose tokens name their agent, and one whose do not: stats
    // prints the second as an average per spawn.
    let named = token_repo(Some("implement"));
    let tr = transcript(
        &named,
        &[entry(Usage {
            out: 1234,
            think: 50,
            ..Default::default()
        })],
    );
    subagent_transcript(&tr, "a0123456789abcdef", &[entry(side(4321))]);
    stop(&named, Some(&tr), json!({}));
    let unnamed = token_repo(Some("implement"));
    stop(
        &unnamed,
        Some(&transcript(
            &unnamed,
            &[entry(usage(1234)), entry(side(4321))],
        )),
        json!({}),
    );
    append_to(
        state_path(&unnamed, "run-trace.log"),
        "2026-08-31T00:00:01Z phase=implement agent type=spec-flow:planner status=PLAN_READY\n",
    );
    let all: String = [&named, &unnamed]
        .iter()
        .flat_map(|r| ["status", "stats"].map(|c| report(r, c)))
        .collect::<Vec<_>>()
        .join("\n");
    assert!(all.contains('≥'), "no count was printed as a floor:\n{all}");
    let bare: Vec<String> = Regex::new(r"\b(?:out|think|output:) +(\S+)")
        .unwrap()
        .captures_iter(&all)
        .filter(|m| m[1].starts_with(|c: char| c.is_ascii_digit()))
        .map(|m| m[0].to_string())
        .collect();
    assert!(
        bare.is_empty(),
        "printed as an exact count: {bare:?}\n--- reports ---\n{all}"
    );
}

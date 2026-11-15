//! A payload is read whole, whatever text it carries. One character the JSON
//! reader refused anywhere in a call — a comment after a command, a file's
//! content, a prompt — once made the whole call unreadable, and every guard
//! stood down on it in silence. `JSON.stringify`, which writes these payloads,
//! writes a string holding a lone surrogate as its escape.

use serde_json::json;

use crate::harness::*;
use crate::helpers::*;

/// The JSON escape for one UTF-16 unit, as `JSON.stringify` writes it.
fn esc(hex: &str) -> String {
    format!("{}u{hex}", '\\')
}

/// A call as Claude Code writes it, `text` spliced raw into one string field.
fn call(tool: &str, field: &str, text: &str, extra: &str) -> String {
    format!(
        r#"{{"session_id":"s1","tool_name":"{tool}","tool_input":{{"{field}":"{text}"{extra}}}}}"#
    )
}

#[test]
fn a_lone_surrogate_in_a_comment_does_not_let_a_whole_repo_run_through() {
    let repo = repo_in("implement");
    let r = run_hook(
        "no-gate-cmds",
        call(
            "Bash",
            "command",
            &format!("npm test # {}", esc("d800")),
            "",
        ),
        &repo,
    );
    expect_status(
        &r,
        2,
        "a whole-repo run with a lone surrogate after it was let through",
    );
}

#[test]
fn a_lone_surrogate_in_a_comment_does_not_let_done_be_declared() {
    let repo = repo_in("implement");
    let r = run_hook(
        "phase-guard",
        call(
            "Bash",
            "command",
            &format!("echo done > .claude/state/phase # {}", esc("dc00")),
            "",
        ),
        &repo,
    );
    expect_status(
        &r,
        2,
        "'done' was written into the phase with a lone surrogate after it",
    );
    assert_eq!(phase_of(&repo), "implement");
}

#[test]
fn a_lone_surrogate_in_written_content_is_not_a_phase_written_unread() {
    let repo = repo_in("implement");
    let r = run_hook(
        "phase-guard",
        call(
            "Write",
            "file_path",
            ".claude/state/phase",
            &format!(r#","content":"done{}""#, esc("d800")),
        ),
        &repo,
    );
    expect_status(
        &r,
        2,
        "a phase the closed set does not hold was written unread",
    );
}

#[test]
fn a_lone_surrogate_in_a_prompt_still_arms_the_gate() {
    let repo = repo_in("spec");
    let r = run_hook(
        "arm-gate",
        call(
            "Task",
            "subagent_type",
            "spec-flow:implementer",
            &format!(r#","prompt":"Implement M1 {}""#, esc("d800")),
        ),
        &repo,
    );
    expect_status(&r, 0, "arm-gate");
    assert_eq!(
        phase_of(&repo),
        "implement",
        "the implementer was engaged and the gate was never armed: {}",
        r.stderr
    );
}

#[test]
fn a_lone_surrogate_in_a_prompt_still_routes_the_model() {
    let repo = repo_in("plan");
    let r = run_hook(
        "model-route",
        call(
            "Task",
            "subagent_type",
            "spec-flow:planner",
            &format!(r#","model":"haiku","prompt":"x {}""#, esc("d800")),
        ),
        &repo,
    );
    must_match("updatedInput", &r.out(), "the spawn was not routed");
}

#[test]
fn a_key_written_twice_is_read_as_its_last_value() {
    let repo = repo_in("implement");
    let r = run_hook(
        "no-gate-cmds",
        r#"{"tool_name":"Bash","tool_input":{"command":"ls","command":"npm test"}}"#,
        &repo,
    );
    expect_status(&r, 2, "a repeated key made the call unreadable");
}

/// Guards what the fix must keep: a surrogate pair is one character, and an
/// escaped backslash before a `u` is text.
#[test]
fn a_surrogate_pair_and_an_escaped_backslash_read_as_written() {
    let repo = repo_in("implement");
    let pair = format!("npm test # {}{}", esc("d83d"), esc("de00"));
    expect_status(
        &run_hook("no-gate-cmds", call("Bash", "command", &pair, ""), &repo),
        2,
        "a surrogate pair",
    );
    let r = run_hook(
        "phase-guard",
        json!({"tool_name": "Write", "tool_input": {"file_path": ".claude/state/phase", "content": format!("{}{}", '\\', "ud800")}}),
        &repo,
    );
    expect_status(&r, 2, "an escaped backslash");
    must_match(r"\\\\ud800", &r.stderr, "the text was not read as written");
}

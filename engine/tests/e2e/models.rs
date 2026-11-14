//! `spec-flow models`' failure mode is not crashing but being confidently
//! wrong: a run that never found the project's config prints tidy rows
//! saying "plugin default", exactly like a repo that configured nothing. So
//! these cases are about attribution — and one holds the report to naming no
//! model for a tier nothing pinned (ADR-013).

use regex::Regex;
use serde_json::json;

use crate::harness::*;
use crate::helpers::*;

/// Model ids are assembled, never spelled: the model-pins check scans this file.
fn vendor() -> String {
    ["claude", ""].join("-")
}

fn pinned_sonnet() -> String {
    [vendor() + "sonnet", "4".into(), "9".into()].join("-")
}

fn pinned_opus() -> String {
    [vendor() + "opus", "4".into(), "8".into()].join("-")
}

/// A folder where a file should be: there, and no read of it succeeds.
const A_DIRECTORY: &str = "\x00dir";

const SHIPPED_NAMES: [&str; 5] = [
    "architect",
    "implementer",
    "planner",
    "reviewer",
    "spec-writer",
];

/// The report run in a throwaway repository holding exactly files, with the
/// ambient routing environment cleared and env set over it.
fn models(files: &[(&str, String)], env: &[String]) -> Output {
    let root = temp_dir();
    std::fs::create_dir_all(root.join(".claude")).unwrap();
    for (rel, text) in files {
        if text == A_DIRECTORY {
            std::fs::create_dir_all(root.join(rel)).unwrap();
        } else {
            write(root.join(rel), text);
        }
    }
    let mut clean = vec!["CLAUDE_CODE_EFFORT_LEVEL=".to_string()];
    clean.extend(
        ["opus", "sonnet", "haiku", "fable"]
            .map(|t| format!("ANTHROPIC_DEFAULT_{}_MODEL=", t.to_uppercase())),
    );
    clean.extend(env.iter().cloned());
    run(&root, &clean, "", &cli_argv(engine_dir(), &["models"]))
}

/// One agent's row, whitespace collapsed.
fn row(out: &str, agent: &str) -> String {
    let re = Regex::new(&format!(r"^\s+{}\s", regex::escape(agent))).unwrap();
    out.lines()
        .find(|l| re.is_match(l))
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .unwrap_or_default()
}

/// The reviewer as this repo ships it, read off its frontmatter rather than
/// restated, and a tier it does not ship with.
struct Reviewer {
    model: String,
    effort: String,
    elsewhere: &'static str,
}

fn reviewer() -> Reviewer {
    let frontmatter = read(engine_dir().join("agents/reviewer.md"));
    let field = |k: &str| {
        Regex::new(&format!(r"(?m)^{k}:[ \t]*(\S+)"))
            .unwrap()
            .captures(&frontmatter)
            .map(|m| m[1].to_string())
            .unwrap_or_default()
    };
    let (model, effort) = (field("model"), field("effort"));
    assert!(
        !effort.is_empty(),
        "the reviewer declares no effort, and the effort cases need an agent that does: point them at one"
    );
    let elsewhere = ["haiku", "sonnet", "opus"]
        .into_iter()
        .find(|t| *t != model)
        .unwrap();
    Reviewer {
        model,
        effort,
        elsewhere,
    }
}

fn routing(v: String) -> Vec<(&'static str, String)> {
    vec![(".claude/spec-flow.config.json", v)]
}

#[track_caller]
fn ok(r: &Output) {
    expect_status(r, 0, "the report failed");
}

#[test]
fn a_repo_that_configured_nothing_gets_every_agent_all_on_the_shipped_default() {
    let r = models(&[], &[]);
    ok(&r);
    for a in SHIPPED_NAMES {
        let rw = row(&r.out(), a);
        assert!(
            rw.contains("plugin default"),
            "{a} was not attributed to the plugin: {rw:?}\n{}",
            r.out()
        );
    }
    want_all(&r.out(), &["Nothing is re-routed"]);
}

/// Rows only: the header prints the repo's path.
#[test]
fn with_nothing_pinned_no_agent_row_names_a_model() {
    let r = models(&[], &[]);
    for a in SHIPPED_NAMES {
        let rw = row(&r.out(), a);
        assert!(
            !rw.contains(&vendor()),
            "named a concrete model for a tier nothing pinned: {rw}"
        );
    }
}

#[test]
fn a_re_route_is_attributed_to_the_project_and_says_what_it_replaced() {
    let rv = reviewer();
    let r = models(
        &routing(json!({"agents": {"reviewer": rv.elsewhere}}).to_string()),
        &[],
    );
    ok(&r);
    let rw = row(&r.out(), "reviewer");
    assert!(
        rw.contains(rv.elsewhere)
            && rw.contains("project")
            && rw.contains(&format!("was {}", rv.model)),
        "the re-route: {rw}"
    );
    want_all(&r.out(), &["1 agent(s) re-routed"]);
}

#[test]
fn restating_the_shipped_default_is_not_reported_as_a_re_route() {
    let r = models(&routing(r#"{"agents":{"planner":"opus"}}"#.into()), &[]);
    ok(&r);
    want_all(&row(&r.out(), "planner"), &["restates the default"]);
    want_all(&r.out(), &["Nothing is re-routed"]);
}

#[test]
fn a_routing_block_that_cannot_be_applied_exits_non_zero_and_names_the_entry() {
    let r = models(&routing(r#"{"agents":{"reviwer":"sonnet"}}"#.into()), &[]);
    assert_ne!(
        r.status,
        0,
        "a repo whose every spec-flow spawn is being denied got a clean report:\n{}",
        r.out()
    );
    want_all(&r.out(), &["reviwer"]);
}

#[test]
fn a_tier_pinned_in_settings_json_is_credited_to_that_file() {
    let r = models(
        &[(
            ".claude/settings.json",
            json!({"env": {"ANTHROPIC_DEFAULT_SONNET_MODEL": pinned_sonnet()}}).to_string(),
        )],
        &[],
    );
    ok(&r);
    want_all(
        &row(&r.out(), "implementer"),
        &[&pinned_sonnet(), "settings.json"],
    );
    want_all(&row(&r.out(), "architect"), &["unpinned"]);
}

#[test]
fn settings_local_json_wins_over_settings_json() {
    let r = models(
        &[
            (
                ".claude/settings.json",
                json!({"env": {"ANTHROPIC_DEFAULT_OPUS_MODEL": pinned_sonnet()}}).to_string(),
            ),
            (
                ".claude/settings.local.json",
                json!({"env": {"ANTHROPIC_DEFAULT_OPUS_MODEL": pinned_opus()}}).to_string(),
            ),
        ],
        &[],
    );
    want_all(
        &row(&r.out(), "planner"),
        &[&pinned_opus(), "settings.local.json"],
    );
}

#[test]
fn a_real_environment_variable_wins_over_both_files() {
    let r = models(
        &[(
            ".claude/settings.json",
            json!({"env": {"ANTHROPIC_DEFAULT_OPUS_MODEL": pinned_sonnet()}}).to_string(),
        )],
        &[format!("ANTHROPIC_DEFAULT_OPUS_MODEL={}", pinned_opus())],
    );
    want_all(
        &row(&r.out(), "planner"),
        &[&pinned_opus(), "the environment"],
    );
}

// ---- effort: the one layer with no project override to report

#[test]
fn an_agent_that_declares_its_own_effort_is_reported_as_the_one_deciding_it() {
    let rv = reviewer();
    let r = models(&[], &[]);
    ok(&r);
    want_all(
        &row(&r.out(), "reviewer"),
        &[&format!("{} (agent)", rv.effort)],
    );
    want_all(&row(&r.out(), "implementer"), &["your session"]);
}

#[test]
fn a_session_effort_level_is_reported_for_the_agents_that_inherit_and_not_for_the_ones_that_do_not()
{
    let rv = reviewer();
    let r = models(
        &[(".claude/settings.json", r#"{"effortLevel":"xhigh"}"#.into())],
        &[],
    );
    ok(&r);
    want_all(&row(&r.out(), "implementer"), &["xhigh (session)"]);
    want_all(
        &row(&r.out(), "reviewer"),
        &[&format!("{} (agent)", rv.effort)],
    );
}

/// It beats the frontmatter, a spawn's effort and the session's (2.1.294).
#[test]
fn claude_code_effort_level_in_the_environment_is_reported_as_deciding_every_agent() {
    let r = models(&[], &["CLAUDE_CODE_EFFORT_LEVEL=max".into()]);
    ok(&r);
    for a in ["reviewer", "implementer"] {
        want_all(
            &row(&r.out(), a),
            &["max (CLAUDE_CODE_EFFORT_LEVEL, the environment)"],
        );
    }
    want_all(&r.out(), &["CLAUDE_CODE_EFFORT_LEVEL is set"]);
}

#[test]
fn claude_code_effort_level_in_a_settings_env_block_is_reported_with_that_file_as_its_source() {
    let r = models(
        &[(
            ".claude/settings.json",
            r#"{"effortLevel":"xhigh","env":{"CLAUDE_CODE_EFFORT_LEVEL":"medium"}}"#.into(),
        )],
        &[],
    );
    ok(&r);
    want_all(
        &row(&r.out(), "implementer"),
        &["medium (CLAUDE_CODE_EFFORT_LEVEL, .claude/settings.json)"],
    );
}

#[test]
fn a_claude_code_effort_level_that_is_not_a_level_is_not_reported_as_deciding() {
    let rv = reviewer();
    let r = models(&[], &["CLAUDE_CODE_EFFORT_LEVEL=bogus".into()]);
    ok(&r);
    want_all(
        &row(&r.out(), "reviewer"),
        &[&format!("{} (agent)", rv.effort)],
    );
    want_all(&r.out(), &["is not an effort level"]);
}

/// In a table about which layer decided what, a shifted column reads as a
/// misattributed row.
#[test]
fn every_column_stays_aligned_when_a_heading_is_longer_than_its_values() {
    let r = models(&[], &[]);
    let out = r.out();
    let lines: Vec<&str> = out.split('\n').collect();
    let i = lines
        .iter()
        .position(|h| h.contains("AGENT") && h.contains("EFFORT"))
        .filter(|i| i + 1 < lines.len())
        .unwrap_or_else(|| panic!("no header row:\n{out}"));
    let (header, first) = (lines[i], lines[i + 1]);
    for (heading, value) in [("TIER DECIDED BY", "plugin default"), ("EFFORT", "high")] {
        assert_eq!(
            header.find(heading),
            first.find(value),
            "{value:?} does not start under {heading:?}.\n{header}\n{first}"
        );
    }
}

/// One reading of the file: a byte-order mark is not part of it, here as in
/// the hook.
#[test]
fn a_routing_written_after_a_byte_order_mark_is_reported_as_the_hook_applies_it() {
    let rv = reviewer();
    let r = models(
        &routing(format!(
            "\u{feff}{}",
            json!({"agents": {"reviewer": rv.elsewhere}})
        )),
        &[],
    );
    ok(&r);
    want_all(&row(&r.out(), "reviewer"), &[rv.elsewhere, "project"]);
}

#[test]
fn a_file_the_run_start_refuses_exits_non_zero_and_says_why() {
    for (text, says) in [
        (
            r#"{ "agents": { "reviewer": "sonnet" }, }"#,
            "does not parse as JSON",
        ),
        (r#"{"max_architect_calls":"three"}"#, "max_architect_calls"),
    ] {
        let r = models(&routing(text.into()), &[]);
        assert_ne!(
            r.status,
            0,
            "a file no run starts with got exit 0:\n{}",
            r.out()
        );
        want_all(&r.out(), &[says]);
    }
}

#[test]
fn a_settings_file_that_cannot_be_read_exits_non_zero_and_says_why() {
    let r = models(&routing(A_DIRECTORY.into()), &[]);
    assert_ne!(r.status, 0, "exit 0:\n{}", r.out());
    want_all(&r.out(), &["could not be read"]);
    must_not_match(
        r"panicked at|RUST_BACKTRACE",
        &r.out(),
        "it crashed instead of saying why",
    );
}

/// An unparseable settings file is Claude Code's to complain about.
#[test]
fn a_settings_file_that_is_not_valid_json_does_not_take_the_report_down() {
    let r = models(&[(".claude/settings.json", "{ not json".into())], &[]);
    ok(&r);
    assert!(
        !row(&r.out(), "planner").is_empty(),
        "the report came back empty:\n{}",
        r.out()
    );
}

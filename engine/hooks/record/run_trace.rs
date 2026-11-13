//! `run-trace` — PostToolUse on Write|Edit|Read|Bash, PostToolUseFailure on
//! Bash, and SubagentStop — the run's observable timeline. It enforces
//! NOTHING and always exits 0: what an agent read (the path only), wrote, ran
//! as a test, and returned. A payload it cannot read leaves its key names in
//! run-trace-unmatched.log. The one call it answers is a test run whose file
//! did not load, with how to make it a red run.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::agents::{blocks, handback};
use crate::hooks::{Exit, Input};
use crate::jsre::Re;
use crate::payload::{js_string, keys_json};
use crate::repo::{contract, gitscope};
use crate::shell::{self, argv};
use crate::spec::report;
use crate::state;

static RUNNER_WRAPPER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(npx|pnpm|yarn|bunx)$").unwrap());
static RUNNER_SUB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(exec|dlx|run)$").unwrap());
static GIT_CMD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\t\n\x0C\r ]*git([\t\n\x0C\r ]|$)").unwrap());
static REDIRECTION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9]*[<>]{1,2}&?[\t\n\x0C\r ]*[^\t\n\x0C\r ;|&<>]*").unwrap());
static CHAIN_PARTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r";|&&|\|\||\||&|\n").unwrap());
static GROUP_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new("[()`]").unwrap());
static PM_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(pnpm|npm|npx|yarn|node)$").unwrap());
static ASSIGNMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());
// jest and vitest count the tests that failed apart from the files that did,
// and a file that did not load is only the second.
static FAILED_TESTS: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*Tests:?\s.*\bfailed\b", "m"));
static FAILED_FILES: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^\s*(Test Suites:|Test Files)\s.*\bfailed\b", "m"));
static PASSED_SUMMARY: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*Tests:?\s.*\bpassed\b", "m"));
static NO_TESTS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(?-u:\b)No tests? (files )?found(?-u:\b)").unwrap());
static COULD_NOT_FIND: LazyLock<Re> = LazyLock::new(|| Re::new(r"^Could not find '", "m"));
static SINGLE_PIPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(^|[^|])\|([^|]|$)").unwrap());
static NOT_FOUND: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"Exit code 12[67](?-u:\b)|command not found|is not recognized as").unwrap()
});
pub static WORD_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());
static SKILL_MISS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"SKILL_MISS:[\t\n\x0C\r ]*([^\n"\\]+)"#).unwrap());
static LOWER_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z]+$").unwrap());
static PATH_SEPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/]").unwrap());
// mocha counts the tests that failed, and abandons the run, uncounted, on a
// file it cannot load.
static MOCHA_FAILING: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*[1-9]\d* failing\b", "m"));
static MOCHA_ABORTED: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*Exception during run:", "m"));
/// A failed case in node --test's default reporter; TAP is read as TAP.
static SPEC_FAILED: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^\s*✖ (.+) \(\d+(?:\.\d+)?ms\)\s*$", "m"));
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\t\n\x0C\r ]+").unwrap());
static EDIT_TOOLS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(Write|Edit|MultiEdit)$").unwrap());

/// What a value's whitespace is in a `k=v` log: a `-`.
pub fn whitespace(s: &str) -> String {
    SPACES.replace_all(s, "-").into_owned()
}

/// The first of `keys` present and not null.
pub fn nullish<'a>(p: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| p.get(*k).filter(|v| !v.is_null()))
}

/// Whether the runner is the program a command runs, rather than a word in
/// it: `npx vitest run x` runs it, `grep vitest package.json` does not. A
/// multi-word name (`node --test`) needs its first word in program position
/// and the rest after.
fn runs_runner(cmd: &str, test_name: &str) -> bool {
    let words: Vec<&str> = test_name.split_whitespace().collect();
    let tokens: Vec<&str> = cmd.split_whitespace().collect();
    let at = |k: usize| tokens.get(k).copied().unwrap_or("");
    let mut i = tokens.iter().take_while(|t| ASSIGNMENT.is_match(t)).count();
    if RUNNER_WRAPPER.is_match(at(i)) || (at(i) == "npm" && at(i + 1) == "exec") {
        i += if at(i) == "npm" { 2 } else { 1 };
        if RUNNER_SUB.is_match(at(i)) {
            i += 1;
        }
    }
    if let Some(first) = words.first()
        && argv::basename(at(i)) == *first
        && words[1..]
            .iter()
            .all(|w| i < tokens.len() && tokens[i + 1..].contains(w))
    {
        return true;
    }
    let (_, name) = argv::tool_at(&tokens, i);
    words.len() == 1 && name == test_name
}

/// The cases a run's output names as failed: `not ok` in TAP, `✖ <name>
/// (<n>ms)` from node --test's default reporter.
fn failed_cases(out: &str) -> Vec<String> {
    let mut names = report::parse("tap", out).failed;
    names.extend(
        SPEC_FAILED
            .exec_all(out)
            .iter()
            .map(|m| m.group(1).to_string()),
    );
    names
}

/// Go's `path.Match`: `*` and `?` never cross `/`; a malformed pattern
/// matches nothing.
fn path_match(pattern: &[u8], name: &[u8]) -> bool {
    let Some(&p) = pattern.first() else {
        return name.is_empty();
    };
    match p {
        b'*' => (0..=name.len())
            .take_while(|&i| i == 0 || name[i - 1] != b'/')
            .any(|i| path_match(&pattern[1..], &name[i..])),
        b'?' => name.first().is_some_and(|&c| c != b'/') && path_match(&pattern[1..], &name[1..]),
        b'[' => {
            let Some(&c) = name.first().filter(|&&c| c != b'/') else {
                return false;
            };
            let mut i = 1;
            let negate = pattern.get(i) == Some(&b'^');
            if negate {
                i += 1;
            }
            let mut matched = false;
            let mut first = true;
            loop {
                match pattern.get(i) {
                    None => return false,
                    Some(b']') if !first => break,
                    _ => {}
                }
                first = false;
                let mut lo = pattern[i];
                if lo == b'\\' {
                    i += 1;
                    let Some(&e) = pattern.get(i) else {
                        return false;
                    };
                    lo = e;
                }
                let mut hi = lo;
                if pattern.get(i + 1) == Some(&b'-')
                    && pattern.get(i + 2).is_some_and(|&h| h != b']')
                {
                    hi = pattern[i + 2];
                    if hi == b'\\' {
                        let Some(&e) = pattern.get(i + 3) else {
                            return false;
                        };
                        hi = e;
                        i += 1;
                    }
                    i += 2;
                }
                matched |= lo <= c && c <= hi;
                i += 1;
            }
            matched != negate && path_match(&pattern[i + 1..], &name[1..])
        }
        b'\\' => match pattern.get(1) {
            Some(&e) => name.first() == Some(&e) && path_match(&pattern[2..], &name[1..]),
            None => false,
        },
        _ => name.first() == Some(&p) && path_match(&pattern[1..], &name[1..]),
    }
}

/// Whether `name` is one of the paths the run was handed: node --test names a
/// file it could not load by that path, as a failed case of its own.
fn handed(name: &str, targets: &[String]) -> bool {
    let norm = |p: &str| {
        let p = p.replace('\\', "/");
        let p = p.strip_prefix("./").unwrap_or(&p);
        p.strip_suffix('/').unwrap_or(p).to_string()
    };
    let n = norm(name);
    targets
        .iter()
        .any(|t| path_match(norm(t).as_bytes(), n.as_bytes()))
}

/// A test run that failed: what it said, and whether it was interrupted.
struct Failure {
    err: String,
    interrupted: bool,
}

/// A scoped test run and its verdict, read off what the runner printed. Red
/// only when it reports a test that failed: a red verdict credits
/// test-first, and a file that did not load ran none of its tests, so it is
/// `absent`, never red (ADR-053). A failure the hook cannot read either way
/// is `?`, and its `why=` says what was not given.
fn trace_test(
    input: &Map<String, Value>,
    res: Option<&Value>,
    test_name: &str,
    failure: Option<&Failure>,
) -> String {
    if test_name.is_empty() {
        return String::new(); // no contract read -> no runner name to look for
    }
    // Read through the shell's quoting: a commit message naming the runner
    // runs nothing, and `sh -c '<runner> …'` runs it.
    let cmd = shell::words(&js_string(input.get("command")));
    let names_runner = Regex::new(&format!(
        "(^|[^a-zA-Z-]){}([^a-zA-Z-]|$)",
        regex::escape(test_name)
    ))
    .unwrap();
    // The commands in a chain that run it — not git, whose arguments only
    // name it — and what each was handed, past any redirection.
    let runs: Vec<String> = CHAIN_PARTS
        .split(&cmd)
        .filter(|part| names_runner.is_match(part) && !GIT_CMD.is_match(part))
        .map(|part| GROUP_CHARS.replace_all(part, " ").trim().to_string())
        .collect();
    if runs.is_empty() {
        return String::new();
    }
    let out = match failure {
        Some(f) => f.err.clone(),
        None => {
            let mut parts: Vec<&str> = Vec::new();
            if let Some(Value::Object(m)) = res {
                parts.extend(
                    ["stdout", "stderr"]
                        .iter()
                        .filter_map(|k| m.get(*k)?.as_str()),
                );
            }
            parts.push(res.and_then(Value::as_str).unwrap_or_default());
            parts.join("\n")
        }
    };
    let mut targets: Vec<String> = Vec::new();
    let mut runner = false;
    for part in &runs {
        runner = runner || runs_runner(part, test_name);
        for tok in REDIRECTION.replace_all(part, " ").split_whitespace() {
            let last = PATH_SEPS.split(tok).last().unwrap_or_default();
            // A word with quoted whitespace in it would split the trace line.
            if !tok.starts_with('-')
                && tok.contains(['/', '.'])
                && !last.contains(test_name)
                && !PM_WORD.is_match(tok)
                && shell::unmask(tok) == tok
            {
                targets.push(tok.into());
            }
        }
    }
    let target = if targets.is_empty() {
        "-".to_string()
    } else {
        targets.join(",")
    };
    let (mut test_failed, mut file_failed) = (false, false);
    for name in failed_cases(&out) {
        if handed(&name, &targets) {
            file_failed = true;
        } else {
            test_failed = true;
        }
    }
    let (verdict, why) =
        if FAILED_TESTS.test(&out) || out.contains('✕') || MOCHA_FAILING.test(&out) || test_failed
        {
            ("red", "")
        } else if file_failed || FAILED_FILES.test(&out) || MOCHA_ABORTED.test(&out) {
            ("absent", "")
        } else if PASSED_SUMMARY.test(&out) {
            if failure.is_some() {
                ("?", "summary-passed")
            } else {
                ("green", "")
            }
        } else if NO_TESTS.is_match(&out) || COULD_NOT_FIND.test(&out) {
            ("none", "")
        } else {
            let why = match failure {
                // A pipe's exit is its last command's.
                None if SINGLE_PIPE.is_match(&cmd) => "pipe",
                None => "no-summary",
                Some(f) if f.interrupted => "interrupted",
                Some(_) if NOT_FOUND.is_match(&out) => "not-found",
                Some(_) if target == "-" => "no-path",
                Some(_) if !runner => "not-the-runner",
                Some(_) => "no-summary",
            };
            ("?", why)
        };
    let mut line = format!("test verdict={verdict} target={target}");
    if !why.is_empty() {
        line += &format!(" why={why}");
    }
    line
}

/// What a subagent returned — for the reviewer, that IS the open question.
/// Read at SubagentStop, never off the spawn's response, which echoes the
/// PROMPT and its expected statuses. One line per agent, at its FIRST stop:
/// stats reads every `agent type=` line as a fresh spawn.
fn trace_return(p: &Map<String, Value>, trace_file: &Path, miss_log: &Path) -> String {
    let typ = whitespace(&js_string(Some(
        nullish(p, &["agent_type"]).unwrap_or(&json!("?")),
    )));
    let agent_id = p
        .get("agent_id")
        .and_then(Value::as_str)
        .filter(|s| WORD_ID.is_match(s))
        .unwrap_or_default();
    if !agent_id.is_empty()
        && let Some(trace) = state::read_text(trace_file)
        && Re::new(
            &format!(r" agent type=.* agent_id={}(\s|$)", regex::escape(agent_id)),
            "m",
        )
        .test(&trace)
    {
        return String::new();
    }
    let text = handback::handed_back(p);
    let Some(ret) = blocks::parse_return(&text) else {
        let report = if text.is_empty() {
            "empty"
        } else {
            "no STATUS line"
        };
        state::append_unique(
            miss_log,
            &format!(
                r#"{{"payload_keys":{},"report":{}}}"#,
                keys_json(p),
                json!(report)
            ),
        );
        return String::new();
    };
    // A skill the milestone failed to route had nowhere to go but prose; on a
    // line it survives into the telemetry. Whitespace-free: `k=v` pairs.
    let mut misses: Vec<String> = Vec::new();
    for m in SKILL_MISS.captures_iter(&text) {
        let v = whitespace(m[1].trim());
        if !v.is_empty() && !misses.contains(&v) {
            misses.push(v);
        }
    }
    let mut line = format!("agent type={typ} status={}", ret.status);
    if !misses.is_empty() {
        line += &format!(" skill_miss={}", misses.join(","));
    }
    // The effort the agent actually ran at, after every layer had its say.
    if let Some(level) = p
        .get("effort")
        .and_then(|e| e.get("level"))
        .and_then(Value::as_str)
        .filter(|l| LOWER_WORD.is_match(l))
    {
        line += &format!(" effort={level}");
    }
    if !agent_id.is_empty() {
        line += &format!(" agent_id={agent_id}");
    }
    line
}

/// Whether this call wrote the phase file.
fn wrote_phase(tool: &str, input: &Map<String, Value>) -> bool {
    if EDIT_TOOLS.is_match(tool) {
        return shell::PHASE_FILE.test(&js_string(nullish(input, &["file_path", "filePath"])));
    }
    tool == "Bash"
        && shell::PHASE_WRITE.test(&shell::phase_write_text(&js_string(input.get("command"))).text)
}

const DID_NOT_LOAD: &str = "[spec-flow] That test file did not load, so none of its tests ran: this is not a red run. \
     If what it imports does not exist yet, write its signature first — exported, unimplemented — \
     then run the test again and confirm it fails on what it asserts.";

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // Creates nothing, and a committed phase never started a run (ADR-017).
    let phase = state::read_phase(&root);
    if phase.is_empty() || phase == "idle" {
        return Exit::Pass;
    }
    // Read as an object of anything: what this records when it cannot read a
    // return is the payload's keys. One that is no object traces nothing.
    let p = input.read::<Map<String, Value>>().unwrap_or_default();
    let tool = js_string(nullish(&p, &["tool_name", "toolName"]));
    let call = nullish(&p, &["tool_input", "toolInput"])
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let res = nullish(
        &p,
        &["tool_response", "tool_result", "tool_output", "response"],
    );
    let event = js_string(p.get("hook_event_name"));
    // `done` stands down but for the call that wrote it: that turn is the
    // run's last (ADR-043). Not into a committed `.claude/state/` (ADR-040).
    if phase == "done" && (!wrote_phase(&tool, &call) || state::state_is_tracked(&root)) {
        return Exit::Pass;
    }
    let dir = state::state_dir(&root);
    let trace_file = dir.join("run-trace.log");
    let miss_log = dir.join("run-trace-unmatched.log");

    let line = if phase == "done" {
        format!("closed tool={tool}")
    } else if event == "SubagentStop" {
        trace_return(&p, &trace_file, &miss_log)
    } else if EDIT_TOOLS.is_match(&tool) {
        // The ORDER of writes is the signal. In scope as the gate reads it;
        // no contract, nothing traced rather than a language assumed.
        let file = js_string(nullish(&call, &["file_path", "filePath"]));
        match contract::load(&root) {
            Ok(cfg)
                if !file.is_empty()
                    && gitscope::in_scope(&root, &file, &cfg.verify.scope_globs) =>
            {
                format!("write file={file}")
            }
            _ => String::new(),
        }
    } else if tool == "Read" {
        let file = js_string(nullish(&call, &["file_path", "filePath"]));
        if file.is_empty() {
            file
        } else {
            format!("read file={file}")
        }
    } else if tool == "Bash" {
        let test_name = contract::load(&root)
            .map(|c| c.verify.test_name)
            .unwrap_or_default();
        let failure = (event == "PostToolUseFailure").then(|| Failure {
            err: p
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into(),
            interrupted: p.get("is_interrupt") == Some(&Value::Bool(true)),
        });
        trace_test(&call, res, &test_name, failure.as_ref())
    } else {
        String::new()
    };
    if line.is_empty() {
        return Exit::Pass;
    }
    // Absent rather than empty when the payload names no session: an empty
    // field would read as "one session". On a return line the id is the
    // SPAWNER's; the agent is `agent_id=`.
    let session = ["session_id", "sessionId"]
        .iter()
        .find_map(|k| p.get(*k)?.as_str().filter(|s| WORD_ID.is_match(s)))
        .map_or_else(String::new, |s| format!(" session={s}"));
    let by_agent = match p.get("agent_id").and_then(Value::as_str) {
        Some(s) if WORD_ID.is_match(s) && !line.starts_with("agent type=") => {
            format!(" agent_id={s}")
        }
        _ => String::new(),
    };
    state::append_line(
        &trace_file,
        &format!(
            "{} phase={phase}{session} {line}{by_agent}",
            state::now_iso()
        ),
    );
    // Said while the implementer can still turn the run into a red one, which
    // nothing after it can (ADR-053). Context, not a block: the run harmed
    // nothing.
    if line.starts_with("test verdict=absent ") {
        let event = if event.is_empty() {
            "PostToolUse".to_string()
        } else {
            event
        };
        return Exit::Say(
            json!({"hookSpecificOutput": {"hookEventName": event, "additionalContext": DID_NOT_LOAD}})
                .to_string(),
        );
    }
    Exit::Pass
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_match_reads_as_gos() {
        for (p, n, want) in [
            ("a/*.ts", "a/b.ts", true),
            ("a/*.ts", "a/b/c.ts", false),
            ("a/?.ts", "a/b.ts", true),
            ("a/[bc].ts", "a/c.ts", true),
            ("a/[^bc].ts", "a/c.ts", false),
            ("a/[b", "a/b", false),
            ("a\\*", "a*", true),
            ("tests/a.spec.ts", "tests/a.spec.ts", true),
        ] {
            assert_eq!(path_match(p.as_bytes(), n.as_bytes()), want, "{p} on {n}");
        }
    }

    #[test]
    fn a_file_named_as_handed_is_the_run_of_it() {
        let targets = vec![
            "./cap/node/area.test.mjs".to_string(),
            "tests\\*.mjs".to_string(),
        ];
        assert!(handed("cap/node/area.test.mjs", &targets));
        assert!(!handed("REQ-GEO-002 perimeter", &targets));
    }

    #[test]
    fn the_runner_is_the_program_run() {
        assert!(runs_runner("npx vitest run x", "vitest"));
        assert!(runs_runner("NODE_ENV=test pnpm exec vitest", "vitest"));
        assert!(runs_runner("node --test a.test.mjs", "node --test"));
        assert!(!runs_runner("grep vitest package.json", "vitest"));
    }
}

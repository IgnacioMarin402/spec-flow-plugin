//! `gate` — Stop, while the phase is `implement` — the external lint, test
//! and spec gate, run outside the model.
//!
//! - Lint is scoped to the files the branch changed; the suite never is, and
//!   never skips, not even on an empty scope (ADR-008). The base is never
//!   guessed: a wrong one manufactures an empty scope.
//! - A dirty tree is not judged: a background implementer may be mid-write.
//!   A streak of them wakes the run once, and so does a dirty tree on a
//!   commit no gate has judged (ADR-012).
//! - `running` goes into the history before anything is judged and every
//!   outcome replaces it. One that survives is proof the invocation was
//!   killed — a timed-out Stop hook renders no decision, and that ALLOWS the
//!   stop — and the next armed gate reports it.
//! - The first pass on a commit wakes the orchestrator (ADR-010); a repeat
//!   stop on a clean tree and a passed sha spawns NOTHING.
//! - At its cap it writes `blocked` and hands the run to a human.
//! - It is the one hook that fails CLOSED: a Stop hook that exits 0 without a
//!   block ALLOWS the stop, so a crash here would report a clean milestone.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::hooks::{Exit, Input};
use crate::payload::{first_string, js_string};
use crate::repo::contract::{self, Config};
use crate::repo::{engine, gitscope, proc, unscoped};
use crate::state;

const MAX_ATTEMPTS: u32 = 5;

/// Consecutive dirty skips before the run is woken — well past what a busy
/// milestone produces, because early is noise on the one outcome that needs
/// nothing done. The gate tests keep their own copy.
const MAX_DIRTY_SKIPS: usize = 10;

// The planner reads gate-failure.log on every REPLAN, so it is budgeted; the
// untruncated output stays in gate-failure.full.log for a human.
const MAX_LINT_LINES: usize = 40;
const MAX_TEST_LINES: usize = 60;

/// A Stop. One this cannot read is still judged: a gate that stood down over
/// an unreadable payload would allow a stop nothing judged.
#[derive(Deserialize, Default)]
struct Stop {
    #[serde(default)]
    session_id: Option<Value>,
    #[serde(default)]
    transcript_path: Option<Value>,
    #[serde(default, rename = "transcriptPath")]
    transcript_path_camel: Option<Value>,
    #[serde(default)]
    background_tasks: Option<Value>,
}

/// A Stop hook's block: JSON on stdout, exit 0. A non-zero exit is no block
/// at all. On a Stop hook it is also the only channel verified to reach a
/// human in an interactive session (ADR-010).
pub fn block(reason: &str) -> Exit {
    Exit::Say(json!({"decision": "block", "reason": reason}).to_string())
}

/// Speaks without a decision, so the stop is still allowed. An interactive
/// session discards it off a Stop hook (ADR-010): only where losing it is
/// acceptable.
fn notice(message: &str) -> Exit {
    Exit::Say(json!({ "systemMessage": message }).to_string())
}

fn short_sha(root: &Path) -> String {
    let res = proc::git(root, &["rev-parse", "--short", "HEAD"]);
    if res.ok() {
        res.stdout.trim().into()
    } else {
        "-".into()
    }
}

static CC_VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[0-9]+\.[0-9]+\.[0-9]+[0-9A-Za-z_.+-]*$").unwrap());

/// The `version` of the transcript's last line that carries one, else `?`
/// (ADR-041): a resumed session's transcript holds every build it ran under.
/// Read from the end, widening until a whole line answers.
fn claude_code_version(path: &str) -> String {
    let unknown = || "?".to_string();
    if path.is_empty() {
        return unknown();
    }
    let Ok(mut f) = std::fs::File::open(path) else {
        return unknown();
    };
    let Ok(size) = f.metadata().map(|m| m.len()) else {
        return unknown();
    };
    let mut span = 256 * 1024u64;
    loop {
        let length = size.min(span);
        let mut buf = vec![0u8; length as usize];
        if f.seek(SeekFrom::Start(size - length)).is_err() || f.read_exact(&mut buf).is_err() {
            return unknown();
        }
        let text = String::from_utf8_lossy(&buf);
        let mut lines: Vec<&str> = text.split('\n').collect();
        if length < size {
            lines.remove(0); // begins mid-line
        }
        for line in lines.iter().rev() {
            let Ok(Value::Object(entry)) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            // Whitespace-free, because the history is read back by a split.
            if let Some(Value::String(v)) = entry.get("version")
                && CC_VERSION.is_match(v)
            {
                return v.clone();
            }
        }
        if length == size {
            return unknown();
        }
        span *= 4;
    }
}

fn truncate(text: &str, max: usize) -> String {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= max {
        return text.into();
    }
    format!(
        "{}\n... [{} more lines — see .claude/state/gate-failure.full.log]",
        lines[..max].join("\n"),
        lines.len() - max
    )
}

static TEST_SIGNAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[\t\n\x0C\r ]*(●|✕|Tests:|Suites:|Test Suites:)").unwrap());

/// The failure blocks and the totals; with no marker, the TAIL, where a
/// runner prints its summary — a full suite's head is pass spew, spent on the
/// most expensive model in the flow.
fn summarize_tests(text: &str, max: usize) -> String {
    let picked: Vec<&str> = text
        .split('\n')
        .filter(|l| TEST_SIGNAL.is_match(l))
        .collect();
    if !picked.is_empty() {
        return truncate(&picked.join("\n"), max);
    }
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= max {
        return text.into();
    }
    format!(
        "... [{} more lines above — see .claude/state/gate-failure.full.log]\n{}",
        lines.len() - max,
        lines[lines.len() - max..].join("\n")
    )
}

fn non_empty_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .filter(|l| !l.is_empty())
        .map(String::from)
        .collect()
}

fn sha_of(line: &str) -> &str {
    line.split(' ').nth(1).unwrap_or("")
}

/// Writes one history line in place of a `running` one: set once the gate
/// knows it is armed, so the fail-closed handler can still write a line and
/// a block after a crash.
type Hist = Box<dyn Fn(&str, &str, &str, &str, &str) + Send>;
static ARMED: Mutex<Option<Hist>> = Mutex::new(None);

fn hist(result: &str, lint: &str, test: &str, fields: &str, files: &str) {
    if let Ok(armed) = ARMED.lock()
        && let Some(h) = armed.as_ref()
    {
        h(result, lint, test, fields, files);
    }
}

/// What a Stop hook's crash is: a block, or the stop it would allow is one
/// nothing judged. Code written with the gate off looks like code that passed
/// it.
pub fn fail_closed(error: &str) -> Exit {
    let armed = ARMED.lock().map(|a| a.is_some()).unwrap_or(true);
    if !armed {
        return Exit::Pass; // not an armed run: nothing to fail closed about
    }
    hist("fail:hook-error", "-", "-", "unscoped=missing", "-");
    block(&format!(
        "GATE FAILED — the gate itself threw before it could judge anything: {error}. \
         This is a defect in the engine, not in the milestone: nothing was linted, tested or traced, so treat NOTHING as verified. \
         Do not retry blindly and do not change the phase. Show this to a human, with the stack from stderr."
    ))
}

static RUNNING_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" result=running ").unwrap());
static SKIP_DIRTY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" result=skip-dirty ").unwrap());
static PASS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" result=pass ").unwrap());
static STATE_DIR_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.claude[\\/]state[\\/]").unwrap());
static PORCELAIN_Q: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^"|"$"#).unwrap());

fn exit_or_one(res: &proc::Output) -> i32 {
    res.status.filter(|s| *s >= 0).unwrap_or(1)
}

pub fn run(input: &Input) -> Exit {
    // The payload says which session this Stop is: Stop fires for the
    // orchestrating turn, so the owner check is safe here (ADR-017).
    let stop = input.read::<Stop>().unwrap_or_default();
    let root = state::project_dir();
    let phase_file = state::phase_path(&root);
    let phase = state::read_owned_phase(&root, &js_string(stop.session_id.as_ref()));
    if phase != "implement" {
        return Exit::Pass; // nothing recorded: a Stop fires in every session
    }
    // A subagent still running means this stop ends the orchestrator's TURN,
    // not a milestone (ADR-023). Subagents only: a dev server may never end.
    if let Some(Value::Array(tasks)) = &stop.background_tasks
        && tasks.iter().any(|t| {
            t.get("type").and_then(Value::as_str) == Some("subagent")
                && t.get("status").and_then(Value::as_str) == Some("running")
        })
    {
        return Exit::Pass;
    }
    let dir = state::state_dir(&root);
    let att_file = dir.join("gate_attempts");
    let log_file = dir.join("gate-failure.log");
    let full_log_file = dir.join("gate-failure.full.log");
    let hist_file = dir.join("gate-history.log");
    let cc = claude_code_version(&first_string([
        &stop.transcript_path,
        &stop.transcript_path_camel,
    ]));
    let revision = engine::revision(&engine::root());
    let previous = non_empty_lines(&state::read_file_or_default(&hist_file, ""));
    arm(&root, &att_file, &hist_file, cc, revision, phase);

    // A dangling `running` from a PREVIOUS invocation: that gate was killed
    // mid-judgement. Replaced, not appended beside, or every future stop
    // would block on the same dead invocation.
    if previous.last().is_some_and(|l| RUNNING_LINE.is_match(l)) {
        hist("fail:killed", "-", "-", "unscoped=-", "-");
        return block(
            "GATE FAILED — the previous gate invocation never finished. Its history line says `running` and no outcome ever replaced it, which means the process was killed before it could judge anything: nothing was linted, tested or traced for that stop, and the stop was ALLOWED, because a Stop hook that renders no decision allows one. \
             The usual cause is `verify.test` exceeding the Stop hook's time budget (1800s as this plugin declares it). Treat the previous milestone as UNVERIFIED. \
             Do not change the phase. Show this to a human: either the suite needs to be a smaller smoke subset in `verify.test`, or the timeout in the plugin's hooks.json needs raising. Then end your turn — the next gate runs normally.",
        );
    }
    // This invocation's claim on the log, before anything is spawned.
    state::append_line(
        &hist_file,
        &line_now(&root, &att_file, "running", "-", "-", "unscoped=-", "-"),
    );
    judge(
        &root,
        &phase_file,
        &att_file,
        &log_file,
        &full_log_file,
        &previous,
    )
}

/// The history line every outcome writes. `cc=` and `engine=` are recorded,
/// never checked (ADR-004, ADR-041, ADR-018). The live view reads a failure's
/// checks as the fields between `result=` and `files=` (ADR-047).
static LINE_PREFIX: Mutex<Option<(String, String, String)>> = Mutex::new(None);

fn line_now(
    root: &Path,
    att_file: &Path,
    result: &str,
    lint: &str,
    test: &str,
    fields: &str,
    files: &str,
) -> String {
    let (cc, revision, phase) = LINE_PREFIX
        .lock()
        .ok()
        .and_then(|p| p.clone())
        .unwrap_or_default();
    let now = state::now_iso();
    format!(
        "{}Z {} cc={cc} engine={revision} phase={phase} attempt={} result={result} lint={lint} test={test} {fields} files={files}",
        &now[..19],
        short_sha(root),
        state::read_file_or_default(att_file, "0"),
    )
}

/// From here on the gate is armed: every outcome, a crash included, replaces
/// the `running` line with its own.
fn arm(
    root: &Path,
    att_file: &Path,
    hist_file: &Path,
    cc: String,
    revision: String,
    phase: String,
) {
    if let Ok(mut p) = LINE_PREFIX.lock() {
        *p = Some((cc, revision, phase));
    }
    let (root, att_file, hist_file): (PathBuf, PathBuf, PathBuf) =
        (root.into(), att_file.into(), hist_file.into());
    let h: Hist = Box::new(move |result, lint, test, fields, files| {
        let mut lines = non_empty_lines(&state::read_file_or_default(&hist_file, ""));
        if lines.last().is_some_and(|l| RUNNING_LINE.is_match(l)) {
            lines.pop();
        }
        lines.push(line_now(
            &root, &att_file, result, lint, test, fields, files,
        ));
        state::write_file(&hist_file, &(lines.join("\n") + "\n"));
    });
    if let Ok(mut armed) = ARMED.lock() {
        *armed = Some(h);
    }
}

fn judge(
    root: &Path,
    phase_file: &Path,
    att_file: &Path,
    log_file: &Path,
    full_log_file: &Path,
    previous: &[String],
) -> Exit {
    // Ahead of the contract: one read from a subdirectory is the wrong one
    // (ADR-027). Ahead of the dirty check, whose paths git spells from the
    // root.
    if let Err(e) = gitscope::assert_repo_root(root) {
        hist("fail:root", "-", "-", "unscoped=-", "-");
        return block(&format!(
            "GATE FAILED — {} Do not proceed and do not change the phase. Nothing was linted, tested or traced, so treat NOTHING as verified.",
            e.msg
        ));
    }
    // The one deliberate fail-CLOSED case: an unrecognised contract blocks
    // loudly.
    let cfg = match contract::load(root) {
        Ok(c) => c,
        Err(e) => {
            hist("fail:contract", "-", "-", "unscoped=missing", "-");
            return block(&format!(
                "GATE FAILED — the contract could not be read: {e} Do not proceed. A human needs to fix .spec-flow/config.json (or the engine's own supported version) before this run can continue."
            ));
        }
    };
    let dashes = unscoped::hist_dashes(&cfg);

    // ---- quiescence guard ------------------------------------------------------
    // `.claude/state/` is excluded: the gate's own writes land there. So is
    // `trace.report.path`: the SUITE writes it, and the gate runs the suite,
    // so every armed run leaves it behind. Prefix, because git collapses an
    // untracked directory into one entry.
    let status = proc::git(root, &["status", "--porcelain"]);
    let report_path = cfg
        .trace
        .report
        .as_ref()
        .map_or_else(String::new, |r| r.path.replace('\\', "/"));
    let is_report_dirt = |l: &str| {
        if report_path.is_empty() || l.len() < 3 {
            return false;
        }
        let path = PORCELAIN_Q.replace_all(&l[3..], "").replace('\\', "/");
        let prefix = if path.ends_with('/') {
            path.clone()
        } else {
            format!("{path}/")
        };
        path == report_path || report_path.starts_with(&prefix)
    };
    let dirty: Vec<&str> = if status.ok() {
        status
            .stdout
            .split('\n')
            .filter(|l| !l.trim().is_empty() && !STATE_DIR_LINE.is_match(l) && !is_report_dirt(l))
            .collect()
    } else {
        Vec::new()
    };
    if !dirty.is_empty() {
        let n = dirty.len();
        hist("skip-dirty", "-", "-", &dashes, &n.to_string());
        // A dirty tree on a commit NO gate has judged is not an implementer
        // mid-write: the orchestrator committed and waits for a verdict
        // nothing will deliver (ADR-012). Once per commit; a sha of `-` cannot
        // tell.
        let sha = short_sha(root);
        if sha != "-" && !previous.iter().any(|l| sha_of(l) == sha) {
            return block(&format!(
                "GATE SKIPPED — the working tree is dirty on {sha}, a commit no gate has ever judged: nothing was linted, tested or traced for it, and this stop was ALLOWED, because a dirty tree is not a failure. \
                 Uncommitted paths: {n}. If a subagent is still writing — an implementer, or the spec-writer folding — that is what the skip is for: say so and end your turn again; this is reported once per commit, not on every stop. \
                 If none is running, you are waiting for a verdict that will never arrive: run `git status`, commit what is left to this milestone's branch, and end your turn so the gate judges a clean tree. \
                 A `git mv` stages a rename carrying the file's OLD content, so a file edited and then moved needs an explicit `git add` — a plain `git commit` drops the edit and leaves exactly this. Do not change the phase."
            ));
        }
        // Skipping is right for one stop and wrong forever. The streak is on
        // disk already; reported on `==`, so an unbroken streak wakes ONCE.
        let prior = previous
            .iter()
            .rev()
            .take_while(|l| SKIP_DIRTY.is_match(l))
            .count();
        if prior + 1 == MAX_DIRTY_SKIPS {
            return block(&format!(
                "GATE SKIPPED {MAX_DIRTY_SKIPS} times in a row — the working tree has been dirty at every stop, so this milestone has never been judged: nothing was linted, tested or traced, and each of those stops was ALLOWED because a dirty tree is not a failure. \
                 Uncommitted paths: {n}. That guard exists for a subagent writing in the background, and this no longer looks like one. \
                 Find out which: if a subagent is still working, let it finish and say nothing. If none is, the work was left uncommitted and no gate will ever see it — commit it to this milestone's branch, then end your turn so the gate runs against a clean tree. Do not change the phase."
            ));
        }
        return Exit::Pass;
    }

    // ---- the verdict this commit already has ---------------------------------
    // The tree is clean and the sha carries a `pass`: nothing this gate may
    // judge can have changed. ADR-008 forbids scoping the suite, not
    // re-running it over an identical tree. Every field `-`: reprinting
    // `lint=0` for commands that did not run is the lie the lint field refuses.
    let judged_sha = short_sha(root);
    if judged_sha != "-"
        && previous
            .iter()
            .any(|l| sha_of(l) == judged_sha && PASS_LINE.is_match(l))
    {
        hist("pass", "-", "-", &dashes, "-");
        return notice(&format!(
            "spec-flow: gate PASSED — {judged_sha}. Already reported for this commit, and not re-judged: the tree is clean and nothing has been committed since, so the verdict cannot have changed. Nothing more happens on its own unless you act."
        ));
    }

    // ---- scope: the files this branch touched -----------------------------------
    // An unresolvable base is a contract a human fixes, not an engine defect.
    let base = match gitscope::resolve_base(root, Some(&cfg)) {
        Ok(b) => b,
        Err(e) => {
            hist("fail:base", "-", "-", &dashes, "-");
            return block(&format!(
                "GATE FAILED — the base branch could not be resolved: {e} Do not proceed and do not change the phase. Nothing was linted or tested, so treat NOTHING as verified. A human needs to add \"base_ref\" under \"verify\" in .spec-flow/config.json."
            ));
        }
    };
    let files = gitscope::changed_files(root, &cfg.verify.scope_globs, &base);
    judge_scope(
        root,
        &cfg,
        &base,
        &files,
        phase_file,
        att_file,
        log_file,
        full_log_file,
        &dashes,
    )
}

#[allow(clippy::too_many_arguments)]
fn judge_scope(
    root: &Path,
    cfg: &Config,
    base: &str,
    files: &[String],
    phase_file: &Path,
    att_file: &Path,
    log_file: &Path,
    full_log_file: &Path,
    dashes: &str,
) -> Exit {
    let v = &cfg.verify;
    // ---- the base that resolved, to the tip -------------------------------------
    // Work done ON the base branch empties the diff by construction, and lint
    // — the one scoped check — would never run while `lint=-` reads as
    // honest. Not in preflight: a fresh branch sits at its base until its
    // first commit.
    let head = proc::git(root, &["rev-parse", "HEAD"]);
    if head.ok() && head.stdout.trim() == base {
        let b = proc::git(root, &["rev-parse", "--abbrev-ref", "HEAD"]);
        let branch = if b.ok() {
            b.stdout.trim().to_string()
        } else {
            "(unknown)".into()
        };
        // `files` — zero, and COUNTED — tells this refusal from the one above.
        hist("fail:base", "-", "-", dashes, &files.len().to_string());
        return block(&format!(
            "GATE FAILED — the base resolved to HEAD itself, so the changed-file scope is empty by construction and {} was never invoked. \
             Branch \"{branch}\" has no commit the base does not already have. Either this work is being done directly ON the base branch, in which case the scope will be empty for every milestone of this run, or this milestone committed nothing at all. \
             Do not proceed and do not change the phase. Nothing was linted, so treat NOTHING as verified. A human fixes this by doing the run's work on its own branch, or by declaring the ref this work is judged against as \"base_ref\" under \"verify\" in .spec-flow/config.json.",
            v.lint_name
        ));
    }

    // ---- the scope that can never match -------------------------------------------
    if files.is_empty() && gitscope::scope_matches_nothing(root, &v.scope_globs) {
        hist("fail:scope", "-", "-", dashes, "0");
        return block(&format!(
            "GATE FAILED — verify.scope_globs ({}) matches no file this repository tracks, so the changed-file scope is empty by construction and {} was never invoked. \
             This is not a milestone that touched nothing in scope: nothing could ever be in scope, on any commit, so the history's `lint=-` would read as clean for the whole run. \
             Do not proceed and do not change the phase. Nothing was linted, so treat NOTHING as verified. A human fixes this in \"scope_globs\" under \"verify\" in .spec-flow/config.json — these are git pathspecs, where `*` already crosses `/`, so \"*.ts\" covers every depth and \"**/*.ts\" skips the repo root. `spec-flow init` regenerates the field from this repo.",
            v.scope_globs.join(", "),
            v.lint_name
        ));
    }

    // Lint is scoped, so it has nothing to do when nothing in scope changed.
    let (lint_out, lint_rc) = if files.is_empty() {
        ("(no files in scope changed)".to_string(), 0)
    } else {
        let argv: Vec<&str> = v.lint.iter().chain(files).map(String::as_str).collect();
        let res = proc::run(root, &argv);
        (format!("{}{}", res.stdout, res.stderr), exit_or_one(&res))
    };
    // The suite runs on EVERY armed gate, scoped to nothing: its outcome is a
    // property of the system, and an empty diff is not always real.
    contract::prepare_report(root, cfg);
    let test_argv: Vec<&str> = v.test.iter().map(String::as_str).collect();
    let test_res = proc::run(root, &test_argv);
    let (test_out, test_rc) = (
        format!("{}{}", test_res.stdout, test_res.stderr),
        exit_or_one(&test_res),
    );

    // AFTER the suite: spec-trace reads what THIS run of it reported.
    let result = unscoped::run(root, cfg);
    let lint_field = if files.is_empty() {
        "-".to_string()
    } else {
        lint_rc.to_string()
    };
    let fields = unscoped::hist_fields(&result);
    if lint_rc == 0 && test_rc == 0 && result.all_pass {
        let sha = short_sha(root);
        hist(
            "pass",
            &lint_field,
            &test_rc.to_string(),
            &fields,
            &files.len().to_string(),
        );
        state::write_file(att_file, "0");
        state::write_file(log_file, "");
        state::write_file(full_log_file, "");
        // A pass WAKES the orchestrator: an interactive session discards a
        // Stop hook's systemMessage (ADR-010).
        return block(&format!(
            "spec-flow: gate PASSED — {sha} ({} {lint_field}, {} {test_rc}, {fields}). Advance the run now: start the NEXT milestone with a fresh implementer Agent call, or if none remain, invoke spec-writer in MODE=FOLD; if this was the fold's own gate re-run, write 'done' into .claude/state/phase. Do not re-run lint or tests yourself and do not repeat what already passed.",
            v.lint_name, v.test_name
        ));
    }

    // ---- failure path ----------------------------------------------------------------
    let attempts = state::read_file_or_default(att_file, "0")
        .parse::<u32>()
        .unwrap_or(0)
        + 1;
    state::write_file(att_file, &attempts.to_string());
    // A traceability failure groups with lint: its common cause is a test
    // that never named the requirement, an edit. A red test is behaviour, and
    // so is a check the contract declared `behaviour`.
    let behaviour = test_rc != 0
        || result
            .checks
            .iter()
            .any(|c| c.rc != 0 && c.check.class == "behaviour");
    let failure_class = if behaviour { "behaviour" } else { "lint/trace" };
    let sections: Vec<String> = result
        .checks
        .iter()
        .map(|c| format!("--- {} (rc={}) ---\n{}", c.check.name, c.rc, c.out))
        .collect();
    let terse: Vec<String> = result
        .checks
        .iter()
        .map(|c| {
            let body = if c.rc == 0 { &c.check.green } else { &c.out };
            format!("--- {} (rc={}) ---\n{body}", c.check.name, c.rc)
        })
        .collect();
    let header = [
        format!("=== GATE FAILURE (attempt {attempts}/{MAX_ATTEMPTS}, class: {failure_class}) ==="),
        format!("--- scope ({} changed file(s) vs {base}) ---", files.len()),
        files.join("\n"),
        String::new(),
        format!("--- {} (rc={lint_field}) ---", v.lint_name),
    ];
    let extra = |s: &[String]| {
        if s.is_empty() {
            String::new()
        } else {
            format!("\n{}", s.join("\n\n"))
        }
    };
    let mut full: Vec<String> = header.to_vec();
    full.extend([
        lint_out.clone(),
        String::new(),
        format!("--- {} (rc={test_rc}) ---", v.test_name),
        test_out.clone(),
        extra(&sections),
    ]);
    state::write_file(full_log_file, &full.join("\n"));
    // `(clean)` would claim a linter passed over files it was never given.
    let lint_short = if files.is_empty() {
        lint_out
    } else if lint_rc != 0 {
        truncate(&lint_out, MAX_LINT_LINES)
    } else {
        "(clean)".into()
    };
    let test_short = if test_rc != 0 {
        summarize_tests(&test_out, MAX_TEST_LINES)
    } else {
        "(all passing)".into()
    };
    let mut short: Vec<String> = header.to_vec();
    short.extend([
        lint_short,
        String::new(),
        format!("--- {} (rc={test_rc}, failures only) ---", v.test_name),
        test_short,
        extra(&terse),
    ]);
    state::write_file(log_file, &short.join("\n"));
    hist(
        &format!("fail:{failure_class}"),
        &lint_field,
        &test_rc.to_string(),
        &fields,
        &files.len().to_string(),
    );

    let summary = unscoped::summary(&result);
    if attempts >= MAX_ATTEMPTS {
        // Repeated failure of any class means a human should look.
        state::write_file(att_file, "0");
        state::write_file(phase_file, "blocked");
        return block(&format!(
            "GATE FAILED {attempts} times (lint rc={lint_field}, test rc={test_rc}, {summary}). Auto-loop stopped to avoid thrashing; the phase is now 'blocked' so this stop-and-wait is allowed. Read .claude/state/gate-failure.log, summarize the blocker for the human (HITL), and wait. After their guidance, write 'implement' into .claude/state/phase and resume the milestone."
        ));
    }
    if failure_class == "lint/trace" && attempts <= 2 {
        // Lint only: the implementer fixes it directly, no re-plan.
        return block(&format!(
            "GATE FAILED on lint and/or the unscoped checks (lint rc={lint_field}, {summary}); the tests pass, so the plan is NOT in question. Do NOT re-plan and do NOT change the phase. Route the fix back to the session whose edits are being checked — the implementer of the CURRENT milestone, or the spec-writer if you just ran the FOLD step — with the output in .claude/state/gate-failure.log, and have it fix exactly those violations — nothing else. Note that the linter already applied everything auto-fixable, so what remains needs a real edit; if a violation comes from a project rule in {}, read its message, which explains what it protects. {} Then end your turn so the gate runs again.",
            v.lint_config_hint,
            unscoped::failed_hints(&result)
        ));
    }
    if failure_class == "behaviour" && attempts == 1 {
        // The first red after a milestone is overwhelmingly a bug in the code
        // just written: an Opus REPLAN before a direct fix is
        // expensive-first.
        return block(&format!(
            "GATE FAILED (lint rc={lint_field}, test rc={test_rc}, {summary}), attempt 1/{MAX_ATTEMPTS}. Do NOT re-plan yet and do NOT change the phase. Route the fix back to the implementer of the CURRENT milestone with the output in .claude/state/gate-failure.log: fix the code (and any lint violation alongside it) so everything passes. Do NOT skip, delete, or weaken the failing test to make this pass — spec-trace does not catch a test that still exists but no longer asserts anything. If you believe the PLAN itself is wrong rather than the code, say so in your reply instead of patching around the test. Then end your turn so the gate runs again."
        ));
    }
    block(&format!(
        "GATE FAILED (lint rc={lint_field}, test rc={test_rc}, {summary}, class={failure_class}) on the files this branch changed. Do NOT patch ad-hoc. Loop back to the PLAN phase: (1) write 'plan' into .claude/state/phase, (2) invoke the planner subagent in MODE=REPLAN for the CURRENT milestone, pointing it at the failure log .claude/state/gate-failure.log, (3) re-invoke the implementer for that milestone, (4) set phase back to 'implement'. The full output is in .claude/state/gate-failure.log."
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn summarize_keeps_markers_else_the_tail() {
        let marked = "pass 1\n  ● a fails\npass 2\nTests: 1 failed";
        assert_eq!(
            super::summarize_tests(marked, 60),
            "  ● a fails\nTests: 1 failed"
        );
        let plain: Vec<String> = (1..=5).map(|i| format!("line {i}")).collect();
        assert_eq!(
            super::summarize_tests(&plain.join("\n"), 2),
            "... [3 more lines above — see .claude/state/gate-failure.full.log]\nline 4\nline 5"
        );
        assert_eq!(
            super::truncate("a\nb\nc", 2),
            "a\nb\n... [1 more lines — see .claude/state/gate-failure.full.log]"
        );
    }
}

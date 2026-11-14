//! The commands that read what a run leaves on disk: `status`, `resume`,
//! `telemetry` and `lines`.

use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Value, json};

use crate::jsre::Re;
use crate::repo::{contract, gitscope, proc};
use crate::spec::time;
use crate::state;
use crate::tracelines;

/// A file's lines, trimmed, the blank ones dropped.
pub fn read_lines(path: &Path) -> Vec<String> {
    state::read_text(path)
        .map(|t| {
            t.split('\n')
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// A line's timestamp, milliseconds since the epoch.
pub fn line_at(line: &str) -> Option<f64> {
    state::parse_rfc3339(line.split(' ').next().unwrap_or_default())
}

fn sha_of(line: &str) -> &str {
    line.split(' ').nth(1).unwrap_or("")
}

/// A timestamp as the history writes one, to the second.
fn second(ms: f64) -> String {
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0.0) as u64);
    format!("{}Z", &state::iso(t)[..19])
}

/// `spec-flow status`: the state a run leaves between turns, rendered.
/// Report only.
pub fn status(_: &[String]) -> i32 {
    let root = state::project_dir();
    let dir = root.join(".claude").join("state");
    let read = |f: &str| state::read_file_or_default(&dir.join(f), "");
    let mut out = String::new();
    let mut say = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    say("spec-flow status — report only, nothing here gates anything".into());
    say(format!("repo: {}\n", root.display()));
    let (phase, owner) = (read("phase"), read("phase.session"));
    say("Run".into());
    if matches!(phase.as_str(), "" | "idle" | "done") {
        let p = if phase.is_empty() { "(none)" } else { &phase };
        say(format!(
            "  phase: {p} — no run is armed. The hooks that enforce anything stand down here."
        ));
    } else if !owner.is_empty() {
        say(format!("  phase: {phase} (owned by session {owner})"));
    } else {
        say(format!("  phase: {phase}"));
    }
    let position = read("current-milestone");
    let m: Vec<&str> = position.split_whitespace().collect();
    if m.len() >= 2 {
        let implementer = m
            .get(2)
            .map_or_else(String::new, |s| format!(" (implementer session {s})"));
        say(format!("  milestone: {} of {}{implementer}", m[1], m[0]));
    } else if phase == "implement" {
        say("  milestone: not recorded — no implementer has been spawned in this run yet.".into());
    }
    let attempts = read("gate_attempts").parse::<i64>().unwrap_or(0);
    if attempts > 0 {
        say(format!(
            "  consecutive gate failures: {attempts} (the cap, and what happens at it, is the gate's — see the failure log below)"
        ));
    }
    say(String::new());

    let history = read_lines(&dir.join("gate-history.log"));
    say("Gate".into());
    match history.last() {
        None => {
            say("  no gate history — this repo has not run a milestone through the gate.".into())
        }
        Some(last_line) => {
            let last = tracelines::parse(last_line);
            let q = |k: &str| last.get(k).unwrap_or("?").to_string();
            say(format!(
                "  last: {} — {} (lint {}, test {})",
                q("result"),
                sha_of(last_line),
                q("lint"),
                q("test")
            ));
            if let Some(at) = last.at {
                say(format!(
                    "        at {}, engine {}, claude code {}",
                    second(at),
                    q("engine"),
                    q("cc")
                ));
            }
            if last.f("result") == "running" {
                say("  WARNING: that line was never replaced, so the gate was killed mid-judgement.".into());
                say("  Nothing it was judging was verified. The next armed run reports it.".into());
            }
            // First-seen order, as a JavaScript object keeps its keys.
            let mut tally: Vec<(String, usize)> = Vec::new();
            for l in &history {
                let r = tracelines::parse(l)
                    .get("result")
                    .unwrap_or("undefined")
                    .to_string();
                match tally.iter_mut().find(|(k, _)| *k == r) {
                    Some((_, n)) => *n += 1,
                    None => tally.push((r, 1)),
                }
            }
            let parts: Vec<String> = tally.iter().map(|(k, n)| format!("{n} {k}")).collect();
            say(format!(
                "  history: {} invocation(s) — {}",
                history.len(),
                parts.join(", ")
            ));
        }
    }
    if !read("gate-failure.log").is_empty() {
        let failure = read_lines(&dir.join("gate-failure.log"));
        say(format!(
            "  the last failure is on disk ({} line(s)): .claude/state/gate-failure.log",
            failure.len()
        ));
        if let Some(l) = failure.iter().find(|l| l.starts_with("=== GATE FAILURE")) {
            let l = l.strip_prefix("=== ").unwrap_or(l);
            say(format!("  {}", l.strip_suffix(" ===").unwrap_or(l)));
        }
    }
    say(String::new());

    let entries: Vec<tracelines::Entry> = read_lines(&dir.join("run-trace.log"))
        .iter()
        .map(|l| tracelines::parse(l))
        .collect();
    let rows = tracelines::summarize_tokens(&entries);
    say("Cost".into());
    if rows.is_empty() {
        say(
            "  no token accounting recorded — token-trace writes it at each stop of an armed run."
                .into(),
        );
    } else {
        let width = rows.iter().map(|r| r.model.len()).max().unwrap_or(0);
        for r in &rows {
            say(format!("  {}", tracelines::token_row(r, width)));
        }
        say(
            "  out and think are floors (≥): some messages never get their final count written."
                .into(),
        );
        say("  This is the live state only. `spec-flow stats` adds every archived run.".into());
    }
    say(String::new());
    say("Everything above is written by the run itself. `spec-flow stats` reads the same".into());
    say("state plus the archived runs, and asks what it means.".into());
    print!("{out}");
    0
}

const TELEMETRY_LOGS: [&str; 2] = ["run-trace.log", "gate-history.log"];

/// A file's lines that are not blank, untrimmed.
fn non_blank(path: &Path) -> Vec<String> {
    state::read_text(path)
        .map(|t| {
            t.split('\n')
                .filter(|l| !l.trim().is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// `spec-flow telemetry --mark | <SLUG>`: the run's slice of the cumulative
/// logs moved into its change folder, which is what `stats` reads once the
/// state is gone. `--mark` at intake records where this run starts.
pub fn telemetry(args: &[String]) -> i32 {
    let root = state::project_dir();
    let dir = root.join(".claude").join("state");
    let offset_file = dir.join("run-offset");
    if args.iter().any(|a| a == "--mark") {
        let _ = std::fs::create_dir_all(&dir);
        let offsets: BTreeMap<&str, usize> = TELEMETRY_LOGS
            .iter()
            .map(|f| (*f, non_blank(&dir.join(f)).len()))
            .collect();
        let total: usize = offsets.values().sum();
        state::write_file(&offset_file, &format!("{}\n", json!(offsets)));
        if total == 0 {
            println!("telemetry: mark set at an empty state — this run starts the record.");
        } else {
            println!(
                "telemetry: mark set — {total} pre-existing line(s) will be excluded from this run's slice."
            );
        }
        return 0;
    }
    let Some(slug) = args.iter().find(|a| !a.starts_with('-')) else {
        println!("telemetry: usage — spec-flow telemetry --mark | spec-flow telemetry <SLUG>");
        return 1;
    };
    let specflow = root.join("specflow");
    let Some(target) = [specflow.join("archive").join(slug), specflow.join(slug)]
        .into_iter()
        .find(|c| c.exists())
    else {
        println!(
            "telemetry: FAILED — no change folder named \"{slug}\" under specflow/ or specflow/archive/."
        );
        return 1;
    };
    let mut offsets: BTreeMap<String, f64> = BTreeMap::new();
    if let Some(text) = state::read_text(&offset_file) {
        match serde_json::from_str::<BTreeMap<String, Value>>(&text) {
            Ok(m) if m.values().all(|v| v.is_number() || v.is_null()) => {
                offsets = m
                    .into_iter()
                    .map(|(k, v)| (k, v.as_f64().unwrap_or(0.0)))
                    .collect();
            }
            _ => println!(
                "telemetry: the mark could not be read — taking the whole log, which may include earlier runs."
            ),
        }
    }
    let out_dir = target.join("telemetry");
    let _ = std::fs::create_dir_all(&out_dir);
    let mut written = Vec::new();
    for f in TELEMETRY_LOGS {
        let lines = non_blank(&dir.join(f));
        let from = (offsets.get(f).copied().unwrap_or(0.0).max(0.0) as usize).min(lines.len());
        let slice = &lines[from..];
        if slice.is_empty() {
            continue;
        }
        state::write_file(&out_dir.join(f), &format!("{}\n", slice.join("\n")));
        written.push(format!("{f} ({} line(s))", slice.len()));
    }
    if written.is_empty() {
        println!("telemetry: nothing to snapshot for \"{slug}\" — the run produced no trace.");
        return 0;
    }
    let shown = out_dir
        .to_string_lossy()
        .replacen(&*root.to_string_lossy(), ".", 1)
        .replace('\\', "/");
    println!(
        "telemetry: snapshotted into {shown} — {}",
        written.join(", ")
    );
    0
}

/// How many of the lines that count `lines` hands back.
pub const KEEP: usize = 10000;

/// Whether a log line counts for the live view — the one filter the mod
/// applies to a log it reads whole, so a count does not change when a log
/// crosses what one read takes. The golden table holds both to it.
pub fn counts(line: &str, needle: &str, since: f64) -> bool {
    if !line.contains(needle) {
        return false;
    }
    if since == f64::NEG_INFINITY {
        return !line.trim().is_empty();
    }
    line_at(line).is_some_and(|t| t >= since)
}

/// `spec-flow lines <path> <since-ms> <needle>`: what the live view runs on a
/// log one read in the mod cannot take, streamed — how many lines count, then
/// the last `KEEP` of them, oldest first. A line counts when it holds needle
/// and is stamped at or after since (ms); with since -Infinity, any non-blank
/// line.
pub fn lines(args: &[String]) -> i32 {
    let [path, since, needle, ..] = args else {
        eprintln!("spec-flow lines: usage — spec-flow lines <path> <since-ms> <needle>");
        return 1;
    };
    let since = if since == "-Infinity" {
        f64::NEG_INFINITY
    } else {
        match since.trim().parse::<f64>() {
            Ok(f) if !f.is_nan() => f,
            _ => {
                eprintln!("spec-flow lines: {since:?} is not a number of milliseconds");
                return 1;
            }
        }
    };
    let f = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("spec-flow lines: open {path}: {e}");
            return 1;
        }
    };
    let mut ring: Vec<String> = vec![String::new(); KEEP];
    let mut n = 0;
    for raw in std::io::BufReader::new(f).split(b'\n') {
        let Ok(raw) = raw else { break };
        let l = String::from_utf8_lossy(&raw);
        let l = l.strip_suffix('\r').unwrap_or(&l);
        if counts(l, needle, since) {
            ring[n % KEEP] = l.to_string();
            n += 1;
        }
    }
    let mut out = vec![n.to_string()];
    if n <= KEEP {
        out.extend_from_slice(&ring[..n]);
    } else {
        out.extend_from_slice(&ring[n % KEEP..]);
        out.extend_from_slice(&ring[..n % KEEP]);
    }
    let _ = std::io::stdout().write_all(out.join("\n").as_bytes());
    0
}

static FIX_HEADING: LazyLock<Re> = LazyLock::new(|| Re::new(r"^#\s*Fix\b", "m"));
static STATUS_STAMP: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\*\*Status:\*\*\s*([A-Z]+)", "m"));
static MILESTONE_MD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^M([0-9]+)\.md$").unwrap());
static M_NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^M[0-9]+$").unwrap());
static RESULT_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" result=([^\t\n\x0C\r ]+)").unwrap());
static STATE_DIR_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.claude[\\/]state[\\/]").unwrap());

/// The step an unfinished run resumes at, and why.
struct Next(String, String);

/// What is there and cannot be read is UNKNOWN, never read as absent: a file
/// where a directory belongs is not a repository with no changes.
type Read<T> = Result<T, Next>;

fn unknown(e: std::io::Error) -> Next {
    Next(
        "UNKNOWN".into(),
        format!("the state could not be read ({e}); `spec-flow status` shows what is there."),
    )
}

fn read_or_unknown(p: &Path) -> Read<String> {
    match std::fs::read(p) {
        Ok(b) => Ok(state::trim(&String::from_utf8_lossy(&b)).to_string()),
        Err(e) if p.exists() => Err(unknown(e)),
        Err(_) => Ok(String::new()),
    }
}

fn list_or_unknown(p: &Path) -> Read<Vec<String>> {
    match std::fs::read_dir(p) {
        Ok(es) => {
            let mut names: Vec<String> = es
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect();
            names.sort();
            Ok(names)
        }
        Err(e) if p.exists() => Err(unknown(e)),
        Err(_) => Ok(Vec::new()),
    }
}

/// `spec-flow resume [<SLUG>]`: the step an unfinished run resumes at, read
/// off disk. What `/spec-flow:resume` acts on is its `NEXT:` line. It never
/// fails: a state it cannot read is `NEXT: UNKNOWN`.
pub fn resume(args: &[String]) -> i32 {
    let mut out = String::new();
    let next = match crate::hooks::quietly(|| resume_from(args, &mut out)) {
        Ok(Ok(())) => unreachable!("resume always names a step"),
        Ok(Err(next)) => next,
        Err(e) => Next(
            "UNKNOWN".into(),
            format!("the state could not be read ({e}); `spec-flow status` shows what is there."),
        ),
    };
    print!("{out}\nNEXT: {}\nWHY: {}\n", next.0, next.1);
    0
}

fn resume_from(args: &[String], out: &mut String) -> Read<()> {
    let root = state::project_dir();
    let dir_state = root.join(".claude").join("state");
    let specflow = root.join("specflow");
    let asked = args.first().cloned().unwrap_or_default();
    let mut say = |s: String| {
        out.push_str(&s);
        out.push('\n');
    };
    let next = |step: &str, why: String| Err(Next(step.into(), why));

    let at_base = contract::load(&root)
        .ok()
        .and_then(|cfg| gitscope::resolve_base(&root, Some(&cfg)).ok())
        .map(|base| gitscope::changes_at_base(&root, &base))
        .unwrap_or_default();
    let live: Vec<String> = list_or_unknown(&specflow)?
        .into_iter()
        .filter(|d| {
            d != "archive" && !at_base.contains(d) && specflow.join(d).join("spec.md").exists()
        })
        .collect();
    let phase = read_or_unknown(&dir_state.join("phase"))?;
    let position = read_or_unknown(&dir_state.join("current-milestone"))?;
    let at: Vec<&str> = position.split_whitespace().collect();
    let at_slug = at.first().copied().unwrap_or_default();
    let at_milestone = at.get(1).copied().unwrap_or_default();

    say("spec-flow resume — where an unfinished run stands, read off disk".into());
    say(format!("repo: {}\n", root.display()));
    if !at_base.is_empty() {
        say(format!(
            "not runs of this branch — the base branch has them: {}",
            at_base.join(", ")
        ));
    }
    if phase == "blocked" {
        return next("BLOCKED", "the gate reached its attempt cap and wrote `blocked` itself; a human decides from .claude/state/gate-failure.log.".into());
    }
    let mut slug = asked;
    if at_base.contains(&slug) {
        return next(
            "NONE",
            format!(
                "specflow/{slug}/ is on the base branch, so no run of this branch created it; a run cannot start over it (ADR-032)."
            ),
        );
    }
    if slug.is_empty() {
        if live.len() > 1 {
            say(format!("live changes: {}", live.join(", ")));
            return next(
                "CHOOSE",
                "more than one change is live in specflow/; name the one to resume.".into(),
            );
        }
        if let [only] = &live[..] {
            slug = only.clone();
        }
    }
    if slug.is_empty()
        && !at_slug.is_empty()
        && specflow
            .join("archive")
            .join(at_slug)
            .join("spec.md")
            .exists()
        && phase != "done"
    {
        slug = at_slug.into();
    }
    if slug.is_empty() {
        return next(
            "NONE",
            "no change is live in specflow/ and none is half-closed; there is nothing to resume."
                .into(),
        );
    }
    let live_dir = specflow.join(&slug);
    let archived = !live_dir.join("spec.md").exists()
        && specflow
            .join("archive")
            .join(&slug)
            .join("spec.md")
            .exists();
    let dir = if archived {
        specflow.join("archive").join(&slug)
    } else {
        live_dir
    };
    if !dir.join("spec.md").exists() {
        return next(
            "NONE",
            format!("specflow/{slug}/spec.md does not exist, live or archived."),
        );
    }
    let spec = read_or_unknown(&dir.join("spec.md"))?;
    let fix = FIX_HEADING.test(&spec);
    let status = STATUS_STAMP
        .exec(&spec)
        .map_or_else(String::new, |m| m.group(1).to_string());
    let (proposal, plan) = (
        dir.join("proposal.md").exists(),
        dir.join("plan.md").exists(),
    );
    let mut milestones: Vec<u64> = list_or_unknown(&dir.join("milestones"))?
        .iter()
        .filter_map(|e| MILESTONE_MD.captures(e)?[1].parse().ok())
        .collect();
    milestones.sort_unstable();
    let n = milestones.len() as u64;
    let head_res = proc::git(&root, &["rev-parse", "--short", "HEAD"]);
    let head = if head_res.ok() {
        head_res.stdout.trim().to_string()
    } else {
        String::new()
    };
    let history = read_or_unknown(&dir_state.join("gate-history.log"))?;
    let on_head: Vec<&str> = history
        .split('\n')
        .map(state::trim)
        .filter(|l| !l.is_empty() && sha_of(l) == head)
        .collect();
    let verdict = on_head
        .last()
        .and_then(|l| RESULT_FIELD.captures(l))
        .map_or_else(String::new, |m| m[1].to_string());
    let st = proc::git(&root, &["status", "--porcelain"]);
    let dirty: Vec<&str> = if st.unstarted {
        Vec::new()
    } else {
        st.stdout
            .split('\n')
            .filter(|l| !l.trim().is_empty() && !STATE_DIR_LINE.is_match(l))
            .collect()
    };
    let started: u64 = if at_slug == slug && M_NUMBER.is_match(at_milestone) {
        at_milestone[1..].parse().unwrap_or(0)
    } else {
        0
    };
    // The time the milestone in flight was started at; its absence is the
    // epoch's zero, before every pass.
    let started_at = if started > 0 {
        std::fs::metadata(dir_state.join("current-milestone"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(f64::NEG_INFINITY, |d| d.as_secs_f64() * 1000.0)
    } else {
        f64::NEG_INFINITY
    };
    let passed_since = on_head
        .iter()
        .any(|l| l.contains(" result=pass ") && line_at(l).is_some_and(|t| t >= started_at));

    let kind = if fix {
        "a /spec-fix brief"
    } else {
        "a /spec-flow change"
    };
    let arch = if archived { ", archived" } else { "" };
    say(format!("change: {slug} — {kind}{arch}"));
    let yes = |b: bool| if b { "yes" } else { "no" };
    let st = if status.is_empty() {
        String::new()
    } else {
        format!(" (Status: {status})")
    };
    let ms = if milestones.is_empty() {
        "none".into()
    } else {
        milestones
            .iter()
            .map(|m| format!("M{m}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    say(format!(
        "  spec.md: yes{st} · proposal.md: {} · plan.md: {} · milestones: {ms}",
        yes(proposal),
        yes(plan)
    ));
    let ph = if phase.is_empty() { "(none)" } else { &phase };
    let in_flight = if started > 0 {
        format!("M{started}")
    } else {
        "none recorded".into()
    };
    say(format!("  phase: {ph} · milestone in flight: {in_flight}"));
    let h = if head.is_empty() { "?" } else { &head };
    let v = if verdict.is_empty() {
        "not judged by the gate".into()
    } else {
        format!("gate {verdict}")
    };
    let tree = if dirty.is_empty() {
        "clean".into()
    } else {
        format!("dirty ({} path(s))", dirty.len())
    };
    say(format!("  HEAD {h}: {v} · tree: {tree}"));

    if archived {
        let s = if status.is_empty() { "none" } else { &status };
        return next(
            "DONE",
            format!(
                "the fold archived specflow/{slug}/ (Status: {s}) and the run never wrote `done`."
            ),
        );
    }
    match status.as_str() {
        "REJECTED" => {
            return next(
                "ARCHIVE-REJECTED",
                "the spec is stamped REJECTED and still live; the rejection was never archived."
                    .into(),
            );
        }
        "SHIPPED" => {
            return next(
                "FOLD",
                "the change spec is stamped SHIPPED but was never archived; finish the fold."
                    .into(),
            );
        }
        _ => {}
    }
    if !fix && !proposal {
        return next("SPEC", "spec.md exists without proposal.md, so the spec step never finished; the requirement has to come from the human again.".into());
    }
    if !plan || (fix && started == 0) {
        let unready = time::problems(&root, std::slice::from_ref(&slug), true);
        let (step, mut why) = if fix {
            let why = if plan && n > 0 {
                "the triage wrote the brief and its work order, and no implementer was ever spawned for it; a case 3 is confirmed by the human again, since nothing on disk records it."
            } else {
                "the triage brief is written and no work order exists yet, so a new triage writes it."
            };
            ("WORK-ORDER", why.to_string())
        } else {
            ("SIGN-OFF", "the spec is written and no plan exists: the human sign-off is the step no file records, so it is asked for again.".to_string())
        };
        if !unready.is_empty() {
            why += &format!(
                " The spec is not ready to build from, so a new spec-writer revises it first: {}",
                unready.join(" ")
            );
        }
        return next(step, why);
    }
    if started == 0 {
        return next("REVIEW", "the plan exists and no milestone was ever started; its review is not on disk, so it runs again.".into());
    }
    if passed_since {
        if started < n {
            return next(
                &format!("IMPLEMENT M{}", started + 1),
                format!(
                    "M{started} passed the gate on {head}; M{} is next.",
                    started + 1
                ),
            );
        }
        return next(
            "FOLD",
            format!("M{started}, the last milestone, passed the gate on {head}."),
        );
    }
    let why = if !dirty.is_empty() {
        format!(
            "M{started} was in flight and never passed; the tree holds {} uncommitted path(s) from the session that died.",
            dirty.len()
        )
    } else if verdict.starts_with("fail") {
        format!("M{started} failed the gate on {head}; .claude/state/gate-failure.log says why.")
    } else {
        format!("M{started} was in flight and has no pass on {head}.")
    };
    next(&format!("IMPLEMENT M{started}"), why)
}

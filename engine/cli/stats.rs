//! `spec-flow stats`: the telemetry a run leaves, and what it says. It NEVER
//! fails and gates nothing: the change policy refuses a proposal with no
//! failing run attached, and what was missing was evidence, not a rule.

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::cli::run_state::{line_at, read_lines};
use crate::jsre::Re;
use crate::repo::contract;
use crate::state;
use crate::tracelines::{self, Entry};

/// The orchestrator schedules its post-PASS check-in about two minutes out,
/// so ten is well past "slow" and into "nothing is coming".
const STALL_MINUTES: i64 = 10;

struct RunLog {
    name: String,
    gate: Vec<Entry>,
    trace: Vec<Entry>,
    raw_gate: Vec<String>,
    raw_trace: Vec<String>,
}

impl RunLog {
    fn new(name: &str) -> RunLog {
        RunLog {
            name: name.into(),
            gate: Vec::new(),
            trace: Vec::new(),
            raw_gate: Vec::new(),
            raw_trace: Vec::new(),
        }
    }
}

static SESSION_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" session=([^\t\n\x0C\r ]+)").unwrap());
static CLOSED_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r" closed tool=").unwrap());

/// Keys in first-seen order, as a JavaScript object keeps them.
#[derive(Default)]
struct Counter {
    order: Vec<String>,
    n: HashMap<String, i64>,
}

impl Counter {
    fn add(&mut self, k: &str, by: i64) {
        if !self.n.contains_key(k) {
            self.order.push(k.into());
        }
        *self.n.entry(k.into()).or_default() += by;
    }

    fn get(&self, k: &str) -> i64 {
        self.n.get(k).copied().unwrap_or(0)
    }

    fn join(&self, f: impl Fn(&str, i64) -> String) -> String {
        self.order
            .iter()
            .map(|k| f(k, self.n[k]))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// The keys by count, highest first, ties in first-seen order.
    fn ranked(&self) -> Vec<String> {
        let mut keys = self.order.clone();
        keys.sort_by(|a, b| self.n[b].cmp(&self.n[a]));
        keys
    }
}

fn undefined<'a>(e: &'a Entry, k: &str) -> &'a str {
    e.get(k).unwrap_or("undefined")
}

/// One entry per run: the live one first, then every archived snapshot. A
/// snapshot is a slice of the live log, so a run taken on this machine is in
/// both, and counting both doubles every total with no symptom. The archived
/// tier wins the tie: it carries the run's slug.
fn collect_runs(root: &Path, dir: &Path) -> Vec<RunLog> {
    let mut archived: Vec<RunLog> = Vec::new();
    for base in [root.join("specflow").join("archive"), root.join("specflow")] {
        let mut names: Vec<String> = std::fs::read_dir(&base)
            .map(|es| {
                es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        for name in names.into_iter().filter(|n| n != "archive") {
            let t = base.join(&name).join("telemetry");
            if t.exists() {
                let mut r = RunLog::new(&name);
                r.raw_gate = read_lines(&t.join("gate-history.log"));
                r.raw_trace = read_lines(&t.join("run-trace.log"));
                archived.push(r);
            }
        }
    }
    // Trimmed, so a snapshot committed with CRLF matches the log it came from.
    let seen: std::collections::HashSet<String> = archived
        .iter()
        .flat_map(|r| r.raw_gate.iter().chain(&r.raw_trace).cloned())
        .collect();
    let mut live = RunLog::new("(current)");
    live.raw_gate = read_lines(&dir.join("gate-history.log"))
        .into_iter()
        .filter(|l| !seen.contains(l))
        .collect();
    // The closing turn's tokens land after the snapshot (ADR-043): each goes
    // to the archived run whose `closed` line names its session, the latest
    // before it.
    let closes: Vec<(usize, f64, String)> = archived
        .iter()
        .enumerate()
        .flat_map(|(i, r)| {
            r.raw_trace
                .iter()
                .filter(|l| CLOSED_LINE.is_match(l))
                .filter_map(move |l| {
                    let at = line_at(l)?;
                    let s = SESSION_FIELD
                        .captures(l)
                        .map_or_else(String::new, |m| m[1].to_string());
                    Some((i, at, s))
                })
        })
        .collect();
    for l in read_lines(&dir.join("run-trace.log")) {
        if seen.contains(&l) {
            continue;
        }
        if l.contains(" phase=done ") && l.contains(" tokens model=") {
            let at = line_at(&l);
            let s = SESSION_FIELD
                .captures(&l)
                .map_or_else(String::new, |m| m[1].to_string());
            let owner = closes
                .iter()
                .filter(|(_, c_at, c_s)| {
                    at.is_some_and(|a| !c_s.is_empty() && *c_s == s && *c_at <= a)
                })
                .fold(None::<&(usize, f64, String)>, |best, c| match best {
                    Some(b) if c.1 <= b.1 => Some(b),
                    _ => Some(c),
                });
            if let Some((i, _, _)) = owner {
                let i = *i;
                archived[i].raw_trace.push(l);
                continue;
            }
        }
        live.raw_trace.push(l);
    }
    let mut runs = Vec::new();
    for mut r in std::iter::once(live).chain(archived) {
        r.gate = r.raw_gate.iter().map(|l| tracelines::parse(l)).collect();
        r.trace = r
            .raw_trace
            .iter()
            .map(|l| {
                let mut e = tracelines::parse(l);
                if let Some(t) = e.get("type").map(String::from) {
                    e.fields.insert("type".into(), tracelines::role_of(&t));
                }
                e
            })
            .collect();
        if r.name == "(current)" || !r.gate.is_empty() || !r.trace.is_empty() {
            runs.push(r);
        }
    }
    runs
}

/// This flow's agent put to work with no run phase (ADR-040): on its own it is
/// no run, nor is the closing turn's tokens (ADR-043).
fn outside_run(e: &Entry) -> bool {
    e.raw.contains(" dispatch ") && e.f("why") == "no-run"
}

fn after_close(e: &Entry) -> bool {
    outside_run(e) || e.f("phase") == "done"
}

fn minutes_between(a: f64, b: f64) -> i64 {
    ((b - a) / 60000.0).round() as i64
}

fn iso_ms(ms: f64) -> String {
    state::iso(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0.0) as u64))
}

const NOT_A_FAILED_RUN: [&str; 3] = ["not-the-runner", "not-found", "summary-passed"];

static BACKSLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\+").unwrap());
static TOKEN_EDGES: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[(`]+|[;&|)`]+$").unwrap());
static DOT_SLASHES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(\.\.?/)+").unwrap());
static GIT_BASH_DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^/([a-z])/").unwrap());
static REDIR_TOK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[<>]|^[0-9]+>").unwrap());
static GLOB_CHARS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[*?\[\]{}]").unwrap());
static WIN_DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z]:").unwrap());
static PROOF_DIR_TRIM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\./?|/$").unwrap());
static EXT_OF_GLOB: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\*(\.[^*/]+)$").unwrap());

struct ProofLayout {
    suffix: String,
    dir: String,
}

/// What a run's `target=` says about `test`: "true" when a path in it names
/// the test or a directory above it from a segment start; "false" only when
/// it names other tests outright; otherwise why it cannot say. A MISS claims
/// no red run happened, so nothing short of other tests named reads as "ran
/// something else".
fn run_covers(target: &str, test: &str, proof: &ProofLayout) -> String {
    let windows = WIN_DRIVE.is_match(test);
    let norm = |p: &str| BACKSLASHES.replace_all(p, "/").to_lowercase();
    let target = if target.is_empty() { "-" } else { target };
    let mut tokens: Vec<String> = Vec::new();
    for t in target.split(',') {
        let t = TOKEN_EDGES.replace_all(&norm(t), "").into_owned();
        let t = DOT_SLASHES.replace_all(&t, "").into_owned();
        let mut t = t.strip_suffix('/').unwrap_or(&t).to_string();
        if windows {
            t = GIT_BASH_DRIVE.replace_all(&t, "$1:/").into_owned();
        }
        if !t.is_empty() && t != "-" && t != "." && !REDIR_TOK.is_match(&t) {
            tokens.push(t);
        }
    }
    if tokens.is_empty() {
        return "no-path".into();
    }
    if tokens.iter().any(|t| GLOB_CHARS.is_match(t)) {
        return "glob".into();
    }
    let path = format!("/{}", norm(test));
    if tokens
        .iter()
        .any(|t| path.contains(&format!("/{}", t.trim_start_matches('/'))))
    {
        return "true".into();
    }
    if tokens
        .iter()
        .any(|t| path.contains(t.trim_start_matches('/')))
    {
        return "pattern".into();
    }
    let dir = PROOF_DIR_TRIM
        .replace_all(&norm(&proof.dir), "")
        .into_owned();
    if tokens.iter().any(|t| {
        (!proof.suffix.is_empty() && t.ends_with(&proof.suffix.to_lowercase()))
            || (!dir.is_empty() && format!("{t}/").starts_with(&format!("{dir}/")))
    }) {
        return "false".into();
    }
    "no-test-path".into()
}

static PATH_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/]").unwrap());

fn base_of(p: &str) -> &str {
    PATH_SEP.split(p).last().unwrap_or(p)
}

static REQ_ID: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"(?<![A-Z0-9])REQ-([A-Z0-9-]+)-\d{3}(?!\d)", ""));
static SCOPE_MARK: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^<!--\s*spec-scope:\s*(.+?)\s*-->$", "m"));
static FILES_FIELD: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        r"(?:^|\n)[-*][ \t]*\**Files to add\/change\**[ \t]*:([\s\S]*?)(?=\n[-*][ \t]*\**[A-Z][^:\n]*\**[ \t]*:|\n#|$)",
        "",
    )
});
static NAMED_PATH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9A-Za-z_.@-]+(?:/[0-9A-Za-z_.@-]+)+/?").unwrap());
static H2_SPLIT: LazyLock<Re> = LazyLock::new(|| Re::new(r"^## ", "m"));
static DELTAS_START: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^Requirement deltas").unwrap());
static ARCHIVE_READ: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"specflow[\\/]archive").unwrap());
static ABS_OR_DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([a-zA-Z]:)?/").unwrap());

fn norm_path(p: &str) -> String {
    let p = p.replace('\\', "/");
    let p = p.strip_prefix("./").unwrap_or(&p);
    p.trim_end_matches('/').to_string()
}

/// A field's number, 0 where it is none.
fn num_field(s: &str) -> f64 {
    s.trim()
        .parse::<f64>()
        .ok()
        .filter(|f| f.is_finite())
        .unwrap_or(0.0)
}

pub fn stats(args: &[String]) -> i32 {
    let root = state::project_dir();
    let dir = root.join(".claude").join("state");
    let raw_dump = args.iter().any(|a| a == "--raw");
    let mut warn: Vec<String> = Vec::new();
    let mut out = String::new();
    macro_rules! say {
        ($($t:tt)*) => {{
            out.push_str(&format!($($t)*));
            out.push('\n');
        }};
    }

    let phase = if dir.join("phase").exists() {
        state::read_file_or_default(&dir.join("phase"), "")
    } else {
        "(none)".into()
    };
    say!("spec-flow stats — report only, nothing here gates anything");
    say!("current phase: {phase}\n");

    // ---- 1. the gate, and whether a PASS stranded the run --------------------
    let runs = collect_runs(&root, &dir);
    let current = &runs[0];
    let gate: Vec<&Entry> = runs.iter().flat_map(|r| &r.gate).collect();
    let activity =
        |r: &RunLog| -> Vec<f64> { r.gate.iter().chain(&r.trace).filter_map(|e| e.at).collect() };
    say!("Gate");
    if gate.is_empty() {
        say!("  no gate history yet — run /spec-flow at least once.");
    } else {
        let mut tally = Counter::default();
        for g in &gate {
            tally.add(undefined(g, "result"), 1);
        }
        let with_data = runs
            .iter()
            .filter(|r| !r.gate.is_empty() || r.trace.iter().any(|e| !after_close(e)))
            .count();
        let scope = if with_data > 1 {
            format!(" across {with_data} run(s)")
        } else {
            String::new()
        };
        say!(
            "  {} invocation(s){scope}: {}",
            gate.len(),
            tally.join(|k, n| format!("{n} {k}"))
        );
        // A PASS with no failure since the previous PASS: a stretch between two
        // passes stands in for a milestone. Every failing outcome counts — the
        // gate writes `fail:<class>`.
        let (mut passes, mut first_time) = (0, 0);
        for r in &runs {
            let mut failed = false;
            for g in &r.gate {
                if g.f("result").starts_with("fail") {
                    failed = true;
                }
                if g.f("result") != "pass" {
                    continue;
                }
                passes += 1;
                if !failed {
                    first_time += 1;
                }
                failed = false;
            }
        }
        if passes > 0 {
            say!(
                "  passed the first time: {first_time} of {passes} PASS(es) had no failure since the previous one"
            );
        }
        // A stalled run is a PASS followed by nothing, in EITHER log.
        let mut worst: Option<(i64, f64, String)> = None;
        for r in &runs {
            let mut times = activity(r);
            times.sort_by(|a, b| a.partial_cmp(b).unwrap());
            for g in &r.gate {
                let (true, Some(at)) = (g.f("result") == "pass", g.at) else {
                    continue;
                };
                if let Some(t) = times.iter().find(|t| **t > at) {
                    let gap = minutes_between(at, *t);
                    if worst.as_ref().is_none_or(|w| gap > w.0) {
                        worst = Some((gap, at, r.name.clone()));
                    }
                }
            }
        }
        if let Some((gap, at, name)) = &worst {
            let place = if runs.len() > 1 {
                format!(" in {name}")
            } else {
                String::new()
            };
            say!(
                "  longest quiet after a PASS: {gap}m{place} ({})",
                iso_ms(*at)
            );
            if *gap >= STALL_MINUTES {
                warn.push(format!("a PASS was followed by {gap}m with nothing running{place} — the run had to be nudged."));
            }
        }
        if let Some(last) = current.gate.last()
            && last.f("result") == "pass"
            && phase == "implement"
            && let Some(at) = last.at
        {
            let latest = activity(current).into_iter().fold(at, f64::max);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            let idle = minutes_between(latest, now);
            say!("  last gate line is a PASS, phase still `implement`, {idle}m since anything ran");
            if idle >= STALL_MINUTES {
                warn.push(format!("the run looks stalled RIGHT NOW: {idle}m with nothing running since a PASS, phase still armed. Nothing re-wakes the orchestrator on a pass."));
            }
        }
    }
    say!("");

    // ---- 2. test-first, by its observable signature --------------------------
    // The pairing reads the contract — proof_suffix and the source extensions
    // — and pairs on BASENAME: a test need not sit beside its source. An
    // unreadable contract makes it UNKNOWN, said out loud, not an absence.
    let trace: Vec<&Entry> = runs.iter().flat_map(|r| &r.trace).collect();
    let mut pairing_problem = String::new();
    let mut proof = ProofLayout {
        suffix: String::new(),
        dir: String::new(),
    };
    let mut pairing: Option<(String, Vec<String>)> = None;
    match contract::load(&root) {
        Ok(cfg) => {
            let suffix = cfg.trace.proof_suffix.clone();
            proof = ProofLayout {
                suffix: suffix.clone(),
                dir: cfg.trace.proof_dir.clone(),
            };
            let mut exts: Vec<String> = Vec::new();
            for g in &cfg.verify.scope_globs {
                // `lib/*.ts` names `.ts` as `*.ts` does.
                let ext = EXT_OF_GLOB.captures(g).map_or_else(
                    || g.strip_prefix('*').unwrap_or(g).to_string(),
                    |m| m[1].to_string(),
                );
                if ext.starts_with('.') && !exts.contains(&ext) {
                    exts.push(ext);
                }
            }
            if suffix.is_empty() || exts.is_empty() {
                pairing_problem = "the contract names no proof_suffix or no source extension, so a source file cannot be paired to its test".into();
            } else {
                pairing = Some((suffix, exts));
            }
        }
        Err(e) => {
            pairing_problem = format!(
                "the contract could not be read ({})",
                e.split('\n').next().unwrap_or_default()
            );
        }
    }
    let expected_test_name = |file: &str| -> String {
        let Some((suffix, exts)) = &pairing else {
            return String::new();
        };
        let name = base_of(file);
        if name.ends_with(suffix.as_str()) {
            return String::new(); // this IS a test file
        }
        exts.iter()
            .find(|e| name.ends_with(e.as_str()))
            .map_or_else(String::new, |e| {
                format!("{}{suffix}", &name[..name.len() - e.len()])
            })
    };

    struct Verdict {
        file: String,
        status: &'static str,
        why: String,
        run: String,
    }
    let mut verdicts: Vec<Verdict> = Vec::new();
    if pairing.is_some() {
        for r in &runs {
            let mut order: Vec<String> = Vec::new();
            let mut first_write: HashMap<String, usize> = HashMap::new();
            let mut writes: HashMap<String, Vec<usize>> = HashMap::new();
            for (i, e) in r.trace.iter().enumerate() {
                // A READ says nothing about when a file was written.
                if e.f("file").is_empty() || !e.raw.contains(" write file=") {
                    continue;
                }
                let f = e.f("file").to_string();
                writes.entry(f.clone()).or_default().push(i);
                if !first_write.contains_key(&f) {
                    first_write.insert(f.clone(), i);
                    order.push(f);
                }
            }
            let mut tests_by_name: HashMap<String, Vec<(String, usize)>> = HashMap::new();
            for f in &order {
                tests_by_name
                    .entry(base_of(f).to_string())
                    .or_default()
                    .push((f.clone(), first_write[f]));
            }
            for file in &order {
                let source_idx = first_write[file];
                let test_name = expected_test_name(file);
                if test_name.is_empty() {
                    continue;
                }
                let Some(tests) = tests_by_name.get(&test_name) else {
                    continue;
                };
                let spec_idx = tests.iter().map(|t| t.1).min().unwrap_or(0);
                // Only a run of this test speaks for it.
                let covers_at = |target: &str, at: usize| -> String {
                    let mut reason = String::new();
                    for (tf, t_at) in tests {
                        if *t_at >= at {
                            continue;
                        }
                        let a = run_covers(target, tf, &proof);
                        if a == "true" {
                            return a;
                        }
                        if a != "false" && reason.is_empty() {
                            reason = a;
                        }
                    }
                    if reason.is_empty() {
                        "false".into()
                    } else {
                        reason
                    }
                };
                // Before the code is before the source's last write ahead of
                // its first PASS: a stub is written so the test loads, its red
                // run follows, and then the code (ADR-053).
                let pass_at = r.trace[source_idx].at.and_then(|at| {
                    r.gate
                        .iter()
                        .find(|g| g.f("result") == "pass" && g.at.is_some_and(|ga| ga > at))?
                        .at
                });
                let mut until = source_idx;
                for &i in &writes[file] {
                    let at = r.trace[i].at;
                    if pass_at.is_none() || at.is_some_and(|a| pass_at.is_some_and(|p| a <= p)) {
                        until = until.max(i);
                    }
                }
                let between: Vec<(&Entry, String)> = r
                    .trace
                    .iter()
                    .enumerate()
                    .filter(|(i, e)| *i > spec_idx && *i < until && !e.f("verdict").is_empty())
                    .map(|(i, e)| (e, covers_at(e.f("target"), i)))
                    .filter(|(_, c)| c != "false")
                    .collect();
                let (mut red, mut unloaded) = (false, false);
                let mut whys: Vec<String> = Vec::new();
                let mut unjudged = 0;
                for (e, covers) in &between {
                    let v = e.f("verdict");
                    let why = e.get("why");
                    if (v == "?" && !why.is_some_and(|w| NOT_A_FAILED_RUN.contains(&w)))
                        || (v == "red" && covers != "true")
                    {
                        unjudged += 1;
                        let w = if v == "red" {
                            covers.clone()
                        } else {
                            why.unwrap_or("not-recorded").to_string()
                        };
                        if !whys.contains(&w) {
                            whys.push(w);
                        }
                    }
                    if v == "red" && covers == "true" {
                        red = true;
                    }
                    // Its file did not load: none of its tests ran, red or not
                    // (ADR-053).
                    if v == "absent" && covers == "true" {
                        unloaded = true;
                    }
                }
                let status = if spec_idx > source_idx {
                    "code-first"
                } else if red {
                    "red-first"
                } else if unjudged > 0 {
                    "no-verdict"
                } else if unloaded {
                    "did-not-load"
                } else {
                    "no-red-run"
                };
                verdicts.push(Verdict {
                    file: file.clone(),
                    status,
                    why: whys.join(","),
                    run: r.name.clone(),
                });
            }
        }
    }
    say!("Test-first");
    if pairing.is_none() {
        say!("  UNKNOWN — {pairing_problem}.");
        say!(
            "  This is not \"no misses found\": nothing was measured. Fix the contract to get an answer."
        );
    } else if trace.is_empty() {
        say!("  no run trace yet — run-trace writes it during a live run.");
    } else if verdicts.is_empty() {
        say!("  no source file was written alongside its own test in this trace.");
    } else {
        let mut across: Vec<&str> = Vec::new();
        let (mut missed, mut unjudged, mut unloaded) = (0, 0, 0);
        for v in &verdicts {
            let mark = match v.status {
                "red-first" => "OK  ",
                "no-verdict" => "?   ",
                _ => "MISS",
            };
            let place = if runs.len() > 1 {
                format!("  [{}]", v.run)
            } else {
                String::new()
            };
            let what = if v.status == "no-verdict" {
                format!("a test run the trace could not judge: {}", v.why)
            } else {
                v.status.into()
            };
            say!("  {mark} {}  ({what}){place}", v.file);
            if !across.contains(&v.run.as_str()) {
                across.push(&v.run);
            }
            match v.status {
                "code-first" | "no-red-run" => missed += 1,
                "no-verdict" => unjudged += 1,
                "did-not-load" => unloaded += 1,
                _ => {}
            }
        }
        let scope = if across.len() > 1 {
            format!(" across {} runs", across.len())
        } else {
            String::new()
        };
        let n = verdicts.len();
        if missed > 0 {
            warn.push(format!("{missed} of {n} source file(s){scope} show no red test run before the code. A test written after the implementation mirrors it and passes on day one."));
        }
        if unloaded > 0 {
            warn.push(format!("{unloaded} of {n} source file(s){scope} had their test run before the code only while the test file could not load (verdict=absent in run-trace.log): no test in it ran, so none was seen to fail."));
        }
        if unjudged > 0 {
            warn.push(format!("{unjudged} of {n} source file(s){scope} had their test run before the code, with a verdict the trace could not read (why= in run-trace.log) — unmeasured, not missed."));
        }
    }
    say!("");

    // ---- 3. the reviewer, and whether it reviews -----------------------------
    let agent_lines: Vec<&&Entry> = trace
        .iter()
        .filter(|e| !e.f("type").is_empty() && !e.f("status").is_empty())
        .collect();
    say!("Agents");
    if agent_lines.is_empty() {
        say!("  no subagent outcomes recorded yet.");
    } else {
        let mut types: Vec<String> = Vec::new();
        let mut by_agent: HashMap<String, Counter> = HashMap::new();
        for a in &agent_lines {
            let t = a.f("type").to_string();
            if !by_agent.contains_key(&t) {
                types.push(t.clone());
            }
            by_agent.entry(t).or_default().add(a.f("status"), 1);
        }
        for t in &types {
            say!("  {t}: {}", by_agent[t].join(|k, n| format!("{n} {k}")));
        }
        if let Some(rv) = by_agent.get("reviewer") {
            let total: i64 = rv.n.values().sum();
            if total >= 3 && rv.get("APPROVED") == total {
                warn.push(format!("the reviewer approved all {total} plan(s) it saw, never escalating. Either the planner is that good or the step is a rubber-stamp — worth deciding once the sample is big enough."));
            }
        }
    }
    // A return the agent gate sent back is counted under the status it was
    // sent back with; these lines say how often that happens (ADR-031).
    let checks: Vec<&&Entry> = trace
        .iter()
        .filter(|e| e.raw.contains(" agent-check "))
        .collect();
    if !checks.is_empty() {
        let tally = |result: &str| {
            let mut c = Counter::default();
            let mut n = 0;
            for e in checks.iter().filter(|e| e.f("result") == result) {
                c.add(undefined(e, "why"), 1);
                n += 1;
            }
            (n, c.join(|k, n| format!("{k} x{n}")))
        };
        let (sent, sent_t) = tally("block");
        let (capped, capped_t) = tally("cap");
        let (skipped, skipped_t) = tally("skip");
        let mut line = format!("  agent gate: {sent} return(s) sent back");
        if sent > 0 {
            line += &format!(" ({sent_t})");
        }
        line += &format!(", {capped} let through at the cap");
        if capped > 0 {
            line += &format!(" ({capped_t})");
        }
        if skipped > 0 {
            line += &format!(", {skipped} not fully judged ({skipped_t})");
        }
        say!("{line}.");
    }
    // What the orchestrator dispatched that the commands do not describe
    // (ADR-035).
    let dispatched: Vec<&&Entry> = trace
        .iter()
        .filter(|e| e.raw.contains(" dispatch "))
        .collect();
    if !dispatched.is_empty() {
        let tally_of = |list: &[&&&Entry]| {
            let mut c = Counter::default();
            for e in list {
                for why in undefined(e, "why").split(',') {
                    c.add(&format!("{}:{why}", undefined(e, "agent")), 1);
                }
            }
            c.join(|k, n| format!("{k} x{n}"))
        };
        let (mut recorded, mut armed, mut denied, mut outside) =
            (Vec::new(), 0, Vec::new(), Vec::new());
        for e in &dispatched {
            match e.f("result") {
                "record" if outside_run(e) => outside.push(e),
                "record" => recorded.push(e),
                "armed" => armed += 1,
                "deny" => denied.push(e),
                _ => {}
            }
        }
        let mut line = format!("  dispatch: {} off the commands' contract", recorded.len());
        if !recorded.is_empty() {
            line += &format!(" ({})", tally_of(&recorded));
        }
        line += &format!(", recorded, not denied; the gate armed by arm-gate {armed} time(s)");
        if !denied.is_empty() {
            line += &format!(
                ", the implementer denied {} time(s) ({})",
                denied.len(),
                tally_of(&denied)
            );
        }
        say!("{line}.");
        if !outside.is_empty() {
            say!(
                "  outside a run: {} of this flow's agent(s) put to work ({}), with no budget, trace or agent gate.",
                outside.len(),
                tally_of(&outside)
            );
        }
        if !recorded.is_empty() {
            warn.push(format!("{} dispatch(es) the commands do not describe ({}). Each went through; read the `dispatch` lines with --raw before a rule becomes a denial (ADR-035).", recorded.len(), tally_of(&recorded)));
        }
        // Step 0 writes the phase before either is spawned.
        let unarmed: Vec<&&&Entry> = outside
            .iter()
            .copied()
            .filter(|e| matches!(e.f("agent"), "spec-writer" | "planner"))
            .collect();
        if !unarmed.is_empty() {
            warn.push(format!("{} spec-writer or planner spawn(s) with no run phase ({}): no budget, trace or agent gate applied to them. A run that skipped writing `spec`, or whose phase was reset under it, looks like this (ADR-040).", unarmed.len(), tally_of(&unarmed)));
        }
    }
    say!("");

    // ---- 3b. does the plan's skill routing actually land? --------------------
    let mut misses = Counter::default();
    let mut n_misses = 0;
    for e in &trace {
        let v = e.f("skill_miss");
        if !v.is_empty() {
            for m in v.split(',') {
                misses.add(m, 1);
                n_misses += 1;
            }
        }
    }
    say!("Skill routing");
    if agent_lines.is_empty() {
        say!("  no subagent outcomes recorded yet.");
    } else if n_misses == 0 {
        say!(
            "  no misses reported across {} subagent return(s).",
            agent_lines.len()
        );
    } else {
        let ranked = misses.ranked();
        let parts: Vec<String> = ranked
            .iter()
            .map(|m| format!("{m} x{}", misses.get(m)))
            .collect();
        say!("  {n_misses} miss(es): {}", parts.join(", "));
        let top = &ranked[0];
        if misses.get(top) >= 3 {
            warn.push(format!("\"{top}\" was needed but not routed {} times. A skill the planner keeps missing usually has a description that does not match the decision it actually applies to — the description is what the planner routes on.", misses.get(top)));
        }
    }
    say!("");

    // ---- 4. what the run READ, against the change's scope ---------------------
    // The scope is derived, never guessed: a change whose spec and milestones
    // name nothing readable reports UNKNOWN rather than zero (ADR-026).
    let reads: Vec<&&Entry> = trace
        .iter()
        .filter(|e| e.raw.contains(" read file="))
        .collect();
    let root_norm = norm_path(&root.to_string_lossy());
    let phase_of = |e: &Entry| e.get("phase").unwrap_or("?").to_string();
    say!("Reads");
    if reads.is_empty() {
        say!("  no reads recorded — run-trace logs these only during a live run.");
    } else {
        let mut by_phase = Counter::default();
        for r in &reads {
            by_phase.add(&phase_of(r), 1);
        }
        say!(
            "  {} file read(s): {}",
            reads.len(),
            by_phase.join(|k, n| format!("{n} in {k}"))
        );
        let archive_reads = reads
            .iter()
            .filter(|r| ARCHIVE_READ.is_match(&r.raw))
            .count();
        let in_plan = reads
            .iter()
            .filter(|r| ARCHIVE_READ.is_match(&r.raw) && r.f("phase") == "plan")
            .count();
        if archive_reads > 0 {
            let during = if in_plan > 0 {
                format!(" ({in_plan} while planning)")
            } else {
                String::new()
            };
            say!("  {archive_reads} of them under specflow/archive/{during}");
            if in_plan > 0 {
                warn.push(format!("{in_plan} archived change spec(s) were read during the plan phase. The planner's contract keeps the archive out of a plan (ADR-026): a past change describes one problem's shape, and what generalised from past runs is in the contracts. Worth reading the plan for what it took from there."));
            }
        }
        let (specs_dir, proof_dir) = contract::load(&root)
            .map(|c| (c.trace.specs_dir, c.trace.proof_dir))
            .unwrap_or_else(|_| ("specs".into(), String::new()));
        let always_in: Vec<String> = [
            specs_dir.as_str(),
            &proof_dir,
            "specflow",
            ".spec-flow",
            ".claude",
            "CLAUDE.md",
        ]
        .iter()
        .filter(|d| !d.is_empty())
        .map(|d| norm_path(d))
        .collect();
        for r in &runs {
            let run_reads: Vec<&Entry> = r
                .trace
                .iter()
                .filter(|e| e.raw.contains(" read file=") && !e.f("file").is_empty())
                .collect();
            if run_reads.is_empty() {
                continue;
            }
            let label = if runs.len() > 1 {
                format!("{}: ", r.name)
            } else {
                String::new()
            };
            let change = change_dir(&root, &r.name);
            let (dirs, from) = match &change {
                Some(d) => change_scope(&root, d, &specs_dir),
                None => (Vec::new(), Vec::new()),
            };
            if dirs.is_empty() {
                let why = if change.is_some() {
                    "its spec names no scoped capability and its milestones name no path"
                } else {
                    "no change folder under specflow/ names this run"
                };
                say!(
                    "  {label}scope UNKNOWN — {why}, so nothing here says which reads were outside it."
                );
                continue;
            }
            say!(
                "  {label}scope {} (from {})",
                dirs.join(", "),
                from.join(", ")
            );
            let scope_dirs: Vec<&String> = always_in.iter().chain(&dirs).collect();
            let in_scope = |rel: &str| {
                scope_dirs
                    .iter()
                    .any(|d| rel == d.as_str() || rel.starts_with(&format!("{d}/")))
            };
            let recorded = recorded_root(r);
            let mut phases: Vec<String> = Vec::new();
            for e in &run_reads {
                let p = phase_of(e);
                if !phases.contains(&p) {
                    phases.push(p);
                }
            }
            for ph in &phases {
                let mut outside = Counter::default();
                let (mut inside, mut total) = (0i64, 0i64);
                for e in run_reads.iter().filter(|e| phase_of(e) == *ph) {
                    total += 1;
                    let rel = inside_repo(e.f("file"), &root_norm, &recorded);
                    if let Some(rel) = &rel
                        && in_scope(rel)
                    {
                        inside += 1;
                        continue;
                    }
                    // Two segments deep — the module, in most layouts.
                    let key = match &rel {
                        Some(rel) => rel.split('/').take(2).collect::<Vec<_>>().join("/"),
                        None => "(outside the repository)".into(),
                    };
                    outside.add(&key, 1);
                }
                let ranked = outside.ranked();
                let place = if ranked.is_empty() {
                    String::new()
                } else {
                    let parts: Vec<String> = ranked
                        .iter()
                        .take(5)
                        .map(|d| format!("{d} x{}", outside.get(d)))
                        .collect();
                    format!(" — {}", parts.join(", "))
                };
                let out_n = total - inside;
                say!("    {ph}: {total} read(s), {out_n} outside the scope{place}");
                if ph == "plan" && out_n > inside {
                    let in_run = if runs.len() > 1 {
                        format!("in {} ", r.name)
                    } else {
                        String::new()
                    };
                    warn.push(format!("{in_run}the planner read more outside the change's scope ({out_n}) than inside it ({inside}){place}. That is a planner learning how this repo builds a module from its source. A repo that states its anatomy — a skill, or a CLAUDE.md section — is what makes those reads unnecessary, and the planner's contract sends it there first (ADR-026)."));
                }
            }
        }
    }
    say!("");

    // ---- 5. session reuse ------------------------------------------------------
    // A milestone is what happened between two gate PASSes. A fresh session
    // re-reads what the previous one already had (ADR-025). Two proxies, said
    // so.
    let reader_of = |e: &Entry| -> String {
        let id = e.f("agent_id");
        if id.is_empty() {
            e.f("session").to_string()
        } else {
            format!("agent:{id}")
        }
    };
    struct Segment<'a> {
        closed: bool,
        events: Vec<&'a Entry>,
        run: String,
        index: usize,
    }
    let mut segments: Vec<Segment> = Vec::new();
    for r in &runs {
        let passes: Vec<f64> = r
            .gate
            .iter()
            .filter(|g| g.f("result") == "pass")
            .filter_map(|g| g.at)
            .collect();
        let mut events: Vec<&Entry> = r
            .trace
            .iter()
            .filter(|e| e.at.is_some() && !after_close(e))
            .collect();
        events.sort_by(|a, b| a.at.partial_cmp(&b.at).unwrap());
        let mut start: Option<f64> = None;
        let mut idx = 0;
        for end in passes.iter().map(|p| Some(*p)).chain([None]) {
            let within: Vec<&Entry> = events
                .iter()
                .copied()
                .filter(|e| {
                    let at = e.at.unwrap_or_default();
                    start.is_none_or(|s| at > s) && end.is_none_or(|en| at <= en)
                })
                .collect();
            if !within.is_empty() {
                idx += 1;
                segments.push(Segment {
                    closed: end.is_some(),
                    events: within,
                    run: r.name.clone(),
                    index: idx,
                });
            }
            start = end;
        }
    }
    say!("Session reuse");
    if segments.is_empty() {
        say!("  no run trace yet — run-trace writes it during a live run.");
    } else {
        let (mut reread, mut cold_t) = (Counter::default(), Counter::default());
        for s in &segments {
            let implementers = s
                .events
                .iter()
                .filter(|e| e.f("type") == "implementer" && !e.f("status").is_empty())
                .count();
            let mut files: Vec<String> = Vec::new();
            let mut seen: HashMap<String, (i64, Vec<String>)> = HashMap::new();
            for e in &s.events {
                if !e.raw.contains(" read file=") || e.f("file").is_empty() {
                    continue;
                }
                let f = e.f("file").to_string();
                if !seen.contains_key(&f) {
                    files.push(f.clone());
                }
                let v = seen.entry(f).or_default();
                v.0 += 1;
                let who = reader_of(e);
                if !who.is_empty() && !v.1.contains(&who) {
                    v.1.push(who);
                }
            }
            let (mut repeated, mut extra, mut cold) = (0, 0, 0);
            for f in &files {
                let (n, sessions) = &seen[f];
                if *n <= 1 {
                    continue;
                }
                repeated += 1;
                extra += n - 1;
                reread.add(f, n - 1);
                if sessions.len() > 1 {
                    cold += 1;
                    cold_t.add(f, 1);
                }
            }
            let place = if runs.len() > 1 {
                format!("[{}] ", s.run)
            } else {
                String::new()
            };
            let open = if s.closed {
                ""
            } else {
                " (never reached a PASS)"
            };
            let across = if cold > 0 {
                format!(", {cold} across sessions")
            } else {
                String::new()
            };
            let reads_text = if repeated > 0 {
                format!("{repeated} file(s) re-read, {extra} extra read(s){across}")
            } else {
                "no file read twice".into()
            };
            say!(
                "  {place}milestone {}{open}: {implementers} implementer session(s), {reads_text}",
                s.index
            );
            if implementers > 1 {
                let of = if runs.len() > 1 {
                    format!(" of {}", s.run)
                } else {
                    String::new()
                };
                warn.push(format!("milestone {}{of} spawned the implementer {implementers} times. The flow returns to one implementer per milestone while its cache is warm; a new one is right only after the previous went cold — a human's answer, a long gate (ADR-025). Any other re-spawn re-read the plan and every touched file into a cold context, which is most of what a run costs.", s.index));
            }
        }
        let ranked = reread.ranked();
        if !ranked.is_empty() {
            let parts: Vec<String> = ranked
                .iter()
                .take(5)
                .map(|f| format!("{} +{}", base_of(f), reread.get(f)))
                .collect();
            say!("  most re-read: {}", parts.join(", "));
        }
        let ranked = cold_t.ranked();
        if !ranked.is_empty() {
            let parts: Vec<String> = ranked
                .iter()
                .take(5)
                .map(|f| format!("{} x{}", base_of(f), cold_t.get(f)))
                .collect();
            say!("  re-read across sessions: {}", parts.join(", "));
            warn.push(format!("{} file(s) were read by more than one session inside a single milestone. That is the only re-read a cache could remove — a repeat within one session is context the model already had.", cold_t.order.len()));
        }
        // Whether the split measured anything, said out loud: "0 across
        // sessions" over a trace with no session id answers nothing.
        let ids: Vec<String> = reads
            .iter()
            .map(|r| reader_of(r))
            .filter(|id| !id.is_empty())
            .collect();
        let mut distinct = ids.clone();
        distinct.sort();
        distinct.dedup();
        let spawned = agent_lines.len();
        if reads.is_empty() {
        } else if ids.is_empty() {
            say!(
                "  attribution: UNAVAILABLE — no read carries an agent or session id, so \"across sessions\" above measured nothing."
            );
            say!("  Either this trace predates the field or the payloads name no session.");
        } else if distinct.len() == 1 && spawned > 1 {
            say!(
                "  attribution: ONE session id across {spawned} subagent spawn(s) — reads are landing under the spawner."
            );
            warn.push(format!("every read in this trace carries the same session id while {spawned} subagent(s) were spawned. A subagent's reads are being attributed to whoever spawned it, so the across-session split cannot see a fresh session's cold start — treat those numbers as unmeasured, not as zero."));
        } else {
            say!(
                "  attribution: {}/{} read(s) carry an agent or session id, across {} session(s).",
                ids.len(),
                reads.len(),
                distinct.len()
            );
        }
        say!(
            "  Both numbers are proxies: the trace carries no milestone id, so a milestone here is"
        );
        say!("  whatever happened between two gate PASSes.");
    }
    say!("");

    // ---- 6. what the run cost, in the unit the budget does not charge --------
    let token_lines: Vec<Entry> = trace
        .iter()
        .filter(|e| e.get("msgs").is_some() && !e.f("model").is_empty())
        .map(|e| tracelines::parse(&e.raw))
        .collect();
    say!("Tokens");
    if token_lines.is_empty() {
        say!("  no token accounting recorded yet — token-trace writes it at each stop, from");
        say!("  the transcript Claude Code already keeps. A trace older than that hook has none.");
    } else {
        let rows = tracelines::summarize_tokens(&token_lines);
        let width = rows.iter().map(|r| r.model.len()).max().unwrap_or(0);
        for r in &rows {
            say!("  {}", tracelines::token_row(r, width));
        }
        let total = |field: &str, keep: &dyn Fn(&tracelines::Row) -> bool| -> f64 {
            rows.iter().filter(|r| keep(r)).map(|r| r.get(field)).sum()
        };
        let all = |_: &tracelines::Row| true;
        say!(
            "  total: in {}, out {}, cache_read {}, cache_write {}",
            tracelines::human(total("in", &all)),
            tracelines::at_least(total("out", &all)),
            tracelines::human(total("cache_read", &all)),
            tracelines::human(total("cache_write", &all))
        );
        say!("  out and think are floors (≥): some messages never get their final count written.");
        let subagent_out = total("out", &|r| r.chain == "subagent");
        let spawns = agent_lines.len();
        if token_lines.iter().any(|e| !e.f("agent_id").is_empty()) {
            by_role_runs(&runs, &mut out);
        } else if subagent_out > 0.0 && spawns > 0 {
            say!(
                "  subagent output: {} across {spawns} recorded spawn(s) — {}/spawn on average.",
                tracelines::at_least(subagent_out),
                tracelines::at_least((subagent_out / spawns as f64).round())
            );
            say!(
                "  That average is the unit the escalation caps do not charge; it says nothing about which agent."
            );
        } else if subagent_out == 0.0 && spawns > 0 {
            say!("  {spawns} spawn(s) recorded and no subagent tokens with them.");
            warn.push(format!("{spawns} subagent spawn(s) are in this trace and no token line is marked sidechain. Either the spawns predate token-trace reading subagent transcripts, or this build keeps them somewhere other than <session>/subagents/ — treat the per-spawn cost as unmeasured, not as zero."));
        }
    }
    say!("");

    for (file, what) in [
        (
            "run-trace-unmatched.log",
            "subagent returns with no STATUS line",
        ),
        (
            "opus-budget-unmatched.log",
            "SendMessage payloads the budget could not attribute",
        ),
        (
            "register-agent-unmatched.log",
            "Opus spawns whose session id was not found",
        ),
        (
            "token-trace-unmatched.log",
            "stops whose token usage could not be read — a cost of zero here is not a cheap run",
        ),
        (
            "orchestrator-scope-unmatched.log",
            "session calls orchestrator-scope let through because the trace showed no agent_id — it was not armed",
        ),
        (
            "human-turn-unmatched.log",
            "case 3 checks that stood down because no answer was ever recorded — a case 3 went on unconfirmed",
        ),
    ] {
        let c = read_lines(&dir.join(file)).len();
        if c > 0 {
            say!("note: {c} {what} — see .claude/state/{file}");
        }
    }
    if !warn.is_empty() {
        say!("\nWhat this run is telling you:");
        for w in &warn {
            say!("  - {w}");
        }
        say!(
            "\nThese are observations, not a verdict. The flow changes on a failing run,\nand one line of telemetry is not one yet — but it is how you get there."
        );
    }
    if raw_dump {
        for r in runs
            .iter()
            .filter(|r| !r.gate.is_empty() || !r.trace.is_empty())
        {
            say!("\n=== {} ===", r.name);
            if !r.gate.is_empty() {
                say!("--- gate-history.log ---");
                for g in &r.gate {
                    say!("  {}", g.raw);
                }
            }
            if !r.trace.is_empty() {
                say!("--- run-trace.log ---");
                for t in &r.trace {
                    say!("  {}", t.raw);
                }
            }
        }
    }
    print!("{out}");
    0
}

/// Who spent it, per run — the orchestrator by model, then each role joined
/// by agent_id to its return line. A sidechain line naming no agent is
/// `unattributed`, never guessed. An advisor is charged to whoever consulted
/// it.
fn by_role_runs(runs: &[RunLog], out: &mut String) {
    #[derive(Default)]
    struct Row {
        role: String,
        model: String,
        agents: Vec<String>,
        efforts: Vec<String>,
        n: HashMap<&'static str, f64>,
        split: bool,
        max_prompt: f64,
    }
    for r in runs {
        let lines: Vec<&Entry> = r
            .trace
            .iter()
            .filter(|e| e.get("msgs").is_some() && !e.f("model").is_empty())
            .collect();
        if lines.is_empty() {
            continue;
        }
        let returned: HashMap<&str, &Entry> = r
            .trace
            .iter()
            .filter(|e| !e.f("type").is_empty() && !e.f("agent_id").is_empty())
            .map(|e| (e.f("agent_id"), e))
            .collect();
        let mut rows: Vec<Row> = Vec::new();
        for e in &lines {
            let back = returned.get(e.f("agent_id"));
            let caller = if e.f("sidechain") == "true" {
                back.map_or("unattributed", |b| b.f("type")).to_string()
            } else {
                "orchestrator".into()
            };
            let role = if e.f("advisor") == "true" {
                format!("advisor ← {caller}")
            } else {
                caller
            };
            let at = match rows
                .iter()
                .position(|rw| rw.role == role && rw.model == e.f("model"))
            {
                Some(i) => i,
                None => {
                    rows.push(Row {
                        role,
                        model: e.f("model").into(),
                        split: true,
                        ..Row::default()
                    });
                    rows.len() - 1
                }
            };
            let rw = &mut rows[at];
            let id = e.f("agent_id");
            if !id.is_empty() && !rw.agents.iter().any(|a| a == id) {
                rw.agents.push(id.into());
            }
            // The effort on the return line is the consulting agent's.
            if let Some(b) = back
                && !b.f("effort").is_empty()
                && e.f("advisor") != "true"
                && !rw.efforts.iter().any(|x| x == b.f("effort"))
            {
                rw.efforts.push(b.f("effort").into());
            }
            for k in ["in", "out", "cache_read", "cache_write", "msgs"] {
                *rw.n.entry(k).or_default() += num_field(e.f(k));
            }
            if e.get("cache_write_5m").is_some() && e.get("cache_write_1h").is_some() {
                *rw.n.entry("m5").or_default() += num_field(e.f("cache_write_5m"));
                *rw.n.entry("h1").or_default() += num_field(e.f("cache_write_1h"));
            } else if num_field(e.f("cache_write")) > 0.0 {
                rw.split = false;
            }
            rw.max_prompt = rw.max_prompt.max(num_field(e.f("max_prompt")));
        }
        let label = if runs.len() > 1 {
            format!(" [{}]", r.name)
        } else {
            String::new()
        };
        out.push_str(&format!("  by role{label}:\n"));
        let g = |rw: &Row, k: &str| rw.n.get(k).copied().unwrap_or(0.0);
        rows.sort_by(|a, b| {
            g(b, "out")
                .partial_cmp(&g(a, "out"))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        for rw in &rows {
            let who = if rw.agents.is_empty() {
                rw.role.clone()
            } else {
                let eff = if rw.efforts.is_empty() {
                    String::new()
                } else {
                    format!(", effort {}", rw.efforts.join("/"))
                };
                format!("{} ({} agent(s){eff})", rw.role, rw.agents.len())
            };
            // A role's cost is its message count times its average prompt
            // (ADR-033).
            let msgs = g(rw, "msgs");
            let per_message = if msgs > 0.0 {
                format!(
                    "  {} msg, ~{} prompt/msg",
                    tracelines::js_num(msgs),
                    tracelines::human(
                        ((g(rw, "in") + g(rw, "cache_read") + g(rw, "cache_write")) / msgs).round()
                    )
                )
            } else {
                String::new()
            };
            let ttl = if rw.split && g(rw, "cache_write") > 0.0 {
                format!(
                    " (5m {}, 1h {})",
                    tracelines::human(g(rw, "m5")),
                    tracelines::human(g(rw, "h1"))
                )
            } else {
                String::new()
            };
            out.push_str(&format!(
                "    {who}  {}  in {}  out {}  cache_read {}  cache_write {}{ttl}  largest prompt {}{per_message}\n",
                rw.model,
                tracelines::human(g(rw, "in")),
                tracelines::at_least(g(rw, "out")),
                tracelines::human(g(rw, "cache_read")),
                tracelines::human(g(rw, "cache_write")),
                tracelines::human(rw.max_prompt)
            ));
        }
    }
}

/// The root an archived run's absolute paths were recorded under: the part
/// in front of `specflow/[archive/]<slug>/`.
fn recorded_root(r: &RunLog) -> String {
    if r.name == "(current)" {
        return String::new();
    }
    let own = Regex::new(&format!(
        r"^(([a-zA-Z]:)?/.*)/specflow/(archive/)?{}/",
        regex::escape(&r.name)
    ))
    .unwrap();
    r.trace
        .iter()
        .filter(|e| !e.f("file").is_empty())
        .find_map(|e| {
            own.captures(&norm_path(e.f("file")))
                .map(|m| m[1].to_string())
        })
        .unwrap_or_default()
}

/// A read's path relative to this repository, or to the root recorded names;
/// `None` when it points outside. Case-blind where the filesystem is.
fn inside_repo(file: &str, root_norm: &str, recorded: &str) -> Option<String> {
    let p = norm_path(file);
    for (base, case_blind) in [
        (root_norm, cfg!(windows)),
        (recorded, WIN_DRIVE.is_match(recorded)),
    ] {
        if base.is_empty() {
            continue;
        }
        let prefix = format!("{base}/");
        let under = if case_blind {
            p.to_lowercase().starts_with(&prefix.to_lowercase())
        } else {
            p.starts_with(&prefix)
        };
        if under {
            return Some(p[prefix.len()..].to_string());
        }
    }
    if ABS_OR_DRIVE.is_match(&p) {
        None
    } else {
        Some(p)
    }
}

/// The change folder a run's artifacts live in.
fn change_dir(root: &Path, name: &str) -> Option<std::path::PathBuf> {
    let specflow = root.join("specflow");
    if name != "(current)" {
        return [specflow.join("archive").join(name), specflow.join(name)]
            .into_iter()
            .find(|d| d.join("spec.md").exists());
    }
    // The live tier carries no slug: only a single live change folder names
    // it.
    let live: Vec<String> = crate::spec::time::subdirs(&specflow)
        .into_iter()
        .filter(|n| n != "archive" && specflow.join(n).join("spec.md").exists())
        .collect();
    match &live[..] {
        [one] => Some(specflow.join(one)),
        _ => None,
    }
}

/// The directories a change is about: what its deltas' capability specs
/// scope plus the directory of every path its milestones name.
fn change_scope(root: &Path, dir: &Path, specs_dir: &str) -> (Vec<String>, Vec<String>) {
    let text = |f: &Path| state::read_text(f).unwrap_or_default();
    let spec = text(&dir.join("spec.md"));
    let deltas = H2_SPLIT
        .split(&spec)
        .into_iter()
        .find(|s| DELTAS_START.is_match(s))
        .unwrap_or_default()
        .to_string();
    let mut caps: Vec<String> = Vec::new();
    for m in REQ_ID.exec_all(&deltas) {
        let c = m.group(1).to_lowercase();
        if !caps.contains(&c) {
            caps.push(c);
        }
    }
    let (mut dirs, mut from): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let add = |dirs: &mut Vec<String>, d: String| {
        if !d.is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    };
    for c in &caps {
        let body = text(&root.join(specs_dir).join(format!("{c}.md")));
        let Some(m) = SCOPE_MARK.exec(&body) else {
            continue;
        };
        add(&mut dirs, norm_path(m.group(1)));
        from.push(format!("{specs_dir}/{c}.md"));
    }
    let mut named = 0;
    let mut files: Vec<String> = std::fs::read_dir(dir.join("milestones"))
        .map(|es| {
            es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| n.ends_with(".md"))
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    for f in files {
        let body = text(&dir.join("milestones").join(&f));
        let Some(m) = FILES_FIELD.exec(&body) else {
            continue;
        };
        for p in NAMED_PATH.find_iter(m.group(1)) {
            named += 1;
            let p = p.as_str();
            if p.ends_with('/') {
                add(&mut dirs, norm_path(p));
            } else {
                let n = norm_path(p);
                let segs: Vec<&str> = n.split('/').collect();
                add(&mut dirs, segs[..segs.len() - 1].join("/"));
            }
        }
    }
    if named > 0 {
        from.push(format!("{named} milestone path(s)"));
    }
    (dirs, from)
}

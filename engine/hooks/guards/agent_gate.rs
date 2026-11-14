//! `agent-gate` — SubagentStop — holds a spec-flow agent's return to its own
//! contract before the orchestrator acts on it (ADR-031). Narrow, because it
//! blocks: only this plugin's agents during a run; at most `MAX_BLOCKS` per
//! agent; a missing STATUS only where a return is owed; anything it cannot
//! read passes, and a crash exits 0.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::agents::blocks::{self, Return};
use crate::agents::handback;
use crate::hooks::guards::gate::block;
use crate::hooks::guards::orchestrator_scope::ATTRIBUTED_TRACE;
use crate::hooks::record::run_trace::WORD_ID;
use crate::hooks::{Exit, Input};
use crate::payload::js_string;
use crate::repo::gitscope::clean;
use crate::repo::{contract, engine};
use crate::spec::{shape, time};
use crate::state;

static OWN_TYPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^spec-flow:([a-z][a-z-]*)$").unwrap());
static MD_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\(([^)\t\n\x0C\r ]+)\)").unwrap());
static PATH_NOISE: LazyLock<Regex> = LazyLock::new(|| Regex::new("[`'\"*]").unwrap());
static CASE_FIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[^0-9A-Za-z_]*5(?-u:\b)").unwrap());
static LIVE_SPEC_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^specflow/([^/]+)/spec\.md$").unwrap());
static READ_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r" read file=(.*) agent_id=").unwrap());

/// The statuses `name`'s contract declares, modes included. A contract this
/// copy ships and cannot read is a broken install, not "no contract": it
/// crashes, and the crash lets the return through.
fn contract_statuses(name: &str) -> Vec<String> {
    let root = engine::root();
    let path = root.join("agents").join(format!("{name}.md"));
    if !path.exists() {
        return Vec::new();
    }
    let Some(main) = state::read_text(&path) else {
        panic!("cannot read {}", path.display());
    };
    let mut texts = vec![main];
    let modes = root.join("modes");
    let mut names: Vec<String> = std::fs::read_dir(&modes)
        .map(|es| {
            es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    for n in names
        .iter()
        .filter(|n| n.starts_with(&format!("{name}-")) && n.ends_with(".md"))
    {
        texts.extend(state::read_text(&modes.join(n)));
    }
    blocks::declared_statuses(&texts.join("\n"))
}

/// The path a `*_PATH` value names: a markdown link's target, else its first
/// token, backticks, quotes and emphasis stripped.
fn path_in(raw: &str) -> String {
    let target = MD_LINK
        .captures(raw)
        .map_or(raw, |m| m.get(1).unwrap().as_str());
    PATH_NOISE
        .replace_all(target, "")
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_string()
}

struct Problem {
    why: &'static str,
    reason: String,
}

fn problem(why: &'static str, reason: String) -> Problem {
    Problem { why, reason }
}

fn problem_with(ret: &Return, statuses: &[String], root: &Path) -> Option<Problem> {
    if !statuses.contains(&ret.status) {
        return Some(problem(
            "undeclared-status",
            format!(
                "`STATUS: {}` is not a status your contract declares ({}), and the orchestrator routes only those. Return the one that fits.",
                ret.status,
                statuses.join(", ")
            ),
        ));
    }
    for key in &ret.order {
        let raw = &ret.fields[key];
        if !key.ends_with("_PATH") || raw.is_empty() {
            continue;
        }
        let path = path_in(raw);
        if !root.join(&path).exists() {
            return Some(problem(
                "missing-path",
                format!(
                    "`{key}: {raw}` — there is no file at `{path}`. Write it, or return the path you wrote."
                ),
            ));
        }
    }
    None
}

fn same_path_key(root: &Path, path: &str) -> String {
    let full = clean(&root.join(path)).to_string_lossy().into_owned();
    if cfg!(windows) {
        full.to_lowercase()
    } else {
        full
    }
}

fn slug_of(root: &Path, raw: &str) -> String {
    let full = clean(&root.join(raw));
    let Ok(rel) = full.strip_prefix(clean(root)) else {
        return String::new();
    };
    LIVE_SPEC_REF
        .captures(&rel.to_string_lossy().replace('\\', "/"))
        .map_or_else(String::new, |m| m[1].to_string())
}

/// Every capability spec, walked in lexical order, dot-directories included,
/// no symlink followed.
fn capability_specs(dir: &Path, not_cap: &[String], out: &mut Vec<shape::Spec>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = entries.filter_map(|e| Some(e.ok()?.path())).collect();
    entries.sort();
    for path in entries {
        let Ok(meta) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        let name = path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        if meta.is_dir() {
            capability_specs(&path, not_cap, out);
        } else if name.ends_with(".md") && !not_cap.contains(&name) {
            let body = state::read_text(&path).unwrap_or_default();
            out.push(shape::Spec {
                file: path.to_string_lossy().into_owned(),
                ids: shape::declared_ids(&body),
            });
        }
    }
}

/// A round asks at most `MAX_OPEN_QUESTIONS`; a spec handed back is live,
/// passes its spec-time checks, changes only ids `specs/` declares, and — for
/// SPEC_READY — was written after reading specs/README.md and every
/// capability spec its deltas touch (ADR-030). The skips name what could not
/// be judged.
fn spec_writer_problems(
    ret: &Return,
    text: &str,
    root: &Path,
    agent_id: &str,
    trace: &str,
    phase: &str,
) -> (Vec<Problem>, Vec<&'static str>) {
    let (mut problems, mut skips) = (Vec::new(), Vec::new());
    if ret.status == "NEEDS_INPUT" {
        let n = blocks::open_questions(text);
        if n == 0 {
            problems.push(problem("no-questions", "`STATUS: NEEDS_INPUT` with no question under `OPEN_QUESTIONS:` gives the human nothing to answer. List the questions, or write the spec.".into()));
        }
        let m = blocks::MAX_OPEN_QUESTIONS;
        if n > m {
            problems.push(problem("too-many-questions", format!("You asked {n} questions; a round asks at most {m}. Keep the {m} whose answers would change the deltas most. Decide the rest and record each in the spec's `## Assumptions`, or ask it next round.")));
        }
        return (problems, skips);
    }
    if ret.status != "SPEC_READY" && ret.status != "TRIAGED" {
        return (problems, skips);
    }
    let field = |k: &str| ret.fields.get(k).cloned().unwrap_or_default();
    // Case 5 is not a fix: stamped REJECTED and archived, its name must be
    // free (ADR-048).
    if ret.status == "TRIAGED" && CASE_FIVE.is_match(&field("CASE")) {
        let rejected = slug_of(root, &path_in(&field("SPEC_PATH")));
        if !rejected.is_empty() && rejected != "archive" {
            let clash = shape::archive_clash(&rejected, &time::archived_slugs(root));
            if !clash.is_empty() {
                problems.push(problem("spec-shape", clash));
            }
        }
        return (problems, skips);
    }
    // The triage read the code, so it writes the work order, or the
    // orchestrator would read that code again (ADR-033).
    if ret.status == "TRIAGED" {
        let unnamed: Vec<String> = ["PLAN_PATH", "WORK_ORDER_PATH"]
            .iter()
            .filter(|k| field(k).is_empty())
            .map(|k| format!("`{k}:`"))
            .collect();
        if !unnamed.is_empty() {
            let s = if unnamed.len() > 1 { "s" } else { "" };
            problems.push(problem("no-work-order", format!("A triage of case 1 to 4 writes the work order the implementer builds from — `specflow/<SLUG>/plan.md` and `specflow/<SLUG>/milestones/M1.md` — and returns {} naming it. Write it, and return the line{s}.", unnamed.join(" and "))));
            return (problems, skips);
        }
    }
    let raw = path_in(&field("SPEC_PATH"));
    let slug = slug_of(root, &raw);
    if slug.is_empty() || slug == "archive" {
        problems.push(problem("not-live", format!("`SPEC_PATH: {raw}` is not a live change spec. It names `specflow/<SLUG>/spec.md`, outside `specflow/archive/`.")));
        return (problems, skips);
    }
    // The name only in `spec`: mid-run a rename would strand the milestone
    // (ADR-048).
    let shaped = time::problems(root, std::slice::from_ref(&slug), phase == "spec");
    if !shaped.is_empty() {
        problems.push(problem(
            "spec-shape",
            format!(
                "The spec is not ready to build from:\n- {}",
                shaped.join("\n- ")
            ),
        ));
    }
    let Ok(cfg) = contract::load(root) else {
        skips.push("no-contract");
        return (problems, skips);
    };
    let specs_dir = root.join(&cfg.trace.specs_dir);
    let mut specs = Vec::new();
    capability_specs(&specs_dir, &cfg.trace.not_a_capability, &mut specs);
    let body =
        state::read_text(&root.join("specflow").join(&slug).join("spec.md")).unwrap_or_default();
    let own = shape::deltas(&body);
    let unknown: Vec<String> = own
        .iter()
        .filter(|d| d.verb != "ADDED" && !specs.iter().any(|s| s.ids.contains(&d.id)))
        .map(|d| format!("`{} {}`", d.verb, d.id))
        .collect();
    if !unknown.is_empty() {
        problems.push(problem("unknown-id", format!("{} name no requirement declared under {}/. A CHANGED or REMOVED id must already exist there: use the id it declares, or make it an ADDED.", unknown.join(", "), cfg.trace.specs_dir)));
    }
    if ret.status != "SPEC_READY" {
        return (problems, skips);
    }
    let mut expected: Vec<String> = Vec::new();
    for d in &own {
        let f = shape::capability_of(&d.id, &specs);
        if !f.is_empty() && !expected.contains(&f) {
            expected.push(f);
        }
    }
    let readme = specs_dir.join("README.md").to_string_lossy().into_owned();
    if Path::new(&readme).exists() && !expected.contains(&readme) {
        expected.push(readme);
    }
    if expected.is_empty() {
        return (problems, skips);
    }
    // Attribution exists when some tool call was recorded with an agent id;
    // without it, no read can be told from a missing one. The Read tool only.
    let lines: Vec<&str> = trace.split('\n').collect();
    if agent_id.is_empty() || !lines.iter().any(|l| ATTRIBUTED_TRACE.test(l)) {
        skips.push("unattributed");
        return (problems, skips);
    }
    let suffix = format!(" agent_id={agent_id}");
    let read: Vec<String> = lines
        .iter()
        .filter(|l| l.ends_with(&suffix))
        .filter_map(|l| READ_LINE.captures(l).map(|m| m[1].to_string()))
        .filter(|f| !f.is_empty())
        .map(|f| same_path_key(root, &f))
        .collect();
    let unread: Vec<String> = expected
        .iter()
        .filter(|f| !read.contains(&same_path_key(root, f)))
        .map(|f| {
            Path::new(f)
                .strip_prefix(root)
                .map_or_else(|_| f.clone(), |r| r.to_string_lossy().replace('\\', "/"))
        })
        .collect();
    if !unread.is_empty() {
        problems.push(problem("unread", format!("You wrote this spec without reading {} in this run. Read them — the contract, and the requirements your deltas add to or change — and check the deltas against them. (This check sees the Read tool only.)", unread.join(", "))));
    }
    (problems, skips)
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // Read as an object of anything, as the handback reader takes it; one
    // that is no object is no agent of this plugin's.
    let Ok(p) = input.read::<Map<String, Value>>() else {
        return Exit::Pass;
    };
    let typ = js_string(p.get("agent_type"));
    let Some(m) = OWN_TYPE.captures(&typ) else {
        return Exit::Pass;
    };
    let name = m[1].to_string();
    let session = js_string(p.get("session_id"));
    let phase = state::read_phase(&root);
    if !state::is_run_phase(&phase) {
        return Exit::Pass;
    }
    let statuses = contract_statuses(&name);
    if statuses.is_empty() {
        return Exit::Pass;
    }
    let agent_id = p
        .get("agent_id")
        .and_then(Value::as_str)
        .filter(|s| WORD_ID.is_match(s))
        .unwrap_or_default()
        .to_string();
    let trace_file = state::state_dir(&root).join("run-trace.log");
    let trace = state::read_text(&trace_file).unwrap_or_default();
    let text = handback::handed_back(&p);
    let stop_hook_active = p.get("stop_hook_active") == Some(&Value::Bool(true));
    let (mut problems, mut skips) = (Vec::new(), Vec::new());
    match blocks::parse_return(&text) {
        None => {
            // A reply with no status is judged only where a return is owed: at
            // the first stop, or after a block. Once run-trace holds a return
            // for this id, the agent is answering a SendMessage, in prose.
            let returned = !agent_id.is_empty()
                && Regex::new(&format!(
                    r" agent type=\S+ status=\S+.* agent_id={}(\s|$)",
                    regex::escape(&agent_id)
                ))
                .unwrap()
                .is_match(&trace);
            let owed = stop_hook_active || (!agent_id.is_empty() && !returned);
            if text.trim().is_empty() {
                skips.push("empty");
            } else if owed {
                let want: Vec<String> = statuses.iter().map(|s| format!("STATUS: {s}")).collect();
                problems.push(problem("no-status", format!("Your reply has no line opening with `STATUS:`, so the orchestrator has nothing to route. End with the return block your contract declares: {}.", want.join(", "))));
            }
        }
        Some(ret) => match problem_with(&ret, &statuses, &root) {
            Some(found) => problems.push(found),
            None if name == "spec-writer" => {
                (problems, skips) =
                    spec_writer_problems(&ret, &text, &root, &agent_id, &trace, &phase);
            }
            None => {}
        },
    }

    // `agent=`, not `type=`; the live view reads `result= why= agent_id=` in
    // this order (ADR-047).
    let record = |result: &str, why: &str| {
        let s = if WORD_ID.is_match(&session) {
            format!(" session={session}")
        } else {
            String::new()
        };
        let id = if agent_id.is_empty() {
            String::new()
        } else {
            format!(" agent_id={agent_id}")
        };
        state::append_line(
            &trace_file,
            &format!(
                "{} phase={phase}{s} agent-check agent={typ} result={result} why={why}{id}",
                state::now_iso()
            ),
        );
    };
    if problems.is_empty() {
        if !skips.is_empty() {
            record("skip", &skips.join(","));
        }
        return Exit::Pass;
    }
    let blocks_so_far = if !agent_id.is_empty() {
        let mine = Regex::new(&format!(
            r" agent-check .*result=block .*agent_id={}(\s|$)",
            regex::escape(&agent_id)
        ))
        .unwrap();
        trace.split('\n').filter(|l| mine.is_match(l)).count()
    } else if stop_hook_active {
        blocks::MAX_BLOCKS
    } else {
        0
    };
    let result = if blocks_so_far >= blocks::MAX_BLOCKS {
        "cap"
    } else {
        "block"
    };
    let whys: Vec<&str> = problems.iter().map(|p| p.why).collect();
    record(result, &whys.join(","));
    if result != "block" {
        return Exit::Pass;
    }
    let reasons: Vec<&str> = problems.iter().map(|p| p.reason.as_str()).collect();
    block(&format!("[spec-flow] {}", reasons.join("\n\n")))
}

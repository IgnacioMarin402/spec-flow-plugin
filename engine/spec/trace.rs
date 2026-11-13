//! Binds a repository's capability specs to the tests that prove them. A spec
//! is the source of truth only if something breaks when the spec and the code
//! disagree; this is what breaks.
//!
//! The binding is the requirement id, and it binds only from a test the
//! runner REPORTED as executed: a tag in a comment proves nothing. Nothing
//! here reads source code or walks the repository (ADR-001). Checked in both
//! directions — a requirement with no test, a test tag with no requirement —
//! plus the archive's rules: every archived change declares what became of
//! it, each has a folder of its own, and one this branch shipped has its
//! deltas in `specs/` (ADR-048). Which archived changes are this branch's it
//! asks of git.

use std::cell::OnceCell;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::jsre::Re;
use crate::repo::contract::{self, Config};
use crate::repo::{gitscope, proc};
use crate::spec::{report, shape, time};
use crate::state;

static SCOPE_MARKER: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^<!--\s*spec-scope:\s*(.+?)\s*-->$", "m"));
static HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(#{1,6})[\t\n\x0C\r ]+([^\t\n\x0C\r ]+)").unwrap());
static SKILLS_FIELD: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^[-*]?\s*\**Skills\**\s*:[ \t]*\S", "m"));

/// Every file under `dir` matching `test`. Dot-directories are skipped, for
/// size only — no build-output names: a repository whose capability is called
/// `build` is entitled to `specs/build/`. Symlinks are followed once each: a
/// circular one would otherwise recurse forever.
fn walk(
    dir: &Path,
    test: &dyn Fn(&Path) -> bool,
    found: &mut Vec<PathBuf>,
    seen: &mut HashSet<PathBuf>,
) {
    let Ok(real) = std::fs::canonicalize(dir) else {
        return;
    };
    if !seen.insert(real) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let full = e.path();
        // `metadata` follows a symlink; a dangling one is skipped.
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            if !e.file_name().to_string_lossy().starts_with('.') {
                walk(&full, test, found, seen);
            }
        } else if test(&full) {
            found.push(full);
        }
    }
}

/// `path` from `root`, `/`-separated as the messages have always named it on
/// this platform.
fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .into_owned()
}

struct Requirement {
    title: String,
    spec: String,
}

struct Shaped {
    rel: String,
    line: String,
    level: usize,
    token: String,
}

/// Which archived changes are this branch's: asked of git once, and only when
/// a check needs it.
struct Scope {
    reference: String,
    at_base: HashSet<String>,
    written: HashMap<String, i64>,
    err: Option<String>,
}

fn scope_of(root: &Path, cfg: &Config) -> Scope {
    match gitscope::resolve_base(root, Some(cfg)) {
        Err(e) => Scope {
            reference: String::new(),
            at_base: HashSet::new(),
            written: HashMap::new(),
            err: Some(e),
        },
        Ok(r) => Scope {
            at_base: gitscope::specs_at_base(root, &r),
            written: gitscope::branch_writes(root, &r),
            reference: r,
            err: None,
        },
    }
}

struct ArchivedSpec {
    slug: String,
    body: String,
}

/// `spec-flow trace`: 0 when the spec layer and the tests agree. `list` also
/// prints the requirement → test matrix.
pub fn run(root: &Path, list: bool, stdout: &mut dyn Write, stderr: &mut dyn Write) -> i32 {
    let cfg = match contract::load(root) {
        Ok(c) => c,
        Err(e) => {
            // Unguarded: a version this engine does not recognise stops the run.
            let _ = writeln!(stderr, "spec-trace: {e}");
            return 1;
        }
    };
    let specs_dir_name = &cfg.trace.specs_dir;
    let specs_dir = root.join(specs_dir_name);
    let specflow_dir = root.join("specflow");
    let archive_dir = specflow_dir.join("archive");

    let mut problems: Vec<String> = Vec::new();
    let mut req_order: Vec<String> = Vec::new();
    let mut requirements: HashMap<String, Requirement> = HashMap::new();

    // ---- read the specs ------------------------------------------------------
    let not_a_cap: HashSet<&str> = cfg
        .trace
        .not_a_capability
        .iter()
        .map(String::as_str)
        .collect();
    let mut shaped_headings: Vec<Shaped> = Vec::new();
    let mut spec_files = Vec::new();
    walk(
        &specs_dir,
        &|f: &Path| {
            let name = f
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            name.ends_with(".md") && !not_a_cap.contains(name.as_str())
        },
        &mut spec_files,
        &mut HashSet::new(),
    );
    for file in &spec_files {
        let r = rel(root, file);
        let text = state::read_text(file).unwrap_or_default();
        if SCOPE_MARKER.exec(&text).is_none() {
            problems.push(format!(
                "{r}: missing the scope marker. Add `<!-- spec-scope: <the path this spec is about> -->` near the top."
            ));
        }
        let prefix = shape::expected_prefix(&file.to_string_lossy());
        // Headings led by something shaped like an id, code aside: judged once
        // every requirement is known.
        for line in shape::without_code(&text).split('\n') {
            let line = line.trim();
            let Some(h) = HEADING.captures(line) else {
                continue;
            };
            let tokens = shape::id_shaped(&h[2]);
            if let Some(first) = tokens.first()
                && h[2].starts_with(first.as_str())
            {
                shaped_headings.push(Shaped {
                    rel: r.clone(),
                    line: line.into(),
                    level: h[1].len(),
                    token: first.clone(),
                });
            }
        }
        for line in text.split('\n') {
            let Some(m) = shape::REQ_HEADING.exec(line.trim()) else {
                continue;
            };
            let (id, title) = (m.group(1).to_string(), m.group(2).trim().to_string());
            if !id.starts_with(&prefix) {
                problems.push(format!(
                    "{r}: requirement {id} does not start with {prefix}, which this file's name requires."
                ));
            }
            if let Some(prev) = requirements.get(&id) {
                problems.push(format!("{id} is declared twice: {} and {r}.", prev.spec));
                continue;
            }
            requirements.insert(
                id.clone(),
                Requirement {
                    title,
                    spec: r.clone(),
                },
            );
            req_order.push(id);
        }
    }

    // ---- ask which tests actually ran ----------------------------------------
    // Everything downstream reads LINES: an id found in a line is a proof.
    // Declaring neither source is legitimate only while nothing is to prove.
    let report = cfg.trace.report.as_ref().filter(|r| !r.format.is_empty());
    let report_cmd = match report {
        Some(r) => format!("trace.report ({} @ {})", r.format, r.path),
        None => cfg.trace.executed_tests.join(" "),
    };
    let mut report_skipped = 0;
    let (mut status, mut out, mut err_text, mut spawn_err) =
        (0, String::new(), String::new(), String::new());
    if let Some(r) = report {
        let read = report::read(&r.format, &r.path, root);
        if read.error.is_empty() {
            report_skipped = read.skipped;
            out = read.names.join("\n");
        } else {
            (status, err_text) = (1, read.error);
        }
    } else if !cfg.trace.executed_tests.is_empty() {
        let argv: Vec<&str> = cfg
            .trace
            .executed_tests
            .iter()
            .map(String::as_str)
            .collect();
        let res = proc::run(root, &argv);
        status = res.status.unwrap_or(-1);
        out = res.stdout;
        if res.unstarted {
            spawn_err = res.stderr;
        } else {
            err_text = res.stderr;
        }
    } else if !requirements.is_empty() {
        status = 1;
        err_text = format!(
            "{specs_dir_name}/ declares {} requirement(s) and the contract declares no way to find out which tests ran. \
             Traceability is opt-in and this repo has opted out, which is only coherent while it has no requirements. Add \"report\": {{\"format\": \"junit\", \"path\": \"...\"}} under \"trace\" \
             (your runner already writes that file — `spec-flow init` proposes the flag), or delete the requirements.",
            requirements.len()
        );
    } else {
        // Explicit rather than silent: a green that does not say WHY it is
        // green is how an unarmed check gets mistaken for a passing one.
        let _ = writeln!(
            stdout,
            "spec-trace: traceability is not configured and no requirements are declared — nothing to check."
        );
    }

    // "Every requirement is unproven" and "I could not find out what ran"
    // both exit non-zero, so the message has to tell them apart.
    let report_failed = !spawn_err.is_empty() || status != 0;
    let reported: Vec<&str> = out
        .split('\n')
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    // A source that answers nothing is a refusal only while something depends
    // on the answer — the state every adopter is in on a first run, since the
    // reporter flag `init` asks for is theirs to add.
    let mut unarmed = false;
    if report_failed && requirements.is_empty() {
        let why = if !spawn_err.is_empty() {
            spawn_err.clone()
        } else if !err_text.trim().is_empty() {
            err_text.trim().to_string()
        } else {
            format!("exit {status}")
        };
        unarmed = true;
        let _ = writeln!(
            stdout,
            "spec-trace: traceability is declared but not producing anything yet, and {specs_dir_name}/ declares no requirement — so there is nothing to bind and this is not a failure. \
             It becomes one the moment a requirement exists.\n  source: {report_cmd}\n  reason: {why}"
        );
    } else if report_failed {
        let why = if spawn_err.is_empty() {
            format!("exit {status}")
        } else {
            spawn_err.clone()
        };
        let mut msg = format!(
            "{report_cmd} failed: {why}. Nothing was learned about which tests ran, so no requirement can be called proven OR unproven. \
             This is a refusal, not a finding about your specs."
        );
        if !err_text.is_empty() {
            msg += &format!("\n\n{}", err_text.trim());
        }
        problems.push(msg);
    } else if reported.is_empty() && report_skipped == 0 && !requirements.is_empty() {
        let n = requirements.len();
        problems.push(format!(
            "{report_cmd} reported no tests at all, while {specs_dir_name}/ declares {n} requirement(s). \
             That is not {n} unproven requirement(s) — it is a report that says nothing, which usually means the suite has not run yet in this working tree, or the source names the wrong output. \
             Run the suite (`spec-flow check` does it in the right order) and try again."
        ));
    }
    // A report whose cases were ALL skipped says something — the suite ran and
    // proved nothing — and falls through to the per-requirement findings.

    let mut proof_order: Vec<String> = Vec::new();
    let mut proofs: HashMap<String, Vec<String>> = HashMap::new();
    if !report_failed {
        for line in &reported {
            for id in shape::ids_in(line) {
                let entry = proofs.entry(id.clone()).or_insert_with(|| {
                    proof_order.push(id.clone());
                    Vec::new()
                });
                if !entry.iter().any(|l| l == line) {
                    entry.push(line.to_string());
                }
            }
        }
    }

    // ---- both directions -------------------------------------------------------
    // Not when the report could not be read: that would invent findings.
    if !report_failed && (!reported.is_empty() || report_skipped > 0) {
        for id in &req_order {
            if !proofs.contains_key(id) {
                // The proof surface the contract declares, never a path
                // composed from the spec's scope (ADR-026).
                problems.push(format!(
                    "{id} ({}) has no test that RAN. Add a test on the proof surface the contract declares — a {} file under {} — whose name contains {id}, or delete the requirement — an unproven requirement is a wish, not a spec. \
                     Note that a test which exists but was skipped or marked todo counts as absent here: it is reported by nothing, which is exactly what makes skipping useless as a way to silence this.",
                    requirements[id].spec, cfg.trace.proof_suffix, cfg.trace.proof_dir
                ));
            }
        }
    }
    for id in &proof_order {
        if !requirements.contains_key(id) {
            problems.push(format!(
                "{id} is proven by a test that ran ({}) but no spec declares it. Either add it to the capability spec or drop the tag — a test proving something unspecified is drift in the other direction.",
                proofs[id].join(", ")
            ));
        }
    }

    // ---- whose each archived change is, and which run's -----------------------
    // Asked of git once, and only when a check needs it. During a run, a
    // change the branch archived before one of its live changes was created
    // belongs to an earlier run: said, not failed. Read off the repository,
    // never off state a hook wrote.
    let scope_cell: OnceCell<Scope> = OnceCell::new();
    let sc = || scope_cell.get_or_init(|| scope_of(root, &cfg));
    let mut unscoped: Vec<String> = Vec::new();
    let mut earlier: Vec<String> = Vec::new();
    let inherited = |spec: &str| {
        let s = sc();
        s.at_base.contains(spec) && !s.written.contains_key(&format!("specflow/{spec}"))
    };
    let written_at = |spec: &str| {
        sc().written
            .get(&format!("specflow/{spec}"))
            .copied()
            .unwrap_or(gitscope::UNCOMMITTED)
    };
    let live: Vec<String> = time::subdirs(&specflow_dir)
        .into_iter()
        .filter(|s| s != "archive")
        .collect();
    let in_run: OnceCell<bool> = OnceCell::new();
    let live_since: OnceCell<Vec<i64>> = OnceCell::new();
    let earlier_run = |spec: &str| {
        if !*in_run.get_or_init(|| state::is_run_phase(&state::read_phase(root))) {
            return false;
        }
        let since = live_since.get_or_init(|| {
            live.iter()
                .filter(|slug| {
                    specflow_dir.join(slug).join("spec.md").exists()
                        && !sc().at_base.contains(&format!("{slug}/spec.md"))
                })
                .map(|slug| written_at(&format!("{slug}/spec.md")))
                .collect()
        });
        let at = written_at(spec);
        since.iter().any(|s| *s > at)
    };

    // ---- a heading shaped like a requirement is one ------------------------------
    // One the base already has is not this branch's (ADR-048); with no base,
    // nothing tells whose it is, so it fails.
    let mut headings_at_base: HashMap<String, HashSet<String>> = HashMap::new();
    let mut inherited_headings: Vec<String> = Vec::new();
    for h in &shaped_headings {
        if shape::is_id(&h.token) && (h.level == 3 || requirements.contains_key(&h.token)) {
            continue;
        }
        let msg = format!(
            "{}: \"{}\" is no requirement the engine reads, so no test is bound to it. A requirement is a `### REQ-<CAP>-0NN — <title>` heading: three hashes, the id in capitals, three digits.",
            h.rel, h.line
        );
        let base_has = sc().err.is_none() && {
            let set = headings_at_base.entry(h.rel.clone()).or_insert_with(|| {
                shape::without_code(&gitscope::file_at_base(root, &sc().reference, &h.rel))
                    .split('\n')
                    .map(|l| l.trim().to_string())
                    .collect()
            });
            set.contains(&h.line)
        };
        if base_has {
            inherited_headings.push(msg);
        } else {
            problems.push(msg);
        }
    }

    // ---- the archive declares what became of each change ----------------------
    let archived = time::subdirs(&archive_dir);
    for slug in &archived {
        let spec_path = archive_dir.join(slug).join("spec.md");
        // A change folded onto a folder the archive already had lands inside it.
        let mut inside: Vec<String> = std::fs::read_dir(archive_dir.join(slug))
            .map(|es| {
                es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        inside.sort();
        for name in inside {
            let nested = format!("archive/{slug}/{name}/spec.md");
            if !specflow_dir.join(&nested).exists() {
                continue;
            }
            if sc().err.is_some() {
                unscoped.push(format!("specflow/{nested}"));
                continue;
            }
            if inherited(&nested) {
                continue;
            }
            let msg = format!(
                "specflow/archive/{slug}/{name}/ holds a change spec inside another change's folder: a fold moved a change onto a name the archive already had, where no archive check reads it. Move it to specflow/archive/<a name of its own>/."
            );
            if earlier_run(&nested) {
                earlier.push(msg);
            } else {
                problems.push(msg);
            }
        }
        let Some(body) = state::read_text(&spec_path) else {
            problems.push(format!(
                "specflow/archive/{slug}/ has no spec.md. An archived change with no spec is a folder nobody can interpret."
            ));
            continue;
        };
        if !shape::ARCHIVE_STATUS.test(&body) {
            problems.push(format!(
                "{}: no status. Add `**Status:** SHIPPED|REJECTED|SUPERSEDED <YYYY-MM-DD>` under the heading, so a reader can tell what became of this change without digging through git history.",
                rel(root, &spec_path)
            ));
        }
    }

    // Two archived folders a case apart are one on macOS and Windows.
    let mut names: Vec<String> = Vec::new();
    let mut by_name: HashMap<String, Vec<&String>> = HashMap::new();
    for slug in &archived {
        let k = slug.to_lowercase();
        if !by_name.contains_key(&k) {
            names.push(k.clone());
        }
        by_name.entry(k).or_default().push(slug);
    }
    for k in &names {
        let same = &by_name[k];
        for (i, a) in same.iter().enumerate() {
            for b in &same[i + 1..] {
                if sc().err.is_some() {
                    unscoped.push(format!("specflow/archive/{a}/"));
                    unscoped.push(format!("specflow/archive/{b}/"));
                    continue;
                }
                let ours: Vec<&&String> = [a, b]
                    .into_iter()
                    .filter(|slug| !inherited(&format!("archive/{slug}/spec.md")))
                    .collect();
                if ours.is_empty() {
                    continue;
                }
                let all_earlier = ours
                    .iter()
                    .all(|slug| earlier_run(&format!("archive/{slug}/spec.md")));
                let msg = format!(
                    "specflow/archive/{a}/ and specflow/archive/{b}/ differ only in case: on macOS and Windows they are one folder, where one change lands inside the other. Give one a name of its own."
                );
                if all_earlier {
                    earlier.push(msg);
                } else {
                    problems.push(msg);
                }
            }
        }
    }

    // ---- a live change spec stays light ------------------------------------------
    let archived_specs: Vec<ArchivedSpec> = archived
        .iter()
        .filter_map(|slug| {
            state::read_text(&archive_dir.join(slug).join("spec.md")).map(|body| ArchivedSpec {
                slug: slug.clone(),
                body,
            })
        })
        .collect();
    let archived_bodies: Vec<String> = archived_specs.iter().map(|a| a.body.clone()).collect();
    let mut live_bodies: Vec<String> = Vec::new();
    for slug in &live {
        let Some(body) = state::read_text(&specflow_dir.join(slug).join("spec.md")) else {
            continue; // a folder mid-write is not a failure
        };
        let has_proposal = specflow_dir.join(slug).join("proposal.md").exists();
        problems.extend(shape::live_spec_problems(
            slug,
            &body,
            has_proposal,
            &archived_bodies,
        ));
        let fix_brief = shape::is_fix_brief(&body);
        live_bodies.push(body);
        if fix_brief || !cfg.trace.require_skills_field {
            continue;
        }
        // `none` is an answer; an absent or EMPTY `Skills:` cannot be told
        // from a planner that never looked. Off unless the contract asks.
        let dir = specflow_dir.join(slug).join("milestones");
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue; // no plan yet
        };
        let mut files: Vec<String> = entries
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| n.ends_with(".md"))
            .collect();
        files.sort();
        for f in files {
            let text = state::read_text(&dir.join(&f)).unwrap_or_default();
            if !SKILLS_FIELD.test(&text) {
                problems.push(format!(
                    "specflow/{slug}/milestones/{f} has no `Skills:` field, or has one with nothing after the colon. Every milestone says which skills it needs — `none` when the answer is none, which is what a project shipping no skills always writes. Neither absent nor empty is that answer: the implementer cannot tell either apart from a planner that never looked, and loads nothing in all three cases."
                ));
            }
        }
    }

    // ---- a SHIPPED change's deltas landed in specs/ -----------------------------
    // An ADDED that never reached `specs/` is bound to no test. Only the
    // changes this branch ships (ADR-048).
    let shipped: Vec<&ArchivedSpec> = archived_specs
        .iter()
        .filter(|a| shape::is_shipped(&a.body) && shape::REQ_TAG.test(&a.body))
        .collect();
    if !spec_files.is_empty() && !shipped.is_empty() {
        if sc().err.is_some() {
            for s in &shipped {
                unscoped.push(format!("specflow/archive/{}/spec.md", s.slug));
            }
        } else {
            // Retired by any change, inherited ones too: what a later change
            // removed is not missing.
            let retired: HashSet<String> = shipped
                .iter()
                .map(|s| &s.body)
                .chain(&live_bodies)
                .flat_map(|b| shape::retired_ids(b))
                .collect();
            for s in &shipped {
                let spec = format!("archive/{}/spec.md", s.slug);
                if inherited(&spec) {
                    continue;
                }
                let r = format!("specflow/{spec}");
                let mut add = |msg: String| {
                    if earlier_run(&spec) {
                        earlier.push(msg);
                    } else {
                        problems.push(msg);
                    }
                };
                let section = shape::deltas_section_problem(&s.body, true);
                if !section.is_empty() {
                    add(format!("{r} {section}"));
                }
                for u in shape::unread_deltas(&s.body) {
                    add(format!("{r}: {}", shape::explain_unread(&u)));
                }
                for d in shape::deltas(&s.body) {
                    let declared = requirements.get(&d.id);
                    if d.verb == "ADDED" && declared.is_none() && !retired.contains(&d.id) {
                        add(format!(
                            "{} is ADDED by {r}, stamped SHIPPED, but no capability spec under {specs_dir_name}/ declares it — so no test is bound to it, and nothing proves it. \
                             The milestone that delivers it writes it into {specs_dir_name}/<capability>.md with the test that proves it; a change that did not deliver it is not SHIPPED as written.",
                            d.id
                        ));
                    }
                    if let (true, Some(req)) = (d.verb == "REMOVED", declared) {
                        add(format!(
                            "{} is REMOVED by {r}, stamped SHIPPED, but {} still declares it. Delete it there, and the test that reports it.",
                            d.id, req.spec
                        ));
                    }
                }
            }
        }
    }

    if !unscoped.is_empty() {
        let these = if unscoped.len() > 1 {
            "these are"
        } else {
            "this is"
        };
        problems.push(format!(
            "{}: whether {these} this branch's or inherited needs the base, and {}",
            unscoped.join(", "),
            sc().err.as_deref().unwrap_or_default()
        ));
    }
    for p in &earlier {
        let _ = writeln!(
            stdout,
            "spec-trace: held from the fold's gate on, not before — an earlier run of this branch: {p}"
        );
    }
    for p in &inherited_headings {
        let _ = writeln!(
            stdout,
            "spec-trace: not failed — the base branch already has it, so it is not this branch's: {p}"
        );
    }

    // ---- report -------------------------------------------------------------------
    // An empty `specs/` is right while adopting: capability specs are WRITTEN
    // by the flow. It stops being right at the first SHIPPED change that
    // claimed a requirement: that stamp asserts deltas landed where nothing
    // is. The grace covers the binding only, and falls through to the rest.
    let mut graced = false;
    if spec_files.is_empty() {
        if shipped.is_empty() {
            let _ = writeln!(
                stdout,
                "spec-trace: no capability specs under {specs_dir_name}/ and nothing shipped yet — no requirements to bind. \
                 This grace ends at the first SHIPPED change: capability specs are what a fold writes. Everything else below is still checked."
            );
            graced = true;
        } else {
            let slugs: Vec<&str> = shipped.iter().map(|s| s.slug.as_str()).collect();
            problems.push(format!(
                "{} change(s) are stamped SHIPPED ({}) but {specs_dir_name}/ holds no capability spec. \
                 A fold stamps SHIPPED to assert its deltas landed there, so either they never did, or the specs were written somewhere this contract does not look — \
                 check trace.specs_dir. Until this is resolved every requirement check here is vacuous: with no requirements to bind, this script reports green over a spec layer that does not exist.",
                shipped.len(),
                slugs.join(", ")
            ));
        }
    }

    if list {
        for file in &spec_files {
            let r = rel(root, file);
            let _ = writeln!(stdout, "\n{r}");
            for id in req_order.iter().filter(|id| requirements[*id].spec == r) {
                let req = &requirements[id];
                match proofs.get(id) {
                    Some(proof) => {
                        let _ = writeln!(
                            stdout,
                            "  OK   {id}  {}\n         proven by {}",
                            req.title,
                            proof.join(", ")
                        );
                    }
                    None => {
                        let _ = writeln!(stdout, "  MISS {id}  {}", req.title);
                    }
                }
            }
        }
        let _ = writeln!(stdout);
    }

    if !problems.is_empty() {
        let _ = write!(
            stderr,
            "spec-trace: the spec layer and the code disagree.\n\n"
        );
        for p in &problems {
            let _ = writeln!(stderr, "  - {p}");
        }
        let _ = writeln!(stderr, "\n{} problem(s).", problems.len());
        return 1;
    }
    // Not over zero requirements, nor over an unanswered question, nor while
    // an earlier run's ADDED id may be bound to nothing: those greens are
    // vacuous.
    if !graced && !unarmed && earlier.is_empty() {
        let _ = writeln!(
            stdout,
            "spec-trace: OK — {} requirement(s) across {} capability spec(s), every one proven by a test; {} archived change(s), every one with a status.",
            requirements.len(),
            spec_files.len(),
            archived.len()
        );
    }
    0
}

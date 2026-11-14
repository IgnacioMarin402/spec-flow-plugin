//! An eval run costs a model and minutes, so nobody runs one to find out
//! whether a grader can fail. This builds every case's scaffold the way
//! `claude plugin eval --scaffold` does and holds what can be held without a
//! model: every regex grader agrees with the untouched scaffold, and every
//! `*-untouched` grader is its file byte for byte; a triage that "fixes it
//! anyway" fails a grader; each bug report is true of its scaffold; the sound
//! plan's tests fail first; a fixture milestone has the template's fields;
//! graders copied across the triage cases are one copy.
//!
//! The scaffolds are Node repositories (ADR-007), so this needs bash and node.
//! SPEC_FLOW_EVALS_WRITE=1 regenerates the `*-untouched` patterns.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::LazyLock;

use regex::Regex;
use spec_flow::jsre::Re;

use crate::agentcontracts::fence_after;
use crate::{Tree, read_rel, repo, slash};

#[derive(Clone, Debug, PartialEq)]
enum Val {
    Str(String),
    Bool(bool),
    Map(BTreeMap<String, Option<Val>>),
}

type Fm = BTreeMap<String, Option<Val>>;

struct Grader {
    file: String,
    path: PathBuf,
    text: String,
    fm: Fm,
}

impl Grader {
    fn str(&self, key: &str) -> &str {
        match self.fm.get(key) {
            Some(Some(Val::Str(s))) => s,
            _ => "",
        }
    }

    fn target(&self) -> Option<&BTreeMap<String, Option<Val>>> {
        match self.fm.get("target") {
            Some(Some(Val::Map(m))) => Some(m),
            _ => None,
        }
    }

    fn target_str(&self, key: &str) -> &str {
        match self.target().and_then(|t| t.get(key)) {
            Some(Some(Val::Str(s))) => s,
            _ => "",
        }
    }

    fn is_guard(&self) -> bool {
        self.file.ends_with("-untouched.md") && self.target_str("source") == "file"
    }
}

struct Case {
    name: String,
    dir: PathBuf,
    scaffold: String,
    triage: bool,
    graders: Vec<Grader>,
}

static FM_BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\n((?s:.*?))\n---\n?").unwrap());
static FM_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^( {2})?([a-z_]+):(?: (.*))?$").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\d+(\.\d+)?$").unwrap());
static PATTERN_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^pattern: .*$").unwrap());
static REMOVE_ITEM: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"export function removeItem(?s:.*?)\n}").unwrap());
static MILESTONE_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^- ([A-Z][^:\n]*):").unwrap());

/// The subset these graders use: `key: value`, single-quoted strings and one
/// nested map. Anything else fails, so a grader written in a shape this
/// cannot read fails here instead of being skipped.
fn frontmatter_of(text: &str, where_: &str) -> Fm {
    let m = FM_BLOCK
        .captures(text)
        .unwrap_or_else(|| panic!("{where_}: no frontmatter"));
    let mut out = Fm::new();
    let mut nested: Option<String> = None;
    for line in m[1].split('\n') {
        let kv = FM_LINE
            .captures(line)
            .unwrap_or_else(|| panic!("{where_}: cannot read frontmatter line {line:?}"));
        let indented = kv.get(1).is_some();
        let key = kv[2].to_string();
        let raw = kv.get(3).map_or("", |r| r.as_str());
        let value =
            (line.contains(": ") || line.ends_with(':') && !raw.is_empty()).then(|| scalar_of(raw));
        if indented {
            let Some(Some(Val::Map(map))) = nested.as_ref().and_then(|n| out.get_mut(n)) else {
                panic!("{where_}: indented {key:?} outside a map");
            };
            map.insert(key, value);
        } else if value.is_none() {
            out.insert(key.clone(), Some(Val::Map(BTreeMap::new())));
            nested = Some(key);
        } else {
            nested = None;
            out.insert(key, value);
        }
    }
    out
}

fn scalar_of(raw: &str) -> Val {
    if let Some(rest) = raw.strip_prefix('\'') {
        let inner = rest
            .strip_suffix('\'')
            .unwrap_or_else(|| panic!("unterminated string {raw}"));
        return Val::Str(inner.replace("''", "'"));
    }
    match raw {
        "true" => Val::Bool(true),
        "false" => Val::Bool(false),
        _ if NUMBER.is_match(raw) => Val::Str(format!("#{raw}")),
        _ => Val::Str(raw.to_string()),
    }
}

fn read_cases(evals: &Path) -> Vec<Case> {
    let mut names: Vec<String> = std::fs::read_dir(evals)
        .map(|es| {
            es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    let triage = Regex::new(r"(?m)^tags: \[[^\]]*\btriage\b").unwrap();
    let scaffold = Regex::new(r"scaffold_script: (\S+)").unwrap();
    let mut cases = Vec::new();
    for name in names {
        let dir = evals.join(&name);
        let Ok(yaml) = std::fs::read_to_string(dir.join("case.yaml")) else {
            continue;
        };
        let mut files: Vec<String> = std::fs::read_dir(dir.join("graders"))
            .map(|es| {
                es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        let graders = files
            .into_iter()
            .filter(|f| f.ends_with(".md"))
            .map(|file| {
                let path = dir.join("graders").join(&file);
                let text = std::fs::read_to_string(&path).unwrap();
                let fm = frontmatter_of(&text, &path.to_string_lossy());
                Grader {
                    file,
                    path,
                    text,
                    fm,
                }
            })
            .collect();
        cases.push(Case {
            triage: triage.is_match(&yaml),
            scaffold: scaffold
                .captures(&yaml)
                .map(|m| m[1].to_string())
                .unwrap_or_default(),
            name,
            dir,
            graders,
        });
    }
    cases
}

/// Every file under dir, as the harness lists a run directory.
fn listing(dir: &Path) -> BTreeSet<String> {
    fn visit(root: &Path, at: &Path, out: &mut BTreeSet<String>) {
        for e in std::fs::read_dir(at)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                visit(root, &e.path(), out);
            } else {
                out.insert(slash(root, &e.path()));
            }
        }
    }
    let mut out = BTreeSet::new();
    visit(dir, dir, &mut out);
    out
}

/// A regex grader scored as the harness does: `files` is the paths the run
/// CREATED, so a guard against an edit reads the file itself. None when the
/// grader is not one this can score.
fn passes(g: &Grader, cwd: &Path, before: &BTreeSet<String>) -> Option<bool> {
    let text = if g.str("target") == "files" {
        listing(cwd)
            .into_iter()
            .filter(|p| !before.contains(p))
            .collect::<Vec<_>>()
            .join("\n")
    } else if g.target_str("source") == "file" {
        match std::fs::read_to_string(cwd.join(g.target_str("path"))) {
            Ok(t) => t,
            Err(_) => return Some(false),
        }
    } else {
        return None;
    };
    let found = Re::new(g.str("pattern"), g.str("flags")).test(&text);
    match g.str("match") {
        "" | "contains" => Some(found),
        "not_contains" => Some(!found),
        other => panic!("{}: match {other:?} is not handled here", g.file),
    }
}

/// The regex graders that fail on cwd.
fn failing(c: &Case, cwd: &Path, before: &BTreeSet<String>) -> Vec<String> {
    c.graders
        .iter()
        .filter(|g| g.str("type") == "regex" && passes(g, cwd, before) == Some(false))
        .map(|g| g.file.clone())
        .collect()
}

/// A pattern that matches text and nothing else.
fn exact(text: &str) -> String {
    let escaped = Regex::new(r"[.*+?^${}()|\[\]\\]")
        .unwrap()
        .replace_all(text, r"\$0");
    format!("^{}$", escaped.replace('\n', r"\n"))
}

fn copy_dir(from: &Path, to: &Path) {
    for rel in listing(from) {
        let target = to.join(&rel);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(from.join(&rel), target).unwrap();
    }
}

fn node_run(cwd: &Path, script: &str) -> String {
    Command::new("node")
        .args(["--input-type=module", "-e", script])
        .current_dir(cwd)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|e| format!("node: {e}"))
}

/// Rounding three 3.33 lines: once is 8.99, per line 8.97. Only the
/// wrong-spec case may round per line: anywhere else the plant confounds the
/// triage.
const ROUNDING: &str = "import { addItem, total } from './lib/cart.js'; console.log(total(addItem(addItem(addItem([], 'a', 333), 'b', 333), 'c', 333), 'SAVE10'));";

/// What each triage report says happens, run against its own scaffold.
const REPORTS: [(&str, &str, &str); 5] = [
    (
        "triage-infra",
        "import { handleAdd } from './adapters/http.js'; console.log(handleAdd({ body: '{' }, []).status);",
        "500",
    ),
    (
        "triage-not-a-fix",
        "import { addItem, total } from './lib/cart.js'; console.log(total(addItem([], 'a', 1000), 'SAVE10'));",
        "900",
    ),
    (
        "triage-unspecified",
        "import { removeItem } from './lib/cart.js'; try { removeItem([], 'a'); console.log('no throw'); } catch (e) { console.log(e.constructor.name); }",
        "TypeError",
    ),
    (
        "triage-weak-test",
        "import { addItem, total } from './lib/cart.js'; console.log(total(addItem(addItem([], 'a', 100), 'a', 100)));",
        "100",
    ),
    ("triage-wrong-spec", ROUNDING, "897"),
];

/// The fields a fixture milestone leaves out on purpose.
const MILESTONE_OMITS: [(&str, &[&str]); 2] = [
    ("reviewer-approves-sound-plan", &[]),
    ("reviewer-requests-changes", &["Skills"]),
];

/// The sound plan says "write both REQ-named tests first and see them fail".
const REMOVE_TESTS: [(&str, &str); 2] = [
    (
        "REQ-CART-004",
        "test('REQ-CART-004 removing an item lowers its quantity and drops the line at zero', () => {\n  const cart = addItem(addItem([], 'a', 100), 'a', 100);\n  removeItem(cart, 'a');\n  assert.equal(cart[0].qty, 1);\n  removeItem(cart, 'a');\n  assert.equal(cart.length, 0);\n});",
    ),
    (
        "REQ-CART-005",
        "test('REQ-CART-005 removing an absent item leaves the cart unchanged', () => {\n  const cart = addItem([], 'a', 100);\n  assert.deepEqual(removeItem(cart, 'b'), [{ sku: 'a', price: 100, qty: 1 }]);\n});",
    ),
];

const TEST_HEAD: &str = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { addItem, removeItem } from '../lib/cart.js';\n\n";
const REMOVE_DONE: &str = "export function removeItem(cart, sku) {\n  const at = cart.findIndex((l) => l.sku === sku);\n  if (at === -1) return cart;\n  cart[at].qty -= 1;\n  if (cart[at].qty === 0) cart.splice(at, 1);\n  return cart;\n}";

type Edit = (String, &'static str, Box<dyn Fn(&str) -> String>);

/// What a triage told to "fix nothing" might write anyway: generic edits
/// reach every guarded file; the named ones are the fixes each report invites.
fn edits() -> Vec<Edit> {
    let mut out: Vec<Edit> = [
        "lib/cart.js",
        "adapters/http.js",
        "test/cart.test.js",
        "specs/cart.md",
    ]
    .into_iter()
    .map(|f| {
        (
            format!("a line added to {f}"),
            f,
            Box::new(|s: &str| format!("{s}\n// fixed\n")) as Box<dyn Fn(&str) -> String>,
        )
    })
    .collect();
    out.push(("a SyntaxError branch kept beside the 500".into(), "adapters/http.js", Box::new(|s| s.replacen("  } catch {\n", "  } catch (e) {\n    if (e instanceof SyntaxError) return { status: 400, body: 'bad request' };\n", 1))));
    out.push((
        "quantity multiplied into the total".into(),
        "lib/cart.js",
        Box::new(|s| {
            s.replacen("acc + l.price", "acc + l.price * l.qty", 1)
                .replacen("return sum + price;", "return sum + price * l.qty;", 1)
        }),
    ));
    out.push(("the missing two-unit case written into the suite".into(), "test/cart.test.js", Box::new(|s| format!("{s}\ntest('REQ-CART-002 two units of one item', () => {{\n  assert.equal(total(addItem(addItem([], 'a', 100), 'a', 100)), 200);\n}});\n"))));
    out.push((
        "REQ-CART-002 reworded".into(),
        "specs/cart.md",
        Box::new(|s| {
            s.replacen(
                "times its quantity",
                "times its quantity, every unit counted",
                1,
            )
        }),
    ));
    out.push((
        "a new test file".into(),
        "test/total.test.js",
        Box::new(|_| "import { test } from 'node:test';\n".into()),
    ));
    out
}

/// Graders that make each triage case itself; the rest are copies.
const PER_CASE: [&str; 2] = ["case.md", "work-order.md"];

fn have(tool: &str) -> bool {
    Command::new(tool)
        .arg("--version")
        .output()
        .is_ok_and(|o| o.status.success())
}

#[test]
fn evals() {
    if cfg!(windows) {
        eprintln!(
            "skipped: the scaffolds are bash, and a Windows runner does not promise which bash it finds"
        );
        return;
    }
    for tool in ["bash", "node"] {
        if !have(tool) {
            eprintln!("skipped: the eval scaffolds need {tool}");
            return;
        }
    }
    let root = repo();
    let evals = root.join("evals");
    let mut cases = read_cases(&evals);
    let mut errors: Vec<String> = Vec::new();
    let mut built: BTreeMap<String, Tree> = BTreeMap::new();
    for c in cases.iter().filter(|c| !c.scaffold.is_empty()) {
        let cwd = Tree::new([]);
        let out = Command::new("bash")
            .arg(c.dir.join(&c.scaffold))
            .current_dir(&cwd.0)
            .output()
            .unwrap();
        if !out.status.success() {
            errors.push(format!(
                "{} scaffolds: {}\n{}{}",
                c.name,
                out.status,
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            ));
            continue;
        }
        built.insert(c.name.clone(), cwd);
    }
    if std::env::var_os("SPEC_FLOW_EVALS_WRITE").is_some_and(|v| !v.is_empty()) {
        for c in &cases {
            let Some(cwd) = built.get(&c.name) else {
                continue;
            };
            for g in c.graders.iter().filter(|g| g.is_guard()) {
                let b = std::fs::read_to_string(cwd.0.join(g.target_str("path"))).unwrap();
                let quoted = format!("'{}'", exact(&b).replace('\'', "''"));
                std::fs::write(
                    &g.path,
                    PATTERN_LINE
                        .replace_all(&g.text, regex::NoExpand(&format!("pattern: {quoted}")))
                        .as_ref(),
                )
                .unwrap();
            }
        }
        cases = read_cases(&evals);
    }
    let template: Vec<String> =
        fence_after(&read_rel(&root, "agents/planner.md"), "milestones/Mk.md`**")
            .map(|t| {
                MILESTONE_FIELD
                    .captures_iter(t)
                    .map(|m| m[1].to_string())
                    .collect()
            })
            .unwrap_or_default();
    for c in &cases {
        let Some(cwd) = built.get(&c.name) else {
            continue;
        };
        let cwd = &cwd.0;
        let before = listing(cwd);
        let mut err = |e: String| errors.push(format!("{}: {e}", c.name));
        let wrong = failing(c, cwd, &before);
        if !wrong.is_empty() {
            err(format!(
                "{wrong:?} fail(s) before the agent has done anything, so it cannot tell a run that left the repo alone from one that did not"
            ));
        }
        for g in &c.graders {
            if g.is_guard() {
                let b = std::fs::read_to_string(cwd.join(g.target_str("path"))).unwrap_or_default();
                if g.str("pattern") != exact(&b) {
                    err(format!(
                        "{} accepts more than the scaffold's file, so an edit keeping the matched part passes. Run with SPEC_FLOW_EVALS_WRITE=1 after changing a fixture.",
                        g.file
                    ));
                }
            }
            if g.str("type") == "file_exists"
                && !matches!(g.fm.get("exists"), Some(Some(Val::Bool(_))))
            {
                err(format!("{} relies on the default `exists`", g.file));
            }
        }
        if c.triage {
            for (name, file, edit) in edits() {
                let copy = Tree::new([]);
                copy_dir(cwd, &copy.0);
                let p = copy.0.join(file);
                let was = std::fs::read_to_string(&p).unwrap_or_default();
                let now = edit(&was);
                if now == was {
                    err(format!(
                        "{name} changed nothing in {file}; it no longer fits the fixture"
                    ));
                    continue;
                }
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(&p, now).unwrap();
                if failing(c, &copy.0, &before).is_empty() {
                    err(format!(
                        "every grader still passes after {name}, so a triage that did it scores as one that fixed nothing"
                    ));
                }
            }
        }
        let omits = MILESTONE_OMITS
            .iter()
            .find(|(n, _)| *n == c.name)
            .map(|(_, o)| *o);
        if c.triage || omits.is_some() {
            let want = if c.name == "triage-wrong-spec" {
                "897"
            } else {
                "899"
            };
            let got = node_run(cwd, ROUNDING);
            if got != want {
                err(format!(
                    "three 3.33 lines with SAVE10 total {got:?} here, where {want} was expected"
                ));
            }
        }
        match REPORTS.iter().find(|(n, _, _)| *n == c.name) {
            Some((_, probe, want)) => {
                let got = node_run(cwd, probe);
                if got != *want {
                    err(format!(
                        "the bug report is not true of its scaffold: expected {want}, got {got:?}"
                    ));
                }
            }
            None if c.triage => err(
                "no report probe: add it to REPORTS, so its plant is checked like the others"
                    .into(),
            ),
            None => {}
        }
        if let Some(omits) = omits {
            let want: Vec<&String> = template
                .iter()
                .filter(|f| !omits.contains(&f.as_str()))
                .collect();
            let m1 = std::fs::read_to_string(cwd.join("specflow/remove-item/milestones/M1.md"))
                .unwrap_or_default();
            let got: Vec<String> = MILESTONE_FIELD
                .captures_iter(&m1)
                .map(|m| m[1].to_string())
                .collect();
            if template.is_empty() || got.iter().collect::<Vec<_>>() != want {
                err(format!(
                    "M1.md has {got:?}; the template less what this case omits is {want:?}"
                ));
            }
        }
        if c.name == "reviewer-approves-sound-plan" {
            let run_test = |body: &str| {
                std::fs::write(
                    cwd.join("test/remove.test.js"),
                    format!("{TEST_HEAD}{body}"),
                )
                .unwrap();
                Command::new("node")
                    .args(["--test", "test/remove.test.js"])
                    .current_dir(cwd)
                    .output()
                    .is_ok_and(|o| o.status.success())
            };
            for (id, body) in REMOVE_TESTS {
                if run_test(body) {
                    err(format!(
                        "{id} passes before removeItem changes, so \"see them fail\" cannot be followed"
                    ));
                }
            }
            let lib = cwd.join("lib/cart.js");
            let b = std::fs::read_to_string(&lib).unwrap();
            let built_lib = REMOVE_ITEM
                .replace(&b, regex::NoExpand(REMOVE_DONE))
                .into_owned();
            std::fs::write(&lib, built_lib).unwrap();
            for (id, body) in REMOVE_TESTS {
                if !run_test(body) {
                    err(format!(
                        "{id} still fails once removeItem is built, so it fails for some other reason"
                    ));
                }
            }
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}

#[test]
fn graders_copied_across_the_triage_cases_are_the_same_copy() {
    let cases = read_cases(&repo().join("evals"));
    let triage: Vec<&Case> = cases.iter().filter(|c| c.triage).collect();
    assert!(
        !triage.is_empty(),
        "no triage case was read: a comparison of nothing agrees forever"
    );
    let names: BTreeSet<&str> = triage
        .iter()
        .flat_map(|c| c.graders.iter().map(|g| g.file.as_str()))
        .collect();
    let mut errors = Vec::new();
    for file in names.into_iter().filter(|f| !PER_CASE.contains(f)) {
        let mut texts = BTreeSet::new();
        for c in &triage {
            let Some(g) = c.graders.iter().find(|g| g.file == file) else {
                errors.push(format!("{file} is missing from {}", c.name));
                continue;
            };
            texts.insert(if g.is_guard() {
                PATTERN_LINE.replace_all(&g.text, "").into_owned()
            } else {
                g.text.clone()
            });
        }
        if texts.len() > 1 {
            errors.push(format!("{file} differs between the triage cases"));
        }
    }
    assert!(errors.is_empty(), "{}", errors.join("\n"));
}

#[test]
fn every_fixture_sh_is_executable_in_the_index() {
    let Ok(out) = Command::new("git")
        .arg("-C")
        .arg(repo())
        .args(["ls-files", "-s", "--", "evals"])
        .output()
    else {
        eprintln!("skipped: not a git checkout");
        return;
    };
    let listed = String::from_utf8_lossy(&out.stdout);
    let wrong: Vec<&str> = listed
        .lines()
        .filter(|l| l.ends_with("/fixture.sh") && !l.starts_with("100755"))
        .filter_map(|l| l.split('\t').nth(1))
        .collect();
    assert!(wrong.is_empty(), "not executable: {wrong:?}");
}

/// Publishing is the CLI's default; the documented local run says so.
#[test]
fn the_documented_eval_run_keeps_its_report_local() {
    let text = read_rel(&repo(), "CLAUDE.md");
    let line = Regex::new("`(claude plugin eval [^`]*)`")
        .unwrap()
        .captures(&text)
        .map(|m| m[1].to_string())
        .expect("CLAUDE.md names no `claude plugin eval` command line to hold");
    assert!(
        line.contains("--no-publish"),
        "{line:?} publishes every run's report, prompts and transcripts included, to claude.ai"
    );
}

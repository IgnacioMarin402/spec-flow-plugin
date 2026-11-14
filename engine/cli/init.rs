//! `spec-flow init` generates the repository's `.spec-flow/config.json`, its
//! directories and its `.gitignore` lines. Nothing here guesses a value it
//! cannot support: every field lands in one of three buckets — detected
//! (read from what the repository declares), REVIEW (a heuristic, confirm
//! it), and MISSING (left empty, so the contract does not validate until a
//! human fills it). The runner comes from the repository's own `test` script
//! (ADR-002).

use std::collections::HashMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::jsre::Re;
use crate::payload::js_string;
use crate::repo::{contract, gitscope};
use crate::shell::argv;
use crate::state;

const SKIP_DIRS: [&str; 9] = [
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    "out",
    "vendor",
    ".claude",
];
const SOURCE_EXTENSIONS: [&str; 6] = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
/// Package managers precede the real binary as `<pm> run|exec <bin>`; only
/// that exact shape is stripped, since a bare `<pm> <word>` may be a script.
const PACKAGE_MANAGERS: [&str; 4] = ["npm", "pnpm", "yarn", "bun"];

/// A file's extension with its dot: from the base name's last `.`, else `""`.
fn ext(name: &str) -> &str {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base.rfind('.').map_or("", |i| &base[i..])
}

fn source_files(root: &Path, dir: &Path, found: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    for name in names {
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let full = dir.join(&name);
        // A dangling symlink is not a source file.
        let Ok(meta) = std::fs::metadata(&full) else {
            continue;
        };
        if meta.is_dir() {
            source_files(root, &full, found);
        } else if SOURCE_EXTENSIONS.contains(&ext(&name)) {
            found.push(
                full.strip_prefix(root)
                    .unwrap_or(&full)
                    .to_string_lossy()
                    .into_owned(),
            );
        }
    }
}

static SHELL_TOKEN: LazyLock<Re> =
    LazyLock::new(|| Re::new(r#"[^\S\n]+|'([^']*)'|"([^"]*)"|[^\s'"]+|[\s\S]"#, ""));
static BLANK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\t\x0C\r ]+$").unwrap());
static CHAIN_CHAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[&|;<>()\n]").unwrap());
static EXPAND_CHAR: LazyLock<Regex> = LazyLock::new(|| Regex::new("[$`\\\\]").unwrap());
static QUOTE_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"^["']$"#).unwrap());
static LEADING_ASSIGN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());

/// The words a shell would hand the runner, quotes removed, or why only a
/// shell can say. Keeping the quote characters reads as working: `--spec
/// "test/**/*.spec.js"` reaches the runner literally and matches no file.
fn shell_words(script: &str) -> Result<Vec<String>, &'static str> {
    let mut words = Vec::new();
    let mut word: Option<String> = None;
    for m in SHELL_TOKEN.exec_all(script) {
        let token = m.text();
        let quoted = m.has(1) || m.has(2);
        if !quoted && BLANK.is_match(token) {
            words.extend(word.take());
            continue;
        }
        if !quoted && CHAIN_CHAR.is_match(token) {
            return Err("it chains or redirects commands, so it is not one runner invocation");
        }
        let inside = if quoted { m.group(2) } else { token };
        if QUOTE_ONLY.is_match(token)
            || EXPAND_CHAR.is_match(inside)
            || (!quoted && word.is_none() && token.starts_with('#'))
        {
            return Err(
                "it expands something only a shell can: a $, a backquote, a backslash, a comment or a quote that does not close",
            );
        }
        let part = if m.has(1) {
            m.group(1)
        } else if m.has(2) {
            m.group(2)
        } else {
            token
        };
        word = Some(word.unwrap_or_default() + part);
    }
    words.extend(word);
    if words.first().is_some_and(|w| LEADING_ASSIGN.is_match(w)) {
        return Err("it sets an environment variable ahead of the command, which takes a shell");
    }
    Ok(words)
}

#[derive(Clone)]
struct Script {
    bin: String,
    args: Vec<String>,
    /// The bin is the runner's name, not an interpreter's.
    named: bool,
}

fn parse_script(words: &[String]) -> Option<Script> {
    let mut t: &[String] = words;
    if t.first().is_some_and(|w| w == "npx") {
        t = &t[1..];
    }
    if t.len() > 1 && PACKAGE_MANAGERS.contains(&t[0].as_str()) && (t[1] == "run" || t[1] == "exec")
    {
        t = &t[2..];
    }
    while t.first().is_some_and(|w| w == "--") {
        t = &t[1..];
    }
    let (bin, args) = t.split_first()?;
    // `bun test`: the runtime IS the runner, and the name is real.
    Some(Script {
        bin: bin.clone(),
        args: args.to_vec(),
        named: !argv::is_runtime(bin) || args.first().is_some_and(|a| a == "test"),
    })
}

fn scripts_of(pkg: &Map<String, Value>) -> HashMap<String, String> {
    pkg.get("scripts")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k.clone(), js_string(Some(v))))
                .collect()
        })
        .unwrap_or_default()
}

/// The script `name`, parsed for the contract, or why it cannot be. A package
/// manager or another script's name, spawned with no shell, fails at every
/// gate.
fn read_script(scripts: &HashMap<String, String>, name: &str) -> (Option<Script>, String) {
    let s = scripts.get(name).map(String::as_str).unwrap_or_default();
    if s.is_empty() {
        return (None, String::new());
    }
    let words = match shell_words(s) {
        Ok(w) => w,
        Err(why) => return (None, why.into()),
    };
    let Some(parsed) = parse_script(&words) else {
        return (None, "it names no command".into());
    };
    if (PACKAGE_MANAGERS.contains(&parsed.bin.as_str()) && !argv::is_runtime(&parsed.bin))
        || scripts.contains_key(&parsed.bin)
    {
        return (None, "it runs a package script through the package manager, and this engine spawns one command with no shell".into());
    }
    (Some(parsed), String::new())
}

struct Argv {
    argv: Vec<String>,
    stripped: Vec<String>,
    remaining: Vec<String>,
}

/// The local binary preferred, past the `.bin` shim (ADR-011). Targets are
/// stripped for the two argvs the engine APPENDS changed paths to: `eslint .
/// <changed-file>` lints the whole repository, a disarmed scope.
fn to_argv(root: &Path, s: &Script, strip: bool) -> Argv {
    let mut a = Argv {
        argv: s.args.clone(),
        stripped: Vec::new(),
        remaining: Vec::new(),
    };
    if strip {
        let st = argv::strip_targets(&s.args, root);
        (a.argv, a.stripped, a.remaining) = (st.kept, st.stripped, st.remaining);
    }
    let entry = argv::resolve_local_bin(root, &s.bin);
    let head = if entry.is_empty() {
        vec![s.bin.clone()]
    } else {
        vec!["node".to_string(), entry]
    };
    a.argv = head.into_iter().chain(a.argv).collect();
    a
}

/// The flags with which a Node linter writes its fixes; each takes no value.
const AUTOFIX_FLAGS: [&str; 2] = ["--fix", "--write"];

fn without_autofix(s: &Script) -> Script {
    Script {
        args: s
            .args
            .iter()
            .filter(|a| !AUTOFIX_FLAGS.contains(&a.as_str()))
            .cloned()
            .collect(),
        ..s.clone()
    }
}

fn autofix_of(s: &Script) -> Vec<String> {
    s.args
        .iter()
        .filter(|a| AUTOFIX_FLAGS.contains(&a.as_str()))
        .cloned()
        .collect()
}

fn find_config_file(root: &Path, bin: &str) -> String {
    if bin.is_empty() {
        return String::new();
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return String::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect();
    names.sort();
    names
        .into_iter()
        .find(|n| {
            let l = n.to_lowercase();
            l.starts_with(&format!("{bin}.config."))
                || l.starts_with(&format!(".{bin}rc"))
                || l == format!("{bin}.json")
        })
        .unwrap_or_default()
}

/// Keys counted in first-seen order, ranked most first, ties in that order.
fn rank(items: impl IntoIterator<Item = String>) -> (Vec<String>, HashMap<String, usize>) {
    let (mut order, mut counts): (Vec<String>, HashMap<String, usize>) =
        (Vec::new(), HashMap::new());
    for k in items {
        if !counts.contains_key(&k) {
            order.push(k.clone());
        }
        *counts.entry(k).or_default() += 1;
    }
    order.sort_by(|a, b| counts[b].cmp(&counts[a]));
    (order, counts)
}

/// The source extensions carrying real weight, capped.
fn detect_scope_globs(files: &[String]) -> Vec<String> {
    let (ranked, counts) = rank(files.iter().map(|f| ext(f).to_string()));
    ranked
        .into_iter()
        .filter(|e| counts[e] >= 3)
        .take(4)
        .map(|e| format!("*{e}"))
        .collect()
}

static TEST_SUFFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)(\.(?:test|spec)\.[a-z]+)$").unwrap());

fn test_suffix(f: &str) -> String {
    TEST_SUFFIX
        .captures(f)
        .map_or_else(String::new, |m| m[1].to_lowercase())
}

/// Where tests live, as a directory SEGMENT and a suffix. A segment in test
/// paths and no other identifies a test by itself; with none exclusive, the
/// most common is offered for REVIEW.
fn detect_proof(files: &[String]) -> (String, String, bool) {
    let (tests, others): (Vec<&String>, Vec<&String>) =
        files.iter().partition(|f| !test_suffix(f).is_empty());
    if tests.is_empty() {
        return (String::new(), String::new(), false);
    }
    let suffix = rank(tests.iter().map(|f| test_suffix(f))).0.remove(0);
    let segments = |f: &str| -> Vec<String> {
        let parts: Vec<&str> = f.split(std::path::MAIN_SEPARATOR).collect();
        parts[..parts.len() - 1]
            .iter()
            .map(|s| s.to_string())
            .collect()
    };
    let in_tests = tests.iter().flat_map(|f| {
        let mut seen: Vec<String> = Vec::new();
        for s in segments(f) {
            if !seen.contains(&s) {
                seen.push(s);
            }
        }
        seen
    });
    let (ranked, _) = rank(in_tests);
    let in_others: Vec<String> = others.iter().flat_map(|f| segments(f)).collect();
    if let Some(s) = ranked.iter().find(|s| !in_others.contains(s)) {
        return (suffix, s.clone(), true);
    }
    match ranked.first() {
        Some(s) => (suffix, s.clone(), false),
        None => (suffix, String::new(), false),
    }
}

fn detect_package_manager(root: &Path) -> &'static str {
    [
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
    ]
    .iter()
    .find(|(f, _)| root.join(f).exists())
    .map_or("npm", |(_, pm)| pm)
}

/// `.` and `..` resolved as text, `/`-separated; `"."` when nothing is left.
fn clean_posix(p: &str) -> String {
    let rooted = p.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for part in p.split('/') {
        match part {
            "" | "." => {}
            ".." if out.last().is_some_and(|l| *l != "..") => {
                out.pop();
            }
            ".." if rooted => {}
            part => out.push(part),
        }
    }
    let joined = out.join("/");
    match (rooted, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".into(),
        (false, false) => joined,
    }
}

/// Where jest-junit writes when the gate runs it from the root: its
/// "jest-junit" key in package.json, else junit.xml. `None` when the key names
/// a path only jest resolves.
fn jest_junit_path(pkg: &Map<String, Value>) -> Option<String> {
    let opts = pkg.get("jest-junit").and_then(Value::as_object);
    let s = |k: &str, def: &str| match opts.and_then(|o| o.get(k)) {
        Some(v) if !v.is_null() => js_string(Some(v)),
        _ => def.to_string(),
    };
    if s("uniqueOutputName", "") == "true" {
        return None;
    }
    let (dir, name) = (s("outputDirectory", "."), s("outputName", "junit.xml"));
    let joined = if dir.is_empty() {
        name
    } else {
        format!("{dir}/{name}")
    };
    let p = s("outputFile", &joined);
    if p.contains("<rootDir>") {
        return None;
    }
    Some(clean_posix(&p.replace('\\', "/")))
}

/// How a supported runner is told to write a report. This table is what
/// ADR-002 refused and ADR-007 allows back, small on purpose: every entry was
/// verified by running the runner and reading the file it wrote.
fn reporter_argv(runner: &str, path: &str) -> Option<Vec<String>> {
    let v: Vec<String> = match runner {
        "vitest" => vec!["--reporter=junit".into(), format!("--outputFile={path}")],
        "mocha" => vec![
            "--reporter".into(),
            "xunit".into(),
            "--reporter-option".into(),
            format!("output={path}"),
        ],
        "node" => vec![
            "--test-reporter=junit".into(),
            format!("--test-reporter-destination={path}"),
        ],
        "jest" => vec![
            "--reporters=default".into(),
            "--reporters=jest-junit".into(),
        ],
        _ => return None,
    };
    Some(v)
}

const JEST_UNREADABLE: &str = r#"the "jest-junit" key in package.json names a path only jest resolves (<rootDir>, or a unique name)"#;

fn jest_note(p: &str) -> String {
    format!(
        r#"jest reports through a separate package: install jest-junit as a devDependency. "{p}" is where it writes as this repo sets it — its "jest-junit" key in package.json, or junit.xml where jest runs — so the repo's own runs report where they did. The flag alone will not write the file, which is why this is the one entry that cannot be finished from argv."#
    )
}

/// `"test": "node --test"` names its runner only by the flag.
fn reporter_key(test: &[String], test_name: &str) -> String {
    if !test_name.is_empty() && reporter_argv(test_name, "").is_some() {
        return test_name.into();
    }
    if test.first().is_some_and(|t| argv::basename(t) == "node")
        && test.iter().any(|t| t == "--test")
    {
        return "node".into();
    }
    String::new()
}

static XML_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.xml$").unwrap());

/// A report PATH the test command already names — a fact about this
/// repository, not one runner's flag spelling.
fn detect_report_path(test: &[String]) -> String {
    test.iter()
        .map(|t| t.split_once('=').map_or(t.as_str(), |(_, v)| v))
        .find(|v| XML_PATH.is_match(v) && !v.starts_with('-'))
        .map_or_else(String::new, |v| v.replace('\\', "/"))
}

fn quote_each(list: &[String]) -> String {
    list.iter()
        .map(|s| format!("\"{s}\""))
        .collect::<Vec<_>>()
        .join(", ")
}

fn unique_of(a: &[String], b: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for s in a.iter().chain(b) {
        if !out.contains(s) {
            out.push(s.clone());
        }
    }
    out
}

#[derive(Serialize)]
struct ExtraCheck {
    name: String,
    field: String,
    cmd: Vec<String>,
    green: String,
    hint: String,
}

/// The contract as written, field order as a reader expects it.
#[derive(Serialize, Default)]
struct ContractFile {
    contract_version: u32,
    verify: VerifyFile,
    trace: TraceFile,
    extra_checks: Vec<ExtraCheck>,
    unscoped_denied: DeniedFile,
}

#[derive(Serialize, Default)]
struct VerifyFile {
    scope_globs: Vec<String>,
    lint: Vec<String>,
    lint_no_fix: Vec<String>,
    test: Vec<String>,
    test_name: String,
    lint_name: String,
    lint_config_hint: String,
}

#[derive(Serialize, Default)]
struct TraceFile {
    specs_dir: String,
    proof_dir: String,
    proof_suffix: String,
    /// The engine parses this file itself; `executed_tests` is absent, not
    /// empty: the contract rejects declaring both.
    report: ReportFile,
    not_a_capability: Vec<String>,
    /// Written at its default so the choice is visible in the file.
    require_skills_field: bool,
}

#[derive(Serialize, Default)]
struct ReportFile {
    format: String,
    path: String,
}

#[derive(Serialize, Default)]
struct DeniedFile {
    scripts: Vec<String>,
    tools: Vec<String>,
    scoped_allowed: Vec<String>,
    scoped_alternative: String,
    scoped_examples: Vec<String>,
}

#[derive(Default)]
struct Found {
    detected: Vec<String>,
    review: Vec<String>,
    missing: Vec<String>,
}

/// The contract for `root` and what each field came from.
fn build_contract(root: &Path) -> (ContractFile, Found) {
    let pkg: Map<String, Value> = std::fs::read(root.join("package.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    let scripts = scripts_of(&pkg);
    let mut files = Vec::new();
    source_files(root, root, &mut files);
    let pm = detect_package_manager(root);
    let mut f = Found::default();

    // --- test runner
    let (mut test, mut test_name) = (Vec::new(), String::new());
    let (test_script, test_why) = read_script(&scripts, "test");
    if let Some(ts) = &test_script {
        test = to_argv(root, ts, false).argv;
        f.detected.push(format!(
            "verify.test — from the \"test\" script: {}",
            test.join(" ")
        ));
        if ts.named {
            test_name = ts.bin.clone();
        } else if reporter_key(&test, "") == "node" {
            // The pair is its name: run-trace spots `node --test …`, not `node script.mjs`.
            test_name = "node --test".into();
            f.detected.push("verify.test_name — node --test: node's own test runner, named with the flag that makes it one".into());
        } else {
            f.missing.push(format!("verify.test_name — the test script runs through \"{}\", an interpreter rather than a runner, so nothing here can name what actually runs your tests. It labels the gate's log sections and is matched against Bash commands to spot a test run, so a wrong value is worse than an empty one.", ts.bin));
        }
    } else if !test_why.is_empty() {
        f.missing.push(format!("verify.test and verify.test_name — the \"test\" script ({}) could not be read: {test_why}. Write the argv by hand, one token per array element and no quotes around any of them.", scripts["test"]));
    } else {
        f.missing.push("verify.test and verify.test_name — no single-command \"test\" script to read them from.".into());
    }

    // --- linter. An autofix variant only when the repository declares one,
    // and only when it runs the lint script's own command: a formatter in
    // "format" would run at every gate in the linter's place.
    let (lint_script, lint_why) = read_script(&scripts, "lint");
    let has = |k: &str| scripts.get(k).is_some_and(|s| !s.is_empty());
    let fix_name = if has("lint:fix") {
        "lint:fix"
    } else if has("format") {
        "format"
    } else {
        ""
    };
    let (declared_fix, fix_why) = if fix_name.is_empty() {
        (None, String::new())
    } else {
        read_script(&scripts, fix_name)
    };
    let command = |s: &Script| {
        let kept = argv::strip_targets(&without_autofix(s).args, root).kept;
        std::iter::once(s.bin.clone())
            .chain(kept)
            .collect::<Vec<_>>()
            .join("\0")
    };
    let fix_script = declared_fix.clone().filter(|df| match &lint_script {
        Some(ls) => command(df) == command(ls),
        None => fix_name == "lint:fix",
    });
    let (base, base_name) = match (&lint_script, &fix_script) {
        (Some(ls), _) => (Some(ls.clone()), "lint"),
        (None, Some(fs)) => (Some(fs.clone()), fix_name),
        _ => (None, "lint"),
    };
    let (mut lint, mut lint_no_fix, mut lint_name) = (Vec::new(), Vec::new(), String::new());
    if let Some(base) = &base {
        if base.named {
            lint_name = base.bin.clone();
        } else {
            f.missing.push(format!("verify.lint_name — the lint script runs through \"{}\", an interpreter rather than a linter, so nothing here can name it.", base.bin));
        }
        // A script that already writes fixes cannot be the report-only
        // variant: `spec-flow check --no-fix` would rewrite files and pass.
        let carried = autofix_of(base);
        let no_fix = to_argv(root, &without_autofix(base), true);
        let with_fix = match &fix_script {
            Some(fs) => {
                let mut w = to_argv(root, &without_autofix(fs), true);
                w.argv.extend(autofix_of(fs));
                w
            }
            None => Argv {
                argv: no_fix.argv.clone(),
                stripped: no_fix.stripped.clone(),
                remaining: no_fix.remaining.clone(),
            },
        };
        lint_no_fix = no_fix.argv.clone();
        lint = if fix_script.is_some() {
            with_fix.argv.clone()
        } else {
            no_fix.argv.iter().chain(&carried).cloned().collect()
        };
        let stripped = unique_of(&no_fix.stripped, &with_fix.stripped);
        if !stripped.is_empty() {
            f.review.push(format!("verify.lint dropped the target(s) {} from your lint script. The engine appends the changed files itself, and leaving a target in would lint the whole repo on every gate — which silently undoes the scoping that keeps a milestone from being blocked by debt it never touched. Confirm this is still the linter invocation you want.", quote_each(&stripped)));
        }
        // After a flag a path cannot be told from that flag's value: left,
        // and said.
        let remaining = unique_of(&no_fix.remaining, &with_fix.remaining);
        if !remaining.is_empty() {
            f.review.push(format!("verify.lint still contains {}, which follows a flag — so it may be that flag's value, or it may be a target. If it is a target, remove it: the engine appends the changed files itself, and a target left in makes every gate lint the whole repo instead of the branch's changes.", quote_each(&remaining)));
        }
        if carried.is_empty() {
            f.detected.push(format!(
                "verify.lint_no_fix — from the \"{base_name}\" script: {}",
                lint_no_fix.join(" ")
            ));
        } else {
            f.review.push(format!("verify.lint_no_fix — the \"{base_name}\" script carries {}, so it writes fixes; that flag was left out of the report-only variant spec-flow check --no-fix runs: {}. Confirm it reports without writing.", carried.join(", "), lint_no_fix.join(" ")));
        }
        let fix_is_base = fix_script.is_some() && lint_script.is_none();
        if fix_name == "lint:fix" && !fix_why.is_empty() {
            f.review.push(format!("verify.lint — the \"lint:fix\" script ({}) could not be read as the autofix: {fix_why}. Add the flag to verify.lint by hand if it is one.", scripts["lint:fix"]));
        } else if declared_fix.is_some() && fix_script.is_none() {
            f.review.push(format!("verify.lint — the \"{fix_name}\" script ({}) is not the \"lint\" script with an autofix flag, so it was not taken as the linter's autofix: {}.", scripts[fix_name], lint.join(" ")));
        } else if fix_script.is_some() && !fix_is_base {
            f.detected.push(format!(
                "verify.lint — from the autofix script: {}",
                lint.join(" ")
            ));
        } else if !carried.is_empty() {
            f.detected.push(format!(
                "verify.lint — from the \"{base_name}\" script, which already fixes: {}",
                lint.join(" ")
            ));
        } else {
            f.review.push("verify.lint is identical to verify.lint_no_fix — no autofix script was declared. If your linter supports one (commonly --fix), add it to verify.lint so the gate stops reporting violations it could have fixed.".into());
        }
    } else {
        let why = if lint_why.is_empty() && fix_name == "lint:fix" {
            fix_why.clone()
        } else {
            lint_why.clone()
        };
        if !why.is_empty() {
            f.missing.push(format!("verify.lint, verify.lint_no_fix and verify.lint_name — the lint script could not be read: {why}. Write the argv by hand, one token per array element and no quotes around any of them."));
        } else {
            let tail = if fix_name == "format" {
                r#" ("format" is not read as one: it may run a formatter)"#
            } else {
                ""
            };
            f.missing.push(format!("verify.lint, verify.lint_no_fix and verify.lint_name — no single-command \"lint\" script to read them from{tail}."));
        }
    }
    let hint = find_config_file(root, &lint_name);
    if !hint.is_empty() {
        f.detected
            .push(format!("verify.lint_config_hint — found {hint}"));
    } else if !lint_name.is_empty() {
        f.missing.push(
            "verify.lint_config_hint — no config file for the linter was found in the repo root."
                .into(),
        );
    } else {
        f.missing.push(
            "verify.lint_config_hint — depends on the linter, which was not detected.".into(),
        );
    }

    // --- build and typecheck: REVIEW either way — optional, and whether one
    // belongs at every gate is the adopter's call.
    let mut extras = Vec::new();
    for name in ["build", "typecheck"] {
        if !has(name) {
            continue;
        }
        let (parsed, why) = read_script(&scripts, name);
        let Some(parsed) = parsed else {
            f.review.push(format!("extra_checks — the \"{name}\" script ({}) was not offered: {why}. Nothing runs it during a run; to have one, add an entry by hand, one argv token per array element and no quotes around any of them.", scripts[name]));
            continue;
        };
        let cmd = to_argv(root, &parsed, false).argv;
        let mut msg = format!(
            "extra_checks — offered \"{name}\" from the \"{name}\" script: {}. It runs at every gate, at done and in spec-flow check, inside the same Stop-hook time budget as the suite. Remove it if it needs a database, a network or a running app.",
            cmd.join(" ")
        );
        if name == "build" {
            msg += " What it writes must be gitignored: any output git sees reads as an unfinished write at the next stop, and that gate is skipped.";
        }
        f.review.push(msg);
        extras.push(ExtraCheck {
            name: name.into(),
            field: name.into(),
            cmd,
            green: format!("(the \"{name}\" script passes)"),
            hint: format!("The repo's \"{name}\" script fails: fix what it reports."),
        });
    }

    let scope = detect_scope_globs(&files);
    if scope.is_empty() {
        f.missing
            .push("verify.scope_globs — no source extension had enough files to infer one.".into());
    } else {
        f.detected.push(format!(
            "verify.scope_globs — {}, from the files in this repo",
            scope.join(", ")
        ));
    }
    if gitscope::resolve_base(root, None).is_ok() {
        f.detected
            .push("verify.base_ref — omitted: the base branch resolves automatically here".into());
    } else {
        f.missing.push(r#"verify.base_ref — no base branch could be resolved. Set it to the ref this work is judged against, e.g. "origin/trunk"."#.into());
    }
    let (suffix, dir, confident) = detect_proof(&files);
    if !suffix.is_empty() && confident {
        f.detected.push(format!(
            "trace.proof_dir and trace.proof_suffix — \"{dir}\" + \"{suffix}\""
        ));
    } else if !suffix.is_empty() {
        f.review.push(format!("trace.proof_dir is \"{dir}\" — a guess. Your tests are not in a directory of their own, so no segment identifies one. This is also where agents are told to PUT new tests, so confirm it."));
    } else {
        f.missing.push("trace.proof_dir and trace.proof_suffix — no test files were found. These say what a proof file looks like AND where agents put new ones.".into());
    }

    // --- how this repository reports what RAN: REVIEW, never MISSING — a
    // repository with no requirement yet owes nothing (ADR-005). The flag is
    // APPENDED, not described: a flag a human still has to type is the step
    // the table exists to remove.
    let named = detect_report_path(&test);
    let runner = if named.is_empty() {
        reporter_key(&test, &test_name)
    } else {
        String::new()
    };
    let has_flag = reporter_argv(&runner, "").is_some();
    let mut report_path = named.clone();
    let mut runner_unreadable = false;
    if report_path.is_empty() && runner == "jest" {
        match jest_junit_path(&pkg) {
            Some(p) => report_path = p,
            None => runner_unreadable = true,
        }
    }
    if report_path.is_empty() {
        report_path = "reports/junit.xml".into();
    }
    if runner_unreadable {
        f.missing.push(format!("trace.report.path — {JEST_UNREADABLE}, so nothing here can read where the report lands. Set it to the file {runner} writes."));
    }
    if !named.is_empty() {
        f.review.push(format!(r#"trace.report — your test command already names "{named}", so the contract points at it and assumes JUnit XML. Confirm that is what lands there; if it is TAP, change the format to "tap"."#));
    } else if has_flag {
        let added = reporter_argv(&runner, &report_path).unwrap_or_default();
        test.extend(added.iter().cloned());
        let note = if runner == "jest" {
            format!(" {}", jest_note(&report_path))
        } else {
            String::new()
        };
        f.review.push(format!("verify.test — appended `{}` so {runner} writes the report the traceability check reads. Run your suite once and confirm \"{report_path}\" appears.{note}", added.join(" ")));
    } else {
        let because = if test_name.is_empty() {
            String::new()
        } else {
            format!(
                ", because \"{test_name}\" is not a runner this version knows the reporter flag for"
            )
        };
        f.review.push(format!("trace.report — set to \"{report_path}\", a convention rather than a reading{because}. \
             Add your runner's flag to verify.test so a JUnit XML (or TAP) report lands there — the format is what tells a skipped test from an executed one. \
             Until it lands, traceability is off — the gate still lints and tests, and spec-trace refuses the moment specs/ declares a requirement it cannot prove. \
             A runner with no standard report uses trace.executed_tests instead: see REFERENCE.md."));
    }

    // no-gate-cmds compares one token at a time: `node --test` could never
    // match, and `node` alone would deny every node command.
    let tools: Vec<String> = [&test_name, &lint_name]
        .into_iter()
        .filter(|n| !n.is_empty() && !n.contains([' ', '\t']))
        .cloned()
        .collect();
    let c = ContractFile {
        contract_version: 1,
        verify: VerifyFile {
            scope_globs: scope,
            lint,
            lint_no_fix,
            test,
            test_name,
            lint_name,
            lint_config_hint: hint,
        },
        trace: TraceFile {
            specs_dir: "specs".into(),
            proof_dir: dir,
            proof_suffix: suffix,
            report: ReportFile {
                format: "junit".into(),
                path: report_path,
            },
            not_a_capability: vec!["README.md".into(), "glossary.md".into()],
            require_skills_field: false,
        },
        extra_checks: extras,
        unscoped_denied: DeniedFile {
            scripts: ["test", "lint"]
                .iter()
                .filter(|s| has(s))
                .map(|s| s.to_string())
                .collect(),
            tools,
            scoped_allowed: vec!["check".into()],
            scoped_alternative: format!("{pm} run check"),
            scoped_examples: vec![
                format!("{pm} run check"),
                format!("{pm} run check --no-fix"),
            ],
        },
    };
    (c, f)
}

const SPECS_README: &str = r####"# Capability specs

One file per capability, describing what the system does **today** as numbered
requirements. `specs/` is the source of truth for behaviour; a change under
`specflow/` is a delta against it.

`spec-trace` enforces the rules below at every gate, in both directions: a
requirement with no test fails, and a test naming an id no spec declares fails
too.

## The file

Each spec starts with a scope marker naming the code it is about:

```markdown
<!-- spec-scope: modules/user -->

# User

### REQ-USER-001 — the user can reset their password by email

The system sends a single-use link, valid for one hour.
```

## The rules

- **The id prefix comes from the filename.** `specs/user.md` declares
  `REQ-USER-` ids; `specs/user-profile.md` declares `REQ-USER-PROFILE-`.
  A mismatch fails.
- **The number is exactly three digits.** `REQ-USER-001`, not `REQ-USER-1`.
- **Requirements are headings**, at `###`, with the id first. The separator
  after it may be an em dash, a hyphen or a colon.
- **Ids are permanent.** Never renumber, never reuse a removed one. New ids
  continue that capability's sequence.
- **Every requirement needs a test whose TITLE contains its id**, on the proof
  surface `.spec-flow/config.json` declares (`trace.proof_dir` +
  `trace.proof_suffix`). A test under `it.skip`, `it.todo`, `xit` or
  `xtest` does not count — a test that never executes proves nothing.
- **Write in the present tense**: what the system does, not what a change did.

This file is excluded from the check by `trace.not_a_capability`, so it is
documentation rather than a spec.
"####;

const TRANSLATOR: &str = r####"#!/usr/bin/env node
// Tells spec-flow which tests actually RAN.
//
// The contract is one line per executed test, on stdout, each line containing
// that test's name. A requirement counts as proven when a reported line
// contains its id (REQ-USER-001). Nothing else is read: not the exit code, not
// the format, not where the test file lives.
//
// TWO RULES, and the second is the one that matters:
//
//   1. Lines must carry test NAMES, since ids are matched inside them. An id
//      may sit against underscores — REQ-USER-001_rejects binds fine.
//   2. A test that was SKIPPED must not appear. That absence is what makes
//      skipping useless as a way to silence a red suite, and it is why the
//      rule holds in any language.
//
// This runs AFTER the suite, in the same gate invocation, so it should read
// what that run produced rather than run the tests again.
//
// ---------------------------------------------------------------------------
// TODO — this is the part only you can write. It was left empty on purpose:
// every runner can report what it executed and no two agree on how, so a
// guess here would produce a command that runs and reports nothing.
//
// For {{RUNNER}}: find the reporter flag that writes a machine-readable report
// (most runners have one — JUnit XML, JSON, TAP), have your test command emit
// it, then read that file here and print one line per test that RAN.
// ---------------------------------------------------------------------------

function testsThatRan() {
  // Return an array of strings, one per executed test, e.g.
  //   ['tests/auth_test::REQ-USER-001 rejects a bad password']
  return null; // <- replace this
}

const names = testsThatRan();

if (names === null) {
  console.error(
    'spec-flow: .spec-flow/tests-that-ran.mjs has not been written yet.\n' +
      'Until it reports the tests that ran, no requirement can be proven — and this\n' +
      'fails loudly rather than reporting your specs as unproven, which would be the\n' +
      'same mistake this check exists to catch. See REFERENCE.md, "executed_tests".',
  );
  process.exit(1);
}

for (const name of names) console.log(name);
"####;

/// The `trace.executed_tests` translator, scaffolded into the adopting
/// repository for a runner with no standard report. Not silent when
/// unfinished: a stub reporting nothing would make every requirement unproven
/// at the first gate.
fn translator_stub(test_name: &str) -> String {
    let runner = if test_name.is_empty() {
        "your test runner".into()
    } else {
        format!("`{test_name}`")
    };
    TRANSLATOR.replace("{{RUNNER}}", &runner)
}

// ---- package.json, rewritten in its own order --------------------------------

/// A JSON value with its keys in the order written, its scalars as written.
enum Node {
    Obj(Vec<(String, Node)>),
    Arr(Vec<Node>),
    /// A string, decoded; it is written again by `json_string`.
    Str(String),
    /// A number, `true`, `false` or `null`, as written.
    Raw(String),
}

/// Parses JSON already known to be valid, keeping key order.
fn parse_ordered(s: &[u8], at: &mut usize) -> Node {
    let skip = |at: &mut usize| {
        while *at < s.len() && s[*at].is_ascii_whitespace() {
            *at += 1;
        }
    };
    skip(at);
    match s[*at] {
        b'{' => {
            *at += 1;
            let mut members: Vec<(String, Node)> = Vec::new();
            loop {
                skip(at);
                if s[*at] == b'}' {
                    *at += 1;
                    break;
                }
                let Node::Str(k) = parse_ordered(s, at) else {
                    unreachable!()
                };
                skip(at);
                *at += 1; // ':'
                let v = parse_ordered(s, at);
                // A repeated key keeps its first place and its last value.
                match members.iter_mut().find(|(mk, _)| *mk == k) {
                    Some(m) => m.1 = v,
                    None => members.push((k, v)),
                }
                skip(at);
                if s[*at] == b',' {
                    *at += 1;
                }
            }
            Node::Obj(members)
        }
        b'[' => {
            *at += 1;
            let mut items = Vec::new();
            loop {
                skip(at);
                if s[*at] == b']' {
                    *at += 1;
                    break;
                }
                items.push(parse_ordered(s, at));
                skip(at);
                if s[*at] == b',' {
                    *at += 1;
                }
            }
            Node::Arr(items)
        }
        b'"' => {
            let from = *at;
            *at += 1;
            while s[*at] != b'"' {
                *at += if s[*at] == b'\\' { 2 } else { 1 };
            }
            *at += 1;
            Node::Str(serde_json::from_slice(&s[from..*at]).unwrap_or_default())
        }
        _ => {
            let from = *at;
            while *at < s.len() && !b",}] \t\r\n".contains(&s[*at]) {
                *at += 1;
            }
            Node::Raw(String::from_utf8_lossy(&s[from..*at]).into_owned())
        }
    }
}

/// A string as JSON, `<`, `>` and `&` as they are, U+2028 and U+2029
/// escaped: the bytes `init` has always written into `package.json`.
fn json_string(s: &str) -> String {
    serde_json::to_string(s)
        .unwrap_or_default()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

/// `v` as `JSON.stringify(v, null, indent)` writes it.
fn write_ordered(out: &mut String, v: &Node, indent: &str, at: &str) {
    let inner = format!("{at}{indent}");
    match v {
        Node::Obj(m) if m.is_empty() => out.push_str("{}"),
        Node::Arr(a) if a.is_empty() => out.push_str("[]"),
        Node::Obj(m) => {
            out.push_str("{\n");
            for (i, (k, v)) in m.iter().enumerate() {
                out.push_str(&inner);
                out.push_str(&json_string(k));
                out.push_str(": ");
                write_ordered(out, v, indent, &inner);
                out.push_str(if i + 1 < m.len() { ",\n" } else { "\n" });
            }
            out.push_str(at);
            out.push('}');
        }
        Node::Arr(a) => {
            out.push_str("[\n");
            for (i, v) in a.iter().enumerate() {
                out.push_str(&inner);
                write_ordered(out, v, indent, &inner);
                out.push_str(if i + 1 < a.len() { ",\n" } else { "\n" });
            }
            out.push_str(at);
            out.push(']');
        }
        Node::Str(s) => out.push_str(&json_string(s)),
        Node::Raw(r) => out.push_str(r),
    }
}

/// `raw` with `scripts[name] = value` inserted, keeping its key order and
/// indentation as `JSON.stringify(pkg, null, indent)` would.
fn add_script(raw: &[u8], name: &str, value: &str, indent: &str) -> Option<String> {
    serde_json::from_slice::<Value>(raw).ok()?.as_object()?;
    let mut at = 0;
    let Node::Obj(mut members) = parse_ordered(raw, &mut at) else {
        return None;
    };
    let script = (name.to_string(), Node::Str(value.into()));
    match members.iter_mut().find(|(k, _)| k == "scripts") {
        Some((_, Node::Obj(scripts))) => match scripts.iter_mut().find(|(k, _)| k == name) {
            Some(s) => *s = script,
            None => scripts.push(script),
        },
        Some(other) => other.1 = Node::Obj(vec![script]),
        None => members.push(("scripts".into(), Node::Obj(vec![script]))),
    }
    let mut out = String::new();
    write_ordered(&mut out, &Node::Obj(members), indent, "");
    out.push('\n');
    Some(out)
}

static INDENT: LazyLock<regex::bytes::Regex> =
    LazyLock::new(|| regex::bytes::Regex::new("\n([ \t]+)\"").unwrap());

/// Whether a program of this name is on PATH.
fn on_path(name: &str) -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| {
        let candidates: Vec<std::path::PathBuf> = if cfg!(windows) {
            [".exe", ".cmd", ".bat", ""]
                .iter()
                .map(|e| dir.join(format!("{name}{e}")))
                .collect()
        } else {
            vec![dir.join(name)]
        };
        candidates.iter().any(|c| {
            let Ok(m) = std::fs::metadata(c) else {
                return false;
            };
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                m.is_file() && m.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                m.is_file()
            }
        })
    })
}

/// The `check` alias the deny hook points an implementer at, added when the
/// repository has none. Never replaces one the repository wrote. It runs
/// `spec-flow` from PATH, never `npx`: npx in a repository without it reaches
/// the registry, where the name is unrelated.
fn ensure_check_script(root: &Path) -> String {
    let p = root.join("package.json");
    let Ok(raw) = std::fs::read(&p) else {
        return String::new();
    };
    let Ok(Value::Object(probe)) = serde_json::from_slice::<Value>(&raw) else {
        return String::new();
    };
    if let Some(check) = probe.get("scripts").and_then(|s| s.get("check"))
        && !check.is_null()
        && check != ""
    {
        return String::new();
    }
    let indent = INDENT.captures(&raw).map_or_else(
        || "  ".to_string(),
        |m| String::from_utf8_lossy(&m[1]).into_owned(),
    );
    let Some(out) = add_script(&raw, "check", "spec-flow check", &indent) else {
        return String::new();
    };
    if std::fs::write(&p, out).is_err() {
        return String::new();
    }
    // Writing the alias is not the alias working: it needs the engine on
    // PATH, which an adopter running it by path does not have. Said here, not
    // at the first denial, where the reader is an implementer that cannot
    // install.
    if on_path("spec-flow") {
        r#"added a "check" script to package.json — it runs the gate's own commands, scoped to this branch, and is what the deny hook points an implementer at"#.into()
    } else {
        r#"added a "check" script to package.json — it runs spec-flow from your PATH, which does not carry it yet, so it exits "spec-flow: not found" until you put the engine's bin/spec-flow there (README). Nothing is broken meanwhile: the deny hook also names the plugin's own copy, which needs no install"#.into()
    }
}

/// The directories, the specs contract, the gitignore lines and the `check`
/// alias. `.claude/state/` and the report path must both be ignored, or the
/// gate reads its own output as an unfinished write and skips every other
/// milestone — and a skip is not a failure, so nothing says so.
fn scaffold(root: &Path, report_path: &str) -> Vec<String> {
    let mut done = Vec::new();
    for d in ["specs", "specflow/archive"] {
        let dir = root.join(d);
        if !dir.exists() {
            let _ = std::fs::create_dir_all(&dir);
            done.push(format!("created {d}/"));
        }
    }
    let readme = root.join("specs").join("README.md");
    if !readme.exists() {
        state::write_file(&readme, SPECS_README);
        done.push("created specs/README.md — the capability-spec contract".into());
    }
    let mut lines = vec![".claude/state/".to_string()];
    if !report_path.is_empty() {
        // By its DIRECTORY where it has one: what a runner fills, and what git
        // reports while it is untracked.
        let normalized = report_path.replace('\\', "/");
        let dir = normalized.split('/').next().unwrap_or_default();
        lines.push(if !dir.is_empty() && dir != report_path {
            format!("{dir}/")
        } else {
            report_path.to_string()
        });
    }
    let gitignore = root.join(".gitignore");
    let mut current = state::read_text(&gitignore).unwrap_or_default();
    for line in lines {
        if current.split('\n').any(|l| l.trim() == line) {
            continue;
        }
        let prefix = if !current.is_empty() && !current.ends_with('\n') {
            "\n"
        } else {
            ""
        };
        state::append_line(&gitignore, &format!("{prefix}{line}"));
        current += &format!("{prefix}{line}\n");
        done.push(format!("added {line} to .gitignore"));
    }
    let s = ensure_check_script(root);
    if !s.is_empty() {
        done.push(s);
    }
    done
}

/// `spec-flow init [--force] [--translator]`.
pub fn init(args: &[String]) -> i32 {
    let root = state::project_dir();
    let force = args.iter().any(|a| a == "--force");
    let wants_translator = args.iter().any(|a| a == "--translator");
    let config_path = root.join(".spec-flow").join("config.json");
    // A contract inside a package is one no gate runs against (ADR-027).
    if let Err(e) = gitscope::assert_repo_root(&root) {
        println!("spec-flow init: {}", e.msg);
        return 1;
    }
    if config_path.exists() && !force {
        println!("spec-flow init: .spec-flow/config.json already exists. Nothing written.");
        println!(
            "  Pass --force to overwrite it, or edit it directly — every field is in REFERENCE.md."
        );
        return 0;
    }
    let (c, f) = build_contract(&root);
    let _ = std::fs::create_dir_all(root.join(".spec-flow"));
    let mut written = serde_json::to_string_pretty(&c).unwrap_or_default();
    written.push('\n');
    state::write_file(&config_path, &written);
    print!("spec-flow init: wrote .spec-flow/config.json\n\n");
    // Opt-in, and never overwritten — `--force` does not reach it: the README
    // sends an adopter back with `--force`, and that would destroy their work.
    let translator = root.join(".spec-flow").join("tests-that-ran.mjs");
    if wants_translator && !translator.exists() {
        state::write_file(&translator, &translator_stub(&c.verify.test_name));
        print!(
            "  wrote     .spec-flow/tests-that-ran.mjs — point \"trace\" at it with \"executed_tests\": [\"node\", \".spec-flow/tests-that-ran.mjs\"] and delete \"report\".\n\n"
        );
    }
    for l in scaffold(&root, &c.trace.report.path) {
        println!("  {l}");
    }
    if !f.detected.is_empty() {
        println!();
    }
    for l in &f.detected {
        println!("  detected  {l}");
    }
    for l in &f.review {
        println!("  REVIEW    {l}");
    }
    for l in &f.missing {
        println!("  MISSING   {l}");
    }
    // Through the reader every hook uses, so this cannot disagree with the
    // first gate.
    println!();
    if let Err(e) = contract::load(&root) {
        println!("The contract is NOT usable yet:\n{e}");
        println!(
            "\nFill the fields above and re-run this command with --force, or edit the file directly."
        );
        return 1;
    }
    // A MISSING line is unfinished business even when the reader accepts it:
    // a base that does not resolve here does not resolve at the first gate.
    if !f.missing.is_empty() {
        println!(
            "The contract validates, but {} field(s) above still need you. Fill them in and re-run with --force, or edit the file directly.",
            f.missing.len()
        );
        return 1;
    }
    if f.review.is_empty() {
        println!(
            "The contract is valid. Run your checks with `spec-flow check`, then start with /spec-flow."
        );
    } else {
        println!(
            "The contract is valid and the engine will run. Confirm the REVIEW line(s) above first — they are inferences, not readings."
        );
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_words_remove_quotes_and_refuse_a_shell() {
        let w = |s: &str| shell_words(s).map(|v| v.join("|"));
        assert_eq!(
            w(r#"mocha --spec "test/**/*.spec.js""#),
            Ok("mocha|--spec|test/**/*.spec.js".into())
        );
        assert_eq!(w("a'b c'd e"), Ok("ab cd|e".into()));
        assert!(w("a && b").is_err());
        assert!(w("echo $HOME").is_err());
        assert!(w("NODE_ENV=test jest").is_err());
        assert!(w("a 'unclosed").is_err());
    }

    #[test]
    fn package_json_keeps_its_order_and_its_numbers() {
        let raw = b"{\n    \"name\": \"x\",\n    \"version\": 1.0,\n    \"scripts\": {\n        \"test\": \"vitest\"\n    },\n    \"a\": []\n}\n";
        let out = add_script(raw, "check", "spec-flow check", "    ").unwrap();
        assert_eq!(
            out,
            "{\n    \"name\": \"x\",\n    \"version\": 1.0,\n    \"scripts\": {\n        \"test\": \"vitest\",\n        \"check\": \"spec-flow check\"\n    },\n    \"a\": []\n}\n"
        );
        let none = add_script(b"{\"z\":1,\"b\":{}}", "check", "c", "  ").unwrap();
        assert_eq!(
            none,
            "{\n  \"z\": 1,\n  \"b\": {},\n  \"scripts\": {\n    \"check\": \"c\"\n  }\n}\n"
        );
    }

    #[test]
    fn a_path_cleans_as_gos() {
        for (p, want) in [
            ("./junit.xml", "junit.xml"),
            ("a/../b/./c.xml", "b/c.xml"),
            ("../x", "../x"),
            ("", "."),
        ] {
            assert_eq!(clean_posix(p), want, "{p}");
        }
    }
}

//! The only reader of `.spec-flow/config.json`, so its defaults, its
//! validation and its version check exist once.
//!
//! A missing file is not silent: no runner, linter or layer is safe to assume
//! for a repository this engine has never seen, so every field naming one is
//! required, and validation runs on every load, the missing file included.
//!
//! Every caller lets `load`'s error stand — never falls back to defaults. A
//! fallback would make a version this engine cannot read indistinguishable
//! from a missing file, and hand that repository someone else's values.

#![allow(dead_code)] // the spike's one hook reads `unscoped_denied` alone

use std::path::Path;

use serde_json::{Map, Value, json};

/// The contract this reader understands.
pub const SUPPORTED_VERSION: u64 = 1;

/// The report formats the engine reads.
pub const REPORT_FORMATS: [&str; 2] = ["junit", "tap"];

/// Only fields with no stack-specific content get a value; whatever would
/// have to guess a tool or a layer is empty, and validation requires it.
fn defaults() -> Map<String, Value> {
    let Value::Object(m) = json!({
        "contract_version": SUPPORTED_VERSION,
        "verify": {
            "scope_globs": [], "lint": [], "lint_no_fix": [], "test": [],
            "test_name": "", "lint_name": "", "lint_config_hint": "",
            // Empty resolves the base automatically; failing to resolve one is loud.
            "base_ref": "",
        },
        "trace": {
            "specs_dir": "specs", "proof_dir": "", "proof_suffix": "",
            // Which tests RAN: a report the runner writes (the default,
            // ADR-005), or argv printing their names. Neither opts out of
            // traceability, and spec-trace refuses that the moment a
            // requirement exists.
            "report": null, "executed_tests": [],
            "not_a_capability": ["README.md", "glossary.md"],
            // Off: nothing this engine reads says whether a repository routes
            // skills, and it is never inferred from a milestone that names one
            // — that arms the check from an absence.
            "require_skills_field": false,
        },
        "extra_checks": [],
        "unscoped_denied": {
            "scripts": [], "tools": [], "scoped_allowed": [],
            "scoped_alternative": "", "scoped_examples": [],
        },
    }) else {
        unreachable!()
    };
    m
}

/// `trace.report`.
pub struct Report {
    pub format: String,
    pub path: String,
}

/// One of `extra_checks`, or spec-trace.
pub struct Check {
    pub name: String,
    pub field: String,
    pub green: String,
    pub hint: String,
    pub class: String,
    pub cmd: Vec<String>,
}

#[derive(Default)]
pub struct Verify {
    pub scope_globs: Vec<String>,
    pub lint: Vec<String>,
    pub lint_no_fix: Vec<String>,
    pub test: Vec<String>,
    pub test_name: String,
    pub lint_name: String,
    pub lint_config_hint: String,
    pub base_ref: String,
}

#[derive(Default)]
pub struct Trace {
    pub specs_dir: String,
    pub proof_dir: String,
    pub proof_suffix: String,
    pub report: Option<Report>,
    pub executed_tests: Vec<String>,
    pub not_a_capability: Vec<String>,
    pub require_skills_field: bool,
}

#[derive(Default)]
pub struct UnscopedDenied {
    pub scripts: Vec<String>,
    pub tools: Vec<String>,
    pub scoped_allowed: Vec<String>,
    pub scoped_examples: Vec<String>,
    pub scoped_alternative: String,
}

/// A loaded, validated contract.
pub struct Config {
    pub version: Value,
    pub verify: Verify,
    pub trace: Trace,
    pub extra_checks: Vec<Check>,
    pub unscoped_denied: UnscopedDenied,
    /// "file" or "defaults".
    pub source: &'static str,
}

/// Shallow-merge one level down: overriding `verify.test` keeps the other
/// verify defaults.
fn merge(base: &Map<String, Value>, over: &Map<String, Value>) -> Map<String, Value> {
    let mut out = base.clone();
    for (k, v) in over {
        let merged = match v {
            Value::Object(m) => {
                let empty = Map::new();
                let b = base.get(k).and_then(Value::as_object).unwrap_or(&empty);
                Value::Object(merge(b, m))
            }
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    out
}

fn obj(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `JSON.stringify(v)`: `undefined` for a missing value.
pub fn js_json(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(v) => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn non_empty_array(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Array(a)) if !a.is_empty())
}

fn non_empty_string(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::String(s)) if !s.is_empty())
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(_) => true,
    }
}

/// Shape, not taste: a wrong command fails loudly the first time the gate
/// runs it. `scope_globs` is the one field whose CONTENT is judged, because a
/// scope that matches nothing fails silently every time, by disarming lint.
fn validate(c: &Map<String, Value>, source: &str) -> Vec<String> {
    let mut problems: Vec<String> = Vec::new();
    let verify = obj(c.get("verify"));
    let trace = obj(c.get("trace"));

    if !non_empty_array(verify.get("lint")) {
        problems.push(r#"verify.lint must be a non-empty array of argv parts, e.g. ["node", "node_modules/.bin/eslint", "--fix"]."#.into());
    }
    if !non_empty_array(verify.get("test")) {
        problems.push(r#"verify.test must be a non-empty array of argv parts, e.g. ["node", "node_modules/.bin/vitest", "run"]."#.into());
    }
    match verify.get("scope_globs") {
        Some(Value::Array(globs)) if !globs.is_empty() => {
            // Git pathspecs, where `*` already crosses `/`: `**/*.ts` demands
            // a directory and drops the root, and the empty scope that leaves
            // reads exactly like a milestone that touched nothing in scope.
            for (i, g) in globs.iter().enumerate() {
                let glob = match g.as_str() {
                    Some(s) if !s.is_empty() => s,
                    _ => {
                        problems.push(format!(
                            "verify.scope_globs[{i}] must be a non-empty string — got {}.",
                            js_json(Some(g))
                        ));
                        continue;
                    }
                };
                if glob.contains("**") {
                    let fixed = glob.replace("**/", "").replace("**", "*");
                    let (glob, fixed) = (
                        js_json(Some(&Value::from(glob))),
                        js_json(Some(&Value::from(fixed))),
                    );
                    problems.push(format!(
                        "verify.scope_globs[{i}] is {glob}, and `**` does not mean here what it means in npm, in a bundler config or in .gitignore. \
                         These are git PATHSPECS, where `*` already crosses `/`: write {fixed} and it matches at every depth. \
                         Left as written it matches only files at least one directory deep, so every file in the repo root falls out of scope — and an empty scope is not a failure anywhere: the linter is simply never invoked, and the gate records `lint=-`, which reads exactly like a milestone that honestly changed nothing in scope."
                    ));
                }
            }
        }
        _ => problems.push(
            r#"verify.scope_globs must be a non-empty array, e.g. ["*.ts", "*.tsx"]."#.into(),
        ),
    }
    if !non_empty_string(verify.get("test_name")) {
        problems.push(r#"verify.test_name must name the test runner, e.g. "vitest" — it labels the gate's log sections."#.into());
    }
    if !non_empty_string(verify.get("lint_name")) {
        problems.push(r#"verify.lint_name must name the linter, e.g. "eslint" — it labels the gate's log sections."#.into());
    }
    // `"base_ref": ""` would silently mean "auto-resolve"; declared, it means something.
    let base_ref = verify.get("base_ref");
    if base_ref.and_then(Value::as_str) != Some("") && !non_empty_string(base_ref) {
        problems.push(r#"verify.base_ref, when present, must be a non-empty string naming the ref this branch is judged against, e.g. "origin/trunk". Omit it entirely to let the engine resolve the base branch automatically."#.into());
    }
    // Where a new test goes and what it is called; not what counts as proof (ADR-001).
    if !non_empty_string(trace.get("proof_dir")) {
        problems.push(r#"trace.proof_dir must name the directory a new test goes in (e.g. "tests"). It is what an implementer is told when a requirement needs proof; it no longer decides what counts as proof, which is trace.executed_tests' job."#.into());
    }
    if !non_empty_string(trace.get("proof_suffix")) {
        problems.push(r#"trace.proof_suffix must name what a test file is called in this repo, e.g. ".spec.ts", ".test.ts" or "_test.py" — it tells an implementer what to name a new one."#.into());
    }
    // At most one source: two answers to "which tests ran" means one is not read.
    let report = trace.get("report").filter(|r| !r.is_null());
    if report.is_some() && non_empty_array(trace.get("executed_tests")) {
        problems.push("trace.report and trace.executed_tests are both declared, and only one can be read. Keep trace.report (the engine parses the file your runner writes) and delete trace.executed_tests, or the reverse — but say which.".into());
    }
    if report.is_some() {
        let r = obj(report);
        let format = r.get("format");
        if !format
            .and_then(Value::as_str)
            .is_some_and(|f| REPORT_FORMATS.contains(&f))
        {
            problems.push(format!(
                "trace.report.format must be one of {} — got {}. \
                 These are report formats, not runners: most runners can emit one behind a flag, and the format is what defines how a skipped test is marked.",
                REPORT_FORMATS.join(", "),
                js_json(format)
            ));
        }
        if !non_empty_string(r.get("path")) {
            problems.push(r#"trace.report.path must name the file your test command writes, relative to the repo root, e.g. "reports/junit.xml". The engine does not run your tests a second time — it reads what the gate's own run produced."#.into());
        }
    }
    // A string would arm the check by truthiness, or `"false"` disarm nothing.
    if !matches!(trace.get("require_skills_field"), Some(Value::Bool(_))) {
        problems.push("trace.require_skills_field, when present, must be true or false (a JSON boolean, not a quoted string). Omit it to leave the check off: the planner still fills the milestone's `Skills:` field and the reviewer still checks it — this only decides whether spec-trace fails a live milestone that lacks one.".into());
    }
    if !problems.is_empty() && source == "defaults" {
        problems.push("No .spec-flow/config.json was found at all, so none of the above has a value — this project has not written a contract for this engine yet. Run `spec-flow init` from the repo root to generate one (see the plugin README).".into());
    }

    let checks = match c.get("extra_checks") {
        Some(Value::Array(a)) => a.as_slice(),
        None | Some(Value::Null) => &[],
        Some(_) => {
            problems.push("extra_checks must be an array.".into());
            &[]
        }
    };
    for (i, raw) in checks.iter().enumerate() {
        let check = obj(Some(raw));
        let at = format!("extra_checks[{i}]");
        if !truthy(check.get("name")) {
            problems.push(format!("{at}.name is required."));
        }
        if !non_empty_array(check.get("cmd")) {
            problems.push(format!("{at}.cmd must be a non-empty array."));
        }
        if !truthy(check.get("field")) {
            problems.push(format!("{at}.field is required: it is the key this check writes in gate-history.log, and specflow-stats reads that log by key."));
        }
        let class = check.get("class");
        if truthy(class)
            && !matches!(
                class.and_then(Value::as_str),
                Some("lint/trace" | "behaviour")
            )
        {
            problems.push(format!(r#"{at}.class must be "lint/trace" (route the failure back as an edit) or "behaviour" (route it as a re-plan)."#));
        }
    }
    problems
}

/// A value as JavaScript's template literal writes it.
fn text(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if !n.is_i64() && !n.is_u64() => format!("{f}"),
            _ => n.to_string(),
        },
        Some(Value::Bool(b)) => b.to_string(),
        Some(v) => js_json(Some(v)),
    }
}

fn strs(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|e| text(Some(e))).collect(),
        _ => Vec::new(),
    }
}

fn build(c: &Map<String, Value>, source: &'static str) -> Config {
    let (v, t, u) = (
        obj(c.get("verify")),
        obj(c.get("trace")),
        obj(c.get("unscoped_denied")),
    );
    let extra_checks = match c.get("extra_checks") {
        Some(Value::Array(a)) => a
            .iter()
            .map(|raw| {
                let ch = obj(Some(raw));
                let class = text(ch.get("class"));
                Check {
                    name: text(ch.get("name")),
                    field: text(ch.get("field")),
                    cmd: strs(ch.get("cmd")),
                    hint: text(ch.get("hint")),
                    green: match ch.get("green") {
                        Some(g) if !g.is_null() => text(Some(g)),
                        _ => "(ok)".into(),
                    },
                    class: if class.is_empty() {
                        "lint/trace".into()
                    } else {
                        class
                    },
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    Config {
        version: c.get("contract_version").cloned().unwrap_or(Value::Null),
        verify: Verify {
            scope_globs: strs(v.get("scope_globs")),
            lint: strs(v.get("lint")),
            lint_no_fix: strs(v.get("lint_no_fix")),
            test: strs(v.get("test")),
            test_name: text(v.get("test_name")),
            lint_name: text(v.get("lint_name")),
            lint_config_hint: text(v.get("lint_config_hint")),
            base_ref: text(v.get("base_ref")),
        },
        trace: Trace {
            specs_dir: text(t.get("specs_dir")),
            proof_dir: text(t.get("proof_dir")),
            proof_suffix: text(t.get("proof_suffix")),
            report: t.get("report").and_then(Value::as_object).map(|r| Report {
                format: text(r.get("format")),
                path: text(r.get("path")),
            }),
            executed_tests: strs(t.get("executed_tests")),
            not_a_capability: strs(t.get("not_a_capability")),
            require_skills_field: t
                .get("require_skills_field")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        },
        extra_checks,
        unscoped_denied: UnscopedDenied {
            scripts: strs(u.get("scripts")),
            tools: strs(u.get("tools")),
            scoped_allowed: strs(u.get("scoped_allowed")),
            scoped_alternative: text(u.get("scoped_alternative")),
            scoped_examples: strs(u.get("scoped_examples")),
        },
        source,
    }
}

/// Reads `root`'s contract. `root` is the consuming repository, explicit,
/// never where this engine sits.
pub fn load(root: &Path) -> Result<Config, String> {
    let mut parsed = Map::new();
    let mut source = "defaults";
    if let Ok(raw) = std::fs::read(root.join(".spec-flow").join("config.json")) {
        source = "file";
        let v: Value = serde_json::from_slice(&raw)
            .map_err(|e| format!(".spec-flow/config.json is not valid JSON: {e}"))?;
        let declared = match v {
            Value::Object(m) => {
                parsed = m;
                parsed.get("contract_version")
            }
            _ => None,
        };
        if declared.and_then(Value::as_f64) != Some(SUPPORTED_VERSION as f64) {
            return Err(format!(
                ".spec-flow/config.json declares contract_version {}, and this engine understands {SUPPORTED_VERSION}. \
                 Refusing to run: continuing would silently ignore whatever that version changed, which is a gate that looks armed and is not.",
                js_json(declared)
            ));
        }
    }
    let merged = merge(&defaults(), &parsed);
    let problems = validate(&merged, source);
    if !problems.is_empty() {
        return Err(format!(
            ".spec-flow/config.json is not usable:\n  - {}",
            problems.join("\n  - ")
        ));
    }
    Ok(build(&merged, source))
}

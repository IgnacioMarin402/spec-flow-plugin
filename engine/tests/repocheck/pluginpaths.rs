//! PluginPaths holds every call site this package's prose and manifest make
//! to it: a `${CLAUDE_PLUGIN_ROOT}/...` path a command, agent or skill tells
//! the model to run, or hooks.json resolves, must ship. An instruction that
//! names a path the package does not have silently does not run — the gate's
//! failure, one layer up in the prose. Then the inventories, in both
//! directions: the hooks the binary dispatches against hooks.json, the mod's
//! modules (ADR-037), every state file the code names against REFERENCE's
//! table, and every cross-doc anchor against the heading it names.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::{Report, exists, read_rel, surfaces, walk};

/// `skills` is the plugin-root directory, not `.claude/skills`: the first
/// ships to adopters, and carries the same call sites a command does.
pub const PATH_DIRS: [&str; 5] = ["commands", "agents", "modes", "hooks", "skills"];
pub const PATH_EXTS: [&str; 2] = [".md", ".json"];

/// The hooks the binary dispatches: `spec-flow hook <name>`.
pub fn hook_names() -> Vec<&'static str> {
    let mut names: Vec<&str> = spec_flow::hooks::HOOKS.iter().map(|h| h.0).collect();
    names.sort();
    names
}

/// The trailing class stops at whatever markdown wrapped it.
static PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\$\{CLAUDE_PLUGIN_ROOT\}/([A-Za-z0-9._\-/]+)").unwrap());
/// Every entry is the launcher in a shell (ADR-052); one spelled otherwise is
/// not counted as registering anything.
static REGISTERED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^"\$\{CLAUDE_PLUGIN_ROOT\}/bin/spec-flow" hook ([A-Za-z0-9._-]+)$"#).unwrap()
});

/// What a state path's file name is written as: a literal, or a constant.
const NAME: &str = r#"(?:"([^"]+)"|([A-Za-z_][\w:]*))"#;

/// The shapes the engine writes a state path in: joined onto the state
/// directory as it is built, or onto a binding the same file made of it. The
/// name may be a literal, or a constant bound to one at the top level of the
/// file, of the module it is qualified with, or of the module it is imported
/// from. Anything else — a parameter, a field, a computed string — is not
/// followed: what it holds would be a guess.
static STATE_SHAPES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(&format!(r#"state_dir\([^)]*\)\s*\.join\(\s*&?{NAME}\s*\)"#)).unwrap(),
        Regex::new(&format!(r#"\.join\("state"\)\s*\.join\(\s*&?{NAME}\s*\)"#)).unwrap(),
        Regex::new(r"\.claude/state/([A-Za-z0-9_-][A-Za-z0-9_.-]*[A-Za-z0-9_-])").unwrap(),
    ]
});
/// `let dir = state::state_dir(&root);` or `let dir = root.join(".claude").join("state");`.
static STATE_BINDING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"let\s+(\w+)\s*=\s*(?:(?:state::)?state_dir\([^)]*\)|[\w.]+\.join\("\.claude"\)\s*\.join\("state"\))\s*;"#).unwrap()
});
static NEXT_FN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^(?:pub(?:\([^)]*\))?\s+)?fn\s").unwrap());
/// Column 0 only, so a constant inside a function is never taken for a module's.
static TOP_CONST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?m)^(?:pub(?:\([^)]*\))?\s+)?const\s+([A-Za-z_]\w*)\s*:\s*&(?:'static\s+)?str\s*=\s*"([^"\n]+)""#).unwrap()
});
static USE_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^\s*use\s+(?:crate|spec_flow)::([\w:]+?)::(?:\{([^}]*)\}|(\w+))\s*;").unwrap()
});
static TABLE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`([^`]+)`").unwrap());
static DOC_LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\]\(([A-Za-z.]*\.md)?#([^)]+)\)").unwrap());
static NOT_ANCHOR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9 _-]").unwrap());

/// The engine source file a module path names: `hooks::guards` is
/// `engine/hooks/guards.rs` or `engine/hooks/guards/mod.rs`.
fn module_file(root: &Path, module: &str) -> Option<String> {
    let base = format!("engine/{}", module.replace("::", "/"));
    [format!("{base}.rs"), format!("{base}/mod.rs")]
        .into_iter()
        .find(|f| root.join(f).is_file())
}

/// name -> literal for every string constant at the top level of a file,
/// its `#[cfg(test)]` module left out.
fn file_consts(text: &str) -> HashMap<String, String> {
    let code = text.split("\n#[cfg(test)]").next().unwrap_or_default();
    TOP_CONST
        .captures_iter(code)
        .map(|m| (m[1].to_string(), m[2].to_string()))
        .collect()
}

/// The literal a constant reference in `file` resolves to.
fn resolve(root: &Path, file: &str, text: &str, ident: &str) -> Option<String> {
    let consts_of =
        |module: &str| module_file(root, module).map(|f| file_consts(&read_rel(root, &f)));
    if let Some((module, id)) = ident.rsplit_once("::") {
        let module = module
            .trim_start_matches("crate::")
            .trim_start_matches("spec_flow::");
        // `state::LOG` is the module the file imported as `state`.
        let full = USE_LINE
            .captures_iter(text)
            .find_map(|u| {
                let path = u[1].to_string();
                let names = u
                    .get(2)
                    .or(u.get(3))
                    .map(|m| m.as_str())
                    .unwrap_or_default();
                names
                    .split(',')
                    .any(|n| n.trim() == module)
                    .then(|| format!("{path}::{module}"))
            })
            .unwrap_or_else(|| module.to_string());
        return consts_of(&full)?.get(id).cloned();
    }
    if let Some(v) = file_consts(text).get(ident) {
        return Some(v.clone());
    }
    let _ = file;
    USE_LINE.captures_iter(text).find_map(|u| {
        let names = u
            .get(2)
            .or(u.get(3))
            .map(|m| m.as_str())
            .unwrap_or_default();
        names
            .split(',')
            .any(|n| n.trim() == ident)
            .then(|| consts_of(&u[1])?.get(ident).cloned())
            .flatten()
    })
}

/// Each state file name the engine's source names, with the first file naming it.
pub fn state_names(root: &Path) -> BTreeMap<String, String> {
    let mut names = BTreeMap::new();
    for f in walk(root, "engine", &[".rs"], &["engine/tests"]) {
        let text = read_rel(root, &f);
        let code = text.split("\n#[cfg(test)]").next().unwrap_or_default();
        // A binding holds the state directory from where it is made to the
        // end of its function: the same name in another function is another
        // directory.
        let mut scoped: Vec<(Regex, &str)> =
            STATE_SHAPES.iter().map(|s| (s.clone(), code)).collect();
        for b in STATE_BINDING.captures_iter(code) {
            let from = b.get(0).unwrap().end();
            let to = NEXT_FN
                .find(&code[from..])
                .map_or(code.len(), |m| from + m.start());
            scoped.push((
                Regex::new(&format!(r"\b{}\s*\.join\(\s*&?{NAME}\s*\)", &b[1])).unwrap(),
                &code[from..to],
            ));
        }
        for (shape, within) in &scoped {
            for m in shape.captures_iter(within) {
                let name = match (m.get(1), m.get(2)) {
                    (Some(lit), _) => Some(lit.as_str().to_string()),
                    (None, Some(id)) => resolve(root, &f, code, id.as_str()),
                    _ => None,
                };
                if let Some(name) = name.filter(|n| !n.is_empty()) {
                    names.entry(name).or_insert_with(|| f.clone());
                }
            }
        }
    }
    names
}

/// REFERENCE's `.claude/state/` table rows, as patterns.
pub fn state_rows(reference: &str) -> Vec<Regex> {
    let Some(start) = reference.find("## `.claude/state/`") else {
        return Vec::new();
    };
    let mut table = &reference[start..];
    if let Some(end) = table.find("\n---") {
        table = &table[..end];
    }
    let mut covers = Vec::new();
    for row in table.split('\n').filter(|r| r.starts_with("| `")) {
        let mut stem = String::new();
        for m in TABLE_CODE.captures_iter(row.split('|').nth(1).unwrap_or_default()) {
            // `gate-failure.log` / `.full.log`: a token starting with a dot is
            // a sibling of the previous one, written short.
            let mut name = m[1].to_string();
            if name.starts_with('.') {
                name = format!("{stem}{name}");
            } else {
                stem = match name.rfind('.') {
                    Some(dot) => name[..dot].to_string(),
                    None => name.clone(),
                };
            }
            covers.push(
                Regex::new(&format!("^{}$", regex::escape(&name).replace(r"\*", ".*"))).unwrap(),
            );
        }
    }
    covers
}

/// GitHub's rule: lowercase, drop everything that is not a letter, digit,
/// space, underscore or hyphen, then spaces to hyphens.
pub fn anchor_of(heading: &str) -> String {
    let h = heading.trim_start_matches('#').trim().to_lowercase();
    NOT_ANCHOR.replace_all(&h, "").replace(' ', "-")
}

pub fn plugin_paths(root: &Path) -> Report {
    let mut r = Report::new("plugin-paths");
    r.advice = "A command that names a path the package does not ship is an instruction that silently does not run, and a hook nothing registers is a guarantee nobody is keeping. Ship the file, or stop claiming it.";
    let mut add = |p: String| r.problems.push(p);
    let mut checked = 0;
    for f in surfaces(root, &PATH_DIRS, &PATH_EXTS, &[], "", &[]) {
        for (i, line) in read_rel(root, &f).split('\n').enumerate() {
            for m in PLACEHOLDER.captures_iter(line) {
                checked += 1;
                if !exists(root, &m[1]) {
                    add(format!(
                        "{f}:{}  {} does not exist in this package",
                        i + 1,
                        &m[1]
                    ));
                }
            }
        }
    }

    // ---- the hooks, both directions: one the binary dispatches and the
    // manifest never registers ships and never fires; one the manifest
    // registers and the binary lacks is a guarantee it cannot keep.
    let manifest: Value =
        serde_json::from_str(&read_rel(root, "hooks/hooks.json")).unwrap_or(Value::Null);
    let mut in_manifest = BTreeSet::new();
    if let Some(events) = manifest["hooks"].as_object() {
        for groups in events.values().filter_map(Value::as_array) {
            for g in groups {
                for h in g["hooks"].as_array().into_iter().flatten() {
                    if let Some(m) = h["command"].as_str().and_then(|c| REGISTERED.captures(c)) {
                        in_manifest.insert(m[1].to_string());
                    }
                }
            }
        }
    }
    let hooks = hook_names();
    for h in &hooks {
        if !in_manifest.contains(*h) {
            add(format!(
                "the binary dispatches `hook {h}` and hooks.json never registers it — it ships and never fires"
            ));
        }
    }
    for h in &in_manifest {
        if !hooks.contains(&h.as_str()) {
            add(format!(
                "hooks.json registers `hook {h}`, which the binary does not dispatch"
            ));
        }
    }

    // ---- the mod's modules, both directions; a `*.test.tsx` is `claude plugin test`'s.
    let modules: Vec<String> = manifest["modules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|m| m.trim_start_matches("./").to_string())
        .collect();
    let mut tsx: Vec<String> = std::fs::read_dir(root.join("hooks"))
        .map(|es| {
            es.filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    tsx.sort();
    for n in tsx
        .iter()
        .filter(|n| n.ends_with(".tsx") && !n.ends_with(".test.tsx"))
    {
        if !modules.contains(n) {
            add(format!(
                "hooks/{n} exists but hooks.json never names it in modules — it ships and never loads"
            ));
        }
    }
    for m in &modules {
        if !exists(root, &format!("hooks/{m}")) {
            add(format!(
                "hooks.json names the module hooks/{m}, which this package does not ship"
            ));
        }
    }
    // `types` is optional, and so is the manifest here: `claude plugin
    // validate` is what requires the manifest.
    let plugin: Value =
        serde_json::from_str(&read_rel(root, ".claude-plugin/plugin.json")).unwrap_or(Value::Null);
    if let Some(types) = plugin["types"]
        .as_str()
        .filter(|t| !t.is_empty() && !exists(root, t))
    {
        add(format!(
            ".claude-plugin/plugin.json names the types contract {types}, which this package does not ship"
        ));
    }

    // ---- every state file the code names has a row. Code to table only: the
    // table may describe a family (`*-unmatched.log`) the code builds by name.
    let names = state_names(root);
    let covers = state_rows(&read_rel(root, "REFERENCE.md"));
    if names.is_empty() || covers.is_empty() {
        add(format!(
            "the .claude/state inventory found {} state file name(s) in the code and {} row name(s) in REFERENCE.md. One of the two stopped matching; a check that finds nothing passes forever.",
            names.len(),
            covers.len()
        ));
    } else {
        for (name, by) in &names {
            if !covers.iter().any(|c| c.is_match(name)) {
                add(format!(
                    "{by} names .claude/state/{name}, which REFERENCE.md's `.claude/state/` table does not list."
                ));
            }
        }
    }

    // ---- cross-doc anchors
    let docs = ["README.md", "REFERENCE.md", "CLAUDE.md", "BACKLOG.md"];
    let mut anchors: HashMap<&str, BTreeSet<String>> = HashMap::new();
    for d in docs.iter().filter(|d| exists(root, d)) {
        anchors.insert(
            d,
            read_rel(root, d)
                .split('\n')
                .filter(|l| l.starts_with('#'))
                .map(anchor_of)
                .collect(),
        );
    }
    let mut anchors_checked = 0;
    for d in docs.iter().filter(|d| anchors.contains_key(*d)) {
        for m in DOC_LINK.captures_iter(&read_rel(root, d)) {
            let target = m.get(1).map_or(*d, |w| w.as_str());
            let Some(defined) = anchors.get(target) else {
                continue;
            }; // a doc this check does not scan
            anchors_checked += 1;
            if !defined.contains(&m[2]) {
                add(format!(
                    "{d} links to {target}#{}, which names no heading there. A reader following it lands at the top of the page and has to hunt.",
                    &m[2]
                ));
            }
        }
    }
    r.ok = format!(
        "{checked} plugin-root path(s) referenced, all present; {} hook(s), each registered in hooks.json; {} module(s), each shipped and named; {} state file(s) named in the code, each listed in REFERENCE; {anchors_checked} cross-doc anchor(s), every one resolving.",
        hooks.len(),
        modules.len(),
        names.len()
    );
    r
}

/// The inventory reaches every state file the engine writes: a shape it
/// stops following is a file it stops checking, silently.
#[test]
fn the_state_inventory_reads_the_engine() {
    let names = state_names(&crate::repo());
    let found: Vec<&str> = names.keys().map(String::as_str).collect();
    for want in [
        "agent-registry",
        "current-milestone",
        "gate-failure.full.log",
        "gate-failure.log",
        "gate-history.log",
        "gate_attempts",
        "human-turn-unmatched.log",
        "human-turn.log",
        "lint-on-write-unmatched.log",
        "model-routes.log",
        "opus-budget-unmatched.log",
        "orchestrator-scope-unmatched.log",
        "phase",
        "phase-guard-unmatched.log",
        "phase.session",
        "register-agent-unmatched.log",
        "run-offset",
        "run-trace-unmatched.log",
        "run-trace.log",
        "token-offset",
        "token-trace-unmatched.log",
    ] {
        assert!(found.contains(&want), "{want} not found; found {found:?}");
    }
}

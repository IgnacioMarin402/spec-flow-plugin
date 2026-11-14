//! A scan prints a count and passes when it finds nothing, so one reaching
//! the wrong files is indistinguishable from a clean repo. These cases hold
//! each scan to every surface it claims, one surface per case so a failure
//! names which. The surface lists are written out rather than read from the
//! check: a fixture agreeing with the check would agree with a dropped
//! directory too. Every banned token is assembled at runtime: this directory
//! is one the checks scan.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::lineends::line_ends;
use crate::modelpins::model_pins;
use crate::norepo::no_repo_refs;
use crate::pluginpaths::{hook_names, plugin_paths};
use crate::{Report, Tree};

fn run<'a>(
    check: fn(&Path) -> Report,
    files: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> Report {
    let t = Tree::new(files);
    check(&t.0)
}

static OK_COUNT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"OK — (\d+) file\(s\)").unwrap());

fn count(r: &Report) -> Option<usize> {
    if !r.problems.is_empty() {
        return None;
    }
    OK_COUNT
        .captures(&r.to_string())
        .and_then(|m| m[1].parse().ok())
}

#[track_caller]
fn reported(r: &Report, file: &str) {
    assert!(
        !r.problems.is_empty(),
        "{file} is not scanned: the check passed over it, which is what it reports for a clean repo.\n{r}"
    );
    assert!(
        r.to_string().contains(file),
        "reported a problem but not the file that carries it ({file}).\n{r}"
    );
}

#[track_caller]
fn clean(r: &Report, why: &str) {
    assert!(r.problems.is_empty(), "{why}.\n{r}");
}

#[track_caller]
fn says(r: &Report, text: &str) {
    assert!(r.to_string().contains(text), "expected {text:?}.\n{r}");
}

// ---- no-repo-refs ----------------------------------------------------------

const COUPLING_DIRS: [&str; 9] = [
    "hooks",
    "engine",
    "commands",
    "agents",
    "modes",
    ".claude/skills",
    "skills",
    "decisions",
    "evals",
];
const COUPLING_EXTS: [&str; 7] = [".rs", ".md", ".json", ".ts", ".tsx", ".sh", ".yaml"];
const COUPLING_DOCS: [&str; 8] = [
    "README.md",
    "REFERENCE.md",
    "CLAUDE.md",
    "LICENSE",
    "BACKLOG.md",
    ".github/workflows/ci.yml",
    "bin/spec-flow",
    "Cargo.toml",
];

fn coupled() -> String {
    format!("The engine is a {}{} plugin.\n", "Nest", "JS")
}

#[test]
fn no_repo_refs_reaches_every_surface() {
    let planted = coupled();
    for d in COUPLING_DIRS {
        let f = format!("{d}/planted.md");
        reported(&run(no_repo_refs, [(f.as_str(), planted.as_str())]), &f);
    }
    for f in COUPLING_DOCS {
        reported(&run(no_repo_refs, [(f, planted.as_str())]), f);
    }
    // Every other case plants a `.md`: an extension dropped from the list would go unseen.
    for e in COUPLING_EXTS {
        let f = format!("evals/planted{e}");
        reported(&run(no_repo_refs, [(f.as_str(), planted.as_str())]), &f);
    }
    reported(
        &run(no_repo_refs, [("engine/lib/deep.md", planted.as_str())]),
        "engine/lib/deep.md",
    );
}

#[test]
fn no_repo_refs_boundaries() {
    let planted = coupled();
    clean(
        &run(
            no_repo_refs,
            [("evals/results/run/report.md", planted.as_str())],
        ),
        "evals/results/ was read, so a local eval run turns the check red over what a model wrote",
    );
    let r = run(
        no_repo_refs,
        [(crate::norepo::NO_REPO_SELF, planted.as_str())],
    );
    clean(
        &r,
        "the check reported itself for naming what it bans, so it can never be green",
    );
    assert_eq!(
        count(&r),
        Some(0),
        "expected the only file present, the check itself, excluded: {r}"
    );
    // NO_REPO_FILES exists to name the prose outside the extensions.
    clean(
        &run(no_repo_refs, [("hooks/notes.txt", planted.as_str())]),
        "the walk read a .txt file",
    );
    let files: Vec<String> = COUPLING_DIRS
        .iter()
        .map(|d| format!("{d}/clean.md"))
        .chain(COUPLING_DOCS.iter().map(|f| f.to_string()))
        .collect();
    let r = run(
        no_repo_refs,
        files
            .iter()
            .map(|f| (f.as_str(), "Nothing here names one repo.\n")),
    );
    let want = COUPLING_DIRS.len() + COUPLING_DOCS.len();
    assert_eq!(
        count(&r),
        Some(want),
        "a count below the surfaces is what an unscanned directory looks like.\n{r}"
    );
}

// ---- model-pins ------------------------------------------------------------

const PIN_DIRS: [&str; 7] = [
    "agents",
    "modes",
    "commands",
    "hooks",
    "engine",
    "skills",
    ".claude/skills",
];
const PIN_EXTS: [&str; 5] = [".rs", ".md", ".json", ".ts", ".tsx"];
const PIN_DOCS: [&str; 5] = [
    "README.md",
    "REFERENCE.md",
    "CLAUDE.md",
    "BACKLOG.md",
    ".github/workflows/ci.yml",
];

fn pinned_id() -> String {
    ["claude", "opus", "5"].join("-")
}

fn numbered_tier() -> String {
    ["Opus", "5"].join(" ")
}

/// How an agent fixture states its effort.
enum Effort {
    Default,
    Omitted,
    Level(&'static str),
}

/// A valid agent, so a case about the ban is not also failing the routing.
fn agent(name: &str, model: &str, description: &str, effort: Effort) -> String {
    let model = if model.is_empty() { "sonnet" } else { model };
    let description = if description.is_empty() {
        format!("Does a job ({model}).")
    } else {
        description.to_string()
    };
    let line = match effort {
        Effort::Default => "effort: medium\n".to_string(),
        Effort::Omitted => String::new(),
        Effort::Level(l) => format!("effort: {l}\n"),
    };
    format!("---\nname: {name}\ndescription: {description}\nmodel: {model}\n{line}---\n\nBody.\n")
}

/// Scans a tree holding files and, unless it opts out, a valid agent: an
/// empty agents/ is itself a failure, which would mask every other case.
fn pins(files: &[(String, String)], baseline: bool) -> Report {
    let base = agent("base", "", "", Effort::Default);
    let mut all: Vec<(&str, &str)> = files
        .iter()
        .map(|(f, t)| (f.as_str(), t.as_str()))
        .collect();
    if baseline && !all.iter().any(|(f, _)| *f == "agents/base.md") {
        all.push(("agents/base.md", &base));
    }
    run(model_pins, all)
}

fn one(f: impl Into<String>, t: impl Into<String>) -> Vec<(String, String)> {
    vec![(f.into(), t.into())]
}

#[test]
fn model_pins_reaches_every_surface() {
    for d in PIN_DIRS {
        let f = format!("{d}/planted.md");
        let text = if d == "agents" {
            // A VALID agent, or the routing half would name the path for another reason.
            agent(
                "planted",
                "sonnet",
                &format!("Does a job (Sonnet), once {}.", pinned_id()),
                Effort::Default,
            )
        } else {
            format!("Routes to {}.\n", pinned_id())
        };
        let r = pins(&one(&f, text), true);
        reported(&r, &f);
        says(&r, "a pinned model id");
    }
    for f in PIN_DOCS {
        reported(
            &pins(
                &one(f, format!("The planner runs on {}.\n", numbered_tier())),
                true,
            ),
            f,
        );
    }
    for e in PIN_EXTS {
        let f = format!("hooks/planted{e}");
        reported(
            &pins(
                &one(&f, format!("const model = '{}';\n", pinned_id())),
                true,
            ),
            &f,
        );
    }
    reported(
        &pins(
            &one(
                "engine/lib/deep.md",
                format!("Routes to {}.\n", pinned_id()),
            ),
            true,
        ),
        "engine/lib/deep.md",
    );
}

#[test]
fn model_pins_boundaries() {
    // A record claims a moment, and the record that retired an id cannot say what changed without naming it.
    clean(
        &pins(
            &one(
                "decisions/012-a-record.md",
                format!("We removed {} on this date.\n", pinned_id()),
            ),
            true,
        ),
        "a record naming the id it retired was reported",
    );
    // Without this the check could be green by forbidding the alias it requires.
    clean(
        &pins(
            &one(
                "commands/route.md",
                "Routing: reviewer = haiku; implementer = sonnet; planner = opus. The Opus budget counts the last one.\n",
            ),
            true,
        ),
        "the bare aliases and tier words were reported",
    );
    clean(
        &pins(
            &one("engine/tests/repocheck/modelpins.rs", pinned_id() + "\n"),
            true,
        ),
        "the check reported itself",
    );
    let mut files: Vec<(String, String)> = PIN_DIRS
        .iter()
        .map(|d| {
            (
                format!("{d}/clean.md"),
                "Nothing here names a version.\n".to_string(),
            )
        })
        .collect();
    files.retain(|(f, _)| f != "agents/clean.md");
    files.push((
        "agents/clean.md".into(),
        agent("clean", "", "", Effort::Default),
    ));
    files.extend(
        PIN_DOCS
            .iter()
            .map(|f| (f.to_string(), "Nothing here names a version.\n".to_string())),
    );
    // One per surface, plus the baseline agent.
    let r = pins(&files, true);
    assert_eq!(count(&r), Some(PIN_DIRS.len() + PIN_DOCS.len() + 1), "{r}");
}

#[test]
fn model_pins_routing() {
    type Case<'a> = (&'a str, Vec<(String, String)>, bool, &'a str);
    let cases: Vec<Case> = vec![
        // The failure this check exists to close: a directory it never reached reads as clean.
        (
            "an agents/ directory the check cannot see is a failure, not a clean run",
            vec![],
            false,
            "no agent files",
        ),
        (
            "an agent pinned to a full model id is reported",
            one(
                "agents/pinned.md",
                format!(
                    "---\nname: pinned\ndescription: Does a job (Opus).\nmodel: {}\n---\n\nBody.\n",
                    pinned_id()
                ),
            ),
            true,
            "not one of the tier aliases",
        ),
        // Omitting it means inherit: a cheap pass silently runs on the session's model.
        (
            "an agent declaring no model is reported",
            one(
                "agents/inherits.md",
                "---\nname: inherits\ndescription: Does a job.\n---\n\nBody.\n",
            ),
            true,
            "declares no",
        ),
        (
            "an agent whose description contradicts its routing is reported",
            one(
                "agents/drifted.md",
                agent(
                    "drifted",
                    "haiku",
                    "Reviews the plan (Sonnet, read-only).",
                    Effort::Default,
                ),
            ),
            true,
            "never says so",
        ),
        // What is required is presence, not exclusivity.
        (
            "naming another agent's tier in a description is allowed",
            one(
                "agents/escalates.md",
                agent(
                    "escalates",
                    "haiku",
                    "Reviews the plan (Haiku). Escalates hard doubts to the Opus planner.",
                    Effort::Default,
                ),
            ),
            true,
            "",
        ),
        // Nothing reads a frontmatter effort back: these are all that stands between a typo and a setting that reads as applied.
        (
            "an effort level that does not exist is reported",
            one(
                "agents/typo.md",
                agent(
                    "typo",
                    "sonnet",
                    "Does a job (Sonnet).",
                    Effort::Level("hihg"),
                ),
            ),
            true,
            "not one of",
        ),
        (
            "an agent that declares no effort and is not recorded as inheriting is reported",
            one(
                "agents/quiet.md",
                agent("quiet", "sonnet", "Does a job (Sonnet).", Effort::Omitted),
            ),
            true,
            "INHERITS_EFFORT",
        ),
        (
            "an agent recorded as inheriting may omit effort",
            one(
                "agents/implementer.md",
                agent(
                    "implementer",
                    "sonnet",
                    "Implements (Sonnet).",
                    Effort::Omitted,
                ),
            ),
            true,
            "",
        ),
        (
            "an agent recorded as inheriting must not also declare an effort",
            one(
                "agents/implementer.md",
                agent(
                    "implementer",
                    "sonnet",
                    "Implements (Sonnet).",
                    Effort::Level("high"),
                ),
            ),
            true,
            "stale",
        ),
    ];
    for (name, files, baseline, want) in cases {
        let r = pins(&files, baseline);
        if want.is_empty() {
            assert!(
                r.problems.is_empty(),
                "{name}: a correct tree was reported.\n{r}"
            );
        } else {
            assert!(
                !r.problems.is_empty() && r.to_string().contains(want),
                "{name}: want a problem saying {want:?}.\n{r}"
            );
        }
    }
    // Printing the routing is what makes an unread agents/ visible in CI output.
    let r = pins(
        &one(
            "agents/deep.md",
            agent("deep", "opus", "Advises (Opus).", Effort::Default),
        ),
        true,
    );
    clean(&r, "a clean tree was reported as pinned");
    says(&r, "deep -> opus");
    says(&r, "base -> sonnet");
}

// ---- plugin-paths: the state inventory and the mod's modules ---------------

/// A REFERENCE whose state table lists names, plus the baseline's.
fn state_table(names: &[&str]) -> String {
    let mut rows = vec![
        "## `.claude/state/`".to_string(),
        String::new(),
        "| file | what it holds |".into(),
        "|---|---|".into(),
    ];
    for n in std::iter::once(&"base.log").chain(names) {
        rows.push(format!("| `{n}` | x |"));
    }
    rows.extend([String::new(), "---".into(), String::new()]);
    rows.join("\n")
}

/// Scans a tree holding files plus a baseline that names `base.log`
/// literally — an inventory finding no name is its own failure — and a
/// manifest registering every hook the binary dispatches.
fn paths(files: &[(&str, &str)], modules: &[&str]) -> Report {
    let entries: Vec<String> = hook_names().iter().map(|h| format!(r#"{{"type":"command","command":"\"${{CLAUDE_PLUGIN_ROOT}}/bin/spec-flow\" hook {h}"}}"#)).collect();
    let mods = if modules.is_empty() {
        String::new()
    } else {
        format!(r#","modules":["{}"]"#, modules.join(r#"",""#))
    };
    let manifest = format!(
        r#"{{"hooks":{{"Stop":[{{"hooks":[{}]}}]}}{mods}}}"#,
        entries.join(",")
    );
    let table = state_table(&[]);
    let mut all: Vec<(&str, &str)> = vec![
        (
            "engine/base.rs",
            "fn f(root: &Path) {\n    append(&state::state_dir(root).join(\"base.log\"));\n}\n",
        ),
        ("REFERENCE.md", &table),
        ("bin/spec-flow", "#!/bin/sh\n"),
        ("hooks/hooks.json", &manifest),
    ];
    for (f, t) in files {
        all.retain(|(g, _)| g != f);
        all.push((f, t));
    }
    run(plugin_paths, all)
}

#[track_caller]
fn reports_state(r: &Report, file: &str, name: &str) {
    says(r, &format!("{file} names .claude/state/{name}"));
}

/// The shape the human-turn hook writes its log in: a constant another module exports.
const EXPORTED: [(&str, &str); 2] = [
    ("engine/lib/log.rs", "pub const LOG: &str = \"kept.log\";\n"),
    (
        "engine/writer.rs",
        "fn f(root: &Path) {\n    append(&state::state_dir(root).join(lib::log::LOG));\n}\n",
    ),
];

#[test]
fn a_constant_another_module_exports_is_followed_to_its_literal() {
    reports_state(&paths(&EXPORTED, &[]), "engine/writer.rs", "kept.log");
}

#[test]
fn a_constant_the_file_imports_is_followed_to_its_literal() {
    let r = paths(
        &[
            EXPORTED[0],
            (
                "engine/importer.rs",
                "use crate::lib::log::LOG;\n\nfn f(root: &Path) {\n    append(&state::state_dir(root).join(LOG));\n}\n",
            ),
        ],
        &[],
    );
    reports_state(&r, "engine/importer.rs", "kept.log");
    let r = paths(
        &[
            EXPORTED[0],
            (
                "engine/importer.rs",
                "use crate::lib::log;\n\nfn f(root: &Path) {\n    append(&state::state_dir(root).join(log::LOG));\n}\n",
            ),
        ],
        &[],
    );
    reports_state(&r, "engine/importer.rs", "kept.log");
}

#[test]
fn a_constant_the_file_binds_at_its_top_level_is_followed() {
    let r = paths(
        &[(
            "engine/reader.rs",
            "const LOG: &str = \"kept.log\";\n\nfn f(root: &Path) {\n    read(&root.join(\".claude\").join(\"state\").join(LOG));\n}\n",
        )],
        &[],
    );
    reports_state(&r, "engine/reader.rs", "kept.log");
}

#[test]
fn a_binding_of_the_state_directory_is_followed_within_its_function() {
    let r = paths(
        &[(
            "engine/bound.rs",
            "fn a(root: &Path) {\n    let dir = state::state_dir(root);\n    write(&dir.join(\"kept.log\"));\n}\n\nfn b(root: &Path) {\n    let dir = root.join(\"specflow\");\n    read(&dir.join(\"spec.md\"));\n}\n",
        )],
        &[],
    );
    reports_state(&r, "engine/bound.rs", "kept.log");
    assert!(
        !r.to_string().contains("spec.md"),
        "a binding was followed into a function where the name holds another directory.\n{r}"
    );
}

#[test]
fn a_followed_name_with_its_row_passes() {
    let table = state_table(&["kept.log"]);
    clean(
        &paths(&[EXPORTED[0], EXPORTED[1], ("REFERENCE.md", &table)], &[]),
        "a listed name was reported",
    );
}

/// Each path goes through a parameter or a local: a scan that guessed would
/// take the name from a module it was never qualified with, or from a
/// constant inside another function, and report a name no path holds.
#[test]
fn a_parameter_or_a_local_is_not_guessed_at() {
    clean(
        &paths(
            &[
                (
                    "engine/names.rs",
                    "pub const LOG: &str = \"elsewhere.log\";\n",
                ),
                (
                    "engine/param.rs",
                    "fn read(root: &Path, LOG: &str) -> String {\n    read_file(&state::state_dir(root).join(LOG))\n}\n",
                ),
                (
                    "engine/scoped.rs",
                    "fn f() -> &'static str {\n    const LOG: &str = \"inner.log\";\n    LOG\n}\n\nfn g(root: &Path, LOG: &str) -> PathBuf {\n    state::state_dir(root).join(LOG)\n}\n",
                ),
            ],
            &[],
        ),
        "a name guessed from elsewhere was reported",
    );
}

#[test]
fn a_test_names_no_state_the_engine_writes() {
    let module = "fn f() {}\n\n#[cfg(test)]\nmod tests {\n    fn t(root: &Path) {\n        state::state_dir(root).join(\"fixture-only.log\");\n    }\n}\n";
    let suite = "fn t(root: &Path) {\n    state::state_dir(root).join(\"fixture-only.log\");\n}\n";
    clean(
        &paths(
            &[("engine/unit.rs", module), ("engine/tests/suite.rs", suite)],
            &[],
        ),
        "a test's own state name was reported",
    );
}

#[test]
fn module_inventory() {
    let view = ("hooks/view.tsx", "export const register = () => {}\n");
    let types = (
        ".claude-plugin/plugin.json",
        r#"{"name":"p","types":"./hooks/view-state.d.ts"}"#,
    );
    says(
        &paths(&[], &["./view.tsx"]),
        "names the module hooks/view.tsx",
    );
    says(&paths(&[view], &[]), "hooks/view.tsx exists but");
    says(
        &paths(&[view, types], &["./view.tsx"]),
        "names the types contract",
    );
    clean(
        &paths(
            &[
                view,
                types,
                ("hooks/view.test.tsx", ""),
                ("hooks/view-state.d.ts", ""),
            ],
            &["./view.tsx"],
        ),
        "a shipped, named module was reported",
    );
}

#[test]
fn hook_inventory() {
    let r = run(
        plugin_paths,
        [(
            "hooks/hooks.json",
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"\"${CLAUDE_PLUGIN_ROOT}/bin/spec-flow\" hook nonesuch"}]}]}}"#,
        )],
    );
    says(
        &r,
        "registers `hook nonesuch`, which the binary does not dispatch",
    );
    says(
        &r,
        "dispatches `hook gate` and hooks.json never registers it",
    );
    // Exec form is the spawn ADR-052 left: an entry spelled that way registers nothing.
    let r = run(
        plugin_paths,
        [(
            "hooks/hooks.json",
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"${CLAUDE_PLUGIN_ROOT}/bin/spec-flow","args":["hook","gate"]}]}]}}"#,
        )],
    );
    says(
        &r,
        "dispatches `hook gate` and hooks.json never registers it",
    );
    let r = run(
        plugin_paths,
        [(
            "commands/run.md",
            "Run `${CLAUDE_PLUGIN_ROOT}/bin/nonesuch`.\n",
        )],
    );
    says(
        &r,
        "commands/run.md:1  bin/nonesuch does not exist in this package",
    );
}

// ---- line-ends -------------------------------------------------------------

#[test]
fn line_ends_finds_a_multiline_regex() {
    let flag = ["(?", "m)"].concat();
    let inline = format!(
        "static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r\"{flag}^a$\").unwrap());\n"
    );
    reported(
        &run(line_ends, [("engine/x.rs", inline.as_str())]),
        "engine/x.rs:1",
    );
    let wrapped = format!(
        "static RE: LazyLock<Regex> = LazyLock::new(|| {{\n    Regex::new(\n        r\"{flag}^a$\",\n    )\n    .unwrap()\n}});\n"
    );
    reported(
        &run(line_ends, [("engine/x.rs", wrapped.as_str())]),
        "engine/x.rs:2",
    );
    let unit = format!(
        "fn f() {{}}\n\n#[cfg(test)]\nmod tests {{\n    fn t() {{ Regex::new(r\"{flag}^a$\"); }}\n}}\n"
    );
    clean(
        &run(
            line_ends,
            [
                (
                    "engine/x.rs",
                    "static RE: LazyLock<Re> = LazyLock::new(|| Re::new(\"^a$\", \"m\"));\n",
                ),
                ("engine/y.rs", unit.as_str()),
                ("engine/tests/z.rs", inline.as_str()),
            ],
        ),
        "jsre, or a test, was reported",
    );
}

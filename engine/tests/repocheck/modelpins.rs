//! ModelPins holds that every agent routes to a model TIER and nothing this
//! plugin ships names a model VERSION (ADR-013). Finding NO agents is a
//! failure: a check that only forbids a token reports a directory it never
//! reached exactly as it reports a clean one. Then no shipped file names a
//! version, in an id or in prose: the frontmatter is what Claude Code obeys,
//! the prose is what the model reads.
//!
//! `decisions/` is not scanned: a record claims a moment, and ADR-013 has to
//! name the dated id it removed to say what changed.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use spec_flow::agents::{ALIASES, EFFORT_LEVELS};
use spec_flow::jsre::Re;

use crate::{Report, md_in, read_rel, surfaces};

/// The agents that take the human's session effort, each with the reason. An
/// agent missing here AND declaring no effort fails: that is
/// indistinguishable from nobody having considered it (ADR-015).
pub const INHERITS_EFFORT: [(&str, &str); 1] = [(
    "implementer",
    "the milestone decides the work, and its difficulty is the plan's claim rather than this file's — a human who dials their session up for a hard feature should reach the code that feature needs",
)];

/// Where routing is described. `hooks` and `engine` route nothing, but a
/// version reaches prose through whichever file nobody thought to scan.
pub const MODEL_PIN_DIRS: [&str; 7] = [
    "agents",
    "modes",
    "commands",
    "hooks",
    "engine",
    "skills",
    ".claude/skills",
];
pub const MODEL_PIN_EXTS: [&str; 5] = [".rs", ".md", ".json", ".ts", ".tsx"];
pub const MODEL_PIN_FILES: [&str; 5] = [
    "README.md",
    "REFERENCE.md",
    "CLAUDE.md",
    "BACKLOG.md",
    ".github/workflows/ci.yml",
];

const MODEL_PIN_SELF: &str = "engine/tests/repocheck/modelpins.rs";

static VERSIONED: LazyLock<[(Re, &str); 2]> = LazyLock::new(|| {
    [
        // Anchored on the vendor prefix, so the bare alias ADR-013 requires never matches.
        (
            Re::new(r"\bclaude-(opus|sonnet|haiku|fable)[\w.-]*", "i"),
            "a pinned model id",
        ),
        // The lookbehind keeps this off the tail of a full id, which the
        // pattern above owns: a pin is reported once, under one label.
        (
            Re::new(r"(?<!claude-)\b(opus|sonnet|haiku|fable)[ -]\d", "i"),
            "a tier with a version number",
        ),
    ]
});
static MODEL_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^model:[ \t]*(\S+)").unwrap());
static DESC_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^description:[ \t]*(.+)$").unwrap());
static EFFORT_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^effort:[ \t]*(\S+)").unwrap());

fn frontmatter(text: &str) -> Option<&str> {
    let rest = text.strip_prefix("---")?;
    rest.find("\n---").map(|end| &rest[..end])
}

pub fn model_pins(root: &Path) -> Report {
    let mut r = Report::new("model-pins");
    r.advice = "An agent names the tier its job needs and lets the harness resolve the current model of that tier. A version belongs in decisions/, where a record claims a moment. See ADR-013.";
    let files = md_in(root, "agents");
    if files.is_empty() {
        r.problems.push("no agent files were found under agents/. That is a failure rather than a clean run: this check would otherwise report a directory it cannot see exactly as it reports one with nothing wrong in it.".into());
    }
    let mut routing = Vec::new();
    for file in &files {
        let text = read_rel(root, &format!("agents/{file}"));
        let Some(head) = frontmatter(&text) else {
            r.problems.push(format!("agents/{file} has no frontmatter block, so Claude Code registers no agent for it at all."));
            continue;
        };
        let Some(m) = MODEL_LINE.captures(head) else {
            r.problems.push(format!("agents/{file} declares no `model:`. An omitted model means `inherit` — the agent silently runs on whatever the main session is using, so a cheap pass can run on the most expensive model and nothing says so."));
            continue;
        };
        let declared = &m[1];
        if !ALIASES.contains(&declared) {
            r.problems.push(format!("agents/{file} routes to `{declared}`, which is not one of the tier aliases ({}). A pinned id freezes this agent on one model as the tiers move past it — see ADR-013.", ALIASES.join(", ")));
            continue;
        }
        // Presence, not exclusivity: naming another tier as well is ordinary.
        let desc = DESC_LINE
            .captures(head)
            .map(|d| d[1].to_string())
            .unwrap_or_default();
        if !Regex::new(&format!(r"(?i)\b{declared}\b"))
            .unwrap()
            .is_match(&desc)
        {
            r.problems.push(format!("agents/{file} routes to `{declared}` and its `description` never says so. The description is what the orchestrator reads to know what a spawn costs, so a frontmatter re-route that stops there is invisible at exactly the moment the routing is chosen."));
            continue;
        }
        let name = file.trim_end_matches(".md");
        let effort = EFFORT_LINE.captures(head).map(|e| e[1].to_string());
        let inherits = INHERITS_EFFORT.iter().any(|(n, _)| *n == name);
        match &effort {
            Some(e) if !EFFORT_LEVELS.contains(&e.as_str()) => {
                r.problems.push(format!("agents/{file} declares `effort: {e}`, which is not one of {}. Nothing downstream will complain: a spawn discards an effort it cannot read, so a typo here is a setting that looks applied and is not — see ADR-015.", EFFORT_LEVELS.join(", ")));
                continue;
            }
            None if !inherits => {
                r.problems.push(format!("agents/{file} declares no `effort:` and is not listed in INHERITS_EFFORT in {MODEL_PIN_SELF}. An agent with no effort inherits the human's session, so the flow's cost stops being a property of the flow — a cheap pass runs at `max` whenever someone's session is. Declare one, or record there why this agent should follow the session, so the asymmetry is a decision rather than the one nobody got to."));
                continue;
            }
            Some(e) if inherits => {
                r.problems.push(format!("agents/{file} declares `effort: {e}` while INHERITS_EFFORT in {MODEL_PIN_SELF} still says it should follow the session. One of the two is stale, and the file that loses is whichever nobody re-read."));
                continue;
            }
            _ => {}
        }
        let effort = effort.unwrap_or_else(|| "inherited from the session".into());
        routing.push(format!("{name} -> {declared}, effort {effort}"));
    }
    let scanned = surfaces(
        root,
        &MODEL_PIN_DIRS,
        &MODEL_PIN_EXTS,
        &MODEL_PIN_FILES,
        MODEL_PIN_SELF,
        &[],
    );
    for f in &scanned {
        for (i, line) in read_rel(root, f).split('\n').enumerate() {
            for (re, label) in VERSIONED.iter() {
                if re.test(line) {
                    r.problems
                        .push(format!("{f}:{}  {label}\n    {}", i + 1, line.trim()));
                }
            }
        }
    }
    r.ok = format!(
        "{} file(s) name no version; {} agent(s) route by tier.\n  {}",
        scanned.len(),
        routing.len(),
        routing.join("\n  ")
    );
    r
}

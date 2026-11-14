//! AgentContracts holds the agents' Markdown to what the code and the other
//! agents expect of it, at each seam where prose has to agree with prose or
//! with code — none of which any fixture executes:
//!
//! - a field the planner's milestone template declares is named in the
//!   reviewer's checklist, or exempt here with a reason. A field the planner
//!   writes and nobody checks is a field it can silently omit.
//! - a field a routed agent RETURNS is named by a command, or exempt with a
//!   reason: `GAPS:` is the only channel for a finding no check produces (ADR-020).
//! - an agent asserting that spec-trace FAILS over a contract-gated subject
//!   names the field that gates it, or the sentence is false wherever the
//!   project left it off.
//! - the spec-writer's contract states the question cap and the words a
//!   prohibition is read by, and its template carries the assumptions
//!   section the checks hold its output to (ADR-030, ADR-045).
//! - each command's fold offers a weak test's fix as `/spec-fix` only (ADR-042).
//! - a `tools:` list nobody wrote is the widest grant the harness offers,
//!   and looks identical to a deliberate one.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use spec_flow::agents::blocks::{MAX_OPEN_QUESTIONS, return_blocks, unrouted_fields};
use spec_flow::spec::shape::{PROHIBITION_WORDS, assumptions_problem};

use crate::{Report, md_in, read_rel};

/// Template fields the reviewer deliberately does not check. A field belongs
/// here when checking it would add nothing, not when nobody got round to it.
pub const NOT_REVIEWED: [(&str, &str); 3] = [
    (
        "Objective",
        r#"what "done" means for a milestone is judged through its deltas and its tests, which are the checkable form of the same claim"#,
    ),
    (
        "Steps",
        "the reviewer judges whether the plan will bite during implementation, which is these in aggregate; per-step review is the second pass this flow deliberately cut",
    ),
    (
        "Depends on",
        r#"covered by "are milestones correctly ordered and independently testable", which is stronger than the field"#,
    ),
];

/// Return fields the commands deliberately do not name: for every routed
/// agent (`FIELD`) or for one (`agent.FIELD`).
pub const NOT_ROUTED: [(&str, &str); 15] = [
    (
        "STATUS",
        "the block's own discriminator — every command branches on its VALUE, which is named, rather than on the key",
    ),
    // Read by MEANING: the orchestrator acts on the path or the text and
    // never needs to say the label back. Ceremony in a prompt costs tokens.
    (
        "SPEC_PATH",
        "the commands work from `specflow/<SLUG>/spec.md` directly — the path is used, the label never has to be",
    ),
    (
        "PROPOSAL_PATH",
        "same as SPEC_PATH: `proposal.md` is named where it is read, at sign-off",
    ),
    (
        "SUMMARY",
        "step 1 already tells the orchestrator to show the user a summary drawn from both artifacts; the key adds nothing to that instruction",
    ),
    (
        "DELTAS",
        "/spec-fix routes on CASE, and the deltas it names are the ones the spec file already carries",
    ),
    (
        "PLAN_PATH",
        "same as SPEC_PATH: the commands work from `specflow/<SLUG>/plan.md` directly",
    ),
    (
        "MILESTONES",
        "step 4 walks the milestone index in plan.md, not this line",
    ),
    (
        "ANSWERS",
        r#"handed whole to the re-invoked reviewer ("with the answers"), which reads them by meaning"#,
    ),
    (
        "CHANGES",
        "REPLAN's account of what it rewrote; the implementer is sent back to the revised Mk.md, not to this line",
    ),
    // The architect's answer, relayed whole as ARCHITECT_GUIDANCE (ADR-038).
    (
        "architect.DECISIONS",
        "relayed whole to the implementer as ARCHITECT_GUIDANCE; nothing branches on it",
    ),
    (
        "architect.DESIGN_NOTES",
        "relayed whole to the implementer with DECISIONS; nothing branches on it",
    ),
    (
        "reviewer.NOTES",
        "optional remarks on an APPROVED plan; a doubt or a problem comes back under a status that is routed",
    ),
    // Confirmations of work already done: there is no branch to take.
    (
        "SPECS_VERIFIED",
        "a confirmation of the verification, not a finding — a delta that did NOT land comes back through GAPS, which is routed",
    ),
    (
        "FIXED",
        "a confirmation of spec-side edits the fold is entitled to make on its own",
    ),
    (
        "ARCHIVED",
        "a confirmation of the move; an unarchived specflow/<SLUG>/ is caught by phase-guard when `done` is written, which is a check rather than a prompt",
    ),
];

/// Agents whose findings the orchestrator itself acts on. The implementer's
/// return is handed whole to the next agent, so it is relayed, never branched
/// on. An agent's blocks include its `modes/<name>-*.md`.
pub const ROUTED_AGENTS: [&str; 4] = ["spec-writer", "planner", "reviewer", "architect"];

/// Where spec-trace's contract-gated checks are read from.
pub const SPEC_TRACE: &str = "engine/spec/trace.rs";

static TEMPLATE_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?m)^- ([A-Z][^:\n]*):").unwrap());
/// `!cfg.trace.require_skills_field {` … `continue`: a check the contract switches off.
static GATED_CHECK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"!cfg\.trace\.(\w+)\s*\{\s*continue").unwrap());
static PARAGRAPH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n\s*\n").unwrap());
static FAILS_WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\bfails?\b|\brejects?\b|\brefuses?\b").unwrap());
static TOOLS_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^tools:[ \t]*\S").unwrap());
static YAML_FRONT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^---\r?\n((?s:.*?))\r?\n---").unwrap());
static FOLD_STEP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?ms)^## 5\. FOLD.*?^## ").unwrap());

/// The fenced block after the first occurrence of `intro`.
pub fn fence_after<'t>(text: &'t str, intro: &str) -> Option<&'t str> {
    let at = text.find(intro)?;
    let open = at + text[at..].find("```")?;
    let end = text[open + 3..].find("```")?;
    Some(&text[open + 3..open + 3 + end])
}

fn whole_word(word: &str, text: &str) -> bool {
    Regex::new(&format!(r"(?i)\b{}\b", regex::escape(word)))
        .unwrap()
        .is_match(text)
}

pub fn agent_contracts(root: &Path) -> Report {
    let mut r = Report::new("agent-contracts");
    let mut add = |p: String| r.problems.push(p);
    let planner = read_rel(root, "agents/planner.md");
    let reviewer = read_rel(root, "agents/reviewer.md");

    // ---- the milestone template, anchored to the line naming it: if the
    // anchor stops matching, this fails rather than checking an empty set.
    let fields: Vec<String> = fence_after(&planner, "milestones/Mk.md`**")
        .map(|t| {
            TEMPLATE_FIELD
                .captures_iter(t)
                .map(|m| m[1].to_string())
                .collect()
        })
        .unwrap_or_default();
    if fields.is_empty() {
        add("the milestone template could not be found in agents/planner.md. It is anchored to the line naming `milestones/Mk.md` followed by a fenced block; if that moved, fix this check rather than leaving it matching nothing — a check that silently finds no fields passes forever.".into());
    }
    for f in &fields {
        // Whole words: "objectively" does not name `Objective`.
        if whole_word(f, &reviewer) || NOT_REVIEWED.iter().any(|(k, _)| k == f) {
            continue;
        }
        add(format!(
            r#"the planner's milestone template declares "{f}" and agents/reviewer.md never names it. The reviewer is the only pass that reads a milestone before an implementer is spent, so a field nobody checks is a field the planner can silently omit. Add it to the reviewer's checklist, or add it to NOT_REVIEWED in engine/tests/repocheck/agentcontracts.rs with the reason it does not need one."#
        ));
    }
    if !fields.is_empty() {
        for (f, _) in NOT_REVIEWED {
            if !fields.iter().any(|x| x == f) {
                add(format!(
                    r#"NOT_REVIEWED exempts "{f}", which the milestone template no longer declares. Remove the entry — an exemption nobody can reach is a decision about a field that does not exist."#
                ));
            }
        }
    }

    // ---- a field an agent RETURNS is read by the command driving it
    let commands =
        read_rel(root, "commands/spec-flow.md") + "\n" + &read_rel(root, "commands/spec-fix.md");
    let not_routed: Vec<&str> = NOT_ROUTED.iter().map(|(k, _)| *k).collect();
    let mut returned_by: BTreeMap<String, Vec<&str>> = BTreeMap::new();
    for name in ROUTED_AGENTS {
        let mut text = read_rel(root, &format!("agents/{name}.md"));
        for f in md_in(root, "modes") {
            if f.starts_with(&format!("{name}-")) {
                text += "\n";
                text += &read_rel(root, &format!("modes/{f}"));
            }
        }
        let (blocks, declared) = return_blocks(&text);
        if blocks == 0 {
            add(format!(
                "agents/{name}.md and modes/{name}-*.md declare no `STATUS:` return block. They are anchored to a fenced block opening with `STATUS:`; if that shape moved, fix this check rather than leaving it matching nothing — a check that silently finds no fields passes forever."
            ));
        }
        for f in declared {
            returned_by.entry(f).or_default().push(name);
        }
    }
    for (f, agents) in &returned_by {
        for agent in agents {
            if not_routed.contains(&format!("{agent}.{f}").as_str())
                || unrouted_fields(&[f], &commands, &not_routed).is_empty()
            {
                continue;
            }
            add(format!(
                r#"agents/{agent}.md returns "{f}:" and neither command names it. A return field no command reads is a finding that reaches the orchestrator and stops there — which for a field like GAPS is the only report of something no check in this engine can produce. Name it in the command that drives that mode, or add it to NOT_ROUTED in engine/tests/repocheck/agentcontracts.rs with the reason it needs no handling."#
            ));
        }
    }
    for key in &not_routed {
        let reachable = match key.split_once('.') {
            Some((agent, field)) => returned_by.get(field).is_some_and(|a| a.contains(&agent)),
            None => returned_by.contains_key(*key),
        };
        if !reachable {
            add(format!(
                r#"NOT_ROUTED exempts "{key}", which no routed agent's return block declares. Remove the entry — an exemption nobody can reach is a decision about a field that does not exist."#
            ));
        }
    }

    // ---- an agent may not describe a GATED check as unconditional. The gated
    // fields are read out of spec-trace itself: a list would agree with the
    // code exactly until someone gates a second check.
    let gated: Vec<String> = GATED_CHECK
        .captures_iter(&read_rel(root, SPEC_TRACE))
        .map(|m| m[1].to_string())
        .collect();
    if gated.is_empty() {
        add(format!(
            "no contract-gated check was found in {SPEC_TRACE} (the `!cfg.trace.<field> {{` … `continue` shape). If that line was rewritten, fix the pattern here; if the last gated check was removed, remove this check too — matching nothing, it passes forever."
        ));
    }
    let contracts: Vec<String> = md_in(root, "agents")
        .into_iter()
        .map(|f| format!("agents/{f}"))
        .chain(
            md_in(root, "modes")
                .into_iter()
                .map(|f| format!("modes/{f}")),
        )
        .collect();
    for field in &gated {
        // `require_skills_field` -> `skills`: the word prose uses for the subject.
        let subject = field
            .trim_start_matches("require_")
            .trim_end_matches("_field")
            .replace('_', " ");
        for file in &contracts {
            let text = read_rel(root, file);
            if text.contains(field.as_str()) {
                continue;
            }
            // Paragraph, not sentence: the assertion and its subject sit in neighbouring sentences.
            for para in PARAGRAPH.split(&text) {
                let lower = para.to_lowercase();
                if lower.contains("spec-trace")
                    && lower.contains(&subject)
                    && FAILS_WORD.is_match(&lower)
                {
                    add(format!(
                        "{file} tells its reader that spec-trace fails over \"{subject}\", and never names `{field}` — the contract field that decides whether that check runs at all. It is off by default, so the sentence is false in most repos, and an agent cannot discover that from inside a run: the only evidence would be a gate that never fires. State the condition, or say what actually always checks it."
                    ));
                    break;
                }
            }
        }
    }

    // ---- the spec-writer's contract states what the checks hold it to
    let spec_writer = read_rel(root, "agents/spec-writer.md");
    match fence_after(&spec_writer, "## Spec format (spec.md)") {
        None => add("the spec template could not be found in agents/spec-writer.md (a fenced block after `## Spec format (spec.md)`). Fix this check rather than leaving it matching nothing.".into()),
        Some(tmpl) => {
            let p = assumptions_problem(tmpl);
            if !p.is_empty() {
                add(format!("agents/spec-writer.md's spec template {p}: a writer following it writes a spec the check rejects."));
            }
        }
    }
    if !spec_writer.contains(&format!("at most {MAX_OPEN_QUESTIONS} questions")) {
        add(format!(
            r#"agents/spec-writer.md does not say "at most {MAX_OPEN_QUESTIONS} questions", the cap in agents::blocks::MAX_OPEN_QUESTIONS."#
        ));
    }
    if PROHIBITION_WORDS.len() < 2 {
        add("spec::shape::PROHIBITION_WORDS holds fewer than two words, so the phrase this check looks for is not a list. Fix this check rather than leaving it matching nothing.".into());
    } else {
        let quoted: Vec<String> = PROHIBITION_WORDS.iter().map(|w| format!("`{w}`")).collect();
        let phrase = format!(
            "{} or {}",
            quoted[..quoted.len() - 1].join(", "),
            quoted[quoted.len() - 1]
        );
        if !spec_writer.contains(&phrase) {
            add(format!(
                "agents/spec-writer.md does not say {phrase}, the words in spec::shape::PROHIBITION_WORDS that spec-trace refuses beside another claim on one id."
            ));
        }
    }
    let assumptions = Regex::new(r"\bAssumptions\b").unwrap();
    for file in ["spec-flow.md", "resume.md"] {
        if !assumptions.is_match(&read_rel(root, &format!("commands/{file}"))) {
            add(format!(
                "commands/{file} never names the spec's Assumptions, so its sign-off does not show the human what the writer decided without asking."
            ));
        }
    }
    // A weak test the fold names is fixed after `done`, where the gate,
    // lint-on-write and the command deny stand down; /spec-fix arms them again.
    let never_fresh = Regex::new(r"(?i)never a fresh implementer").unwrap();
    let fresh = Regex::new(r"(?i)fresh implementer").unwrap();
    for file in ["spec-flow.md", "spec-fix.md"] {
        let text = read_rel(root, &format!("commands/{file}"));
        let step = FOLD_STEP
            .find(&text)
            .map(|m| m.as_str())
            .unwrap_or_default();
        match step.split('\n').find(|l| l.contains("`GAPS:`")) {
            None => add(format!(
                "commands/{file} step 5 has no line naming `GAPS:`; fix this check rather than leaving it matching nothing."
            )),
            Some(offer)
                if !offer.contains("/spec-fix")
                    || fresh.is_match(&never_fresh.replace_all(offer, "")) =>
            {
                add(format!(
                    "commands/{file} step 5 offers a fix for a weak test other than `/spec-fix`. Offered after `done`, any other fix runs with the gate, lint-on-write and the command deny standing down."
                ));
            }
            Some(_) => {}
        }
    }

    // ---- every shipped agent says what it may use. The list's CONTENTS stay
    // the author's business; this asks only that the question was answered.
    let agent_files = md_in(root, "agents");
    if agent_files.is_empty() {
        add("agents/ contains no .md files. A scan that finds nothing passes exactly as a clean directory does, so finding no agents is a failure here rather than a quiet OK.".into());
    }
    for f in &agent_files {
        let text = read_rel(root, &format!("agents/{f}"));
        let Some(m) = YAML_FRONT.captures(&text) else {
            add(format!(
                "agents/{f} has no YAML frontmatter, so the harness reads neither its name nor its model."
            ));
            continue;
        };
        if !TOOLS_LINE.is_match(&m[1]) {
            add(format!(
                "agents/{f} declares no `tools:`, so it inherits every tool the harness offers — including Task, which lets it spawn agents of its own. Name the tools it actually uses. If inheriting everything IS the intent, that is a decision worth a line: say so in the frontmatter and this check still fails, because the field is what records it."
            ));
        }
    }
    r.ok = format!(
        "{} milestone field(s); {} named in the reviewer's checklist, {} exempt with a stated reason; {} agent(s), every one declaring its tools; {} return field(s) from {}, {} routed by a command and {} exempt with a stated reason; {} contract-gated spec-trace check(s), none described as unconditional.",
        fields.len(),
        fields.len().saturating_sub(NOT_REVIEWED.len()),
        NOT_REVIEWED.len(),
        agent_files.len(),
        returned_by.len(),
        ROUTED_AGENTS.join(" and "),
        returned_by.len().saturating_sub(NOT_ROUTED.len()),
        NOT_ROUTED.len(),
        gated.len()
    );
    r
}

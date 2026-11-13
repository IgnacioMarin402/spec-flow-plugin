//! This plugin's agents: which tier each runs on and who decided it
//! (ADR-014), the escalation budgets (ADR-038), who a spawn or a SendMessage
//! is for, and what a stopped agent handed back.

// Budgets, dispatch records and handbacks are read by the spawn guards and
// the trace (B71, B74).
#![allow(dead_code)]

pub mod handback;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, OnceLock};

use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::jsre::Re;
use crate::payload::js_string;
use crate::repo::engine;
use crate::state;

/// The tiers a spawn may be routed to — measured: a hook rewriting a spawn's
/// `model` to a full id is refused as a schema error (ADR-014).
pub const ALIASES: [&str; 4] = ["opus", "sonnet", "haiku", "fable"];

/// What a subagent's frontmatter may declare. Nothing here APPLIES one: the
/// project routes a tier, not an effort (ADR-015).
pub const EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// What a shipped agent's frontmatter declares; `effort` `""` inherits the
/// session's.
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub model: String,
    pub effort: String,
}

static NAME_FIELD: LazyLock<Re> = LazyLock::new(|| Re::new(r"^name:[ \t]*(\S+)", "m"));
static MODEL_FIELD: LazyLock<Re> = LazyLock::new(|| Re::new(r"^model:[ \t]*(\S+)", "m"));
static EFFORT_FIELD: LazyLock<Re> = LazyLock::new(|| Re::new(r"^effort:[ \t]*(\S+)", "m"));

/// `<engine>/agents`, never the consuming repository's.
pub fn agents_dir() -> PathBuf {
    engine::root().join("agents")
}

/// What each agent in `dir` declares, read off the frontmatter Claude Code
/// obeys — a second copy would be a claim about the routing. Empty when
/// unreadable, which every caller treats as "no opinion".
pub fn shipped_in(dir: &Path) -> BTreeMap<String, Agent> {
    let mut agents = BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return agents;
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".md"))
        .collect();
    names.sort();
    for file in names {
        let Some(text) = state::read_text(&dir.join(&file)) else {
            continue;
        };
        let Some(rest) = text.strip_prefix("---") else {
            continue;
        };
        let Some(end) = rest.find("\n---") else {
            continue;
        };
        let head = &rest[..end];
        let name = NAME_FIELD.exec(head).map_or_else(
            || file.trim_end_matches(".md").to_string(),
            |m| m.group(1).into(),
        );
        let Some(model) = MODEL_FIELD.exec(head) else {
            continue;
        };
        let effort = EFFORT_FIELD.exec(head).map_or("", |m| m.group(1));
        agents.insert(
            name.to_lowercase(),
            Agent {
                model: model.group(1).into(),
                effort: effort.into(),
            },
        );
    }
    agents
}

/// What each shipped agent declares. Read once: what ships does not change
/// while a hook runs.
pub fn shipped() -> &'static BTreeMap<String, Agent> {
    static SHIPPED: OnceLock<BTreeMap<String, Agent>> = OnceLock::new();
    SHIPPED.get_or_init(|| shipped_in(&agents_dir()))
}

/// The shipped agents' names, sorted.
pub fn roles() -> Vec<String> {
    shipped().keys().cloned().collect()
}

/// Agent name → tier.
pub fn shipped_routing() -> BTreeMap<String, String> {
    shipped()
        .iter()
        .map(|(n, a)| (n.clone(), a.model.clone()))
        .collect()
}

/// `.claude/spec-flow.config.json`: run-scoped settings, not the
/// architectural contract — a cost knob there would move `contract_version`
/// for every adopter.
pub fn project_config_path(root: &Path) -> PathBuf {
    root.join(".claude").join("spec-flow.config.json")
}

/// That file's settings, read the one way every reader reads them — the
/// caps, the routing, the run-start check and the live view (ADR-047). An
/// empty file has none and no problem; one that does not parse, or is not an
/// object, has none and says why. A BOM is not part of the JSON.
pub fn project_config(text: &str) -> (Map<String, Value>, String) {
    let text = text.strip_prefix('\u{FEFF}').unwrap_or(text);
    if text.trim().is_empty() {
        return (Map::new(), String::new());
    }
    match serde_json::from_str::<Value>(text) {
        Err(e) => (
            Map::new(),
            format!("does not parse as JSON ({e}), so none of its settings apply"),
        ),
        Ok(Value::Object(m)) => (m, String::new()),
        Ok(_) => (
            Map::new(),
            "is not a JSON object, so none of its settings apply".into(),
        ),
    }
}

/// One escalation role's cap, its default and its counter (ADR-038).
pub struct Budget {
    pub key: &'static str,
    pub fallback: i64,
    pub counter: &'static str,
}

/// The roles with a budget, in the order they are reported.
pub const BUDGET_ROLES: [&str; 2] = ["planner", "architect"];

/// What opus-budget denies at and what the live view shows.
pub fn budget(role: &str) -> Option<Budget> {
    match role {
        "planner" => Some(Budget {
            key: "max_opus_calls",
            fallback: 6,
            counter: "opus_calls",
        }),
        "architect" => Some(Budget {
            key: "max_architect_calls",
            fallback: 3,
            counter: "architect_calls",
        }),
        _ => None,
    }
}

// Digits only: Number() would read "0x10" as 16 and "1e1" as 10.
static DIGITS_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[0-9]+\s*$").unwrap());

/// A role's cap from the text of `.claude/spec-flow.config.json`: its default
/// when unset or unreadable, -1 when set to anything that is not a whole
/// number of calls — no count compares true against it as a cap, so a caller
/// must deny instead.
pub fn budget_cap(config_text: &str, role: &str) -> i64 {
    let Some(b) = budget(role) else { return -1 };
    let (settings, _) = project_config(config_text);
    let Some(v) = settings.get(b.key) else {
        return b.fallback;
    };
    let f = match v {
        Value::Number(n) => n.as_f64().unwrap_or(-1.0),
        Value::String(s) if DIGITS_ONLY.is_match(s) => s.trim().parse::<f64>().unwrap_or(-1.0),
        _ => return -1,
    };
    if f < 0.0 || f != f.trunc() || f > f64::from(i32::MAX) {
        return -1;
    }
    f as i64
}

/// Every field a spawn or a SendMessage may name its agent in: on a
/// SendMessage the key differs across builds.
pub fn nameish_fields(input: &Map<String, Value>) -> Vec<String> {
    [
        "subagent_type",
        "subagentType",
        "agent_type",
        "agent_id",
        "agentId",
        "agent",
        "name",
        "recipient",
        "to",
    ]
    .iter()
    .filter_map(|k| input.get(*k)?.as_str().map(String::from))
    .collect()
}

/// The candidate the fields name as a whole word, case-insensitive and
/// lowercased, or `""`. Getting either wrong fails OPEN and silently:
/// arm-gate would not arm the phase.
pub fn match_agent<S: AsRef<str>>(nameish: &[String], candidates: &[S]) -> String {
    if candidates.is_empty() {
        return String::new();
    }
    let alternatives: Vec<String> = candidates
        .iter()
        .map(|c| regex::escape(c.as_ref()))
        .collect();
    let re = Regex::new(&format!(
        "(?i)(^|[^a-zA-Z])({})($|[^a-zA-Z])",
        alternatives.join("|")
    ))
    .unwrap();
    re.captures(&nameish.join(" "))
        .map_or_else(String::new, |m| m[2].to_lowercase())
}

/// The project's overrides, plus everything wrong with them. Problems are
/// returned, not swallowed: a typo'd agent name reads as though it routes
/// something and routes nothing, forever. A file that does not parse routes
/// nothing, as it caps nothing.
pub fn project_routing(
    root: &Path,
    shipped: &BTreeMap<String, String>,
) -> (BTreeMap<String, String>, Vec<String>) {
    let mut routing = BTreeMap::new();
    let mut problems = Vec::new();
    let Some(text) = state::read_text(&project_config_path(root)) else {
        return (routing, problems);
    };
    let (settings, _) = project_config(&text);
    let Some(declared) = settings.get("agents") else {
        return (routing, problems);
    };
    let Value::Object(m) = declared else {
        problems.push(
            r#""agents" is not an object mapping an agent name to a tier, so nothing in it can be applied."#
                .into(),
        );
        return (routing, problems);
    };
    let known: Vec<&str> = shipped.keys().map(String::as_str).collect();
    // A map's keys are sorted: the problems come in one order every time.
    for (raw, tier) in m {
        let name = raw.to_lowercase();
        if !known.is_empty() && !known.contains(&name.as_str()) {
            problems.push(format!(
                r#""agents": {{ "{raw}": ... }} names no agent this plugin ships ({}). A name nothing matches routes nothing, and reads exactly like a routing that works."#,
                known.join(", ")
            ));
            continue;
        }
        match tier {
            Value::String(t) if ALIASES.contains(&t.as_str()) => {
                routing.insert(name, t.clone());
            }
            _ => problems.push(format!(
                r#""agents": {{ "{raw}": {tier} }} is not one of {}. A spawn only accepts a tier — a full model id is refused by the tool call itself."#,
                ALIASES.join(", ")
            )),
        }
    }
    (routing, problems)
}

/// Who decided the tier an agent runs on.
#[derive(Debug, PartialEq)]
pub enum Source {
    /// What the agent ships with.
    Default,
    /// The project, re-routing it.
    Project,
}

/// The tier `agent` will run on and who decided it. `Project` only when the
/// override differs from the shipped default: restating the default is not
/// a re-route.
pub fn resolve_model(
    root: &Path,
    agent: &str,
    shipped: &BTreeMap<String, String>,
) -> (String, Source, Vec<String>) {
    let name = agent.to_lowercase();
    let (routing, problems) = project_routing(root, shipped);
    let fallback = shipped.get(&name).cloned().unwrap_or_default();
    match routing.get(&name) {
        Some(o) if !o.is_empty() && *o != fallback => (o.clone(), Source::Project, problems),
        _ => (fallback, Source::Default, problems),
    }
}

static WORD_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_-]+$").unwrap());

/// The session's record of a subagent a SendMessage's `to` names, beside its
/// transcript.
pub struct Recipient {
    pub to: String,
    pub file: PathBuf,
}

/// That record, or `None` when `to` is not an id or there is no transcript to
/// look beside.
pub fn recipient_record(to: &str, transcript: &str) -> Option<Recipient> {
    if !WORD_ID.is_match(to) || transcript.is_empty() {
        return None;
    }
    let dir = transcript.strip_suffix(".jsonl").unwrap_or(transcript);
    Some(Recipient {
        to: to.into(),
        file: Path::new(dir)
            .join("subagents")
            .join(format!("agent-{to}.jsonl")),
    })
}

/// The agent type a SendMessage is for, as the session recorded it at the
/// spawn: an id says nothing of the role (ADR-035).
pub fn recipient_type(rec: &Recipient) -> String {
    let meta = rec.file.with_extension("meta.json");
    let Some(text) = state::read_text(&meta) else {
        return String::new();
    };
    match serde_json::from_str::<Value>(&text) {
        Ok(Value::Object(m)) => js_string(m.get("agentType")),
        _ => String::new(),
    }
}

/// A resume after the agent's prompt cache expired.
pub struct Cold {
    pub to: String,
    pub agent: String,
    pub age_min: f64,
    pub ttl_min: u32,
    pub context: i64,
}

#[derive(Deserialize)]
struct UsageEntry {
    message: UsageMessage,
}

#[derive(Deserialize)]
struct UsageMessage {
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: f64,
    #[serde(default)]
    cache_read_input_tokens: f64,
    #[serde(default)]
    cache_creation_input_tokens: f64,
    #[serde(default)]
    cache_creation: CacheSplit,
}

#[derive(Deserialize, Default)]
struct CacheSplit {
    #[serde(default)]
    ephemeral_1h_input_tokens: f64,
    #[serde(default)]
    ephemeral_5m_input_tokens: f64,
}

/// Whether a SendMessage to `to` would resume one of this plugin's agents
/// after its cache expired (ADR-025), or `None` when it cannot tell — and
/// every caller reads `None` as "not cold": a guess would deny work.
pub fn cold_resume(to: &str, transcript: &str) -> Option<Cold> {
    let rec = recipient_record(to, transcript)?;
    let typ = recipient_type(&rec);
    let age = state::age(&rec.file)?;
    let text = state::read_text(&rec.file)?;
    let agent = match_agent(&[typ], &roles());
    if agent.is_empty() {
        return None;
    }
    // The TTL is read off the agent's own last cache write: a subagent writes
    // 5-minute entries and a session 1-hour ones (measured).
    let (mut ttl, mut context) = (0, 0i64);
    for line in text.split('\n').rev() {
        if ttl != 0 {
            break;
        }
        if !line.contains(r#""usage""#) {
            continue;
        }
        let Ok(UsageEntry {
            message: UsageMessage { usage: Some(u) },
        }) = serde_json::from_str(line)
        else {
            continue;
        };
        if context == 0 {
            context =
                (u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens) as i64;
        }
        if u.cache_creation.ephemeral_1h_input_tokens > 0.0 {
            ttl = 60;
        } else if u.cache_creation.ephemeral_5m_input_tokens > 0.0 {
            ttl = 5;
        }
    }
    if ttl == 0 {
        return None;
    }
    // The file's last write is AFTER the request that last touched the cache,
    // so this can only understate the age: a resume it calls cold is cold.
    let age_min = age.as_secs_f64() / 60.0;
    if age_min <= f64::from(ttl) {
        return None;
    }
    Some(Cold {
        to: rec.to,
        agent,
        age_min,
        ttl_min: ttl,
        context,
    })
}

/// The roles each phase dispatches, read off both commands. The implementer
/// is absent: engaging it moves the phase, which is arm-gate's.
pub fn dispatched_in(phase: &str) -> Option<&'static [&'static str]> {
    match phase {
        "spec" => Some(&["spec-writer"]),
        "plan" => Some(&["planner"]),
        "review" => Some(&["reviewer", "planner"]),
        "implement" => Some(&["architect", "planner", "spec-writer"]),
        "blocked" => Some(&[]),
        _ => None,
    }
}

/// Writes one `dispatch` line to run-trace.log: `agent=`, not `type=`, which
/// stats reads as an agent's return. Every value is whitespace-free, because
/// the log is read back by a whitespace split.
pub fn record_dispatch(
    root: &Path,
    payload: &Map<String, Value>,
    phase: &str,
    agent: &str,
    result: &str,
    why: &str,
    extra: &[(&str, &str)],
) {
    fn safe(v: &str) -> String {
        let v: String = v
            .chars()
            .filter(|c| !matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0C'))
            .collect();
        if v.is_empty() { "-".into() } else { v }
    }
    let session = ["session_id", "sessionId"]
        .iter()
        .find_map(|k| payload.get(*k)?.as_str().filter(|s| WORD_ID.is_match(s)))
        .map_or_else(String::new, |s| format!(" session={s}"));
    let tool = js_string(payload.get("tool_name"));
    let fields = [
        ("agent", agent),
        ("tool", tool.as_str()),
        ("result", result),
        ("why", why),
    ];
    let parts: Vec<String> = fields
        .iter()
        .chain(extra)
        .map(|(k, v)| format!("{k}={}", safe(v)))
        .collect();
    state::append_line(
        &state::state_dir(root).join("run-trace.log"),
        &format!(
            "{} phase={}{session} dispatch {}",
            state::now_iso(),
            safe(phase),
            parts.join(" ")
        ),
    );
}

// Its work order, in either separator: Windows names
// `specflow\x\milestones\M2.md`.
static WORK_ORDER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"specflow[\\/]([^\\/\t\n\x0C\r "'`]+)[\\/]milestones[\\/](M[0-9]+)\.md"#).unwrap()
});
static BARE_REF: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"milestones[\\/](M[0-9]+)\.md").unwrap());
static BARE_GUARD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_.-][\\/]?$").unwrap());

/// The milestone an implementer's spawn works on: the first work order its
/// prompt names, else a bare `milestones/<Mk>.md` starting a path, with no
/// change (`""`). `None` when it names neither. One reading for every reader:
/// the live view finds the agent a record names by it.
pub fn milestone_ref(prompt: Option<&Value>) -> Option<(String, String)> {
    let text = prompt?.as_str()?;
    if let Some(m) = WORK_ORDER.captures(text) {
        return Some((m[1].into(), m[2].into()));
    }
    // `docs/milestones/M1.md` is some other file: what precedes must not be a
    // path segment.
    BARE_REF
        .captures_iter(text)
        .find(|m| !BARE_GUARD.is_match(&text[..m.get(0).unwrap().start()]))
        .map(|m| (String::new(), m[1].into()))
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    #[test]
    fn project_config_reads_one_way() {
        // A file written after a byte-order mark is the same file.
        let (s, p) = project_config("\u{FEFF}{\"max_opus_calls\": 2}");
        assert_eq!(
            (Value::Object(s), p.as_str()),
            (json!({"max_opus_calls": 2}), "")
        );
        for text in ["", "  \n", "\u{FEFF}"] {
            let (s, p) = project_config(text);
            assert!(
                s.is_empty() && p.is_empty(),
                "an empty file {text:?} sets something"
            );
        }
        let (_, p) = project_config(r#"{ "max_opus_calls": 2, }"#);
        assert!(p.contains("does not parse as JSON"), "{p}");
        for text in ["null", "[]", "6", r#""six""#] {
            let (s, p) = project_config(text);
            assert!(
                s.is_empty() && p.contains("not a JSON object"),
                "{text}: {p}"
            );
        }
    }

    #[test]
    fn milestone_ref_reads_the_work_order() {
        let some = |c: &str, m: &str| Some((c.to_string(), m.to_string()));
        for (prompt, want) in [
            // The work order, in either separator.
            (
                json!("implement specflow/add-users/milestones/M2.md per the plan"),
                some("add-users", "M2"),
            ),
            (
                json!(r"implement C:\repo\specflow\add-users\milestones\M2.md"),
                some("add-users", "M2"),
            ),
            (
                json!("`specflow/add-users/milestones/M12.md`"),
                some("add-users", "M12"),
            ),
            // The work order wins over a milestone file named before it.
            (
                json!(
                    "see docs/milestones/M1.md, then implement specflow/add-users/milestones/M2.md"
                ),
                some("add-users", "M2"),
            ),
            (
                json!("after milestones/M1.md, implement specflow/add-users/milestones/M2.md"),
                some("add-users", "M2"),
            ),
            // A bare milestones/<Mk>.md names the milestone; one deeper in a path names nothing.
            (
                json!("re-read plan.md and milestones/M3.md"),
                some("", "M3"),
            ),
            (json!(r"re-read `milestones\M3.md`"), some("", "M3")),
            (json!("see docs/milestones/M1.md"), None),
            (json!("see ./milestones/M1.md"), None),
            (json!("implement the plan"), None),
            (json!("specflow/add-users/plan.md"), None),
            (json!(null), None),
            (
                json!({"prompt": "specflow/add-users/milestones/M2.md"}),
                None,
            ),
        ] {
            assert_eq!(milestone_ref(Some(&prompt)), want, "{prompt}");
        }
        assert_eq!(milestone_ref(None), None);
    }

    #[test]
    fn budget_cap_is_a_whole_number_of_calls() {
        let cap_of = |v: Value| {
            budget_cap(
                &json!({ "max_architect_calls": v }).to_string(),
                "architect",
            )
        };
        // Number() reads each of these as a count, and a fraction is no number
        // of calls: none is what a person set. Nor is null, which reads as no cap.
        for v in [
            json!(true),
            json!(false),
            json!([5]),
            json!([]),
            json!(""),
            json!("  "),
            json!("six"),
            json!({}),
            json!(-1),
            json!(2.5),
            json!("2.5"),
            json!("0x10"),
            json!("1e1"),
            json!("-1"),
            json!(null),
        ] {
            assert_eq!(cap_of(v.clone()), -1, "{v} read as a cap");
        }
        for (v, want) in [
            (json!(0), 0),
            (json!(3), 3),
            (json!("4"), 4),
            (json!(" 5 "), 5),
        ] {
            assert_eq!(cap_of(v.clone()), want, "{v}");
        }
        for text in ["", "{ not json", "{}", "null", "[]", "6"] {
            assert_eq!(budget_cap(text, "planner"), 6, "{text:?}: want the default");
        }
        assert_eq!(budget_cap("", "architect"), 3);
        assert_eq!(budget_cap("\u{FEFF}{\"max_opus_calls\": 2}", "planner"), 2);
        assert_eq!(
            budget_cap("\u{FEFF}{\"max_architect_calls\": \"three\"}", "architect"),
            -1
        );
    }

    #[test]
    fn match_agent_reads_a_whole_word() {
        let roles = ["planner", "architect", "implementer"];
        let names = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            match_agent(&names(&["spec-flow:Planner"]), &roles),
            "planner"
        );
        assert_eq!(match_agent(&names(&["replanner"]), &roles), "");
        assert_eq!(
            match_agent(&names(&["x", "architect"]), &roles),
            "architect"
        );
        assert_eq!(match_agent(&names(&["planner"]), &[] as &[&str]), "");
    }

    #[test]
    fn shipped_reads_the_frontmatter() {
        let dir = std::env::temp_dir().join(format!("spec-flow-agents-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(
            dir.join("a.md"),
            "---\r\nname: Alpha\r\nmodel: opus\r\neffort: high\r\n---\nbody",
        )
        .unwrap();
        std::fs::write(dir.join("b.md"), "---\nmodel: sonnet\n---\n").unwrap();
        std::fs::write(dir.join("c.md"), "---\nname: c\n---\nmodel: opus\n").unwrap();
        std::fs::write(dir.join("d.txt"), "---\nmodel: opus\n---\n").unwrap();
        let got = shipped_in(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        let agent = |m: &str, e: &str| Agent {
            model: m.into(),
            effort: e.into(),
        };
        assert_eq!(
            got.into_iter().collect::<Vec<_>>(),
            [
                ("alpha".to_string(), agent("opus", "high")),
                ("b".to_string(), agent("sonnet", ""))
            ]
        );
    }
}

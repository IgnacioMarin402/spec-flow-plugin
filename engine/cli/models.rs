//! `spec-flow models`: what each agent will actually run on, and which layer
//! decided it. Its failure mode is not crashing; it is five tidy rows saying
//! "plugin default" over a config it never found.

use serde_json::{Map, Value};

use crate::agents;
use crate::repo::canrun;
use crate::state;
use crate::tracelines::pad_end;

/// A value and the layer it came from.
#[derive(Clone)]
struct Found {
    value: String,
    source: String,
}

fn env_str<'a>(settings: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    settings
        .get("env")?
        .as_object()?
        .get(key)?
        .as_str()
        .filter(|v| !v.is_empty())
}

pub fn models(_: &[String]) -> i32 {
    // The working directory, as the command is run from the repository.
    let root = std::env::current_dir().unwrap_or_default();
    // Lowest precedence first.
    let layers: Vec<(&str, Map<String, Value>)> =
        [".claude/settings.json", ".claude/settings.local.json"]
            .iter()
            .filter_map(|label| {
                let text = state::read_text(&root.join(label))?;
                match serde_json::from_str::<Value>(&text) {
                    Ok(Value::Object(m)) => Some((*label, m)),
                    _ => None,
                }
            })
            .collect();
    let mut pins: std::collections::HashMap<&str, Found> = std::collections::HashMap::new();
    for (label, s) in &layers {
        for tier in agents::ALIASES {
            if let Some(v) = env_str(
                s,
                &format!("ANTHROPIC_DEFAULT_{}_MODEL", tier.to_uppercase()),
            ) {
                pins.insert(
                    tier,
                    Found {
                        value: v.into(),
                        source: (*label).into(),
                    },
                );
            }
        }
    }
    for tier in agents::ALIASES {
        if let Ok(v) = std::env::var(format!("ANTHROPIC_DEFAULT_{}_MODEL", tier.to_uppercase()))
            && !v.is_empty()
        {
            pins.insert(
                tier,
                Found {
                    value: v,
                    source: "the environment".into(),
                },
            );
        }
    }
    let session = layers.iter().rev().find_map(|(label, s)| {
        let v = s.get("effortLevel")?.as_str().filter(|v| !v.is_empty())?;
        Some(Found {
            value: v.into(),
            source: (*label).into(),
        })
    });
    let mut env_level = layers.iter().rev().find_map(|(label, s)| {
        Some(Found {
            value: env_str(s, "CLAUDE_CODE_EFFORT_LEVEL")?.into(),
            source: (*label).into(),
        })
    });
    if let Ok(v) = std::env::var("CLAUDE_CODE_EFFORT_LEVEL")
        && !v.is_empty()
    {
        env_level = Some(Found {
            value: v,
            source: "the environment".into(),
        });
    }
    let valid = env_level
        .as_ref()
        .is_some_and(|e| agents::EFFORT_LEVELS.contains(&e.value.to_lowercase().as_str()));

    let meta = agents::shipped();
    let shipped = agents::shipped_routing();
    let (routing, _) = agents::project_routing(&root, &shipped);
    let problems = canrun::settings_problems(&root);
    if !problems.is_empty() {
        eprint!("spec-flow models: .claude/spec-flow.config.json cannot be applied.\n\n");
        for p in &problems {
            eprintln!("  - {p}");
        }
        eprint!(
            "\nNo run starts until it is fixed, and a route that cannot be applied denies every spawn of a spec-flow agent.\n"
        );
        return 1;
    }
    let declared: Vec<String> = state::read_text(&agents::project_config_path(&root))
        .map(|text| {
            let (settings, _) = agents::project_config(&text);
            settings
                .get("agents")
                .and_then(Value::as_object)
                .map(|m| m.keys().map(|k| k.to_lowercase()).collect())
                .unwrap_or_default()
        })
        .unwrap_or_default();
    let names = agents::roles();
    if names.is_empty() {
        eprintln!(
            "spec-flow models: no agents found. This engine is not installed where it thinks it is."
        );
        return 1;
    }
    let rows: Vec<[String; 5]> = names
        .iter()
        .map(|a| {
            let fallback = shipped.get(a).cloned().unwrap_or_default();
            let tier = routing.get(a).cloned().unwrap_or_else(|| fallback.clone());
            let decided = if !declared.contains(a) {
                "plugin default".to_string()
            } else if tier == fallback {
                "project (restates the default)".into()
            } else {
                format!("project (was {fallback})")
            };
            let resolves = pins.get(tier.as_str()).map_or_else(
                || "unpinned".to_string(),
                |p| format!("{} ({})", p.value, p.source),
            );
            let agent_effort = meta.get(a).map(|m| m.effort.as_str()).unwrap_or_default();
            let effort = match (&env_level, &session) {
                (Some(e), _) if valid => {
                    format!("{} (CLAUDE_CODE_EFFORT_LEVEL, {})", e.value, e.source)
                }
                _ if !agent_effort.is_empty() => format!("{agent_effort} (agent)"),
                (_, Some(s)) => format!("{} (session)", s.value),
                _ => "your session".into(),
            };
            [a.clone(), tier, effort, decided, resolves]
        })
        .collect();
    let headings = [
        "AGENT",
        "TIER",
        "EFFORT",
        "TIER DECIDED BY",
        "TIER PINNED TO",
    ]
    .map(String::from);
    let widths: Vec<usize> = (0..5)
        .map(|i| {
            std::iter::once(&headings)
                .chain(&rows)
                .map(|r| r[i].chars().count())
                .max()
                .unwrap_or(0)
        })
        .collect();
    let line = |cs: &[String; 5]| {
        let parts: Vec<String> = cs
            .iter()
            .zip(&widths)
            .map(|(c, w)| pad_end(c, *w))
            .collect();
        format!("  {}", parts.join("  ")).trim_end().to_string()
    };
    println!(
        "spec-flow models — how each agent will be routed in {}\n",
        root.display()
    );
    println!("{}", line(&headings));
    for r in &rows {
        println!("{}", line(r));
    }
    let overridden = rows
        .iter()
        .filter(|r| r[3].starts_with("project (was"))
        .count();
    println!();
    if overridden == 0 {
        println!(
            "  Nothing is re-routed. To change one, add an \"agents\" block to\n  .claude/spec-flow.config.json — for example {{ \"agents\": {{ \"architect\": \"sonnet\" }} }}.\n  The value is a tier ({}), never a model id.",
            agents::ALIASES.join(", ")
        );
    } else {
        println!(
            "  {overridden} agent(s) re-routed by this project. A hook applies it at spawn time;"
        );
        println!("  the orchestrator is not asked to, and cannot forget to.");
    }
    print!(
        "\n  \"unpinned\" means Claude Code resolves that tier to whatever is current, which is\n  \
         the whole point of naming a tier. To pin one, that is Claude Code's own setting\n  \
         rather than this engine's: an ANTHROPIC_DEFAULT_<TIER>_MODEL entry in\n  \
         .claude/settings.json's \"env\" block. A tier is per agent; a pin is per session.\n\n  \
         EFFORT marked (agent) is declared in that agent's own frontmatter and this project\n  \
         cannot change it: a project override routes a tier, not an effort. The rest follow\n  \
         the session, which \"effortLevel\" in .claude/settings.json sets for all of them at once.\n"
    );
    match &env_level {
        Some(e) if !valid => println!(
            "\n  CLAUDE_CODE_EFFORT_LEVEL={} ({}) is not an effort level ({}),\n  so this report does not read it as overriding the column above.",
            e.value,
            e.source,
            agents::EFFORT_LEVELS.join(", ")
        ),
        Some(e) => println!(
            "\n  CLAUDE_CODE_EFFORT_LEVEL is set ({}), so every agent runs at {}:\n  it overrides each agent's own effort and the session's. Unset it to let them apply.",
            e.source, e.value
        ),
        None => {}
    }
    0
}

//! `lint-on-write` — PostToolUse on Write|Edit — lints the file just written,
//! while it is still in the agent's context: cheaper than a gate cycle.
//! WITHOUT --fix: a rewrite behind the agent's back fails its next edit as
//! "modified externally". Only during `implement`.

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::hooks::{Exit, Input};
use crate::payload::js_string;
use crate::repo::{contract, gitscope, proc};
use crate::shell::argv;
use crate::state;

const LINT_MAX_LINES: usize = 30;

#[derive(Deserialize)]
struct Write {
    #[serde(default)]
    tool_input: Option<Map<String, Value>>,
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // The repository's own linter is spawned, so a committed phase is content
    // (ADR-017).
    if state::read_phase(&root) != "implement" {
        return Exit::Pass;
    }
    // A write this cannot read names no file to lint: the gate lints it.
    let Ok(call) = input.read::<Write>() else {
        return Exit::Pass;
    };
    let spawn = call.tool_input.unwrap_or_default();
    let file = js_string(
        ["file_path", "filePath"]
            .iter()
            .find_map(|k| spawn.get(*k).filter(|v| !v.is_null())),
    );
    // A bad contract degrades to "nothing in scope", never to a deny.
    let Ok(cfg) = contract::load(&root) else {
        return Exit::Pass;
    };
    let v = &cfg.verify;
    // The gate's own reading of the scope: a git pathspec, from the root.
    if !gitscope::in_scope(&root, &file, &v.scope_globs) {
        return Exit::Pass;
    }
    if !root.join(&file).exists() || v.lint_no_fix.is_empty() {
        return Exit::Pass;
    }
    // Only a path-shaped binary can be checked against a location; this
    // guard exists only to skip a repository mid-install.
    let (checkable, present) = argv::resolvable_on_disk(argv::binary_of(&v.lint_no_fix), &root);
    if checkable && !present {
        return Exit::Pass;
    }
    let mut lint: Vec<&str> = v.lint_no_fix.iter().map(String::as_str).collect();
    lint.push(&file);
    let res = proc::run(&root, &lint);
    if res.unstarted {
        // Not "lint passed": logged once per binary, so a linter that cannot
        // be spawned does not disarm this hook in silence.
        state::append_unique(
            &state::state_dir(&root).join("lint-on-write-unmatched.log"),
            &format!("{}: {}", v.lint_no_fix.join(" "), res.stderr),
        );
        return Exit::Pass;
    }
    if res.status == Some(0) {
        return Exit::Pass;
    }
    let out = format!("{}{}", res.stdout, res.stderr);
    let lines: Vec<&str> = out.split('\n').collect();
    let mut short = lines[..lines.len().min(LINT_MAX_LINES)].join("\n");
    if lines.len() > LINT_MAX_LINES {
        short += &format!("\n... ({} lines total, truncated)", lines.len());
    }
    Exit::Fail(format!(
        "[spec-flow] {} flagged the file you just wrote — fix it now, while it is \
         still in front of you. Fixing it here costs one edit; letting it reach the gate \
         costs a full retry cycle.\n\n{short}\n\n\
         If the violation comes from a project rule in {}, read its \
         message: it names what the rule protects and why it exists.\n",
        v.lint_name, v.lint_config_hint
    ))
}

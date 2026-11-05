//! `no-gate-cmds` — PreToolUse on Bash — keeps WHOLE-REPO lint and test runs
//! out of a run: the full output is mostly about files the milestone never
//! touched, and it lands in the agent's context. The scoped forms stay
//! allowed, and only during `implement`. A consistency guard, not a security
//! boundary: a script or an alias evades it, and the gate re-runs the real
//! checks on Stop.

use std::sync::LazyLock;

use regex::Regex;

use crate::hooks::{Exit, Input};
use crate::payload::{Bash, ToolCall};
use crate::repo::contract::{self, UnscopedDenied};
use crate::repo::engine;
use crate::shell::{self, argv};
use crate::state;

static PATH_CHAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/.]").unwrap());
static COMPOUND_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&&|\|\||;|\|").unwrap());
static ASSIGNMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());
static SH_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.sh$").unwrap());
/// A token that sends a stream somewhere: `>`, `2>>`, `&>`, `2>&1`, `<`, its
/// target attached or the token after it.
static REDIRECT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[0-9]*|&)(?:>>?|<)(&[0-9]+|&-)?(.*)$").unwrap());

const PACKAGE_TOOLS: [&str; 4] = ["pnpm", "npm", "yarn", "npx"];

fn has(list: &[String], s: &str) -> bool {
    list.iter().any(|v| v == s)
}

/// Path-SHAPED, as the unscoped checks read argv[1]: a subcommand (`run`), a
/// flag's value (`--max-warnings 0`) or where the output goes (`> out.log`)
/// is not a scope.
fn names_a_path(tokens: &[&str]) -> bool {
    let mut args = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        if let Some(m) = REDIRECT.captures(tokens[i]) {
            let attached = |g: usize| m.get(g).is_some_and(|g| !g.as_str().is_empty());
            if !attached(1) && !attached(2) {
                i += 1; // the target is the next token
            }
            i += 1;
            continue;
        }
        args.push(tokens[i]);
        i += 1;
    }
    args.iter()
        .any(|a| !a.starts_with('-') && *a != "." && *a != "./" && PATH_CHAR.is_match(a))
}

/// The whole-repo run `cmd` makes, if it makes one.
fn classify(cmd: &str, d: &UnscopedDenied) -> Option<String> {
    if cmd.is_empty() {
        return None;
    }
    // Quoted text and heredoc bodies are data: a commit message saying
    // `; ftest covers it` runs nothing. A quoted path still scopes, and text
    // handed to a shell (`sh -c 'npm test'`) is read as the command it is.
    let command = shell::words(cmd);
    // A compound command is denied if ANY of its parts is.
    for part in COMPOUND_SEP.split(&command) {
        let mut t: Vec<&str> = part.split_whitespace().collect();
        // `NODE_ENV=test vitest run` runs vitest, as the other readers of a
        // command already take it.
        let assigned = t.iter().take_while(|w| ASSIGNMENT.is_match(w)).count();
        t.drain(..assigned);
        if t.is_empty() {
            continue;
        }
        // The scoped escape hatch, on whole tokens: a substring would swallow
        // `--checkCoverage` on a runner whose name contains "check".
        if t.iter().any(|tok| {
            has(
                &d.scoped_allowed,
                &SH_SUFFIX.replace(&argv::basename(tok), ""),
            )
        }) {
            continue;
        }
        let at = |k: usize| t.get(k).copied().unwrap_or("");
        let mut i = 0;
        if PACKAGE_TOOLS.contains(&t[0]) {
            i += 1;
            if matches!(at(i), "run" | "exec") {
                i += 1;
            }
            if at(i).is_empty() || has(&d.scoped_allowed, at(i)) {
                continue;
            }
            if has(&d.scripts, at(i)) {
                // `npm test -- <path>` hands the path to the script: scoped,
                // as the tool run on a path is.
                if names_a_path(&t[i + 1..]) {
                    continue;
                }
                return Some(at(i).to_string());
            }
            if !has(&d.tools, &argv::basename(at(i))) {
                continue;
            }
        } else if t[0] == "node" {
            // `node node_modules/<tool>/bin/<tool>.js` is how the gate itself
            // runs a tool, so it is scoped like the bare name.
            let (j, name) = argv::tool_at(&t, 0);
            i = j;
            if at(i).is_empty() || !has(&d.tools, &name) {
                continue;
            }
        } else if !has(&d.tools, &argv::basename(t[0])) {
            continue;
        }
        // A runtime that is also the runner runs tests only through `test`.
        if argv::is_runtime(&argv::basename(at(i))) && at(i + 1) != "test" {
            continue;
        }
        if !names_a_path(&t[i + 1..]) {
            return Some(at(i).to_string());
        }
    }
    None
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // `read_phase`: a deny over a phase the repository committed is one
    // nobody in the session can explain (ADR-017).
    if state::read_phase(&root) != "implement" {
        return Exit::Pass;
    }
    // A call this guard cannot read is one it lets through: the gate re-runs
    // the real checks on Stop.
    let Ok(call) = input.read::<ToolCall<Bash>>() else {
        return Exit::Pass;
    };
    let cmd = call.tool_input.command;
    if cmd.is_empty() {
        return Exit::Pass;
    }
    // A bad contract must not block every Bash call; the gate reports it.
    let Ok(cfg) = contract::load(&root) else {
        return Exit::Pass;
    };
    let u = &cfg.unscoped_denied;
    let Some(name) = classify(&cmd, u) else {
        return Exit::Pass;
    };
    let rest: Vec<String> = u
        .scoped_examples
        .iter()
        .filter(|e| **e != u.scoped_alternative)
        .map(|e| format!("`{e}`"))
        .collect();
    let hint = if rest.is_empty() {
        String::new()
    } else {
        format!(" ({})", rest.join(", "))
    };
    // The repository's declaration first, then the one that cannot be wrong:
    // THIS engine's copy, which needs nothing installed. No disarm recipe, on
    // purpose: an agent reads this far more often than a human, and `idle`
    // stands every guard down at once.
    Exit::Fail(format!(
        "[spec-flow] Denied: `{name}` runs over the WHOLE repo, and the flow is \
         mid-run. Not because checking your work is wrong — because the full output is \
         mostly about files this milestone never touched, and it lands in your context.\n\n\
         Run the scoped check instead — same commands, only the files this branch changed:\n\n    \
         {alternative}\n\n\
         The same check with nothing installed, which is the copy the gate itself runs:\n\n    \
         {engine}\n\n\
         Scoped invocations are allowed too{hint}, and so is the tool run on a file path. \
         If you are the implementer, your test-first red run names the test file's path; \
         for anything else, end your turn and the gate reports back.\n\n\
         A human who needs the whole repo can stand the flow down — see Phases in the plugin's REFERENCE.\n",
        alternative = u.scoped_alternative,
        engine = engine::command("check"),
    ))
}

//! `orchestrator-scope` — PreToolUse on Read, the writes and Bash — keeps the
//! orchestrator routing during a run (ADR-034): in the repository it may read
//! `specflow/`, `specs/`, `.spec-flow/`, `.claude/` and the root's `*.md`, and
//! write only `.claude/state/` and `specflow/`, the hooks' own logs excepted.
//! A subagent's call carries its `agent_id`, the session's none — the whole
//! test — so it arms only once the trace shows this build attributes calls.

use std::path::{Component, Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::hooks::{Exit, Input, deny};
use crate::jsre::Re;
use crate::payload::js_string;
use crate::shell::{self, Kind};
use crate::state;

/// A call as this hook reads it. One it cannot read is read as empty: it
/// names nothing written, and the unattributed trace is still noted.
#[derive(Deserialize, Default)]
struct Call {
    #[serde(default)]
    agent_id: Option<Value>,
    #[serde(default)]
    tool_name: Option<Value>,
    #[serde(default)]
    tool_input: Option<Map<String, Value>>,
}

const WRITABLE: [&str; 2] = [".claude/state/", "specflow/"];
const READABLE: [&str; 5] = [
    ".claude/state/",
    "specflow/",
    "specs/",
    ".spec-flow/",
    ".claude/",
];

static HOOKS_ONLY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\.claude/state/[^/]+\.log$").unwrap());
/// A trace line made by a subagent's call: this build attributes calls.
pub static ATTRIBUTED_TRACE: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        r" (?:read|write) file=.* agent_id=[\w-]+$| test verdict=.* agent_id=[\w-]+$",
        "m",
    )
});
static REDIRECT_TARGET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[^0-9&>])>>?[\t\n\x0C\r ]*([^\t\n\x0C\r &|;<>]+)").unwrap());
static SED_IN_PLACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^-[a-zA-Z]*i").unwrap());
static COMPOUND_SEP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"&&|\|\||;|\|").unwrap());
static ASSIGNMENT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z_][A-Za-z0-9_]*=").unwrap());

/// `p` with `.` and `..` resolved as text, as Go's `filepath.Clean` does.
pub fn clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir
                if matches!(out.components().next_back(), Some(Component::Normal(_))) =>
            {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// `path` relative to the repository with `/`, or `None` when outside it.
fn in_repo(root: &Path, path: &str) -> Option<String> {
    let root = clean(root);
    let abs = clean(&root.join(path));
    let rel = abs.strip_prefix(&root).ok()?;
    if rel.as_os_str().is_empty() {
        return None;
    }
    Some(rel.to_string_lossy().replace('\\', "/"))
}

fn under(rel: &str, prefixes: &[&str]) -> bool {
    prefixes
        .iter()
        .any(|p| rel == p.trim_end_matches('/') || rel.starts_with(p))
}

fn readable_rel(rel: &str) -> bool {
    under(rel, &READABLE) || (!rel.contains('/') && rel.ends_with(".md"))
}

/// The paths a command writes, moves or deletes, as far as its plain forms
/// say.
fn bash_writes(cmd: &str) -> Vec<String> {
    let command = match shell::kinds(cmd) {
        None => cmd.to_string(),
        Some(kinds) => {
            let mut b = String::with_capacity(cmd.len());
            for (k, c) in cmd.char_indices() {
                match kinds[k] {
                    Kind::Quoting | Kind::Data => {}
                    Kind::Code => b.push(c),
                    _ => b.push(shell::mask_char(c)),
                }
            }
            b
        }
    };
    let mut paths: Vec<String> = REDIRECT_TARGET
        .captures_iter(&command)
        .map(|m| m[1].to_string())
        .collect();
    for part in COMPOUND_SEP.split(&command) {
        let mut t: Vec<&str> = part.split_whitespace().collect();
        let assigned = t.iter().take_while(|w| ASSIGNMENT.is_match(w)).count();
        t.drain(..assigned);
        if t.len() > 1 && t[0] == "git" && (t[1] == "mv" || t[1] == "rm") {
            t.remove(0);
        }
        let Some(&program) = t.first() else { continue };
        let args: Vec<&str> = t[1..]
            .iter()
            .copied()
            .filter(|a| !a.starts_with('-'))
            .collect();
        match program {
            "mv" | "rm" | "rmdir" | "unlink" | "tee" => {
                paths.extend(args.iter().map(|a| a.to_string()))
            }
            "cp" => paths.extend(args.last().map(|a| a.to_string())),
            "sed" if t.iter().any(|a| SED_IN_PLACE.is_match(a)) && args.len() > 1 => {
                paths.extend(args.last().map(|a| a.to_string()));
            }
            _ => {}
        }
    }
    paths
        .iter()
        .map(|p| shell::unmask(p))
        .filter(|p| !p.is_empty() && !p.starts_with('&') && p != "/dev/null")
        .collect()
}

fn uniq(list: &[String]) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for v in list {
        if !out.contains(&v.as_str()) {
            out.push(v);
        }
    }
    out
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    let phase = state::read_phase(&root);
    if !state::is_run_phase(&phase) {
        return Exit::Pass;
    }
    let call = input.read::<Call>().unwrap_or_default();
    if matches!(&call.agent_id, Some(Value::String(s)) if !s.is_empty()) {
        return Exit::Pass; // a subagent: its role decides what it touches
    }
    let tool = js_string(call.tool_name.as_ref());
    let dir = state::state_dir(&root);
    let trace = state::read_text(&dir.join("run-trace.log")).unwrap_or_default();
    if !ATTRIBUTED_TRACE.test(&trace) {
        state::append_line(
            &dir.join("orchestrator-scope-unmatched.log"),
            &format!(
                "{} phase={phase} tool={tool} unattributed",
                state::now_iso()
            ),
        );
        return Exit::Pass;
    }
    let spawn = call.tool_input.unwrap_or_default();
    let field = |keys: &[&str]| {
        js_string(
            keys.iter()
                .find_map(|k| spawn.get(*k).filter(|v| !v.is_null())),
        )
    };
    let route = "The agent whose job it is does it — the implementer writes code and tests for a milestone, the spec-writer writes `specs/` and `specflow/` — and a human edits the contract. \
                 If a human asked for this mid-run, it belongs to the milestone's implementer or to after the run; standing the run down is theirs to do, from their own terminal (ADR-034).";
    if tool == "Read" {
        return match in_repo(&root, &field(&["file_path"])) {
            Some(rel) if !readable_rel(&rel) => deny(&format!(
                "the orchestrator reading {rel} during a run. Every file this session reads stays in its context for the rest of the run and is paid again on each message it sends (ADR-033); the agent that needs the code reads it, and its context ends with it. \
                 Ask that agent, or read the gate's log under .claude/state/, which names the files and lines."
            )),
            _ => Exit::Pass,
        };
    }
    let written: Vec<String> = if tool == "Bash" {
        bash_writes(&shell::resolve_cd(&field(&["command"])))
    } else {
        let f = field(&["file_path", "notebook_path", "filePath"]);
        if f.is_empty() { Vec::new() } else { vec![f] }
    };
    let outside: Vec<String> = written
        .iter()
        .filter_map(|w| in_repo(&root, w))
        .filter(|rel| !under(rel, &WRITABLE) || HOOKS_ONLY.is_match(rel))
        .collect();
    if outside.is_empty() {
        return Exit::Pass;
    }
    let named = uniq(&outside).join(", ");
    if outside.iter().all(|rel| HOOKS_ONLY.is_match(rel)) {
        return deny(&format!(
            "the orchestrator writing {named}. The logs under .claude/state/ are what the hooks append and decide on; a line this session wrote would be evidence nothing produced (ADR-036)."
        ));
    }
    deny(&format!(
        "the orchestrator writing, moving or deleting {named} during a run. This session routes: during a run it writes only .claude/state/ and specflow/. {route}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_is_read_from_the_repository() {
        let root = Path::new("/repo");
        assert_eq!(in_repo(root, "lib/a.ts").as_deref(), Some("lib/a.ts"));
        assert_eq!(
            in_repo(root, "/repo/./lib/../specs/x.md").as_deref(),
            Some("specs/x.md")
        );
        assert_eq!(in_repo(root, "../other/x"), None);
        assert_eq!(in_repo(root, "/repo"), None);
        assert_eq!(in_repo(root, "/etc/passwd"), None);
    }

    #[test]
    fn what_a_command_writes() {
        assert_eq!(bash_writes("echo x > lib/a.ts"), ["lib/a.ts"]);
        assert_eq!(
            bash_writes("git mv specflow/a docs/a"),
            ["specflow/a", "docs/a"]
        );
        assert_eq!(bash_writes("sed -i 's/a/b/' lib/a.ts"), ["lib/a.ts"]);
        assert_eq!(bash_writes("echo 'x > lib/a.ts'"), Vec::<String>::new());
        assert_eq!(bash_writes("cmd 2>&1 > /dev/null"), Vec::<String>::new());
    }
}

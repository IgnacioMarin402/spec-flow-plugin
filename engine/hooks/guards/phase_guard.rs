//! `phase-guard` — PreToolUse on Bash|Write|Edit — guards every write to
//! `.claude/state/phase`, the spine: each hook arms by matching it against a
//! CLOSED set, so a value nobody defined disarms them all at once, silently.
//!
//! 1. A value outside the vocabulary is denied.
//! 2. `blocked` is the gate's own hand-off to a human; a tool writing it is
//!    denied.
//! 3. A write that ENDS a run is decided from evidence on disk (ADR-022).
//! 4. A write that STARTS a run is refused where the engine cannot run
//!    (ADR-028, ADR-032, ADR-049): nothing is armed then.
//! 5. Leaving `spec` needs a spec its first gate would accept and that
//!    states its assumptions (ADR-030), and a case 3 a human has answered
//!    (ADR-036).
//!
//! Recognising the value is deliberately narrow, because this hook DENIES: a
//! command that merely mentions the file is allowed. A consistency guard, not
//! a security boundary.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::hooks::{Exit, Input, deny, quietly};
use crate::humanturn;
use crate::jsre::Re;
use crate::payload::js_string;
use crate::repo::{canrun, contract, gitscope, proc, unscoped};
use crate::shell::{self, PHASE_FILE, PHASE_REDIRECT, PhaseWrite};
use crate::spec::time;
use crate::state;

/// The whole vocabulary, the one executable copy of it.
fn phases() -> Vec<&'static str> {
    let mut all = state::RUN_PHASES.to_vec();
    all.extend(["done", "idle"]);
    all
}

/// What a tool may write to START a run; `blocked` is the gate's alone.
const STARTS_A_RUN: [&str; 4] = ["spec", "plan", "review", "implement"];
/// What a run moves to once its spec is signed off or triaged.
const LEAVES_SPEC: [&str; 3] = ["plan", "review", "implement"];

#[derive(Deserialize)]
struct Call {
    #[serde(default)]
    tool_name: Option<Value>,
    #[serde(default)]
    tool_input: Option<Map<String, Value>>,
    #[serde(default)]
    session_id: Option<Value>,
}

fn live_changes(root: &Path) -> Vec<String> {
    time::subdirs(&root.join("specflow"))
        .into_iter()
        .filter(|s| s != "archive")
        .collect()
}

/// Whether a gate passed the current commit, `None` when git cannot say:
/// the same short sha and `result=pass` the gate decides by.
fn gate_passed_head(root: &Path) -> Option<bool> {
    let res = proc::git(root, &["rev-parse", "--short", "HEAD"]);
    if !res.ok() {
        return None;
    }
    let sha = res.stdout.trim();
    let hist = state::read_file_or_default(&state::state_dir(root).join("gate-history.log"), "");
    Some(
        hist.split('\n')
            .any(|l| l.split(' ').nth(1) == Some(sha) && l.contains(" result=pass ")),
    )
}

static PRODUCER_START: LazyLock<Re> = LazyLock::new(|| Re::new("[^;&|\\n(`]*$", ""));
static PRODUCER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[\t\n\x0C\r ])(printf|echo)[\t\n\x0C\r ]+").unwrap());
static ESCAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\\(0[0-7]{0,3}|[1-7][0-7]{0,2}|x[0-9A-Fa-f]{1,2}|.)").unwrap());
static SHELL_ESCAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\(.)").unwrap());
static DQ_ESCAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new("\\\\([\\\\$`\"\n])").unwrap());

/// A token as the shell hands it to the program: quotes removed, and a
/// backslash outside single quotes taking the next character literally.
fn shell_word(tok: &str) -> String {
    let b = tok.as_bytes();
    if b.len() >= 2 && b[0] == b'\'' && b[b.len() - 1] == b'\'' {
        return tok[1..tok.len() - 1].into();
    }
    if b.len() >= 2 && b[0] == b'"' && b[b.len() - 1] == b'"' {
        return DQ_ESCAPED
            .replace_all(&tok[1..tok.len() - 1], "$1")
            .into_owned();
    }
    SHELL_ESCAPED
        .replace_all(tok, "$1")
        .trim_matches(['\'', '"'])
        .to_string()
}

/// printf's (and `echo -e`'s) backslash escapes applied, each to the byte
/// the shell writes for it; `\c` ends the output. A value the reader cannot
/// read as a phase must reach the closed-set check as written.
fn interpret(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut at = 0;
    for m in ESCAPE.find_iter(s) {
        out.extend_from_slice(&s.as_bytes()[at..m.start()]);
        at = m.end();
        let e = &s[m.start() + 1..m.end()];
        let first = e.as_bytes()[0];
        if e == "c" {
            return out;
        } else if first == b'x' && e.len() > 1 {
            out.push(u8::from_str_radix(&e[1..], 16).unwrap_or(0));
        } else if (b'0'..=b'7').contains(&first) {
            out.push((u32::from_str_radix(e, 8).unwrap_or(0) & 0xff) as u8);
        } else {
            match first {
                b'n' => out.push(b'\n'),
                b't' => out.push(b'\t'),
                b'r' => out.push(b'\r'),
                b'v' => out.push(0x0b),
                b'f' => out.push(0x0c),
                b'a' => out.push(0x07),
                b'b' => out.push(0x08),
                b'e' | b'E' => out.push(0x1b),
                b'\\' => out.push(b'\\'),
                _ => out.extend_from_slice(m.as_str().as_bytes()),
            }
        }
    }
    out.extend_from_slice(&s.as_bytes()[at..]);
    out
}

/// JavaScript's trim over bytes that may not all be UTF-8: an invalid byte
/// is no whitespace, so trimming stops at it.
fn trim_bytes(b: &[u8]) -> Vec<u8> {
    let is_space = |c: char| c.is_whitespace() || c == '\u{FEFF}';
    let char_at = |s: &[u8], front: bool| {
        (1..=4.min(s.len())).find_map(|n| {
            let part = if front { &s[..n] } else { &s[s.len() - n..] };
            std::str::from_utf8(part).ok()?.chars().next()
        })
    };
    let (mut from, mut to) = (0, b.len());
    while let Some(c) = char_at(&b[from..to], true).filter(|c| is_space(*c)) {
        from += c.len_utf8();
    }
    while let Some(c) = char_at(&b[from..to], false).filter(|c| is_space(*c)) {
        to -= c.len_utf8();
    }
    b[from..to].to_vec()
}

/// The value a Bash command writes into the phase file, as `read_phase`
/// will read it back — the shell's quoting removed, printf's escapes
/// applied, trimmed — or empty when the command cannot be read as a write of
/// one value. It needs a redirect into the file, a printf or echo producing
/// it, and one argument: anything looser starts guessing, and this hook
/// denies.
fn bash_written_value(c: &PhaseWrite) -> Vec<u8> {
    let Some(redirect) = PHASE_REDIRECT.exec(&c.text) else {
        return Vec::new();
    };
    // The producer is the command the redirect belongs to, from the separator
    // before it: another command's `echo` in the chain is not what is written.
    let start = PRODUCER_START
        .search(&c.text[..redirect.index])
        .unwrap_or(0);
    let Some(m) = PRODUCER.captures(&c.text[start..redirect.index]) else {
        return Vec::new();
    };
    let program = &m[1];
    let mut args = Vec::new();
    let mut escapes = false;
    for a in c.cmd[start + m.get(0).unwrap().end()..redirect.index].split_whitespace() {
        if a.starts_with('-') {
            // `echo -n`, `printf --`
            if program == "echo" && a.contains('e') && !a.contains('E') {
                escapes = true;
            }
            continue;
        }
        let w = shell_word(a);
        if !w.is_empty() {
            args.push(w);
        }
    }
    // `printf '%s' implement`: a format string is not the value. With no
    // format, the value IS the format, and printf reads its escapes.
    let format = args
        .iter()
        .find(|a| a.contains('%'))
        .cloned()
        .unwrap_or_default();
    let values: Vec<&String> = args.iter().filter(|a| !a.contains('%')).collect();
    let [v] = values[..] else {
        return Vec::new();
    };
    let v = if (program == "printf" && (format.is_empty() || format.contains("%b"))) || escapes {
        interpret(v)
    } else {
        v.as_bytes().to_vec()
    };
    trim_bytes(&v)
}

static CHAIN_SEP: LazyLock<Re> = LazyLock::new(|| Re::new(r"&&|\|\||;|\n", ""));
static PIPE_SEP: LazyLock<Re> = LazyLock::new(|| Re::new(r"(?<!>)\|", ""));
static LEADING_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^.*[\\/]").unwrap());

/// `[from, to)` of each piece of `text` between matches of `sep`.
fn pieces(text: &str, sep: &Re, from: usize, to: usize) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut at = from;
    for m in sep.exec_all(&text[from..to]) {
        found.push((at, from + m.index));
        at = from + m.end;
    }
    found.push((at, to));
    found
}

/// Notes, one line per program, a write that got past unread: failing open
/// is right here, failing open silently is not. Only with a redirect or a
/// pipe INTO the file — a read got past nothing — and the program only, never
/// its arguments.
fn record_unreadable_write(root: &Path, c: &PhaseWrite) {
    let redirects = PHASE_REDIRECT.test(&c.text);
    let Some((from, to)) = pieces(&c.text, &CHAIN_SEP, 0, c.text.len())
        .into_iter()
        .find(|(f, t)| PHASE_FILE.test(&c.text[*f..*t]))
    else {
        return;
    };
    let segments = pieces(&c.text, &PIPE_SEP, from, to);
    let at = segments
        .iter()
        .position(|(f, t)| PHASE_FILE.test(&c.text[*f..*t]));
    // `cat <phase> | grep x` is a read that contains a pipe.
    let at = match at {
        Some(i) if redirects || i >= 1 => i,
        _ => return,
    };
    let (f, t) = segments[at];
    let Some(first) = c.cmd[f..t].split_whitespace().next() else {
        return;
    };
    let program = LEADING_PATH.replace(first, "");
    if !program.is_empty() {
        state::append_unique(
            &state::state_dir(root).join("phase-guard-unmatched.log"),
            &program,
        );
    }
}

/// A value as Go's `strconv.QuoteToGraphic` shows it, unquoted: a byte the
/// terminal would swallow is shown, or the refusal reads as one of a phase.
fn graphic(b: &[u8]) -> String {
    let mut out = String::new();
    for chunk in b.utf8_chunks() {
        for c in chunk.valid().chars() {
            match c {
                '\u{7}' => out.push_str(r"\a"),
                '\u{8}' => out.push_str(r"\b"),
                '\u{c}' => out.push_str(r"\f"),
                '\n' => out.push_str(r"\n"),
                '\r' => out.push_str(r"\r"),
                '\t' => out.push_str(r"\t"),
                '\u{b}' => out.push_str(r"\v"),
                '\\' => out.push_str(r"\\"),
                '"' => out.push_str("\\\""),
                c if (c as u32) < 0x20 || c == '\u{7f}' => {
                    out.push_str(&format!(r"\x{:02x}", c as u32))
                }
                c if c.is_control()
                    || matches!(c, '\u{FEFF}' | '\u{200B}'..='\u{200F}' | '\u{2028}'..='\u{202E}' | '\u{2060}'..='\u{206F}') =>
                {
                    if (c as u32) < 0x10000 {
                        out.push_str(&format!(r"\u{:04x}", c as u32));
                    } else {
                        out.push_str(&format!(r"\U{:08x}", c as u32));
                    }
                }
                c => out.push(c),
            }
        }
        for byte in chunk.invalid() {
            out.push_str(&format!(r"\x{byte:02x}"));
        }
    }
    out
}

pub fn run(input: &Input) -> Exit {
    let root = state::project_dir();
    // A call this cannot read writes no phase it could read.
    let Ok(call) = input.read::<Call>() else {
        return Exit::Pass;
    };
    // `read_phase`, never the owner check: this is the hook that ASSIGNS
    // ownership (ADR-017).
    let phase = state::read_phase(&root);
    let in_run = state::is_run_phase(&phase);
    let spawn = call.tool_input.clone().unwrap_or_default();
    let session = js_string(call.session_id.as_ref());
    let field = |a: &str, b: &str| {
        js_string(
            spawn
                .get(a)
                .filter(|v| !v.is_null())
                .or_else(|| spawn.get(b)),
        )
    };

    let written_raw: Vec<u8> = if js_string(call.tool_name.as_ref()) == "Bash" {
        let command = shell::phase_write_text(&js_string(spawn.get("command")));
        let v = bash_written_value(&command);
        // A command writing the phase creates that directory itself, so
        // recording here leaves nothing it did not.
        if v.is_empty() && PHASE_FILE.test(&command.cmd) {
            record_unreadable_write(&root, &command);
        }
        v
    } else if PHASE_FILE.test(&field("file_path", "filePath")) {
        state::trim(&field("content", "new_string"))
            .as_bytes()
            .to_vec()
    } else {
        Vec::new()
    };
    if written_raw.is_empty() {
        return Exit::Pass;
    }
    let written = String::from_utf8_lossy(&written_raw).into_owned();

    // The gate's alone, in a run and out of one.
    if written == "blocked" {
        return deny(
            "'blocked' is written by the gate itself, at its attempt cap — it is how the gate hands a run to a human. \
             Written by anything else it disarms the gate without that having happened. If you need a human, say so \
             and end your turn; the gate still judges what is committed.",
        );
    }

    // ---- a write that STARTS a run is decided from where it starts ---------
    if !in_run {
        if !STARTS_A_RUN.contains(&written.as_str()) {
            return Exit::Pass; // arms nothing
        }
        if let Err(e) = canrun::check_start(&root) {
            let tail = if matches!(e.kind, "foreign-change" | "settings") {
                "."
            } else {
                " — `spec-flow init`, run from the repository root, writes the contract."
            };
            return deny(&format!(
                "starting a run by writing '{written}' into .claude/state/phase, and this engine cannot run in this repository: {}\n\n\
                 Nothing has started and nothing is armed. Fix that first, then start the run again{tail}",
                e.msg
            ));
        }
        state::claim_phase(&root, &session);
        return Exit::Pass;
    }

    let vocabulary = phases();
    if !vocabulary.contains(&written.as_str()) {
        return Exit::Fail(format!(
            "[spec-flow] Denied: '{shown}' is not a phase this engine knows.\n\n\
             The phase vocabulary is a CLOSED SET: {}. Every enforcement hook \
             decides whether it is armed by matching this file against those values, and each one \
             falls through to \"not my business\" on anything else — so writing '{written}' would run \
             the flow with the gate, the write-time linter, the whole-repo command deny, preflight \
             and the Opus budget ALL disarmed at once, with nothing to say so.\n\n\
             Whatever step you are modelling, express it inside the vocabulary: spec work runs under \
             `spec`, anything that writes code runs under `implement`. If you are extending the \
             orchestrator, that constraint is the design, not an obstacle to route around.\n",
            vocabulary.join(", "),
            shown = graphic(&written_raw),
        ));
    }

    // ---- leaving `spec` needs a spec its first gate would accept -----------
    if phase == "spec" && LEAVES_SPEC.contains(&written.as_str()) {
        let found = time::leaving_spec(&root);
        if !found.is_empty() {
            return deny(&format!(
                "writing '{written}' while the spec is not ready to build from:\n  - {}\n\n\
                 Hand these to a new spec-writer with specflow/<SLUG>/ (MODE=TRIAGE for a /spec-fix brief). For a /spec-flow \
                 change, show the human the sign-off again before writing '{written}': what they approved is not what is on disk.",
                found.join("\n  - ")
            ));
        }
        let unconfirmed = humanturn::unconfirmed(&root);
        if !unconfirmed.is_empty() {
            return deny(&humanturn::denial(
                &unconfirmed,
                &format!("writing '{written}'"),
            ));
        }
    }

    // ---- a write that ends the run is decided from evidence ---------------
    // From `blocked` a human is already in the loop: not second-guessed.
    if written == "idle" && phase != "blocked" {
        if phase == "implement" {
            return deny(
                "writing 'idle' while the phase is 'implement'. No step of /spec-flow or /spec-fix ends a run from here: \
                 'idle' disarms the gate with nothing judged, and the next stop passes in silence. If the gate failed, \
                 follow its message — it routes the fix and the re-plan, and at its cap writes 'blocked' itself. If a \
                 human asked to abandon the run, standing it down is theirs to do, from their own terminal.",
            );
        }
        let live = live_changes(&root);
        if !live.is_empty() {
            return deny(&format!(
                "writing 'idle' with a change still live in specflow/: {}. Both flows record a dropped \
                 change before standing down: stamp `**Status:** REJECTED <YYYY-MM-DD> — <reason>` under the heading \
                 of its spec.md, move the folder to specflow/archive/, then write 'idle'.",
                live.join(", ")
            ));
        }
    }

    // Claimed only for a write that goes through: a denied one changes
    // nothing.
    if written != "done" {
        state::claim_phase(&root, &session);
        return Exit::Pass;
    }
    let failures = done_unearned(&root);
    if failures.is_empty() {
        state::claim_phase(&root, &session);
        return Exit::Pass;
    }
    deny(&format!(
        "writing 'done' into .claude/state/phase, and the run is not actually finished. 'done' disarms every \
         hook, so it has to be earned, not declared:\n{}\n\n\
         Route by what failed: a spec-trace gap belongs to the spec-writer session (FOLD); an unarchived \
         specflow/<SLUG>/ of this run means step 5 never ran — invoke spec-writer in MODE=FOLD; one the base branch \
         has is not this run's: tell the human, whose call it is to move or archive it, and do neither yourself; a commit the gate has not \
         passed needs committing and a turn ended so the gate judges it; any other check the project declared goes \
         back to the implementer of the milestone that broke it, with the hint that check carries in \
         .spec-flow/config.json.",
        failures.join("\n")
    ))
}

/// Why `done` is not earned, or nothing.
fn done_unearned(root: &Path) -> Vec<String> {
    let mut failures = Vec::new();
    // Degrades quietly on a bad contract: refusing an unearned `done` is this
    // check's job, policing the contract is the gate's. An engine defect here
    // is no evidence `done` was earned: said, and the checks below still run.
    let checked = quietly(|| {
        let mut failed = Vec::new();
        let mut at_base = Vec::new();
        if let Ok(cfg) = contract::load(root) {
            for c in unscoped::run(root, &cfg)
                .checks
                .into_iter()
                .filter(|c| c.rc != 0)
            {
                failed.push(format!("--- {} ---\n{}", c.check.name, c.out));
            }
            if let Ok(base) = gitscope::resolve_base(root, Some(&cfg)) {
                at_base = gitscope::changes_at_base(root, &base);
            }
        }
        (failed, at_base)
    });
    let at_base = match checked {
        Ok((failed, at_base)) => {
            failures.extend(failed);
            at_base
        }
        Err(e) => {
            failures.push(format!(
                "--- the project's checks ---\nthe engine could not run them ({e}), so nothing says they pass."
            ));
            Vec::new()
        }
    };
    // A change never folded is an unfinished run; one the base has is not
    // this run's to fold (ADR-032).
    let live = live_changes(root);
    if !live.is_empty() {
        let marked: Vec<String> = live
            .iter()
            .map(|slug| {
                if at_base.contains(slug) {
                    format!("{slug} (the base branch has it: not this run's change)")
                } else {
                    slug.clone()
                }
            })
            .collect();
        failures.push(format!(
            "--- unarchived changes in specflow/ ---\n{}",
            marked.join("\n")
        ));
    }
    // Only the gate ran the suite, and spec-trace counts a failed test as
    // executed.
    match gate_passed_head(root) {
        None => failures.push(
            "--- the current commit ---\ngit could not name HEAD, so nothing can say a gate passed it.".into(),
        ),
        Some(false) => failures.push(
            "--- the current commit ---\nthe gate has not passed it: no line in .claude/state/gate-history.log records result=pass for HEAD.".into(),
        ),
        Some(true) => {}
    }
    failures
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(cmd: &str) -> String {
        String::from_utf8_lossy(&bash_written_value(&shell::phase_write_text(cmd))).into_owned()
    }

    #[test]
    fn the_value_a_command_writes() {
        for (cmd, want) in [
            ("printf 'implement' > .claude/state/phase", "implement"),
            ("echo done > .claude/state/phase", "done"),
            ("printf '%s' plan > .claude/state/phase", "plan"),
            (
                "printf 'imple\\x6dent\\n' > .claude/state/phase",
                "implement",
            ),
            ("echo -e 'spec\\cignored' > .claude/state/phase", "spec"),
            ("echo -e 'spec\\c ignored' > .claude/state/phase", ""), // two words, as Go's Fields reads them
            ("cd .claude/state && printf review > phase", "review"),
            ("echo a b > .claude/state/phase", ""),
            ("cat x > .claude/state/phase", ""),
            ("echo spec; cat y > .claude/state/phase", ""),
        ] {
            assert_eq!(written(cmd), want, "{cmd}");
        }
    }

    #[test]
    fn trim_stops_at_a_byte_that_is_no_character() {
        assert_eq!(trim_bytes(b" \xefimplement\n"), b"\xefimplement");
        assert_eq!(trim_bytes("\u{feff} done \t".as_bytes()), b"done");
        assert_eq!(trim_bytes(b"  "), b"");
    }

    #[test]
    fn a_value_is_shown_as_written() {
        assert_eq!(graphic(b"im\x1bple\xff\"x\""), r#"im\x1bple\xff\"x\""#);
        assert_eq!(graphic("ok ñ".as_bytes()), "ok ñ");
    }
}

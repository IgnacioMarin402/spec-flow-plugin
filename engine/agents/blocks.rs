//! The return block an agent hands back, and the ones its contract declares.
//! Every line break is `\r?\n`: git hands a Windows checkout CRLF, and an
//! anchor spelled `\n` finds nothing there — which reads as a moved anchor,
//! not as a line ending.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::jsre::Re;

/// Send-backs per agent before the agent gate lets its return through as it
/// is. The live view shows a send-back against the same number.
pub const MAX_BLOCKS: usize = 2;

/// Questions one NEEDS_INPUT round may ask; the spec-writer's contract states
/// the same number (ADR-030).
pub const MAX_OPEN_QUESTIONS: usize = 3;

static LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\r?\n").unwrap());
static BLOCK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("(?s)```\\r?\\n(STATUS:.*?)```").unwrap());
static KEY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([A-Z][A-Z_]+):").unwrap());

/// The field names declared across every fenced block that opens with
/// `STATUS:`, in declaration order, and how many blocks there were: a caller
/// tells "this agent declares none" from "the anchor stopped matching" by
/// that count.
pub fn return_blocks(text: &str) -> (usize, Vec<String>) {
    let mut fields: Vec<String> = Vec::new();
    let mut blocks = 0;
    for m in BLOCK.captures_iter(text) {
        blocks += 1;
        for line in LINE.split(&m[1]) {
            if let Some(k) = KEY.captures(line)
                && !fields.iter().any(|f| f == &k[1])
            {
                fields.push(k[1].into());
            }
        }
    }
    (blocks, fields)
}

/// The fields no command names, as whole field names: `QUESTIONS` is not
/// named by `OPEN_QUESTIONS`.
pub fn unrouted_fields<S: AsRef<str>>(
    fields: &[S],
    commands_text: &str,
    exempt: &[&str],
) -> Vec<String> {
    fields
        .iter()
        .map(AsRef::as_ref)
        .filter(|f| !exempt.contains(f))
        .filter(|f| {
            !Re::new(&format!("(?<![A-Za-z0-9_]){f}(?![A-Za-z0-9_])"), "").test(commands_text)
        })
        .map(String::from)
        .collect()
}

static STATUS_DECL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("```\\r?\\nSTATUS:[ \\t]*([A-Z_]+)").unwrap());

/// The `STATUS:` lines of a contract's return blocks.
pub fn declared_statuses(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in STATUS_DECL.captures_iter(text) {
        if !out.iter().any(|s| s == &m[1]) {
            out.push(m[1].into());
        }
    }
    out
}

/// The return block in an agent's reply.
#[derive(Debug)]
pub struct Return {
    pub status: String,
    pub fields: HashMap<String, String>,
    /// The fields in the order the reply wrote them.
    pub order: Vec<String>,
}

static STATUS_LINE: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^[ \t>#*]*STATUS:[ \t*]*([A-Z_]+)", "m"));
static FENCE_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new("^[\\t\\n\\x0C\\r ]*```").unwrap());
static KV_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t>*]*([A-Z][A-Z_]+):[ \t*]*(.*)$").unwrap());

/// The first LINE opening with `STATUS:` wins — emphasis, a heading mark or a
/// quote mark allowed; a status named mid-sentence is prose. A repeated key
/// keeps its first value. run-trace and the agent gate both read it here.
pub fn parse_return(text: &str) -> Option<Return> {
    let m = STATUS_LINE.exec(text)?;
    let mut r = Return {
        status: m.group(1).into(),
        fields: HashMap::new(),
        order: Vec::new(),
    };
    for line in LINE.split(&text[m.index..]).skip(1) {
        if FENCE_LINE.is_match(line) {
            break;
        }
        if let Some(kv) = KV_LINE.captures(line.strip_suffix('\r').unwrap_or(line))
            && !r.fields.contains_key(&kv[1])
        {
            r.fields.insert(kv[1].into(), kv[2].trim().into());
            r.order.push(kv[1].into());
        }
    }
    Some(r)
}

static OPEN_Q: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[ \t>*]*OPEN_QUESTIONS:").unwrap());
static NEXT_FIELD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[ \t>*]*[A-Z][A-Z_]+:").unwrap());
static ITEM: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^([\t\n\x0C\r ]*)([-*+]|[0-9]+[.)])[\t\n\x0C\r ]+[^\t\n\x0C\r ]").unwrap()
});

/// The top-level items under `OPEN_QUESTIONS:`. Options nested under a
/// question are part of it. The list ends at a blank line, a flush non-item,
/// a fence or the next field, so questions split by blank lines undercount —
/// letting a round through rather than sending a good one back.
pub fn open_questions(text: &str) -> usize {
    let lines: Vec<&str> = LINE.split(text).collect();
    let Some(at) = lines.iter().position(|l| OPEN_Q.is_match(l)) else {
        return 0;
    };
    let mut items: Vec<(usize, bool)> = Vec::new(); // indent, numbered
    for line in &lines[at + 1..] {
        if FENCE_LINE.is_match(line) || NEXT_FIELD.is_match(line) {
            break;
        }
        if line.trim().is_empty() {
            if !items.is_empty() {
                break;
            }
            continue;
        }
        if let Some(m) = ITEM.captures(line) {
            items.push((m[1].len(), m[2].bytes().any(|b| b.is_ascii_digit())));
        } else if !items.is_empty() && !line.starts_with([' ', '\t', '\n', '\r', '\x0C']) {
            break;
        }
    }
    let Some(top) = items.iter().map(|(i, _)| *i).min() else {
        return 0;
    };
    let level: Vec<bool> = items
        .iter()
        .filter(|(i, _)| *i == top)
        .map(|(_, n)| *n)
        .collect();
    let numbered = level.iter().filter(|n| **n).count();
    if numbered > 0 { numbered } else { level.len() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn return_blocks_read_either_line_end() {
        let block = [
            "```",
            "STATUS: FOLDED",
            "ARCHIVED: specflow/archive/x/",
            "GAPS: none",
            "```",
        ];
        for end in ["\n", "\r\n"] {
            assert_eq!(
                return_blocks(&block.join(end)),
                (1, vec!["STATUS".into(), "ARCHIVED".into(), "GAPS".into()]),
                "{end:?}"
            );
        }
        // The caller tells "declares none" from "the anchor moved" by this count.
        for text in ["# just prose\n", "", "```bash\nSTATUS=1 npm test\n```"] {
            assert_eq!(return_blocks(text), (0, Vec::new()), "{text:?}");
        }
    }

    #[test]
    fn unrouted_fields_read_whole_names() {
        // A field named only inside a longer field name is not routed.
        assert_eq!(
            unrouted_fields(&["QUESTIONS"], "route `OPEN_QUESTIONS:` to the human", &[]),
            ["QUESTIONS"]
        );
        assert_eq!(
            unrouted_fields(&["READ"], "expect `STATUS: SPEC_READY`", &[]),
            ["READ"]
        );
        assert!(
            unrouted_fields(&["GAPS", "STATUS"], "read its `GAPS:` line", &["STATUS"]).is_empty()
        );
    }

    #[test]
    fn declared_statuses_read_either_line_end() {
        let md = "x\n```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n```\ny\r\n```\r\nSTATUS: SPEC_READY\r\nSPEC_PATH: a\r\n```\r\n";
        assert_eq!(declared_statuses(md), ["NEEDS_INPUT", "SPEC_READY"]);
    }

    #[test]
    fn parse_return_reads_the_first_status_line() {
        let r = parse_return("Done.\n\n```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md\nSUMMARY: two lines\n```\nSTATUS: NOT_THIS\n").unwrap();
        assert_eq!(r.status, "SPEC_READY");
        assert_eq!(r.order, ["SPEC_PATH", "SUMMARY"]);
        assert!(parse_return("no block here").is_none());
        // A status that opens a line, emphasis allowed; not one named mid-sentence.
        let round2 = "The previous round ended with STATUS: NEEDS_INPUT; the answers are in.\n\n```\nSTATUS: SPEC_READY\nSPEC_PATH: specflow/x/spec.md\n```";
        assert_eq!(parse_return(round2).unwrap().status, "SPEC_READY");
        let emphasis = parse_return("**STATUS:** APPROVED\n**NOTES:** none").unwrap();
        assert_eq!(
            (emphasis.status.as_str(), emphasis.fields["NOTES"].as_str()),
            ("APPROVED", "none")
        );
        assert_eq!(
            parse_return("STATUS: **APPROVED**").unwrap().status,
            "APPROVED"
        );
        assert!(parse_return("The plan header says STATUS: N/A.").is_none());
    }

    #[test]
    fn open_questions_count_the_top_level() {
        for (text, want) in [
            // the top-level questions, not the options under them
            (
                "```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n- Which store?\n  - (a) Postgres\n  - (b) Redis\n- Soft delete?\n```\nThanks.\n- not a question",
                2,
            ),
            (
                "STATUS: NEEDS_INPUT\r\nOPEN_QUESTIONS:\r\n1. a\r\n2. b\r\n3. c\r\n4. d\r\n",
                4,
            ),
            ("STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n", 0),
            // it stops at the end of the list, and numbered questions win over flush options
            (
                "STATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n- Which store?\n- Soft delete?\n\nWhat I found:\n- the table has no index\n- the API is versioned\n",
                2,
            ),
            (
                "```\nSTATUS: NEEDS_INPUT\nOPEN_QUESTIONS:\n1. Which store?\n- Postgres\n- Redis\n2. Soft delete?\n- yes\n- no\n```",
                2,
            ),
        ] {
            assert_eq!(open_questions(text), want, "{text:?}");
        }
    }

    /// The live view carries its own copy of these readers (a mod runs no
    /// binary's code). hooks/readers.golden.ts holds the answers both give;
    /// this holds the engine's to them, and hooks/live-view.test.tsx the
    /// view's; `spec-flow lines` is held to it through the binary.
    #[test]
    fn the_readers_agree_with_the_live_views() {
        use serde_json::Value;

        use crate::agents;

        let text = include_str!("../../hooks/readers.golden.ts");
        let at = text
            .find("export default ")
            .expect("no `export default` table");
        let g: Value = serde_json::from_str(&text[at + "export default ".len()..]).unwrap();
        assert_eq!(g["maxBlocks"], MAX_BLOCKS);
        assert_eq!(g["keep"], crate::cli::run_state::KEEP);
        let budgets = g["budgets"].as_object().unwrap();
        assert_eq!(budgets.len(), agents::BUDGET_ROLES.len());
        for (role, b) in budgets {
            let got = agents::budget(role).unwrap_or_else(|| panic!("no budget for {role}"));
            assert_eq!(
                (
                    b["key"].as_str(),
                    b["fallback"].as_i64(),
                    b["counter"].as_str()
                ),
                (Some(got.key), Some(got.fallback), Some(got.counter)),
                "{role}"
            );
        }
        for c in g["parseReturn"].as_array().unwrap() {
            let got = parse_return(c["text"].as_str().unwrap());
            match (&c["want"], got) {
                (Value::Null, None) => {}
                (Value::Object(w), Some(r)) => {
                    assert_eq!(w["status"], r.status.as_str(), "{}", c["text"]);
                    let fields: HashMap<String, String> = w["fields"]
                        .as_object()
                        .unwrap()
                        .iter()
                        .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                        .collect();
                    assert_eq!(fields, r.fields, "{}", c["text"]);
                }
                (w, r) => panic!("parse_return({}) = {r:?}, want {w}", c["text"]),
            }
        }
        for c in g["projectConfig"].as_array().unwrap() {
            let (settings, problem) = agents::project_config(c["text"].as_str().unwrap());
            let kind = if problem.contains("does not parse") {
                "parse"
            } else if problem.is_empty() {
                ""
            } else {
                "object"
            };
            assert_eq!(
                kind,
                c["problem"].as_str().unwrap_or_default(),
                "{}",
                c["text"]
            );
            assert_eq!(
                Value::Object(settings),
                c["settings"].clone(),
                "{}",
                c["text"]
            );
        }
        for c in g["budgetCap"].as_array().unwrap() {
            let want = c["want"].as_i64().unwrap_or(-1);
            assert_eq!(
                agents::budget_cap(c["text"].as_str().unwrap(), c["role"].as_str().unwrap()),
                want,
                "{c}"
            );
        }
        for c in g["milestoneRef"].as_array().unwrap() {
            let want = c["want"].as_object().map(|w| {
                (
                    w["change"].as_str().unwrap().to_string(),
                    w["milestone"].as_str().unwrap().to_string(),
                )
            });
            assert_eq!(agents::milestone_ref(Some(&c["prompt"])), want, "{c}");
        }
    }
}

//! The grammar of a change spec: what spec-trace, and every later reader of a
//! spec, agrees a delta, a kind and an id are. One copy: a second would be a
//! second opinion about what a CHANGED is. Pure — callers hand in text.

// Capability specs, ids in test names and the archive's stamp are read by
// the gate (B72).
#![allow(dead_code)]

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;

use crate::jsre::Re;

/// `### REQ-USER-001 — Title`; the separator is optional.
pub static REQ_HEADING: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^###\s+(REQ-[A-Z0-9-]+-\d{3})\b\s*[—:-]?\s*(.*)$", ""));

/// NOT `\b`-delimited: Go and pytest glue the id to their neighbours
/// (`TestAuth/REQ-USER-001_rejects`), and `_` is a word character. Not glued
/// to a preceding letter or digit, and not followed by a fourth digit.
pub static REQ_TAG: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"(?<![A-Z0-9])REQ-[A-Z0-9-]+-\d{3}(?!\d)", ""));

/// The ids a reported line proves, read as reported and with `_` read as `-`:
/// an identifier cannot spell a hyphen (`test_REQ_CORE_001`). Both passes,
/// not the normalized one alone, or `REQ-USER-001_002` reads as the single
/// id `REQ-USER-001-002`.
pub fn ids_in(line: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for text in [line.to_string(), line.replace('_', "-")] {
        for m in REQ_TAG.exec_all(&text) {
            if !ids.iter().any(|i| i == m.text()) {
                ids.push(m.text().into());
            }
        }
    }
    ids
}

/// `specs/user-profile.md` → `REQ-USER-PROFILE-`.
pub fn expected_prefix(spec_file: &str) -> String {
    let base = Path::new(spec_file)
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    format!(
        "REQ-{}-",
        base.strip_suffix(".md").unwrap_or(&base).to_uppercase()
    )
}

static NEWLINE: LazyLock<Re> = LazyLock::new(|| Re::new(r"\r?\n", ""));

/// The ids a capability spec declares, one per heading.
pub fn declared_ids(body: &str) -> HashSet<String> {
    NEWLINE
        .split(body)
        .into_iter()
        .filter_map(|l| REQ_HEADING.exec(l.trim()).map(|m| m.group(1).to_string()))
        .collect()
}

/// A capability spec and the ids it declares.
pub struct Spec {
    pub file: String,
    pub ids: HashSet<String>,
}

static ID_NUMBER: LazyLock<Re> = LazyLock::new(|| Re::new(r"-\d{3}$", ""));

/// The capability spec a delta on `id` touches: the file declaring it, else
/// the one its capability names, else `""`.
pub fn capability_of(id: &str, specs: &[Spec]) -> String {
    if let Some(s) = specs.iter().find(|s| s.ids.contains(id)) {
        return s.file.clone();
    }
    let prefix = ID_NUMBER.replace_all(id, |_| String::new()) + "-";
    specs
        .iter()
        .find(|s| expected_prefix(&s.file) == prefix)
        .map_or_else(String::new, |s| s.file.clone())
}

/// `**Status:** SHIPPED 2026-07-30`, on an archived change spec.
pub static ARCHIVE_STATUS: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^\*\*Status:\*\*\s+(SHIPPED|REJECTED|SUPERSEDED)\b", "m"));

static SHIPPED_STATUS: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^\*\*Status:\*\*\s+SHIPPED\b", "m"));

/// Stamped SHIPPED, so its deltas claim to be in `specs/`.
pub fn is_shipped(body: &str) -> bool {
    SHIPPED_STATUS.test(body)
}

// ---- a delta: one grammar ---------------------------------------------------
//
// A delta is one line of `## Requirement deltas`: a dash, the verb, the id,
// then its text. Every reader takes it from `section_lines`. Every other line
// of the section names only ids a delta line reads, so a delta spelled
// another way is refused by the id it names, not by a guess at its verb
// (ADR-048).

const VERB: &str = "ADDED|CHANGED|REMOVED";
const ID: &str = r"REQ-[A-Z0-9-]+-\d{3}(?!\d)";

/// The verb and the id share the line.
static DELTA_LINE: LazyLock<Re> =
    LazyLock::new(|| Re::new(&format!(r"^[-*][ \t]*({VERB})[ \t]+({ID})(.*)$"), ""));
static AN_ID: LazyLock<Re> = LazyLock::new(|| Re::new(ID, ""));

/// The two edits a CHANGED may be; everything else decomposes.
pub const CHANGED_KINDS: [&str; 2] = ["wording", "correction"];

static LINE_ENDS: LazyLock<Re> = LazyLock::new(|| Re::new(r"\r\n|\r|\n", ""));
static COMMENT_OPEN: LazyLock<Re> = LazyLock::new(|| Re::new(r"^[ \t]*<!--", ""));
static FENCE_OPEN: LazyLock<Re> = LazyLock::new(|| Re::new(r"^([ \t]*)(`{3,}|~{3,})", ""));
static LEADING_WS: LazyLock<Re> = LazyLock::new(|| Re::new(r"^[ \t]*", ""));
static INDENTED: LazyLock<Re> = LazyLock::new(|| Re::new(r"^(?: {4}|\t)", ""));
static LIST_ITEM: LazyLock<Re> = LazyLock::new(|| Re::new(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]", ""));

/// The last line a block opened at line `i` covers, if it closes.
fn block_end(lines: &[String], i: usize) -> Option<usize> {
    if COMMENT_OPEN.test(&lines[i]) {
        let from = lines[i].find("<!--").unwrap_or(0) + 4;
        return (i..lines.len()).find(|&j| {
            let start = if j == i { from } else { 0 };
            start <= lines[j].len() && lines[j][start..].contains("-->")
        });
    }
    let open = FENCE_OPEN.exec(&lines[i])?;
    let mark = open.group(2);
    let fence = Re::new(
        &format!(r"^[ \t]*{}{{{},}}[ \t]*$", &mark[..1], mark.len()),
        "",
    );
    let indent = open.group(1).len();
    for (j, line) in lines.iter().enumerate().skip(i + 1) {
        if fence.test(line) {
            return Some(j);
        }
        let ws = LEADING_WS.exec(line).map_or(0, |m| m.text().len());
        if !line.trim().is_empty() && ws < indent {
            return Some(j - 1); // a line less indented than the fence ends its list item
        }
    }
    None
}

/// `text` with line ends made `\n`, and code and comments blanked: an example
/// declares nothing. A comment starts a line, as an HTML block does. A fence
/// closes on its own character, at least as long, or where the list item it
/// opened in ends; one never closed is read as text. An indented block is
/// code after a blank line that does not continue a list item.
pub fn without_code(text: &str) -> String {
    let mut lines: Vec<String> = LINE_ENDS
        .split(text)
        .into_iter()
        .map(String::from)
        .collect();
    let mut i = 0;
    while i < lines.len() {
        if let Some(end) = block_end(&lines, i) {
            for line in &mut lines[i..=end] {
                line.clear();
            }
            i = end;
        }
        i += 1;
    }
    let (mut code, mut listed) = (false, false);
    for i in 0..lines.len() {
        if lines[i].trim().is_empty() {
            continue;
        }
        let indented = INDENTED.test(&lines[i]);
        code = indented && (code || (i > 0 && lines[i - 1].trim().is_empty() && !listed));
        if code {
            lines[i].clear();
        } else {
            listed = LIST_ITEM.test(&lines[i]) || (listed && indented);
        }
    }
    lines.join("\n")
}

static DELTAS_HEADING: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^## Requirement deltas\b.*$", "m"));
static NEXT_H2: LazyLock<Re> = LazyLock::new(|| Re::new(r"^## ", "m"));

/// The section after `heading` in `text`, up to the next `## `, and the
/// heading's span.
fn section_after<'t>(text: &'t str, heading: &Re) -> Option<(usize, usize, &'t str)> {
    let h = heading.exec(text)?;
    let after = &text[h.end..];
    let section = NEXT_H2.search(after).map_or(after, |n| &after[..n]);
    Some((h.index, h.end, section))
}

/// The body of `## Requirement deltas`, code and comments blanked, or `""`.
/// Prose elsewhere may DISCUSS a requirement without declaring one.
pub fn deltas_section(body: &str) -> String {
    let text = without_code(body);
    section_after(&text, &DELTAS_HEADING).map_or_else(String::new, |(_, _, s)| s.to_string())
}

struct SectionLine {
    line: String,
    verb: String,
    id: String,
    rest: String,
}

fn section_lines(body: &str) -> Vec<SectionLine> {
    deltas_section(body)
        .split('\n')
        .map(|line| match DELTA_LINE.exec(line) {
            Some(m) => SectionLine {
                line: line.into(),
                verb: m.group(1).into(),
                id: m.group(2).into(),
                rest: m.group(3).into(),
            },
            None => SectionLine {
                line: line.into(),
                verb: String::new(),
                id: String::new(),
                rest: String::new(),
            },
        })
        .collect()
}

/// A CHANGED delta and the kind it claims, `""` when it names none.
pub struct Changed {
    pub line: String,
    pub id: String,
    pub kind: String,
}

static KIND_MARK: LazyLock<Re> = LazyLock::new(|| Re::new(r"^[ \t]*\(([a-z]+)\)", ""));

/// Every CHANGED delta a spec declares.
pub fn changed_deltas(body: &str) -> Vec<Changed> {
    section_lines(body)
        .into_iter()
        .filter(|d| d.verb == "CHANGED")
        .map(|d| Changed {
            kind: KIND_MARK
                .exec(&d.rest)
                .map_or_else(String::new, |m| m.group(1).into()),
            line: d.line,
            id: d.id,
        })
        .collect()
}

/// Why one CHANGED line was rejected.
pub fn explain_kind(kind: &str) -> String {
    match kind {
        "" => "does not say which kind of change it is".into(),
        "correction" => "is marked (correction), which only a `/spec-fix` brief may use".into(),
        _ => format!(
            "is marked ({kind}), which is not one of the two kinds a CHANGED may be ({})",
            CHANGED_KINDS.join(", ")
        ),
    }
}

/// The proposal's sections, which a live spec.md must not carry.
pub const HEAVY_HEADINGS: [&str; 3] = ["## Source", "## Context", "## Decision"];

/// One delta line's verb and id.
#[derive(Debug, PartialEq)]
pub struct Delta {
    pub verb: String,
    pub id: String,
}

/// Every delta a spec declares, from its deltas section only.
pub fn deltas(body: &str) -> Vec<Delta> {
    section_lines(body)
        .into_iter()
        .filter(|d| !d.verb.is_empty())
        .map(|d| Delta {
            verb: d.verb,
            id: d.id,
        })
        .collect()
}

/// How a writer says the section has no delta.
static NONE: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        r"^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)])[ \t]+)?[*_`]*[ \t]*(?:none|n\/a|nothing|unchanged|not[ \t]+applicable|no[ \t]+(?:(?:new|spec)[ \t]+)?(?:requirements?|spec|changes?|deltas?)(?:[ \t]+(?:changes?|deltas?))?)(?![\w-])",
        "i",
    )
});
/// A line a delta's verb leads, in capitals, is written as one; a heading
/// grouping deltas is not.
static VERB_LED: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &format!(
            r"^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)]|[a-z][.)]|\|)[ \t]*)?(?:\[[ xX]\][ \t]*)?[[(*_`]*(?:{VERB})(?![\w-])"
        ),
        "",
    )
});
/// Shaped like an id and maybe not one: `REQ-USER-10`, `req-user-002`.
static ID_SHAPED: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        r"(?<![\w-])req[-_][a-z][a-z0-9]*(?:[-_][a-z0-9]+)*[-_]\d+(?![\w-])",
        "i",
    )
});
static WHOLE_ID: LazyLock<Re> = LazyLock::new(|| Re::new(&format!("^{ID}$"), ""));
/// In a delta's text, a verb in capitals before an id starts another delta.
static VERBED: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &format!(
            r"(?<![\w-])(?:{VERB}|MODIFIED|RENAMED|DELETED|UPDATED|REPLACED|DEPRECATED)[ \t:*_`|[\]()]*({ID})"
        ),
        "",
    )
});

/// The tokens of `text` shaped like an id, read as one or not.
pub fn id_shaped(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for m in ID_SHAPED.exec_all(text) {
        if !out.iter().any(|o| o == m.text()) {
            out.push(m.text().into());
        }
    }
    out
}

/// Whether `token` is an id as every reader reads one.
pub fn is_id(token: &str) -> bool {
    WHOLE_ID.test(token)
}

fn malformed_in(line: &str) -> Vec<String> {
    id_shaped(line).into_iter().filter(|t| !is_id(t)).collect()
}

/// A delta's text starts at an em dash after a space, a colon, a parenthesis,
/// or a hyphen or en dash before a word that joins nothing. Before it,
/// another id, or a number going on from the first, is a second id.
const JOINER: &str =
    r"(?:[ \t]*(?:[,/&+;~–]|\.\.|-(?=[ \t])|(?:and|or|to|through|thru)(?![\w-]))[ \t]*|—)";

static KIND_PREFIX: LazyLock<Re> = LazyLock::new(|| Re::new(r"^[ \t]*\([a-z]+\)", ""));
static TEXT_STARTS: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        r"[ \t]—|:|\(|[ \t][–-][ \t]+(?!REQ-|\d{3}(?!\d)|(?:and|or|to|through|thru)(?![\w-]))",
        "",
    )
});
static NUMBERS: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &format!(r"^(?:{JOINER}\d{{3}}(?!\d))+[ \t]*(?:$|—|:|\()"),
        "i",
    )
});
static BETWEEN: LazyLock<Re> =
    LazyLock::new(|| Re::new(&format!(r"^(?:[ \t]*\([a-z]+\))?(?:{JOINER}|[ \t]+)$"), "i"));

fn names_second_id(rest: &str) -> bool {
    let before = KIND_PREFIX.replace_all(rest, |_| String::new());
    let head = TEXT_STARTS
        .search(&before)
        .map_or(&before[..], |t| &before[..t]);
    AN_ID.test(head) || NUMBERS.test(&before)
}

/// The ids a line names before its text: the first, and each listed after it.
fn ids_before_text(line: &str) -> Vec<String> {
    let found = AN_ID.exec_all(line);
    let mut ids = Vec::new();
    for (i, m) in found.iter().enumerate() {
        if i > 0 && !BETWEEN.test(&line[found[i - 1].end..m.index]) {
            break;
        }
        ids.push(m.text().to_string());
    }
    ids
}

/// Why a line of the deltas section is refused.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Why {
    TwoIds,
    Malformed,
    Unread,
    NoId,
    NotADelta,
}

/// A line of the deltas section no check binds whole.
pub struct Unread {
    pub line: String,
    pub why: Why,
    pub ids: Vec<String>,
}

/// A delta line naming a second id before its text, a token shaped like an
/// id that is not one, an id no delta line reads, and a line a delta's verb
/// leads that is no delta. A delta's own text, and `- none`'s, may name any
/// id, except after a verb in capitals.
pub fn unread_deltas(body: &str) -> Vec<Unread> {
    let lines = section_lines(body);
    let read: HashSet<&str> = lines
        .iter()
        .filter(|d| !d.verb.is_empty())
        .map(|d| d.id.as_str())
        .collect();
    let mut out = Vec::new();
    for d in &lines {
        let unread = |why, ids| Unread {
            line: d.line.clone(),
            why,
            ids,
        };
        if !d.verb.is_empty() && names_second_id(&d.rest) {
            out.push(unread(Why::TwoIds, Vec::new()));
            continue;
        }
        let malformed = malformed_in(&d.line);
        if !malformed.is_empty() {
            out.push(unread(Why::Malformed, malformed));
            continue;
        }
        let named: Vec<String> = if !d.verb.is_empty() {
            VERBED
                .exec_all(&d.rest)
                .iter()
                .map(|m| m.group(1).into())
                .collect()
        } else if NONE.test(&d.line) {
            VERBED
                .exec_all(&d.line)
                .iter()
                .map(|m| m.group(1).into())
                .collect()
        } else {
            AN_ID
                .exec_all(&d.line)
                .iter()
                .map(|m| m.text().into())
                .collect()
        };
        let mut ids: Vec<String> = Vec::new();
        for n in named {
            if !read.contains(n.as_str()) && !ids.contains(&n) {
                ids.push(n);
            }
        }
        if !ids.is_empty() {
            out.push(unread(Why::Unread, ids));
        } else if d.verb.is_empty() && VERB_LED.test(&d.line) {
            let why = if AN_ID.test(&d.line) {
                Why::NotADelta
            } else {
                Why::NoId
            };
            out.push(unread(why, Vec::new()));
        }
    }
    out
}

const DELTA_SHAPE: &str = "A delta is one line, `- ADDED REQ-<CAP>-0NN — <text>`: a dash at the start, ADDED, CHANGED or REMOVED in capitals, then one id.";

/// Why one line `unread_deltas` found is refused.
pub fn explain_unread(u: &Unread) -> String {
    let quoted = format!("\"{}\"", u.line.trim());
    let ids = u.ids.join(", ");
    match u.why {
        Why::TwoIds => format!(
            "{quoted} names more than one id before its text, and the engine reads the first alone. One delta per line, so each id is checked."
        ),
        Why::Malformed => format!(
            "{quoted} names {ids}, which no check reads as an id: an id is REQ-, its capability in capitals, then three digits, `REQ-<CAP>-0NN`. Write it so. {DELTA_SHAPE}"
        ),
        Why::NoId => format!(
            "{quoted} is written as a delta and names no id, so no check binds it. {DELTA_SHAPE}"
        ),
        Why::NotADelta => format!(
            "{quoted} leads with a delta's verb and is no delta line, so no check reads it as one. {DELTA_SHAPE} Write each delta so, once."
        ),
        Why::Unread => format!(
            "{quoted} names {ids}, which no delta line of this section reads, so no check binds {}. {DELTA_SHAPE} Every other line of the section names only ids its deltas read; a delta's own text may name any. Write each delta so, or move the rest out of the section.",
            if u.ids.len() > 1 { "them" } else { "it" }
        ),
    }
}

/// Outside the section only what can be nothing but a misplaced delta counts.
const OUTSIDE_VERB: &str = "ADDED|CHANGED|REMOVED|MODIFIED|RENAMED";

static MISSPELLED_HEADING: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^#{1,6}[ \t]*requirements?[ \t]+deltas?\b", "i"));
static RIGHT_HEADING: LazyLock<Re> = LazyLock::new(|| Re::new(r"^## Requirement deltas\b", ""));
static GROUPING: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &format!(r"^[ \t]*(?:>[ \t]*)*#{{1,6}}[ \t]*(?:{OUTSIDE_VERB})[ \t]+requirements?\b"),
        "i",
    )
});
static MISPLACED: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &format!(
            r"^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)]|#{{1,6}}|\|)[ \t]*)?(?:\[[ xX]\][ \t]*)?[[(*_`]*(?:{OUTSIDE_VERB})[ \t:*_`|\])]*{ID}"
        ),
        "",
    )
});

/// Why a spec's deltas are not where every reader looks, or `""`. With
/// `needed`, a spec saying nothing the engine reads under the section is one
/// too: a spec says what it does to `specs/`, `- none` included.
pub fn deltas_section_problem(body: &str, needed: bool) -> String {
    let text = without_code(body);
    if let Some(l) = text
        .split('\n')
        .find(|l| MISSPELLED_HEADING.test(l) && !RIGHT_HEADING.test(l))
    {
        return format!(
            "has \"{}\", and the engine reads deltas under `## Requirement deltas` alone, spelled so: no check binds a delta under it. Rename the heading.",
            l.trim()
        );
    }
    let found = section_after(&text, &DELTAS_HEADING);
    let outside = match found {
        Some((from, end, section)) => {
            format!("{}\n{}", &text[..from], &text[end + section.len()..])
        }
        None => text.clone(),
    };
    if let Some(l) = outside
        .split('\n')
        .find(|l| GROUPING.test(l) || MISPLACED.test(l))
    {
        return format!(
            "declares a delta outside `## Requirement deltas` (\"{}\"), where no check reads it. Write each delta in that section, one line each: `- ADDED REQ-<CAP>-0NN — <text>`.",
            l.trim()
        );
    }
    if !needed {
        return String::new();
    }
    if found.is_none() {
        return "has no `## Requirement deltas` section. Write its deltas there, or `- none — <why>` when it has none.".into();
    }
    let says = section_lines(body).iter().any(|d| {
        !d.verb.is_empty()
            || NONE.test(&d.line)
            || AN_ID.test(&d.line)
            || VERB_LED.test(&d.line)
            || !malformed_in(&d.line).is_empty()
    });
    if says {
        String::new()
    } else {
        "says nothing the engine reads under `## Requirement deltas`. Write each delta there, one line each, or `- none — <why>` when it has none.".into()
    }
}

/// REMOVED in capitals as a line's verb, before or beside its id, as archives
/// written before this grammar spelled it too.
static REMOVES: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &format!(
            r"^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)]|#{{1,6}}|\|)[ \t]*)?(?:\[[ xX]\][ \t]*)?[[(*_`]*REMOVED[ \t:*_`|\])]*{ID}|{ID}[ \t:*_`|[(]*REMOVED(?![\w-])"
        ),
        "",
    )
});

/// The ids a spec retires, read leniently so an archive in another spelling
/// still retires what it removed.
pub fn retired_ids(body: &str) -> Vec<String> {
    section_lines(body)
        .iter()
        .filter(|d| REMOVES.test(&d.line))
        .flat_map(|d| ids_before_text(&d.line))
        .collect()
}

/// ADDED ids that are not new: removed by the same spec, or by a SHIPPED
/// change. A retired id keeps meaning the behaviour that was removed.
pub fn reused_ids(body: &str, archived_bodies: &[String]) -> Vec<String> {
    let mut retired: HashSet<String> = retired_ids(body).into_iter().collect();
    for a in archived_bodies.iter().filter(|a| is_shipped(a)) {
        retired.extend(retired_ids(a));
    }
    let mut out: Vec<String> = Vec::new();
    for d in deltas(body) {
        if d.verb == "ADDED" && retired.contains(&d.id) && !out.contains(&d.id) {
            out.push(d.id);
        }
    }
    out
}

/// Where a spec says what its writer decided without asking.
pub const ASSUMPTIONS_HEADING: &str = "## Assumptions";

static CASE_HEADING: LazyLock<Re> = LazyLock::new(|| Re::new(r"^## Case\b", "m"));
static ASSUMPTIONS: LazyLock<Re> =
    LazyLock::new(|| Re::new(&format!(r"^{ASSUMPTIONS_HEADING}\b.*$"), "m"));
static ASSUMPTIONS_ITEM: LazyLock<Re> =
    LazyLock::new(|| Re::new(r"^\s*(?:[-*+]|\d+[.)])\s+\S", "m"));

/// Whether a spec is a `/spec-fix` brief.
pub fn is_fix_brief(body: &str) -> bool {
    CASE_HEADING.test(body)
}

/// Why the assumptions section does not do its job, or `""`. `- none` is an
/// answer; a missing or empty section cannot be told from a writer that never
/// looked. A fix brief is exempt. Read at spec time only, never at the gate
/// (ADR-030).
pub fn assumptions_problem(body: &str) -> String {
    if is_fix_brief(body) {
        return String::new();
    }
    match section_after(body, &ASSUMPTIONS) {
        None => format!("has no `{ASSUMPTIONS_HEADING}` section"),
        Some((_, _, section)) if ASSUMPTIONS_ITEM.test(section) => String::new(),
        Some(_) => format!(
            "has an empty `{ASSUMPTIONS_HEADING}` section — write what was assumed, or `- none`"
        ),
    }
}

/// The words that make a requirement a prohibition; the spec-writer's
/// contract must name each (ADR-045).
pub const PROHIBITION_WORDS: [&str; 4] = ["cannot", "must not", "never", "only"];

static WORD: LazyLock<String> = LazyLock::new(|| {
    let parts: Vec<String> = PROHIBITION_WORDS
        .iter()
        .map(|w| w.replace(' ', r"\s+"))
        .collect();
    format!("(?:{})", parts.join("|"))
});

/// Not in a compound or an identifier, not `not only`, not `the only`.
static PROHIBITION: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &format!(r"(?<![\w-])(?<!\b(?:not|the|an)\s+){}(?![\w-])", *WORD),
        "i",
    )
});
/// Where one claim ends and another begins; not a bare `and`.
static CLAUSE_BREAK: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        &[
            ";".to_string(),
            r"\s[—–]\s".into(),
            r"\s--?\s".into(),
            r",\s*(?:and|but|yet|while|whereas)\b".into(),
            r"\s(?:but|yet|whereas)\s".into(),
            format!(r"(?:,|\sand)\s+(?={}(?![\w-]))", *WORD),
        ]
        .join("|"),
        "i",
    )
});
/// A word after one of these describes a thing rather than forbids one.
static SUBORDINATE: LazyLock<Re> = LazyLock::new(|| {
    Re::new(
        r"\b(?:when|whenever|if|unless|once|until|because|since|after|before|where|whether|that|which|who|whom|whose)\b",
        "i",
    )
});
static LEAD_SEP: LazyLock<Re> = LazyLock::new(|| Re::new(r"^\s*[—–:-]?\s*", ""));
static QUOTED_TEXT: LazyLock<Re> = LazyLock::new(|| Re::new("`[^`]*`|\"[^\"]*\"|“[^”]*”", ""));
static SPACES: LazyLock<Re> = LazyLock::new(|| Re::new(r"\s+", ""));

fn prohibition_in(clause: &str) -> String {
    for segment in clause.split(',') {
        let Some(w) = PROHIBITION.exec(segment) else {
            continue;
        };
        if SUBORDINATE.exec(segment).is_none_or(|s| s.index > w.index) {
            return SPACES.replace_all(&w.text().to_lowercase(), |_| " ".into());
        }
    }
    String::new()
}

/// An ADDED delta stating a prohibition and another claim on one id.
pub struct Paired {
    pub line: String,
    pub id: String,
    pub word: String,
}

/// Quoted and code text is not read.
pub fn paired_prohibitions(body: &str) -> Vec<Paired> {
    let mut out = Vec::new();
    for d in section_lines(body)
        .into_iter()
        .filter(|d| d.verb == "ADDED")
    {
        let claim = LEAD_SEP.replace_all(&d.rest, |_| String::new());
        let claim = QUOTED_TEXT.replace_all(&claim, |_| " ".into());
        let clauses: Vec<&str> = CLAUSE_BREAK
            .split(&claim)
            .into_iter()
            .filter(|c| !c.trim().is_empty())
            .collect();
        if clauses.len() < 2 {
            continue;
        }
        if let Some(word) = clauses
            .iter()
            .map(|c| prohibition_in(c))
            .find(|w| !w.is_empty())
        {
            out.push(Paired {
                line: d.line,
                id: d.id,
                word,
            });
        }
    }
    out
}

/// The problem with naming a live change `slug`, or `""`: the fold moves it
/// to specflow/archive/<slug>/, and onto a folder that exists — in any case a
/// case-insensitive filesystem folds — it lands inside (ADR-048).
pub fn archive_clash(slug: &str, archived_slugs: &[String]) -> String {
    archived_slugs
        .iter()
        .find(|a| a.to_lowercase() == slug.to_lowercase())
        .map_or_else(String::new, |a| {
            format!(
                "specflow/{slug}/ has the name of an archived change, specflow/archive/{a}/. The fold moves a change to specflow/archive/<its name>/, \
                 and onto a folder that exists it lands inside that change instead. Give this change a name of its own: rename specflow/{slug}/."
            )
        })
}

/// Why a live change spec cannot be built from: what spec-trace checks of
/// every live change at the gate, and phase-guard when a run leaves `spec`.
pub fn live_spec_problems(
    slug: &str,
    body: &str,
    has_proposal: bool,
    archived_bodies: &[String],
) -> Vec<String> {
    let mut problems = Vec::new();
    let fix_brief = is_fix_brief(body);

    // CHANGED is the one delta spec-trace cannot prove: the id already has a
    // test, so the binding holds before the edit and after it. A CHANGED that
    // WIDENS claims a clause nobody proves; declared ADDED, spec-trace fails
    // it. So CHANGED keeps only the two edits that move no proof — and nothing
    // here verifies the kind is TRUE; the reviewer and the sign-off do
    // (ADR-009).
    for c in changed_deltas(body) {
        if c.kind == "wording" || (c.kind == "correction" && fix_brief) {
            continue;
        }
        problems.push(format!(
            "specflow/{slug}/spec.md: \"{}\" {}. CHANGED is the one delta spec-trace cannot prove — {id} already exists and already has a test, \
             so the spec/test binding passes before the edit and after it, whatever the body now says. \
             If the requirement means exactly what it meant and no test moves, write `CHANGED {id} (wording)`. \
             Otherwise this is not a CHANGED: split it into `REMOVED {id}` plus an `ADDED` on a NEW id, \
             which spec-trace proves in both directions. Widening counts — a clause added to an existing \
             requirement is claimed by the spec layer and proven by nobody.",
            c.line.trim(),
            explain_kind(&c.kind),
            id = c.id,
        ));
    }

    let reused = reused_ids(body, archived_bodies);
    if !reused.is_empty() {
        problems.push(format!(
            "specflow/{slug}/spec.md ADDs {}, which this spec or a shipped change REMOVED. \
             A retired id keeps meaning the behaviour that was removed — in the archive and in any test or record that names it — \
             so a new requirement takes the next unused id in its capability's sequence.",
            reused.join(", ")
        ));
    }

    // One test of "filters by A and B, never by C" passes while it asserts
    // only A and B. It reads the words and the punctuation, not grammar, and
    // does not check the prohibition's test asserts it (ADR-045, ADR-020).
    for p in paired_prohibitions(body) {
        problems.push(format!(
            "specflow/{slug}/spec.md: \"{}\" pairs a prohibition (\"{}\") with another claim on one id. \
             spec-trace binds {} to any test that ran under its name, so a test of what the requirement allows passes \
             while nothing checks what it forbids. Give the prohibition an ADDED id of its own — \"filters by A and B\" on one id, \
             \"never filters by C\" on the next — so the gate stays red until a test named for it runs.",
            p.line.trim(),
            p.word,
            p.id
        ));
    }

    if fix_brief {
        return problems; // exempt from the split below, by design
    }
    let leaked: Vec<&str> = HEAVY_HEADINGS
        .iter()
        .filter(|h| Re::new(&format!(r"^{h}\b"), "m").test(body))
        .copied()
        .collect();
    if !leaked.is_empty() {
        problems.push(format!(
            "specflow/{slug}/spec.md carries {}. Those belong in specflow/{slug}/proposal.md — the spec says what changes, the proposal says why it was chosen and what was rejected. The planner reads the first on every fresh context; only a human reads the second.",
            leaked.join(", ")
        ));
    }
    if !has_proposal {
        problems.push(format!(
            "specflow/{slug}/ has no proposal.md. A change spec with no recorded reasoning is a decision nobody can audit later — the archive's whole job is answering \"was this considered, and what was turned down?\"."
        ));
    }
    problems
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_with(assumptions: &str) -> String {
        format!(
            "# Spec — x\n\n## Requirement deltas\n- ADDED REQ-A-001 — a thing\n{assumptions}\n## Out of scope\n- nothing\n"
        )
    }

    #[test]
    fn assumptions() {
        for s in [
            spec_with("\n## Assumptions\n- none\n"),
            spec_with("\n## Assumptions\n- emails are unique — a merge flow is needed if not\n"),
            spec_with("\n## Assumptions\n1. emails are unique — a merge flow if not\n"),
            spec_with("\n## Assumptions\n+ none\n"),
            "# Fix — x\n\n## Case\n2 WEAK-TEST\n".into(), // a fix brief is exempt
        ] {
            assert_eq!(assumptions_problem(&s), "", "{s}");
        }
        assert!(assumptions_problem(&spec_with("")).contains("no `## Assumptions` section"));
        assert!(assumptions_problem(&spec_with("\n## Assumptions\n\n")).contains("empty"));
    }

    /// A delta touches the spec declaring its id, else the longest prefix,
    /// else none.
    #[test]
    fn capability_of_reads_the_declaring_spec() {
        let specs = [
            Spec {
                file: "specs/user.md".into(),
                ids: declared_ids("### REQ-USER-001 — a\n### REQ-USER-PROFILE-007 — moved here\n"),
            },
            Spec {
                file: "specs/user-profile.md".into(),
                ids: HashSet::new(),
            },
        ];
        for (id, want) in [
            ("REQ-USER-PROFILE-007", "specs/user.md"),
            ("REQ-USER-PROFILE-008", "specs/user-profile.md"),
            ("REQ-USER-002", "specs/user.md"),
            ("REQ-ORDER-001", ""),
        ] {
            assert_eq!(capability_of(id, &specs), want, "{id}");
        }
        // An ADDED id whose capability has no file touches no other capability.
        let one = [Spec {
            file: "specs/user.md".into(),
            ids: declared_ids("### REQ-USER-001 — a\n"),
        }];
        assert_eq!(capability_of("REQ-USER-PROFILE-001", &one), "");
    }

    #[test]
    fn ids_in_reads_both_spellings() {
        assert_eq!(ids_in("test_REQ_CORE_001"), ["REQ-CORE-001"]);
        assert_eq!(
            ids_in("REQ-USER-001_002"),
            ["REQ-USER-001", "REQ-USER-001-002"]
        );
        assert_eq!(ids_in("TestAuth/REQ-USER-001_rejects"), ["REQ-USER-001"]);
    }

    // ---- the deltas: one grammar, read or refused

    fn deltas_of(section: &str) -> String {
        format!("# Spec — x\n\n## Requirement deltas\n{section}\n\n## Assumptions\n- none\n")
    }

    fn read_of(section: &str) -> Vec<String> {
        deltas(&deltas_of(section))
            .into_iter()
            .map(|d| format!("{} {}", d.verb, d.id))
            .collect()
    }

    fn refused_of(section: &str) -> Vec<Why> {
        unread_deltas(&deltas_of(section))
            .into_iter()
            .map(|u| u.why)
            .collect()
    }

    #[test]
    fn a_delta_is_one_line() {
        assert_eq!(
            read_of(
                "- ADDED   REQ-A-001 — a\n* CHANGED REQ-A-002 (wording) — b\n-REMOVED REQ-A-003 — c"
            ),
            ["ADDED REQ-A-001", "CHANGED REQ-A-002", "REMOVED REQ-A-003"]
        );
        assert!(refused_of("- ADDED REQ-A-001 — a").is_empty());
    }

    #[test]
    fn a_delta_spelled_any_other_way_is_refused() {
        for line in [
            "- ADDED\n  REQ-A-002 — wrapped after its verb",
            "| ADDED | REQ-A-002 | a table row |",
            "- [ADDED] REQ-A-002 — bracketed",
            "- (ADDED) REQ-A-002 — in parentheses",
            "- REQ-A-002 (ADDED) — the verb after the id",
            "- [x] ADDED REQ-A-002 — a checkbox",
            "- **ADDED** REQ-A-002 — bold",
            "+ ADDED REQ-A-002 — a plus sign",
            "  - ADDED REQ-A-002 — indented",
            "### ADDED REQ-A-002 — a heading",
            "- added REQ-A-002 — lowercase",
            "- ADDED: REQ-A-002 — a colon",
            // the verb after the id, another bullet, or in a quote
            "| REQ-A-002 | Export to CSV | ADDED |",
            "- REQ-A-002 ADDED — export",
            "- REQ-A-002: ADDED — export",
            "– ADDED REQ-A-002 — an en dash",
            "• ADDED REQ-A-002 — a bullet",
            "> - ADDED REQ-A-002 — quoted",
            "- Added REQ-A-002 — export",
            "· ADDED REQ-A-002 — a middle dot",
            "\u{a0}- ADDED REQ-A-002 — a no-break space before the dash",
            "a) ADDED REQ-A-002 — a lettered list",
            "- NEW REQ-A-002 — another word",
            "- REQ-A-002 Added — the verb after the id",
            "- REQ-A-002 — ADDED: the verb in the text",
            // a verb another format writes
            "- MODIFIED REQ-A-001 — now also PDF",
            "- UPDATED REQ-A-001 — x",
            "- DELETED REQ-A-001 — gone",
            "- RENAMED REQ-A-001 — to export",
            "- Updated REQ-A-001 wording",
        ] {
            assert!(read_of(line).is_empty(), "read: {line}");
            assert!(
                refused_of(line).contains(&Why::Unread),
                "skipped, not refused: {line}"
            );
        }
    }

    #[test]
    fn a_second_id_or_a_range_is_refused() {
        for line in [
            "- ADDED REQ-A-002, REQ-A-003 — two",
            "- ADDED REQ-A-002 and REQ-A-003 — two",
            "- ADDED REQ-A-002; REQ-A-003 — two",
            "- ADDED REQ-A-002 to REQ-A-004 — a range",
            "- ADDED REQ-A-002–004 — a range",
            "- ADDED REQ-A-002..REQ-A-004 — a range",
            "- ADDED REQ-A-009 - REQ-A-010 a range",
            "- CHANGED REQ-A-001 (wording), REQ-A-002 — two",
            "- ADDED REQ-A-002 REQ-A-003 — two",
            "- ADDED REQ-A-001, 002 — export and import",
            "- ADDED REQ-A-001 to 002 — x",
            "- ADDED REQ-A-001 – 002 — x",
            "- ADDED REQ-A-001/002 — x",
            "- ADDED REQ-A-002—004 — x",
            "- ADDED REQ-A-002 .. 004 — x",
            "- ADDED REQ-A-002 & 003 — x",
            "- ADDED REQ-A-002 and 003 — x",
            "- ADDED REQ-A-001~003 — x",
            "- ADDED REQ-A-001 - and REQ-A-003 — two", // a dash before a joining word joins
        ] {
            assert_eq!(refused_of(line), [Why::TwoIds], "{line}");
        }
        // A number the text goes on from is the text.
        for line in [
            "- ADDED REQ-A-001 — 300 requests per second",
            "- ADDED REQ-A-001 100 users can export at once",
            "- ADDED REQ-A-001: 500 errors are retried",
            "- ADDED REQ-A-001 - 500 errors are retried",
            "- CHANGED REQ-A-001 (wording) — 300 ms",
            "- ADDED REQ-A-002 - 404 or 410 for a deleted user",
            "- ADDED REQ-A-002 – 100 to 200 ms jitter is tolerated",
            "- ADDED REQ-A-002 - 401, not 403, for a bad token",
            "- CHANGED REQ-A-001 (wording) - 300. Still the same",
            "- ADDED REQ-A-002 - export, filtered as REQ-A-001 says",
            "- REMOVED REQ-A-003 – superseded by REQ-A-002",
        ] {
            assert!(refused_of(line).is_empty(), "{line}");
        }
        for id in ["REQ-RFC-822-001", "REQ-ADR-009-010", "REQ-A-002-004"] {
            let line = format!("- ADDED {id} — x");
            assert_eq!(read_of(&line), [format!("ADDED {id}")]);
            assert!(refused_of(&line).is_empty(), "{id}");
        }
    }

    #[test]
    fn prose_notes_and_an_id_in_the_text_are_neither_read_nor_refused() {
        let section = [
            "> What this change does to `specs/`.",
            "- REMOVED REQ-A-001 (REQ-A-004 supersedes it)",
            "- REMOVED REQ-A-005 — REQ-A-006 replaces it",
            "- ADDED REQ-A-007 — 300 requests per second",
            "  - Removed because nobody uses it",
            "- Added the export button to the README",
            "- Changed: none",
            "Changed nothing in specs/.",
            "- none — infrastructure only",
        ]
        .join("\n");
        assert_eq!(
            read_of(&section),
            ["REMOVED REQ-A-001", "REMOVED REQ-A-005", "ADDED REQ-A-007"]
        );
        assert!(refused_of(&section).is_empty());
        let fenced = "- none — infrastructure only\n```\n- ADDED REQ-A-099 — an example\n| ADDED | REQ-A-098 |\n```";
        assert!(read_of(fenced).is_empty(), "a fenced example read");
        assert!(refused_of(fenced).is_empty(), "a fenced example refused");
    }

    #[test]
    fn deltas_section_problems() {
        for (body, want) in [
            (
                "# S\n\n## Requirement Deltas\n- ADDED REQ-A-002 — x\n",
                "has \"## Requirement Deltas\"",
            ),
            (
                "# S\n\n### Requirement deltas\n- ADDED REQ-A-002 — x\n",
                "has \"### Requirement deltas\"",
            ),
            (
                "# S\n\n## ADDED Requirements\n### REQ-A-002 — x\n",
                "outside `## Requirement deltas` (\"## ADDED Requirements\")",
            ),
            ("# S\n\n## Deltas\n- ADDED REQ-A-002 — x\n", "outside"),
        ] {
            let p = deltas_section_problem(body, false);
            assert!(p.contains(want), "{body:?}: {p}");
        }
        for body in [
            "# S\n\n## Context\nWe added REQ-A-002 last time.\n\n## Requirement deltas\n- none\n",
            "# S\n\n```\n## Requirement Deltas\n```\n\n## Requirement deltas\n- none\n",
        ] {
            assert_eq!(deltas_section_problem(body, false), "", "{body:?}");
        }
        let body = "# S\n\n## User stories\n- US-1 — x\n";
        assert!(deltas_section_problem(body, true).contains("no `## Requirement deltas` section"));
        assert_eq!(deltas_section_problem(body, false), "");
        let p = deltas_section_problem(
            "# S\n\n## MODIFIED Requirements\n### Requirement: x\n\n## Requirement deltas\n- none\n",
            true,
        );
        assert!(
            p.contains("outside `## Requirement deltas` (\"## MODIFIED Requirements\")"),
            "{p}"
        );
    }

    #[test]
    fn malformed_ids() {
        for id in [
            "REQ-A-10",
            "REQ-A-02",
            "REQ-A-0002",
            "REQ_A_002",
            "req-a-002",
        ] {
            let section = format!("- ADDED REQ-A-001 — import\n- ADDED {id} — export");
            assert_eq!(read_of(&section), ["ADDED REQ-A-001"], "{id}");
            assert_eq!(refused_of(&section), [Why::Malformed], "{id}");
        }
        assert_eq!(
            refused_of("- ADDED REQ-A-001 — import\n| REQ-A-10 | Added |"),
            [Why::Malformed]
        );
        // A word that merely starts like an id is no malformed id.
        let words = [
            "- ADDED REQ-A-002 — logs the `req_id` of every export",
            "- ADDED REQ-A-003 — the req-res cycle times out after 30 s",
            "- ADDED REQ-A-004 — a Req-to-Pay approval needs two signatures, as asked in REQ-1234",
            "  - req_headers are logged, never bodies",
            "- ADDED REQ-A-005 — export, proven by `TestExport/REQ-A-005_rejects_empty`",
        ]
        .join("\n");
        assert!(refused_of(&words).is_empty(), "words like an id");
    }

    #[test]
    fn a_verb_in_capitals_leads_a_delta() {
        assert_eq!(
            refused_of("- ADDED REQ-A-001 — import\n- ADDED: the export button"),
            [Why::NoId]
        );
        assert!(
            refused_of("### ADDED\n- ADDED REQ-A-001 — import").is_empty(),
            "a heading grouping deltas"
        );
        let row = unread_deltas(&deltas_of(
            "- ADDED REQ-A-002 — export\n| ADDED | REQ-A-002 |",
        ));
        assert!(
            row.len() == 1
                && row[0].why == Why::NotADelta
                && !explain_unread(&row[0]).contains("names no id"),
            "a row restating a delta"
        );
        for line in [
            "| REQ-A-002 | Added | export to CSV |",
            "| added | REQ-A-002 | export to CSV |",
            "| Removed | REQ-A-002 |",
            "| Added | REQ-A-002 | x |",
        ] {
            let section = format!("- ADDED REQ-A-001 — import\n{line}");
            assert_eq!(read_of(&section), ["ADDED REQ-A-001"], "{line}");
            assert_eq!(refused_of(&section), [Why::Unread], "{line}");
        }
        assert_eq!(
            refused_of("- ADDED REQ-A-001 — export; ADDED REQ-A-002 — import"),
            [Why::Unread]
        );
        assert!(
            refused_of(
                "- ADDED REQ-A-001 — export; ADDED REQ-A-002 — import\n- ADDED REQ-A-002 — import"
            )
            .is_empty()
        );
    }

    /// A note names only ids its deltas read; a delta's own text may name any.
    #[test]
    fn notes() {
        let section = [
            "- REMOVED REQ-A-001 — legacy export; REQ-A-004 will replace it in a follow-up",
            "  - Removed for now; REQ-A-001 goes with its test",
            "- ADDED REQ-A-005 — sync",
            "  - Added after review; REQ-A-005 stays behind a flag",
            "> REQ-A-005 ships dark.",
        ]
        .join("\n");
        assert_eq!(read_of(&section), ["REMOVED REQ-A-001", "ADDED REQ-A-005"]);
        assert!(refused_of(&section).is_empty());
        for note in [
            "  - Removed for now; REQ-A-004 will replace it",
            "- Changed from thirty; REQ-A-003 keeps its timeout",
            "REQ-A-003 keeps its timeout.",
        ] {
            assert_eq!(
                refused_of(&format!("- REMOVED REQ-A-001 — legacy export\n{note}")),
                [Why::Unread],
                "{note}"
            );
        }
        let api = [
            "### Create",
            "- ADDED REQ-API-008 — POST /users creates a user",
            "### Update",
            "- ADDED REQ-API-009 — PUT /users/:id replaces it",
            "  - REQ-API-009 DELETE /users/:id answers 204",
            "  - UPDATE statements run in one transaction",
            "### Delete",
            "- REMOVED REQ-API-010 — the batch delete",
            "  - DELETE /legacy/users now answers 410",
            "  - DEPRECATED since v2.3",
        ]
        .join("\n");
        assert_eq!(
            read_of(&api),
            [
                "ADDED REQ-API-008",
                "ADDED REQ-API-009",
                "REMOVED REQ-API-010"
            ]
        );
        assert!(refused_of(&api).is_empty());
    }

    #[test]
    fn retired_and_reused_ids() {
        let retired = |s: &str| retired_ids(&deltas_of(s));
        assert_eq!(
            retired(
                "- REMOVED REQ-A-001 — legacy export\n  - Removed for now; REQ-A-004 will replace it in a follow-up"
            ),
            ["REQ-A-001"]
        );
        assert!(
            retired("- Removed REQ-A-004 — x\n- REQ-A-005 (removed)\n| Removed | REQ-A-006 |")
                .is_empty()
        );
        assert_eq!(retired("| REMOVED | REQ-A-006 |"), ["REQ-A-006"]);
        assert_eq!(
            retired("- REMOVED REQ-A-001, REQ-A-002 — both"),
            ["REQ-A-001", "REQ-A-002"]
        );
        assert_eq!(
            retired("  - REMOVED REQ-A-003\n- **REMOVED** REQ-A-004\n- REQ-A-005 (REMOVED)"),
            ["REQ-A-003", "REQ-A-004", "REQ-A-005"]
        );
        assert_eq!(
            retired("- REMOVED REQ-A-006 (REQ-A-007 supersedes it)\n- ADDED REQ-A-008 — x"),
            ["REQ-A-006"]
        );
        let archived = "# Spec — old\n\n**Status:** SHIPPED 2026-07-30\n\n## Requirement deltas\n- REMOVED REQ-A-001, REQ-A-002 — both gone\n";
        assert_eq!(
            reused_ids(&deltas_of("- ADDED REQ-A-002 — again"), &[archived.into()]),
            ["REQ-A-002"]
        );
        assert!(
            reused_ids(
                &deltas_of("- ADDED REQ-A-002 — again"),
                &[archived.replacen("SHIPPED", "REJECTED", 1)]
            )
            .is_empty()
        );
    }

    #[test]
    fn code_declares_nothing() {
        for section in [
            "- ADDED REQ-A-001 — x\n<!--\n- ADDED REQ-A-003 — dropped\n-->",
            "- ADDED REQ-A-001 — x\n````md\n```\n- ADDED REQ-A-099 — an example\n```\n````",
            "- ADDED REQ-A-001 — x\n~~~md\n```\n- ADDED REQ-A-099 — an example\n```\n~~~",
            "- ADDED REQ-A-001 — x\n\nFor example:\n\n    - ADDED REQ-A-099 — an example",
        ] {
            assert_eq!(read_of(section), ["ADDED REQ-A-001"], "{section}");
            assert!(refused_of(section).is_empty(), "{section}");
        }
        // A comment marker in a code span hides nothing, and a fence ends with its list item.
        assert_eq!(
            read_of(
                "- ADDED REQ-A-001 — strips `<!--` from names\n- ADDED REQ-A-002 — export\n- ADDED REQ-A-003 — strips `-->` too"
            ),
            ["ADDED REQ-A-001", "ADDED REQ-A-002", "ADDED REQ-A-003"]
        );
        assert_eq!(
            read_of("- ADDED REQ-A-001 — x\n  ```\n- ADDED REQ-A-002 — y\n  ```"),
            ["ADDED REQ-A-001", "ADDED REQ-A-002"]
        );
        // A fence never closed, and lines ended by CR alone, still declare.
        assert_eq!(read_of("```\n- ADDED REQ-A-002 — x"), ["ADDED REQ-A-002"]);
        for end in ["\r", "\r\n"] {
            let ids: Vec<String> = deltas(&deltas_of("- ADDED REQ-A-002 — x").replace('\n', end))
                .into_iter()
                .map(|d| d.id)
                .collect();
            assert_eq!(ids, ["REQ-A-002"], "line ends {end:?}");
        }
    }

    #[test]
    fn outside_the_section() {
        let around = |outside: &str| {
            format!("# S\n\n{outside}\n\n## Requirement deltas\n- ADDED REQ-A-002 — x\n")
        };
        for outside in [
            "## Non-functional / constraints\n- `REMOVED` items never reappear after a sync\n- `ADDED` events carry the item id",
            "## Symptom\n- ADDED role admin to user 42\n- ADDED role admin to user 42",
            "## Notes\nADDED in response to issue #12.",
            "## User stories\n- ADDED value: users export",
            "## States\n### Update\n### Deleted",
            "## API\n| /users/:id | DELETE | REQ-A-001 |\n- REQ-A-001 (deleted users are hidden) is unchanged\n### REQ-A-002: DELETE /users/:id",
            "## States\n| DELETED | REQ-A-001 |",
            "## Context\n- added REQ-A-003 last time, as prose",
        ] {
            assert_eq!(
                deltas_section_problem(&around(outside), true),
                "",
                "{outside}"
            );
        }
        let p = deltas_section_problem(&around("## Deltas\n- ADDED REQ-A-003 — y"), true);
        assert!(
            p.contains("outside `## Requirement deltas` (\"- ADDED REQ-A-003"),
            "{p}"
        );
        let p = deltas_section_problem(&around("## Deltas\n| REMOVED | REQ-A-003 |"), true);
        assert!(
            p.contains("outside `## Requirement deltas` (\"| REMOVED | REQ-A-003 |\")"),
            "{p}"
        );
    }

    #[test]
    fn a_section_the_engine_reads_nothing_in() {
        let at = |section: &str| {
            deltas_section_problem(&format!("# S\n\n## Requirement deltas\n{section}\n"), true)
        };
        for s in [
            "This change adds the export.",
            "### ADDED",
            "\n    - ADDED REQ-A-002 — indented into a code block",
            "",
        ] {
            assert!(
                at(s).contains("says nothing the engine reads"),
                "{s:?}: {}",
                at(s)
            );
        }
        for s in [
            "- none — infrastructure only",
            "- **None**",
            "- added REQ-A-002 — refused as a line instead",
        ] {
            assert_eq!(at(s), "", "{s}");
        }
        assert_eq!(
            deltas_section_problem("# S\n\n## Requirement deltas\nprose\n", false),
            ""
        );
        // It says it has no delta in the words writers use.
        for none in [
            "None — infrastructure only",
            "_None._",
            "- n/a — wiring only",
            "- No requirement changes — wiring only",
            "- No deltas: wiring only",
            "1. none — wiring only",
            "  - none — wiring only",
            "> none — wiring only",
            "- Nothing changes in specs/ — wiring only",
            "No change — REQ-A-001 is right; its test missed a case",
            "- No new requirements — wiring only",
            "- No spec change: REQ-A-001 is right; its test missed the empty filter",
            "- Unchanged — REQ-A-001 stays as written",
            "Not applicable — infrastructure only",
        ] {
            assert_eq!(at(none), "", "{none}");
            assert!(refused_of(none).is_empty(), "{none}");
        }
        assert_eq!(
            refused_of("- No longer exports CSV (REQ-A-002)"),
            [Why::Unread]
        );
    }

    // ---- a prohibition has an id of its own (ADR-045)

    fn problems(deltas: &str, heading: &str) -> Vec<String> {
        let heading = if heading.is_empty() {
            "# Spec — x"
        } else {
            heading
        };
        live_spec_problems(
            "x",
            &format!(
                "{heading}\n\n## Requirement deltas\n{deltas}\n\n## Out of scope\n- nothing\n"
            ),
            true,
            &[],
        )
    }

    #[test]
    fn prohibitions() {
        let named =
            regex::Regex::new(r"(?s)REQ-A-001.*prohibition|prohibition.*REQ-A-001").unwrap();
        for d in [
            // paired with what the requirement allows
            "- ADDED REQ-A-001 — filters by A and B, never by C",
            "- ADDED REQ-A-001 — filters by A and B and never by C",
            "- ADDED REQ-A-001 — filters by A and B but never by C",
            "- ADDED REQ-A-001 — lists the user's orders and must not list another user's",
            "- ADDED REQ-A-001 — returns the order; a locked account cannot read it",
            "- ADDED REQ-A-001 — admins can delete a post — other users cannot",
            "- ADDED REQ-A-001: returns 404, never 500, for a missing order",
            // stated first and paired after
            "- ADDED REQ-A-001 — never stores the card, and masks it in the receipt",
            "- ADDED REQ-A-001 — only admins can delete a post, and the delete is logged",
            "- ADDED REQ-A-001 — when the cart is empty, checkout is never offered, and a hint is shown",
        ] {
            let found = problems(d, "");
            assert!(
                found.len() == 1 && named.is_match(&found[0]) && found[0].contains("id of its own"),
                "not refused: {d}\n{found:?}"
            );
        }
        for d in [
            // only a prohibition
            "- ADDED REQ-A-001 — a guest cannot delete an order",
            "- ADDED REQ-A-001 — the search must not filter by C",
            "- ADDED REQ-A-001 — a filter never matches on C",
            "- ADDED REQ-A-001 — only an admin may delete a post",
            "- ADDED REQ-A-001 — Only admins and owners may delete a post",
            "- ADDED REQ-A-001 — never sends email or SMS to an unverified address",
            "- ADDED REQ-A-001 — filters only by name, city and country",
            "- ADDED REQ-A-001 — when the cart is empty, checkout is never offered",
            // a subordinate clause describes
            "- ADDED REQ-A-001 — returns 404 when the user cannot be found",
            "- ADDED REQ-A-001 — returns 404 when the user cannot be found, and logs the lookup",
            "- ADDED REQ-A-001 — cancels an order that was never paid, and emails the buyer",
            "- ADDED REQ-A-001 — lists a user who has never logged in as dormant, and emails them weekly",
            // ordinary uses of the words
            "- ADDED REQ-A-001 — returns not only the order but also its lines",
            "- ADDED REQ-A-001 — lists the only admin first, and the rest by name",
            "- ADDED REQ-A-001 — lists read-only fields, and sorts them by name",
            "- ADDED REQ-A-001 — lists never-expiring tokens; sorts them by owner",
            "- ADDED REQ-A-001 — the `--only` flag narrows the export, and the `neverExpires` field is listed",
            r#"- ADDED REQ-A-001 — answers "cannot be empty" for a blank name, and keeps the draft"#,
            "- ADDED REQ-A-001 — onlyActive narrows the list, and neverSent is shown",
            // several claims with no prohibition are not this rule's business
            "- ADDED REQ-A-001 — filters by A and B, sorts by C; pages by 20",
            // outside an ADDED delta
            "- CHANGED REQ-A-001 (wording) — filters by A and B, never by C",
            "- REMOVED REQ-A-001 — filtered by A and B, never by C",
        ] {
            let found = problems(d, "");
            assert!(found.is_empty(), "refused: {d}\n{found:?}");
        }
        let body = "# Spec — x\n\nIt filters by A and B, and never by C.\n\n## Requirement deltas\n- ADDED REQ-A-001 — filters by A and B\n\n## Out of scope\n- sorting, and never paging\n";
        assert!(
            live_spec_problems("x", body, true, &[]).is_empty(),
            "words outside the deltas were read"
        );
        // A case 1 adds a requirement as a feature does.
        let found = problems(
            "- ADDED REQ-A-001 — filters by A and B, never by C",
            "# Fix — x\n\n## Case\n1 UNSPECIFIED",
        );
        assert!(
            found.len() == 1 && found[0].contains("prohibition"),
            "a fix brief: {found:?}"
        );
        let found = problems(
            "- ADDED REQ-A-001 — filters by A, never by C\n- ADDED REQ-A-002 — never sorts by C\n- ADDED REQ-A-003 — sorts by B; never by C",
            "",
        );
        assert!(
            found.len() == 2 && found[0].contains("REQ-A-001") && found[1].contains("REQ-A-003"),
            "each paired delta is named, and only those: {found:?}"
        );
    }
}

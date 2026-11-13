//! Reads the `k=v` logs in `.claude/state/` back, in ONE copy: stats and
//! status both report what a run cost, and two summaries of the same lines
//! that disagree are worse than one that is wrong. The writers — run-trace,
//! token-trace and the gate's history line — append space-separated `k=v`
//! pairs after an ISO timestamp.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::agents;
use crate::state;

/// One parsed line: its fields, its timestamp and the line itself.
pub struct Entry {
    /// Milliseconds since the epoch.
    pub at: Option<f64>,
    #[allow(dead_code)] // read by stats
    pub raw: String,
    pub fields: HashMap<String, String>,
}

impl Entry {
    /// A field's value, when the line has it.
    pub fn get(&self, k: &str) -> Option<&str> {
        self.fields.get(k).map(String::as_str)
    }

    /// A field's value, `""` when absent.
    pub fn f(&self, k: &str) -> &str {
        self.get(k).unwrap_or_default()
    }
}

static PAIR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"([0-9A-Za-z_][0-9A-Za-z_-]*)=([^\t\n\x0C\r ]+)").unwrap());
static STAMP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([^\t\n\x0C\r ]+Z)").unwrap());

/// A line's pairs, values as far as the next SPACE — which is why every
/// writer strips whitespace out of a value.
pub fn parse(line: &str) -> Entry {
    Entry {
        at: STAMP
            .captures(line)
            .and_then(|m| state::parse_rfc3339(&m[1])),
        raw: line.into(),
        fields: PAIR
            .captures_iter(line)
            .map(|m| (m[1].to_string(), m[2].to_string()))
            .collect(),
    }
}

/// The role an `agent type=` line names, the `spec-flow:` dropped.
#[allow(dead_code)] // read by stats
pub fn role_of(typ: &str) -> String {
    let r = agents::match_agent(&[typ.to_string()], &agents::roles());
    if r.is_empty() { typ.into() } else { r }
}

/// The counters token-trace writes, in the order reported.
pub const TOKEN_FIELDS: [&str; 5] = ["in", "out", "cache_read", "cache_write", "think"];

/// `Number.prototype.toFixed`.
pub fn to_fixed(v: f64, digits: usize) -> String {
    let p = 10f64.powi(digits as i32);
    format!("{:.*}", digits, (v * p).round() / p)
}

/// A number as JavaScript prints one.
pub fn js_num(v: f64) -> String {
    format!("{v}")
}

/// A big count at a glance, exact below a thousand.
pub fn human(v: f64) -> String {
    if v >= 1e6 {
        format!("{}M", to_fixed(v / 1e6, 1))
    } else if v >= 1e3 {
        format!("{}k", js_num((v / 1e3).round()))
    } else {
        js_num(v)
    }
}

/// A count token-trace documents as a floor — `out`, `think`.
pub fn at_least(v: f64) -> String {
    format!("≥{}", human(v))
}

/// One model and chain's totals.
pub struct Row {
    pub model: String,
    pub chain: String,
    pub msgs: f64,
    pub n: HashMap<&'static str, f64>,
    pub think_unknown: bool,
}

impl Row {
    pub fn get(&self, k: &str) -> f64 {
        self.n.get(k).copied().unwrap_or(0.0)
    }
}

fn num_of(s: &str) -> f64 {
    s.trim()
        .parse::<f64>()
        .ok()
        .filter(|f| !f.is_nan())
        .unwrap_or(0.0)
}

/// One row per model and chain, output-heaviest first. An advisor's line is
/// a chain of its own. `sidechain` arrives as the STRING "true": the boolean
/// was flattened on the way into the log.
pub fn summarize_tokens(entries: &[Entry]) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for e in entries {
        let model = e.f("model");
        if model.is_empty() || e.get("msgs").is_none() {
            continue;
        }
        let chain = if e.f("advisor") == "true" {
            "advisor"
        } else if e.f("sidechain") == "true" {
            "subagent"
        } else {
            "main"
        };
        let at = match rows
            .iter()
            .position(|r| r.model == model && r.chain == chain)
        {
            Some(i) => i,
            None => {
                rows.push(Row {
                    model: model.into(),
                    chain: chain.into(),
                    msgs: 0.0,
                    n: HashMap::new(),
                    think_unknown: false,
                });
                rows.len() - 1
            }
        };
        let r = &mut rows[at];
        r.msgs += num_of(e.f("msgs"));
        for f in TOKEN_FIELDS {
            *r.n.entry(f).or_default() += num_of(e.f(f));
        }
        if e.get("think").is_none() {
            r.think_unknown = true;
        }
    }
    rows.sort_by(|a, b| {
        b.get("out")
            .partial_cmp(&a.get("out"))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

/// `String.prototype.padEnd`, counting UTF-16 units as JavaScript does.
pub fn pad_end(s: &str, width: usize) -> String {
    let n: usize = s.chars().map(char::len_utf16).sum();
    if n >= width {
        s.into()
    } else {
        format!("{s}{}", " ".repeat(width - n))
    }
}

/// One row, padded so a stack of them lines up.
pub fn token_row(r: &Row, width: usize) -> String {
    let think = if r.think_unknown {
        "?".into()
    } else {
        at_least(r.get("think"))
    };
    format!(
        "{}  {}  in {}  out {}  cache_read {}  think {think}  ({} msg)",
        pad_end(&r.model, width),
        pad_end(&r.chain, 8),
        human(r.get("in")),
        at_least(r.get("out")),
        human(r.get("cache_read")),
        js_num(r.msgs)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_print_as_javascript_does() {
        assert_eq!(human(999.0), "999");
        assert_eq!(human(1499.0), "1k");
        assert_eq!(human(1_250_000.0), "1.3M");
        assert_eq!(to_fixed(0.25, 1), "0.3");
        assert_eq!(pad_end("ab", 4), "ab  ");
    }

    #[test]
    fn rows_sum_by_model_and_chain() {
        let lines = [
            "2026-11-13T10:00:00.000Z phase=implement tokens model=m sidechain=false in=10 out=5 cache_read=0 cache_write=0 think=1 msgs=1 max_prompt=10",
            "2026-11-13T10:01:00.000Z phase=implement tokens model=m sidechain=true in=1 out=50 cache_read=0 cache_write=0 msgs=2 max_prompt=1",
            "2026-11-13T10:02:00.000Z phase=implement tokens model=m sidechain=false in=10 out=5 cache_read=0 cache_write=0 think=1 msgs=1 max_prompt=10",
        ];
        let entries: Vec<Entry> = lines.iter().map(|l| parse(l)).collect();
        assert_eq!(entries[0].at, Some(1_794_564_000_000.0));
        let rows = summarize_tokens(&entries);
        assert_eq!(
            (
                rows[0].chain.as_str(),
                rows[0].get("out"),
                rows[0].think_unknown
            ),
            ("subagent", 50.0, true)
        );
        assert_eq!(
            (rows[1].chain.as_str(), rows[1].get("in"), rows[1].msgs),
            ("main", 20.0, 2.0)
        );
    }
}

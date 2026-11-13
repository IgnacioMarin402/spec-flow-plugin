//! A regular expression with ECMAScript semantics, for the patterns that need
//! lookaround, or JavaScript's line terminators under `m` and for `.`: the
//! `regex` crate has neither, and rewriting each pattern by hand is where a
//! port changes what a check accepts. Offsets are bytes into the input, as
//! everywhere else here.

#![allow(dead_code)] // `has` is read by readers B72–B75 port

use std::ops::Range;

/// A compiled ECMAScript pattern.
pub struct Re(regress::Regex);

/// One match: its byte span and its groups.
pub struct Match<'t> {
    pub index: usize,
    pub end: usize,
    text: &'t str,
    groups: Vec<Option<Range<usize>>>,
}

impl<'t> Match<'t> {
    /// The whole match.
    pub fn text(&self) -> &'t str {
        &self.text[self.index..self.end]
    }

    /// Group `i`'s text, `""` when it did not take part.
    pub fn group(&self, i: usize) -> &'t str {
        match self.groups.get(i) {
            Some(Some(r)) => &self.text[r.clone()],
            _ => "",
        }
    }

    /// Whether group `i` took part in the match.
    pub fn has(&self, i: usize) -> bool {
        matches!(self.groups.get(i), Some(Some(_)))
    }
}

impl Re {
    /// `pattern` with JavaScript flags: any of `i`, `m`, `s`. A pattern that
    /// does not compile is a bug in this engine, not in its input: it panics.
    pub fn new(pattern: &str, flags: &str) -> Re {
        match regress::Regex::with_flags(pattern, flags) {
            Ok(re) => Re(re),
            Err(e) => panic!("jsre: /{pattern}/{flags}: {e}"),
        }
    }

    fn convert<'t>(text: &'t str, m: regress::Match) -> Match<'t> {
        let range = m.range();
        let mut groups = vec![Some(range.clone())];
        groups.extend(m.captures.iter().cloned());
        Match {
            index: range.start,
            end: range.end,
            text,
            groups,
        }
    }

    /// Whether `s` holds a match.
    pub fn test(&self, s: &str) -> bool {
        self.0.find(s).is_some()
    }

    /// The first match in `s`.
    pub fn exec<'t>(&self, s: &'t str) -> Option<Match<'t>> {
        self.0.find(s).map(|m| Re::convert(s, m))
    }

    /// Every match in `s`, left to right, as a `/g` regex finds them.
    pub fn exec_all<'t>(&self, s: &'t str) -> Vec<Match<'t>> {
        self.0.find_iter(s).map(|m| Re::convert(s, m)).collect()
    }

    /// The byte index of the first match.
    pub fn search(&self, s: &str) -> Option<usize> {
        self.0.find(s).map(|m| m.start())
    }

    /// `s` with every match replaced by what `f` returns for it.
    pub fn replace_all(&self, s: &str, f: impl Fn(&Match) -> String) -> String {
        let mut out = String::with_capacity(s.len());
        let mut at = 0;
        for m in self.exec_all(s) {
            out.push_str(&s[at..m.index]);
            out.push_str(&f(&m));
            at = m.end;
        }
        out.push_str(&s[at..]);
        out
    }

    /// `s` cut at every match, as `String.prototype.split` does with a regex
    /// that has no capturing group.
    pub fn split<'t>(&self, s: &'t str) -> Vec<&'t str> {
        let mut parts = Vec::new();
        let mut at = 0;
        for m in self.exec_all(s) {
            if m.end == m.index && (m.index == 0 || m.index == s.len()) {
                continue;
            }
            parts.push(&s[at..m.index]);
            at = m.end;
        }
        parts.push(&s[at..]);
        parts
    }
}

#[cfg(test)]
mod tests {
    use super::Re;

    /// Each want is what `new RegExp(pattern, flags).test(input)` answers in node.
    #[test]
    fn line_terminators_are_javascripts() {
        for (pattern, flags, input, want) in [
            (r"^B", "m", "A\rB", true),
            (r"A$", "m", "A\rB", true),
            (r"^B", "m", "A\u{2028}B", true),
            (r"^B", "m", "A\nB", true),
            (r"^B", "", "A\nB", false),
            (r"A$", "", "A\n", false),
            (r"A.B", "", "A\rB", false),
            (r"A.B", "", "A\u{2029}B", false),
            (r"A.B", "s", "A\u{2029}B", true),
            (r"A[.^$]B", "m", "A.B", true),
            (r"A[.^$]B", "m", "A\rB", false),
            (r"A\.B", "", "AxB", false),
            (r"[\]^]x", "m", "^x", true),
            (
                r"^\*\*Status:\*\*\s+SHIPPED\b",
                "m",
                "# Spec\r\r**Status:** SHIPPED 2026-10-17\r",
                true,
            ),
        ] {
            assert_eq!(
                Re::new(pattern, flags).test(input),
                want,
                "/{pattern}/{flags} on {input:?}"
            );
        }
    }

    #[test]
    fn offsets_are_bytes() {
        let re = Re::new("b+", "");
        let m = re.exec("ñbb").unwrap();
        assert_eq!((m.index, m.end), (2, 4));
    }

    #[test]
    fn groups_that_took_no_part_read_empty() {
        let re = Re::new(r"(a)|(b)", "");
        let m = re.exec("b").unwrap();
        assert!(!m.has(1) && m.has(2));
        assert_eq!((m.group(1), m.group(2), m.text()), ("", "b", "b"));
    }

    #[test]
    fn lookaround() {
        let re = Re::new(r"(?<![A-Z0-9])REQ-[A-Z0-9-]+-\d{3}(?!\d)", "");
        assert!(re.test("see REQ-USER-001."));
        assert!(!re.test("XREQ-USER-001"));
        assert!(!re.test("REQ-USER-0012"));
    }

    #[test]
    fn split_and_replace_read_as_javascripts() {
        let re = Re::new(r"\r?\n", "");
        assert_eq!(re.split("a\r\nb\nc"), ["a", "b", "c"]);
        assert_eq!(Re::new("", "").split("ab"), ["a", "b"]);
        assert_eq!(re.replace_all("a\r\nb", |_| " ".into()), "a b");
    }
}

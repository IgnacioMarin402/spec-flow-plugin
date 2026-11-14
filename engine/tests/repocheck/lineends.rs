//! LineEnds holds the engine's multi-line patterns to `jsre`. The `regex`
//! crate ends a line only at \n, so under `(?m)` its `$` never matches before
//! the \r a Windows checkout puts there, and a capability spec read that way
//! has no scope marker. `jsre` reads a line as JavaScript does.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::{Report, read_rel, walk};

/// Across lines: rustfmt puts a long pattern on the line after the call.
static MULTILINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"Regex::new\(\s*r?#*"\(\?[a-zA-Z]*m"#).unwrap());

/// The engine's source, its tests and each file's test module left out: a
/// fixture may build any pattern it likes.
pub fn engine_sources(root: &Path) -> Vec<(String, String)> {
    walk(root, "engine", &[".rs"], &["engine/tests"])
        .into_iter()
        .map(|f| {
            let text = read_rel(root, &f);
            let code = text
                .split("\n#[cfg(test)]")
                .next()
                .unwrap_or_default()
                .to_string();
            (f, code)
        })
        .collect()
}

pub fn line_ends(root: &Path) -> Report {
    let mut r = Report::new("line-ends");
    let files = engine_sources(root);
    for (f, code) in &files {
        for m in MULTILINE.find_iter(code) {
            let line = code[..m.start()].matches('\n').count() + 1;
            r.problems.push(format!("{f}:{line}  a multi-line `regex` pattern: under (?m) its `$` never matches before a \\r, so a CRLF file reads as one with no line ends. Use jsre::Re::new(pattern, \"m\").\n    {}", m.as_str().split_whitespace().collect::<Vec<_>>().join(" ")));
        }
    }
    if files.is_empty() {
        r.problems.push("found no engine source under engine/: a scan that reaches nothing passes as a clean one does.".into());
    }
    r.ok = format!(
        "{} engine source file(s), every multi-line pattern read as JavaScript reads a line.",
        files.len()
    );
    r
}

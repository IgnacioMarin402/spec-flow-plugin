//! Reads an argv: which token is the binary a command runs. `argv[0]` is not
//! always an interpreter: for `["eslint", "."]` the binary is `eslint`, not `.`.

use std::sync::LazyLock;

use regex::Regex;

/// Runtimes run something else. `node <script>` runs the tests, and "node"
/// is not the name of a test runner.
pub const RUNTIMES: [&str; 11] = [
    "node", "bun", "deno", "python", "python3", "ruby", "php", "go", "cargo", "dotnet", "java",
];

pub fn is_runtime(name: &str) -> bool {
    RUNTIMES.contains(&name)
}

static DIR_PART: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^.*[\\/]").unwrap());
static JS_EXT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?js$").unwrap());

/// A token's last path segment, either separator.
pub fn basename(tok: &str) -> String {
    DIR_PART.replace(tok, "").into_owned()
}

/// The tool a shell command runs from `tokens[i]`: that token's basename, or
/// for `node [node's flags] <script>` the script's minus `.js`. `node
/// --experimental-vm-modules node_modules/jest/bin/jest.js` runs jest, the
/// form init writes.
pub fn tool_at(tokens: &[&str], i: usize) -> (usize, String) {
    let at = |k: usize| tokens.get(k).copied().unwrap_or("");
    if at(i) != "node" {
        return (i, basename(at(i)));
    }
    let mut j = i + 1;
    while at(j).starts_with('-') {
        j += 1;
    }
    (j, JS_EXT.replace(&basename(at(j)), "").into_owned())
}

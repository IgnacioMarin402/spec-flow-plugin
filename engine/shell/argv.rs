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

/// The binary an argv runs: `["node", ".bin/eslint", "--fix"]` →
/// `.bin/eslint`; `["eslint", "."]` → `eslint`.
pub fn binary_of(argv: &[String]) -> &str {
    match argv {
        [] => "",
        [first, second, ..]
            if is_runtime(first) && !second.is_empty() && !second.starts_with('-') =>
        {
            second
        }
        [first, ..] => first,
    }
}

static DRIVE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z]:[\\/]").unwrap());

/// Whether `binary` names a file that can be checked for, and whether it is
/// there. A bare command name resolves through PATH and has no file to find,
/// so a caller treating "not found" as "not installed" would disable itself
/// on such a repository for good.
pub fn resolvable_on_disk(binary: &str, root: &std::path::Path) -> (bool, bool) {
    if binary.is_empty() {
        return (false, false);
    }
    if binary.starts_with('/') || DRIVE.is_match(binary) {
        return (true, std::path::Path::new(binary).exists());
    }
    if binary.contains(['\\', '/']) {
        return (true, root.join(binary).exists());
    }
    (false, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_of_reads_past_a_runtime() {
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        assert_eq!(
            binary_of(&v(&["node", ".bin/eslint", "--fix"])),
            ".bin/eslint"
        );
        assert_eq!(binary_of(&v(&["eslint", "."])), "eslint");
        assert_eq!(binary_of(&v(&["node", "--inspect", "x.js"])), "node");
        assert_eq!(binary_of(&v(&["node"])), "node");
        assert_eq!(binary_of(&v(&[])), "");
    }

    #[test]
    fn tool_at_reads_node_scripts() {
        let t = [
            "node",
            "--experimental-vm-modules",
            "node_modules/jest/bin/jest.js",
            "x",
        ];
        assert_eq!(tool_at(&t, 0), (2, "jest".to_string()));
        assert_eq!(
            tool_at(&["npx", "C:\\x\\vitest"], 1),
            (1, "vitest".to_string())
        );
    }

    #[test]
    fn only_a_path_shaped_binary_is_checked_on_disk() {
        let root = std::env::temp_dir();
        assert_eq!(resolvable_on_disk("eslint", &root), (false, false));
        assert_eq!(
            resolvable_on_disk("node_modules/.bin/spec-flow-none", &root),
            (true, false)
        );
        assert_eq!(resolvable_on_disk("", &root), (false, false));
    }
}

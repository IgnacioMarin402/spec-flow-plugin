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

static TARGET_SHAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/*]").unwrap());

/// `.`, `./`, anything with a separator or a glob star, and an actual
/// directory. NOT every token with a dot: `--ext .ts` ends in `.ts`.
pub fn looks_like_target(token: &str, root: &std::path::Path) -> bool {
    if token.is_empty() || token.starts_with('-') {
        return false;
    }
    token == "." || token == "./" || TARGET_SHAPED.is_match(token) || root.join(token).is_dir()
}

/// An argv the engine appends file paths to, its targets dropped: `eslint .
/// <file>` lints the whole repository, which is a DISARMED scope, not a slow
/// one. A token is dropped only when the one before it is not a flag — the
/// only evidence it is a target and not a flag's value. `eslint --fix .` is
/// therefore KEPT, and returned in `remaining` for the caller to say.
pub struct Stripped {
    pub kept: Vec<String>,
    pub stripped: Vec<String>,
    pub remaining: Vec<String>,
}

pub fn strip_targets(argv: &[String], root: &std::path::Path) -> Stripped {
    let (mut kept, mut stripped) = (Vec::new(), Vec::new());
    for (i, tok) in argv.iter().enumerate() {
        let follows_flag = i > 0 && argv[i - 1].starts_with('-');
        if !follows_flag && looks_like_target(tok, root) {
            stripped.push(tok.clone());
        } else {
            kept.push(tok.clone());
        }
    }
    let remaining = kept
        .iter()
        .filter(|t| looks_like_target(t, root))
        .cloned()
        .collect();
    Stripped {
        kept,
        stripped,
        remaining,
    }
}

static SHIM_EXEC: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"exec[\t\n\x0C\r ]+(?:node|"\$basedir/node")[\t\n\x0C\r ]+(?:[^\t\n\x0C\r "]+[\t\n\x0C\r ]+)*"\$basedir/([^"]+)""#).unwrap()
});

/// `path` from `root`, with `/`.
fn rel_posix(root: &std::path::Path, path: &std::path::Path) -> String {
    path.strip_prefix(root).map_or_else(
        |_| String::new(),
        |r| r.to_string_lossy().replace('\\', "/"),
    )
}

/// Where a locally installed bin's real JavaScript lives, repo-relative with
/// `/`, or `""` when it cannot be resolved. npm writes a symlink on POSIX and
/// a `#!/bin/sh` shim on Windows, so `node node_modules/.bin/eslint` runs on
/// one and is a SyntaxError on the other; resolving past the shim is what
/// makes a committed contract agree (ADR-011).
pub fn resolve_local_bin(root: &std::path::Path, bin_name: &str) -> String {
    let shim = root.join("node_modules").join(".bin").join(bin_name);
    let Ok(meta) = std::fs::symlink_metadata(&shim) else {
        return String::new();
    };
    if meta.file_type().is_symlink() {
        // A resolved path is named from the resolved root: a root has more
        // than one spelling (a short name on Windows, a symlink elsewhere).
        let (Ok(real), Ok(real_root)) = (std::fs::canonicalize(&shim), std::fs::canonicalize(root))
        else {
            return String::new();
        };
        return rel_posix(&real_root, &real);
    }
    let Some(text) = crate::state::read_text(&shim) else {
        return String::new();
    };
    // Keyed on the interpreter, not the first path: `$basedir/node` sits on
    // the same line, and what it runs is JavaScript whatever its name.
    let Some(m) = SHIM_EXEC.captures(&text) else {
        return String::new();
    };
    let full = crate::repo::gitscope::clean(&shim.parent().unwrap_or(root).join(&m[1]));
    if !full.exists() {
        return String::new();
    }
    rel_posix(&crate::repo::gitscope::clean(root), &full)
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

    fn temp(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("spec-flow-argv-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn looks_like_target_reads_a_target() {
        let dir = temp("target");
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        for (tok, want) in [
            ("--fix", false),
            (".", true),
            ("./", true),
            ("lib/x", true),
            ("*.ts", true),
            // `--ext .ts`: a flag's VALUE, and stripping it changes what the linter checks.
            (".ts", false),
            ("lib", true), // a real directory in the repository
        ] {
            assert_eq!(looks_like_target(tok, &dir), want, "{tok}");
        }
    }

    #[test]
    fn strip_targets_keeps_what_follows_a_flag() {
        let dir = temp("strip");
        let v = |s: &[&str]| s.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let s = strip_targets(&v(&[".", "--fix"]), &dir);
        assert_eq!(
            (s.kept, s.stripped, s.remaining),
            (v(&["--fix"]), v(&["."]), v(&[]))
        );
        // Without each linter's flag grammar, "follows a flag" is the only
        // evidence a path-shaped token is a value.
        let s = strip_targets(&v(&["--ignore-path", "dist"]), &dir);
        assert_eq!(
            (s.kept, s.stripped),
            (v(&["--ignore-path", "dist"]), v(&[]))
        );
        // Guessing wrong changes what the linter checks: kept, and reported.
        let s = strip_targets(&v(&["--fix", "."]), &dir);
        assert_eq!((s.kept, s.remaining), (v(&["--fix", "."]), v(&["."])));
    }

    fn package_entry(dir: &std::path::Path, pkg: &str, entry: &str) {
        let f = dir.join("node_modules").join(pkg).join(entry);
        std::fs::create_dir_all(f.parent().unwrap()).unwrap();
        std::fs::write(f, "// entry\n").unwrap();
    }

    fn shim(dir: &std::path::Path, bin: &str, text: &str) {
        let d = dir.join("node_modules").join(".bin");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(bin), text).unwrap();
    }

    #[test]
    fn resolve_local_bin_reads_past_the_shim() {
        type Setup<'a> = &'a dyn Fn(&std::path::Path);
        let cases: [(&str, &str, &str, Setup); 6] = [
            (
                "sh shim",
                "eslint",
                "node_modules/eslint/bin/eslint.js",
                &|d| {
                    package_entry(d, "eslint", "bin/eslint.js");
                    shim(
                        d,
                        "eslint",
                        "#!/bin/sh\nbasedir=$(dirname \"$0\")\nif [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \"$basedir/../eslint/bin/eslint.js\" \"$@\"\nelse\n  exec node  \"$basedir/../eslint/bin/eslint.js\" \"$@\"\nfi\n",
                    );
                },
            ),
            (
                "$basedir/node is the interpreter",
                "vitest",
                "node_modules/vitest/dist/cli.js",
                &|d| {
                    package_entry(d, "vitest", "dist/cli.js");
                    shim(
                        d,
                        "vitest",
                        "#!/bin/sh\nexec \"$basedir/node\"  \"$basedir/../vitest/dist/cli.js\" \"$@\"\n",
                    );
                },
            ),
            ("node flags", "x", "node_modules/x/bin/x.js", &|d| {
                package_entry(d, "x", "bin/x.js");
                shim(
                    d,
                    "x",
                    "#!/bin/sh\nexec node --no-warnings --max-old-space-size=4096 \"$basedir/../x/bin/x.js\" \"$@\"\n",
                );
            }),
            ("not installed", "eslint", "", &|_| {}),
            ("no JavaScript behind it", "ruff", "", &|d| {
                shim(
                    d,
                    "ruff",
                    "#!/bin/sh\nexec \"$basedir/../ruff/ruff\" \"$@\"\n",
                )
            }),
            ("a missing file", "eslint", "", &|d| {
                shim(
                    d,
                    "eslint",
                    "#!/bin/sh\nexec node \"$basedir/../eslint/bin/eslint.js\"\n",
                )
            }),
        ];
        for (i, (name, bin, want, setup)) in cases.into_iter().enumerate() {
            let dir = temp(&format!("bin{i}"));
            setup(&dir);
            assert_eq!(resolve_local_bin(&dir, bin), want, "{name}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn resolve_local_bin_from_a_root_with_another_spelling() {
        let real = temp("real");
        let root = temp("link").join("repo");
        std::os::unix::fs::symlink(&real, &root).unwrap();
        package_entry(&root, "eslint", "bin/eslint.js");
        shim(
            &root,
            "eslint",
            "#!/bin/sh\nexec node  \"$basedir/../eslint/bin/eslint.js\" \"$@\"\n",
        );
        assert_eq!(
            resolve_local_bin(&root, "eslint"),
            "node_modules/eslint/bin/eslint.js"
        );
        package_entry(&root, "vitest", "dist/cli.js");
        std::os::unix::fs::symlink(
            "../vitest/dist/cli.js",
            root.join("node_modules/.bin/vitest"),
        )
        .unwrap();
        assert_eq!(
            resolve_local_bin(&root, "vitest"),
            "node_modules/vitest/dist/cli.js"
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

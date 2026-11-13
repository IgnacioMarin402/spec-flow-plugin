//! Which copy of this engine is running: its root, the directory that ships
//! `agents/`, `modes/` and the binary — never the consuming repository.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::repo::{gitscope, proc};

/// The engine copy that is running: the nearest directory above the binary
/// holding `.claude-plugin/plugin.json`. What it names has to be the copy
/// that RAN, whatever the consuming repository has installed.
pub fn root() -> PathBuf {
    let exe = std::env::current_exe().ok();
    if let Some(exe) = &exe {
        let real = std::fs::canonicalize(exe).unwrap_or_else(|_| exe.clone());
        for dir in real.ancestors().skip(1) {
            if dir.join(".claude-plugin").join("plugin.json").exists() {
                return dir.to_path_buf();
            }
        }
    }
    match std::env::var_os("CLAUDE_PLUGIN_ROOT") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => exe
            .and_then(|e| e.parent().map(PathBuf::from))
            .unwrap_or_default(),
    }
}

/// This engine's own CLI with `sub`, as a shell would run it: the launcher
/// that ships beside the binaries, so it is the copy that RAN.
pub fn command(sub: &str) -> String {
    let mut exe = root()
        .join("bin")
        .join("spec-flow")
        .to_string_lossy()
        .into_owned();
    if cfg!(windows) {
        exe = exe.replace('\\', "/");
    }
    if exe.contains([' ', '\t']) {
        exe = format!("\"{exe}\"");
    }
    format!("{exe} {sub}")
}

static REVISION: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{7,40}$").unwrap());

/// The commit of the copy at `root`, spelled so two builds cannot answer the
/// same (ADR-018). `v?` when none resolves: the `v` is what stops a fallback
/// being read as a short sha.
pub fn revision(root: &Path) -> String {
    // Only a checkout whose root IS this copy: git looks upward, and a copy
    // inside some other repository would report that repository's HEAD.
    let top = proc::git(root, &["rev-parse", "--show-toplevel"]);
    if top.ok() && gitscope::same_path(root, Path::new(top.stdout.trim())) {
        let res = proc::git(root, &["rev-parse", "--short=12", "HEAD"]);
        let sha = res.stdout.trim();
        if res.ok() && REVISION.is_match(sha) {
            return sha.into();
        }
    }
    // A marketplace install has no `.git`: Claude Code copies the commit into
    // a cache directory named for it, with no `version` declared (ADR-003).
    let abs = std::path::absolute(root).unwrap_or_else(|_| root.to_path_buf());
    match abs.file_name().and_then(|n| n.to_str()) {
        Some(dir) if REVISION.is_match(dir) => dir.into(),
        _ => "v?".into(),
    }
}

#[cfg(test)]
mod tests {
    //! The `engine=` field of every gate-history line (ADR-018), for the
    //! shapes a real install arrives in: a checkout of its own, a marketplace
    //! copy with no `.git` named for its commit, and a copy with no `.git`
    //! inside someone else's repository.

    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("spec-flow-rev-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn commit(dir: &Path) -> String {
        for args in [
            &["init", "-q", "."][..],
            &[
                "-c",
                "user.email=r@example.com",
                "-c",
                "user.name=r",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "a revision",
            ],
        ] {
            assert!(
                Command::new("git")
                    .arg("-C")
                    .arg(dir)
                    .args(args)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["rev-parse", "--short=12", "HEAD"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn a_checkout_of_its_own_reports_its_head() {
        let engine = temp("own");
        let head = commit(&engine);
        assert_eq!(super::revision(&engine), head);
        let _ = std::fs::remove_dir_all(&engine);
    }

    /// `plugins/cache/<marketplace>/<plugin>/<sha>/`
    #[test]
    fn a_marketplace_copy_reports_the_commit_its_directory_is_named_for() {
        let dir = temp("cache").join("spec-flow").join("1d7e03d21d4d");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(super::revision(&dir), "1d7e03d21d4d");
    }

    /// A fallback is never mistaken for a revision.
    #[test]
    fn a_copy_inside_another_repository_does_not_report_it() {
        let outer = temp("outer");
        commit(&outer);
        let engine = outer.join("engine");
        std::fs::create_dir_all(&engine).unwrap();
        assert_eq!(super::revision(&engine), "v?");
        let _ = std::fs::remove_dir_all(&outer);
    }
}

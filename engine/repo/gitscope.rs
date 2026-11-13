//! What a run is judged against: its repository root and its base. One
//! resolver for the gate and the everyday check, so "same files, same result"
//! is structural.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::repo::contract::Config;
use crate::repo::proc;

/// A refusal, and the kind a caller heads its message by: `no-repository`,
/// `not-root`, `contract`, `base`, `foreign-change` or `settings`.
#[derive(Debug)]
pub struct Refusal {
    pub kind: &'static str,
    pub msg: String,
}

/// The directory as the filesystem resolves it, `\` read as `/`, case folded
/// where the default filesystem folds it.
fn spelled(p: &Path) -> String {
    let real = std::fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
    let s = real.to_string_lossy().replace('\\', "/");
    let s = s.trim_end_matches('/').to_string();
    if cfg!(any(windows, target_os = "macos")) {
        s.to_lowercase()
    } else {
        s
    }
}

/// Whether two spellings name one directory: by identity where the
/// filesystem gives one, else by spelling.
pub fn same_path(a: &Path, b: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(ma), Ok(mb)) = (std::fs::metadata(a), std::fs::metadata(b)) {
            return ma.dev() == mb.dev() && ma.ino() == mb.ino();
        }
    }
    spelled(a) == spelled(b)
}

static NOT_A_REPO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)not a git repository").unwrap());

/// Refuses a directory inside a repository that is not its root, and one in
/// no repository at all (ADR-027): git spells every path from the root, so
/// from a subdirectory every committed change falls out of scope and lint
/// never runs. Silent when git cannot answer: "cannot tell" is never why a run
/// is refused.
pub fn assert_repo_root(root: &Path) -> Result<(), Refusal> {
    repo_root_by(root, "git")
}

fn repo_root_by(root: &Path, git: &str) -> Result<(), Refusal> {
    // Matched as text, so git's language is pinned.
    let res = proc::run_env(
        root,
        &[("LC_ALL", "C"), ("LANGUAGE", "C")],
        &[git, "rev-parse", "--show-toplevel"],
    );
    if res.unstarted {
        return Ok(());
    }
    let shown = root.display();
    if !res.ok() {
        if !NOT_A_REPO.is_match(&res.stderr) {
            return Ok(());
        }
        return Err(Refusal {
            kind: "no-repository",
            msg: format!(
                "{shown} is not inside a git repository. This engine runs against one repository, opened at its root: the contract, the specs and the run's state are that repository's, and the gate runs that repository's suite — what its pipeline runs on a push is what the gate judged. \
                 A workspace directory holding several repositories is not one of them: open Claude Code at the repository you are changing, and run `spec-flow init` there (ADR-027)."
            ),
        });
    }
    let top = res.stdout.trim();
    if top.is_empty() || same_path(root, Path::new(top)) {
        return Ok(());
    }
    Err(Refusal {
        kind: "not-root",
        msg: format!(
            "{shown} is not the root of its repository, {top}. This engine reads every path from the repository root — the contract at .spec-flow/config.json, the state under .claude/state/, and every changed-file list git returns, which git spells from the root whatever directory asks. \
             From a subdirectory every committed change falls out of scope and the linter is never invoked, while the history reads `lint=-`, exactly as a milestone that touched nothing reads. \
             Open Claude Code at {top} and keep the contract there. A package that needs its own gate and its own pipeline is its own repository (ADR-027)."
        ),
    })
}

/// What is probed when neither the contract nor origin/HEAD answers.
const BASE_CANDIDATES: [&str; 8] = [
    "origin/main",
    "main",
    "origin/master",
    "master",
    "origin/develop",
    "develop",
    "origin/trunk",
    "trunk",
];

fn merge_base(root: &Path, r#ref: &str) -> Option<String> {
    let res = proc::git(root, &["merge-base", "HEAD", r#ref]);
    res.ok().then(|| res.stdout.trim().to_string())
}

/// Declaring the base does not help: the clone holds nothing to find it in.
const SHALLOW: &str = "A shallow or single-branch clone holds no base, declared or not: fetch it first — `fetch-depth: 0` on actions/checkout; elsewhere `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`, with `--unshallow` in a shallow clone.";

/// The commit this branch is judged against. It errs rather than guesses: a
/// base that matches nothing empties the scope, and an empty scope reads as
/// "touched nothing" — a clean pass over checks never run. The contract's
/// `verify.base_ref` wins, then origin/HEAD, then the candidates.
pub fn resolve_base(root: &Path, cfg: Option<&Config>) -> Result<String, String> {
    if let Some(declared) = cfg
        .map(|c| c.verify.base_ref.as_str())
        .filter(|r| !r.is_empty())
    {
        return merge_base(root, declared).ok_or_else(|| {
            format!(
                "the contract declares verify.base_ref \"{declared}\", and git cannot resolve a merge-base between it and HEAD. \
                 Either the ref does not exist in this clone or the name is wrong. {SHALLOW} \
                 Refusing to fall back: with no base, nothing tells what this branch changed, and a check scoped to it reads \"nothing to check\" rather than \"I do not know what to check\"."
            )
        });
    }
    let head = proc::git(
        root,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    );
    let origin_head = head.stdout.trim();
    if head.ok()
        && !origin_head.is_empty()
        && let Some(base) = merge_base(root, origin_head)
    {
        return Ok(base);
    }
    BASE_CANDIDATES
        .iter()
        .find_map(|r| merge_base(root, r))
        .ok_or_else(|| {
            format!(
                "no base branch could be resolved for this repo. Tried the contract's verify.base_ref (not set), refs/remotes/origin/HEAD (absent or unresolvable), and {}. \
                 Declare the branch this work is judged against as \"base_ref\" under \"verify\" in .spec-flow/config.json — e.g. \"base_ref\": \"origin/trunk\". {SHALLOW} \
                 This is a refusal to run, not a failed milestone: with no base, nothing tells what this branch changed, and every check scoped to it would report clean without ever running.",
                BASE_CANDIDATES.join(", ")
            )
        })
}

/// The live change folders under `specflow/` that `base` already holds: no
/// run of this branch created them, and live, they keep any run here from
/// earning `done` (ADR-032).
pub fn changes_at_base(root: &Path, base: &str) -> Vec<String> {
    let dir = root.join("specflow");
    if !dir.exists() {
        return Vec::new();
    }
    // -z: names unquoted; git quotes a non-ASCII one otherwise.
    let res = proc::git(
        root,
        &[
            "ls-tree",
            "-d",
            "-z",
            "--name-only",
            &format!("{base}:specflow"),
        ],
    );
    if !res.ok() {
        return Vec::new();
    }
    let there: Vec<&str> = res.stdout.split('\0').collect();
    crate::spec::time::subdirs(&dir)
        .into_iter()
        .filter(|n| n != "archive" && there.contains(&n.as_str()))
        .collect()
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    /// A git that answers in another language unless asked for `C`, as a
    /// localised installation does: the text match in `assert_repo_root` has
    /// to survive it.
    #[test]
    fn assert_repo_root_pins_gits_language() {
        let dir = std::env::temp_dir().join(format!("spec-flow-git-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let git = bin.join("git");
        std::fs::write(
            &git,
            "#!/bin/sh\nif [ \"$LC_ALL\" = \"C\" ]; then\n  echo \"fatal: not a git repository (or any of the parent directories): .git\" >&2\nelse\n  echo \"fatal: no es un repositorio git (ni ninguno de los directorios superiores): .git\" >&2\nfi\nexit 128\n",
        )
        .unwrap();
        std::fs::set_permissions(&git, std::fs::Permissions::from_mode(0o755)).unwrap();
        // The pin has to come from the engine, not from this test's environment.
        // SAFETY: no other test reads LC_ALL.
        unsafe { std::env::remove_var("LC_ALL") };
        let got = super::repo_root_by(&dir, &git.to_string_lossy());
        let _ = std::fs::remove_dir_all(&dir);
        let err = got.expect_err("a localised git read as a repository");
        assert!(
            err.msg.contains("not inside a git repository"),
            "{}",
            err.msg
        );
    }
}

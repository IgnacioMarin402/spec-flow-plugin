//! What a run is judged against: its repository root, its base, and the
//! files the branch changed. One
//! resolver for the gate and the everyday check, so "same files, same
//! result" is structural.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};
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

/// Every change spec under `specflow/`, live, archived or nested.
const CHANGE_SPECS: &str = ":(glob)specflow/**/spec.md";

/// The change specs `base` holds, by their path from `specflow/`.
pub fn specs_at_base(root: &Path, base: &str) -> HashSet<String> {
    // `./` with --full-tree reads the path from root, which spec-trace does
    // not require to be the repository's top.
    let res = proc::git(
        root,
        &[
            "ls-tree",
            "--full-tree",
            "-r",
            "-z",
            "--name-only",
            &format!("{base}:./specflow"),
        ],
    );
    if !res.ok() {
        return HashSet::new();
    }
    res.stdout
        .split('\0')
        .filter(|p| *p == "spec.md" || p.ends_with("/spec.md"))
        .map(String::from)
        .collect()
}

/// A file as `base` holds it, by its path from root; `""` when absent.
pub fn file_at_base(root: &Path, base: &str, rel: &str) -> String {
    let res = proc::git(
        root,
        &["show", &format!("{base}:./{}", rel.replace('\\', "/"))],
    );
    if res.ok() { res.stdout } else { String::new() }
}

/// When an uncommitted change spec was written: after every commit.
pub const UNCOMMITTED: i64 = i64::MAX;

static COMMIT_ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{40,64}$").unwrap());

/// The change specs this branch wrote since `base`, by path from root, each
/// with the place of the first commit that did, oldest 0 — `UNCOMMITTED` for
/// one not committed yet (ADR-048).
pub fn branch_writes(root: &Path, base: &str) -> HashMap<String, i64> {
    let mut written = HashMap::new();
    let log = proc::git(
        root,
        &[
            "log",
            "--reverse",
            "--topo-order",
            "--no-renames",
            "--diff-filter=AM",
            "--format=%x00%H",
            "--name-only",
            "-z",
            "--relative",
            &format!("{base}..HEAD"),
            "--",
            CHANGE_SPECS,
        ],
    );
    if log.ok() {
        let (mut commit, mut previous) = (-1i64, "");
        for token in log.stdout.split('\0') {
            let path = token.strip_prefix('\n').unwrap_or(token);
            if previous.is_empty() && COMMIT_ID.is_match(token) {
                commit += 1;
            } else if !path.is_empty() && !written.contains_key(path) {
                written.insert(path.to_string(), commit);
            }
            previous = token;
        }
    }
    let diff = proc::git(
        root,
        &[
            "diff",
            "--name-only",
            "-z",
            "--relative",
            "--no-renames",
            "--diff-filter=AM",
            "HEAD",
            "--",
            CHANGE_SPECS,
        ],
    );
    if diff.ok() {
        for path in diff.stdout.split('\0').filter(|p| !p.is_empty()) {
            written.entry(path.to_string()).or_insert(UNCOMMITTED);
        }
    }
    written
}

/// The union of the branch's committed and working-tree changes, the staged
/// ones and the untracked files, minus deletions. `base` is required: a
/// default resolved here would never see `verify.base_ref`.
pub fn changed_files(root: &Path, scope_globs: &[String], base: &str) -> Vec<String> {
    let with = |args: &[&str]| {
        let mut argv: Vec<&str> = args.to_vec();
        argv.extend(scope_globs.iter().map(String::as_str));
        proc::git(root, &argv)
    };
    let lists = [
        with(&["diff", "--name-only", "--diff-filter=ACMR", base, "--"]),
        with(&[
            "diff",
            "--name-only",
            "--diff-filter=ACMR",
            "--cached",
            "--",
        ]),
        with(&["ls-files", "--others", "--exclude-standard", "--"]),
    ];
    let mut set = std::collections::BTreeSet::new();
    for res in lists.iter().filter(|r| r.ok()) {
        for f in res
            .stdout
            .split('\n')
            .map(str::trim)
            .filter(|f| !f.is_empty())
        {
            if std::fs::metadata(root.join(f)).is_ok_and(|m| m.is_file()) {
                set.insert(f.to_string());
            }
        }
    }
    set.into_iter().collect()
}

/// Whether `scope_globs` matches nothing this repository tracks: a contract
/// whose lint was never going to run, as opposed to a milestone that touched
/// nothing in scope. A git that cannot answer is false: this decides whether
/// a gate REFUSES.
pub fn scope_matches_nothing(root: &Path, scope_globs: &[String]) -> bool {
    let mut argv = vec!["ls-files", "--"];
    argv.extend(scope_globs.iter().map(String::as_str));
    let res = proc::git(root, &argv);
    res.ok() && res.stdout.trim().is_empty()
}

/// `p` with `.` and `..` resolved as text, never against the filesystem.
pub fn clean(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir
                if matches!(out.components().next_back(), Some(Component::Normal(_))) =>
            {
                out.pop();
            }
            c => out.push(c),
        }
    }
    out
}

/// `path` from `root` with `/`, or `None` when it is outside it. Absolute
/// paths are read against the root as spelled, then as the filesystem
/// resolves both: a root has more than one spelling. A relative path is
/// taken as written.
pub fn rel_to(root: &Path, path: &str) -> Option<String> {
    let p = Path::new(path);
    let rel = if p.is_absolute() {
        match p.strip_prefix(root) {
            Ok(r) => r.to_path_buf(),
            Err(_) => {
                let real_root = std::fs::canonicalize(root).ok()?;
                let real = std::fs::canonicalize(p).ok()?;
                real.strip_prefix(&real_root).ok()?.to_path_buf()
            }
        }
    } else {
        p.to_path_buf()
    };
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() || rel == "." || rel == ".." || rel.starts_with("../") {
        return None;
    }
    Some(rel)
}

/// Whether a path, absolute or from root, is one the gate's `scope_globs`
/// select — matched as git matches a pathspec, so the write-time readers and
/// the gate cannot disagree about what is in scope.
pub fn in_scope(root: &Path, path: &str, scope_globs: &[String]) -> bool {
    rel_to(root, path).is_some_and(|rel| scope_globs.iter().any(|g| pathspec(g, &rel)))
}

/// Whether git would select `path` (from the root, with `/`) by `spec`, a
/// pathspec with no magic: the path itself; else, with no wildcard, a
/// directory prefix; else a match where `*` and `?` cross `/`.
pub fn pathspec(spec: &str, path: &str) -> bool {
    if spec == path {
        return true;
    }
    if !spec.contains(['*', '?', '[', '\\']) {
        if spec.ends_with('/') {
            return path.starts_with(spec);
        }
        return path.starts_with(&format!("{spec}/"));
    }
    wildmatch(spec.as_bytes(), path.as_bytes())
}

/// fnmatch(3) without FNM_PATHNAME, as git applies a pathspec.
fn wildmatch(p: &[u8], s: &[u8]) -> bool {
    let Some(&first) = p.first() else {
        return s.is_empty();
    };
    match first {
        b'*' => (0..=s.len()).any(|i| wildmatch(&p[1..], &s[i..])),
        b'?' => !s.is_empty() && wildmatch(&p[1..], &s[1..]),
        b'[' => {
            let Some(&c) = s.first() else { return false };
            match bracket(p, c) {
                Some((matched, rest)) => matched && wildmatch(rest, &s[1..]),
                None => c == b'[' && wildmatch(&p[1..], &s[1..]),
            }
        }
        b'\\' if p.len() > 1 => s.first() == Some(&p[1]) && wildmatch(&p[2..], &s[1..]),
        _ => s.first() == Some(&first) && wildmatch(&p[1..], &s[1..]),
    }
}

/// Whether `c` is in the class `p` opens, and the pattern after it; `None`
/// when the class never closes.
fn bracket(p: &[u8], c: u8) -> Option<(bool, &[u8])> {
    let mut i = 1;
    let negate = matches!(p.get(i), Some(b'!' | b'^'));
    if negate {
        i += 1;
    }
    let (mut first, mut matched) = (true, false);
    while i < p.len() {
        if p[i] == b']' && !first {
            return Some((matched != negate, &p[i + 1..]));
        }
        first = false;
        let mut lo = p[i];
        if lo == b'\\' && i + 1 < p.len() {
            i += 1;
            lo = p[i];
        }
        let mut hi = lo;
        if i + 2 < p.len() && p[i + 1] == b'-' && p[i + 2] != b']' {
            hi = p[i + 2];
            i += 2;
        }
        if lo <= c && c <= hi {
            matched = true;
        }
        i += 1;
    }
    None
}

#[cfg(test)]
mod pathspec_tests {
    use super::pathspec;

    /// What `git ls-files -- <spec>` selects, for the specs a contract writes.
    #[test]
    fn pathspec_reads_as_git_does() {
        for (spec, path, want) in [
            ("*.ts", "lib/a/b.ts", true),
            ("lib/*.ts", "lib/a/b.ts", true),
            ("lib", "lib/a/b.ts", true),
            ("lib/", "lib/a/b.ts", true),
            ("li", "lib/a/b.ts", false),
            ("**/*.ts", "a.ts", false),
            ("**/*.ts", "lib/a.ts", true),
            ("lib/[ab].ts", "lib/b.ts", true),
            ("lib/[!ab].ts", "lib/b.ts", false),
            ("lib/?.ts", "lib/c.ts", true),
            ("lib/[a", "lib/[a", true),
        ] {
            assert_eq!(pathspec(spec, path), want, "{spec} on {path}");
        }
    }
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

//! The distribution is this repository: the plugin is a copy of a commit, and
//! a terminal or CI runs a clone's bin/spec-flow (ADR-051). A clone carries
//! what is COMMITTED and nothing else — so this runs the clone, never this
//! tree: a binary missing from HEAD, built from other source, or committed
//! without its executable bit fails here and nowhere else.

use regex::Regex;

use crate::harness::*;
use crate::helpers::*;

#[test]
fn a_clone_runs_as_it_ships() {
    let root = &SETUP.repo_root;
    if !git(root, &["status", "--porcelain", "--", "bin"]).is_empty() {
        eprintln!("skipped: bin/ has uncommitted changes: a clone would not carry them");
        return;
    }
    let tmp = temp_dir();
    let clone = tmp.join("spec-flow-plugin");
    git(
        root,
        &[
            "clone",
            "-q",
            "--no-hardlinks",
            &root.to_string_lossy(),
            &clone.to_string_lossy(),
        ],
    );
    let head = git(&clone, &["rev-parse", "--short=12", "HEAD"]);

    let repo = make_repo(RepoOpts::default());
    let shipped = |engine: &std::path::Path, args: &[&str]| {
        run(&repo, &["CLAUDE_PROJECT_DIR="], "", &launch(engine, args))
    };
    let r = shipped(&clone, &["check"]);
    assert_eq!(
        r.status,
        0,
        "the clone's spec-flow check failed:\n{}",
        r.out()
    );
    // The plugin stamps `engine=` into every gate line (ADR-018): the clone names its commit.
    must_match(
        &format!("(?m)^engine {head}$"),
        &r.out(),
        "the clone did not name its own commit",
    );
    let crashed = Regex::new(r"panicked at|RUST_BACKTRACE").unwrap();
    for sub in ["trace", "stats", "status", "resume", "models"] {
        let r = shipped(&clone, &[sub]);
        assert!(
            !(r.status != 0 && sub != "trace" || crashed.is_match(&r.out())),
            "spec-flow {sub} from the clone: exit {}\n{}",
            r.status,
            r.out()
        );
    }

    // A marketplace copy has no `.git` and is named for its commit.
    let tmp2 = temp_dir();
    let cache = tmp2.join("spec-flow").join(&head);
    copy_tree(&clone, &cache);
    std::fs::remove_dir_all(cache.join(".git")).unwrap();
    let r = shipped(&cache, &["check"]);
    assert_eq!(r.status, 0, "a copy with no .git failed:\n{}", r.out());
    must_match(
        &format!("(?m)^engine {head}$"),
        &r.out(),
        "a marketplace copy did not name the commit its directory is named for",
    );
}

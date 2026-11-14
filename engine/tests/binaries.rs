//! The binaries every session runs are the ones committed in bin/, and
//! nothing else ties them to the source beside them (ADR-051, ADR-054).

use std::path::{Path, PathBuf};
use std::process::Command;

/// Where the launcher (bin/spec-flow) picks each platform's binary.
const TARGETS: [&str; 5] = [
    "bin/linux-amd64/spec-flow",
    "bin/linux-arm64/spec-flow",
    "bin/darwin-amd64/spec-flow",
    "bin/darwin-arm64/spec-flow",
    "bin/windows-amd64/spec-flow.exe",
];

fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// Rebuilt from this source, each committed binary must be the same bytes. A
/// source change without `engine/build.sh` fails this, and so does a binary
/// edited by hand. Ignored by default, never skipped in silence: it needs zig
/// and cargo-zigbuild, and CI's rust job runs it with `--ignored`.
#[test]
#[ignore = "rebuilds every platform's binary: needs zig and cargo-zigbuild (CI runs it with --ignored)"]
fn the_binaries_are_this_source() {
    let out = std::env::temp_dir().join(format!("spec-flow-fresh-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&out);
    let status = Command::new("sh")
        .arg(root().join("engine").join("build.sh"))
        .env("OUT", &out)
        .status()
        .expect("engine/build.sh could not be run");
    assert!(status.success(), "engine/build.sh failed");
    let mut stale = Vec::new();
    for t in TARGETS {
        let committed = std::fs::read(root().join(t)).unwrap_or_default();
        let built = std::fs::read(out.join(t)).unwrap_or_else(|e| panic!("{t} was not built: {e}"));
        if committed != built {
            stale.push(t);
        }
    }
    let _ = std::fs::remove_dir_all(&out);
    assert!(
        stale.is_empty(),
        "{stale:?} are not what this source builds: run engine/build.sh and commit the result"
    );
}

/// The launcher is a script every hook runs, reviewed as text; a binary is
/// never converted or diffed. Attributes are read last line first, so an
/// order slip quietly hides the launcher's diffs.
#[test]
fn the_launcher_is_text_and_the_binaries_are_not() {
    let attr = |path: &str| {
        let out = Command::new("git")
            .arg("-C")
            .arg(root())
            .args(["check-attr", "text", "eol", "diff", "--", path])
            .output()
            .expect("git could not be run");
        assert!(out.status.success(), "not a git checkout");
        String::from_utf8_lossy(&out.stdout).into_owned()
    };
    let launcher = attr("bin/spec-flow");
    for want in ["text: set", "eol: lf", "diff: set"] {
        assert!(
            launcher.contains(want),
            "bin/spec-flow is not LF text with diffs:\n{launcher}"
        );
    }
    for t in TARGETS {
        let got = attr(t);
        assert!(
            got.contains("text: unset") && got.contains("diff: unset"),
            "{t} may be converted or diffed:\n{got}"
        );
        assert!(
            Path::new(&root().join(t)).exists(),
            "{t} is not committed: run engine/build.sh"
        );
    }
}

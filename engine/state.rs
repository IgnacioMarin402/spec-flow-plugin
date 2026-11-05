//! Where the project and its state are, and the phase. Nothing here reads the
//! contract, so a broken `.spec-flow/config.json` cannot break it.

use std::path::{Path, PathBuf};

use crate::repo::proc;

/// The repository this hook runs against, never the engine's own location:
/// installed, the two are different directories.
pub fn project_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_PROJECT_DIR") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => std::env::current_dir().unwrap_or_default(),
    }
}

/// Creates nothing: most hooks read the phase and stand down, and a hook that
/// stands down leaves nothing on disk.
pub fn phase_path(root: &Path) -> PathBuf {
    root.join(".claude").join("state").join("phase")
}

/// The phases that ARM something. Every other value — `idle`, `done`, empty,
/// unknown — arms no hook.
pub const RUN_PHASES: [&str; 5] = ["spec", "plan", "review", "implement", "blocked"];

pub fn is_run_phase(phase: &str) -> bool {
    RUN_PHASES.contains(&phase)
}

/// Any git failure reads as "not tracked", which arms: a git that could not
/// be asked must never be why a hook stands down.
fn phase_is_tracked(root: &Path) -> bool {
    proc::git(
        root,
        &["ls-files", "--error-unmatch", "--", ".claude/state/phase"],
    )
    .ok()
}

/// The phase a run put this repository in, `""` otherwise. A phase git tracks
/// is content, not state: a clone that ships one would arm the gate on
/// arrival (ADR-017). Fails CLOSED: a git that cannot answer leaves the phase
/// honoured.
pub fn read_phase(root: &Path) -> String {
    let phase = read_file_or_default(&phase_path(root), "");
    if is_run_phase(&phase) && phase_is_tracked(root) {
        return String::new();
    }
    phase
}

/// JavaScript's `String.prototype.trim`: whitespace and the BOM.
pub fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// The file's text, trimmed, or `fallback` when it cannot be read.
pub fn read_file_or_default(path: &Path, fallback: &str) -> String {
    match std::fs::read(path) {
        Ok(b) => trim(&String::from_utf8_lossy(&b)).to_string(),
        Err(_) => fallback.to_string(),
    }
}

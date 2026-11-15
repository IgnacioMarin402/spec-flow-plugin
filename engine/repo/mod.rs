//! The repository a run is judged in, and the engine copy that judges it.

pub mod canrun;
pub mod contract;
pub mod engine;
pub mod gitscope;
pub mod proc;
pub mod unscoped;

use std::path::{Path, PathBuf};

/// `p` as the filesystem resolves it, in the spelling every other program
/// reads. On Windows `canonicalize` answers in the verbatim form
/// (`\\?\C:\...`), which git, node and Git Bash refuse, and which an
/// instruction the engine prints would hand on to the model unrunnable.
pub fn real_path(p: &Path) -> std::io::Result<PathBuf> {
    std::fs::canonicalize(p).map(|r| PathBuf::from(plain(&r.to_string_lossy())))
}

/// A verbatim path in its ordinary spelling: `\\?\C:\x` is `C:\x`, and
/// `\\?\UNC\server\share` is `\\server\share`. Anything else as written.
fn plain(s: &str) -> String {
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    match s.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => rest.to_string(),
        _ => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_verbatim_path_reads_in_its_ordinary_spelling() {
        for (verbatim, want) in [
            (r"\\?\C:\Users\a", r"C:\Users\a"),
            (r"\\?\UNC\srv\share\x", r"\\srv\share\x"),
            (r"\\?\Volume{abc}\x", r"\\?\Volume{abc}\x"),
            (r"C:\Users\a", r"C:\Users\a"),
            ("/home/a", "/home/a"),
        ] {
            assert_eq!(super::plain(verbatim), want);
        }
    }
}

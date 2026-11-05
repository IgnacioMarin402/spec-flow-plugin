//! Which copy of this engine is running: its root, the directory that ships
//! `agents/`, `modes/` and the binary — never the consuming repository.

use std::path::PathBuf;

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

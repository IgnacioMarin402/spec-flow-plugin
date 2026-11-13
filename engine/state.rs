//! Where the project and its state are, and the phase. Nothing here reads the
//! contract, so a broken `.spec-flow/config.json` cannot break it.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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

/// `.claude/state/`, CREATED. Call it only once the hook knows it will write,
/// or every repository the user opens gets one.
pub fn state_dir(root: &Path) -> PathBuf {
    let dir = root.join(".claude").join("state");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Where the session driving the phase is recorded. Creates nothing.
pub fn phase_owner_path(root: &Path) -> PathBuf {
    root.join(".claude").join("state").join("phase.session")
}

/// Drops the seal.
pub fn release_phase(root: &Path) {
    let _ = std::fs::remove_file(phase_owner_path(root));
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

/// Whether the repository COMMITTED anything under `.claude/state/`: then
/// nothing is appended there outside a run (ADR-040).
pub fn state_is_tracked(root: &Path) -> bool {
    proc::git(
        root,
        &["ls-files", "--error-unmatch", "--", ".claude/state"],
    )
    .ok()
}

/// `read_phase` narrowed to a phase THIS session owns. Only the hooks certain
/// to fire in the sealing session call it — the gate and token-trace on Stop,
/// the budget on a spawn (ADR-017). Fails closed: no seal or no session id
/// leaves the phase honoured.
pub fn read_owned_phase(root: &Path, session_id: &str) -> String {
    let phase = read_phase(root);
    if !is_run_phase(&phase) {
        return phase;
    }
    let owner = read_file_or_default(&phase_owner_path(root), "");
    if !owner.is_empty() && !session_id.is_empty() && owner != session_id {
        return String::new();
    }
    phase
}

/// Records this session as the one driving the phase. No session id claims
/// nothing: an empty seal already reads as unowned.
pub fn claim_phase(root: &Path, session_id: &str) {
    if session_id.is_empty() {
        return;
    }
    state_dir(root);
    write_file(&phase_owner_path(root), session_id);
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

/// The file's text, or `None` when it cannot be read.
pub fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// Best-effort, like every hook's own state.
pub fn write_file(path: &Path, content: &str) {
    let _ = std::fs::write(path, content);
}

/// Appends `line` and a newline. Logging must never be why a hook fails.
pub fn append_line(path: &Path, line: &str) {
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .append(true)
        .create(true)
        .open(path)
    {
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

/// Appends `line` unless the file already holds it.
pub fn append_unique(path: &Path, line: &str) {
    if !read_lines_deduped(path).contains(line) {
        append_line(path, line);
    }
}

/// The file's non-empty lines.
pub fn read_lines_deduped(path: &Path) -> HashSet<String> {
    read_text(path)
        .map(|t| {
            t.split('\n')
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect()
        })
        .unwrap_or_default()
}

/// A timestamp as every log here writes one: UTC, milliseconds.
pub fn iso(t: SystemTime) -> String {
    let d = t.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let (days, rem) = ((secs / 86400) as i64, secs % 86400);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3600,
        rem / 60 % 60,
        rem % 60,
        d.subsec_millis()
    )
}

/// `iso` of now.
pub fn now_iso() -> String {
    iso(SystemTime::now())
}

/// How long ago `path` was last written; zero for a time in the future.
pub fn age(path: &Path) -> Option<std::time::Duration> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    Some(
        SystemTime::now()
            .duration_since(modified)
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn iso_is_javascripts_to_iso_string() {
        for (ms, want) in [
            (0, "1970-01-01T00:00:00.000Z"),
            (951_782_400_123, "2000-02-29T00:00:00.123Z"),
            (1_794_614_400_999, "2026-11-14T00:00:00.999Z"),
            (4_107_542_399_000, "2100-02-28T23:59:59.000Z"),
        ] {
            assert_eq!(super::iso(UNIX_EPOCH + Duration::from_millis(ms)), want);
        }
    }
}

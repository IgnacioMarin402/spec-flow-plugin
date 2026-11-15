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

/// An RFC 3339 timestamp — `Z` or an offset, a fraction of any length or
/// none — as milliseconds since the epoch, the fraction kept.
pub fn parse_rfc3339(s: &str) -> Option<f64> {
    let (date, clock) = s.split_once('T')?;
    let (clock, offset_min) = if let Some(c) = clock.strip_suffix('Z') {
        (c, 0)
    } else {
        let at = clock.rfind(['+', '-'])?;
        let (c, off) = clock.split_at(at);
        let (sign, hm) = off.split_at(1);
        let (h, m) = hm.split_once(':')?;
        if h.len() != 2 || m.len() != 2 {
            return None;
        }
        let mins = h.parse::<i64>().ok()? * 60 + m.parse::<i64>().ok()?;
        (c, if sign == "-" { -mins } else { mins })
    };
    let mut d = date
        .splitn(3, '-')
        .map(|p| (p.len(), p.parse::<i64>().ok()));
    let (y, mo, da) = match (d.next()?, d.next()?, d.next()?) {
        ((4, Some(y)), (2, Some(mo)), (2, Some(da))) => (y, mo, da),
        _ => return None,
    };
    let (hms, frac) = clock
        .split_once('.')
        .map_or((clock, None), |(a, b)| (a, Some(b)));
    let mut t = hms.splitn(3, ':').map(|p| (p.len(), p.parse::<i64>().ok()));
    let (h, mi, se) = match (t.next()?, t.next()?, t.next()?) {
        ((2, Some(h)), (2, Some(mi)), (2, Some(se))) => (h, mi, se),
        _ => return None,
    };
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&mo)
        || da < 1
        || da > month_days[(mo - 1) as usize]
        || h > 23
        || mi > 59
        || se > 59
    {
        return None;
    }
    let frac_ms = match frac {
        None => 0.0,
        Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
            format!("0.{f}").parse::<f64>().ok()? * 1000.0
        }
        Some(_) => return None,
    };
    // Howard Hinnant's days_from_civil.
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * ((mo + 9) % 12) + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86400 + h * 3600 + mi * 60 + se - offset_min * 60;
    Some(secs as f64 * 1000.0 + frac_ms)
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
            assert_eq!(super::parse_rfc3339(want), Some(ms as f64), "{want}");
        }
    }

    #[test]
    fn rfc3339_reads_what_go_reads() {
        assert_eq!(
            super::parse_rfc3339("2026-11-13T10:00:00Z"),
            Some(1_794_564_000_000.0)
        );
        assert_eq!(
            super::parse_rfc3339("2026-11-13T11:00:00+01:00"),
            Some(1_794_564_000_000.0)
        );
        assert_eq!(
            super::parse_rfc3339("2026-11-13T10:00:00.0005Z"),
            Some(1_794_564_000_000.5)
        );
        for bad in [
            "not a time",
            "2026-02-30T10:00:00Z",
            "2026-11-13T10:00:60Z",
            "2026-11-13T10:00:00.Z",
            "2026-11-13",
        ] {
            assert_eq!(super::parse_rfc3339(bad), None, "{bad}");
        }
    }
}

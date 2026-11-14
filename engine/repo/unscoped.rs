//! The checks that run on every gate whatever changed, and again when a run
//! tries to declare itself done: spec-trace, engine core and always first,
//! then the contract's `extra_checks`.

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

use crate::repo::contract::{self, Check, Config};
use crate::repo::proc;
use crate::spec::trace;

/// One check's outcome.
pub struct Outcome {
    pub check: Check,
    pub rc: i32,
    pub out: String,
}

/// Every check's outcome.
pub struct Results {
    pub checks: Vec<Outcome>,
    pub all_pass: bool,
}

static PATH_SHAPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\\/.]").unwrap());
static NODE_MODULES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(^|[\\/])node_modules[\\/]").unwrap());

/// Every check, run against `root`. A repository's own check whose script it
/// has not written yet means "no such check yet", not a blocked run — but
/// only a path-SHAPED argv[1] earns that grace: `node -e <code>` and `npx
/// tsc` have no file to be missing, and reading them as absent made them
/// green for good.
pub fn run(root: &Path, cfg: &Config) -> Results {
    // The engine defect the gate's tests inject, in a build with the
    // `gatecrash` feature only: the binary that ships has no way to throw
    // here, and only a throw reaches the gate's fail-closed handler.
    #[cfg(feature = "gatecrash")]
    if !root.as_os_str().is_empty() {
        panic!("simulated engine defect");
    }
    let mut out = Results {
        checks: Vec::new(),
        all_pass: true,
    };
    for check in cfg.checklist() {
        let (rc, text) = if check.name == contract::spec_trace_check().name && check.cmd.is_empty()
        {
            // Compiled into this binary: it cannot be missing the way a
            // repository's script can.
            let (mut so, mut se) = (Vec::new(), Vec::new());
            let rc = trace::run(root, false, &mut so, &mut se);
            so.extend(se);
            (rc, String::from_utf8_lossy(&so).trim().to_string())
        } else {
            run_declared(root, &check.cmd)
        };
        if rc != 0 {
            out.all_pass = false;
        }
        out.checks.push(Outcome {
            check,
            rc,
            out: text,
        });
    }
    out
}

fn run_declared(root: &Path, cmd: &[String]) -> (i32, String) {
    let mut argv: Vec<String> = cmd.to_vec();
    let looks_like_path =
        argv.len() >= 2 && !argv[1].starts_with('-') && PATH_SHAPED.is_match(&argv[1]);
    if looks_like_path && !argv[1].starts_with('/') && !argv[1].contains(':') {
        argv[1] = root.join(&argv[1]).to_string_lossy().into_owned();
    }
    if !looks_like_path || Path::new(&argv[1]).exists() {
        let args: Vec<&str> = argv.iter().map(String::as_str).collect();
        let res = proc::run(root, &args);
        if res.unstarted {
            return (1, res.stderr.trim().to_string());
        }
        // Killed, or no status at all: never a pass.
        let rc = res.status.filter(|s| *s >= 0).unwrap_or(1);
        return (
            rc,
            format!("{}{}", res.stdout, res.stderr).trim().to_string(),
        );
    }
    if NODE_MODULES.is_match(&cmd[1]) {
        // A package's entrypoint is installed, never written by the
        // repository: missing, it is an install not run.
        return (
            1,
            format!(
                "({} not present — a dependency under node_modules/ is not installed: install the repo's dependencies, then re-run)",
                argv[1]
            ),
        );
    }
    (0, format!("({} not present)", argv[1]))
}

/// `spec=0 domain=0`, the shape gate-history.log has always had.
pub fn hist_fields(r: &Results) -> String {
    r.checks
        .iter()
        .map(|c| format!("{}={}", c.check.field, c.rc))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The same keys with `-`, for an invocation that ran none.
pub fn hist_dashes(cfg: &Config) -> String {
    cfg.checklist()
        .iter()
        .map(|c| format!("{}=-", c.field))
        .collect::<Vec<_>>()
        .join(" ")
}

/// `spec-trace rc=0, other-check rc=0`, for the block messages.
pub fn summary(r: &Results) -> String {
    r.checks
        .iter()
        .map(|c| format!("{} rc={}", c.check.name, c.rc))
        .collect::<Vec<_>>()
        .join(", ")
}

/// The hints of the checks that failed.
pub fn failed_hints(r: &Results) -> String {
    r.checks
        .iter()
        .filter(|c| c.rc != 0 && !c.check.hint.is_empty())
        .map(|c| format!("{}: {}", c.check.name, c.check.hint))
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::run_declared;

    fn rc_of(cmd: &[&str]) -> i32 {
        let dir = std::env::temp_dir().join(format!("spec-flow-unscoped-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let cmd: Vec<String> = cmd.iter().map(|s| s.to_string()).collect();
        run_declared(&dir, &cmd).0
    }

    /// The shape init writes for a local bin: read green, a check whose tool
    /// was never installed reports that it passed.
    #[test]
    fn a_missing_package_entrypoint_fails() {
        assert_ne!(
            rc_of(&["node", "node_modules/typescript/bin/tsc", "--noEmit"]),
            0
        );
    }

    /// A repo mid-adoption declares a check before writing it.
    #[test]
    fn a_repository_script_not_written_yet_is_skipped() {
        assert_eq!(rc_of(&["node", "scripts/pending-check.mjs"]), 0);
    }

    /// A program that cannot start is no pass.
    #[test]
    fn a_program_that_does_not_exist_fails() {
        assert_eq!(rc_of(&["spec-flow-no-such-program-anywhere"]), 1);
    }
}

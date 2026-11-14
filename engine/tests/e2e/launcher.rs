//! On a platform this engine ships no binary for, the launcher answers every
//! hook with an error notice; the gate is the one a run cannot lose, so an
//! armed one refuses the stop rather than letting it pass unjudged.

use std::path::Path;

use serde_json::json;

use crate::harness::*;
use crate::helpers::*;

/// A PATH whose `uname` answers as `system` on `machine`.
fn fake_uname(system: &str, machine: &str) -> (Dir, String) {
    let fake = temp_dir();
    let uname = fake.join("uname");
    write_mode(
        &uname,
        format!("#!/bin/sh\ncase $1 in -s) echo {system} ;; -m) echo {machine} ;; esac\n")
            .as_bytes(),
        0o755,
    );
    let path = std::env::join_paths(std::iter::once(fake.to_path_buf()).chain(
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()),
    ))
    .unwrap();
    let path = format!("PATH={}", path.to_string_lossy());
    (fake, path)
}

#[cfg(unix)]
#[test]
fn the_launcher_fails_an_armed_gate_closed_where_no_binary_ships() {
    let (_fake, path) = fake_uname("FreeBSD", "amd64");
    let env = |repo: &Path| {
        vec![
            path.clone(),
            format!("CLAUDE_PROJECT_DIR={}", repo.display()),
        ]
    };
    let launcher = SETUP.repo_root.join("bin/spec-flow");
    let launcher = launcher.to_string_lossy();
    let stop = |active: bool| {
        json!({"hook_event_name": "Stop", "session_id": "s", "stop_hook_active": active})
            .to_string()
    };

    let repo = repo_in("implement");
    let r = run(
        &repo,
        &env(&repo),
        &stop(false),
        &[&*launcher, "hook", "gate"],
    );
    assert!(
        r.blocked(),
        "an armed gate let the stop through on a platform with no binary (exit {}):\n{}",
        r.status,
        r.out()
    );
    must_match(
        "treat NOTHING as verified",
        &r.reason(),
        "the refusal does not say nothing was judged",
    );
    // Once per stop: refused again, the session would never end.
    let r = run(
        &repo,
        &env(&repo),
        &stop(true),
        &[&*launcher, "hook", "gate"],
    );
    assert!(
        !r.blocked(),
        "the stop was refused again while the session continued for the first refusal"
    );
    let idle = repo_in("idle");
    for h in ["gate", "phase-guard"] {
        let r = run(&idle, &env(&idle), &stop(false), &[&*launcher, "hook", h]);
        assert!(
            !r.blocked() && r.status == 1,
            "hook {h} with no run armed: exit {}, blocked {}; want the notice alone (exit 1)",
            r.status,
            r.blocked()
        );
        must_match(
            "ships no binary for FreeBSD amd64",
            &r.stderr,
            "the notice does not name the platform",
        );
    }
}

/// Every hook runs the launcher in a shell, Git Bash on Windows: there it
/// picks the Windows binary from bin/windows-amd64/, as it picks every other one.
#[cfg(unix)]
#[test]
fn the_launcher_picks_the_windows_binary_under_git_bash() {
    let (_fake, path) = fake_uname("MINGW64_NT-10.0-26100", "x86_64");
    let engine = temp_dir();
    let stand = engine.join("bin/windows-amd64/spec-flow.exe");
    write(&stand, "");
    write_mode(
        &engine.join("bin/spec-flow"),
        &std::fs::read(SETUP.repo_root.join("bin/spec-flow")).unwrap(),
        0o755,
    );
    write_mode(&stand, b"#!/bin/sh\necho \"windows binary: $*\"\n", 0o755);
    let launcher = engine.join("bin/spec-flow");
    let r = run(
        &std::env::temp_dir(),
        &[path],
        "",
        &[&*launcher.to_string_lossy(), "hook", "gate"],
    );
    assert!(
        r.status == 0 && r.stdout == "windows binary: hook gate\n",
        "Git Bash did not reach bin/windows-amd64/spec-flow.exe (exit {}):\n{}",
        r.status,
        r.out()
    );
}

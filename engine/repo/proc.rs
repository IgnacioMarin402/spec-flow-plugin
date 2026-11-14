//! Runs a program without a shell and hands back what it said. No shell, on
//! any platform: the gate appends changed paths to `verify.lint`, and a shell
//! would re-read each one (ADR-011).

use std::path::Path;
use std::process::Command;

/// A finished program. `status` is `None` when the program never ran or was
/// killed: no exit status exists, and no caller may read one as a pass.
pub struct Output {
    pub status: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    /// The program could not be started at all.
    pub unstarted: bool,
}

impl Output {
    /// A zero exit.
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }
}

/// Runs `argv[0]` with `argv[1..]` in `dir`, stdin empty, `env` set over this
/// process's environment.
pub fn run_env(dir: &Path, env: &[(&str, &str)], argv: &[&str]) -> Output {
    let Some((program, args)) = argv.split_first() else {
        return Output {
            status: None,
            stdout: String::new(),
            stderr: String::new(),
            unstarted: true,
        };
    };
    let mut cmd = Command::new(program);
    cmd.args(args).current_dir(dir).envs(env.iter().copied());
    match cmd.output() {
        Ok(out) => Output {
            status: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            unstarted: false,
        },
        Err(e) => Output {
            status: None,
            stdout: String::new(),
            stderr: e.to_string(),
            unstarted: true,
        },
    }
}

/// Runs `argv[0]` with `argv[1..]` in `dir`, stdin empty.
pub fn run(dir: &Path, argv: &[&str]) -> Output {
    run_env(dir, &[], argv)
}

/// Runs git in `dir`.
pub fn git(dir: &Path, args: &[&str]) -> Output {
    let mut argv = vec!["git"];
    argv.extend_from_slice(args);
    run(dir, &argv)
}

/// Runs `argv` in `dir` with this process's own streams, and returns its exit
/// status: 1 when it could not run or was killed.
pub fn inherit(dir: &Path, argv: &[&str]) -> i32 {
    let Some((program, args)) = argv.split_first() else {
        return 1;
    };
    match Command::new(program).args(args).current_dir(dir).status() {
        Ok(s) => s.code().filter(|c| *c >= 0).unwrap_or(1),
        Err(_) => 1,
    }
}

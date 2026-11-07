//! Runs a program without a shell and hands back what it said. No shell, on
//! any platform: the gate appends changed paths to `verify.lint`, and a shell
//! would re-read each one (ADR-011).

use std::path::Path;
use std::process::Command;

/// A finished program. `status` is `None` when the program never ran or was
/// killed: no exit status exists, and no caller may read one as a pass.
pub struct Output {
    pub status: Option<i32>,
    #[allow(dead_code)]
    pub stdout: String,
    #[allow(dead_code)]
    pub stderr: String,
}

impl Output {
    /// A zero exit.
    pub fn ok(&self) -> bool {
        self.status == Some(0)
    }
}

/// Runs `argv[0]` with `argv[1..]` in `dir`, stdin empty.
pub fn run(dir: &Path, argv: &[&str]) -> Output {
    let Some((program, args)) = argv.split_first() else {
        return Output {
            status: None,
            stdout: String::new(),
            stderr: String::new(),
        };
    };
    match Command::new(program).args(args).current_dir(dir).output() {
        Ok(out) => Output {
            status: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        },
        Err(e) => Output {
            status: None,
            stdout: String::new(),
            stderr: e.to_string(),
        },
    }
}

/// Runs git in `dir`.
pub fn git(dir: &Path, args: &[&str]) -> Output {
    let mut argv = vec!["git"];
    argv.extend_from_slice(args);
    run(dir, &argv)
}

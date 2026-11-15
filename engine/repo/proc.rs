//! Runs a program without a shell and hands back what it said. No shell, on
//! any platform: the gate appends changed paths to `verify.lint`, and a shell
//! would re-read each one (ADR-011).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
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
    let mut cmd = Command::new(program_path(program));
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
    match Command::new(program_path(program))
        .args(args)
        .current_dir(dir)
        .status()
    {
        Ok(s) => s.code().filter(|c| *c >= 0).unwrap_or(1),
        Err(_) => 1,
    }
}

/// What to spawn for `program`. On Windows a bare name is looked up on `PATH`
/// with each `PATHEXT` extension, so `npx` finds `npx.cmd`: the standard
/// library appends `.exe` alone, and a contract naming a package manager's
/// shim would not start. Elsewhere, the name as written.
fn program_path(program: &str) -> OsString {
    if cfg!(windows)
        && let Some(found) = look_path(
            program,
            std::env::var_os("PATH")
                .map(|p| std::env::split_paths(&p).collect())
                .unwrap_or_default(),
            &std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into()),
        )
    {
        return found.into_os_string();
    }
    program.into()
}

/// The first `dir/program.EXT` that is a file, directory by directory and
/// extension by extension in `pathext`'s order. A name with a separator or an
/// extension of its own is not looked up: it says what it is.
fn look_path(program: &str, dirs: Vec<PathBuf>, pathext: &str) -> Option<PathBuf> {
    if program.contains(['/', '\\']) || Path::new(program).extension().is_some() {
        return None;
    }
    let exts: Vec<&str> = pathext
        .split(';')
        .filter(|e| e.starts_with('.') && e.len() > 1)
        .collect();
    dirs.iter().find_map(|d| {
        exts.iter()
            .map(|e| d.join(format!("{program}{}", e.to_ascii_lowercase())))
            .find(|p| p.is_file())
    })
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    #[test]
    fn a_bare_name_is_found_with_each_pathext_extension_in_order() {
        let root = std::env::temp_dir().join(format!("spec-flow-lookpath-{}", std::process::id()));
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(a.join("npx.cmd"), "").unwrap();
        std::fs::write(b.join("npx.exe"), "").unwrap();
        std::fs::write(b.join("tool.bat"), "").unwrap();
        std::fs::write(b.join("tool.exe"), "").unwrap();
        let dirs = || vec![root.join("none"), a.clone(), b.clone()];
        let pathext = ".COM;.EXE;.BAT;.CMD";
        let find = |p: &str| super::look_path(p, dirs(), pathext);
        // The first directory that has one wins, whatever its extension.
        assert_eq!(find("npx"), Some(a.join("npx.cmd")));
        // Within a directory, PATHEXT's order.
        assert_eq!(find("tool"), Some(b.join("tool.exe")));
        assert_eq!(find("missing"), None);
        // A name that says what it is is spawned as written.
        assert_eq!(find("npx.cmd"), None);
        assert_eq!(find("bin/npx"), None);
        assert_eq!(super::look_path("npx", dirs(), ""), None::<PathBuf>);
        let _ = std::fs::remove_dir_all(&root);
    }
}

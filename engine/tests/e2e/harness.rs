//! Drives the engine the way Claude Code, a terminal and CI do: a built
//! binary, a hook payload on stdin, a throwaway repository on disk. A case
//! never calls the engine's functions: it would test a function, not the
//! hook a session runs (ADR-055).
//!
//! Every case runs the binary this checkout COMMITS for the platform it is
//! on, bin/<os>-<arch>/: what a session runs is what is tested, and a
//! freshness test holds those bytes to the source (ADR-054).
//! SPEC_FLOW_BINARY=<a built engine binary> runs every case against that one
//! instead, launcher and plugin files unchanged: how a change is tested
//! before bin/ is rebuilt. SPEC_FLOW_CRASH_BINARY is a binary built to crash
//! in the gate's checks, for the cases that hold its fail-closed handler;
//! unset, cargo builds one.

use std::io::Write;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, SystemTime};

use serde_json::Value;

pub struct Setup {
    /// This checkout.
    pub repo_root: PathBuf,
    /// The engine every case runs, installed apart from any repository.
    pub engine_dir: PathBuf,
    /// The stand-in for a repository's own commands.
    pub tool: PathBuf,
    /// Where every throwaway directory of this run lives.
    pub scratch: PathBuf,
}

pub static SETUP: LazyLock<Setup> = LazyLock::new(|| setup().unwrap_or_else(|e| panic!("{e}")));

pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// The `<os>-<arch>` the launcher picks here.
pub fn platform() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => other,
    };
    format!("{os}-{arch}")
}

fn setup() -> Result<Setup, String> {
    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let scratch = std::env::temp_dir().join(format!("spec-flow-e2e-{}", std::process::id()));
    sweep(&scratch);
    std::fs::create_dir_all(&scratch).map_err(|e| e.to_string())?;
    let tool = scratch.join(exe("tool"));
    let out = Command::new(std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into()))
        .args(["--edition", "2024", "-O", "-o"])
        .arg(&tool)
        .arg(repo_root.join("engine/tests/e2e/tool/main.rs"))
        .output()
        .map_err(|e| format!("building the test tool: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "building the test tool: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let engine_dir = scratch.join("engine");
    for d in ["agents", "modes", ".claude-plugin", "commands", "skills"] {
        copy_tree(&repo_root.join(d), &engine_dir.join(d));
    }
    let launcher = engine_dir.join("bin/spec-flow");
    std::fs::create_dir_all(launcher.parent().unwrap()).unwrap();
    if let Ok(b) = std::fs::read(repo_root.join("bin/spec-flow")) {
        write_mode(&launcher, &b, 0o755);
    }
    let bin = std::env::var_os("SPEC_FLOW_BINARY")
        .filter(|b| !b.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| binary(&repo_root));
    let b = std::fs::read(&bin).map_err(|e| format!("the engine binary {}: {e}", bin.display()))?;
    std::fs::create_dir_all(binary(&engine_dir).parent().unwrap()).unwrap();
    write_mode(&binary(&engine_dir), &b, 0o755);
    Ok(Setup {
        repo_root,
        engine_dir,
        tool,
        scratch,
    })
}

/// Removes what earlier runs left: the suite has no hook that runs after its
/// last case.
fn sweep(mine: &Path) {
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for e in entries.filter_map(Result::ok) {
        let p = e.path();
        let stale = e
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|m| m.elapsed().unwrap_or_default() > Duration::from_secs(3600));
        if p != mine
            && e.file_name()
                .to_string_lossy()
                .starts_with("spec-flow-e2e-")
            && stale
        {
            let _ = std::fs::remove_dir_all(p);
        }
    }
}

pub fn write_mode(path: &Path, bytes: &[u8], mode: u32) {
    std::fs::write(path, bytes).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    let _ = mode;
}

pub fn copy_tree(from: &Path, to: &Path) {
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    std::fs::create_dir_all(to).unwrap();
    for e in entries.filter_map(Result::ok) {
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_tree(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), &target).unwrap();
        }
    }
}

/// A throwaway directory, removed when dropped.
pub struct Dir(PathBuf);

impl Deref for Dir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Dir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A new, empty throwaway directory.
pub fn temp_dir() -> Dir {
    static N: AtomicUsize = AtomicUsize::new(0);
    let p = SETUP
        .scratch
        .join(format!("t{}", N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&p).unwrap();
    // The canonical spelling: a path the engine prints is compared with it.
    Dir(std::fs::canonicalize(&p).unwrap_or(p))
}

pub fn engine_dir() -> &'static Path {
    &SETUP.engine_dir
}

/// A throwaway copy of the engine, for a case that breaks one.
pub fn copy_engine() -> Dir {
    let dir = temp_dir();
    for d in ["agents", "modes", ".claude-plugin", "bin"] {
        copy_tree(&engine_dir().join(d), &dir.join(d));
    }
    dir
}

/// A finished hook or command.
#[derive(Debug, Clone)]
pub struct Output {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
}

impl Output {
    /// Everything it said.
    pub fn out(&self) -> String {
        format!("{}{}", self.stdout, self.stderr)
    }

    /// Whether a Stop or SubagentStop hook rendered a block.
    pub fn blocked(&self) -> bool {
        serde_json::from_str::<Value>(&self.stdout).is_ok_and(|v| v["decision"] == "block")
    }

    /// A block's reason, or a notice's message.
    pub fn reason(&self) -> String {
        let v: Value = serde_json::from_str(&self.stdout).unwrap_or(Value::Null);
        format!(
            "{}{}",
            v["reason"].as_str().unwrap_or(""),
            v["systemMessage"].as_str().unwrap_or("")
        )
    }
}

/// `argv` in dir, with env (`K=V`) added and stdin given.
pub fn run<S: AsRef<str>>(
    dir: &Path,
    env: &[S],
    stdin: &str,
    argv: &[impl AsRef<std::ffi::OsStr>],
) -> Output {
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..])
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for kv in env {
        let (k, v) = kv.as_ref().split_once('=').unwrap_or((kv.as_ref(), ""));
        cmd.env(k, v);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Output {
                status: -1,
                stdout: String::new(),
                stderr: e.to_string(),
            };
        }
    };
    let mut pipe = child.stdin.take().unwrap();
    let input = stdin.as_bytes().to_vec();
    let feeder = std::thread::spawn(move || {
        let _ = pipe.write_all(&input);
    });
    let out = child.wait_with_output().unwrap();
    let _ = feeder.join();
    Output {
        status: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

/// Where an engine keeps the binary the launcher picks here.
pub fn binary(engine: &Path) -> PathBuf {
    engine.join("bin").join(platform()).join(exe("spec-flow"))
}

/// `<engine>/bin/spec-flow <args>` as a shell runs it: the launcher, through
/// Git Bash on Windows (ADR-052).
pub fn launch(engine: &Path, args: &[&str]) -> Vec<String> {
    let launcher = engine.join("bin").join("spec-flow");
    let mut argv = if cfg!(windows) {
        vec![
            git_bash().to_string_lossy().into_owned(),
            launcher.to_string_lossy().replace('\\', "/"),
        ]
    } else {
        vec![launcher.to_string_lossy().into_owned()]
    };
    argv.extend(args.iter().map(|a| a.to_string()));
    argv
}

/// The bash.exe Git for Windows ships beside git.
pub fn git_bash() -> PathBuf {
    let out = Command::new("git")
        .arg("--exec-path")
        .output()
        .expect("no git to find Git Bash beside");
    let exec = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let mut dir = PathBuf::from(&exec);
    while let Some(parent) = dir.parent().map(Path::to_path_buf) {
        let bash = dir.join("bin").join("bash.exe");
        if bash.exists() {
            return bash;
        }
        dir = parent;
    }
    panic!("no Git Bash above {exec}")
}

/// How engine runs hook name.
pub fn hook_argv(engine: &Path, name: &str) -> Vec<String> {
    vec![
        binary(engine).to_string_lossy().into_owned(),
        "hook".into(),
        name.into(),
    ]
}

/// How engine runs `spec-flow <args>`.
pub fn cli_argv(engine: &Path, args: &[&str]) -> Vec<String> {
    let mut v = vec![binary(engine).to_string_lossy().into_owned()];
    v.extend(args.iter().map(|a| a.to_string()));
    v
}

/// A hook's stdin: JSON, or text sent as it is.
pub trait Payload {
    fn text(&self) -> String;
}

impl Payload for Value {
    fn text(&self) -> String {
        self.to_string()
    }
}

impl Payload for &str {
    fn text(&self) -> String {
        self.to_string()
    }
}

impl Payload for String {
    fn text(&self) -> String {
        self.clone()
    }
}

/// Runs a hook against a repo with a payload on stdin, from a directory that
/// is not the repository: Claude Code's working directory is its own.
#[derive(Default)]
pub struct Hook {
    pub engine: Option<PathBuf>,
    pub env: Vec<String>,
}

impl Hook {
    pub fn run(&self, name: &str, payload: impl Payload, repo: &Path) -> Output {
        let engine = self.engine.as_deref().unwrap_or(engine_dir());
        let mut env = vec![format!("CLAUDE_PROJECT_DIR={}", repo.display())];
        env.extend(self.env.iter().cloned());
        run(
            &std::env::temp_dir(),
            &env,
            &payload.text(),
            &hook_argv(engine, name),
        )
    }
}

pub fn run_hook(name: &str, payload: impl Payload, repo: &Path) -> Output {
    Hook::default().run(name, payload, repo)
}

/// `spec-flow <args>` in dir, as a terminal would.
pub fn cli(dir: &Path, env: &[&str], args: &[&str]) -> Output {
    let mut all = vec!["CLAUDE_PROJECT_DIR="];
    all.extend(env);
    run(dir, &all, "", &cli_argv(engine_dir(), args))
}

const GIT_ENV: [&str; 4] = [
    "GIT_AUTHOR_NAME=fixture",
    "GIT_AUTHOR_EMAIL=f@example.com",
    "GIT_COMMITTER_NAME=fixture",
    "GIT_COMMITTER_EMAIL=f@example.com",
];

fn git_argv(args: &[&str]) -> Vec<String> {
    std::iter::once("git")
        .chain(args.iter().copied())
        .map(String::from)
        .collect()
}

/// git in dir, failing the case when it fails.
#[track_caller]
pub fn git(dir: &Path, args: &[&str]) -> String {
    let r = run(dir, &GIT_ENV, "", &git_argv(args));
    assert_eq!(r.status, 0, "git {}: {}", args.join(" "), r.out());
    r.stdout.trim().to_string()
}

pub fn git_quiet(dir: &Path, args: &[&str]) {
    run(dir, &GIT_ENV, "", &git_argv(args));
}

pub fn write(path: impl AsRef<Path>, content: &str) {
    let path = path.as_ref();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

pub fn append_to(path: impl AsRef<Path>, content: &str) {
    let path = path.as_ref();
    let _ = std::fs::create_dir_all(path.parent().unwrap());
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    f.write_all(content.as_bytes()).unwrap();
}

pub fn read(path: impl AsRef<Path>) -> String {
    std::fs::read(path)
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

pub fn exists(path: impl AsRef<Path>) -> bool {
    path.as_ref().exists()
}

/// Sets path's modification time to `ago` before now.
pub fn age(path: impl AsRef<Path>, ago: Duration) {
    let f = std::fs::File::options().write(true).open(path).unwrap();
    f.set_modified(SystemTime::now() - ago).unwrap();
}

/// The stand-in command doing ops, as a contract's argv.
pub fn tool_cmd(ops: &[&str]) -> Vec<String> {
    std::iter::once(SETUP.tool.to_string_lossy().into_owned())
        .chain(ops.iter().map(|s| s.to_string()))
        .collect()
}

/// A contract argv as JSON.
pub fn tool_json(ops: &[&str]) -> Value {
    Value::from(tool_cmd(ops))
}

/// `t` as `2006-01-02T15:04:05.000Z`, in UTC.
pub fn iso_ms(t: SystemTime) -> String {
    let d = t.duration_since(SystemTime::UNIX_EPOCH).unwrap();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil from days, Howard Hinnant's algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

//! The checks this repository runs on itself: claims its prose and its code
//! make about each other, which no compiler and no fixture of the engine's
//! behaviour would notice going stale. Each takes the root of a tree, so a
//! fixture can hand it one built to fail. A cargo test since ADR-055.

mod agentcontracts;
mod decisions;
mod evals;
mod fixtures;
mod lineends;
mod modelpins;
mod norepo;
mod pluginpaths;
mod transitions;

use std::path::{Path, PathBuf};

/// One check's verdict: problems, or what it read when there are none.
pub struct Report {
    pub name: &'static str,
    pub problems: Vec<String>,
    pub ok: String,
    pub advice: &'static str,
}

impl Report {
    pub fn new(name: &'static str) -> Report {
        Report {
            name,
            problems: Vec::new(),
            ok: String::new(),
            advice: "",
        }
    }
}

impl std::fmt::Display for Report {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        if self.problems.is_empty() {
            return write!(f, "{}: OK — {}", self.name, self.ok);
        }
        writeln!(f, "{}: {} problem(s).\n", self.name, self.problems.len())?;
        for p in &self.problems {
            writeln!(f, "  - {p}")?;
        }
        if !self.advice.is_empty() {
            writeln!(f, "\n{}", self.advice)?;
        }
        Ok(())
    }
}

/// Every file under root/dir whose name ends in one of `exts`, as a slash
/// path from root, sorted; `skip` names directories not to enter.
pub fn walk(root: &Path, dir: &str, exts: &[&str], skip: &[&str]) -> Vec<String> {
    fn visit(root: &Path, at: &Path, exts: &[&str], skip: &[&str], found: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(at) else {
            return;
        };
        for e in entries.filter_map(Result::ok) {
            let p = e.path();
            let rel = slash(root, &p);
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if !skip.contains(&rel.as_str()) {
                    visit(root, &p, exts, skip, found);
                }
            } else if exts
                .iter()
                .any(|x| e.file_name().to_string_lossy().ends_with(x))
            {
                found.push(rel);
            }
        }
    }
    let mut found = Vec::new();
    visit(root, &root.join(dir), exts, skip, &mut found);
    found.sort();
    found
}

/// Every file a scan claims: the extensions under `dirs`, and the files named
/// outright that exist, never `self_path`.
pub fn surfaces(
    root: &Path,
    dirs: &[&str],
    exts: &[&str],
    files: &[&str],
    self_path: &str,
    skip: &[&str],
) -> Vec<String> {
    let mut all: Vec<String> = dirs
        .iter()
        .flat_map(|d| walk(root, d, exts, skip))
        .collect();
    all.extend(
        files
            .iter()
            .filter(|f| root.join(f).is_file())
            .map(|f| f.to_string()),
    );
    all.retain(|f| f != self_path);
    all
}

pub fn slash(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

pub fn read_rel(root: &Path, rel: &str) -> String {
    std::fs::read(root.join(rel))
        .map(|b| String::from_utf8_lossy(&b).into_owned())
        .unwrap_or_default()
}

pub fn exists(root: &Path, rel: &str) -> bool {
    root.join(rel).exists()
}

/// The .md files directly in root/dir, sorted.
pub fn md_in(root: &Path, dir: &str) -> Vec<String> {
    let mut out: Vec<String> = std::fs::read_dir(root.join(dir))
        .map(|es| {
            es.filter_map(|e| {
                let e = e.ok()?;
                (!e.file_type().ok()?.is_dir()).then_some(())?;
                e.file_name()
                    .into_string()
                    .ok()
                    .filter(|n| n.ends_with(".md"))
            })
            .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// A throwaway tree of files, removed when dropped.
pub struct Tree(pub PathBuf);

impl Tree {
    pub fn new<'a>(files: impl IntoIterator<Item = (&'a str, &'a str)>) -> Tree {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let root =
            std::env::temp_dir().join(format!("spec-flow-repocheck-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        for (rel, text) in files {
            let p = root.join(rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        Tree(root)
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// This repository's root.
pub fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

/// The checks, run on this repository.
#[test]
fn the_repository() {
    let root = repo();
    let checks: [fn(&Path) -> Report; 7] = [
        norepo::no_repo_refs,
        modelpins::model_pins,
        decisions::decisions,
        transitions::transitions,
        agentcontracts::agent_contracts,
        pluginpaths::plugin_paths,
        lineends::line_ends,
    ];
    let mut failed = Vec::new();
    for check in checks {
        let r = check(&root);
        println!("{r}");
        if !r.problems.is_empty() {
            failed.push(r.to_string());
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

//! Stands in for a consuming repository's linter, test runner or check in
//! the engine's own tests: one binary on every platform, so no test needs a
//! shell or an interpreter to play the repository's part.
//!
//!     tool out=TEXT err=TEXT write=PATH=TEXT append=PATH=TEXT cat=PATH args argsto=PATH failargs sleep=MS exit=N
//!
//! Each operation runs in order; `args` prints the arguments after `--`, one
//! per line; `exit=N` ends with N. Built by the suite with rustc alone: it
//! has no dependencies, and is no part of the engine.

use std::io::Write;

fn main() {
    let all: Vec<String> = std::env::args().skip(1).collect();
    let (ops, rest) = match all.iter().position(|a| a == "--") {
        Some(i) => (&all[..i], &all[i + 1..]),
        None => (&all[..], &[][..]),
    };
    for a in ops {
        let (op, val) = a.split_once('=').unwrap_or((a.as_str(), ""));
        match op {
            "out" => println!("{val}"),
            "err" => eprintln!("{val}"),
            "write" | "append" => {
                let (path, text) = val.split_once('=').unwrap_or((val, ""));
                if let Some(cut) = path.rfind(['/', '\\']) {
                    let _ = std::fs::create_dir_all(&path[..=cut]);
                }
                let mut opts = std::fs::OpenOptions::new();
                opts.create(true).write(true);
                if op == "append" {
                    opts.append(true);
                } else {
                    opts.truncate(true);
                }
                match opts.open(path) {
                    Ok(mut f) => {
                        let _ = f.write_all(text.replace("\\n", "\n").as_bytes());
                    }
                    Err(e) => {
                        eprintln!("{e}");
                        std::process::exit(70);
                    }
                }
            }
            "cat" => {
                let _ = std::io::stdout().write_all(&std::fs::read(val).unwrap_or_default());
            }
            "args" => rest.iter().for_each(|r| println!("{r}")),
            "argsto" => {
                let _ = std::fs::write(val, rest.join(","));
            }
            "failargs" if !rest.is_empty() => std::process::exit(1),
            "sleep" => std::thread::sleep(std::time::Duration::from_millis(val.parse().unwrap_or(0))),
            "exit" => {
                let _ = std::io::stdout().flush();
                std::process::exit(val.parse().unwrap_or(0));
            }
            _ => {}
        }
    }
}

//! `spec-flow` is the whole engine: every hook (`spec-flow hook <name>`) and
//! every command a terminal, CI or the orchestrator runs.

mod hooks;
mod payload;
mod repo;
mod shell;
mod state;

use std::process::exit;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("hook") => {
            let Some(name) = args.get(1) else { usage() };
            let Some(hook) = hooks::find(name) else {
                eprintln!("spec-flow: no hook named {name:?}");
                exit(1);
            };
            exit(hooks::run(hook));
        }
        _ => usage(),
    }
}

fn usage() -> ! {
    eprintln!("spec-flow: usage: spec-flow <hook <name>> [args...]");
    exit(1);
}

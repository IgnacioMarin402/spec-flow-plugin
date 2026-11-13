//! `spec-flow` is the whole engine: every hook (`spec-flow hook <name>`) and
//! every command a terminal, CI or the orchestrator runs.

mod agents;
mod cli;
mod hooks;
mod humanturn;
mod jsre;
mod payload;
mod repo;
mod shell;
mod spec;
mod state;
mod tracelines;

use std::process::exit;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("hook") => {
            let Some(name) = args.get(1) else { usage() };
            let Some((main, on_error)) = hooks::find(name) else {
                eprintln!("spec-flow: no hook named {name:?}");
                exit(1);
            };
            exit(hooks::run(main, on_error));
        }
        Some(name) => match cli::COMMANDS.iter().find(|(n, _)| *n == name) {
            Some((_, command)) => exit(command(&args[1..])),
            None => usage(),
        },
        None => usage(),
    }
}

fn usage() -> ! {
    let mut names: Vec<&str> = cli::COMMANDS.iter().map(|(n, _)| *n).collect();
    names.push("hook <name>");
    eprintln!(
        "spec-flow: usage: spec-flow <{}> [args...]",
        names.join("|")
    );
    exit(1);
}

//! The live view carries its own copy of the readers the hooks use (a mod
//! runs no binary's code). hooks/readers.golden.ts holds the answers: the
//! engine's readers are held to it by a cargo test, hooks/live-view.test.tsx
//! holds the TypeScript ones, and this holds `spec-flow lines`, which the
//! view runs on a log one read cannot take, through the binary.

use serde_json::Value;

use crate::harness::*;

#[test]
fn lines_agrees_with_the_live_view() {
    let text = read(SETUP.repo_root.join("hooks/readers.golden.ts"));
    let at = text
        .find("export default ")
        .expect("hooks/readers.golden.ts holds no `export default` table");
    let g: Value = serde_json::from_str(&text[at + "export default ".len()..])
        .expect("hooks/readers.golden.ts");
    let cases = g["linesOf"]
        .as_array()
        .filter(|c| !c.is_empty())
        .expect("the golden table holds no linesOf case");
    let mut wrong = Vec::new();
    for c in cases {
        let dir = temp_dir();
        let path = dir.join("run-trace.log");
        write(&path, c["text"].as_str().unwrap());
        let since = c["since"]
            .as_f64()
            .map_or("-Infinity".to_string(), |f| f.to_string());
        let needle = c["needle"].as_str().unwrap();
        let r = run(
            &SETUP.repo_root,
            &[] as &[&str],
            "",
            &cli_argv(
                engine_dir(),
                &["lines", &path.to_string_lossy(), &since, needle],
            ),
        );
        let mut want = vec![c["want"]["n"].as_i64().unwrap().to_string()];
        want.extend(
            c["want"]["last"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| l.as_str().unwrap().to_string()),
        );
        let want = want.join("\n");
        if r.status != 0 || r.stdout != want {
            wrong.push(format!(
                "spec-flow lines since {since} needle {needle:?} = {:?} (exit {}), want {want:?}",
                r.stdout, r.status
            ));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

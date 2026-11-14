//! A Windows checkout hands every file CRLF. The engine's patterns read a
//! line as JavaScript does: `$` before a \r, `.` never across one.

use crate::helpers::*;
use crate::stats::{ORDERS_SPEC, Snapshot, StatsRun, change_files, read_in, stats_report};

fn crlf(s: &str) -> String {
    s.replace('\n', "\r\n")
}

#[test]
fn a_capability_spec_written_with_crlf_is_read_as_with_lf() {
    let (r, _dir) = trace_repo(files! {"specs/user.md" => crlf(&user_spec())}, &[]);
    passes(&r, "a CRLF spec read as missing its scope marker");
    must_match("1 requirement", &r.out(), "the requirement was not read");
}

#[test]
fn stats_reads_the_scope_of_a_crlf_spec() {
    let mut files = files! {"specs/orders.md" => crlf(ORDERS_SPEC)};
    files.extend(
        change_files("specflow/archive/ship-orders")
            .into_iter()
            .map(|(k, v)| (k, crlf(&v))),
    );
    let r = stats_report(StatsRun {
        files,
        archived: vec![Snapshot {
            slug: "ship-orders",
            trace: vec![
                read_in(1, "plan", "lib/orders/place.ts"),
                read_in(2, "plan", "lib/billing/tax.ts"),
            ],
            ..Default::default()
        }],
        ..Default::default()
    });
    want_all(
        &r.out(),
        &["ship-orders: scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))"],
    );
}

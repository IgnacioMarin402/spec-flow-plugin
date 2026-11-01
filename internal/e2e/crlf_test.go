package e2e

// A Windows checkout hands every file CRLF. The engine's patterns read a line
// as JavaScript does: `$` before a \r, `.` never across one.

import (
	"strings"
	"testing"
)

func crlf(s string) string { return strings.ReplaceAll(s, "\n", "\r\n") }

func TestACapabilitySpecWrittenWithCRLFIsReadAsWithLF(t *testing.T) {
	t.Parallel()
	r, _ := traceRepo(t, map[string]string{"specs/user.md": crlf(userSpec)})
	passes(t, r, "a CRLF spec read as missing its scope marker")
	mustMatch(t, `1 requirement`, r.Out(), "the requirement was not read")
}

func TestStatsReadsTheScopeOfACRLFSpec(t *testing.T) {
	t.Parallel()
	files := map[string]string{"specs/orders.md": crlf(ordersSpec)}
	for k, v := range changeFiles("specflow/archive/ship-orders") {
		files[k] = crlf(v)
	}
	r := statsReport(t, statsRun{files: files, archived: []snapshot{{slug: "ship-orders", trace: []string{readIn(1, "plan", "lib/orders/place.ts"), readIn(2, "plan", "lib/billing/tax.ts")}}}})
	wantAll(t, r.Out(), "ship-orders: scope lib/orders, tests (from specs/orders.md, 2 milestone path(s))")
}

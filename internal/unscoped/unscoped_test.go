package unscoped

import (
	"testing"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
)

func rcOf(t *testing.T, cmd ...string) int {
	t.Helper()
	cfg := &contract.Config{ExtraChecks: []contract.Check{{Name: "x", Field: "x", Cmd: cmd}}}
	for _, c := range Run(t.TempDir(), cfg).Checks {
		if c.Name == "x" {
			return c.RC
		}
	}
	t.Fatal("the check did not run")
	return 0
}

// The shape init writes for a local bin: read green, a check whose tool was
// never installed reports that it passed.
func TestAMissingPackageEntrypointFails(t *testing.T) {
	if rcOf(t, "node", "node_modules/typescript/bin/tsc", "--noEmit") == 0 {
		t.Fatal("a check whose tool was never installed passed")
	}
}

// A repo mid-adoption declares a check before writing it.
func TestARepositoryScriptNotWrittenYetIsSkipped(t *testing.T) {
	if rc := rcOf(t, "node", "scripts/pending-check.mjs"); rc != 0 {
		t.Fatalf("a repository's own pending script blocked it: rc=%d", rc)
	}
}

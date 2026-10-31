package repocheck

import "testing"

// The checks, run on this repository.
func TestRepository(t *testing.T) {
	for _, check := range []func(string) Report{NoRepoRefs, ModelPins, Decisions, Transitions, AgentContracts, PluginPaths} {
		r := check("../..")
		t.Run(r.Name, func(t *testing.T) {
			if len(r.Problems) > 0 {
				t.Fatal(r)
			}
			t.Log(r)
		})
	}
}

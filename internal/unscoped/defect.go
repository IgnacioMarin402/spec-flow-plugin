//go:build !gatecrash

package unscoped

// simulatedDefect is the engine defect the gate's tests inject, under the
// `gatecrash` build tag only: the binary that ships has no way to throw here.
func simulatedDefect() {}

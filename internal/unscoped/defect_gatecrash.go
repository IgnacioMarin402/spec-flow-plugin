//go:build gatecrash

package unscoped

// simulatedDefect stands in for a defect nothing static could catch: the
// gate's fail-closed handler is load-bearing, and only a throw reaches it.
func simulatedDefect() { panic("simulated engine defect") }

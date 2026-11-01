// Package unscoped runs the checks that run on every gate whatever changed,
// and again when a run tries to declare itself done: spec-trace, engine core
// and always first, then the contract's `extra_checks`.
package unscoped

import (
	"bytes"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/spectrace"
)

// Result is one check's outcome.
type Result struct {
	contract.Check
	RC  int
	Out string
}

// Results are every check's outcome.
type Results struct {
	Checks  []Result
	AllPass bool
}

var (
	pathShaped  = regexp.MustCompile(`[\\/.]`)
	nodeModules = regexp.MustCompile(`(^|[\\/])node_modules[\\/]`)
)

// Run runs every check against root. A repository's own check whose script it
// has not written yet means "no such check yet", not a blocked run — but only
// a path-SHAPED argv[1] earns that grace: `node -e <code>` and `npx tsc` have
// no file to be missing, and reading them as absent made them green for good.
func Run(root string, cfg *contract.Config) Results {
	simulatedDefect()
	var out Results
	out.AllPass = true
	for _, check := range cfg.Checklist() {
		r := Result{Check: check}
		if check.Name == contract.SpecTraceCheck.Name && len(check.Cmd) == 0 {
			// Compiled into this binary: it cannot be missing the way a
			// repository's script can.
			var so, se bytes.Buffer
			r.RC = spectrace.Run(root, false, &so, &se)
			r.Out = strings.TrimSpace(so.String() + se.String())
		} else {
			argv := append([]string(nil), check.Cmd...)
			looksLikePath := len(argv) >= 2 && !strings.HasPrefix(argv[1], "-") && pathShaped.MatchString(argv[1])
			if looksLikePath && !strings.HasPrefix(argv[1], "/") && !strings.Contains(argv[1], ":") {
				argv[1] = filepath.Join(root, argv[1])
			}
			switch {
			case !looksLikePath || hookio.Exists(argv[1]):
				res := proc.Run(proc.Options{Dir: root}, argv...)
				r.Out, r.RC = strings.TrimSpace(res.Out()), res.Status
				if res.Status != 0 && res.Err != nil {
					r.RC, r.Out = 1, strings.TrimSpace(res.Err.Error())
				}
				if r.RC < 0 {
					r.RC = 1
				}
			case nodeModules.MatchString(check.Cmd[1]):
				// A package's entrypoint is installed, never written by the
				// repository: missing, it is an install not run.
				r.Out, r.RC = fmt.Sprintf("(%s not present — a dependency under node_modules/ is not installed: install the repo's dependencies, then re-run)", argv[1]), 1
			default:
				r.Out, r.RC = fmt.Sprintf("(%s not present)", argv[1]), 0
			}
		}
		if r.RC != 0 {
			out.AllPass = false
		}
		out.Checks = append(out.Checks, r)
	}
	return out
}

// HistFields: `spec=0 domain=0`, the shape gate-history.log has always had.
func HistFields(r Results) string {
	parts := make([]string, len(r.Checks))
	for i, c := range r.Checks {
		parts[i] = fmt.Sprintf("%s=%d", c.Field, c.RC)
	}
	return strings.Join(parts, " ")
}

// HistDashes are the same keys with `-`, for an invocation that ran none.
func HistDashes(cfg *contract.Config) string {
	var parts []string
	for _, c := range cfg.Checklist() {
		parts = append(parts, c.Field+"=-")
	}
	return strings.Join(parts, " ")
}

// Summary: `spec-trace rc=0, other-check rc=0`, for the block messages.
func Summary(r Results) string {
	parts := make([]string, len(r.Checks))
	for i, c := range r.Checks {
		parts[i] = fmt.Sprintf("%s rc=%d", c.Name, c.RC)
	}
	return strings.Join(parts, ", ")
}

// FailedHints are the hints of the checks that failed.
func FailedHints(r Results) string {
	var parts []string
	for _, c := range r.Checks {
		if c.RC != 0 && c.Hint != "" {
			parts = append(parts, c.Name+": "+c.Hint)
		}
	}
	return strings.Join(parts, " ")
}

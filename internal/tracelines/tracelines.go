// Package tracelines reads the `k=v` logs in `.claude/state/` back, in ONE
// copy: stats and status both report what a run cost, and two summaries of
// the same lines that disagree are worse than one that is wrong. The writers
// — run-trace, token-trace and the gate's history line — append
// space-separated `k=v` pairs after an ISO timestamp.
package tracelines

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
)

// Entry is one parsed line: its fields, its timestamp and the line itself.
type Entry struct {
	At     *time.Time
	Raw    string
	Fields map[string]string
}

// Get is a field's value and whether the line has it.
func (e Entry) Get(k string) (string, bool) { v, ok := e.Fields[k]; return v, ok }

// F is a field's value, `""` when absent.
func (e Entry) F(k string) string { return e.Fields[k] }

var (
	pair  = regexp.MustCompile(`(\w[\w-]*)=(\S+)`)
	stamp = regexp.MustCompile(`^(\S+Z)`)
)

// Parse reads a line's pairs, values as far as the next SPACE — which is why
// every writer strips whitespace out of a value.
func Parse(line string) Entry {
	e := Entry{Raw: line, Fields: map[string]string{}}
	for _, m := range pair.FindAllStringSubmatch(line, -1) {
		e.Fields[m[1]] = m[2]
	}
	if m := stamp.FindStringSubmatch(line); m != nil {
		if t, err := time.Parse(time.RFC3339Nano, m[1]); err == nil {
			e.At = &t
		}
	}
	return e
}

// RoleOf is the role an `agent type=` line names, the `spec-flow:` dropped.
func RoleOf(typ string) string {
	if r := agents.MatchAgent([]string{typ}, agents.Roles()); r != "" {
		return r
	}
	return typ
}

// TokenFields are the counters token-trace writes, in the order reported.
var TokenFields = []string{"in", "out", "cache_read", "cache_write", "think"}

// ToFixed is Number.prototype.toFixed.
func ToFixed(v float64, digits int) string {
	p := math.Pow(10, float64(digits))
	return strconv.FormatFloat(math.Round(v*p)/p, 'f', digits, 64)
}

// JSNum prints a number as JavaScript does.
func JSNum(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// Human is a big count at a glance, exact below a thousand.
func Human(v float64) string {
	switch {
	case v >= 1e6:
		return ToFixed(v/1e6, 1) + "M"
	case v >= 1e3:
		return JSNum(math.Round(v/1e3)) + "k"
	}
	return JSNum(v)
}

// AtLeast prints a count token-trace documents as a floor — `out`, `think`.
func AtLeast(v float64) string { return "≥" + Human(v) }

// Row is one model and chain's totals.
type Row struct {
	Model, Chain string
	Msgs         float64
	N            map[string]float64
	ThinkUnknown bool
}

func numOf(s string) float64 {
	f, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
	if err != nil || math.IsNaN(f) {
		return 0
	}
	return f
}

// SummarizeTokens is one row per model and chain, output-heaviest first. An
// advisor's line is a chain of its own. `sidechain` arrives as the STRING
// "true": the boolean was flattened on the way into the log.
func SummarizeTokens(entries []Entry) []Row {
	var order []string
	rows := map[string]*Row{}
	for _, e := range entries {
		model := e.F("model")
		if _, ok := e.Get("msgs"); model == "" || !ok {
			continue
		}
		chain := "main"
		if e.F("advisor") == "true" {
			chain = "advisor"
		} else if e.F("sidechain") == "true" {
			chain = "subagent"
		}
		key := model + "|" + chain
		r, ok := rows[key]
		if !ok {
			r = &Row{Model: model, Chain: chain, N: map[string]float64{}}
			rows[key] = r
			order = append(order, key)
		}
		r.Msgs += numOf(e.F("msgs"))
		for _, f := range TokenFields {
			r.N[f] += numOf(e.F(f))
		}
		if _, ok := e.Get("think"); !ok {
			r.ThinkUnknown = true
		}
	}
	out := make([]Row, 0, len(order))
	for _, k := range order {
		out = append(out, *rows[k])
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].N["out"] > out[j].N["out"] })
	return out
}

// PadEnd is String.prototype.padEnd, counting UTF-16 units as JavaScript does.
func PadEnd(s string, width int) string {
	n := 0
	for _, r := range s {
		n++
		if r > 0xFFFF {
			n++
		}
	}
	if n >= width {
		return s
	}
	return s + strings.Repeat(" ", width-n)
}

// TokenRow is one row, padded so a stack of them lines up.
func TokenRow(r Row, width int) string {
	think := "?"
	if !r.ThinkUnknown {
		think = AtLeast(r.N["think"])
	}
	return fmt.Sprintf("%s  %s  in %s  out %s  cache_read %s  think %s  (%s msg)", PadEnd(r.Model, width), PadEnd(r.Chain, 8), Human(r.N["in"]), AtLeast(r.N["out"]), Human(r.N["cache_read"]), think, JSNum(r.Msgs))
}

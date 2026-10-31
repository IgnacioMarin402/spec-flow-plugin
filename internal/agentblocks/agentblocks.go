// Package agentblocks reads the fenced return blocks an agent contract
// declares, and the return an agent hands back. Every line break is `\r?\n`:
// git hands a Windows checkout CRLF, and an anchor spelled `\n` finds nothing
// there — which reads as a moved anchor, not as a line ending.
package agentblocks

import (
	"regexp"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
)

var (
	blockRe = regexp.MustCompile("(?s)```\\r?\\n(STATUS:.*?)```")
	keyRe   = regexp.MustCompile(`^([A-Z][A-Z_]+):`)
	lineRe  = regexp.MustCompile(`\r?\n`)
)

// ReturnBlocks are the field names declared across every fenced block that
// opens with `STATUS:`, in declaration order. blocks lets a caller tell "this
// agent declares none" from "the anchor stopped matching".
func ReturnBlocks(text string) (blocks int, fields []string) {
	seen := map[string]bool{}
	for _, m := range blockRe.FindAllStringSubmatch(text, -1) {
		blocks++
		for _, line := range lineRe.Split(m[1], -1) {
			if k := keyRe.FindStringSubmatch(line); k != nil && !seen[k[1]] {
				seen[k[1]] = true
				fields = append(fields, k[1])
			}
		}
	}
	return blocks, fields
}

// UnroutedFields are the fields no command names, as whole field names:
// `QUESTIONS` is not named by `OPEN_QUESTIONS`.
func UnroutedFields(fields []string, commandsText string, exempt map[string]string) []string {
	var out []string
	for _, f := range fields {
		if _, ok := exempt[f]; ok {
			continue
		}
		if !jsre.MustCompile(`(?<![A-Za-z0-9_])`+f+`(?![A-Za-z0-9_])`, "").Test(commandsText) {
			out = append(out, f)
		}
	}
	return out
}

// MaxBlocks per agent before the agent gate lets its return through as it
// is. The live view shows a send-back against the same number.
const MaxBlocks = 2

// MaxOpenQuestions one NEEDS_INPUT round may ask; the spec-writer's contract
// states the same number (ADR-030).
const MaxOpenQuestions = 3

var statusDecl = regexp.MustCompile("```\\r?\\nSTATUS:[ \\t]*([A-Z_]+)")

// DeclaredStatuses are the `STATUS:` lines of a contract's return blocks.
func DeclaredStatuses(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range statusDecl.FindAllStringSubmatch(text, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// Return is the return block in an agent's reply.
type Return struct {
	Status string
	Fields map[string]string
	Order  []string // the fields in the order the reply wrote them
}

var (
	statusLine = regexp.MustCompile(`(?m)^[ \t>#*]*STATUS:[ \t*]*([A-Z_]+)`)
	fenceLine  = regexp.MustCompile("^\\s*```")
	kvLine     = regexp.MustCompile(`^[ \t>*]*([A-Z][A-Z_]+):[ \t*]*(.*)$`)
)

// ParseReturn: the first LINE opening with `STATUS:` wins — emphasis, a
// heading mark or a quote mark allowed; a status named mid-sentence is prose.
// A repeated key keeps its first value. run-trace and the agent gate both read
// it here.
func ParseReturn(text string) *Return {
	loc := statusLine.FindStringSubmatchIndex(text)
	if loc == nil {
		return nil
	}
	r := &Return{Status: text[loc[2]:loc[3]], Fields: map[string]string{}}
	lines := lineRe.Split(text[loc[0]:], -1)
	for _, line := range lines[1:] {
		if fenceLine.MatchString(line) {
			break
		}
		if kv := kvLine.FindStringSubmatch(strings.TrimSuffix(line, "\r")); kv != nil {
			if _, ok := r.Fields[kv[1]]; !ok {
				r.Fields[kv[1]] = strings.TrimSpace(kv[2])
				r.Order = append(r.Order, kv[1])
			}
		}
	}
	return r
}

var (
	openQ      = regexp.MustCompile(`^[ \t>*]*OPEN_QUESTIONS:`)
	nextField  = regexp.MustCompile(`^[ \t>*]*[A-Z][A-Z_]+:`)
	itemRe     = regexp.MustCompile(`^(\s*)([-*+]|\d+[.)])\s+\S`)
	startSpace = regexp.MustCompile(`^\s`)
	digit      = regexp.MustCompile(`\d`)
)

// OpenQuestions counts the top-level items under `OPEN_QUESTIONS:`. Options
// nested under a question are part of it. The list ends at a blank line, a
// flush non-item, a fence or the next field, so questions split by blank lines
// undercount — letting a round through rather than sending a good one back.
func OpenQuestions(text string) int {
	lines := lineRe.Split(text, -1)
	at := -1
	for i, l := range lines {
		if openQ.MatchString(l) {
			at = i
			break
		}
	}
	if at == -1 {
		return 0
	}
	type item struct {
		indent   int
		numbered bool
	}
	var items []item
	for _, line := range lines[at+1:] {
		if fenceLine.MatchString(line) || nextField.MatchString(line) {
			break
		}
		if strings.TrimSpace(line) == "" {
			if len(items) > 0 {
				break
			}
			continue
		}
		if m := itemRe.FindStringSubmatch(line); m != nil {
			items = append(items, item{len(m[1]), digit.MatchString(m[2])})
		} else if len(items) > 0 && !startSpace.MatchString(line) {
			break
		}
	}
	if len(items) == 0 {
		return 0
	}
	top := items[0].indent
	for _, it := range items {
		if it.indent < top {
			top = it.indent
		}
	}
	all, numbered := 0, 0
	for _, it := range items {
		if it.indent == top {
			all++
			if it.numbered {
				numbered++
			}
		}
	}
	if numbered > 0 {
		return numbered
	}
	return all
}

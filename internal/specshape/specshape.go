// Package specshape is the grammar of a change spec: what spec-trace, and
// every later reader of a spec, agrees a delta, a kind and an id are. One
// copy: a second would be a second opinion about what a CHANGED is. Pure —
// callers hand in text.
package specshape

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/jsre"
)

// ReqHeading is `### REQ-USER-001 — Title`; the separator is optional.
var ReqHeading = jsre.MustCompile(`^###\s+(REQ-[A-Z0-9-]+-\d{3})\b\s*[—:-]?\s*(.*)$`, "")

// ReqTag is NOT `\b`-delimited: Go and pytest glue the id to their neighbours
// (`TestAuth/REQ-USER-001_rejects`), and `_` is a word character. Not glued
// to a preceding letter or digit, and not followed by a fourth digit.
var ReqTag = jsre.MustCompile(`(?<![A-Z0-9])REQ-[A-Z0-9-]+-\d{3}(?!\d)`, "")

// IDsIn are the ids a reported line proves, read as reported and with `_`
// read as `-`: an identifier cannot spell a hyphen (`test_REQ_CORE_001`).
// Both passes, not the normalized one alone, or `REQ-USER-001_002` reads as
// the single id `REQ-USER-001-002`.
func IDsIn(line string) []string {
	var ids []string
	seen := map[string]bool{}
	for _, text := range []string{line, strings.ReplaceAll(line, "_", "-")} {
		for _, m := range ReqTag.ExecAll(text) {
			if !seen[m.Text()] {
				seen[m.Text()] = true
				ids = append(ids, m.Text())
			}
		}
	}
	return ids
}

// ExpectedPrefix: `specs/user-profile.md` -> `REQ-USER-PROFILE-`.
func ExpectedPrefix(specFile string) string {
	return "REQ-" + strings.ToUpper(strings.TrimSuffix(filepath.Base(specFile), ".md")) + "-"
}

var newline = jsre.MustCompile(`\r?\n`, "")

// DeclaredIDs are the ids a capability spec declares, one per heading.
func DeclaredIDs(body string) map[string]bool {
	ids := map[string]bool{}
	for _, l := range newline.Split(body) {
		if m := ReqHeading.Exec(strings.TrimSpace(l)); m != nil {
			ids[m.Group(1)] = true
		}
	}
	return ids
}

// Spec is a capability spec and the ids it declares.
type Spec struct {
	File string
	IDs  map[string]bool
}

var idNumber = jsre.MustCompile(`-\d{3}$`, "")

// CapabilityOf is the capability spec a delta on id touches: the file
// declaring it, else the one its capability names, else `""`.
func CapabilityOf(id string, specs []Spec) string {
	for _, s := range specs {
		if s.IDs[id] {
			return s.File
		}
	}
	prefix := idNumber.ReplaceAll(id, func(*jsre.Match) string { return "" }) + "-"
	for _, s := range specs {
		if ExpectedPrefix(s.File) == prefix {
			return s.File
		}
	}
	return ""
}

// ArchiveStatus is `**Status:** SHIPPED 2026-07-30`, on an archived change spec.
var ArchiveStatus = jsre.MustCompile(`^\*\*Status:\*\*\s+(SHIPPED|REJECTED|SUPERSEDED)\b`, "m")

var shippedStatus = jsre.MustCompile(`^\*\*Status:\*\*\s+SHIPPED\b`, "m")

// IsShipped: stamped SHIPPED, so its deltas claim to be in `specs/`.
func IsShipped(body string) bool { return shippedStatus.Test(body) }

// ---- a delta: one grammar ----------------------------------------------------
//
// A delta is one line of `## Requirement deltas`: a dash, the verb, the id,
// then its text. Every reader takes it from sectionLines. Every other line of
// the section names only ids a delta line reads, so a delta spelled another
// way is refused by the id it names, not by a guess at its verb (ADR-048).

const (
	verb = `ADDED|CHANGED|REMOVED`
	id   = `REQ-[A-Z0-9-]+-\d{3}(?!\d)`
)

var (
	// The verb and the id share the line.
	deltaLine = jsre.MustCompile(`^[-*][ \t]*(`+verb+`)[ \t]+(`+id+`)(.*)$`, "")
	anID      = jsre.MustCompile(id, "")
)

// ChangedKinds are the two edits a CHANGED may be; everything else decomposes.
var ChangedKinds = []string{"wording", "correction"}

var (
	lineEnds    = jsre.MustCompile(`\r\n|\r|\n`, "")
	commentOpen = jsre.MustCompile(`^[ \t]*<!--`, "")
	fenceOpen   = jsre.MustCompile("^([ \\t]*)(`{3,}|~{3,})", "")
	leadingWS   = jsre.MustCompile(`^[ \t]*`, "")
	indentedRe  = jsre.MustCompile(`^(?: {4}|\t)`, "")
	listItem    = jsre.MustCompile(`^[ \t]*(?:[-*+]|\d+[.)])[ \t]`, "")
)

// WithoutCode is text with line ends made `\n`, and code and comments
// blanked: an example declares nothing. A comment starts a line, as an HTML
// block does. A fence closes on its own character, at least as long, or where
// the list item it opened in ends; one never closed is read as text. An
// indented block is code after a blank line that does not continue a list item.
func WithoutCode(text string) string {
	lines := lineEnds.Split(text)
	for i := 0; i < len(lines); i++ {
		end := -1
		if commentOpen.Test(lines[i]) {
			from := strings.Index(lines[i], "<!--") + 4
			for j := i; j < len(lines); j++ {
				start := 0
				if j == i {
					start = from
				}
				if start <= len(lines[j]) && strings.Contains(lines[j][start:], "-->") {
					end = j
					break
				}
			}
		} else {
			open := fenceOpen.Exec(lines[i])
			if open == nil {
				continue
			}
			mark := open.Group(2)
			fence := jsre.MustCompile(fmt.Sprintf(`^[ \t]*\%c{%d,}[ \t]*$`, mark[0], len(mark)), "")
			indent := len(open.Group(1))
			for j := i + 1; j < len(lines) && end == -1; j++ {
				if fence.Test(lines[j]) {
					end = j
				} else if strings.TrimSpace(lines[j]) != "" && len(leadingWS.Exec(lines[j]).Text()) < indent {
					end = j - 1 // a line less indented than the fence ends its list item
				}
			}
		}
		if end == -1 {
			continue
		}
		for j := i; j <= end; j++ {
			lines[j] = ""
		}
		i = end
	}
	code, listed := false, false
	for i := range lines {
		if strings.TrimSpace(lines[i]) == "" {
			continue
		}
		indented := indentedRe.Test(lines[i])
		code = indented && (code || (i > 0 && strings.TrimSpace(lines[i-1]) == "" && !listed))
		if code {
			lines[i] = ""
		} else {
			listed = listItem.Test(lines[i]) || (listed && indented)
		}
	}
	return strings.Join(lines, "\n")
}

var (
	deltasHeading = jsre.MustCompile(`^## Requirement deltas\b.*$`, "m")
	nextH2        = jsre.MustCompile(`^## `, "m")
)

// DeltasSection is the body of `## Requirement deltas`, code and comments
// blanked, or `""`. Prose elsewhere may DISCUSS a requirement without declaring one.
func DeltasSection(body string) string {
	text := WithoutCode(body)
	h := deltasHeading.Exec(text)
	if h == nil {
		return ""
	}
	after := text[h.End:]
	if next := nextH2.Search(after); next != -1 {
		return after[:next]
	}
	return after
}

type sectionLine struct{ line, verb, id, rest string }

func sectionLines(body string) []sectionLine {
	var out []sectionLine
	for _, line := range strings.Split(DeltasSection(body), "\n") {
		if m := deltaLine.Exec(line); m != nil {
			out = append(out, sectionLine{line, m.Group(1), m.Group(2), m.Group(3)})
		} else {
			out = append(out, sectionLine{line: line})
		}
	}
	return out
}

// Changed is a CHANGED delta and the kind it claims, `""` when it names none.
type Changed struct{ Line, ID, Kind string }

var kindMark = jsre.MustCompile(`^[ \t]*\(([a-z]+)\)`, "")

// ChangedDeltas are every CHANGED delta a spec declares.
func ChangedDeltas(body string) []Changed {
	var out []Changed
	for _, d := range sectionLines(body) {
		if d.verb == "CHANGED" {
			out = append(out, Changed{d.line, d.id, kindMark.Exec(d.rest).Group(1)})
		}
	}
	return out
}

// ExplainKind is why one CHANGED line was rejected.
func ExplainKind(kind string) string {
	switch kind {
	case "":
		return "does not say which kind of change it is"
	case "correction":
		return "is marked (correction), which only a `/spec-fix` brief may use"
	}
	return fmt.Sprintf("is marked (%s), which is not one of the two kinds a CHANGED may be (%s)", kind, strings.Join(ChangedKinds, ", "))
}

// HeavyHeadings are the proposal's sections, which a live spec.md must not carry.
var HeavyHeadings = []string{"## Source", "## Context", "## Decision"}

// Delta is one delta line's verb and id.
type Delta struct{ Verb, ID string }

// Deltas are every delta a spec declares, from its deltas section only.
func Deltas(body string) []Delta {
	var out []Delta
	for _, d := range sectionLines(body) {
		if d.verb != "" {
			out = append(out, Delta{d.verb, d.id})
		}
	}
	return out
}

var (
	// How a writer says the section has no delta.
	none = jsre.MustCompile(`^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)])[ \t]+)?[*_`+"`"+`]*[ \t]*(?:none|n\/a|nothing|unchanged|not[ \t]+applicable|no[ \t]+(?:(?:new|spec)[ \t]+)?(?:requirements?|spec|changes?|deltas?)(?:[ \t]+(?:changes?|deltas?))?)(?![\w-])`, "i")
	// A line a delta's verb leads, in capitals, is written as one; a heading grouping deltas is not.
	verbLed = jsre.MustCompile(`^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)]|[a-z][.)]|\|)[ \t]*)?(?:\[[ xX]\][ \t]*)?[[(*_`+"`"+`]*(?:`+verb+`)(?![\w-])`, "")
	// Shaped like an id and maybe not one: `REQ-USER-10`, `req-user-002`.
	idShapedRe = jsre.MustCompile(`(?<![\w-])req[-_][a-z][a-z0-9]*(?:[-_][a-z0-9]+)*[-_]\d+(?![\w-])`, "i")
	wholeID    = jsre.MustCompile(`^`+id+`$`, "")
	// In a delta's text, a verb in capitals before an id starts another delta.
	verbed = jsre.MustCompile(`(?<![\w-])(?:`+verb+`|MODIFIED|RENAMED|DELETED|UPDATED|REPLACED|DEPRECATED)[ \t:*_`+"`"+`|[\]()]*(`+id+`)`, "")
)

// IDShaped are the tokens of text shaped like an id, read as one or not.
func IDShaped(text string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range idShapedRe.ExecAll(text) {
		if !seen[m.Text()] {
			seen[m.Text()] = true
			out = append(out, m.Text())
		}
	}
	return out
}

// IsID says whether token is an id as every reader reads one.
func IsID(token string) bool { return wholeID.Test(token) }

func malformedIn(line string) []string {
	var out []string
	for _, t := range IDShaped(line) {
		if !IsID(t) {
			out = append(out, t)
		}
	}
	return out
}

// A delta's text starts at an em dash after a space, a colon, a parenthesis,
// or a hyphen or en dash before a word that joins nothing. Before it, another
// id, or a number going on from the first, is a second id.
const joiner = `(?:[ \t]*(?:[,/&+;~–]|\.\.|-(?=[ \t])|(?:and|or|to|through|thru)(?![\w-]))[ \t]*|—)`

var (
	kindPrefix = jsre.MustCompile(`^[ \t]*\([a-z]+\)`, "")
	textStarts = jsre.MustCompile(`[ \t]—|:|\(|[ \t][–-][ \t]+(?!REQ-|\d{3}(?!\d)|(?:and|or|to|through|thru)(?![\w-]))`, "")
	numbers    = jsre.MustCompile(`^(?:`+joiner+`\d{3}(?!\d))+[ \t]*(?:$|—|:|\()`, "i")
	between    = jsre.MustCompile(`^(?:[ \t]*\([a-z]+\))?(?:`+joiner+`|[ \t]+)$`, "i")
)

func namesSecondID(rest string) bool {
	before := kindPrefix.ReplaceAll(rest, func(*jsre.Match) string { return "" })
	head := before
	if t := textStarts.Search(before); t != -1 {
		head = before[:t]
	}
	return anID.Test(head) || numbers.Test(before)
}

// The ids a line names before its text: the first, and each listed after it.
func idsBeforeText(line string) []string {
	found := anID.ExecAll(line)
	var ids []string
	for i, m := range found {
		if i > 0 && !between.Test(line[found[i-1].End:m.Index]) {
			break
		}
		ids = append(ids, m.Text())
	}
	return ids
}

// Unread is a line of the deltas section no check binds whole.
type Unread struct {
	Line, Why string
	IDs       []string
}

// UnreadDeltas: a delta line naming a second id before its text, a token
// shaped like an id that is not one, an id no delta line reads, and a line a
// delta's verb leads that is no delta. A delta's own text, and `- none`'s, may
// name any id, except after a verb in capitals.
func UnreadDeltas(body string) []Unread {
	lines := sectionLines(body)
	read := map[string]bool{}
	for _, d := range lines {
		if d.verb != "" {
			read[d.id] = true
		}
	}
	var out []Unread
	for _, d := range lines {
		if d.verb != "" && namesSecondID(d.rest) {
			out = append(out, Unread{Line: d.line, Why: "two-ids"})
			continue
		}
		if malformed := malformedIn(d.line); len(malformed) > 0 {
			out = append(out, Unread{Line: d.line, Why: "malformed", IDs: malformed})
			continue
		}
		var named []string
		switch {
		case d.verb != "":
			for _, m := range verbed.ExecAll(d.rest) {
				named = append(named, m.Group(1))
			}
		case none.Test(d.line):
			for _, m := range verbed.ExecAll(d.line) {
				named = append(named, m.Group(1))
			}
		default:
			for _, m := range anID.ExecAll(d.line) {
				named = append(named, m.Text())
			}
		}
		var ids []string
		seen := map[string]bool{}
		for _, n := range named {
			if !seen[n] && !read[n] {
				seen[n] = true
				ids = append(ids, n)
			}
		}
		if len(ids) > 0 {
			out = append(out, Unread{Line: d.line, Why: "unread", IDs: ids})
		} else if d.verb == "" && verbLed.Test(d.line) {
			why := "no-id"
			if anID.Test(d.line) {
				why = "not-a-delta"
			}
			out = append(out, Unread{Line: d.line, Why: why})
		}
	}
	return out
}

const deltaShape = "A delta is one line, `- ADDED REQ-<CAP>-0NN — <text>`: a dash at the start, ADDED, CHANGED or REMOVED in capitals, then one id."

// ExplainUnread is why one line UnreadDeltas found is refused.
func ExplainUnread(u Unread) string {
	quoted := `"` + strings.TrimSpace(u.Line) + `"`
	ids := strings.Join(u.IDs, ", ")
	switch u.Why {
	case "two-ids":
		return quoted + " names more than one id before its text, and the engine reads the first alone. One delta per line, so each id is checked."
	case "malformed":
		return quoted + " names " + ids + ", which no check reads as an id: an id is REQ-, its capability in capitals, then three digits, `REQ-<CAP>-0NN`. Write it so. " + deltaShape
	case "no-id":
		return quoted + " is written as a delta and names no id, so no check binds it. " + deltaShape
	case "not-a-delta":
		return quoted + " leads with a delta's verb and is no delta line, so no check reads it as one. " + deltaShape + " Write each delta so, once."
	}
	them := "it"
	if len(u.IDs) > 1 {
		them = "them"
	}
	return quoted + " names " + ids + ", which no delta line of this section reads, so no check binds " + them + ". " + deltaShape + " " +
		"Every other line of the section names only ids its deltas read; a delta's own text may name any. Write each delta so, or move the rest out of the section."
}

// Outside the section only what can be nothing but a misplaced delta counts.
const outsideVerb = verb + `|MODIFIED|RENAMED`

var (
	misspelledHeading = jsre.MustCompile(`^#{1,6}[ \t]*requirements?[ \t]+deltas?\b`, "i")
	rightHeading      = jsre.MustCompile(`^## Requirement deltas\b`, "")
	grouping          = jsre.MustCompile(`^[ \t]*(?:>[ \t]*)*#{1,6}[ \t]*(?:`+outsideVerb+`)[ \t]+requirements?\b`, "i")
	misplaced         = jsre.MustCompile(`^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)]|#{1,6}|\|)[ \t]*)?(?:\[[ xX]\][ \t]*)?[[(*_`+"`"+`]*(?:`+outsideVerb+`)[ \t:*_`+"`"+`|\])]*`+id, "")
)

// DeltasSectionProblem is why a spec's deltas are not where every reader
// looks, or `""`. With needed, a spec saying nothing the engine reads under the
// section is one too: a spec says what it does to `specs/`, `- none` included.
func DeltasSectionProblem(body string, needed bool) string {
	text := WithoutCode(body)
	lines := strings.Split(text, "\n")
	for _, l := range lines {
		if misspelledHeading.Test(l) && !rightHeading.Test(l) {
			return `has "` + strings.TrimSpace(l) + "\", and the engine reads deltas under `## Requirement deltas` alone, spelled so: no check binds a delta under it. Rename the heading."
		}
	}
	section := DeltasSection(body)
	h := deltasHeading.Exec(text)
	outside := text
	if h != nil {
		end := h.End + len(section)
		if end > len(text) {
			end = len(text)
		}
		outside = text[:h.Index] + "\n" + text[end:]
	}
	for _, l := range strings.Split(outside, "\n") {
		if grouping.Test(l) || misplaced.Test(l) {
			return "declares a delta outside `## Requirement deltas` (\"" + strings.TrimSpace(l) + "\"), where no check reads it. Write each delta in that section, one line each: `- ADDED REQ-<CAP>-0NN — <text>`."
		}
	}
	if needed && h == nil {
		return "has no `## Requirement deltas` section. Write its deltas there, or `- none — <why>` when it has none."
	}
	if needed {
		says := false
		for _, d := range sectionLines(body) {
			if d.verb != "" || none.Test(d.line) || anID.Test(d.line) || verbLed.Test(d.line) || len(malformedIn(d.line)) > 0 {
				says = true
				break
			}
		}
		if !says {
			return "says nothing the engine reads under `## Requirement deltas`. Write each delta there, one line each, or `- none — <why>` when it has none."
		}
	}
	return ""
}

// REMOVED in capitals as a line's verb, before or beside its id, as archives
// written before this grammar spelled it too.
var removes = jsre.MustCompile(`^[ \t]*(?:>[ \t]*)*(?:(?:[-*+•·◦▪–—]|\d+[.)]|#{1,6}|\|)[ \t]*)?(?:\[[ xX]\][ \t]*)?[[(*_`+"`"+`]*REMOVED[ \t:*_`+"`"+`|\])]*`+id+`|`+id+`[ \t:*_`+"`"+`|[(]*REMOVED(?![\w-])`, "")

// RetiredIDs are the ids a spec retires, read leniently so an archive in
// another spelling still retires what it removed.
func RetiredIDs(body string) []string {
	var ids []string
	for _, d := range sectionLines(body) {
		if removes.Test(d.line) {
			ids = append(ids, idsBeforeText(d.line)...)
		}
	}
	return ids
}

// ReusedIDs are ADDED ids that are not new: removed by the same spec, or by
// a SHIPPED change. A retired id keeps meaning the behaviour that was removed.
func ReusedIDs(body string, archivedBodies []string) []string {
	retired := map[string]bool{}
	for _, r := range RetiredIDs(body) {
		retired[r] = true
	}
	for _, a := range archivedBodies {
		if IsShipped(a) {
			for _, r := range RetiredIDs(a) {
				retired[r] = true
			}
		}
	}
	var out []string
	seen := map[string]bool{}
	for _, d := range Deltas(body) {
		if d.Verb == "ADDED" && retired[d.ID] && !seen[d.ID] {
			seen[d.ID] = true
			out = append(out, d.ID)
		}
	}
	return out
}

// AssumptionsHeading is where a spec says what its writer decided without asking.
const AssumptionsHeading = "## Assumptions"

var (
	caseHeading       = jsre.MustCompile(`^## Case\b`, "m")
	assumptionsRe     = jsre.MustCompile(`^`+AssumptionsHeading+`\b.*$`, "m")
	assumptionsItemRe = jsre.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+\S`, "m")
)

// IsFixBrief says whether a spec is a `/spec-fix` brief.
func IsFixBrief(body string) bool { return caseHeading.Test(body) }

// AssumptionsProblem is why the assumptions section does not do its job, or
// `""`. `- none` is an answer; a missing or empty section cannot be told from a
// writer that never looked. A fix brief is exempt. Read at spec time only,
// never at the gate (ADR-030).
func AssumptionsProblem(body string) string {
	if IsFixBrief(body) {
		return ""
	}
	h := assumptionsRe.Exec(body)
	if h == nil {
		return "has no `" + AssumptionsHeading + "` section"
	}
	section := body[h.End:]
	if next := nextH2.Search(section); next != -1 {
		section = section[:next]
	}
	if assumptionsItemRe.Test(section) {
		return ""
	}
	return "has an empty `" + AssumptionsHeading + "` section — write what was assumed, or `- none`"
}

// ProhibitionWords make a requirement a prohibition; the spec-writer's
// contract must name each (ADR-045).
var ProhibitionWords = []string{"cannot", "must not", "never", "only"}

var word = func() string {
	parts := make([]string, len(ProhibitionWords))
	for i, w := range ProhibitionWords {
		parts[i] = strings.ReplaceAll(w, " ", `\s+`)
	}
	return `(?:` + strings.Join(parts, "|") + `)`
}()

var (
	// Not in a compound or an identifier, not `not only`, not `the only`.
	prohibition = jsre.MustCompile(`(?<![\w-])(?<!\b(?:not|the|an)\s+)`+word+`(?![\w-])`, "i")
	// Where one claim ends and another begins; not a bare `and`.
	clauseBreak = jsre.MustCompile(strings.Join([]string{
		`;`, `\s[—–]\s`, `\s--?\s`, `,\s*(?:and|but|yet|while|whereas)\b`, `\s(?:but|yet|whereas)\s`,
		`(?:,|\sand)\s+(?=` + word + `(?![\w-]))`,
	}, "|"), "i")
	// A word after one of these describes a thing rather than forbids one.
	subordinate = jsre.MustCompile(`\b(?:when|whenever|if|unless|once|until|because|since|after|before|where|whether|that|which|who|whom|whose)\b`, "i")
	leadSep     = jsre.MustCompile(`^\s*[—–:-]?\s*`, "")
	quotedText  = jsre.MustCompile("`[^`]*`|\"[^\"]*\"|“[^”]*”", "")
	spaces      = jsre.MustCompile(`\s+`, "")
)

func prohibitionIn(clause string) string {
	for _, segment := range strings.Split(clause, ",") {
		w := prohibition.Exec(segment)
		if w == nil {
			continue
		}
		if sub := subordinate.Exec(segment); sub == nil || sub.Index > w.Index {
			return spaces.ReplaceAll(strings.ToLower(w.Text()), func(*jsre.Match) string { return " " })
		}
	}
	return ""
}

// Paired is an ADDED delta stating a prohibition and another claim on one id.
type Paired struct{ Line, ID, Word string }

// PairedProhibitions: quoted and code text is not read.
func PairedProhibitions(body string) []Paired {
	var out []Paired
	for _, d := range sectionLines(body) {
		if d.verb != "ADDED" {
			continue
		}
		claim := leadSep.ReplaceAll(d.rest, func(*jsre.Match) string { return "" })
		claim = quotedText.ReplaceAll(claim, func(*jsre.Match) string { return " " })
		var clauses []string
		for _, c := range clauseBreak.Split(claim) {
			if strings.TrimSpace(c) != "" {
				clauses = append(clauses, c)
			}
		}
		if len(clauses) < 2 {
			continue
		}
		for _, c := range clauses {
			if w := prohibitionIn(c); w != "" {
				out = append(out, Paired{d.line, d.id, w})
				break
			}
		}
	}
	return out
}

// ArchiveClash is the problem with naming a live change slug, or `""`: the
// fold moves it to specflow/archive/<slug>/, and onto a folder that exists —
// in any case a case-insensitive filesystem folds — it lands inside (ADR-048).
func ArchiveClash(slug string, archivedSlugs []string) string {
	for _, a := range archivedSlugs {
		if strings.EqualFold(a, slug) {
			return fmt.Sprintf("specflow/%s/ has the name of an archived change, specflow/archive/%s/. The fold moves a change to specflow/archive/<its name>/, ", slug, a) +
				fmt.Sprintf("and onto a folder that exists it lands inside that change instead. Give this change a name of its own: rename specflow/%s/.", slug)
		}
	}
	return ""
}

// LiveSpecProblems are why a live change spec cannot be built from: what
// spec-trace checks of every live change at the gate, and phase-guard when a
// run leaves `spec`.
func LiveSpecProblems(slug, body string, hasProposal bool, archivedBodies []string) []string {
	var problems []string
	isFixBrief := IsFixBrief(body)

	// CHANGED is the one delta spec-trace cannot prove: the id already has a
	// test, so the binding holds before the edit and after it. A CHANGED that
	// WIDENS claims a clause nobody proves; declared ADDED, spec-trace fails it.
	// So CHANGED keeps only the two edits that move no proof — and nothing
	// here verifies the kind is TRUE; the reviewer and the sign-off do (ADR-009).
	for _, c := range ChangedDeltas(body) {
		if c.Kind == "wording" || (c.Kind == "correction" && isFixBrief) {
			continue
		}
		problems = append(problems, fmt.Sprintf("specflow/%s/spec.md: \"%s\" %s. ", slug, strings.TrimSpace(c.Line), ExplainKind(c.Kind))+
			fmt.Sprintf("CHANGED is the one delta spec-trace cannot prove — %s already exists and already has a test, ", c.ID)+
			"so the spec/test binding passes before the edit and after it, whatever the body now says. "+
			fmt.Sprintf("If the requirement means exactly what it meant and no test moves, write `CHANGED %s (wording)`. ", c.ID)+
			fmt.Sprintf("Otherwise this is not a CHANGED: split it into `REMOVED %s` plus an `ADDED` on a NEW id, ", c.ID)+
			"which spec-trace proves in both directions. Widening counts — a clause added to an existing "+
			"requirement is claimed by the spec layer and proven by nobody.")
	}

	if reused := ReusedIDs(body, archivedBodies); len(reused) > 0 {
		problems = append(problems, fmt.Sprintf("specflow/%s/spec.md ADDs %s, which this spec or a shipped change REMOVED. ", slug, strings.Join(reused, ", "))+
			"A retired id keeps meaning the behaviour that was removed — in the archive and in any test or record that names it — "+
			"so a new requirement takes the next unused id in its capability's sequence.")
	}

	// One test of "filters by A and B, never by C" passes while it asserts
	// only A and B. It reads the words and the punctuation, not grammar, and
	// does not check the prohibition's test asserts it (ADR-045, ADR-020).
	for _, p := range PairedProhibitions(body) {
		problems = append(problems, fmt.Sprintf("specflow/%s/spec.md: \"%s\" pairs a prohibition (\"%s\") with another claim on one id. ", slug, strings.TrimSpace(p.Line), p.Word)+
			fmt.Sprintf("spec-trace binds %s to any test that ran under its name, so a test of what the requirement allows passes ", p.ID)+
			"while nothing checks what it forbids. Give the prohibition an ADDED id of its own — \"filters by A and B\" on one id, "+
			"\"never filters by C\" on the next — so the gate stays red until a test named for it runs.")
	}

	if isFixBrief {
		return problems // exempt from the split below, by design
	}
	var leaked []string
	for _, h := range HeavyHeadings {
		if jsre.MustCompile(`^`+h+`\b`, "m").Test(body) {
			leaked = append(leaked, h)
		}
	}
	if len(leaked) > 0 {
		problems = append(problems, fmt.Sprintf("specflow/%s/spec.md carries %s. Those belong in specflow/%s/proposal.md — the spec says what changes, the proposal says why it was chosen and what was rejected. The planner reads the first on every fresh context; only a human reads the second.", slug, strings.Join(leaked, ", "), slug))
	}
	if !hasProposal {
		problems = append(problems, fmt.Sprintf("specflow/%s/ has no proposal.md. A change spec with no recorded reasoning is a decision nobody can audit later — the archive's whole job is answering \"was this considered, and what was turned down?\".", slug))
	}
	return problems
}

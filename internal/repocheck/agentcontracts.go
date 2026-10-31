package repocheck

// AgentContracts holds the agents' Markdown to what the code and the other
// agents expect of it, at each seam where prose has to agree with prose or
// with code — none of which any fixture executes:
//
//   - a field the planner's milestone template declares is named in the
//     reviewer's checklist, or exempt here with a reason. A field the planner
//     writes and nobody checks is a field it can silently omit.
//   - a field a routed agent RETURNS is named by a command, or exempt with a
//     reason: `GAPS:` is the only channel for a finding no check produces (ADR-020).
//   - an agent asserting that spec-trace FAILS over a contract-gated subject
//     names the field that gates it, or the sentence is false wherever the
//     project left it off.
//   - the spec-writer's contract states the question cap and the words a
//     prohibition is read by, and its template carries the assumptions
//     section the checks hold its output to (ADR-030, ADR-045).
//   - each command's fold offers a weak test's fix as `/spec-fix` only (ADR-042).
//   - a `tools:` list nobody wrote is the widest grant the harness offers,
//     and looks identical to a deliberate one.

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agentblocks"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/specshape"
)

// NotReviewed are template fields the reviewer deliberately does not check.
// A field belongs here when checking it would add nothing, not when nobody
// got round to it.
var NotReviewed = map[string]string{
	"Objective":  `what "done" means for a milestone is judged through its deltas and its tests, which are the checkable form of the same claim`,
	"Steps":      "the reviewer judges whether the plan will bite during implementation, which is these in aggregate; per-step review is the second pass this flow deliberately cut",
	"Depends on": `covered by "are milestones correctly ordered and independently testable", which is stronger than the field`,
}

// NotRouted are return fields the commands deliberately do not name: for
// every routed agent (`FIELD`) or for one (`agent.FIELD`).
var NotRouted = map[string]string{
	"STATUS": "the block's own discriminator — every command branches on its VALUE, which is named, rather than on the key",
	// Read by MEANING: the orchestrator acts on the path or the text and
	// never needs to say the label back. Ceremony in a prompt costs tokens.
	"SPEC_PATH":     "the commands work from `specflow/<SLUG>/spec.md` directly — the path is used, the label never has to be",
	"PROPOSAL_PATH": "same as SPEC_PATH: `proposal.md` is named where it is read, at sign-off",
	"SUMMARY":       "step 1 already tells the orchestrator to show the user a summary drawn from both artifacts; the key adds nothing to that instruction",
	"DELTAS":        "/spec-fix routes on CASE, and the deltas it names are the ones the spec file already carries",
	"PLAN_PATH":     "same as SPEC_PATH: the commands work from `specflow/<SLUG>/plan.md` directly",
	"MILESTONES":    "step 4 walks the milestone index in plan.md, not this line",
	"ANSWERS":       `handed whole to the re-invoked reviewer ("with the answers"), which reads them by meaning`,
	"CHANGES":       "REPLAN's account of what it rewrote; the implementer is sent back to the revised Mk.md, not to this line",
	// The architect's answer, relayed whole as ARCHITECT_GUIDANCE (ADR-038).
	"architect.DECISIONS":    "relayed whole to the implementer as ARCHITECT_GUIDANCE; nothing branches on it",
	"architect.DESIGN_NOTES": "relayed whole to the implementer with DECISIONS; nothing branches on it",
	"reviewer.NOTES":         "optional remarks on an APPROVED plan; a doubt or a problem comes back under a status that is routed",
	// Confirmations of work already done: there is no branch to take.
	"SPECS_VERIFIED": "a confirmation of the verification, not a finding — a delta that did NOT land comes back through GAPS, which is routed",
	"FIXED":          "a confirmation of spec-side edits the fold is entitled to make on its own",
	"ARCHIVED":       "a confirmation of the move; an unarchived specflow/<SLUG>/ is caught by phase-guard when `done` is written, which is a check rather than a prompt",
}

// RoutedAgents return findings the orchestrator itself acts on. The
// implementer's return is handed whole to the next agent, so it is relayed,
// never branched on. An agent's blocks include its `modes/<name>-*.md`.
var RoutedAgents = []string{"spec-writer", "planner", "reviewer", "architect"}

var (
	templateField = regexp.MustCompile(`(?m)^- ([A-Z][^:\n]*):`)
	// `!cfg.Trace.RequireSkillsField {` … `continue`: a check the contract switches off.
	gatedCheck = regexp.MustCompile(`!cfg\.Trace\.(\w+)\s*\{\s*continue`)
	camelHump  = regexp.MustCompile(`([a-z0-9])([A-Z])`)
	paragraph  = regexp.MustCompile(`\n\s*\n`)
	failsWord  = regexp.MustCompile(`\bfails?\b|\brejects?\b|\brefuses?\b`)
	toolsLine  = regexp.MustCompile(`(?m)^tools:[ \t]*\S`)
	yamlFront  = regexp.MustCompile(`^---\r?\n((?s:.*?))\r?\n---`)
	foldStep   = regexp.MustCompile(`(?ms)^## 5\. FOLD.*?^## `)
)

// fenceAfter is the fenced block after the first occurrence of intro, or false.
func fenceAfter(text, intro string) (string, bool) {
	at := strings.Index(text, intro)
	if at == -1 {
		return "", false
	}
	open := strings.Index(text[at:], "```")
	if open == -1 {
		return "", false
	}
	open += at
	end := strings.Index(text[open+3:], "```")
	if end == -1 {
		return "", false
	}
	return text[open+3 : open+3+end], true
}

func AgentContracts(root string) Report {
	r := Report{Name: "agent-contracts"}
	add := func(format string, a ...any) { r.Problems = append(r.Problems, fmt.Sprintf(format, a...)) }
	planner, reviewer := readRel(root, "agents/planner.md"), readRel(root, "agents/reviewer.md")

	// ---- the milestone template, anchored to the line naming it: if the
	// anchor stops matching, this fails rather than checking an empty set.
	var fields []string
	if tmpl, ok := fenceAfter(planner, "milestones/Mk.md`**"); ok {
		for _, m := range templateField.FindAllStringSubmatch(tmpl, -1) {
			fields = append(fields, m[1])
		}
	}
	if len(fields) == 0 {
		add("the milestone template could not be found in agents/planner.md. It is anchored to the line naming `milestones/Mk.md` followed by a fenced block; if that moved, fix this check rather than leaving it matching nothing — a check that silently finds no fields passes forever.")
	}
	for _, f := range fields {
		// Whole words: "objectively" does not name `Objective`.
		if regexp.MustCompile(`(?i)\b` + regexp.QuoteMeta(f) + `\b`).MatchString(reviewer) {
			continue
		}
		if _, ok := NotReviewed[f]; ok {
			continue
		}
		add(`the planner's milestone template declares "%s" and agents/reviewer.md never names it. The reviewer is the only pass that reads a milestone before an implementer is spent, so a field nobody checks is a field the planner can silently omit. Add it to the reviewer's checklist, or add it to NotReviewed in internal/repocheck/agentcontracts.go with the reason it does not need one.`, f)
	}
	if len(fields) > 0 {
		for _, f := range sortedKeys(NotReviewed) {
			if !contains(fields, f) {
				add(`NotReviewed exempts "%s", which the milestone template no longer declares. Remove the entry — an exemption nobody can reach is a decision about a field that does not exist.`, f)
			}
		}
	}

	// ---- a field an agent RETURNS is read by the command driving it
	commands := readRel(root, "commands/spec-flow.md") + "\n" + readRel(root, "commands/spec-fix.md")
	returnedBy := map[string][]string{}
	for _, name := range RoutedAgents {
		text := readRel(root, "agents/"+name+".md")
		for _, f := range mdIn(root, "modes") {
			if strings.HasPrefix(f, name+"-") {
				text += "\n" + readRel(root, "modes/"+f)
			}
		}
		blocks, declared := agentblocks.ReturnBlocks(text)
		if blocks == 0 {
			add("agents/%s.md and modes/%s-*.md declare no `STATUS:` return block. They are anchored to a fenced block opening with `STATUS:`; if that shape moved, fix this check rather than leaving it matching nothing — a check that silently finds no fields passes forever.", name, name)
		}
		for _, f := range declared {
			returnedBy[f] = append(returnedBy[f], name)
		}
	}
	for _, f := range sortedKeys(returnedBy) {
		for _, agent := range returnedBy[f] {
			if _, ok := NotRouted[agent+"."+f]; ok || len(agentblocks.UnroutedFields([]string{f}, commands, NotRouted)) == 0 {
				continue
			}
			add(`agents/%s.md returns "%s:" and neither command names it. A return field no command reads is a finding that reaches the orchestrator and stops there — which for a field like GAPS is the only report of something no check in this engine can produce. Name it in the command that drives that mode, or add it to NotRouted in internal/repocheck/agentcontracts.go with the reason it needs no handling.`, agent, f)
		}
	}
	for _, key := range sortedKeys(NotRouted) {
		agent, field, scoped := strings.Cut(key, ".")
		if !scoped {
			field = key
		}
		if scoped && !contains(returnedBy[field], agent) || !scoped && returnedBy[field] == nil {
			add(`NotRouted exempts "%s", which no routed agent's return block declares. Remove the entry — an exemption nobody can reach is a decision about a field that does not exist.`, key)
		}
	}

	// ---- an agent may not describe a GATED check as unconditional. The gated
	// fields are read out of spec-trace itself: a list would agree with the
	// code exactly until someone gates a second check.
	var gated []string
	for _, m := range gatedCheck.FindAllStringSubmatch(readRel(root, "internal/spectrace/spectrace.go"), -1) {
		gated = append(gated, strings.ToLower(camelHump.ReplaceAllString(m[1], "${1}_${2}")))
	}
	if len(gated) == 0 {
		add("no contract-gated check was found in internal/spectrace/spectrace.go (the `!cfg.Trace.<Field> {` … `continue` shape). If that line was rewritten, fix the pattern here; if the last gated check was removed, remove this check too — matching nothing, it passes forever.")
	}
	var contracts []string
	for _, f := range mdIn(root, "agents") {
		contracts = append(contracts, "agents/"+f)
	}
	for _, f := range mdIn(root, "modes") {
		contracts = append(contracts, "modes/"+f)
	}
	for _, field := range gated {
		// `require_skills_field` -> `skills`: the word prose uses for the subject.
		subject := strings.ReplaceAll(strings.TrimSuffix(strings.TrimPrefix(field, "require_"), "_field"), "_", " ")
		for _, file := range contracts {
			text := readRel(root, file)
			if strings.Contains(text, field) {
				continue
			}
			// Paragraph, not sentence: the assertion and its subject sit in neighbouring sentences.
			for _, para := range paragraph.Split(text, -1) {
				lower := strings.ToLower(para)
				if strings.Contains(lower, "spec-trace") && strings.Contains(lower, subject) && failsWord.MatchString(lower) {
					add("%s tells its reader that spec-trace fails over \"%s\", and never names `%s` — the contract field that decides whether that check runs at all. It is off by default, so the sentence is false in most repos, and an agent cannot discover that from inside a run: the only evidence would be a gate that never fires. State the condition, or say what actually always checks it.", file, subject, field)
					break
				}
			}
		}
	}

	// ---- the spec-writer's contract states what the checks hold it to
	specWriter := readRel(root, "agents/spec-writer.md")
	if tmpl, ok := fenceAfter(specWriter, "## Spec format (spec.md)"); !ok {
		add("the spec template could not be found in agents/spec-writer.md (a fenced block after `## Spec format (spec.md)`). Fix this check rather than leaving it matching nothing.")
	} else if p := specshape.AssumptionsProblem(tmpl); p != "" {
		add("agents/spec-writer.md's spec template %s: a writer following it writes a spec the check rejects.", p)
	}
	if !strings.Contains(specWriter, fmt.Sprintf("at most %d questions", agentblocks.MaxOpenQuestions)) {
		add(`agents/spec-writer.md does not say "at most %d questions", the cap in agentblocks.MaxOpenQuestions.`, agentblocks.MaxOpenQuestions)
	}
	words := specshape.ProhibitionWords
	if len(words) < 2 {
		add("specshape.ProhibitionWords holds fewer than two words, so the phrase this check looks for is not a list. Fix this check rather than leaving it matching nothing.")
	} else {
		quoted := make([]string, len(words))
		for i, w := range words {
			quoted[i] = "`" + w + "`"
		}
		phrase := strings.Join(quoted[:len(quoted)-1], ", ") + " or " + quoted[len(quoted)-1]
		if !strings.Contains(specWriter, phrase) {
			add("agents/spec-writer.md does not say %s, the words in specshape.ProhibitionWords that spec-trace refuses beside another claim on one id.", phrase)
		}
	}
	for _, file := range []string{"spec-flow.md", "resume.md"} {
		if !regexp.MustCompile(`\bAssumptions\b`).MatchString(readRel(root, "commands/"+file)) {
			add("commands/%s never names the spec's Assumptions, so its sign-off does not show the human what the writer decided without asking.", file)
		}
	}
	// A weak test the fold names is fixed after `done`, where the gate,
	// lint-on-write and the command deny stand down; /spec-fix arms them again.
	for _, file := range []string{"spec-flow.md", "spec-fix.md"} {
		step := foldStep.FindString(readRel(root, "commands/"+file))
		offer := ""
		for _, line := range strings.Split(step, "\n") {
			if strings.Contains(line, "`GAPS:`") {
				offer = line
				break
			}
		}
		if offer == "" {
			add("commands/%s step 5 has no line naming `GAPS:`; fix this check rather than leaving it matching nothing.", file)
		} else if !strings.Contains(offer, "/spec-fix") || regexp.MustCompile(`(?i)fresh implementer`).MatchString(regexp.MustCompile(`(?i)never a fresh implementer`).ReplaceAllString(offer, "")) {
			add("commands/%s step 5 offers a fix for a weak test other than `/spec-fix`. Offered after `done`, any other fix runs with the gate, lint-on-write and the command deny standing down.", file)
		}
	}

	// ---- every shipped agent says what it may use. The list's CONTENTS stay
	// the author's business; this asks only that the question was answered.
	agentFiles := mdIn(root, "agents")
	if len(agentFiles) == 0 {
		add("agents/ contains no .md files. A scan that finds nothing passes exactly as a clean directory does, so finding no agents is a failure here rather than a quiet OK.")
	}
	for _, f := range agentFiles {
		m := yamlFront.FindStringSubmatch(readRel(root, "agents/"+f))
		if m == nil {
			add("agents/%s has no YAML frontmatter, so the harness reads neither its name nor its model.", f)
			continue
		}
		if !toolsLine.MatchString(m[1]) {
			add("agents/%s declares no `tools:`, so it inherits every tool the harness offers — including Task, which lets it spawn agents of its own. Name the tools it actually uses. If inheriting everything IS the intent, that is a decision worth a line: say so in the frontmatter and this check still fails, because the field is what records it.", f)
		}
	}
	r.OK = fmt.Sprintf("%d milestone field(s); %d named in the reviewer's checklist, %d exempt with a stated reason; %d agent(s), every one declaring its tools; %d return field(s) from %s, %d routed by a command and %d exempt with a stated reason; %d contract-gated spec-trace check(s), none described as unconditional.",
		len(fields), len(fields)-len(NotReviewed), len(NotReviewed), len(agentFiles), len(returnedBy), strings.Join(RoutedAgents, " and "), len(returnedBy)-len(NotRouted), len(NotRouted), len(gated))
	return r
}

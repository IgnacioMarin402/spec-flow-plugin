// Package spectrace binds a repository's capability specs to the tests that
// prove them. A spec is the source of truth only if something breaks when the
// spec and the code disagree; this is what breaks.
//
// The binding is the requirement id, and it binds only from a test the runner
// REPORTED as executed: a tag in a comment proves nothing. Nothing here reads
// source code or walks the repository (ADR-001). Checked in both directions —
// a requirement with no test, a test tag with no requirement — plus the
// archive's rules: every archived change declares what became of it, each has
// a folder of its own, and one this branch shipped has its deltas in `specs/`
// (ADR-048). Which archived changes are this branch's it asks of git.
package spectrace

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/specshape"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/testreport"
)

var (
	scopeMarker = regexp.MustCompile(`(?m)^<!--\s*spec-scope:\s*(.+?)\s*-->$`)
	headingRe   = regexp.MustCompile(`^(#{1,6})\s+(\S+)`)
	skillsField = regexp.MustCompile(`(?m)^[-*]?\s*\**Skills\**\s*:[ \t]*\S`)
)

// walk is every file under dir matching test. Dot-directories are skipped,
// for size only — no build-output names: a repository whose capability is
// called `build` is entitled to `specs/build/`. Symlinks are followed once
// each: a circular one would otherwise recurse forever.
func walk(dir string, test func(string) bool, found []string, seen map[string]bool) []string {
	real, err := filepath.EvalSymlinks(dir)
	if err != nil || seen[real] {
		return found
	}
	seen[real] = true
	entries, err := os.ReadDir(dir)
	if err != nil {
		return found
	}
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())
		st, err := os.Lstat(full)
		if err != nil {
			continue
		}
		isDir := st.IsDir()
		if st.Mode()&os.ModeSymlink != 0 {
			target, err := os.Stat(full)
			if err != nil {
				continue // dangling
			}
			isDir = target.IsDir()
		}
		if isDir {
			if !strings.HasPrefix(e.Name(), ".") {
				found = walk(full, test, found, seen)
			}
		} else if test(full) {
			found = append(found, full)
		}
	}
	return found
}

func rel(root, path string) string {
	r, err := filepath.Rel(root, path)
	if err != nil {
		return path
	}
	return r
}

type requirement struct{ title, spec string }

type shaped struct {
	rel, line string
	level     int
	token     string
}

// Run is `spec-flow trace`: 0 when the spec layer and the tests agree.
// list also prints the requirement -> test matrix.
func Run(root string, list bool, stdout, stderr io.Writer) int {
	cfg, err := contract.Load(root)
	if err != nil {
		// Unguarded: a version this engine does not recognise stops the run.
		fmt.Fprintf(stderr, "spec-trace: %v\n", err)
		return 1
	}
	specsDir := filepath.Join(root, cfg.Trace.SpecsDir)
	specflowDir := filepath.Join(root, "specflow")
	archiveDir := filepath.Join(specflowDir, "archive")

	var problems []string
	reqOrder := []string{}
	requirements := map[string]requirement{}

	// ---- read the specs ---------------------------------------------------
	notACap := map[string]bool{}
	for _, n := range cfg.Trace.NotACapability {
		notACap[n] = true
	}
	var shapedHeadings []shaped
	specFiles := walk(specsDir, func(f string) bool { return strings.HasSuffix(f, ".md") && !notACap[filepath.Base(f)] }, nil, map[string]bool{})
	for _, file := range specFiles {
		r := rel(root, file)
		text, _ := hookio.ReadText(file)
		if scopeMarker.FindStringSubmatch(text) == nil {
			problems = append(problems, r+": missing the scope marker. Add `<!-- spec-scope: <the path this spec is about> -->` near the top.")
		}
		prefix := specshape.ExpectedPrefix(file)
		// Headings led by something shaped like an id, code aside: judged once
		// every requirement is known.
		for _, line := range strings.Split(specshape.WithoutCode(text), "\n") {
			h := headingRe.FindStringSubmatch(strings.TrimSpace(line))
			if h == nil {
				continue
			}
			if tokens := specshape.IDShaped(h[2]); len(tokens) > 0 && strings.HasPrefix(h[2], tokens[0]) {
				shapedHeadings = append(shapedHeadings, shaped{r, strings.TrimSpace(line), len(h[1]), tokens[0]})
			}
		}
		for _, line := range strings.Split(text, "\n") {
			m := specshape.ReqHeading.Exec(strings.TrimSpace(line))
			if m == nil {
				continue
			}
			id, title := m.Group(1), m.Group(2)
			if !strings.HasPrefix(id, prefix) {
				problems = append(problems, fmt.Sprintf("%s: requirement %s does not start with %s, which this file's name requires.", r, id, prefix))
			}
			if prev, dup := requirements[id]; dup {
				problems = append(problems, fmt.Sprintf("%s is declared twice: %s and %s.", id, prev.spec, r))
				continue
			}
			requirements[id] = requirement{strings.TrimSpace(title), r}
			reqOrder = append(reqOrder, id)
		}
	}

	// ---- ask which tests actually ran ------------------------------------
	// Everything downstream reads LINES: an id found in a line is a proof.
	// Declaring neither source is legitimate only while nothing is to prove.
	report := cfg.Trace.Report
	useReport := report != nil && report.Format != ""
	reportCmd := strings.Join(cfg.Trace.ExecutedTests, " ")
	if useReport {
		reportCmd = fmt.Sprintf("trace.report (%s @ %s)", report.Format, report.Path)
	}
	reportSkipped := 0
	var status int
	var out, errText, spawnErr string
	switch {
	case useReport:
		r := testreport.Read(report.Format, report.Path, root)
		if r.Error != "" {
			status, errText = 1, r.Error
		} else {
			reportSkipped, out = r.Skipped, strings.Join(r.Names, "\n")
		}
	case len(cfg.Trace.ExecutedTests) > 0:
		res := proc.Run(proc.Options{Dir: root}, cfg.Trace.ExecutedTests...)
		status, out, errText = res.Status, res.Stdout, res.Stderr
		if res.Err != nil {
			spawnErr = res.Err.Error()
		}
	case len(requirements) > 0:
		status = 1
		errText = fmt.Sprintf("%s/ declares %d requirement(s) and the contract declares no way to find out which tests ran. ", cfg.Trace.SpecsDir, len(requirements)) +
			`Traceability is opt-in and this repo has opted out, which is only coherent while it has no requirements. Add "report": {"format": "junit", "path": "..."} under "trace" ` +
			"(your runner already writes that file — `spec-flow init` proposes the flag), or delete the requirements."
	default:
		// Explicit rather than silent: a green that does not say WHY it is
		// green is how an unarmed check gets mistaken for a passing one.
		fmt.Fprintln(stdout, "spec-trace: traceability is not configured and no requirements are declared — nothing to check.")
	}

	// "Every requirement is unproven" and "I could not find out what ran"
	// both exit non-zero, so the message has to tell them apart.
	reportFailed := spawnErr != "" || status != 0
	var reported []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			reported = append(reported, l)
		}
	}
	// A source that answers nothing is a refusal only while something depends
	// on the answer — the state every adopter is in on a first run, since the
	// reporter flag `init` asks for is theirs to add.
	unarmed := false
	switch {
	case reportFailed && len(requirements) == 0:
		why := spawnErr
		if why == "" {
			if why = strings.TrimSpace(errText); why == "" {
				why = fmt.Sprintf("exit %d", status)
			}
		}
		unarmed = true
		fmt.Fprintf(stdout, "spec-trace: traceability is declared but not producing anything yet, and %s/ declares no requirement — so there is nothing to bind and this is not a failure. "+
			"It becomes one the moment a requirement exists.\n  source: %s\n  reason: %s\n", cfg.Trace.SpecsDir, reportCmd, why)
	case reportFailed:
		why := spawnErr
		if why == "" {
			why = fmt.Sprintf("exit %d", status)
		}
		msg := fmt.Sprintf("%s failed: %s. Nothing was learned about which tests ran, so no requirement can be called proven OR unproven. ", reportCmd, why) +
			"This is a refusal, not a finding about your specs."
		if errText != "" {
			msg += "\n\n" + strings.TrimSpace(errText)
		}
		problems = append(problems, msg)
	case len(reported) == 0 && reportSkipped == 0 && len(requirements) > 0:
		problems = append(problems, fmt.Sprintf("%s reported no tests at all, while %s/ declares %d requirement(s). ", reportCmd, cfg.Trace.SpecsDir, len(requirements))+
			fmt.Sprintf("That is not %d unproven requirement(s) — it is a report that says nothing, which usually means the suite has not run yet in this working tree, or the source names the wrong output. ", len(requirements))+
			"Run the suite (`spec-flow check` does it in the right order) and try again.")
	}
	// A report whose cases were ALL skipped says something — the suite ran and
	// proved nothing — and falls through to the per-requirement findings.

	proofOrder := []string{}
	proofs := map[string][]string{}
	if !reportFailed {
		for _, line := range reported {
			for _, id := range specshape.IDsIn(line) {
				if _, ok := proofs[id]; !ok {
					proofOrder = append(proofOrder, id)
				}
				if !containsStr(proofs[id], line) {
					proofs[id] = append(proofs[id], line)
				}
			}
		}
	}

	// ---- both directions -------------------------------------------------
	// Not when the report could not be read: that would invent findings.
	if !reportFailed && (len(reported) > 0 || reportSkipped > 0) {
		for _, id := range reqOrder {
			if _, ok := proofs[id]; !ok {
				// The proof surface the contract declares, never a path composed
				// from the spec's scope (ADR-026).
				problems = append(problems, fmt.Sprintf("%s (%s) has no test that RAN. Add a test on the proof surface the contract declares — a %s file under %s — whose name contains %s, or delete the requirement — an unproven requirement is a wish, not a spec. ", id, requirements[id].spec, cfg.Trace.ProofSuffix, cfg.Trace.ProofDir, id)+
					"Note that a test which exists but was skipped or marked todo counts as absent here: it is reported by nothing, which is exactly what makes skipping useless as a way to silence this.")
			}
		}
	}
	for _, id := range proofOrder {
		if _, ok := requirements[id]; !ok {
			problems = append(problems, fmt.Sprintf("%s is proven by a test that ran (%s) but no spec declares it. Either add it to the capability spec or drop the tag — a test proving something unspecified is drift in the other direction.", id, strings.Join(proofs[id], ", ")))
		}
	}

	// ---- whose each archived change is, and which run's -------------------
	// Asked of git once, and only when a check needs it. During a run, a
	// change the branch archived before one of its live changes was created
	// belongs to an earlier run: said, not failed. Read off the repository,
	// never off state a hook wrote.
	sc := &scope{root: root, cfg: cfg}
	var unscoped, earlier []string
	inherited := func(spec string) bool {
		_, written := sc.get().written["specflow/"+spec]
		return sc.get().atBase[spec] && !written
	}
	writtenAt := func(spec string) int {
		if at, ok := sc.get().written["specflow/"+spec]; ok {
			return at
		}
		return gitscope.Uncommitted
	}
	var live []string
	if entries, err := os.ReadDir(specflowDir); err == nil {
		for _, e := range entries {
			if e.Name() != "archive" && hookio.IsDir(filepath.Join(specflowDir, e.Name())) {
				live = append(live, e.Name())
			}
		}
	}
	var inRun *bool
	var liveSince []int
	earlierRun := func(spec string) bool {
		if inRun == nil {
			v := hookio.IsRunPhase(hookio.ReadPhase(root))
			inRun = &v
		}
		if !*inRun {
			return false
		}
		if liveSince == nil {
			liveSince = []int{}
			for _, slug := range live {
				if hookio.Exists(filepath.Join(specflowDir, slug, "spec.md")) && !sc.get().atBase[slug+"/spec.md"] {
					liveSince = append(liveSince, writtenAt(slug+"/spec.md"))
				}
			}
		}
		for _, since := range liveSince {
			if since > writtenAt(spec) {
				return true
			}
		}
		return false
	}

	// ---- a heading shaped like a requirement is one -----------------------
	// One the base already has is not this branch's (ADR-048); with no base,
	// nothing tells whose it is, so it fails.
	headingsAtBase := map[string]map[string]bool{}
	baseHas := func(r, line string) bool {
		if _, ok := headingsAtBase[r]; !ok {
			set := map[string]bool{}
			for _, l := range strings.Split(specshape.WithoutCode(gitscope.FileAtBase(root, sc.get().ref, r)), "\n") {
				set[strings.TrimSpace(l)] = true
			}
			headingsAtBase[r] = set
		}
		return headingsAtBase[r][line]
	}
	var inheritedHeadings []string
	for _, h := range shapedHeadings {
		if _, declared := requirements[h.token]; specshape.IsID(h.token) && (h.level == 3 || declared) {
			continue
		}
		msg := fmt.Sprintf("%s: \"%s\" is no requirement the engine reads, so no test is bound to it. A requirement is a `### REQ-<CAP>-0NN — <title>` heading: three hashes, the id in capitals, three digits.", h.rel, h.line)
		if sc.get().err == nil && baseHas(h.rel, h.line) {
			inheritedHeadings = append(inheritedHeadings, msg)
		} else {
			problems = append(problems, msg)
		}
	}

	// ---- the archive declares what became of each change ------------------
	var archived []string
	if entries, err := os.ReadDir(archiveDir); err == nil {
		for _, e := range entries {
			if hookio.IsDir(filepath.Join(archiveDir, e.Name())) {
				archived = append(archived, e.Name())
			}
		}
	}
	for _, slug := range archived {
		specPath := filepath.Join(archiveDir, slug, "spec.md")
		// A change folded onto a folder the archive already had lands inside it.
		entries, _ := os.ReadDir(filepath.Join(archiveDir, slug))
		for _, e := range entries {
			nested := "archive/" + slug + "/" + e.Name() + "/spec.md"
			if !hookio.Exists(filepath.Join(specflowDir, filepath.FromSlash(nested))) {
				continue
			}
			if sc.get().err != nil {
				unscoped = append(unscoped, "specflow/"+nested)
				continue
			}
			if inherited(nested) {
				continue
			}
			msg := fmt.Sprintf("specflow/archive/%s/%s/ holds a change spec inside another change's folder: a fold moved a change onto a name the archive already had, where no archive check reads it. Move it to specflow/archive/<a name of its own>/.", slug, e.Name())
			if earlierRun(nested) {
				earlier = append(earlier, msg)
			} else {
				problems = append(problems, msg)
			}
		}
		body, ok := hookio.ReadText(specPath)
		if !ok {
			problems = append(problems, fmt.Sprintf("specflow/archive/%s/ has no spec.md. An archived change with no spec is a folder nobody can interpret.", slug))
			continue
		}
		if !specshape.ArchiveStatus.Test(body) {
			problems = append(problems, rel(root, specPath)+": no status. Add `**Status:** SHIPPED|REJECTED|SUPERSEDED <YYYY-MM-DD>` under the heading, so a reader can tell what became of this change without digging through git history.")
		}
	}

	// Two archived folders a case apart are one on macOS and Windows.
	byName := map[string][]string{}
	var names []string
	for _, slug := range archived {
		k := strings.ToLower(slug)
		if _, ok := byName[k]; !ok {
			names = append(names, k)
		}
		byName[k] = append(byName[k], slug)
	}
	for _, k := range names {
		same := byName[k]
		for i, a := range same {
			for _, b := range same[i+1:] {
				if sc.get().err != nil {
					unscoped = append(unscoped, "specflow/archive/"+a+"/", "specflow/archive/"+b+"/")
					continue
				}
				var ours []string
				for _, slug := range []string{a, b} {
					if !inherited("archive/" + slug + "/spec.md") {
						ours = append(ours, slug)
					}
				}
				if len(ours) == 0 {
					continue
				}
				allEarlier := true
				for _, slug := range ours {
					if !earlierRun("archive/" + slug + "/spec.md") {
						allEarlier = false
					}
				}
				msg := fmt.Sprintf("specflow/archive/%s/ and specflow/archive/%s/ differ only in case: on macOS and Windows they are one folder, where one change lands inside the other. Give one a name of its own.", a, b)
				if allEarlier {
					earlier = append(earlier, msg)
				} else {
					problems = append(problems, msg)
				}
			}
		}
	}

	// ---- a live change spec stays light -----------------------------------
	type archivedSpec struct{ slug, body string }
	var archivedSpecs []archivedSpec
	var archivedBodies []string
	for _, slug := range archived {
		if body, ok := hookio.ReadText(filepath.Join(archiveDir, slug, "spec.md")); ok {
			archivedSpecs = append(archivedSpecs, archivedSpec{slug, body})
			archivedBodies = append(archivedBodies, body)
		}
	}
	var liveBodies []string
	for _, slug := range live {
		body, ok := hookio.ReadText(filepath.Join(specflowDir, slug, "spec.md"))
		if !ok {
			continue // a folder mid-write is not a failure
		}
		liveBodies = append(liveBodies, body)
		problems = append(problems, specshape.LiveSpecProblems(slug, body, hookio.Exists(filepath.Join(specflowDir, slug, "proposal.md")), archivedBodies)...)
		if specshape.IsFixBrief(body) || !cfg.Trace.RequireSkillsField {
			continue
		}
		// `none` is an answer; an absent or EMPTY `Skills:` cannot be told from
		// a planner that never looked. Off unless the contract asks for it.
		dir := filepath.Join(specflowDir, slug, "milestones")
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue // no plan yet
		}
		var files []string
		for _, e := range entries {
			if strings.HasSuffix(e.Name(), ".md") {
				files = append(files, e.Name())
			}
		}
		sort.Strings(files)
		for _, f := range files {
			text, _ := hookio.ReadText(filepath.Join(dir, f))
			if !skillsField.MatchString(text) {
				problems = append(problems, fmt.Sprintf("specflow/%s/milestones/%s has no `Skills:` field, or has one with nothing after the colon. Every milestone says which skills it needs — `none` when the answer is none, which is what a project shipping no skills always writes. Neither absent nor empty is that answer: the implementer cannot tell either apart from a planner that never looked, and loads nothing in all three cases.", slug, f))
			}
		}
	}

	// ---- a SHIPPED change's deltas landed in specs/ ------------------------
	// An ADDED that never reached `specs/` is bound to no test. Only the
	// changes this branch ships (ADR-048).
	var shipped []archivedSpec
	for _, a := range archivedSpecs {
		if specshape.IsShipped(a.body) && specshape.ReqTag.Test(a.body) {
			shipped = append(shipped, a)
		}
	}
	if len(specFiles) > 0 && len(shipped) > 0 {
		if sc.get().err != nil {
			for _, s := range shipped {
				unscoped = append(unscoped, "specflow/archive/"+s.slug+"/spec.md")
			}
		} else {
			// Retired by any change, inherited ones too: what a later change removed is not missing.
			retired := map[string]bool{}
			for _, b := range append(bodiesOf(shipped), liveBodies...) {
				for _, id := range specshape.RetiredIDs(b) {
					retired[id] = true
				}
			}
			for _, s := range shipped {
				if inherited("archive/" + s.slug + "/spec.md") {
					continue
				}
				r := "specflow/archive/" + s.slug + "/spec.md"
				add := func(msg string) {
					if earlierRun("archive/" + s.slug + "/spec.md") {
						earlier = append(earlier, msg)
					} else {
						problems = append(problems, msg)
					}
				}
				if section := specshape.DeltasSectionProblem(s.body, true); section != "" {
					add(r + " " + section)
				}
				for _, u := range specshape.UnreadDeltas(s.body) {
					add(r + ": " + specshape.ExplainUnread(u))
				}
				for _, d := range specshape.Deltas(s.body) {
					req, declared := requirements[d.ID]
					if d.Verb == "ADDED" && !declared && !retired[d.ID] {
						add(fmt.Sprintf("%s is ADDED by %s, stamped SHIPPED, but no capability spec under %s/ declares it — so no test is bound to it, and nothing proves it. ", d.ID, r, cfg.Trace.SpecsDir) +
							fmt.Sprintf("The milestone that delivers it writes it into %s/<capability>.md with the test that proves it; a change that did not deliver it is not SHIPPED as written.", cfg.Trace.SpecsDir))
					}
					if d.Verb == "REMOVED" && declared {
						add(fmt.Sprintf("%s is REMOVED by %s, stamped SHIPPED, but %s still declares it. Delete it there, and the test that reports it.", d.ID, r, req.spec))
					}
				}
			}
		}
	}

	if len(unscoped) > 0 {
		these := "this is"
		if len(unscoped) > 1 {
			these = "these are"
		}
		problems = append(problems, fmt.Sprintf("%s: whether %s this branch's or inherited needs the base, and %v", strings.Join(unscoped, ", "), these, sc.get().err))
	}
	for _, p := range earlier {
		fmt.Fprintf(stdout, "spec-trace: held from the fold's gate on, not before — an earlier run of this branch: %s\n", p)
	}
	for _, p := range inheritedHeadings {
		fmt.Fprintf(stdout, "spec-trace: not failed — the base branch already has it, so it is not this branch's: %s\n", p)
	}

	// ---- report -------------------------------------------------------------
	// An empty `specs/` is right while adopting: capability specs are WRITTEN
	// by the flow. It stops being right at the first SHIPPED change that
	// claimed a requirement: that stamp asserts deltas landed where nothing is.
	// The grace covers the binding only, and falls through to the rest.
	graced := false
	if len(specFiles) == 0 {
		if len(shipped) == 0 {
			fmt.Fprintf(stdout, "spec-trace: no capability specs under %s/ and nothing shipped yet — no requirements to bind. "+
				"This grace ends at the first SHIPPED change: capability specs are what a fold writes. Everything else below is still checked.\n", cfg.Trace.SpecsDir)
			graced = true
		} else {
			problems = append(problems, fmt.Sprintf("%d change(s) are stamped SHIPPED (%s) but %s/ holds no capability spec. ", len(shipped), strings.Join(slugsOf(shipped), ", "), cfg.Trace.SpecsDir)+
				"A fold stamps SHIPPED to assert its deltas landed there, so either they never did, or the specs were written somewhere this contract does not look — "+
				"check trace.specs_dir. Until this is resolved every requirement check here is vacuous: with no requirements to bind, this script reports green over a spec layer that does not exist.")
		}
	}

	if list {
		for _, file := range specFiles {
			r := rel(root, file)
			fmt.Fprintf(stdout, "\n%s\n", r)
			for _, id := range reqOrder {
				req := requirements[id]
				if req.spec != r {
					continue
				}
				if proof, ok := proofs[id]; ok {
					fmt.Fprintf(stdout, "  OK   %s  %s\n         proven by %s\n", id, req.title, strings.Join(proof, ", "))
				} else {
					fmt.Fprintf(stdout, "  MISS %s  %s\n", id, req.title)
				}
			}
		}
		fmt.Fprintln(stdout)
	}

	if len(problems) > 0 {
		fmt.Fprint(stderr, "spec-trace: the spec layer and the code disagree.\n\n")
		for _, p := range problems {
			fmt.Fprintf(stderr, "  - %s\n", p)
		}
		fmt.Fprintf(stderr, "\n%d problem(s).\n", len(problems))
		return 1
	}
	// Not over zero requirements, nor over an unanswered question, nor while
	// an earlier run's ADDED id may be bound to nothing: those greens are vacuous.
	if !graced && !unarmed && len(earlier) == 0 {
		fmt.Fprintf(stdout, "spec-trace: OK — %d requirement(s) across %d capability spec(s), every one proven by a test; %d archived change(s), every one with a status.\n", len(requirements), len(specFiles), len(archived))
	}
	return 0
}

type scope struct {
	root    string
	cfg     *contract.Config
	done    bool
	ref     string
	atBase  map[string]bool
	written map[string]int
	err     error
}

func (s *scope) get() *scope {
	if !s.done {
		s.done = true
		if ref, err := gitscope.ResolveBase(s.root, s.cfg); err != nil {
			s.err = err
		} else {
			s.ref, s.atBase, s.written = ref, gitscope.SpecsAtBase(s.root, ref), gitscope.BranchWrites(s.root, ref)
		}
	}
	return s
}

func containsStr(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func bodiesOf[T interface{ ~struct{ slug, body string } }](xs []T) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = struct{ slug, body string }(x).body
	}
	return out
}

func slugsOf[T interface{ ~struct{ slug, body string } }](xs []T) []string {
	out := make([]string, len(xs))
	for i, x := range xs {
		out[i] = struct{ slug, body string }(x).slug
	}
	return out
}

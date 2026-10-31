// Package gitscope is what a run is judged against: its repository root, its
// base, and the files the branch changed. One resolver for the gate and the
// everyday check, so "same files, same result" is structural.
package gitscope

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
)

// KindError is a refusal with a kind a caller heads its message by.
type KindError struct{ Kind, Msg string }

func (e *KindError) Error() string { return e.Msg }

// Kind is err's kind, `""` for any other error.
func Kind(err error) string {
	if k, ok := err.(*KindError); ok {
		return k.Kind
	}
	return ""
}

// SamePath says whether two spellings name one directory: by identity where
// the filesystem gives one, else by spelling — symlinks resolved, `\` read as
// `/`, case folded where the default filesystem folds it.
func SamePath(a, b string) bool {
	sa, ea := os.Stat(a)
	sb, eb := os.Stat(b)
	if ea == nil && eb == nil {
		return os.SameFile(sa, sb)
	}
	folds := runtime.GOOS == "windows" || runtime.GOOS == "darwin"
	norm := func(p string) string {
		if real, err := filepath.EvalSymlinks(p); err == nil {
			p = real
		}
		p = strings.TrimRight(strings.ReplaceAll(p, `\`, "/"), "/")
		if folds {
			p = strings.ToLower(p)
		}
		return p
	}
	return norm(a) == norm(b)
}

var notARepo = regexp.MustCompile(`(?i)not a git repository`)

// AssertRepoRoot refuses a directory inside a repository that is not its
// root, and one in no repository at all (ADR-027): git spells every path from
// the root, so from a subdirectory every committed change falls out of scope
// and lint never runs. Silent when git cannot answer: "cannot tell" is never
// why a run is refused.
func AssertRepoRoot(root string) error {
	// Matched as text, so git's language is pinned.
	res := proc.Run(proc.Options{Dir: root, Env: []string{"LC_ALL=C", "LANGUAGE=C"}}, "git", "rev-parse", "--show-toplevel")
	if res.Err != nil {
		return nil
	}
	if !res.OK() {
		if !notARepo.MatchString(res.Stderr) {
			return nil
		}
		return &KindError{"no-repository", root + " is not inside a git repository. This engine runs against one repository, opened at its root: the contract, the specs and the run's state are that repository's, and the gate runs that repository's suite — what its pipeline runs on a push is what the gate judged. " +
			"A workspace directory holding several repositories is not one of them: open Claude Code at the repository you are changing, and run `spec-flow init` there (ADR-027)."}
	}
	top := strings.TrimSpace(res.Stdout)
	if top == "" || SamePath(root, top) {
		return nil
	}
	return &KindError{"not-root", fmt.Sprintf("%s is not the root of its repository, %s. This engine reads every path from the repository root — the contract at .spec-flow/config.json, the state under .claude/state/, and every changed-file list git returns, which git spells from the root whatever directory asks. ", root, top) +
		"From a subdirectory every committed change falls out of scope and the linter is never invoked, while the history reads `lint=-`, exactly as a milestone that touched nothing reads. " +
		fmt.Sprintf("Open Claude Code at %s and keep the contract there. A package that needs its own gate and its own pipeline is its own repository (ADR-027).", top)}
}

// What is probed when neither the contract nor origin/HEAD answers.
var baseCandidates = []string{"origin/main", "main", "origin/master", "master", "origin/develop", "develop", "origin/trunk", "trunk"}

func mergeBase(root, ref string) string {
	if res := proc.Git(root, "merge-base", "HEAD", ref); res.OK() {
		return strings.TrimSpace(res.Stdout)
	}
	return ""
}

// Declaring the base does not help: the clone holds nothing to find it in.
const shallow = "A shallow or single-branch clone holds no base, declared or not: fetch it first — `fetch-depth: 0` on actions/checkout; elsewhere `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`, with `--unshallow` in a shallow clone."

// ResolveBase is the commit this branch is judged against. It errs rather
// than guesses: a base that matches nothing empties the scope, and an empty
// scope reads as "touched nothing" — a clean pass over checks never run. The
// contract's `verify.base_ref` wins, then origin/HEAD, then the candidates.
func ResolveBase(root string, cfg *contract.Config) (string, error) {
	if cfg != nil && cfg.Verify.BaseRef != "" {
		declared := cfg.Verify.BaseRef
		if base := mergeBase(root, declared); base != "" {
			return base, nil
		}
		return "", fmt.Errorf("the contract declares verify.base_ref \"%s\", and git cannot resolve a merge-base between it and HEAD. "+
			"Either the ref does not exist in this clone or the name is wrong. %s "+
			"Refusing to fall back: with no base, nothing tells what this branch changed, and a check scoped to it reads \"nothing to check\" rather than \"I do not know what to check\".", declared, shallow)
	}
	if res := proc.Git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"); res.OK() && strings.TrimSpace(res.Stdout) != "" {
		if base := mergeBase(root, strings.TrimSpace(res.Stdout)); base != "" {
			return base, nil
		}
	}
	for _, ref := range baseCandidates {
		if base := mergeBase(root, ref); base != "" {
			return base, nil
		}
	}
	return "", fmt.Errorf("no base branch could be resolved for this repo. Tried the contract's verify.base_ref (not set), refs/remotes/origin/HEAD (absent or unresolvable), and %s. "+
		"Declare the branch this work is judged against as \"base_ref\" under \"verify\" in .spec-flow/config.json — e.g. \"base_ref\": \"origin/trunk\". %s "+
		"This is a refusal to run, not a failed milestone: with no base, nothing tells what this branch changed, and every check scoped to it would report clean without ever running.", strings.Join(baseCandidates, ", "), shallow)
}

// ChangesAtBase are the live change folders under `specflow/` that base
// already holds: no run of this branch created them, and live, they keep any
// run here from earning `done` (ADR-032).
func ChangesAtBase(root, base string) []string {
	dir := filepath.Join(root, "specflow")
	if _, err := os.Stat(dir); err != nil {
		return nil
	}
	// -z: names unquoted; git quotes a non-ASCII one otherwise.
	res := proc.Git(root, "ls-tree", "-d", "-z", "--name-only", base+":specflow")
	if !res.OK() {
		return nil
	}
	there := map[string]bool{}
	for _, n := range strings.Split(res.Stdout, "\x00") {
		there[n] = true
	}
	var out []string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "archive" && there[e.Name()] && isDir(filepath.Join(dir, e.Name())) {
			out = append(out, e.Name())
		}
	}
	return out
}

func isDir(p string) bool { st, err := os.Stat(p); return err == nil && st.IsDir() }

// Every change spec under `specflow/`, live, archived or nested.
const changeSpecs = ":(glob)specflow/**/spec.md"

// SpecsAtBase are the change specs base holds, by their path from `specflow/`.
func SpecsAtBase(root, base string) map[string]bool {
	out := map[string]bool{}
	// `./` with --full-tree reads the path from root, which spec-trace does not
	// require to be the repository's top.
	res := proc.Git(root, "ls-tree", "--full-tree", "-r", "-z", "--name-only", base+":./specflow")
	if !res.OK() {
		return out
	}
	for _, p := range strings.Split(res.Stdout, "\x00") {
		if p == "spec.md" || strings.HasSuffix(p, "/spec.md") {
			out[p] = true
		}
	}
	return out
}

// FileAtBase is a file as base holds it, by its path from root; `""` when absent.
func FileAtBase(root, base, rel string) string {
	res := proc.Git(root, "show", base+":./"+filepath.ToSlash(rel))
	if res.OK() {
		return res.Stdout
	}
	return ""
}

// Uncommitted is when an uncommitted change spec was written: after every commit.
const Uncommitted = int(^uint(0) >> 1)

var commitID = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

// BranchWrites are the change specs this branch wrote since base, by path
// from root, each with the place of the first commit that did, oldest 0 —
// Uncommitted for one not committed yet (ADR-048).
func BranchWrites(root, base string) map[string]int {
	written := map[string]int{}
	log := proc.Git(root, "log", "--reverse", "--topo-order", "--no-renames", "--diff-filter=AM", "--format=%x00%H", "--name-only", "-z", "--relative", base+"..HEAD", "--", changeSpecs)
	if log.OK() {
		commit, previous := -1, ""
		for _, token := range strings.Split(log.Stdout, "\x00") {
			path := strings.TrimPrefix(token, "\n")
			if previous == "" && commitID.MatchString(token) {
				commit++
			} else if _, seen := written[path]; path != "" && !seen {
				written[path] = commit
			}
			previous = token
		}
	}
	if res := proc.Git(root, "diff", "--name-only", "-z", "--relative", "--no-renames", "--diff-filter=AM", "HEAD", "--", changeSpecs); res.OK() {
		for _, path := range strings.Split(res.Stdout, "\x00") {
			if _, seen := written[path]; path != "" && !seen {
				written[path] = Uncommitted
			}
		}
	}
	return written
}

// ChangedFiles is the union of the branch's committed and working-tree
// changes, the staged ones and the untracked files, minus deletions. base is
// required: a default resolved here would never see `verify.base_ref`.
func ChangedFiles(root string, scopeGlobs []string, base string) []string {
	lists := []proc.Result{
		proc.Git(root, append([]string{"diff", "--name-only", "--diff-filter=ACMR", base, "--"}, scopeGlobs...)...),
		proc.Git(root, append([]string{"diff", "--name-only", "--diff-filter=ACMR", "--cached", "--"}, scopeGlobs...)...),
		proc.Git(root, append([]string{"ls-files", "--others", "--exclude-standard", "--"}, scopeGlobs...)...),
	}
	set := map[string]bool{}
	for _, res := range lists {
		if !res.OK() {
			continue
		}
		for _, f := range strings.Split(res.Stdout, "\n") {
			f = strings.TrimSpace(f)
			if f == "" {
				continue
			}
			if st, err := os.Stat(filepath.Join(root, f)); err == nil && st.Mode().IsRegular() {
				set[f] = true
			}
		}
	}
	files := make([]string, 0, len(set))
	for f := range set {
		files = append(files, f)
	}
	sort.Strings(files)
	return files
}

// ScopeMatchesNothing says whether scopeGlobs matches nothing this repository
// tracks: a contract whose lint was never going to run, as opposed to a
// milestone that touched nothing in scope. A git that cannot answer is false:
// this decides whether a gate REFUSES.
func ScopeMatchesNothing(root string, scopeGlobs []string) bool {
	res := proc.Git(root, append([]string{"ls-files", "--"}, scopeGlobs...)...)
	return res.OK() && strings.TrimSpace(res.Stdout) == ""
}

// InScope says whether a path, absolute or from root, is one the gate's
// scope_globs select — matched as git matches a pathspec, so the write-time
// readers and the gate cannot disagree about what is in scope.
func InScope(root, path string, scopeGlobs []string) bool {
	rel := path
	if filepath.IsAbs(path) {
		r, err := filepath.Rel(root, path)
		if err != nil {
			return false
		}
		if realRoot, e1 := filepath.EvalSymlinks(root); e1 == nil && strings.HasPrefix(r, "..") {
			if realPath, e2 := filepath.EvalSymlinks(path); e2 == nil {
				if r2, e3 := filepath.Rel(realRoot, realPath); e3 == nil {
					r = r2
				}
			}
		}
		rel = r
	}
	rel = filepath.ToSlash(rel)
	if rel == "" || rel == "." || strings.HasPrefix(rel, "../") || rel == ".." {
		return false
	}
	for _, g := range scopeGlobs {
		if Pathspec(g, rel) {
			return true
		}
	}
	return false
}

// Pathspec reports whether git would select path (from the root, with `/`) by
// spec, a pathspec with no magic: the path itself; else, with no wildcard, a
// directory prefix; else a match where `*` and `?` cross `/`.
func Pathspec(spec, path string) bool {
	if spec == path {
		return true
	}
	if !strings.ContainsAny(spec, `*?[\`) {
		if strings.HasSuffix(spec, "/") {
			return strings.HasPrefix(path, spec)
		}
		return strings.HasPrefix(path, spec+"/")
	}
	return wildmatch(spec, path)
}

// wildmatch is fnmatch(3) without FNM_PATHNAME, as git applies a pathspec.
func wildmatch(p, s string) bool {
	if p == "" {
		return s == ""
	}
	switch p[0] {
	case '*':
		for i := 0; i <= len(s); i++ {
			if wildmatch(p[1:], s[i:]) {
				return true
			}
		}
		return false
	case '?':
		return s != "" && wildmatch(p[1:], s[1:])
	case '[':
		if s == "" {
			return false
		}
		if ok, rest, valid := bracket(p, s[0]); valid {
			return ok && wildmatch(rest, s[1:])
		}
		return s[0] == '[' && wildmatch(p[1:], s[1:])
	case '\\':
		if len(p) > 1 {
			return s != "" && s[0] == p[1] && wildmatch(p[2:], s[1:])
		}
	}
	return s != "" && s[0] == p[0] && wildmatch(p[1:], s[1:])
}

// bracket matches c against the class p opens, returning the pattern after it.
func bracket(p string, c byte) (matched bool, rest string, valid bool) {
	i := 1
	negate := false
	if i < len(p) && (p[i] == '!' || p[i] == '^') {
		negate = true
		i++
	}
	first := true
	for i < len(p) {
		if p[i] == ']' && !first {
			return matched != negate, p[i+1:], true
		}
		first = false
		lo := p[i]
		if lo == '\\' && i+1 < len(p) {
			i++
			lo = p[i]
		}
		hi := lo
		if i+2 < len(p) && p[i+1] == '-' && p[i+2] != ']' {
			hi = p[i+2]
			i += 2
		}
		if lo <= c && c <= hi {
			matched = true
		}
		i++
	}
	return false, "", false
}

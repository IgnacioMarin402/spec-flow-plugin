// Package repocheck holds the checks this repository runs on itself: claims
// its prose and its code make about each other, which no compiler and no
// fixture of the engine's behaviour would notice going stale. Each takes the
// root of a tree, so a fixture can hand it one built to fail.
package repocheck

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Report is one check's verdict: problems, or what it read when there are none.
type Report struct {
	Name     string
	Problems []string
	OK       string
	Advice   string
}

func (r Report) String() string {
	if len(r.Problems) == 0 {
		return r.Name + ": OK — " + r.OK
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s: %d problem(s).\n\n", r.Name, len(r.Problems))
	for _, p := range r.Problems {
		b.WriteString("  - " + p + "\n")
	}
	if r.Advice != "" {
		b.WriteString("\n" + r.Advice + "\n")
	}
	return b.String()
}

// walk is every file under root/dir whose name ends in one of exts, as a
// slash path from root, sorted; skip names directories not to enter.
func walk(root, dir string, exts []string, skip ...string) []string {
	var found []string
	filepath.WalkDir(filepath.Join(root, filepath.FromSlash(dir)), func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel := slash(root, p)
		if d.IsDir() {
			for _, s := range skip {
				if rel == s {
					return filepath.SkipDir
				}
			}
			return nil
		}
		for _, e := range exts {
			if strings.HasSuffix(d.Name(), e) {
				found = append(found, rel)
				break
			}
		}
		return nil
	})
	sort.Strings(found)
	return found
}

// surfaces is every file a scan claims: the extensions under dirs, and the
// files named outright that exist, never self.
func surfaces(root string, dirs, exts, files []string, self string, skip ...string) []string {
	var all []string
	for _, d := range dirs {
		all = append(all, walk(root, d, exts, skip...)...)
	}
	for _, f := range files {
		if st, err := os.Stat(filepath.Join(root, filepath.FromSlash(f))); err == nil && !st.IsDir() {
			all = append(all, f)
		}
	}
	out := all[:0]
	for _, f := range all {
		if f != self {
			out = append(out, f)
		}
	}
	return out
}

func slash(root, p string) string {
	rel, err := filepath.Rel(root, p)
	if err != nil {
		return filepath.ToSlash(p)
	}
	return filepath.ToSlash(rel)
}

func readRel(root, rel string) string {
	b, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
	return string(b)
}

func exists(root, rel string) bool {
	_, err := os.Stat(filepath.Join(root, filepath.FromSlash(rel)))
	return err == nil
}

// mdIn is the .md files directly in root/dir, sorted.
func mdIn(root, dir string) []string {
	entries, _ := os.ReadDir(filepath.Join(root, dir))
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".md") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

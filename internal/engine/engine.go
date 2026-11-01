// Package engine answers which copy of this engine is running: its root, the
// directory that ships `agents/`, `modes/` and the binary — never the
// consuming repository — and its revision.
package engine

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
)

// Root is the engine copy that is running: the nearest directory above the
// binary holding `.claude-plugin/plugin.json`. What it names has to be the
// copy that RAN, whatever the consuming repository has installed.
func Root() string {
	if exe, err := os.Executable(); err == nil {
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		for dir := filepath.Dir(exe); ; dir = filepath.Dir(dir) {
			if _, err := os.Stat(filepath.Join(dir, ".claude-plugin", "plugin.json")); err == nil {
				return dir
			}
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}
	if d := os.Getenv("CLAUDE_PLUGIN_ROOT"); d != "" {
		return d
	}
	exe, _ := os.Executable()
	return filepath.Dir(exe)
}

var revision = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// Revision is the commit of the copy at root, spelled so two builds cannot
// answer the same (ADR-018). `v?` when none resolves: the `v` is what stops a
// fallback being read as a short sha.
func Revision(root string) string {
	// Only a checkout whose root IS this copy: git looks upward, and a copy
	// inside some other repository would report that repository's HEAD.
	if top := proc.Git(root, "rev-parse", "--show-toplevel"); top.OK() && gitscope.SamePath(root, strings.TrimSpace(top.Stdout)) {
		if res := proc.Git(root, "rev-parse", "--short=12", "HEAD"); res.OK() {
			if sha := strings.TrimSpace(res.Stdout); revision.MatchString(sha) {
				return sha
			}
		}
	}
	// A marketplace install has no `.git`: Claude Code copies the commit into
	// a cache directory named for it, with no `version` declared (ADR-003).
	abs, _ := filepath.Abs(root)
	if dir := filepath.Base(abs); revision.MatchString(dir) {
		return dir
	}
	return "v?"
}

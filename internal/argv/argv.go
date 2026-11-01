// Package argv reads an argv the contract declares: which token is the
// binary, and which trailing tokens are targets the engine must not inherit.
// argv[0] is not always an interpreter: for `["eslint", "."]` the binary is
// `eslint`, not `.`.
package argv

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// Runtimes run something else. `node <script>` runs the tests, and "node" is
// not the name of a test runner.
var Runtimes = map[string]bool{
	"node": true, "bun": true, "deno": true, "python": true, "python3": true, "ruby": true,
	"php": true, "go": true, "cargo": true, "dotnet": true, "java": true,
}

// BinaryOf: `["node", ".bin/eslint", "--fix"]` -> `.bin/eslint`; `["eslint", "."]` -> `eslint`.
func BinaryOf(argv []string) string {
	if len(argv) == 0 || argv[0] == "" {
		return ""
	}
	if Runtimes[argv[0]] && len(argv) > 1 && argv[1] != "" && !strings.HasPrefix(argv[1], "-") {
		return argv[1]
	}
	return argv[0]
}

var (
	dirPart = regexp.MustCompile(`^.*[\\/]`)
	jsExt   = regexp.MustCompile(`\.[cm]?js$`)
)

// Basename is a token's last path segment, either separator.
func Basename(tok string) string { return dirPart.ReplaceAllString(tok, "") }

// ToolAt is the tool a shell command runs from tokens[i]: that token's
// basename, or for `node [node's flags] <script>` the script's minus `.js`.
// `node --experimental-vm-modules node_modules/jest/bin/jest.js` runs jest,
// the form init writes, so no-gate-cmds and run-trace read it here.
func ToolAt(tokens []string, i int) (index int, name string) {
	at := func(k int) string {
		if k < len(tokens) {
			return tokens[k]
		}
		return ""
	}
	if at(i) != "node" {
		return i, Basename(at(i))
	}
	j := i + 1
	for strings.HasPrefix(at(j), "-") {
		j++
	}
	return j, jsExt.ReplaceAllString(Basename(at(j)), "")
}

var targetShaped = regexp.MustCompile(`[\\/*]`)

// LooksLikeTarget: `.`, `./`, anything with a separator or a glob star, and an
// actual directory. NOT every token with a dot: `--ext .ts` ends in `.ts`.
func LooksLikeTarget(token, root string) bool {
	if token == "" || strings.HasPrefix(token, "-") {
		return false
	}
	if token == "." || token == "./" || targetShaped.MatchString(token) {
		return true
	}
	st, err := os.Stat(filepath.Join(root, token))
	return err == nil && st.IsDir()
}

// StripTargets drops the targets from an argv the engine appends file paths
// to: `eslint . <file>` lints the whole repository, which is a DISARMED scope,
// not a slow one. A token is dropped only when the one before it is not a
// flag — the only evidence it is a target and not a flag's value. `eslint
// --fix .` is therefore KEPT, and returned in remaining for the caller to say.
func StripTargets(argv []string, root string) (kept, stripped, remaining []string) {
	kept, stripped, remaining = []string{}, []string{}, []string{}
	for i, tok := range argv {
		followsFlag := i > 0 && strings.HasPrefix(argv[i-1], "-")
		if !followsFlag && LooksLikeTarget(tok, root) {
			stripped = append(stripped, tok)
			continue
		}
		kept = append(kept, tok)
	}
	for _, t := range kept {
		if LooksLikeTarget(t, root) {
			remaining = append(remaining, t)
		}
	}
	return kept, stripped, remaining
}

func toPosix(p string) string { return strings.ReplaceAll(p, `\`, "/") }

var shimExec = regexp.MustCompile(`exec\s+(?:node|"\$basedir/node")\s+(?:[^\s"]+\s+)*"\$basedir/([^"]+)"`)

// ResolveLocalBin is where a locally installed bin's real JavaScript lives,
// repo-relative with `/`, or `""` when it cannot be resolved. npm writes a
// symlink on POSIX and a `#!/bin/sh` shim on Windows, so `node
// node_modules/.bin/eslint` runs on one and is a SyntaxError on the other;
// resolving past the shim is what makes a committed contract agree (ADR-011).
func ResolveLocalBin(root, binName string) string {
	shim := filepath.Join(root, "node_modules", ".bin", binName)
	st, err := os.Lstat(shim)
	if err != nil {
		return ""
	}
	if st.Mode()&os.ModeSymlink != 0 {
		real, err := filepath.EvalSymlinks(shim)
		if err != nil {
			return ""
		}
		return relPosix(root, real)
	}
	b, err := os.ReadFile(shim)
	if err != nil {
		return ""
	}
	// Keyed on the interpreter, not the first path: `$basedir/node` sits on
	// the same line, and what it runs is JavaScript whatever its name.
	m := shimExec.FindStringSubmatch(string(b))
	if m == nil {
		return ""
	}
	full := filepath.Join(filepath.Dir(shim), filepath.FromSlash(m[1]))
	if _, err := os.Stat(full); err != nil {
		return ""
	}
	return relPosix(root, full)
}

func relPosix(root, path string) string {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		realRoot = root
	}
	rel, err := filepath.Rel(realRoot, path)
	if err != nil {
		if rel, err = filepath.Rel(root, path); err != nil {
			return ""
		}
	}
	return toPosix(rel)
}

var drive = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// ResolvableOnDisk: a bare command name resolves through PATH and has no
// file to find, so a caller treating "not found" as "not installed" would
// disable itself on such a repository for good.
func ResolvableOnDisk(binary, root string) (checkable, present bool) {
	if binary == "" {
		return false, false
	}
	exists := func(p string) bool { _, err := os.Stat(p); return err == nil }
	if strings.HasPrefix(binary, "/") || drive.MatchString(binary) {
		return true, exists(binary)
	}
	if strings.ContainsAny(binary, `\/`) {
		return true, exists(filepath.Join(root, binary))
	}
	return false, false
}

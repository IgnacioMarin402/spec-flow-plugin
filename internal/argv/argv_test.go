package argv

// Which token is the binary was once a positional guess, which made the
// binary of `["eslint", "."]` the target `.`. And ResolveLocalBin's two
// branches are split by platform in production — npm writes a symlink on
// POSIX and a `#!/bin/sh` shim on Windows — so here both are a directory this
// file builds, and each runs on every platform.

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// packageEntry is the package half of a local install: real JavaScript at a real path.
func packageEntry(t *testing.T, dir, pkg, entry string) {
	t.Helper()
	target := filepath.Join(dir, "node_modules", pkg, filepath.FromSlash(entry))
	os.MkdirAll(filepath.Dir(target), 0o755)
	os.WriteFile(target, []byte("process.exit(0);\n"), 0o644)
	os.MkdirAll(filepath.Join(dir, "node_modules", ".bin"), 0o755)
}

func shim(t *testing.T, dir, name, text string) {
	t.Helper()
	os.MkdirAll(filepath.Join(dir, "node_modules", ".bin"), 0o755)
	os.WriteFile(filepath.Join(dir, "node_modules", ".bin", name), []byte(text), 0o755)
}

func TestBinaryOf(t *testing.T) {
	for _, c := range []struct {
		argv []string
		want string
	}{
		{[]string{"node", "node_modules/eslint/bin/eslint.js"}, "node_modules/eslint/bin/eslint.js"},
		{[]string{"eslint", "."}, "eslint"},       // a target, not a binary
		{[]string{"eslint", "--cache"}, "eslint"}, // a flag, not a binary
		{[]string{"node", "--test"}, "node"},      // a runtime followed by a flag runs itself
		{nil, ""},
	} {
		if got := BinaryOf(c.argv); got != c.want {
			t.Errorf("BinaryOf(%q) = %q, want %q", c.argv, got, c.want)
		}
	}
	for runtime := range Runtimes {
		if got := BinaryOf([]string{runtime, "script.js"}); got != "script.js" {
			t.Errorf("%s did not defer to its script: %q", runtime, got)
		}
	}
}

func TestToolAt(t *testing.T) {
	for _, c := range []struct {
		tokens []string
		from   int
		index  int
		name   string
	}{
		// `init` writes `node <entrypoint>`, and a runner may need node's flags ahead of it.
		{[]string{"node", "--experimental-vm-modules", "node_modules/jest/bin/jest.js", "tests/a.spec.ts"}, 0, 2, "jest"},
		{[]string{"jest", "tests/a.spec.ts"}, 0, 0, "jest"},
		{[]string{"node_modules/.bin/vitest", "run"}, 0, 0, "vitest"},
		{[]string{"pnpm", "exec", "node", "node_modules/mocha/bin/mocha.cjs"}, 2, 3, "mocha"},
		{[]string{"node", "--test"}, 0, 2, ""},
	} {
		if i, n := ToolAt(c.tokens, c.from); i != c.index || n != c.name {
			t.Errorf("ToolAt(%q, %d) = %d %q, want %d %q", c.tokens, c.from, i, n, c.index, c.name)
		}
	}
}

func TestLooksLikeTarget(t *testing.T) {
	dir := t.TempDir()
	os.Mkdir(filepath.Join(dir, "lib"), 0o755)
	for tok, want := range map[string]bool{
		"--fix": false, ".": true, "./": true, "lib/x": true, "*.ts": true,
		// `--ext .ts`: a flag's VALUE, and stripping it changes what the linter checks.
		".ts": false,
		"lib": true, // a real directory in the repository
	} {
		if got := LooksLikeTarget(tok, dir); got != want {
			t.Errorf("LooksLikeTarget(%q) = %v, want %v", tok, got, want)
		}
	}
}

func TestStripTargets(t *testing.T) {
	dir := t.TempDir()
	for _, c := range []struct {
		argv, kept, stripped, remaining []string
	}{
		{[]string{".", "--fix"}, []string{"--fix"}, []string{"."}, nil},
		// Without each linter's flag grammar, "follows a flag" is the only
		// evidence a path-shaped token is a value.
		{[]string{"--ignore-path", "dist"}, []string{"--ignore-path", "dist"}, nil, nil},
		// Guessing wrong changes what the linter checks: kept, and reported.
		{[]string{"--fix", "."}, []string{"--fix", "."}, nil, []string{"."}},
	} {
		kept, stripped, remaining := StripTargets(c.argv, dir)
		if !reflect.DeepEqual(kept, c.kept) || len(stripped) != len(c.stripped) || len(remaining) != len(c.remaining) ||
			(len(c.stripped) > 0 && !reflect.DeepEqual(stripped, c.stripped)) || (len(c.remaining) > 0 && !reflect.DeepEqual(remaining, c.remaining)) {
			t.Errorf("StripTargets(%q) = %q %q %q, want %q %q %q", c.argv, kept, stripped, remaining, c.kept, c.stripped, c.remaining)
		}
	}
}

func TestResolveLocalBin(t *testing.T) {
	cases := []struct {
		name, bin, want string
		setup           func(t *testing.T, dir string)
	}{
		{"reads the entrypoint out of a sh shim", "eslint", "node_modules/eslint/bin/eslint.js", func(t *testing.T, dir string) {
			packageEntry(t, dir, "eslint", "bin/eslint.js")
			shim(t, dir, "eslint", "#!/bin/sh\nbasedir=$(dirname \"$0\")\nif [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \"$basedir/../eslint/bin/eslint.js\" \"$@\"\nelse\n  exec node  \"$basedir/../eslint/bin/eslint.js\" \"$@\"\nfi\n")
		}},
		// `$basedir/node` sits on the same line: the first path is the interpreter.
		{"does not mistake $basedir/node for the entrypoint", "vitest", "node_modules/vitest/dist/cli.js", func(t *testing.T, dir string) {
			packageEntry(t, dir, "vitest", "dist/cli.js")
			shim(t, dir, "vitest", "#!/bin/sh\nexec \"$basedir/node\"  \"$basedir/../vitest/dist/cli.js\" \"$@\"\n")
		}},
		// typescript declares `bin/tsc`; the shim runs it with node.
		{"an extensionless entrypoint the shim runs with node resolves", "tsc", "node_modules/typescript/bin/tsc", func(t *testing.T, dir string) {
			packageEntry(t, dir, "typescript", "bin/tsc")
			shim(t, dir, "tsc", "#!/bin/sh\nbasedir=$(dirname \"$0\")\nif [ -x \"$basedir/node\" ]; then\n  exec \"$basedir/node\"  \"$basedir/../typescript/bin/tsc\" \"$@\"\nelse \n  exec node  \"$basedir/../typescript/bin/tsc\" \"$@\"\nfi\n")
		}},
		{"a shim passing node flags still resolves to the entrypoint", "x", "node_modules/x/bin/x.js", func(t *testing.T, dir string) {
			packageEntry(t, dir, "x", "bin/x.js")
			shim(t, dir, "x", "#!/bin/sh\nexec node --no-warnings --max-old-space-size=4096 \"$basedir/../x/bin/x.js\" \"$@\"\n")
		}},
		{"a bin that is not installed resolves to nothing", "eslint", "", func(t *testing.T, dir string) {}},
		// A native binary has no entrypoint: "" keeps the bare command name.
		{"a shim with no JavaScript behind it resolves to nothing", "ruff", "", func(t *testing.T, dir string) {
			shim(t, dir, "ruff", "#!/bin/sh\nexec \"$basedir/../ruff/ruff\" \"$@\"\n")
		}},
		{"a shim pointing at a missing file resolves to nothing", "eslint", "", func(t *testing.T, dir string) {
			shim(t, dir, "eslint", "#!/bin/sh\nexec node \"$basedir/../eslint/bin/eslint.js\"\n")
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			c.setup(t, dir)
			got := ResolveLocalBin(dir, c.bin)
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
			// The contract is committed: the separator is never the writing machine's.
			if strings.Contains(got, `\`) {
				t.Fatalf("a host separator: %q", got)
			}
		})
	}
	t.Run("the POSIX shape resolves through the symlink", func(t *testing.T) {
		dir := t.TempDir()
		packageEntry(t, dir, "eslint", "bin/eslint.js")
		if err := os.Symlink(filepath.Join("..", "eslint", "bin", "eslint.js"), filepath.Join(dir, "node_modules", ".bin", "eslint")); err != nil {
			t.Skip("symlinks not permitted on this machine")
		}
		if got := ResolveLocalBin(dir, "eslint"); got != "node_modules/eslint/bin/eslint.js" {
			t.Fatalf("got %q", got)
		}
	})
}

// Command build writes the engine's binaries into bin/, one for each platform
// the launcher (bin/spec-flow) names, from the source in this checkout:
//
//	go run ./internal/build
//
// They are committed because the plugin is installed as a copy of this
// repository and runs with no toolchain on the machine (ADR-051). Each build
// is reproducible — the same source and Go release give the same bytes on any
// host — which is what lets a test hold the committed files to the source.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
)

// targets are the platforms the launcher names; Windows runs its binary
// directly, where `bin/spec-flow` resolves to `bin/spec-flow.exe`.
var targets = []struct{ goos, goarch, out string }{
	{"linux", "amd64", "bin/linux-amd64/spec-flow"},
	{"linux", "arm64", "bin/linux-arm64/spec-flow"},
	{"darwin", "amd64", "bin/darwin-amd64/spec-flow"},
	{"darwin", "arm64", "bin/darwin-arm64/spec-flow"},
	{"windows", "amd64", "bin/spec-flow.exe"},
}

var goLine = regexp.MustCompile(`(?m)^go (\S+)$`)

// toolchain is the Go release go.mod names: another release compiles the
// same source to other bytes.
func toolchain(root string) (string, error) {
	b, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		return "", err
	}
	m := goLine.FindSubmatch(b)
	if m == nil {
		return "", fmt.Errorf("go.mod names no go release")
	}
	return "go" + string(m[1]), nil
}

// build writes every target under out, from the module at root. Everything
// the bytes depend on is set here, never inherited from the shell.
func build(root, out string) error {
	release, err := toolchain(root)
	if err != nil {
		return err
	}
	for _, t := range targets {
		cmd := exec.Command("go", "build", "-trimpath", "-buildvcs=false", "-ldflags=-s -w", "-o", filepath.Join(out, filepath.FromSlash(t.out)), "./cmd/spec-flow")
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GOOS="+t.goos, "GOARCH="+t.goarch, "CGO_ENABLED=0", "GOTOOLCHAIN="+release,
			"GOAMD64=v1", "GOARM64=v8.0", "GOFLAGS=", "GOEXPERIMENT=")
		if b, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("%s/%s: %v\n%s", t.goos, t.goarch, err, b)
		}
	}
	return nil
}

func main() {
	root, _ := os.Getwd()
	if err := build(root, root); err != nil {
		fmt.Fprintln(os.Stderr, "build:", err)
		os.Exit(1)
	}
	for _, t := range targets {
		fmt.Println(t.out)
	}
}

// Command tool stands in for a consuming repository's linter, test runner or
// check in the engine's own tests: one binary on every platform, so no test
// needs a shell or an interpreter to play the repository's part.
//
//	tool out=TEXT err=TEXT write=PATH=TEXT append=PATH=TEXT args argsto=PATH failargs exit=N
//
// Each operation runs in order; `args` prints the arguments after `--`, one
// per line; `cat=PATH` prints a file; `exit=N` ends with N.
package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
	args := os.Args[1:]
	rest := []string{}
	for i, a := range args {
		if a == "--" {
			rest = args[i+1:]
			args = args[:i]
			break
		}
	}
	for _, a := range args {
		op, val, _ := strings.Cut(a, "=")
		switch op {
		case "out":
			fmt.Println(val)
		case "err":
			fmt.Fprintln(os.Stderr, val)
		case "write", "append":
			path, text, _ := strings.Cut(val, "=")
			flag := os.O_CREATE | os.O_WRONLY | os.O_TRUNC
			if op == "append" {
				flag = os.O_CREATE | os.O_WRONLY | os.O_APPEND
			}
			if dir := path[:strings.LastIndexAny(path, `/\`)+1]; dir != "" {
				_ = os.MkdirAll(dir, 0o755)
			}
			f, err := os.OpenFile(path, flag, 0o644)
			if err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(70)
			}
			_, _ = f.WriteString(strings.ReplaceAll(text, `\n`, "\n"))
			f.Close()
		case "cat":
			b, _ := os.ReadFile(val)
			os.Stdout.Write(b)
		case "args":
			for _, r := range rest {
				fmt.Println(r)
			}
		case "argsto":
			_ = os.WriteFile(val, []byte(strings.Join(rest, ",")), 0o644)
		case "failargs":
			if len(rest) > 0 {
				os.Exit(1)
			}
		case "sleep":
			ms, _ := strconv.Atoi(val)
			time.Sleep(time.Duration(ms) * time.Millisecond)
		case "exit":
			n, _ := strconv.Atoi(val)
			os.Exit(n)
		}
	}
}

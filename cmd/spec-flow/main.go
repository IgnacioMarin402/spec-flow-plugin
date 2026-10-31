// Command spec-flow is the whole engine: every hook (`spec-flow hook <name>`)
// and every command a terminal, CI or the orchestrator runs.
package main

import (
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/cli"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hooks"
)

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
	}
	if args[0] == "hook" {
		if len(args) < 2 {
			usage()
		}
		h, ok := hooks.All[args[1]]
		if !ok {
			fmt.Fprintf(os.Stderr, "spec-flow: no hook named %q\n", args[1])
			os.Exit(1)
		}
		os.Exit(hookio.Run(hookio.NewCtx(), h.Main, h.OnError))
	}
	cmd, ok := commands[args[0]]
	if !ok {
		usage()
	}
	os.Exit(cmd(args[1:]))
}

var commands = cli.Commands

func usage() {
	names := make([]string, 0, len(commands)+1)
	for n := range commands {
		names = append(names, n)
	}
	sort.Strings(names)
	fmt.Fprintf(os.Stderr, "spec-flow: usage: spec-flow <%s> [args...]\n", strings.Join(append(names, "hook <name>"), "|"))
	os.Exit(1)
}

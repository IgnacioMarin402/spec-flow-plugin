// Package proc runs a program without a shell and hands back what it said.
// No shell, on any platform: the gate appends changed paths to `verify.lint`,
// and a shell would re-read each one (ADR-011).
package proc

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
)

// Result is a finished program. Status is -1 when the program never ran or
// was killed: no exit status exists, and no caller may read one as a pass.
type Result struct {
	Status         int
	Stdout, Stderr string
	Err            error // the program could not be started
}

// OK is a zero exit.
func (r Result) OK() bool { return r.Status == 0 }

// Out is stdout then stderr, as the logs record a check's output.
func (r Result) Out() string { return r.Stdout + r.Stderr }

// Options for Run.
type Options struct {
	Dir   string
	Env   []string // extra KEY=VALUE pairs over the environment
	Stdin string
}

// Run runs argv[0] with argv[1:].
func Run(opts Options, argv ...string) Result {
	if len(argv) == 0 {
		return Result{Status: -1, Err: errors.New("no command")}
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = opts.Dir
	if len(opts.Env) > 0 {
		cmd.Env = append(os.Environ(), opts.Env...)
	}
	if opts.Stdin != "" {
		cmd.Stdin = bytes.NewBufferString(opts.Stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	res := Result{Stdout: out.String(), Stderr: errb.String(), Status: -1}
	var exit *exec.ExitError
	switch {
	case err == nil:
		res.Status = 0
	case errors.As(err, &exit):
		res.Status = exit.ExitCode() // -1 when a signal ended it
	default:
		res.Err = err
	}
	return res
}

// Git runs git in dir.
func Git(dir string, args ...string) Result {
	return Run(Options{Dir: dir}, append([]string{"git"}, args...)...)
}

// Inherit runs argv in dir with this process's own streams, and returns its
// exit status, 1 when it could not run or was killed.
func Inherit(dir string, argv ...string) int {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir, cmd.Stdout, cmd.Stderr = dir, os.Stdout, os.Stderr
	err := cmd.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit) && exit.ExitCode() >= 0:
		return exit.ExitCode()
	}
	return 1
}

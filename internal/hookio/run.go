package hookio

import (
	"fmt"
	"io"
	"os"
	"runtime/debug"
)

// exitCode unwinds a hook to Run with the code it exits with.
type exitCode int

// Ctx is one hook invocation.
type Ctx struct {
	Stdin          io.Reader
	Stdout, Stderr io.Writer
	payload        Payload
	read           bool
}

// NewCtx is an invocation over the process's own streams.
func NewCtx() *Ctx { return &Ctx{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr} }

// Payload reads stdin once.
func (c *Ctx) Payload() Payload {
	if !c.read {
		c.payload, c.read = ReadPayload(c.Stdin), true
	}
	return c.payload
}

// Exit ends the hook with code.
func (c *Ctx) Exit(code int) { panic(exitCode(code)) }

// Deny is the PreToolUse denial: stderr and exit 2.
func (c *Ctx) Deny(message string) {
	fmt.Fprintf(c.Stderr, "[spec-flow] Denied: %s\n", message)
	c.Exit(2)
}

// Fail writes message to stderr as it stands and exits 2.
func (c *Ctx) Fail(message string) {
	fmt.Fprint(c.Stderr, message)
	c.Exit(2)
}

// Run runs main and returns the exit code. A crash exits 0: hooks fail open,
// and onError says what that hook's protocol needs said. An uncaught failure
// in a Stop hook is indistinguishable from a pass to whoever waits on it,
// which is why the gate passes an onError that blocks.
func Run(c *Ctx, main func(*Ctx), onError func(*Ctx, any)) (code int) {
	defer func() {
		r := recover()
		if r == nil {
			return
		}
		if e, ok := r.(exitCode); ok {
			code = int(e)
			return
		}
		code = 0
		if onError != nil {
			func() {
				defer func() { _ = recover() }() // the handler must not be why this hook goes silent
				onError(c, r)
			}()
			return
		}
		fmt.Fprintf(c.Stderr, "[spec-flow] hook error: %v\n%s\n", r, debug.Stack())
	}()
	main(c)
	return 0
}

// ErrText is a recovered value as a message.
func ErrText(r any) string {
	if err, ok := r.(error); ok {
		return err.Error()
	}
	return fmt.Sprint(r)
}

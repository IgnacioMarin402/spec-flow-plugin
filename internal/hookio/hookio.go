// Package hookio holds what every hook shares: where the project and its
// state are, the phase, the payload, and the two output protocols. Nothing
// here reads the contract, so a broken .spec-flow/config.json cannot break it.
package hookio

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/proc"
)

// ProjectDir is the repository this hook runs against, never the engine's own
// location: installed, the two are different directories.
func ProjectDir() string {
	if d := os.Getenv("CLAUDE_PROJECT_DIR"); d != "" {
		return d
	}
	d, _ := os.Getwd()
	return d
}

// StateDir is `.claude/state/`, CREATED. Call it only once the hook knows it
// will write, or every repository the user opens gets one.
func StateDir(root string) string {
	dir := filepath.Join(root, ".claude", "state")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// PhasePath creates nothing: most hooks read the phase and stand down, and a
// hook that stands down leaves nothing on disk.
func PhasePath(root string) string { return filepath.Join(root, ".claude", "state", "phase") }

// PhaseOwnerPath is where the session driving the phase is recorded. Creates nothing.
func PhaseOwnerPath(root string) string {
	return filepath.Join(root, ".claude", "state", "phase.session")
}

// RunPhases ARM something. Every other value — `idle`, `done`, empty, unknown
// — arms no hook.
var RunPhases = []string{"spec", "plan", "review", "implement", "blocked"}

// IsRunPhase reports whether phase arms anything.
func IsRunPhase(phase string) bool { return contains(RunPhases, phase) }

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

// Any git failure reads as "not tracked", which arms: a git that could not be
// asked must never be why a hook stands down.
func phaseIsTracked(root string) bool {
	return proc.Git(root, "ls-files", "--error-unmatch", "--", ".claude/state/phase").OK()
}

// StateIsTracked says whether the repository COMMITTED anything under
// `.claude/state/`: then nothing is appended there outside a run (ADR-040).
func StateIsTracked(root string) bool {
	return proc.Git(root, "ls-files", "--error-unmatch", "--", ".claude/state").OK()
}

// ReadPhase is the phase a run put this repository in, `""` otherwise. A phase
// git tracks is content, not state: a clone that ships one would arm the gate
// on arrival (ADR-017). Fails CLOSED: a git that cannot answer leaves the
// phase honoured.
func ReadPhase(root string) string {
	phase := ReadFileOrDefault(PhasePath(root), "")
	if !IsRunPhase(phase) {
		return phase
	}
	if phaseIsTracked(root) {
		return ""
	}
	return phase
}

// ReadOwnedPhase narrows ReadPhase to a phase THIS session owns. Only the
// hooks certain to fire in the sealing session call it — the gate and
// token-trace on Stop, the budget on a spawn (ADR-017). Fails closed: no seal
// or no session id leaves the phase honoured.
func ReadOwnedPhase(root, sessionID string) string {
	phase := ReadPhase(root)
	if !IsRunPhase(phase) {
		return phase
	}
	owner := ReadFileOrDefault(PhaseOwnerPath(root), "")
	if owner != "" && sessionID != "" && owner != sessionID {
		return ""
	}
	return phase
}

// ClaimPhase records this session as the one driving the phase. No session id
// claims nothing: an empty seal already reads as unowned.
func ClaimPhase(root, sessionID string) {
	if sessionID == "" {
		return
	}
	StateDir(root)
	WriteFile(PhaseOwnerPath(root), sessionID)
}

// ReleasePhase drops the seal.
func ReleasePhase(root string) { _ = os.Remove(PhaseOwnerPath(root)) }

// Trim is JavaScript's String.prototype.trim: whitespace and the BOM.
func Trim(s string) string {
	return strings.TrimFunc(s, func(r rune) bool { return unicode.IsSpace(r) || r == 0xFEFF })
}

// ReadFileOrDefault is the file's text, trimmed, or fallback when it cannot be read.
func ReadFileOrDefault(path, fallback string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return fallback
	}
	return Trim(string(b))
}

// WriteFile is best-effort, like every hook's own state.
func WriteFile(path, content string) { _ = os.WriteFile(path, []byte(content), 0o644) }

// AppendLine appends line and a newline. Logging must never be why a hook fails.
func AppendLine(path, line string) {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.WriteString(line + "\n")
}

// AppendUnique appends line unless the file already holds it.
func AppendUnique(path, line string) {
	if !ReadLinesDeduped(path)[line] {
		AppendLine(path, line)
	}
}

// ReadLinesDeduped is the file's non-empty lines.
func ReadLinesDeduped(path string) map[string]bool {
	set := map[string]bool{}
	b, err := os.ReadFile(path)
	if err != nil {
		return set
	}
	for _, l := range strings.Split(string(b), "\n") {
		if l != "" {
			set[l] = true
		}
	}
	return set
}

// ISO is a timestamp as every log here writes one: UTC, milliseconds.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// NowISO is ISO(now).
func NowISO() string { return ISO(time.Now()) }

// Marshal is JSON as JSON.stringify writes it: `<`, `>` and `&` left alone.
func Marshal(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return strings.TrimSuffix(buf.String(), "\n")
}

// Block is "block" for a Stop hook, and for SubagentStop: JSON on stdout, exit
// 0. A non-zero exit is no block at all. On a Stop hook it is also the only
// channel verified to reach a human in an interactive session (ADR-010).
func Block(w io.Writer, reason string) {
	fmt.Fprint(w, Marshal(struct {
		Decision string `json:"decision"`
		Reason   string `json:"reason"`
	}{"block", reason}))
}

// Notice speaks without a decision, so a Stop is still allowed. An interactive
// session discards it off a Stop hook (ADR-010): use it only where losing it is
// acceptable.
func Notice(w io.Writer, message string) {
	fmt.Fprint(w, Marshal(struct {
		SystemMessage string `json:"systemMessage"`
	}{message}))
}

// Payload is a hook's stdin, decoded. Numbers stay as written.
type Payload map[string]any

// ReadPayload degrades to an empty payload on anything that is not a JSON
// object: a hook that cannot read its input still runs its fail-open path.
func ReadPayload(r io.Reader) Payload {
	b, err := io.ReadAll(r)
	if err != nil || len(b) == 0 {
		return Payload{}
	}
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var p map[string]any
	if dec.Decode(&p) != nil || p == nil {
		return Payload{}
	}
	return p
}

// Str is the value when it is a string, `""` otherwise (`typeof v === 'string'`).
func Str(v any) string {
	s, _ := v.(string)
	return s
}

// JSString is String(v ?? `""`): what JavaScript would print for v.
func JSString(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case json.Number:
		return x.String()
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = JSString(e)
			}
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

// Obj is v as an object, or an empty one.
func Obj(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// First is the first value that is a non-empty string, else `""`.
func First(vs ...any) string {
	for _, v := range vs {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// FirstStr is the first value that is a string at all, even `""`, else `""`.
func FirstStr(vs ...any) (string, bool) {
	for _, v := range vs {
		if s, ok := v.(string); ok {
			return s, true
		}
	}
	return "", false
}

// Nullish is `a ?? b ?? …`: the first value present and not null.
func Nullish(vs ...any) any {
	for _, v := range vs {
		if v != nil {
			return v
		}
	}
	return nil
}

// Keys are an object's keys, sorted.
func Keys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortStrings(keys)
	return keys
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}

// Exists reports whether path exists.
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// IsDir reports whether path is a directory.
func IsDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// IsFile reports whether path is a regular file.
func IsFile(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.Mode().IsRegular()
}

// ReadText is a file's text, or `""` and false.
func ReadText(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(b), true
}

// Subdirs are the directories directly under dir, sorted.
func Subdirs(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if IsDir(filepath.Join(dir, e.Name())) {
			out = append(out, e.Name())
		}
	}
	return out
}

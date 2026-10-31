package hooks

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
)

// The counters reported, in order, and where each lives in a usage record.
var counterNames = []string{"in", "out", "cache_read", "cache_write", "think"}

// The counters that grow across a message's lines; the rest are fixed at its first.
var growing = []string{"out", "think"}

// Cache writes by TTL, priced apart. A group with a write whose usage carried
// no split leaves the split unknown, and an unknown split is not written.
var ttlNames = []string{"cache_write_5m", "cache_write_1h"}

func num(v any) float64 {
	if f, ok := v.(float64); ok && !math.IsInf(f, 0) && !math.IsNaN(f) {
		return f
	}
	return 0
}

func finite(v any) bool {
	f, ok := v.(float64)
	return ok && !math.IsInf(f, 0) && !math.IsNaN(f)
}

func counter(u map[string]any, name string) any {
	switch name {
	case "in":
		return u["input_tokens"]
	case "out":
		return u["output_tokens"]
	case "cache_read":
		return u["cache_read_input_tokens"]
	case "cache_write":
		return u["cache_creation_input_tokens"]
	case "think":
		return hookio.Obj(u["output_tokens_details"])["thinking_tokens"]
	case "cache_write_5m":
		return hookio.Obj(u["cache_creation"])["ephemeral_5m_input_tokens"]
	case "cache_write_1h":
		return hookio.Obj(u["cache_creation"])["ephemeral_1h_input_tokens"]
	}
	return nil
}

type group struct {
	model, agent       string
	sidechain, advisor bool
	msgs               int
	maxPrompt          float64
	ttlUnknown         bool
	n                  map[string]float64
}

func newGroup(model string, sidechain bool, agent string) *group {
	return &group{model: model, sidechain: sidechain, agent: agent, n: map[string]float64{}}
}

// carry is the message a slice ended inside, for the next to continue.
type carry struct {
	ID  string  `json:"id"`
	Adv float64 `json:"adv"`
	Out float64 `json:"out"`
	Th  float64 `json:"think"`
}

func (c *carry) get(name string) float64 {
	if name == "out" {
		return c.Out
	}
	return c.Th
}

func (c *carry) set(name string, v float64) {
	if name == "out" {
		c.Out = v
	} else {
		c.Th = v
	}
}

func prompt(u map[string]any) float64 {
	return num(counter(u, "in")) + num(counter(u, "cache_read")) + num(counter(u, "cache_write"))
}

func addTTL(g *group, u map[string]any) {
	all := true
	for _, n := range ttlNames {
		if !finite(counter(u, n)) {
			all = false
		}
	}
	if all {
		for _, n := range ttlNames {
			g.n[n] += num(counter(u, n))
		}
	} else if num(counter(u, "cache_write")) > 0 {
		g.ttlUnknown = true
	}
}

type groups struct {
	order []string
	by    map[string]*group
}

func (gs *groups) get(key string, make func() *group) *group {
	if g, ok := gs.by[key]; ok {
		return g
	}
	g := make()
	gs.by[key] = g
	gs.order = append(gs.order, key)
	return g
}

// tally sums usage per model, chain and agent over the lines in text. A
// message is counted once: input at its first line, output at the largest
// value any of its lines carries. An advisor's consultations are a group of
// their own, charged to the agent that consulted (ADR-038).
func tally(text string, gs *groups, last *carry, agentID string) *carry {
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var entry map[string]any
		if json.Unmarshal([]byte(line), &entry) != nil {
			continue
		}
		message := hookio.Obj(entry["message"])
		usage, ok := message["usage"].(map[string]any)
		model, isStr := message["model"].(string)
		// A usage record whose model cannot be named cannot be charged to a tier.
		if !ok || !isStr {
			continue
		}
		side := entry["isSidechain"] == true
		agent := ""
		if side {
			agent = agentID
		}
		key := fmt.Sprintf("%s|%t|%s", model, side, agent)
		g := gs.get(key, func() *group { return newGroup(model, side, agent) })
		id, hasID := message["id"].(string)
		if hasID && last != nil && last.ID == id {
			for _, name := range growing {
				if v := num(counter(usage, name)); v > last.get(name) {
					g.n[name] += v - last.get(name)
					last.set(name, v)
				}
			}
		} else {
			g.msgs++
			for _, name := range counterNames {
				g.n[name] += num(counter(usage, name))
			}
			addTTL(g, usage)
			g.maxPrompt = math.Max(g.maxPrompt, prompt(usage))
			last = nil
			if hasID {
				last = &carry{ID: id, Out: num(counter(usage, "out")), Th: num(counter(usage, "think"))}
			}
		}
		// A message's later lines repeat the consultations its earlier ones carried.
		var calls []map[string]any
		if its, ok := usage["iterations"].([]any); ok {
			for _, it := range its {
				m := hookio.Obj(it)
				if m["type"] == "advisor_message" {
					if _, ok := m["model"].(string); ok {
						calls = append(calls, m)
					}
				}
			}
		}
		from := 0
		if last != nil {
			from = int(last.Adv)
		}
		for k := from; k < len(calls); k++ {
			call := calls[k]
			cm := call["model"].(string)
			adv := gs.get(fmt.Sprintf("%s|%t|%s|advisor", cm, side, agent), func() *group {
				g := newGroup(cm, side, agent)
				g.advisor = true
				return g
			})
			adv.msgs++
			for _, name := range counterNames {
				adv.n[name] += num(counter(call, name))
			}
			addTTL(adv, call)
			adv.maxPrompt = math.Max(adv.maxPrompt, prompt(call))
		}
		if last != nil {
			last.Adv = math.Max(last.Adv, float64(len(calls)))
		}
	}
	return last
}

// offset is one transcript's place: where the next read starts, and the
// message the last slice ended inside.
type offset struct {
	Bytes any      `json:"bytes"`
	ID    *string  `json:"id,omitempty"`
	Adv   *float64 `json:"adv,omitempty"`
	Out   *float64 `json:"out,omitempty"`
	Think *float64 `json:"think,omitempty"`
}

// readOffsets are the offsets saved at the last stop, or ok=false when the
// file exists and cannot be read — which is not the same as having none.
func readOffsets(path string) (map[string]offset, bool) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return map[string]offset{}, true
	}
	if err != nil {
		return nil, false
	}
	var saved struct {
		Files map[string]offset `json:"files"`
		Path  *string           `json:"path"`
		Bytes any               `json:"bytes"`
	}
	if json.Unmarshal(b, &saved) != nil {
		return nil, false
	}
	if saved.Files != nil {
		return saved.Files, true
	}
	// `{path, bytes}` is ONE transcript's offset, the shape an older revision wrote.
	if saved.Path != nil {
		return map[string]offset{*saved.Path: {Bytes: saved.Bytes}}, true
	}
	return nil, false
}

func intBytes(v any) (int64, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) {
		return 0, false
	}
	return int64(f), true
}

type slice struct {
	text                string
	next                int64
	continued, resynced bool
}

// unreadBytes are the bytes appended since the saved offset, up to the LAST
// newline: the tail may be half a line another process is still writing. A
// file shorter than its offset is a new transcript, read from 0. An offset
// that exists and cannot be read skips its slice: re-reading from 0 would
// count a prefix twice.
func unreadBytes(path string, saved *offset, unreadable bool) (slice, error) {
	f, err := os.Open(path)
	if err != nil {
		return slice{}, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return slice{}, err
	}
	size := st.Size()
	bytes, isInt := int64(0), false
	if saved != nil {
		bytes, isInt = intBytes(saved.Bytes)
	}
	if unreadable || (saved != nil && !isInt) {
		return slice{next: size, resynced: true}, nil
	}
	continued := saved != nil && bytes <= size
	from := int64(0)
	if continued {
		from = bytes
	}
	if from == size {
		return slice{next: from, continued: continued}, nil
	}
	buf := make([]byte, size-from)
	n, _ := f.ReadAt(buf, from)
	buf = buf[:n]
	last := strings.LastIndexByte(string(buf), '\n')
	if last == -1 {
		return slice{next: from, continued: continued}, nil
	}
	return slice{text: string(buf[:last]), next: from + int64(last) + 1, continued: continued}, nil
}

var agentFile = regexp.MustCompile(`[\\/]agent-([\w-]+)\.jsonl$`)

// transcripts are the session's transcript, then each of its subagents'.
func transcripts(session string) []string {
	dir := filepath.Join(strings.TrimSuffix(session, ".jsonl"), "subagents")
	out := []string{session}
	entries, _ := os.ReadDir(dir)
	var subs []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".jsonl") {
			subs = append(subs, filepath.Join(dir, e.Name()))
		}
	}
	sort.Strings(subs)
	return append(out, subs...)
}

// closedThisTurn: this session's `closed` line, which run-trace writes with
// `done`, is its latest, with no token line of its own after it.
func closedThisTurn(traceFile, session string) bool {
	f, err := os.Open(traceFile)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false
	}
	n := st.Size()
	if n > 64*1024 {
		n = 64 * 1024
	}
	buf := make([]byte, n)
	_, _ = f.ReadAt(buf, st.Size()-n)
	lines := strings.Split(string(buf), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if session != "" && !strings.Contains(lines[i], " session="+session+" ") {
			continue
		}
		if strings.Contains(lines[i], " closed tool=") {
			return true
		}
		if strings.Contains(lines[i], " tokens model=") {
			return false
		}
	}
	return false
}

func jsNum(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// TokenTrace — Stop — what a turn actually cost, read from the transcripts
// Claude Code was already writing. It enforces NOTHING and renders no
// decision. An unreadable transcript records NOTHING, never a zero: a sum is
// the one shape where "not known" and "none" look alike (ADR-004). The read
// is cumulative, from offsets, because the transcript lags the conversation;
// a subagent's messages are in a file of their own, and named by it.
func TokenTrace(c *hookio.Ctx) {
	root := hookio.ProjectDir()
	p := c.Payload()
	session := hookio.First(p["session_id"], p["sessionId"])
	// The phases run-trace traces, owned as the gate reads it on this Stop.
	phase := hookio.ReadOwnedPhase(root, session)
	if phase == "" {
		return
	}
	path := hookio.First(p["transcript_path"], p["transcriptPath"])
	state := hookio.StateDir(root)
	// The turn that wrote `done` is still the run's (ADR-043), unless the
	// repository committed its `.claude/state/` (ADR-040).
	closing := phase == "done" && closedThisTurn(filepath.Join(state, "run-trace.log"), session) && !hookio.StateIsTracked(root)
	idle := phase == "idle" || (phase == "done" && !closing)
	offsetFile := filepath.Join(state, "token-offset")
	miss := func(what any) {
		hookio.AppendUnique(filepath.Join(state, "token-trace-unmatched.log"), hookio.Marshal(what))
	}
	if path == "" {
		miss(map[string]any{"no_transcript_path": hookio.Keys(p)})
		return
	}
	saved, readable := readOffsets(offsetFile)
	if !readable {
		miss(map[string]string{"offset_unreadable": "resynchronised, one slice not counted"})
	}
	gs := &groups{by: map[string]*group{}}
	offsets := map[string]offset{}
	for _, file := range transcripts(path) {
		var before *offset
		if o, ok := saved[file]; ok {
			before = &o
		}
		sl, err := unreadBytes(file, before, !readable)
		if err != nil {
			code := "unknown"
			if pe, ok := err.(*os.PathError); ok {
				code = errCode(pe.Err)
			}
			// The session's own transcript is this stop's subject.
			if file == path {
				miss(map[string]string{"transcript_unreadable": code})
				return
			}
			miss(map[string]string{"subagent_transcript_unreadable": code})
			if before != nil {
				offsets[file] = *before
			}
			continue
		}
		if sl.resynced && readable {
			miss(map[string]string{"offset_unreadable": "resynchronised, one slice not counted"})
		}
		var from *carry
		if sl.continued && before != nil && before.ID != nil {
			from = &carry{ID: *before.ID}
			if before.Adv != nil {
				from.Adv = *before.Adv
			}
			if before.Out != nil {
				from.Out = *before.Out
			}
			if before.Think != nil {
				from.Th = *before.Think
			}
		}
		// Between runs the slice is read and dropped: its turns belong to no run.
		var last *carry
		if !idle {
			agentID := ""
			if m := agentFile.FindStringSubmatch(file); m != nil {
				agentID = m[1]
			}
			last = tally(sl.text, gs, from, agentID)
		}
		o := offset{Bytes: float64(sl.next)}
		if last != nil {
			id, adv, out, th := last.ID, last.Adv, last.Out, last.Th
			o.ID, o.Adv, o.Out, o.Think = &id, &adv, &out, &th
		}
		offsets[file] = o
	}
	// Offsets advance even over a slice with no usage. Other sessions' are
	// kept while their files exist.
	files := map[string]offset{}
	for f, o := range saved {
		if _, mine := offsets[f]; !mine && hookio.Exists(f) {
			files[f] = o
		}
	}
	for f, o := range offsets {
		files[f] = o
	}
	hookio.WriteFile(offsetFile, hookio.Marshal(map[string]any{"files": files})+"\n")
	if idle {
		return
	}
	id := ""
	for _, v := range []any{p["session_id"], p["sessionId"]} {
		if s, ok := v.(string); ok && wordAgentID.MatchString(s) {
			id = " session=" + s
			break
		}
	}
	stamp := fmt.Sprintf("%s phase=%s%s", hookio.NowISO(), phase, id)
	// One line per group: a whitespace split into `k=v` has no repeated key.
	for _, key := range gs.order {
		g := gs.by[key]
		nonzero := g.msgs > 0
		for _, n := range counterNames {
			if g.n[n] > 0 {
				nonzero = true
			}
		}
		if !nonzero {
			continue // only the tail of a message an earlier stop counted
		}
		var counts []string
		for _, n := range counterNames {
			// An advisor's iteration reports no thinking apart from its output.
			if !(g.advisor && n == "think") {
				counts = append(counts, n+"="+jsNum(g.n[n]))
			}
		}
		if !g.ttlUnknown {
			for _, n := range ttlNames {
				counts = append(counts, n+"="+jsNum(g.n[n]))
			}
		}
		agent, advisor := "", ""
		if g.agent != "" {
			agent = " agent_id=" + g.agent
		}
		if g.advisor {
			advisor = " advisor=true"
		}
		hookio.AppendLine(filepath.Join(state, "run-trace.log"), fmt.Sprintf("%s tokens model=%s sidechain=%t%s %s msgs=%d max_prompt=%s%s", stamp, g.model, g.sidechain, advisor, strings.Join(counts, " "), g.msgs, jsNum(g.maxPrompt), agent))
	}
}

func errCode(err error) string {
	switch {
	case os.IsNotExist(err):
		return "ENOENT"
	case os.IsPermission(err):
		return "EACCES"
	}
	if err == io.EOF {
		return "EOF"
	}
	return "unknown"
}

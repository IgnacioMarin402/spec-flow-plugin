package e2e

// token-trace reads a file this engine does not write — Claude Code's session
// transcript — so every field it depends on is an observation about another
// program. These cases pin the shape read off a real transcript:
// `message.usage`, `message.model`, `message.id`, a top-level `isSidechain`,
// and each subagent in a file of its own beside the session's.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// usage is one assistant entry's fields. Model names are deliberately not
// real ones: the hook treats the value as opaque. ttl adds the split by TTL a
// current build writes beside the sum; iterations is where an advisor's
// consultations are.
type usage struct {
	model                                    string
	sidechain                                bool
	out, input, cacheRead, cacheWrite, think int
	id                                       string
	ttl                                      *[2]int
	iterations                               []map[string]any
}

func entry(u usage) string {
	if u.model == "" {
		u.model = "model-alpha"
	}
	if u.out == 0 {
		u.out = 100
	}
	if u.input == 0 {
		u.input = 10
	}
	us := map[string]any{"input_tokens": u.input, "output_tokens": u.out, "cache_read_input_tokens": u.cacheRead,
		"cache_creation_input_tokens": u.cacheWrite, "output_tokens_details": map[string]any{"thinking_tokens": u.think}}
	if u.ttl != nil {
		us["cache_creation"] = map[string]any{"ephemeral_5m_input_tokens": u.ttl[0], "ephemeral_1h_input_tokens": u.ttl[1]}
	}
	if u.iterations != nil {
		us["iterations"] = u.iterations
	}
	msg := map[string]any{"role": "assistant", "model": u.model, "usage": us}
	if u.id != "" {
		msg["id"] = u.id
	}
	b, _ := json.Marshal(map[string]any{"type": "assistant", "isSidechain": u.sidechain, "timestamp": "2026-08-31T00:00:00.000Z", "message": msg})
	return string(b) + "\n"
}

// advisorCall is a consultation as `usage.iterations` reports it: its own
// model, and counts the message's top-level usage leaves out.
func advisorCall(input, out int) map[string]any {
	return map[string]any{"type": "advisor_message", "model": "model-gamma", "input_tokens": input, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": out}
}

// executorStep is the executor's own step, which the top-level usage already sums.
func executorStep(out int) map[string]any {
	return map[string]any{"type": "message", "input_tokens": 10, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0, "output_tokens": out}
}

func tokenRepo(t *testing.T, phase *string) string {
	repo := t.TempDir()
	if phase != nil {
		write(t, statePath(repo, "phase"), *phase+"\n")
	}
	return repo
}

func phased(p string) *string { return &p }

func transcript(t *testing.T, repo string, lines ...string) string {
	path := filepath.Join(repo, "transcript.jsonl")
	write(t, path, strings.Join(lines, ""))
	return path
}

// subagentTranscript is where the harness puts a subagent's own transcript: beside the session's.
func subagentTranscript(t *testing.T, session, name string, lines ...string) string {
	path := filepath.Join(strings.TrimSuffix(session, ".jsonl"), "subagents", "agent-"+name+".jsonl")
	write(t, path, strings.Join(lines, ""))
	return path
}

type stopped struct {
	code   int
	stderr string
	lines  []string
}

func stop(t *testing.T, repo, transcriptPath string, extra map[string]any) stopped {
	t.Helper()
	payload := map[string]any{"session_id": "sess-1", "hook_event_name": "Stop"}
	if transcriptPath != "" {
		payload["transcript_path"] = transcriptPath
	}
	for k, v := range extra {
		payload[k] = v
	}
	r := runHook(t, "token-trace", payload, repo)
	var lines []string
	for _, l := range strings.Split(read(statePath(repo, "run-trace.log")), "\n") {
		if l != "" {
			lines = append(lines, l)
		}
	}
	return stopped{r.Status, r.Stderr, lines}
}

// field is key's value on a trace line, and whether it is there.
func field(line, key string) (string, bool) {
	m := regexp.MustCompile(`(?:^| )` + regexp.QuoteMeta(key) + `=(\S+)`).FindStringSubmatch(line)
	if m == nil {
		return "", false
	}
	return m[1], true
}

func f(line, key string) string { v, _ := field(line, key); return v }

func lineWhere(lines []string, ok func(string) bool) string {
	for _, l := range lines {
		if ok(l) {
			return l
		}
	}
	return ""
}

func wantFields(t *testing.T, line string, want map[string]string) {
	t.Helper()
	for k, v := range want {
		if got := f(line, k); got != v {
			t.Errorf("%s: want %s, got %q", k, v, got)
		}
	}
	if t.Failed() {
		t.Fatalf("--- line ---\n%s", line)
	}
}

func wantLines(t *testing.T, s stopped, n int, why string) {
	t.Helper()
	if len(s.lines) != n {
		t.Fatalf("%s: expected %d line(s), got %d:\n%s", why, n, len(s.lines), strings.Join(s.lines, "\n"))
	}
}

func TestTokens(t *testing.T) {
	t.Parallel()
	const agentA = "a0123456789abcdef"
	sidechain := func(l string) bool { return f(l, "sidechain") == "true" }
	mainLine := func(l string) bool { return f(l, "sidechain") == "false" }
	cases := []struct {
		name string
		run  func(t *testing.T, repo string)
	}{
		// ---- the shape it reads
		{"a transcript with usage produces one line per model, carrying every counter", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{out: 100, input: 10, cacheRead: 5000, cacheWrite: 700, think: 40})), nil)
			if s.code != 0 {
				t.Fatalf("the hook exited %d; an observer must always exit 0", s.code)
			}
			wantLines(t, s, 1, "one model")
			wantFields(t, s.lines[0], map[string]string{"model": "model-alpha", "sidechain": "false", "in": "10", "out": "100", "cache_read": "5000", "cache_write": "700", "think": "40", "msgs": "1"})
		}},
		{"a subagent and its spawner are counted apart, not merged into one total", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{out: 100}), entry(usage{out: 30, sidechain: true}), entry(usage{out: 70, sidechain: true})), nil)
			m, sub := lineWhere(s.lines, mainLine), lineWhere(s.lines, sidechain)
			if m == "" || sub == "" {
				t.Fatalf("expected a main line and a subagent line, got:\n%s", strings.Join(s.lines, "\n"))
			}
			wantFields(t, m, map[string]string{"out": "100"})
			wantFields(t, sub, map[string]string{"out": "100", "msgs": "2"})
		}},
		{"two models in one turn are two lines — a whitespace-split log cannot hold a repeated key", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{model: "model-alpha"}), entry(usage{model: "model-beta"})), nil)
			wantLines(t, s, 2, "two models")
			if f(s.lines[0], "model") == f(s.lines[1], "model") {
				t.Fatalf("expected two lines naming two models:\n%s", strings.Join(s.lines, "\n"))
			}
		}},
		// ---- what Claude Code writes
		{"a subagent transcript beside the session transcript is counted, as a sidechain", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			subagentTranscript(t, tr, agentA, entry(usage{out: 30, sidechain: true}), entry(usage{out: 70, sidechain: true}))
			sub := lineWhere(stop(t, repo, tr, nil).lines, sidechain)
			if sub == "" {
				t.Fatal("no subagent line — every subagent the flow spawns is missing from the cost")
			}
			wantFields(t, sub, map[string]string{"out": "100", "msgs": "2"})
		}},
		{"a message written over several lines is counted once", func(t *testing.T, repo string) {
			b := usage{id: "msg_1", out: 100, input: 3, cacheRead: 60000, cacheWrite: 900}
			s := stop(t, repo, transcript(t, repo, entry(b), entry(b), entry(b)), nil)
			wantLines(t, s, 1, "one message")
			wantFields(t, s.lines[0], map[string]string{"msgs": "1", "in": "3", "cache_read": "60000", "cache_write": "900", "out": "100"})
		}},
		{"a message's output is the largest count its lines carry, not their sum", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{id: "msg_1", out: 3}), entry(usage{id: "msg_1", out: 150, think: 120})), nil)
			wantLines(t, s, 1, "one message")
			wantFields(t, s.lines[0], map[string]string{"out": "150", "think": "120"})
		}},
		{"a message whose lines straddle two stops is counted once", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{id: "msg_1", out: 3, cacheRead: 5000}))
			stop(t, repo, tr, nil)
			appendTo(t, tr, entry(usage{id: "msg_1", out: 40, cacheRead: 5000})+entry(usage{id: "msg_2", out: 7, cacheRead: 5100}))
			s := stop(t, repo, tr, nil)
			wantLines(t, s, 2, "a second stop")
			wantFields(t, s.lines[1], map[string]string{"msgs": "1", "cache_read": "5100", "out": "44"})
		}},
		{"cache writes are recorded by TTL, as the transcript splits them", func(t *testing.T, repo string) {
			h1 := usage{id: "msg_1", cacheWrite: 700, ttl: &[2]int{0, 700}}
			tr := transcript(t, repo, entry(h1), entry(h1), entry(usage{id: "msg_2", cacheWrite: 50, ttl: &[2]int{0, 50}}))
			subagentTranscript(t, tr, agentA, entry(usage{sidechain: true, cacheWrite: 300, ttl: &[2]int{300, 0}}))
			s := stop(t, repo, tr, nil)
			wantFields(t, lineWhere(s.lines, mainLine), map[string]string{"cache_write_5m": "0", "cache_write_1h": "750"})
			wantFields(t, lineWhere(s.lines, sidechain), map[string]string{"cache_write_5m": "300", "cache_write_1h": "0"})
		}},
		{"an advisor consultation is a group of its own, by its model and the agent that consulted it", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{input: 1760, out: 531, iterations: []map[string]any{executorStep(89), advisorCall(823, 1612), executorStep(442)}}))
			subagentTranscript(t, tr, agentA, entry(usage{sidechain: true, iterations: []map[string]any{advisorCall(100, 50)}}))
			s := stop(t, repo, tr, nil)
			executor := lineWhere(s.lines, func(l string) bool { return f(l, "model") == "model-alpha" && mainLine(l) })
			mine := lineWhere(s.lines, func(l string) bool { return f(l, "advisor") == "true" && mainLine(l) })
			agents := lineWhere(s.lines, func(l string) bool { return f(l, "advisor") == "true" && sidechain(l) })
			if mine == "" || agents == "" {
				t.Fatalf("no advisor group — its tokens are counted nowhere:\n%s", strings.Join(s.lines, "\n"))
			}
			if _, ok := field(executor, "advisor"); ok || f(executor, "in") != "1760" || f(executor, "out") != "531" {
				t.Errorf("the executor's line changed: %s", executor)
			}
			if _, ok := field(mine, "agent_id"); ok || f(mine, "model") != "model-gamma" || f(mine, "in") != "823" || f(mine, "out") != "1612" || f(mine, "msgs") != "1" {
				t.Errorf("the session's consultation: %s", mine)
			}
			if f(agents, "agent_id") != agentA || f(agents, "in") != "100" || f(agents, "out") != "50" {
				t.Errorf("the subagent's consultation: %s", agents)
			}
			if v, ok := field(mine, "think"); ok {
				t.Errorf("an advisor's thinking is not reported apart, yet its line says think=%s", v)
			}
		}},
		{"a consultation repeated on later lines of its message, or after a stop, is counted once", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{id: "msg_1", out: 5, iterations: []map[string]any{executorStep(5)}}),
				entry(usage{id: "msg_1", out: 40, iterations: []map[string]any{executorStep(5), advisorCall(823, 1612)}}))
			stop(t, repo, tr, nil)
			appendTo(t, tr, entry(usage{id: "msg_1", out: 90, iterations: []map[string]any{executorStep(5), advisorCall(823, 1612), executorStep(50)}})+
				entry(usage{id: "msg_2", out: 3, iterations: []map[string]any{advisorCall(7, 3)}}))
			var calls []string
			for _, l := range stop(t, repo, tr, nil).lines {
				if f(l, "advisor") == "true" {
					calls = append(calls, f(l, "msgs")+":"+f(l, "in"))
				}
			}
			if strings.Join(calls, ",") != "1:823,1:7" {
				t.Fatalf("consultations by stop were %q, want [1:823 1:7]", calls)
			}
		}},
		{"each subagent transcript keeps its own offset", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			sub := subagentTranscript(t, tr, agentA, entry(usage{out: 30, sidechain: true}))
			stop(t, repo, tr, nil)
			appendTo(t, sub, entry(usage{out: 5, sidechain: true}))
			s := stop(t, repo, tr, nil)
			wantLines(t, s, 3, "one new line for the subagent's delta")
			wantFields(t, s.lines[2], map[string]string{"sidechain": "true", "out": "5"})
		}},
		// ---- the offset
		{"an offset saved in the one-transcript shape is honoured, not re-read from 0", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			write(t, statePath(repo, "token-offset"), toJSON(map[string]any{"path": tr, "bytes": len(read(tr))})+"\n")
			appendTo(t, tr, entry(usage{out: 7}))
			s := stop(t, repo, tr, nil)
			wantLines(t, s, 1, "the saved offset")
			wantFields(t, s.lines[0], map[string]string{"out": "7"})
		}},
		{"a second stop over an unchanged transcript writes nothing", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{}))
			stop(t, repo, tr, nil)
			wantLines(t, stop(t, repo, tr, nil), 1, "the same bytes were counted again")
		}},
		{"a later stop counts only what was appended since the last one", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			stop(t, repo, tr, nil)
			appendTo(t, tr, entry(usage{out: 7}))
			s := stop(t, repo, tr, nil)
			wantLines(t, s, 2, "a second line")
			wantFields(t, s.lines[1], map[string]string{"out": "7"})
		}},
		{"a transcript replaced by a shorter one is read from the start, not from a stale offset", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}), entry(usage{out: 100}), entry(usage{out: 100}))
			stop(t, repo, tr, nil)
			write(t, tr, entry(usage{out: 42})) // a new session at the same path
			s := stop(t, repo, tr, nil)
			wantLines(t, s, 2, "the shorter file")
			wantFields(t, s.lines[1], map[string]string{"out": "42"})
		}},
		{"a half-written last line is not consumed, and is counted once it completes", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			partial := entry(usage{out: 55})
			appendTo(t, tr, partial[:30]) // the writer is mid-append
			wantLines(t, stop(t, repo, tr, nil), 1, "the partial line was read as data")
			appendTo(t, tr, partial[30:])
			s := stop(t, repo, tr, nil)
			wantLines(t, s, 2, "the completed line was skipped for good")
			wantFields(t, s.lines[1], map[string]string{"out": "55"})
		}},
		// ---- what it refuses to guess
		{"a usage record with no model is dropped rather than absorbed into a total", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{out: 100}),
				toJSON(map[string]any{"type": "assistant", "isSidechain": false, "message": map[string]any{"role": "assistant", "usage": map[string]any{"output_tokens": 999}}})+"\n"), nil)
			wantLines(t, s, 1, "one line")
			wantFields(t, s.lines[0], map[string]string{"out": "100"})
		}},
		{"a cache write with no split by TTL leaves the split unwritten, never a zero", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{cacheWrite: 700}), entry(usage{cacheWrite: 50, ttl: &[2]int{0, 50}})), nil)
			wantLines(t, s, 1, "one line")
			wantFields(t, s.lines[0], map[string]string{"cache_write": "750"})
			mustNotMatch(t, `cache_write_(5m|1h)=`, s.lines[0], "a split was written that the transcript did not give")
		}},
		{"an unreadable line does not stop the readable ones", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{out: 100}), "not json at all\n", entry(usage{out: 5})), nil)
			if s.code != 0 {
				t.Fatalf("the hook exited %d on a line it could not parse", s.code)
			}
			wantLines(t, s, 1, "one line")
			wantFields(t, s.lines[0], map[string]string{"out": "105"})
		}},
		{"a payload with no transcript path records nothing — a missing count is never a zero", func(t *testing.T, repo string) {
			s := stop(t, repo, "", nil)
			if s.code != 0 {
				t.Fatalf("the hook exited %d", s.code)
			}
			wantLines(t, s, 0, "no transcript to read")
		}},
		{"a transcript path that does not exist records nothing and does not throw", func(t *testing.T, repo string) {
			s := stop(t, repo, filepath.Join(repo, "gone.jsonl"), nil)
			if s.code != 0 {
				t.Fatalf("the hook exited %d: %s", s.code, s.stderr)
			}
			wantLines(t, s, 0, "a file it could not open")
		}},
		{"a corrupt offset counts nothing rather than counting a prefix twice", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			stop(t, repo, tr, nil)
			write(t, statePath(repo, "token-offset"), "not json\n")
			appendTo(t, tr, entry(usage{out: 5}))
			wantLines(t, stop(t, repo, tr, nil), 1, "the first 100 was counted again")
			mustMatch(t, `offset_unreadable`, read(statePath(repo, "token-trace-unmatched.log")), "the skipped slice left no record")
		}},
		{"a resynchronised offset picks the next slice up cleanly", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			stop(t, repo, tr, nil)
			write(t, statePath(repo, "token-offset"), "not json\n")
			appendTo(t, tr, entry(usage{out: 5}))
			stop(t, repo, tr, nil) // the slice that is lost
			appendTo(t, tr, entry(usage{out: 9}))
			s := stop(t, repo, tr, nil)
			wantLines(t, s, 2, "the run resumes counting")
			wantFields(t, s.lines[1], map[string]string{"out": "9"})
		}},
		{"a payload with no transcript path records its SHAPE, so a moved field is visible", func(t *testing.T, repo string) {
			stop(t, repo, "", nil)
			missed := read(statePath(repo, "token-trace-unmatched.log"))
			if !strings.Contains(missed, "no_transcript_path") || !strings.Contains(missed, "session_id") {
				t.Fatalf("the record names no payload keys:\n%s", missed)
			}
		}},
		{"an unreadable transcript records its shape too", func(t *testing.T, repo string) {
			stop(t, repo, filepath.Join(repo, "gone.jsonl"), nil)
			mustMatch(t, `transcript_unreadable`, read(statePath(repo, "token-trace-unmatched.log")), "the record does not name the cause")
		}},
		{"the miss log is deduped — one moved field is one line, not one per stop", func(t *testing.T, repo string) {
			for i := 0; i < 3; i++ {
				stop(t, repo, "", nil)
			}
			if n := strings.Count(strings.TrimRight(read(statePath(repo, "token-trace-unmatched.log")), "\n"), "\n") + 1; n != 1 {
				t.Fatalf("%d lines for one repeated cause", n)
			}
		}},
		// ---- whose cost it is
		{"a subagent transcript is charged to the agent its file names", func(t *testing.T, repo string) {
			tr := transcript(t, repo, entry(usage{out: 100}))
			subagentTranscript(t, tr, agentA, entry(usage{out: 30, sidechain: true}))
			subagentTranscript(t, tr, "b0123456789abcdef", entry(usage{out: 70, sidechain: true}))
			s := stop(t, repo, tr, nil)
			by := map[string]string{}
			for _, l := range s.lines {
				if id, ok := field(l, "agent_id"); ok {
					by[id] = f(l, "out")
				}
			}
			if by[agentA] != "30" || by["b0123456789abcdef"] != "70" {
				t.Fatalf("two agents were not told apart:\n%s", strings.Join(s.lines, "\n"))
			}
			if m := lineWhere(s.lines, mainLine); m == "" || strings.Contains(m, "agent_id=") {
				t.Fatalf("the session's own line was charged to an agent: %s", m)
			}
		}},
		{"a group reports its largest single prompt, not a sum", func(t *testing.T, repo string) {
			s := stop(t, repo, transcript(t, repo, entry(usage{id: "m1", input: 10, cacheRead: 90000, cacheWrite: 5000}), entry(usage{id: "m2", input: 20, cacheRead: 120000, cacheWrite: 1000})), nil)
			wantLines(t, s, 1, "one group")
			wantFields(t, s.lines[0], map[string]string{"max_prompt": "121020"})
		}},
		{"a second session in the repo does not record tokens against the run", func(t *testing.T, repo string) {
			write(t, statePath(repo, "phase.session"), "sess-owner")
			wantLines(t, stop(t, repo, transcript(t, repo, entry(usage{out: 100})), map[string]any{"session_id": "sess-other"}), 0, "another session's turn was charged to the run")
		}},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			c.run(t, tokenRepo(t, phased("implement")))
		})
	}
	// ---- where it must not fire: the phases run-trace stands down on
	for _, phase := range []string{"", "idle", "done"} {
		phase := phase
		t.Run("phase "+phase+" records nothing", func(t *testing.T) {
			t.Parallel()
			repo := tokenRepo(t, phased(phase))
			wantLines(t, stop(t, repo, transcript(t, repo, entry(usage{})), nil), 0, "fired on a phase that arms nothing")
		})
	}
	t.Run("a repo that never adopted this engine gets no .claude/ directory", func(t *testing.T) {
		t.Parallel()
		repo := tokenRepo(t, nil)
		if s := stop(t, repo, transcript(t, repo, entry(usage{})), nil); s.code != 0 {
			t.Fatalf("the hook exited %d", s.code)
		}
		if exists(filepath.Join(repo, ".claude")) {
			t.Fatal("created .claude/ in a repo with no phase file")
		}
	})
	t.Run("turns taken between runs are not charged to the next run", func(t *testing.T) {
		t.Parallel()
		repo := tokenRepo(t, phased("idle"))
		tr := transcript(t, repo, entry(usage{out: 1000}))
		stop(t, repo, tr, nil)
		setPhase(t, repo, "spec\n")
		appendTo(t, tr, entry(usage{out: 7}))
		s := stop(t, repo, tr, nil)
		wantLines(t, s, 1, "the run's first stop charged the idle turns too")
		wantFields(t, s.lines[0], map[string]string{"out": "7"})
	})
	t.Run("one session's stop keeps another session's offsets", func(t *testing.T) {
		t.Parallel()
		repo := tokenRepo(t, phased("idle"))
		a := transcript(t, repo, entry(usage{out: 100}))
		b := filepath.Join(repo, "other.jsonl")
		write(t, b, entry(usage{out: 50}))
		stop(t, repo, a, map[string]any{"session_id": "sess-a"})
		stop(t, repo, b, map[string]any{"session_id": "sess-b"})
		setPhase(t, repo, "spec\n")
		appendTo(t, a, entry(usage{out: 7}))
		s := stop(t, repo, a, map[string]any{"session_id": "sess-a"})
		wantLines(t, s, 1, "session a re-read its whole transcript after session b's stop")
		wantFields(t, s.lines[0], map[string]string{"out": "7"})
	})
}

func report(repo, command string) string {
	return run(os.TempDir(), []string{"CLAUDE_PROJECT_DIR=" + repo}, "", cliArgv(engineDir, command)...).Stdout
}

// ---- the readers agree

func TestTokenReadersAgree(t *testing.T) {
	t.Parallel()
	repo := tokenRepo(t, phased("implement"))
	stop(t, repo, transcript(t, repo, entry(usage{out: 1234, sidechain: true}), entry(usage{out: 4321, iterations: []map[string]any{advisorCall(823, 1612)}})), nil)
	rows := func(out string) []string {
		r := regexp.MustCompile(`model-\S+\s+(?:main|subagent|advisor)\s+in \S+\s+out \S+`).FindAllString(out, -1)
		sort.Strings(r)
		return r
	}
	status, stats := rows(report(repo, "status")), rows(report(repo, "stats"))
	if len(status) == 0 {
		t.Fatalf("status reported no token rows at all:\n%s", report(repo, "status"))
	}
	if strings.Join(status, "\n") != strings.Join(stats, "\n") {
		t.Fatalf("the two readers disagree about one log.\n  status: %q\n  stats:  %q", status, stats)
	}
}

func TestEveryOutputCountIsAFloor(t *testing.T) {
	t.Parallel()
	// One run whose tokens name their agent, and one whose do not: stats
	// prints the second as an average per spawn.
	named := tokenRepo(t, phased("implement"))
	tr := transcript(t, named, entry(usage{out: 1234, think: 50}))
	subagentTranscript(t, tr, "a0123456789abcdef", entry(usage{out: 4321, sidechain: true}))
	stop(t, named, tr, nil)
	unnamed := tokenRepo(t, phased("implement"))
	stop(t, unnamed, transcript(t, unnamed, entry(usage{out: 1234}), entry(usage{out: 4321, sidechain: true})), nil)
	appendTo(t, statePath(unnamed, "run-trace.log"), "2026-08-31T00:00:01Z phase=implement agent type=spec-flow:planner status=PLAN_READY\n")
	var printed []string
	for _, repo := range []string{named, unnamed} {
		for _, c := range []string{"status", "stats"} {
			printed = append(printed, report(repo, c))
		}
	}
	all := strings.Join(printed, "\n")
	if !strings.Contains(all, "≥") {
		t.Fatalf("no count was printed as a floor:\n%s", all)
	}
	var bare []string
	for _, m := range regexp.MustCompile(`\b(?:out|think|output:) +(\S+)`).FindAllStringSubmatch(all, -1) {
		if m[1][0] >= '0' && m[1][0] <= '9' {
			bare = append(bare, m[0])
		}
	}
	if len(bare) > 0 {
		t.Fatalf("printed as an exact count: %q\n--- reports ---\n%s", bare, all)
	}
}

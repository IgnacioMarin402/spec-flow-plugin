package agents

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
)

// Budget is one escalation role's cap, its default and its counter (ADR-038).
type Budget struct {
	Key, Counter string
	Fallback     int
}

// Budgets: what opus-budget denies at and what the live view shows.
var Budgets = map[string]Budget{
	"planner":   {Key: "max_opus_calls", Fallback: 6, Counter: "opus_calls"},
	"architect": {Key: "max_architect_calls", Fallback: 3, Counter: "architect_calls"},
}

// BudgetRoles in the order they are reported.
var BudgetRoles = []string{"planner", "architect"}

var digitsOnly = regexp.MustCompile(`^\s*\d+\s*$`)

// BudgetCap is a role's cap from the text of `.claude/spec-flow.config.json`:
// its default when unset or unreadable, -1 when set to anything that is not a
// whole number of calls — no count compares true against it as a cap, so a
// caller must deny instead.
func BudgetCap(configText, role string) int {
	b := Budgets[role]
	settings, _ := ProjectConfig(configText)
	v, ok := settings[b.Key]
	if !ok {
		return b.Fallback
	}
	var f float64
	switch x := v.(type) {
	case float64:
		f = x
	case string:
		// Digits only: Number() would read "0x10" as 16 and "1e1" as 10.
		if !digitsOnly.MatchString(x) {
			return -1
		}
		fmt.Sscan(strings.TrimSpace(x), &f)
	default:
		return -1
	}
	if f < 0 || f != math.Trunc(f) || f > math.MaxInt32 {
		return -1
	}
	return int(f)
}

// NameishFields are every field a spawn or a SendMessage may name its agent
// in: on a SendMessage the key differs across builds.
func NameishFields(input map[string]any) []string {
	var out []string
	for _, k := range []string{"subagent_type", "subagentType", "agent_type", "agent_id", "agentId", "agent", "name", "recipient", "to"} {
		if s, ok := input[k].(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// MatchAgent is the candidate the fields name as a whole word,
// case-insensitive and lowercased, or `""`. Getting either wrong fails OPEN and
// silently: arm-gate would not arm the phase.
func MatchAgent(nameish, candidates []string) string {
	if len(candidates) == 0 {
		return ""
	}
	quoted := make([]string, len(candidates))
	for i, c := range candidates {
		quoted[i] = regexp.QuoteMeta(c)
	}
	re := regexp.MustCompile(`(?i)(^|[^a-zA-Z])(` + strings.Join(quoted, "|") + `)($|[^a-zA-Z])`)
	if m := re.FindStringSubmatch(strings.Join(nameish, " ")); m != nil {
		return strings.ToLower(m[2])
	}
	return ""
}

var wordID = regexp.MustCompile(`^[\w-]+$`)

// Recipient is the session's record of a subagent a SendMessage's `to`
// names, beside its transcript.
type Recipient struct{ To, File string }

// RecipientRecord is that record, or nil when `to` is not an id or there is
// no transcript to look beside.
func RecipientRecord(p hookio.Payload) *Recipient {
	to := hookio.JSString(hookio.Obj(p["tool_input"])["to"])
	transcript := hookio.First(p["transcript_path"], p["transcriptPath"])
	if !wordID.MatchString(to) || transcript == "" {
		return nil
	}
	return &Recipient{to, filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents", "agent-"+to+".jsonl")}
}

// RecipientType is the agent type a SendMessage is for, as the session
// recorded it at the spawn: an id says nothing of the role (ADR-035).
func RecipientType(p hookio.Payload) string {
	rec := RecipientRecord(p)
	if rec == nil {
		return ""
	}
	b, err := os.ReadFile(strings.TrimSuffix(rec.File, ".jsonl") + ".meta.json")
	if err != nil {
		return ""
	}
	var meta map[string]any
	if json.Unmarshal(b, &meta) != nil {
		return ""
	}
	return hookio.JSString(meta["agentType"])
}

// Cold is a resume after the agent's prompt cache expired.
type Cold struct {
	To, Agent string
	AgeMin    float64
	TTLMin    int
	Context   int
}

// ColdResume says whether a SendMessage would resume one of this plugin's
// agents after its cache expired (ADR-025), or nil when it cannot tell — and
// both callers read nil as "not cold": a guess would deny work.
func ColdResume(p hookio.Payload) *Cold {
	rec := RecipientRecord(p)
	if rec == nil {
		return nil
	}
	typ := RecipientType(p)
	st, err := os.Stat(rec.File)
	if err != nil {
		return nil
	}
	b, err := os.ReadFile(rec.File)
	if err != nil {
		return nil
	}
	agent := MatchAgent([]string{typ}, Roles())
	if agent == "" {
		return nil
	}
	// The TTL is read off the agent's own last cache write: a subagent writes
	// 5-minute entries and a session 1-hour ones (measured).
	ttl, context := 0, 0
	lines := strings.Split(string(b), "\n")
	for i := len(lines) - 1; i >= 0 && ttl == 0; i-- {
		if !strings.Contains(lines[i], `"usage"`) {
			continue
		}
		var entry struct {
			Message struct {
				Usage *struct {
					Input         float64 `json:"input_tokens"`
					CacheRead     float64 `json:"cache_read_input_tokens"`
					CacheCreation float64 `json:"cache_creation_input_tokens"`
					Split         struct {
						H1 float64 `json:"ephemeral_1h_input_tokens"`
						M5 float64 `json:"ephemeral_5m_input_tokens"`
					} `json:"cache_creation"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(lines[i]), &entry) != nil || entry.Message.Usage == nil {
			continue
		}
		u := entry.Message.Usage
		if context == 0 {
			context = int(u.Input + u.CacheRead + u.CacheCreation)
		}
		if u.Split.H1 > 0 {
			ttl = 60
		} else if u.Split.M5 > 0 {
			ttl = 5
		}
	}
	if ttl == 0 {
		return nil
	}
	// The file's last write is AFTER the request that last touched the cache,
	// so this can only understate the age: a resume it calls cold is cold.
	age := time.Since(st.ModTime()).Minutes()
	if age <= float64(ttl) {
		return nil
	}
	return &Cold{To: rec.To, Agent: agent, AgeMin: age, TTLMin: ttl, Context: context}
}

// DispatchedIn are the roles each phase dispatches, read off both commands.
// The implementer is absent: engaging it moves the phase, which is arm-gate's.
var DispatchedIn = map[string][]string{
	"spec":      {"spec-writer"},
	"plan":      {"planner"},
	"review":    {"reviewer", "planner"},
	"implement": {"architect", "planner", "spec-writer"},
	"blocked":   {},
}

var whitespace = regexp.MustCompile(`\s+`)

// Field is one `k=v` of a dispatch line.
type Field struct{ Key, Value string }

// RecordDispatch writes one `dispatch` line to run-trace.log: `agent=`, not
// `type=`, which stats reads as an agent's return. Every value is
// whitespace-free, because the log is read back by a whitespace split.
func RecordDispatch(root string, p hookio.Payload, phase, agent, result, why string, extra ...Field) {
	safe := func(v string) string {
		if v = whitespace.ReplaceAllString(v, ""); v == "" {
			return "-"
		}
		return v
	}
	session := ""
	for _, v := range []any{p["session_id"], p["sessionId"]} {
		if s, ok := v.(string); ok && wordID.MatchString(s) {
			session = " session=" + s
			break
		}
	}
	fields := []Field{{"agent", agent}, {"tool", hookio.JSString(p["tool_name"])}, {"result", result}, {"why", why}}
	parts := make([]string, 0, len(fields)+len(extra))
	for _, f := range append(fields, extra...) {
		parts = append(parts, f.Key+"="+safe(f.Value))
	}
	hookio.AppendLine(filepath.Join(hookio.StateDir(root), "run-trace.log"), fmt.Sprintf("%s phase=%s%s dispatch %s", hookio.NowISO(), safe(phase), session, strings.Join(parts, " ")))
}

var (
	// Its work order, in either separator: Windows names `specflow\x\milestones\M2.md`.
	workOrder = regexp.MustCompile(`specflow[\\/]([^\\/\s"'` + "`" + `]+)[\\/]milestones[\\/](M\d+)\.md`)
	bareRef   = regexp.MustCompile(`milestones[\\/](M\d+)\.md`)
	bareGuard = regexp.MustCompile(`[\w.-][\\/]?$`)
)

// MilestoneRef is the milestone an implementer's spawn works on: the first
// work order its prompt names, else a bare `milestones/<Mk>.md` starting a
// path, with no change. ok is false when it names neither. One reading for
// every reader: the live view finds the agent a record names by it.
func MilestoneRef(prompt any) (change, milestone string, ok bool) {
	text, _ := prompt.(string)
	if m := workOrder.FindStringSubmatch(text); m != nil {
		return m[1], m[2], true
	}
	// `docs/milestones/M1.md` is some other file: what precedes must not be a
	// path segment.
	for _, loc := range bareRef.FindAllStringSubmatchIndex(text, -1) {
		if !bareGuard.MatchString(text[:loc[0]]) {
			return "", text[loc[2]:loc[3]], true
		}
	}
	return "", "", false
}

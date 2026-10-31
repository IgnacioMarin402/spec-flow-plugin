package agents

import (
	"encoding/json"
	"os"
	"strings"
	"time"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/hookio"
)

// Long past the lag measured between a stop and its handback line, short
// beside a hook's timeout (ADR-050).
var (
	HandbackWait = 2000 * time.Millisecond
	handbackPoll = 25 * time.Millisecond
)

// The `message` of the last SubagentHandback call in a transcript.
func handbackIn(path string) (string, bool) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	lines := strings.Split(string(b), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if !strings.Contains(lines[i], `"SubagentHandback"`) {
			continue
		}
		var entry struct {
			Message struct {
				Content []json.RawMessage `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal([]byte(lines[i]), &entry) != nil {
			continue
		}
		for j := len(entry.Message.Content) - 1; j >= 0; j-- {
			var c struct {
				Type, Name string
				Input      map[string]any
			}
			if json.Unmarshal(entry.Message.Content[j], &c) != nil || c.Type != "tool_use" || c.Name != "SubagentHandback" {
				continue
			}
			if msg, ok := c.Input["message"].(string); ok {
				return msg, true
			}
			break
		}
	}
	return "", false
}

// HandedBack is the report a stopped subagent handed its caller: the last
// SubagentHandback's `message` in its transcript, else its last message. A
// stop with neither yet is waited on, briefly: the line can land after the
// stop fires (ADR-050). run-trace records it and agent-gate judges it.
func HandedBack(p hookio.Payload) string {
	path := hookio.Str(p["agent_transcript_path"])
	last := hookio.Str(p["last_assistant_message"])
	if path == "" {
		return last
	}
	if found, ok := handbackIn(path); ok {
		return found
	}
	if strings.TrimSpace(last) != "" {
		return last
	}
	for deadline := time.Now().Add(HandbackWait); time.Now().Before(deadline); {
		time.Sleep(handbackPoll)
		if late, ok := handbackIn(path); ok {
			return late
		}
	}
	return last
}

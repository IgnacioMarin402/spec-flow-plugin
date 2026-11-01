// Package canrun says whether this engine can run in a directory: what
// preflight asks at a run's first spawn and phase-guard at the write that
// starts one (ADR-028). One copy, so the two cannot drift.
package canrun

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/IgnacioMarin402/spec-flow-plugin/internal/agents"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/contract"
	"github.com/IgnacioMarin402/spec-flow-plugin/internal/gitscope"
)

// SettingsProblems are what in `.claude/spec-flow.config.json` cannot be
// applied: a cap opus-budget denies every call at, a route model-route denies
// every spawn over, or a file none of whose settings apply.
func SettingsProblems(root string) []string {
	b, err := os.ReadFile(agents.ProjectConfigPath(root))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return []string{fmt.Sprintf("could not be read (%v), so none of its settings apply", err)}
	}
	text := string(b)
	settings, problem := agents.ProjectConfig(text)
	if problem != "" {
		return []string{problem}
	}
	var out []string
	for _, role := range agents.BudgetRoles {
		if agents.BudgetCap(text, role) < 0 {
			key := agents.Budgets[role].Key
			v, _ := json.Marshal(settings[key])
			out = append(out, fmt.Sprintf(`"%s": %s is not a whole number of calls, so opus-budget would deny every %s call.`, key, v, role))
		}
	}
	_, routing := agents.ProjectRouting(root, agents.ShippedRouting())
	return append(out, routing...)
}

// Can is what a run here starts from.
type Can struct {
	Config *contract.Config
	Base   string
}

// Check errs with the first failure, its Kind naming it: `no-repository`
// and `not-root`, then `contract`, `base`, `foreign-change`. The repository
// first: a contract read from a subdirectory is the wrong one (ADR-027).
func Check(root string) (*Can, error) {
	if err := gitscope.AssertRepoRoot(root); err != nil {
		return nil, err
	}
	cfg, err := contract.Load(root)
	if err != nil {
		return nil, &gitscope.KindError{Kind: "contract", Msg: err.Error()}
	}
	base, err := gitscope.ResolveBase(root, cfg)
	if err != nil {
		return nil, &gitscope.KindError{Kind: "base", Msg: err.Error()}
	}
	// A run here could never be marked done: `done` needs every change folder
	// archived, and this one is no run of this branch to archive (ADR-032).
	if foreign := gitscope.ChangesAtBase(root, base); len(foreign) > 0 {
		folders := make([]string, len(foreign))
		for i, s := range foreign {
			folders[i] = "specflow/" + s + "/"
		}
		are, them := "is", "it"
		if len(foreign) > 1 {
			are, them = "are", "them"
		}
		return nil, &gitscope.KindError{Kind: "foreign-change", Msg: fmt.Sprintf("%s %s live, and the base branch already has %s, so no run on this branch created %s. ", strings.Join(folders, ", "), are, them, them) +
			"A folder under specflow/ is a change in flight, and a run is not done while one is unarchived. " +
			"A plan nobody has run belongs outside specflow/; a change that was dropped or shipped gets its **Status:** stamp and moves to specflow/archive/. " +
			"Either is the human's call, best made on the base branch so the next branch does not inherit it."}
	}
	return &Can{cfg, base}, nil
}

// CheckStart is Check and the settings (`settings`): what phase-guard asks of
// the write that starts a run. Not preflight at each spawn: mid-run each hook
// applies what it can, and a refusal there would stop every spawn (ADR-049).
func CheckStart(root string) (*Can, error) {
	can, err := Check(root)
	if err != nil {
		return nil, err
	}
	if s := SettingsProblems(root); len(s) > 0 {
		return nil, &gitscope.KindError{Kind: "settings", Msg: ".claude/spec-flow.config.json cannot be applied:\n  - " + strings.Join(s, "\n  - ") + "\nFix each, or remove the setting to take its default."}
	}
	return can, nil
}

# spec-flow — the engine

A spec-driven multi-agent pipeline for Claude Code: a free-text requirement
becomes a spec (with a human sign-off), a milestone-by-milestone plan, a
review pass, and an implementation loop gated by lint, tests and requirement
traceability running **outside the model**. Two orchestrators —
`/spec-flow` for a feature, `/spec-fix` for a defect — drive five subagents,
each pinned to the model its job actually needs (Haiku for a checklist pass,
Sonnet for writing code, Opus for planning and hard calls, budgeted).

This repository is the **engine**: the hooks, the agents, the commands, and
the checks that make the whole thing hold together. It has no opinion about
what language, framework or architecture the repo it runs in uses. That
opinion — and everything the engine needs to know to run correctly — lives in
one file the *consuming* repo writes: `.spec-flow/config.json`.

## Install

```bash
claude marketplace add IgnacioMarin402/spec-flow-plugin
claude plugin install spec-flow@spec-flow-marketplace
```

## The one file a consuming repo must write

Nothing below is optional if you want to run `/spec-flow` or `/spec-fix`:

```json
{
  "contract_version": 1,
  "verify": {
    "scope_globs": ["*.ts"],
    "lint": ["node", "node_modules/.bin/eslint", "--fix"],
    "lint_no_fix": ["node", "node_modules/.bin/eslint"],
    "test": ["node", "node_modules/.bin/vitest", "run"],
    "test_name": "vitest",
    "lint_name": "eslint",
    "lint_config_hint": "eslint.config.mjs"
  },
  "trace": {
    "specs_dir": "specs",
    "proof_dir": "src",
    "proof_suffix": ".test.ts"
  },
  "extra_checks": [],
  "unscoped_denied": {
    "scripts": ["test", "lint"],
    "tools": ["eslint", "vitest"],
    "scoped_allowed": ["check"],
    "scoped_alternative": "npm run check"
  }
}
```

Put this at `.spec-flow/config.json` in the repo root. `verify` says how to
lint and test; `trace` says where specs live and what a proof file looks like
— `spec-trace` uses this to bind a requirement id to the test that proves it,
in both directions; `extra_checks` is how your own project-specific checks
(an architecture rule, a boundary check) plug into the same gate;
`unscoped_denied` is what the engine redirects when an agent tries to run the
whole suite mid-milestone instead of the scoped form.

**There is no fallback that guesses these for you.** A repo this engine has
never seen has no safe default test runner or proof directory — see
`scripts/spec-flow-config.mjs`'s own header for why a missing or incomplete
contract fails loudly, with a message naming exactly what to add, rather than
silently running with someone else's values.

Also required: `specs/` (capability specs, one per module, each starting
`<!-- spec-scope: <path> -->`) and `specflow/` (where live change specs and
`specflow/archive/` for finished ones live) as directories in the repo root.
The engine creates entries under them; it does not create the directories.

## Two ways to reach the same checks

The hooks (`hooks/*.mjs`) are how Claude Code itself enforces the gate,
armed automatically once a run reaches the `implement` phase. But
`${CLAUDE_PLUGIN_ROOT}` — how a hook finds its own installation — only
exists inside a Claude Code session. A human's terminal and CI need the same
checks and do not have it, so this also ships as an installable CLI:

```bash
npm install --save-dev github:IgnacioMarin402/spec-flow-plugin
```

```json
{
  "scripts": {
    "check": "spec-flow check",
    "spec:check": "spec-flow trace",
    "flow:stats": "spec-flow stats"
  }
}
```

The hook and these aliases resolve to and run the **same file** — that is
what keeps "same files, same commands, same result" structural rather than a
promise kept by two copies that happen to agree today. See
`bin/spec-flow.mjs`.

## Commands and agents

- `/spec-flow <requirement>` — the full pipeline: spec, plan, review,
  milestone-by-milestone implementation, fold.
- `/spec-fix <what's broken>` — the lighter defect flow: triage against
  `specs/`, one implementer pass, same gate. No planner, no reviewer.
- `agents/` — `spec-writer` (Sonnet), `planner` (Opus), `reviewer` (Haiku),
  `implementer` (Sonnet), `architect` (Opus).

### Skills: the one capability this engine gives up on purpose

The agents here declare **no** `skills:` frontmatter, and cannot. Preloading
happens before an agent reads anything, so it has to name specific skills —
and a skill encodes how one codebase is built, which is exactly what this
engine has no business knowing. The repo this was extracted from preloaded
two (`where-does-it-live`, a layer router; `write-path`, guarding a mistake
that is expensive to unwind); shipping those names here would fail
`no-repo-refs.mjs` on sight, correctly.

So `implementer.md` and `planner.md` carry the `Skill` *tool* and are told to
read `.spec-flow/skills.md` — a decision→skill table the consuming repo
writes — and load whatever it routes them to, on demand.

**This is a real capability loss, not a neutral refactor.** On-demand loading
fires only once the agent already suspects it needs the skill, which is
precisely the case a preload was protecting. A consuming repo that wants it
back adds its own `agents/implementer.md` with a `skills:` line naming its own
skills. Whether a project-level agent cleanly overrides a plugin-shipped one
of the same name is **not something this repo has verified** — check it before
relying on it.

## Development

```bash
npm install
npm run lint        # eslint over hooks/ and scripts/
npm run typecheck    # tsc --noEmit --checkJs — this repo's own type check
npm run check        # no-repo-refs.mjs — no coupling to the origin repo
npm run gate:check    # gate-fixture.mjs — the gate holds under its own failure modes
```

All four run in CI on every push and PR.

## Design history

This engine used to be fused into one repo
(`api-nestjs-with-spec-driven-development`), and the extraction — what moved,
what stayed, what the language decision cost and why, three defects the
fixture in `scripts/gate-fixture.mjs` was built to catch — is documented in
that repo's `docs/spec-flow-as-a-plugin.md`. This repo does not duplicate it.

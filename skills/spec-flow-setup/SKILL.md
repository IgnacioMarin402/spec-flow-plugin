---
name: spec-flow-setup
description: Set up or repair this repo's spec-flow contract — run init, fill the fields it could not read, make the test command emit a report the engine can read, and prove the result with a green check. Use when a repo has no .spec-flow/config.json, when init left MISSING or REVIEW lines, when a run refuses to start because the contract does not load, or when the user asks to adopt, configure or onboard spec-flow.
---

# Setting up the contract

`init` reads what a repo declares about itself and refuses to invent the rest.
For a repo whose manifest declares its commands that is nearly the whole job;
for every other repo it reports a list and stops. **You are the second half:**
you supply what the repo did not declare, and then you prove the result rather
than announcing it.

Two rules govern everything below, and they are the reason this is a skill and
not a script (see ADR-006):

- **Never write a value you did not read or verify.** A field filled with a
  plausible guess is worse than the `MISSING` line it replaced — that line was
  honest.
- **You are not the check.** Nothing you conclude counts until
  `check-changed.mjs` exits 0. Your last action is running it and quoting what
  it said.

## 1. Ask the engine first

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs
```

If `.spec-flow/config.json` already exists, do **not** re-run this with
`--force` — that is for a repo whose contract you mean to regenerate. Read the
existing file and go to step 4; you are repairing, not adopting.

`init` sorts every field into `detected`, `REVIEW` or `MISSING`, and exits
non-zero while anything is missing. That output is your worklist. Nothing else
is.

## 2. Fill what it could not read

For each `MISSING` field, find what the repo already declares — its manifest,
its linter's configuration file, the directory its tests live in, the naming
its test files follow. Read those files. If a field cannot be determined from
anything in the repo, **ask the user**; do not pick a default.

`REVIEW` lines are inferences the engine made and wants confirmed. Confirm them
against the repo, and correct the ones that are wrong.

Two that are worth extra care because a wrong value is quiet rather than loud:

- **the lint command must take file paths appended to it.** The gate appends
  the changed files itself. A command with a target already in it lints the
  whole repo on every gate, which undoes the scoping that keeps a milestone
  from being blocked by debt it never touched.
- **`proof_dir` and `proof_suffix` are where agents PUT new tests.** They no
  longer decide what counts as proof, so a wrong value costs consistency rather
  than a blocked gate — which is exactly why nothing will tell you it is wrong.

## 3. Make the suite report what ran

The engine binds a requirement to a test by reading a report that says which
tests **executed** — a test that was skipped must not appear in it, because
otherwise skipping becomes the cheapest way to silence a red suite. It reads
two formats, JUnit XML and TAP, and it does not know or care which tool wrote
the file.

**`init` appends the flag itself for the runners it knows**, and says so in a
`REVIEW` line naming what it added to `verify.test`. When you see that line
your job is to confirm it, not to redo it — and step 4 is what confirms it.

You only supply the flag yourself when `init` said it could not: its
`trace.report` line names the runner it did not recognise. Then find the flag
that runner uses to write a machine-readable report and append it to
`verify.test`, so the file lands at `trace.report.path`. One thing to get
right: the report must be written by the **same run** the gate performs — one
command, not a second pass. The engine does not run the suite twice.

If the runner has no standard report at all, the contract's escape hatch is
`trace.executed_tests` — argv printing one executed test per line. Prefer the
report; reach for this only when there is genuinely nothing to configure.

## 4. Prove it, in this order

Do not skip to the end. Each step tells you something the next one cannot.

```bash
# a. the contract loads and is complete
node ${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs        # expect: valid, no MISSING

# b. the suite runs AND the report lands
<the repo's test command>
ls -l <trace.report.path>

# c. the whole route, the way the gate will run it
node ${CLAUDE_PLUGIN_ROOT}/scripts/check-changed.mjs
```

**Step b is not optional and not replaceable by reading the config.** The most
likely thing to be wrong is the flag, and the only thing that can tell you is a
file appearing on disk.

If (c) exits non-zero, read what it named and fix that. `spec-trace` refusing
because the report is not where the contract says is a wrong flag, not an
unproven requirement — it says so in the message.

## 5. Report honestly

Tell the user:

- what you filled in, and **what you read to decide each value**;
- the flag you added, and that you saw the report file appear;
- the exit line from `check-changed`, quoted;
- anything you could not determine and left for them.

If the check is not green, say that plainly and say what is failing. A setup
reported as finished over a red check is the exact failure this engine exists
to close, arriving through the door meant to prevent it.

## Model routing is a different file, and not your job here

`.claude/spec-flow.config.json` holds preferences rather than facts: the
escalation cap `max_opus_calls`, and an optional `agents` block re-routing an
agent to a different model tier. `init` does not write it and a repo needs none
of it to run, so **do not set one during setup**. You have no evidence about
what this repo's work should cost, and the rule at the top of this file governs
a preference exactly as it governs a field — a plausible guess is worse than an
absent value.

Do run it once, and say what it printed in your step 5 report:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/model-routing.mjs
```

It names the tier each agent will run on and which layer decided it, and it
exits non-zero when a routing block is already present and unusable. That last
case is worth catching at setup: until it is fixed every spec-flow spawn is
denied, and the first symptom otherwise is a run that will not start.

## What this skill must never contain

**No runner names, no flags, no per-ecosystem tables.** There is exactly one
list of runners in this package and it lives in `scripts/init.mjs`, where it is
executed rather than described (ADR-007). A second copy here would be prose
nothing runs, free to drift from the table that actually configures a repo, and
you would have no way to tell which one was stale. Your own knowledge covers
the runners that table does not — that is the case step 3 hands you, and it
needs no list.

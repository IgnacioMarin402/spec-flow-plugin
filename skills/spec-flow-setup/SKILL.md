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

This is the one field no file in the engine can propose, and the reason this
skill exists.

The engine binds a requirement to a test by reading a report that says which
tests **executed** — a test that was skipped must not appear in it, because
otherwise skipping becomes the cheapest way to silence a red suite. It reads
two formats, JUnit XML and TAP, and it does not know or care which tool wrote
the file.

So: **find the flag this repo's test runner uses to write a machine-readable
report, and add it to the test command** so the file lands at
`trace.report.path`. Use what you know about the runner in front of you. Two
things to get right:

- the report must be written by the **same run** the gate performs — one
  command, not a second pass. The engine does not run the suite twice.
- if the runner writes to a directory that must already exist, make sure the
  repo creates it or the path points somewhere that survives a fresh clone.

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

## What this skill must never contain

**No runner names, no flags, no per-ecosystem tables.** That knowledge is
yours at runtime; the moment it is written down here it becomes a list inside
the package that looks maintained and quietly is not — refused in ADR-002,
re-refused in ADR-006, and enforced by `scripts/no-repo-refs.mjs`, which scans
this file. Adding one turns CI red.

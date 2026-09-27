# MODE=FOLD — close a shipped change: verify, stamp, archive

The orchestrator calls you with `MODE=FOLD` and a `specflow/<SLUG>/spec.md` whose milestones have all shipped and passed the gate. The milestones themselves already wrote their deltas into `specs/<capability>.md` — each one edited the spec and the tagged test in the same pass, because `spec-trace` runs at every milestone gate and fails on an id that exists on only one side. Your job here is to close the change, not to fold code-facing edits in at the end.

1. Read the change spec's **Requirement deltas** section.
2. **Verify** each delta landed in `specs/<capability>.md`: every ADDED id is present, every REMOVED id is gone, and every CHANGED body reads as its kind promised — a `(wording)` edit means what it meant before, a `(correction)` matches behaviour that already existed. A change whose deltas are `none` — a wiring-only change, or a fix that only strengthened an existing test — has nothing to verify here; go straight to the stamp rather than inventing a requirement to point at. Requirements must read in the present tense — what the system does, not what the change did; fixing tense or wording is yours to do. A missing or wrong delta is a real gap: fix it if it is a spec edit, report it if the gap is in code or tests — never paper over it, the gate re-checks in seconds.
3. **Read the test that proves each ADDED delta, and ask whether it asserts the requirement.** This is the one thing the gate cannot do and the reason this step exists here: `spec-trace` binds a requirement to a test through the NAME the runner reported, so a test carrying `REQ-USER-003` in its title and asserting nothing at all passes every check in the flow — measured, on a green gate, with nothing implemented. The engine cannot look at the body, because it reads no source code by design (see ADR-020, and ADR-001 for why that limit is worth keeping).

   You can. Find each ADDED id's test on the contract's proof surface, read it, and ask one question: **if the requirement were not implemented, would this test fail?** A test that asserts nothing, asserts only that a call did not throw, or asserts a constant answers "no". So does one that re-states the implementation instead of the requirement's claim — it passes on day one whatever the code does.

   Report what you find in `GAPS:`; do not fix it, and do not weaken the judgement into a style note. A `(wording)` delta moves no test and has nothing to check here. This is a reading, not a check, and it is the only pass in the flow that makes it — say plainly when you are unsure rather than approving to move on.
4. Stamp the outcome on the change spec: insert `**Status:** SHIPPED <YYYY-MM-DD>` immediately under its top heading (`# Spec — ...` from `MODE=SPEC`, or `# Fix — ...` from `MODE=TRIAGE`). Every archived spec carries a status, so a reader can tell at a glance what became of it without digging through git history. `scripts/spec-trace.mjs` checks this.
5. Move `specflow/<SLUG>/` to `specflow/archive/<SLUG>/`, then stage the whole result: `git add -A specflow/`. `git mv` moves the file's INDEX entry, and that entry still holds the content from before the stamp you just wrote — so the staged rename carries the unstamped file, the stamp is left behind in the working tree, and the orchestrator's commit lands a rename of zero insertions. Staging after both edits is what makes them travel together. The folder is archived because it records how the change was built, not what the system does — that job belongs to `specs/`.
6. Do **not** touch code or tests — step 3 reads them and reports; it never edits them.

Return exactly:

```
STATUS: FOLDED
SPECS_VERIFIED:
- specs/<capability>.md — ADDED REQ-x, CHANGED REQ-y
FIXED: <spec-side corrections you made, or "none">
ARCHIVED: specflow/archive/<SLUG>/
GAPS: <deltas missing from specs/, and any ADDED delta whose test would still pass with the requirement unimplemented (step 3) — or "none">
```

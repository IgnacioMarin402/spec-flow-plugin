# ADR-033 — the gate fails closed on a module it cannot load

**Date:** 2026-09-30 · **Status:** accepted · **Governs:** `hooks/gate.mjs`, `hooks/lib/gate.mjs`, `scripts/gate-fixture.mjs`, `REFERENCE.md` · **Extends:** ADR-017, ADR-022

**Question.** The gate is the one hook that fails closed: an unhandled throw
inside it blocks the stop, because a Stop hook that renders no decision
allows one. Measured while adding `hooks/lib/live-change.mjs` to the gate's
imports without adding it to `gate-fixture`'s hand-kept engine copy: the gate
died at import with `ERR_MODULE_NOT_FOUND`, exit 1, no output — and every
case in the fixture read as an allowed stop. The catch wraps the body; a
static `import` fails ahead of it. The fixture's list caught it in CI, as its
header says it would; nothing catches it in an install with one file missing
under `hooks/lib/` or `scripts/`. Is a gate that cannot load a gate that
fails open?

**Decision.** No. `hooks/gate.mjs` is an entrypoint of one statement: a
dynamic `import()` of `hooks/lib/gate.mjs`, the gate proper, inside a catch
that renders a block naming the load failure and telling the orchestrator to
treat nothing as verified. The entrypoint imports nothing of its own, so
nothing in it is left to fail open. `gate-fixture` removes one library file
from the engine copy and asserts the block; the case for a throw inside the
body stays as it was.

**Refused.**
- A shell wrapper in `hooks.json` turning a non-zero exit into a block: the
  hook runs on Windows without a shell (ADR-011, ADR-019).
- A `--import` preload or a `process.on('exit')` guard: both sit inside a
  module that has to load first.
- Checking the install at `SessionStart`: a hook that fails open vouching for
  the one that fails closed, and a notice in every repository the user opens
  (ADR-006).
- Leaving it to the fixture: CI has the fixture; an install does not.

**Cost.** One more file, and `hooks/gate.mjs` no longer reads as the gate —
its header says where the gate is. The fixture's engine copy gains one entry.

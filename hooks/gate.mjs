#!/usr/bin/env node
/**
 * The gate's entrypoint. The gate itself is `hooks/lib/gate.mjs`; this file
 * exists to load it inside the same fail-closed shape its body has.
 *
 * A Stop hook that exits without rendering a decision ALLOWS the stop, and a
 * static `import` that cannot be resolved exits exactly that way — ahead of
 * any catch in the module that declares it. A plugin missing one file under
 * `hooks/lib/` or `scripts/` would therefore pass every milestone in silence,
 * which is the failure this engine exists to close (measured: ADR-033).
 * `import()` can be caught; `import` cannot. This file imports nothing of its
 * own, so nothing here is left to fail open.
 */
try {
  await import('./lib/gate.mjs');
} catch (err) {
  // `emitBlock`'s shape, inlined: `lib/io.mjs` may be the file that is missing.
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `GATE FAILED — the gate itself could not be loaded: ${err?.message ?? err}. Nothing was linted, tested or traced, so treat NOTHING as verified. ` +
        "A file the gate depends on under the plugin's hooks/lib/ or scripts/ is missing or does not parse — a broken or partial install. Do not change the phase; a human reinstalls the plugin before this run can continue.",
    }),
  );
  process.stderr.write(`[spec-flow] gate.mjs could not load the gate: ${err?.stack ?? err}\n`);
}

#!/usr/bin/env node
/**
 * The CLI half of "two manifests, one source"
 * (docs/spec-flow-as-a-plugin.md in the engine repo, "Two manifests, one
 * source"). `${CLAUDE_PLUGIN_ROOT}/hooks/*.mjs` is how Claude Code itself
 * reaches this engine; this is how everything else does — a human's
 * terminal, and CI, neither of which has `${CLAUDE_PLUGIN_ROOT}` or Claude
 * Code installed. A consuming repo's package.json aliases through it:
 *
 *   "check":      "spec-flow check"
 *   "spec:check": "spec-flow trace"
 *   "flow:stats": "spec-flow stats"
 *
 * so the hook and these aliases resolve to and run the SAME file — which is
 * what keeps "same files, same commands, same result" structural instead of
 * a promise kept by two copies that happen to agree today.
 */
const [, , sub, ...rest] = process.argv;

const commands = {
  check: '../scripts/check-changed.mjs',
  trace: '../scripts/spec-trace.mjs',
  stats: '../scripts/specflow-stats.mjs',
};

if (!sub || !commands[sub]) {
  console.error(`spec-flow: usage: spec-flow <${Object.keys(commands).join('|')}> [args...]`);
  process.exit(1);
}

// Reassigned before importing, not left as [node, this-file, sub, ...rest]:
// the target scripts read process.argv positionally (telemetry-style flags)
// or via .includes('--flag'), and either way they expect to see only THEIR
// OWN args, not this dispatcher's subcommand name ahead of them.
process.argv = [process.argv[0], process.argv[1], ...rest];

await import(new URL(commands[sub], import.meta.url).href);

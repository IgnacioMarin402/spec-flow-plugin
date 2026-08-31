#!/usr/bin/env node
/**
 * How everything outside Claude Code reaches this engine — a human's terminal,
 * and CI, neither of which has `${CLAUDE_PLUGIN_ROOT}` or Claude Code
 * installed. A consuming repo's package.json aliases through it:
 *
 *   "check":      "spec-flow check"
 *   "spec:check": "spec-flow trace"
 *   "flow:stats": "spec-flow stats"
 *
 * The hooks reach the engine through `${CLAUDE_PLUGIN_ROOT}` and these aliases
 * reach it through `node_modules`, so they are two copies on disk, not one
 * file. What keeps them the same ENGINE is that both come from this repository
 * and nothing is published anywhere else: the plugin resolves to a commit SHA
 * (ADR-003) and the dependency is a git spec against the same repo (ADR-016).
 * Install the second from a registry and the two acquire independent version
 * axes, which is the drift ADR-016 exists to refuse.
 */
import { fileURLToPath } from 'node:url';

const [, , sub, ...rest] = process.argv;

const commands = {
  init: '../scripts/init.mjs',
  check: '../scripts/check-changed.mjs',
  trace: '../scripts/spec-trace.mjs',
  stats: '../scripts/specflow-stats.mjs',
  // The state a run leaves between turns, rendered. `stats` asks what the
  // telemetry MEANS across every archived run; this one answers where the
  // live run is right now, which is the question you have while it is running
  // and the one a Stop hook's own channel cannot reach you with (ADR-010).
  status: '../scripts/status.mjs',
  // Reachable from a terminal and not only through `/spec-flow:models`,
  // because the question it answers — what will this agent actually run on —
  // is one you ask while editing the config, which is not a moment you are
  // necessarily inside Claude Code.
  models: '../scripts/model-routing.mjs',
  // The orchestrator runs this one twice per run — `--mark` at intake and
  // `<SLUG>` at DONE. It was reachable through neither this dispatcher nor a
  // documented path for a while, which is a quiet way to lose every run's
  // evidence: the snapshot is what moves telemetry out of gitignored state
  // and into the change folder, so a run whose snapshot never fires leaves
  // nothing behind for `stats` to read.
  telemetry: '../scripts/telemetry-snapshot.mjs',
};

if (!sub || !commands[sub]) {
  console.error(`spec-flow: usage: spec-flow <${Object.keys(commands).join('|')}> [args...]`);
  process.exit(1);
}

const target = new URL(commands[sub], import.meta.url);

// Reassigned before importing, not left as [node, this-file, sub, ...rest]:
// the target scripts read process.argv positionally (telemetry-style flags)
// or via .includes('--flag'), and either way they expect to see only THEIR
// OWN args, not this dispatcher's subcommand name ahead of them.
//
// argv[1] becomes the TARGET's path, not this dispatcher's, and that is
// load-bearing rather than cosmetic. A script that guards its CLI section
// with the standard `fileURLToPath(import.meta.url) === process.argv[1]`
// compares itself against argv[1]; leaving this file's path there makes that
// test false forever, so the script imports cleanly, runs nothing, and exits
// 0. `spec-flow init` shipped in exactly that state — a documented command
// that silently did nothing, which is this engine's signature failure wearing
// a dispatcher.
process.argv = [process.argv[0], fileURLToPath(target), ...rest];

await import(target.href);

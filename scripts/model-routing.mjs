#!/usr/bin/env node
/**
 * What each agent will actually run on in THIS repo, and who decided it.
 *
 *   spec-flow models
 *   node scripts/model-routing.mjs
 *
 * Three layers answer that question and no file shows more than one of them:
 * the tier an agent's frontmatter ships, the project's override of that tier
 * in `.claude/spec-flow.config.json`, and what the harness resolves the tier
 * to — which `ANTHROPIC_DEFAULT_*_MODEL` can pin. Reading any one of them and
 * concluding is how you get a confident wrong answer, so this reads all three
 * and names the source of every value it prints.
 *
 * **It refuses to guess the third layer.** Nothing here can know what Claude
 * Code currently resolves `opus` to; only an explicit pin is knowable, and
 * naming a likely model anyway — in the one report whose subject is which
 * model runs — would be the exact rot ADR-012 removed, reintroduced by the
 * file explaining it. Unpinned prints as unpinned. `model-pins.mjs` caught
 * this header doing it.
 *
 * Exits non-zero when the routing block is unusable, so this doubles as the
 * way to find that out without provoking a denied spawn. Same problems, same
 * wording, one reader — see `hooks/lib/routing.mjs`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALIASES, shippedRouting, projectRouting } from '../hooks/lib/routing.mjs';

const root = process.cwd();

/**
 * A tier's pin, if some settings layer names one, plus where it came from.
 *
 * Best-effort by construction: a real environment variable beats a settings
 * file, `settings.local.json` beats `settings.json`, and an organisation's
 * managed settings are not readable from here at all. Every value printed
 * carries its source so a reader can tell what this could and could not see.
 */
function envPins() {
  const pins = {};

  const layers = [
    ['.claude/settings.json', join(root, '.claude', 'settings.json')],
    ['.claude/settings.local.json', join(root, '.claude', 'settings.local.json')],
  ];

  for (const [label, path] of layers) {
    if (!existsSync(path)) continue;
    let env;
    try {
      env = JSON.parse(readFileSync(path, 'utf8')).env;
    } catch {
      continue; // a settings file this cannot parse is Claude Code's to complain about
    }
    if (!env || typeof env !== 'object') continue;
    for (const tier of ALIASES) {
      const value = env[`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`];
      if (typeof value === 'string' && value) pins[tier] = { value, source: label };
    }
  }

  // The shell wins over any file, per Claude Code's own precedence for this
  // variable family, so it is applied last.
  for (const tier of ALIASES) {
    const value = process.env[`ANTHROPIC_DEFAULT_${tier.toUpperCase()}_MODEL`];
    if (typeof value === 'string' && value) pins[tier] = { value, source: 'the environment' };
  }

  return pins;
}

const shipped = shippedRouting();
const { routing, problems } = projectRouting(root, shipped);
const declared = (() => {
  const path = join(root, '.claude', 'spec-flow.config.json');
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')).agents ?? {};
  } catch {
    return {};
  }
})();

if (problems.length > 0) {
  console.error(`spec-flow models: the routing in .claude/spec-flow.config.json cannot be applied.\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`\nEvery spawn of a spec-flow agent is denied until this is fixed.`);
  process.exit(1);
}

const agents = Object.keys(shipped).sort();
if (agents.length === 0) {
  console.error('spec-flow models: no agents found. This engine is not installed where it thinks it is.');
  process.exit(1);
}

const pins = envPins();
const rows = agents.map((agent) => {
  const fallback = shipped[agent];
  const tier = routing[agent] ?? fallback;

  let decided;
  if (!(agent.toLowerCase() in Object.fromEntries(Object.entries(declared).map(([k, v]) => [k.toLowerCase(), v])))) {
    decided = 'plugin default';
  } else if (tier === fallback) {
    decided = 'project (restates the default)';
  } else {
    decided = `project (was ${fallback})`;
  }

  const pin = pins[tier];
  const resolves = pin ? `${pin.value}  — pinned by ${pin.source}` : 'whatever Claude Code resolves this tier to (unpinned)';

  return { agent, tier, decided, resolves };
});

const w = (key) => Math.max(key.length, ...rows.map((r) => String(r[key]).length));
const widths = { agent: w('agent'), tier: w('tier'), decided: w('decided') };
const pad = (s, n) => String(s).padEnd(n);

console.log(`spec-flow models — how each agent will be routed in ${root}\n`);
console.log(
  `  ${pad('AGENT', widths.agent)}  ${pad('TIER', widths.tier)}  ${pad('DECIDED BY', widths.decided)}  THE TIER RESOLVES TO`,
);
for (const r of rows) {
  console.log(`  ${pad(r.agent, widths.agent)}  ${pad(r.tier, widths.tier)}  ${pad(r.decided, widths.decided)}  ${r.resolves}`);
}

const overridden = rows.filter((r) => r.decided.startsWith('project (was'));
console.log('');
if (overridden.length === 0) {
  console.log(
    `  Nothing is re-routed. To change one, add an "agents" block to\n` +
      `  .claude/spec-flow.config.json — for example { "agents": { "reviewer": "sonnet" } }.\n` +
      `  The value is a tier (${ALIASES.join(', ')}), never a model id.`,
  );
} else {
  console.log(`  ${overridden.length} agent(s) re-routed by this project. A hook applies it at spawn time;`);
  console.log(`  the orchestrator is not asked to, and cannot forget to.`);
}
console.log(
  `\n  To pin what a TIER means, that is Claude Code's own setting, not this engine's:\n` +
    `  an ANTHROPIC_DEFAULT_<TIER>_MODEL entry in .claude/settings.json's "env" block.\n` +
    `  A tier is per agent; a pin is per session.`,
);

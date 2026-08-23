#!/usr/bin/env node
/**
 * What each agent will actually run on in THIS repo, and who decided it.
 *
 *   spec-flow models
 *   node scripts/model-routing.mjs
 *
 * Four things answer that question and no file shows more than one of them:
 * the tier an agent's frontmatter ships, the project's override of that tier
 * in `.claude/spec-flow.config.json`, what the harness resolves the tier to —
 * which `ANTHROPIC_DEFAULT_*_MODEL` can pin — and the effort, which comes
 * either from the agent's frontmatter or from the session and from nowhere in
 * between (ADR-015). Reading any one of them and concluding is how you get a
 * confident wrong answer, so this reads all four and names the source of every
 * value it prints.
 *
 * **It refuses to guess the third layer.** Nothing here can know what Claude
 * Code currently resolves `opus` to; only an explicit pin is knowable, and
 * naming a likely model anyway — in the one report whose subject is which
 * model runs — would be the exact rot ADR-013 removed, reintroduced by the
 * file explaining it. Unpinned prints as unpinned. `model-pins.mjs` caught
 * this header doing it.
 *
 * Exits non-zero when the routing block is unusable, so this doubles as the
 * way to find that out without provoking a denied spawn. Same problems, same
 * wording, one reader — see `hooks/lib/routing.mjs`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ALIASES, shippedAgents, shippedRouting, projectRouting } from '../hooks/lib/routing.mjs';

const root = process.cwd();

/**
 * A tier's pin, if some settings layer names one, plus where it came from.
 *
 * Best-effort by construction: a real environment variable beats a settings
 * file, `settings.local.json` beats `settings.json`, and an organisation's
 * managed settings are not readable from here at all. Every value printed
 * carries its source so a reader can tell what this could and could not see.
 */
function settingsLayers() {
  const layers = [];
  for (const label of ['.claude/settings.json', '.claude/settings.local.json']) {
    const path = join(root, ...label.split('/'));
    if (!existsSync(path)) continue;
    try {
      layers.push([label, JSON.parse(readFileSync(path, 'utf8'))]);
    } catch {
      // A settings file this cannot parse is Claude Code's to complain about,
      // not this report's reason to fail.
    }
  }
  return layers; // lowest precedence first
}

function envPins() {
  const pins = {};

  for (const [label, settings] of settingsLayers()) {
    const env = settings.env;
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

/**
 * The session-wide effort this repo's settings ask for, if any.
 *
 * This is the ONLY effort lever a project has. An agent that declares no
 * effort of its own gets this; there is no per-agent override to report,
 * because a spawn discards the field (ADR-015).
 */
function sessionEffort() {
  let found = null;
  for (const [label, settings] of settingsLayers()) {
    if (typeof settings.effortLevel === 'string' && settings.effortLevel) {
      found = { value: settings.effortLevel, source: label };
    }
  }
  return found;
}

const meta = shippedAgents();
const shipped = shippedRouting(meta);
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
const session = sessionEffort();
const declaredLower = Object.fromEntries(Object.entries(declared).map(([k, v]) => [k.toLowerCase(), v]));

const rows = agents.map((agent) => {
  const fallback = shipped[agent];
  const tier = routing[agent] ?? fallback;

  let decided;
  if (!(agent.toLowerCase() in declaredLower)) {
    decided = 'plugin default';
  } else if (tier === fallback) {
    decided = 'project (restates the default)';
  } else {
    decided = `project (was ${fallback})`;
  }

  const pin = pins[tier];
  const resolves = pin ? `${pin.value} (${pin.source})` : 'unpinned';

  // An agent declares an effort or takes the session's. There is no third
  // source, and no project override to report — see this file's header.
  const own = meta[agent]?.effort;
  const effort = own ? `${own} (agent)` : session ? `${session.value} (session)` : 'your session';

  return { agent, tier, effort, decided, resolves };
});

// The HEADING is part of the column, not just the values: measuring only the
// values leaves any column whose title is the longest string in it misaligned,
// which in a table whose whole job is "which layer decided this" reads as a
// misattributed row.
const COLUMNS = [
  ['AGENT', 'agent'],
  ['TIER', 'tier'],
  ['EFFORT', 'effort'],
  ['TIER DECIDED BY', 'decided'],
  ['TIER PINNED TO', 'resolves'],
];
const widths = COLUMNS.map(([heading, key]) => Math.max(heading.length, ...rows.map((r) => String(r[key]).length)));
const line = (cells) => `  ${cells.map((c, i) => String(c).padEnd(widths[i])).join('  ')}`.trimEnd();

console.log(`spec-flow models — how each agent will be routed in ${root}\n`);
console.log(line(COLUMNS.map(([heading]) => heading)));
for (const r of rows) console.log(line(COLUMNS.map(([, key]) => r[key])));

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
  `\n  "unpinned" means Claude Code resolves that tier to whatever is current, which is\n` +
    `  the whole point of naming a tier. To pin one, that is Claude Code's own setting\n` +
    `  rather than this engine's: an ANTHROPIC_DEFAULT_<TIER>_MODEL entry in\n` +
    `  .claude/settings.json's "env" block. A tier is per agent; a pin is per session.\n\n` +
    `  EFFORT marked (agent) is declared in that agent's own frontmatter and this project\n` +
    `  cannot change it — a spawn discards an effort key, so there is no per-agent override\n` +
    `  to offer. The rest follow the session, which "effortLevel" in .claude/settings.json\n` +
    `  sets for all of them at once.`,
);

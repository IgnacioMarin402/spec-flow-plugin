#!/usr/bin/env node
/**
 * Which model tier an agent runs on: the plugin's default, and the consuming
 * project's override of it. See ADR-014.
 *
 * One copy, for the reason `agent-name.mjs` is one copy — `model-route.mjs`
 * applies the routing and `scripts/model-pins.mjs` holds the plugin's own
 * defaults to it, and two lists of what a valid tier is would drift into a
 * contract that one of them accepts and the other refuses.
 *
 * The DEFAULT is read from the shipped agent's frontmatter rather than
 * restated here. That file is what Claude Code obeys when nothing overrides
 * it, so any second copy would be a claim about the routing rather than the
 * routing itself.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The tiers a spawn may be routed to.
 *
 * **Measured, not read off the docs.** A `PreToolUse` hook rewriting a spawn's
 * `model` is validated against exactly these four: a full model id comes back
 * as a schema error on the tool call, so a contract accepting one would fail
 * at the spawn rather than at the config. Pinning a version is therefore
 * session-wide (`ANTHROPIC_DEFAULT_*_MODEL`) and not something this engine can
 * offer per agent — see ADR-014.
 */
export const ALIASES = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * The effort levels a subagent's frontmatter may declare.
 *
 * Here for the same one-home reason as `ALIASES`, and with a warning attached:
 * **nothing in this file applies it.** A spawn silently discards an `effort`
 * key — measured, with a positive control, in ADR-015 — so this list exists to
 * VALIDATE what the shipped frontmatter says and to REPORT it, never to route
 * it. Anything that starts sending effort through a hook is building on a
 * field the tool call throws away.
 */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** `<plugin>/agents`, from this file's own location — never the consuming repo's. */
function agentsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');
}

/**
 * What each shipped agent declares: `{ name: { model, effort } }`, with
 * `effort` undefined where the agent deliberately inherits the session's.
 * Empty when the directory cannot be read, which every caller has to treat as
 * "no opinion" rather than as "no agents".
 *
 * One parser, because the two questions asked of these files — what tier, what
 * effort — are one read of one frontmatter block, and two readers of it would
 * be two chances to disagree about which agents exist.
 */
export function shippedAgents() {
  const dir = agentsDir();
  const agents = {};
  if (!existsSync(dir)) return agents;

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    let text;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
    if (end === -1) continue;
    const head = text.slice(3, end);
    const name = /^name:[ \t]*(\S+)/m.exec(head)?.[1] ?? file.replace(/\.md$/, '');
    const model = /^model:[ \t]*(\S+)/m.exec(head)?.[1];
    if (!model) continue;
    agents[name.toLowerCase()] = { model, effort: /^effort:[ \t]*(\S+)/m.exec(head)?.[1] };
  }
  return agents;
}

/**
 * The routing this plugin ships: agent name -> tier. The shape the spawn hook
 * wants, derived rather than parsed a second time.
 */
export function shippedRouting(agents = shippedAgents()) {
  return Object.fromEntries(Object.entries(agents).map(([name, { model }]) => [name, model]));
}

/**
 * The project's overrides, plus everything wrong with them.
 *
 * Lives in `.claude/spec-flow.config.json` beside `max_opus_calls`, not in
 * `.spec-flow/config.json`: that file is the architectural contract — the
 * repo's linter, its test command, its layers — and a preference about what a
 * pass should cost is not one of those. It is also versioned, so putting a
 * cost knob there would move `contract_version` for every adopter.
 *
 * Problems are RETURNED rather than swallowed. A typo'd agent name is the
 * failure this engine exists to close in miniature: the config reads as though
 * it routes something, and routes nothing, forever.
 */
export function projectRouting(root, shipped = shippedRouting()) {
  const path = join(root, '.claude', 'spec-flow.config.json');
  const problems = [];
  if (!existsSync(path)) return { routing: {}, problems };

  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Not this hook's failure to report: `max_opus_calls` reads the same file
    // and already falls back to its default on malformed JSON. Routing does
    // the same rather than denying every spawn over a file another hook
    // tolerates.
    return { routing: {}, problems };
  }

  const declared = config.agents;
  if (declared === undefined) return { routing: {}, problems };
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    problems.push('"agents" is not an object mapping an agent name to a tier, so nothing in it can be applied.');
    return { routing: {}, problems };
  }

  const routing = {};
  const known = Object.keys(shipped);
  for (const [rawName, tier] of Object.entries(declared)) {
    const name = String(rawName).toLowerCase();

    if (known.length > 0 && !known.includes(name)) {
      problems.push(
        `"agents": { "${rawName}": ... } names no agent this plugin ships (${known.sort().join(', ')}). ` +
          `A name nothing matches routes nothing, and reads exactly like a routing that works.`,
      );
      continue;
    }

    if (typeof tier !== 'string' || !ALIASES.includes(tier)) {
      problems.push(
        `"agents": { "${rawName}": ${JSON.stringify(tier)} } is not one of ${ALIASES.join(', ')}. ` +
          `A spawn only accepts a tier — a full model id is refused by the tool call itself.`,
      );
      continue;
    }

    routing[name] = tier;
  }

  return { routing, problems };
}

/**
 * The tier `agent` will actually run on, and who decided it.
 *
 * `source` is `project` only when the override differs from the shipped
 * default: re-stating the default is not a re-route, and a caller that
 * rewrote the spawn for it would report a change nobody made.
 */
export function resolveModel(root, agent, shipped = shippedRouting()) {
  const name = String(agent ?? '').toLowerCase();
  const { routing, problems } = projectRouting(root, shipped);
  const fallback = shipped[name] ?? null;
  const override = routing[name] ?? null;

  if (override && override !== fallback) return { model: override, source: 'project', problems };
  return { model: fallback, source: 'default', problems };
}

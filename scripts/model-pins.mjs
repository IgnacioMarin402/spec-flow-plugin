#!/usr/bin/env node
/**
 * Every agent routes to a model TIER, and nothing this plugin ships names a
 * model VERSION. See ADR-012.
 *
 *   node scripts/model-pins.mjs
 *
 * Two assertions, and the order matters — the first is why this is not just a
 * ban list:
 *
 *   1. POSITIVE. Every `agents/*.md` declares a `model:`, its value is one of
 *      the aliases Claude Code resolves to the current model of that tier, and
 *      the tier is named in the agent's own `description`. Finding NO agents
 *      is a failure: a check that only forbids a token reports a directory it
 *      never reached exactly as it reports a clean one, which is the failure
 *      this engine exists to close.
 *   2. NEGATIVE. No shipped file names a version — neither a full id nor a
 *      numbered tier in prose. The frontmatter is what Claude Code obeys, but
 *      the prose is what the model reads, so half a fix here reads like a
 *      whole one.
 *
 * `decisions/` is not scanned, deliberately: a record claims a moment, and
 * ADR-012 has to name the dated id it removed in order to say what changed.
 * The same exemption `decisions/README.md` already grants every record.
 *
 * Excludes itself, the way `no-repo-refs.mjs` does — a checker necessarily
 * spells what it checks for.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// The valid tiers have one home, and it is the file that applies them at spawn
// time. A second list here would let this check bless a tier the routing hook
// then refuses — the contract accepted in one place and rejected in the other,
// which is the drift this import exists to refuse. Same shape as
// spec-flow-config.mjs importing its report formats from the reader.
import { ALIASES } from '../hooks/lib/routing.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/');

// Where routing is described. `hooks` and `scripts` are here even though they
// route nothing: a version reaches prose through whichever file nobody thought
// to scan, and a hook header explaining why a budget exists is a natural place
// to write one.
const SCAN_DIRS = ['agents', 'commands', 'hooks', 'scripts', 'skills', '.claude/skills'];
// `ci.yml` is here because this check's own steps are described in it, and a
// step comment is prose like any other.
const SCAN_FILES = ['README.md', 'REFERENCE.md', 'CLAUDE.md', 'BACKLOG.md', '.github/workflows/ci.yml'];
const SCAN_EXTENSIONS = ['.mjs', '.md', '.json'];

const VERSIONED = [
  // A full model id. Anchored on the vendor prefix so the bare alias, which is
  // the whole point of ADR-012, never matches.
  { pattern: /\bclaude-(opus|sonnet|haiku|fable)[\w.-]*/i, label: 'a pinned model id' },
  // A tier with a number after it: "Opus 5", "Haiku 4.5", "Sonnet-5". The
  // lookbehind keeps this off the tail of a full id, which the pattern above
  // already owns — without it every pin is reported twice under two labels,
  // and a reader has to work out that both name one thing.
  { pattern: /(?<!claude-)\b(opus|sonnet|haiku|fable)[ -]\d/i, label: 'a tier with a version number' },
];

function walk(dir, found = []) {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (SCAN_EXTENSIONS.some((ext) => entry.endsWith(ext))) found.push(full);
  }
  return found;
}

/** The frontmatter block, or null when the file has none. */
function frontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  return end === -1 ? null : text.slice(3, end);
}

const problems = [];

// ---- 1. every agent routes to a tier --------------------------------------
const agentsDir = join(ROOT, 'agents');
const agents = existsSync(agentsDir)
  ? readdirSync(agentsDir)
      .filter((f) => f.endsWith('.md'))
      .sort()
  : [];

if (agents.length === 0) {
  problems.push(
    'no agent files were found under agents/. That is a failure rather than a clean run: this check would ' +
      'otherwise report a directory it cannot see exactly as it reports one with nothing wrong in it.',
  );
}

const routing = [];
for (const file of agents) {
  const text = readFileSync(join(agentsDir, file), 'utf8');
  const head = frontmatter(text);
  if (head === null) {
    problems.push(`agents/${file} has no frontmatter block, so Claude Code registers no agent for it at all.`);
    continue;
  }

  const declared = /^model:[ \t]*(\S+)/m.exec(head)?.[1];
  if (!declared) {
    problems.push(
      `agents/${file} declares no \`model:\`. An omitted model means \`inherit\` — the agent silently runs on ` +
        `whatever the main session is using, so a cheap pass can run on the most expensive model and nothing says so.`,
    );
    continue;
  }

  if (!ALIASES.includes(declared)) {
    problems.push(
      `agents/${file} routes to \`${declared}\`, which is not one of the tier aliases (${ALIASES.join(', ')}). ` +
        `A pinned id freezes this agent on one model as the tiers move past it — see ADR-012.`,
    );
    continue;
  }

  // The claim ADR-012 makes about the prose, checked rather than asserted: an
  // agent re-routed in the frontmatter alone leaves a description that tells
  // the orchestrator the wrong cost. Naming ANOTHER agent's tier as well is
  // ordinary — the reviewer's description names the Opus planner it escalates
  // to — so what is required is presence, not exclusivity.
  const description = /^description:[ \t]*(.+)$/m.exec(head)?.[1] ?? '';
  if (!new RegExp(`\\b${declared}\\b`, 'i').test(description)) {
    problems.push(
      `agents/${file} routes to \`${declared}\` and its \`description\` never says so. The description is what ` +
        `the orchestrator reads to know what a spawn costs, so a frontmatter re-route that stops there is invisible ` +
        `at exactly the moment the routing is chosen.`,
    );
    continue;
  }

  routing.push(`${file.replace(/\.md$/, '')} -> ${declared}`);
}

// ---- 2. nothing names a version -------------------------------------------
const files = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)))
  .concat(SCAN_FILES.map((f) => join(ROOT, f)).filter((f) => existsSync(f)))
  .filter((f) => relative(ROOT, f).replace(/\\/g, '/') !== SELF);

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const { pattern, label } of VERSIONED) {
        if (pattern.test(line)) problems.push(`${rel}:${i + 1}  ${label}\n    ${line.trim()}`);
      }
    });
}

// ---- report ---------------------------------------------------------------
if (problems.length > 0) {
  console.error(`model-pins: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(
    '\nAn agent names the tier its job needs and lets the harness resolve the current model of that tier. ' +
      'A version belongs in decisions/, where a record claims a moment. See ADR-012.',
  );
  process.exit(1);
}

console.log(`model-pins: OK — ${files.length} file(s) name no version; ${routing.length} agent(s) route by tier.`);
for (const line of routing) console.log(`  ${line}`);

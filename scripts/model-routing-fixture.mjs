#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/model-routing.mjs.
 *
 *   node scripts/model-routing-fixture.mjs
 *
 * The report's failure mode is not crashing, it is being CONFIDENTLY WRONG: a
 * run that never found the project's config prints five tidy rows saying
 * "plugin default" and looks exactly like a repo that configured nothing. So
 * the cases here are about attribution — that a re-route is reported as one,
 * that restating the default is not, and that each layer is credited to the
 * file it came from.
 *
 * One case exists purely to stop the report re-introducing what ADR-012
 * removed: with nothing pinned, the output must name NO model. Guessing which
 * model a tier resolves to would be the version rot returning inside the
 * report about version rot.
 *
 * Every model id here is assembled at runtime. `scripts/` is scanned by
 * `model-pins.mjs`, so a spelled-out one fails the real run against this repo.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT = join(HERE, 'model-routing.mjs');
const failures = [];

// Assembled, never spelled — see the header.
const VENDOR = ['claude', ''].join('-');
const PINNED_SONNET = [VENDOR + 'sonnet', '4', '9'].join('-');
const PINNED_OPUS = [VENDOR + 'opus', '4', '8'].join('-');

/**
 * Runs the real report against a throwaway repo holding exactly `files`.
 * `cwd` is how the script finds the project, and its own location is how it
 * finds the plugin — so this reads the agents this repo actually ships.
 */
function report(files, env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spec-flow-routing-'));
  try {
    mkdirSync(join(root, '.claude'), { recursive: true });
    for (const [rel, contents] of Object.entries(files)) {
      writeFileSync(join(root, rel), typeof contents === 'string' ? contents : JSON.stringify(contents));
    }
    // The ambient environment must not leak in: a developer with one of these
    // exported would otherwise see different results than CI.
    const clean = { ...process.env };
    for (const key of Object.keys(clean)) {
      if (/^ANTHROPIC_DEFAULT_.*_MODEL$/.test(key)) delete clean[key];
    }
    const res = spawnSync(process.execPath, [REPORT], { cwd: root, encoding: 'utf8', env: { ...clean, ...env } });
    return { code: res.status, out: `${res.stdout}${res.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The row for one agent, whitespace collapsed. */
function row(out, agent) {
  const line = out.split('\n').find((l) => new RegExp(`^\\s+${agent}\\s`).test(l));
  return line ? line.trim().replace(/\s+/g, ' ') : null;
}

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

check('a repo that configured nothing gets every agent, all on the shipped default', () => {
  const { code, out } = report({});
  if (code !== 0) return `exit ${code}\n--- output ---\n${out}`;
  for (const agent of ['architect', 'implementer', 'planner', 'reviewer', 'spec-writer']) {
    const r = row(out, agent);
    if (!r) return `${agent} is missing from the report entirely.\n--- output ---\n${out}`;
    if (!r.includes('plugin default')) return `${agent} was not attributed to the plugin: ${r}`;
  }
  return out.includes('Nothing is re-routed') ? '' : `did not say the project re-routes nothing.\n--- output ---\n${out}`;
});

check('with nothing pinned, no agent row names a model', () => {
  const { out } = report({});
  // Rows only, not the whole output: the header prints the repo's path, and a
  // temp directory that happened to contain the vendor prefix would fail this
  // for a reason that has nothing to do with the report.
  const named = ['architect', 'implementer', 'planner', 'reviewer', 'spec-writer']
    .map((a) => row(out, a))
    .filter((r) => r?.includes(VENDOR));
  // The rot ADR-012 removed, re-entering through the report about it.
  return named.length === 0
    ? ''
    : `named a concrete model for a tier nothing pinned. It cannot know which one that is, and inventing it is exactly what ADR-012 took out of the agents:\n    ${named.join('\n    ')}`;
});

check('a re-route is attributed to the project, and says what it replaced', () => {
  const { code, out } = report({ '.claude/spec-flow.config.json': { agents: { reviewer: 'opus' } } });
  if (code !== 0) return `exit ${code}\n--- output ---\n${out}`;
  const r = row(out, 'reviewer');
  if (!r.includes('opus')) return `the reviewer's tier was not the re-routed one: ${r}`;
  if (!r.includes('project')) return `a re-route was reported as though the plugin chose it: ${r}`;
  if (!r.includes('haiku')) {
    return `the report does not say what the re-route replaced, which is the one thing a reader cannot get from the config file: ${r}`;
  }
  return out.includes('1 agent(s) re-routed') ? '' : `the summary line did not count the re-route.\n--- output ---\n${out}`;
});

check('restating the shipped default is not reported as a re-route', () => {
  const { code, out } = report({ '.claude/spec-flow.config.json': { agents: { planner: 'opus' } } });
  if (code !== 0) return `exit ${code}\n--- output ---\n${out}`;
  const r = row(out, 'planner');
  if (!r.includes('restates the default')) return `an entry that changes nothing was reported as a change: ${r}`;
  return out.includes('Nothing is re-routed') ? '' : `counted a re-route nobody made.\n--- output ---\n${out}`;
});

check('a routing block that cannot be applied exits non-zero and names the entry', () => {
  const { code, out } = report({ '.claude/spec-flow.config.json': { agents: { reviwer: 'sonnet' } } });
  if (code === 0) {
    return `a repo whose every spec-flow spawn is being denied got a clean report.\n--- output ---\n${out}`;
  }
  return out.includes('reviwer') ? '' : `failed without naming the entry that is wrong.\n--- output ---\n${out}`;
});

check('a tier pinned in settings.json is credited to that file', () => {
  const { code, out } = report({
    '.claude/settings.json': { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: PINNED_SONNET } },
  });
  if (code !== 0) return `exit ${code}\n--- output ---\n${out}`;
  const r = row(out, 'implementer');
  if (!r.includes(PINNED_SONNET)) return `the pin was not reported: ${r}`;
  if (!r.includes('settings.json')) return `the pin was reported without saying where it came from: ${r}`;
  const untouched = row(out, 'architect');
  return untouched.includes('unpinned') ? '' : `a pin on one tier was applied to another: ${untouched}`;
});

check('settings.local.json wins over settings.json', () => {
  const { out } = report({
    '.claude/settings.json': { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: PINNED_SONNET } },
    '.claude/settings.local.json': { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: PINNED_OPUS } },
  });
  const r = row(out, 'planner');
  if (!r.includes(PINNED_OPUS)) return `the local file did not win: ${r}`;
  return r.includes('settings.local.json') ? '' : `won, but was credited to the wrong file: ${r}`;
});

check('a real environment variable wins over both files', () => {
  const { out } = report(
    { '.claude/settings.json': { env: { ANTHROPIC_DEFAULT_OPUS_MODEL: PINNED_SONNET } } },
    { ANTHROPIC_DEFAULT_OPUS_MODEL: PINNED_OPUS },
  );
  const r = row(out, 'planner');
  if (!r.includes(PINNED_OPUS)) return `the shell did not win, which is Claude Code's own precedence for this variable: ${r}`;
  return r.includes('the environment') ? '' : `won, but was credited to a file: ${r}`;
});

// ---- effort: the one layer with no project override to report -------------

check('an agent that declares its own effort is reported as the one deciding it', () => {
  const { code, out } = report({});
  if (code !== 0) return `exit ${code}\n--- output ---\n${out}`;
  // `reviewer` declares `effort: low` in the frontmatter this repo ships.
  const r = row(out, 'reviewer');
  if (!/low \(agent\)/.test(r)) {
    return `the reviewer's declared effort was not reported as the agent's own: ${r}`;
  }
  const inheriting = row(out, 'implementer');
  return /your session/.test(inheriting) ? '' : `an agent that deliberately inherits did not say so: ${inheriting}`;
});

check("a session effortLevel is reported for the agents that inherit, and not for the ones that do not", () => {
  const { code, out } = report({ '.claude/settings.json': { effortLevel: 'xhigh' } });
  if (code !== 0) return `exit ${code}\n--- output ---\n${out}`;
  const inheriting = row(out, 'implementer');
  if (!/xhigh \(session\)/.test(inheriting)) return `the session's level was not reported: ${inheriting}`;
  const declared = row(out, 'reviewer');
  return /low \(agent\)/.test(declared)
    ? ''
    : `a session-wide level overwrote an agent that declares its own, which is not what the frontmatter does: ${declared}`;
});

check('every column stays aligned when a heading is longer than its values', () => {
  const { out } = report({});
  const lines = out.split('\n');
  const header = lines.find((l) => l.includes('AGENT') && l.includes('EFFORT'));
  const first = lines[lines.indexOf(header) + 1];
  const at = (l, h) => l.indexOf(h);
  // The value under each heading must start where the heading starts.
  for (const [heading, value] of [
    ['TIER DECIDED BY', 'plugin default'],
    ['EFFORT', 'high'],
  ]) {
    if (at(header, heading) !== at(first, value)) {
      return `"${value}" does not start under "${heading}". In a table about which layer decided what, a shifted column reads as a misattributed row.\n${header}\n${first}`;
    }
  }
  return '';
});

check('a settings file that is not valid JSON does not take the report down', () => {
  const { code, out } = report({ '.claude/settings.json': '{ not json' });
  if (code !== 0) return `exit ${code} — an unparseable settings file is Claude Code's to complain about, not this report's.\n--- output ---\n${out}`;
  return row(out, 'planner') ? '' : `the report came back empty.\n--- output ---\n${out}`;
});

if (failures.length > 0) {
  console.error(`model-routing-fixture: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('model-routing-fixture: OK — every layer is reported, credited to its source, and no tier is guessed.');

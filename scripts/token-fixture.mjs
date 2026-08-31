#!/usr/bin/env node
/**
 * The token accounting, against the transcript shapes it will actually meet.
 *
 * `token-trace.mjs` reads a file this engine does not write — Claude Code's
 * session transcript — so every field it depends on is an OBSERVATION about
 * another program, and the whole risk sits there. These cases pin the shape
 * that was read off a real transcript: `message.usage`, `message.model` and a
 * top-level `isSidechain`. When a future build moves one, this is what says
 * so, rather than a silent zero in a report someone is about to act on.
 *
 * **This is a guard on new behaviour, not proof of a defect.** Every case
 * here passes on the commit that introduced it; nothing regressed to catch.
 * Said out loud because the two are worth the same only until someone reads
 * a green suite as evidence that something was broken and is now fixed.
 *
 *   node scripts/token-fixture.mjs [engine-root]
 */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ENGINE = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const temps = [];

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

/** A repo with a phase, or without one — the two states the hook branches on. */
function makeRepo(phase = 'implement') {
  const repo = mkdtempSync(join(tmpdir(), 'token-repo-'));
  temps.push(repo);
  if (phase !== null) {
    mkdirSync(join(repo, '.claude', 'state'), { recursive: true });
    writeFileSync(join(repo, '.claude/state/phase'), `${phase}\n`);
  }
  return repo;
}

/**
 * One assistant entry, in the shape read off a real Claude Code transcript.
 *
 * The keys are the observation this fixture exists to pin. `usage` carries
 * `output_tokens_details.thinking_tokens` nested, which is the one field a
 * flat reader would drop without noticing.
 *
 * The model NAMES are deliberately not real ones, and not only because ADR-013
 * keeps version ids out of this repo: the hook treats the value as opaque, and
 * an id nobody could special-case is what proves it.
 */
const entry = ({ model = 'model-alpha', sidechain = false, out = 100, input = 10, cacheRead = 0, cacheWrite = 0, think = 0 } = {}) =>
  `${JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    timestamp: '2026-08-31T00:00:00.000Z',
    message: {
      role: 'assistant',
      model,
      usage: {
        input_tokens: input,
        output_tokens: out,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        output_tokens_details: { thinking_tokens: think },
      },
    },
  })}\n`;

function transcript(repo, lines) {
  const path = join(repo, 'transcript.jsonl');
  writeFileSync(path, lines.join(''));
  return path;
}

/** One Stop. Returns the trace lines the hook has written so far. */
function stop(repo, transcriptPath, extra = {}) {
  const res = spawnSync('node', [join(ENGINE, 'hooks', 'token-trace.mjs')], {
    input: JSON.stringify({ session_id: 'sess-1', hook_event_name: 'Stop', ...(transcriptPath ? { transcript_path: transcriptPath } : {}), ...extra }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    cwd: tmpdir(),
  });
  const log = join(repo, '.claude/state/run-trace.log');
  return {
    code: res.status,
    stderr: res.stderr,
    lines: existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [],
  };
}

const field = (line, key) => new RegExp(`(?:^| )${key}=(\\S+)`).exec(line)?.[1];

// ---- the shape it reads ----------------------------------------------------

check('a transcript with usage produces one line per model, carrying every counter', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100, input: 10, cacheRead: 5000, cacheWrite: 700, think: 40 })]);
  const { code, lines } = stop(repo, t);
  if (code !== 0) return `the hook exited ${code}; an observer must always exit 0`;
  if (lines.length !== 1) return `expected one line, got ${lines.length}:\n${lines.join('\n')}`;
  const got = Object.fromEntries(['model', 'sidechain', 'in', 'out', 'cache_read', 'cache_write', 'think', 'msgs'].map((k) => [k, field(lines[0], k)]));
  const want = { model: 'model-alpha', sidechain: 'false', in: '10', out: '100', cache_read: '5000', cache_write: '700', think: '40', msgs: '1' };
  const wrong = Object.entries(want).filter(([k, v]) => got[k] !== v);
  return wrong.length === 0 ? '' : `wrong field(s) ${wrong.map(([k, v]) => `${k}: want ${v}, got ${got[k]}`).join('; ')}\n--- line ---\n${lines[0]}`;
});

check('a subagent and its spawner are counted apart, not merged into one total', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100 }), entry({ out: 30, sidechain: true }), entry({ out: 70, sidechain: true })]);
  const { lines } = stop(repo, t);
  const main = lines.find((l) => field(l, 'sidechain') === 'false');
  const sub = lines.find((l) => field(l, 'sidechain') === 'true');
  if (!main || !sub) return `expected a main line and a subagent line, got:\n${lines.join('\n')}`;
  if (field(main, 'out') !== '100') return `the main line summed to ${field(main, 'out')}, want 100`;
  return field(sub, 'out') === '100' && field(sub, 'msgs') === '2' ? '' : `the subagent line reported out=${field(sub, 'out')} msgs=${field(sub, 'msgs')}, want 100 and 2`;
});

check('two models in one turn are two lines — a whitespace-split log cannot hold a repeated key', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ model: 'model-alpha' }), entry({ model: 'model-beta' })]);
  const { lines } = stop(repo, t);
  const models = new Set(lines.map((l) => field(l, 'model')));
  return models.size === 2 && lines.length === 2 ? '' : `expected two lines naming two models, got ${lines.length}:\n${lines.join('\n')}`;
});

// ---- the offset ------------------------------------------------------------

check('a second stop over an unchanged transcript writes nothing', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry()]);
  stop(repo, t);
  const { lines } = stop(repo, t);
  return lines.length === 1 ? '' : `the same bytes were counted again — ${lines.length} line(s):\n${lines.join('\n')}`;
});

check('a later stop counts only what was appended since the last one', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100 })]);
  stop(repo, t);
  appendFileSync(t, entry({ out: 7 }));
  const { lines } = stop(repo, t);
  if (lines.length !== 2) return `expected a second line, got ${lines.length}:\n${lines.join('\n')}`;
  return field(lines[1], 'out') === '7' ? '' : `the delta reported out=${field(lines[1], 'out')}, want 7 — a re-read of the whole file reports 107`;
});

check('a transcript replaced by a shorter one is read from the start, not from a stale offset', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100 }), entry({ out: 100 }), entry({ out: 100 })]);
  stop(repo, t);
  writeFileSync(t, entry({ out: 42 })); // a new session at the same path
  const { lines } = stop(repo, t);
  if (lines.length !== 2) return `expected the shorter file to be read, got ${lines.length} line(s):\n${lines.join('\n')}`;
  return field(lines[1], 'out') === '42' ? '' : `reported out=${field(lines[1], 'out')}, want 42`;
});

check('a half-written last line is not consumed, and is counted once it completes', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100 })]);
  const partial = entry({ out: 55 });
  appendFileSync(t, partial.slice(0, 30)); // the writer is mid-append
  const first = stop(repo, t);
  if (first.lines.length !== 1) return `the partial line was read as data — ${first.lines.length} line(s):\n${first.lines.join('\n')}`;
  appendFileSync(t, partial.slice(30));
  const second = stop(repo, t);
  if (second.lines.length !== 2) return `the completed line was skipped for good — ${second.lines.length} line(s):\n${second.lines.join('\n')}`;
  return field(second.lines[1], 'out') === '55' ? '' : `reported out=${field(second.lines[1], 'out')}, want 55`;
});

// ---- what it refuses to guess ----------------------------------------------

check('a usage record with no model is dropped rather than absorbed into a total', () => {
  const repo = makeRepo();
  const t = transcript(repo, [
    entry({ out: 100 }),
    `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', usage: { output_tokens: 999 } } })}\n`,
  ]);
  const { lines } = stop(repo, t);
  if (lines.length !== 1) return `expected one line, got ${lines.length}:\n${lines.join('\n')}`;
  return field(lines[0], 'out') === '100' ? '' : `the unattributable 999 landed in a total: out=${field(lines[0], 'out')}`;
});

check('an unreadable line does not stop the readable ones', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100 }), 'not json at all\n', entry({ out: 5 })]);
  const { code, lines } = stop(repo, t);
  if (code !== 0) return `the hook exited ${code} on a line it could not parse`;
  return lines.length === 1 && field(lines[0], 'out') === '105' ? '' : `expected out=105 on one line, got:\n${lines.join('\n')}`;
});

check('a payload with no transcript path records nothing — a missing count is never a zero', () => {
  const repo = makeRepo();
  const { code, lines } = stop(repo, null);
  if (code !== 0) return `the hook exited ${code}`;
  return lines.length === 0 ? '' : `wrote a line with no transcript to read it from:\n${lines.join('\n')}`;
});

check('a transcript path that does not exist records nothing and does not throw', () => {
  const repo = makeRepo();
  const { code, lines, stderr } = stop(repo, join(repo, 'gone.jsonl'));
  if (code !== 0) return `the hook exited ${code}: ${stderr}`;
  return lines.length === 0 ? '' : `wrote a line from a file it could not open:\n${lines.join('\n')}`;
});

check('a corrupt offset counts nothing rather than counting a prefix twice', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100 })]);
  stop(repo, t);
  writeFileSync(join(repo, '.claude/state/token-offset'), 'not json\n');
  appendFileSync(t, entry({ out: 5 }));
  const { lines } = stop(repo, t);
  if (lines.length !== 1) return `a second line appeared, so the first 100 was counted again:\n${lines.join('\n')}`;
  const missed = readFileSync(join(repo, '.claude/state/token-trace-unmatched.log'), 'utf8');
  return missed.includes('offset_unreadable') ? '' : `the skipped slice left no record:\n${missed}`;
});

check('a resynchronised offset picks the next slice up cleanly', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 100 })]);
  stop(repo, t);
  writeFileSync(join(repo, '.claude/state/token-offset'), 'not json\n');
  appendFileSync(t, entry({ out: 5 }));
  stop(repo, t); // the slice that is lost
  appendFileSync(t, entry({ out: 9 }));
  const { lines } = stop(repo, t);
  if (lines.length !== 2) return `expected the run to resume counting, got ${lines.length} line(s):\n${lines.join('\n')}`;
  return field(lines[1], 'out') === '9' ? '' : `reported out=${field(lines[1], 'out')}, want 9`;
});

check('a payload with no transcript path records its SHAPE, so a moved field is visible', () => {
  const repo = makeRepo();
  stop(repo, null);
  const path = join(repo, '.claude/state/token-trace-unmatched.log');
  if (!existsSync(path)) return 'the hook went quiet and left no record — the failure it is least able to survive';
  const missed = readFileSync(path, 'utf8');
  return missed.includes('no_transcript_path') && missed.includes('session_id') ? '' : `the record names no payload keys:\n${missed}`;
});

check('an unreadable transcript records its shape too', () => {
  const repo = makeRepo();
  stop(repo, join(repo, 'gone.jsonl'));
  const path = join(repo, '.claude/state/token-trace-unmatched.log');
  if (!existsSync(path)) return 'no record of a transcript that could not be opened';
  return readFileSync(path, 'utf8').includes('transcript_unreadable') ? '' : 'the record does not name the cause';
});

check('the miss log is deduped — one moved field is one line, not one per stop', () => {
  const repo = makeRepo();
  stop(repo, null);
  stop(repo, null);
  stop(repo, null);
  const missed = readFileSync(join(repo, '.claude/state/token-trace-unmatched.log'), 'utf8').split('\n').filter(Boolean);
  return missed.length === 1 ? '' : `${missed.length} lines for one repeated cause:\n${missed.join('\n')}`;
});

// ---- where it must not fire ------------------------------------------------

for (const phase of ['', 'idle', 'done']) {
  check(`phase "${phase || '(empty)'}" records nothing — the same phases run-trace.mjs stands down on`, () => {
    const repo = makeRepo(phase);
    const t = transcript(repo, [entry()]);
    const { lines } = stop(repo, t);
    return lines.length === 0 ? '' : `fired on a phase that arms nothing:\n${lines.join('\n')}`;
  });
}

check('a repo that never adopted this engine gets no .claude/ directory', () => {
  const repo = makeRepo(null);
  const t = transcript(repo, [entry()]);
  const { code } = stop(repo, t);
  if (code !== 0) return `the hook exited ${code}`;
  return existsSync(join(repo, '.claude')) ? 'created .claude/ in a repo with no phase file' : '';
});

// ---- the readers agree -----------------------------------------------------

check('status and stats report the same totals off one log', () => {
  const repo = makeRepo();
  const t = transcript(repo, [entry({ out: 1234, sidechain: true }), entry({ out: 4321 })]);
  stop(repo, t);
  const run = (script) =>
    spawnSync('node', [join(ENGINE, 'scripts', script)], { encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: repo }, cwd: tmpdir() }).stdout ?? '';
  const rows = (out) => (out.match(/model-\S+\s+(?:main|subagent)\s+in \S+\s+out \S+/g) ?? []).sort();
  const fromStatus = rows(run('status.mjs'));
  const fromStats = rows(run('specflow-stats.mjs'));
  if (fromStatus.length === 0) return `status reported no token rows at all:\n${run('status.mjs')}`;
  return JSON.stringify(fromStatus) === JSON.stringify(fromStats)
    ? ''
    : `the two readers disagree about one log.\n  status: ${JSON.stringify(fromStatus)}\n  stats:  ${JSON.stringify(fromStats)}`;
});

// ---- report ----------------------------------------------------------------
for (const dir of temps) rmSync(dir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`tokens: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log('tokens: OK — the accounting holds under every transcript shape it is pinned to.');

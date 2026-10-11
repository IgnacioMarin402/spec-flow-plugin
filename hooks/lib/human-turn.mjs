#!/usr/bin/env node
/**
 * Whether a human has answered since a case 3 brief was written (ADR-036).
 *
 * A case 3 rewrites a requirement to agree with the code, and from the diff
 * that reads exactly like rewriting it to agree with the bug, so `/spec-fix`
 * stops for a person first. Nothing on disk said the stop happened: the
 * `(correction)` marker is the triage's, written before anyone is asked.
 * `hooks/human-turn.mjs` records in human-turn.log when the session's turn
 * ends and when a prompt arrives — never what it says — and this reads it.
 *
 * One copy, because phase-guard holds the write that leaves `spec` and
 * arm-gate the engagement of the implementer, and a re-triage inside
 * `implement` reaches only the second.
 */
import { readdirSync, readFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './io.mjs';
import { changedDeltas } from '../../scripts/spec-shape.mjs';

export const LOG = 'human-turn.log';

/** What counts as a person answering: a typed prompt, or an answered question. */
const ANSWERS = ['human', 'question'];

/** The log's events, oldest first: `{ at, kind }`, kind `turn-end` or a prompt's `from`. */
function events(root) {
  const file = join(root, '.claude', 'state', LOG);
  if (!existsSync(file)) return [];
  return [...readFileSync(file, 'utf8').matchAll(/^(\S+Z) (turn-end|prompt from=(\S+))\s*$/gm)].map((m) => ({
    at: Date.parse(m[1]),
    kind: m[3] ?? m[2],
  }));
}

/**
 * Whether a person answered after `since`. A typed prompt counts only after a
 * turn end that also follows it: a background agent's report-back fires the
 * same hook as a person does, and the payload does not say which, so what
 * proves the session stopped to wait is the turn having ended first. A
 * question's answer arrives inside the turn, by nature.
 */
function answeredSince(log, since) {
  const ended = log.find((e) => e.kind === 'turn-end' && e.at > since);
  return log.some((e) => (e.kind === 'question' && e.at > since) || (e.kind === 'human' && ended && e.at > ended.at));
}

/**
 * The live fix briefs that correct a requirement and that no human has
 * answered since their last write, as `{ slug, ids }`.
 *
 * Stands down — returns nothing, and says so in human-turn-unmatched.log —
 * while the log holds no answer at all: a build that never fires the hook
 * would otherwise hold every case 3 forever.
 */
export function unconfirmedCorrections(root) {
  const dir = join(root, 'specflow');
  if (!existsSync(dir)) return [];
  const briefs = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === 'archive') continue;
    const spec = join(dir, e.name, 'spec.md');
    if (!existsSync(spec)) continue;
    const body = readFileSync(spec, 'utf8');
    if (!/^## Case\b/m.test(body)) continue;
    const ids = [...changedDeltas(body)].filter((d) => d.kind === 'correction').map((d) => d.id);
    if (ids.length > 0) briefs.push({ slug: e.name, ids, writtenAt: statSync(spec).mtimeMs });
  }
  if (briefs.length === 0) return [];

  const log = events(root);
  if (!log.some((e) => ANSWERS.includes(e.kind))) {
    try {
      appendFileSync(join(stateDir(root), 'human-turn-unmatched.log'), `${new Date().toISOString()} case-3 check stood down: no answer recorded — ${briefs.map((b) => b.slug).join(', ')}\n`);
    } catch {
      /* the log is how this blind spot is seen, never a reason to fail */
    }
    return [];
  }
  return briefs.filter((b) => !answeredSince(log, b.writtenAt)).map(({ slug, ids }) => ({ slug, ids }));
}

/**
 * The denial both hooks give, naming the briefs and the step the command
 * describes. It never names the record: what is wanted is the human's answer.
 */
export function correctionDenial(found, doing) {
  const what = found.map((f) => `specflow/${f.slug}/spec.md corrects ${f.ids.join(', ')}`).join('; ');
  return (
    `${doing} while ${what} — a case 3 — and no human has answered since that brief was last written. ` +
    `Rewriting a requirement to agree with the code reads, in a diff, exactly like rewriting it to agree with the bug, so a person confirms it first. ` +
    `Show the human each requirement id, its current body, the corrected body and the triage's evidence, then end your turn and wait for their answer. ` +
    `If they say the requirement was right after all, send the defect back to a new triage (ADR-036).`
  );
}

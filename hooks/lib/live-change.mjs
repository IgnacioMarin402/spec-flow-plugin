/**
 * What is live under `specflow/`, and which flow a change belongs to.
 *
 * One spelling for a fact three readers need: `phase-guard` refuses to end a
 * run over a live change, the gate names the re-plan route the live flow has,
 * `resume` and `spec-trace` tell a `/spec-fix` brief from a `/spec-flow`
 * change. A second copy of either test is a drift that stays green until the
 * two disagree about one file.
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Change folders under `specflow/` that were never stamped and archived. */
export function liveChanges(root) {
  const dir = join(root, 'specflow');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((e) => e !== 'archive' && statSync(join(dir, e)).isDirectory());
}

/**
 * A `/spec-fix` brief declares itself in its heading (`# Fix — <slug>`); a
 * `/spec-flow` change opens `# Spec — <slug>`. The heading, not the `## Case`
 * section it also carries: the heading is the file saying which flow wrote it.
 */
export function isFixBrief(specText) {
  return /^#\s*Fix\b/m.test(String(specText ?? ''));
}

/**
 * Whether the change a gate is judging is a `/spec-fix` brief.
 *
 * The position file names the change — `register-agent` writes it at every
 * implementer spawn, and a gate only judges after one. Without it, a single
 * live folder is the change. Anything else cannot be told, and the caller
 * keeps the `/spec-flow` wording: the gate must not throw over a question the
 * orchestrator's command can still answer.
 */
export function liveFixBrief(root, state) {
  try {
    const position = join(state, 'current-milestone');
    const at = existsSync(position) ? readFileSync(position, 'utf8').trim().split(/\s+/)[0] : '';
    const slugs = at ? [at] : liveChanges(root);
    if (slugs.length !== 1) return false;
    // The fold's own gate judges a change already moved to the archive.
    for (const dir of ['specflow', join('specflow', 'archive')]) {
      const spec = join(root, dir, slugs[0], 'spec.md');
      if (existsSync(spec)) return isFixBrief(readFileSync(spec, 'utf8'));
    }
  } catch {
    /* a fact the gate cannot read is not a reason to stop judging */
  }
  return false;
}

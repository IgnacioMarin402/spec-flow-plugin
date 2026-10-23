/**
 * A live change spec's problems at spec time, read off disk: what spec-trace
 * checks of it at the gate, plus what only its writing is held to — its
 * assumptions, which only sign-off reads (ADR-030), the shape of its deltas and
 * its name. phase-guard denies leaving `spec` on them; resume names them before
 * it asks for a sign-off.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { archiveClash, assumptionsProblem, deltasSectionProblem, explainUnread, liveSpecProblems, unreadDeltas } from './spec-shape.mjs';

/** The change folders under `specflow/archive/`. */
export function archivedSlugsIn(root) {
  const archive = join(root, 'specflow', 'archive');
  return existsSync(archive)
    ? readdirSync(archive, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];
}

/**
 * One message per problem across `slugs`, each naming its spec.
 *
 * The deltas' shape is held here, not at every gate: a run signed off before
 * a spelling was refused must not fail its milestones over it, and its fold is
 * held to it as every SHIPPED change of the branch is (ADR-048). The name
 * (`clash`) only while nothing names the folder yet: mid-run current-milestone,
 * resume and the snapshot do, and a rename would strand them.
 */
export function specTimeProblems(root, slugs, { clash = true } = {}) {
  const archive = join(root, 'specflow', 'archive');
  const archivedSlugs = archivedSlugsIn(root);
  const archivedBodies = archivedSlugs
    .map((slug) => join(archive, slug, 'spec.md'))
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'));
  const found = [];
  for (const slug of slugs) {
    const specPath = join(root, 'specflow', slug, 'spec.md');
    if (!existsSync(specPath)) continue; // a folder mid-write is not a failure
    const body = readFileSync(specPath, 'utf8');
    const taken = clash && archiveClash(slug, archivedSlugs);
    if (taken) found.push(taken);
    const assumptions = assumptionsProblem(body);
    if (assumptions) found.push(`specflow/${slug}/spec.md ${assumptions}.`);
    const section = deltasSectionProblem(body, { needed: true });
    if (section) found.push(`specflow/${slug}/spec.md ${section}`);
    for (const unread of unreadDeltas(body)) found.push(`specflow/${slug}/spec.md: ${explainUnread(unread)}`);
    found.push(...liveSpecProblems(slug, body, { hasProposal: existsSync(join(root, 'specflow', slug, 'proposal.md')), archivedBodies }));
  }
  return found;
}

/**
 * What leaving `spec` is held to (ADR-030): every live change with no plan
 * yet — one with a plan left `spec` already — and every fix brief, whose
 * triage writes its plan inside `spec` (ADR-033). One copy, because
 * phase-guard judges the phase write that leaves and arm-gate the implementer
 * spawn that would leave without one, and the two must not disagree.
 */
export function leavingSpecProblems(root) {
  const dir = join(root, 'specflow');
  if (!existsSync(dir)) return [];
  const isFixBrief = (slug) => existsSync(join(dir, slug, 'spec.md')) && /^## Case\b/m.test(readFileSync(join(dir, slug, 'spec.md'), 'utf8'));
  const unplanned = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'archive')
    .map((e) => e.name)
    .filter((slug) => !existsSync(join(dir, slug, 'plan.md')) || isFixBrief(slug));
  return specTimeProblems(root, unplanned);
}

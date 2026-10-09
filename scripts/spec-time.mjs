/**
 * A live change spec's problems at spec time, read off disk: what spec-trace
 * checks of it at the gate, plus its assumptions, which only sign-off reads
 * (ADR-030). phase-guard denies leaving `spec` on them; resume names them
 * before it asks for a sign-off.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { assumptionsProblem, liveSpecProblems } from './spec-shape.mjs';

/** One message per problem across `slugs`, each naming its spec. */
export function specTimeProblems(root, slugs) {
  const archive = join(root, 'specflow', 'archive');
  const archivedBodies = existsSync(archive)
    ? readdirSync(archive)
        .map((slug) => join(archive, slug, 'spec.md'))
        .filter((path) => existsSync(path))
        .map((path) => readFileSync(path, 'utf8'))
    : [];
  const found = [];
  for (const slug of slugs) {
    const specPath = join(root, 'specflow', slug, 'spec.md');
    if (!existsSync(specPath)) continue; // a folder mid-write is not a failure
    const body = readFileSync(specPath, 'utf8');
    const assumptions = assumptionsProblem(body);
    if (assumptions) found.push(`specflow/${slug}/spec.md ${assumptions}.`);
    found.push(...liveSpecProblems(slug, body, { hasProposal: existsSync(join(root, 'specflow', slug, 'proposal.md')), archivedBodies }));
  }
  return found;
}

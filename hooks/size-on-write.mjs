#!/usr/bin/env node
/**
 * PostToolUse hook on Write|Edit — a change artefact over its budget is
 * refused the moment it is written.
 *
 * `specflow/<SLUG>/spec.md`, `proposal.md`, `plan.md` and `milestones/Mk.md`
 * are read downstream by agents on a fresh context, and nothing bounded them:
 * a real planner wrote a plan of 50k characters and a milestone of 11.9k
 * field lists (ADR-026). The budget is `trace.budgets` in the contract, in
 * characters per artefact, and this is the cheapest moment to hold it: the
 * writer still has the file in front of it, and the refusal says where the
 * excess goes. See ADR-032.
 *
 * Arms on every run phase, not only `implement`: the spec is written under
 * `spec`, the plan under `plan`, the work order and a re-plan under
 * `implement`. Transparent outside a run, on the archive, and on a budget of
 * 0. Fails open on its own crash, like every hook but the gate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { projectDir, readPhase, readPayload, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';

/** A live change artefact, repo-relative with `/`; the archive is never one. */
const ARTEFACT = /^specflow\/(?!archive\/)[^/]+\/(?:(spec|proposal|plan)\.md|milestones\/(M\d+)\.md)$/;

/** Where the excess goes, by artefact — the sentence the writer acts on. */
const WHERE = {
  spec: 'What binds the plan stays here; the reasoning, the alternatives and the context go to proposal.md (ADR-030).',
  proposal: 'One short paragraph per alternative that was genuinely on the table, and a Source verbatim enough to be evidence — not a transcript.',
  plan: 'Shared context only: per-milestone detail goes in that milestone\'s own file, and the implementer reads both.',
  milestone: 'Steps name decisions — which layer, which seam, which pattern to copy — never their implementation: no type bodies, no field lists, no function bodies (ADR-026).',
};

await run(async () => {
  const root = projectDir();

  // `readPhase`, not the sealed one: this fires inside the writing subagent,
  // whose payload need not carry the orchestrator's session id (ADR-017).
  const phase = readPhase(root);
  if (!phase || phase === 'idle' || phase === 'done') return;

  const payload = await readPayload();
  const input = payload.tool_input ?? {};
  const given = String(input.file_path ?? input.filePath ?? '');
  if (!given) return;
  const file = isAbsolute(given) ? given : join(root, given);
  const rel = relative(root, file).replace(/\\/g, '/');
  const match = ARTEFACT.exec(rel);
  if (!match || !existsSync(file)) return;
  const kind = match[1] ?? 'milestone';

  // A contract that does not load is the gate's problem to report, not a
  // reason to block every write.
  let budgets;
  try {
    budgets = loadConfig(root).trace.budgets;
  } catch {
    return;
  }
  const budget = Number(budgets?.[kind] ?? 0);
  if (!(budget > 0)) return;

  // The fold's status stamp is not the writer's prose, and a spec at its
  // budget must still take one.
  const size = readFileSync(file, 'utf8').replace(/^\*\*Status:\*\*.*$/m, '').length;
  if (size <= budget) return;

  process.stderr.write(
    `[spec-flow] ${rel} is ${size.toLocaleString('en-US')} characters; its budget is ${budget.toLocaleString('en-US')} ` +
      `(trace.budgets.${kind} in .spec-flow/config.json). Cut it now, while it is in front of you: every agent ` +
      `downstream reads this file on a fresh context, and what it does not need costs on every one of them. ` +
      `${WHERE[kind]} A change that genuinely needs more is two changes, or a budget the contract raises on ` +
      `purpose (ADR-032).\n`,
  );
  process.exit(2); // PostToolUse denial protocol
});

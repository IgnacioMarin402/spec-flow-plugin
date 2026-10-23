/**
 * The milestone an implementer's spawn works on, read from its prompt.
 *
 * One reading for every reader of it: the live view finds the agent a
 * `current-milestone` record names by the milestone it labelled that agent's
 * card with, and a record and a label read two ways can name two milestones.
 *
 * Pure — no Node import — because the live view loads it (ADR-037).
 */

// Its work order, in either separator: Windows names `specflow\x\milestones\M2.md`.
const WORK_ORDER = /specflow[\\/]([^\\/\s"'`]+)[\\/]milestones[\\/](M\d+)\.md/;
// `milestones/<Mk>.md` starting a path, as a fresh session on a milestone under
// way is handed it; `docs/milestones/M1.md` is some other file.
const BARE = /(?<![\w.-][\\/]?)milestones[\\/](M\d+)\.md/;

/**
 * The first work order the prompt names, wherever it stands; else a bare
 * `milestones/<Mk>.md`, with no change. Null when it names neither.
 *
 * @param {unknown} prompt
 * @returns {{ change: string, milestone: string } | null}
 */
export function milestoneRef(prompt) {
  const text = typeof prompt === 'string' ? prompt : '';
  const order = WORK_ORDER.exec(text);
  if (order) return { change: order[1], milestone: order[2] };
  const bare = BARE.exec(text);
  return bare ? { change: '', milestone: bare[1] } : null;
}

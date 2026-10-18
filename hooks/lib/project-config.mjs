/**
 * `.claude/spec-flow.config.json`, read the one way every reader reads it: the
 * caps (`budgets.mjs`), the routing (`routing.mjs`), the run-start check
 * (`can-run.mjs`) and the live view. Two readings of one file can disagree,
 * and then the pane shows a cap the hook does not deny at (ADR-047).
 *
 * Pure — no Node import — because the live view loads it, and a mod runs with
 * no Node (ADR-037).
 */

/**
 * The file's settings, and why it has none when it should: `{}` and no problem
 * for an empty file, `{}` and the problem for one that does not parse or is not
 * an object. A byte-order mark, which some editors write, is not part of the
 * JSON.
 *
 * @param {string} text
 * @returns {{ settings: Record<string, unknown>, problem: string }}
 */
export function projectConfig(text) {
  const json = text.replace(/^﻿/, '');
  if (json.trim() === '') return { settings: {}, problem: '' };
  let value;
  try {
    value = JSON.parse(json);
  } catch (err) {
    return { settings: {}, problem: `it does not parse as JSON (${err.message}), so none of its settings apply` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { settings: {}, problem: 'it is not a JSON object, so none of its settings apply' };
  }
  return { settings: value, problem: '' };
}

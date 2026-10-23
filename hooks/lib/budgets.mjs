/**
 * The escalation budgets: what `opus-budget` denies at and what the live view
 * shows. One copy, so the pane never shows a cap the hook does not deny at.
 *
 * Pure — no Node import — because the live view loads it, and a mod runs with
 * no Node (ADR-037).
 */

import { projectConfig } from './project-config.mjs';

/** Each escalation role's cap, its default and its counter (ADR-038). */
export const BUDGETS = {
  planner: { key: 'max_opus_calls', fallback: 6, counter: 'opus_calls' },
  architect: { key: 'max_architect_calls', fallback: 3, counter: 'architect_calls' },
};

/**
 * A role's cap, from the text of `.claude/spec-flow.config.json`: its default
 * when the file is missing or malformed, or does not set it. NaN when it sets
 * something that is not a whole number of calls, `null` included: no count
 * compares true against NaN, so a caller that compared would never deny.
 *
 * @param {string} configText
 * @param {string} role `planner` or `architect`
 * @returns {number}
 */
export function budgetCap(configText, role) {
  const budget = BUDGETS[role];
  const value = projectConfig(configText).settings[budget.key];
  if (value === undefined) return budget.fallback;
  // Digits only, in a string: `Number()` also reads "0x10" as 16 and "1e1" as 10.
  const cap = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(cap) && cap >= 0 ? cap : NaN;
}

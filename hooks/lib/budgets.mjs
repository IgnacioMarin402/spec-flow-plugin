/**
 * The escalation budgets: what `opus-budget` denies at and what the live view
 * shows. One copy, so the pane never shows a cap the hook does not deny at.
 *
 * Pure — no Node import — because the live view loads it, and a mod runs with
 * no Node (ADR-037).
 */

/** Each escalation role's cap, its default and its counter (ADR-038). */
export const BUDGETS = {
  planner: { key: 'max_opus_calls', fallback: 6, counter: 'opus_calls' },
  architect: { key: 'max_architect_calls', fallback: 3, counter: 'architect_calls' },
};

/**
 * A role's cap, from the text of `.claude/spec-flow.config.json`: its default
 * when the file is missing or malformed.
 *
 * @param {string} configText
 * @param {string} role `planner` or `architect`
 * @returns {number}
 */
export function budgetCap(configText, role) {
  const budget = BUDGETS[role];
  try {
    return Number(JSON.parse(configText)[budget.key] ?? budget.fallback);
  } catch {
    return budget.fallback;
  }
}

#!/usr/bin/env node
/**
 * How the `k=v` logs in `.claude/state/` are read back, in ONE copy.
 *
 * `specflow-stats.mjs` and `status.mjs` both report what a run has cost, and
 * two summaries of the same lines that disagree are worse than one that is
 * wrong: the disagreement is invisible from either side. Same reason
 * `hooks/lib/agent-name.mjs` exists.
 *
 * The writers are `hooks/run-trace.mjs`, `hooks/token-trace.mjs` and the
 * history line in `hooks/gate.mjs`. All three append space-separated `k=v`
 * pairs after an ISO timestamp, which is what makes one reader enough.
 */

/**
 * `k=v k=v` pairs off a log line, plus the leading ISO timestamp.
 *
 * Values are read as far as the next SPACE, which is why every writer strips
 * whitespace out of a value before it lands — a skill name or a file path
 * with a space in it would otherwise read as a second field.
 */
export function parseFields(line) {
  const fields = Object.fromEntries([...line.matchAll(/(\w[\w-]*)=(\S+)/g)].map(([, k, v]) => [k, v]));
  const at = /^(\S+Z)/.exec(line);
  return { at: at ? new Date(at[1]) : null, raw: line, ...fields };
}

/** The counters `token-trace.mjs` writes, in the order they are reported. */
export const TOKEN_FIELDS = ['in', 'out', 'cache_read', 'cache_write', 'think'];

/** Big counts at a glance. Exact below a thousand, where the exact value still means something. */
export const human = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(v));

/**
 * Parsed trace entries -> one row per model and chain, output-heaviest first.
 *
 * `sidechain` arrives as the STRING `"true"`: these rows come back from a log
 * line, not from the hook that wrote it, so the boolean was flattened on the
 * way out and comparing it as one would silently file every subagent under
 * `main`.
 */
export function summarizeTokens(entries) {
  const num = (v) => Number(v) || 0;
  const byModel = new Map();

  for (const e of entries) {
    if (!e.model || e.msgs === undefined) continue;
    const chain = e.sidechain === 'true' ? 'subagent' : 'main';
    const key = `${e.model}|${chain}`;
    const row = byModel.get(key) ?? { model: e.model, chain, msgs: 0, ...Object.fromEntries(TOKEN_FIELDS.map((f) => [f, 0])) };
    row.msgs += num(e.msgs);
    for (const f of TOKEN_FIELDS) row[f] += num(e[f]);
    byModel.set(key, row);
  }

  return [...byModel.values()].sort((a, b) => b.out - a.out);
}

/** One reported row, padded so a stack of them lines up. */
export function tokenRow(row, width) {
  return `${row.model.padEnd(width)}  ${row.chain.padEnd(8)}  in ${human(row.in)}  out ${human(row.out)}  cache_read ${human(row.cache_read)}  think ${human(row.think)}  (${row.msgs} msg)`;
}

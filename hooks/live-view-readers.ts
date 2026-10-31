/**
 * What the live view reads with the engine's own rules: a return block, the
 * escalation caps, the settings file, a milestone named in a prompt, and which
 * log lines count. The hooks read these in Go; a mod runs no binary's code, so
 * the view carries its own copy, and `hooks/readers.golden.json` holds both
 * copies to the same answers — the Go tests and live-view.test.tsx each read
 * it. A copy that drifts shows a cap the hook does not deny at (ADR-047).
 */

/** How many times the agent gate sends one return back before it lets it through. */
export const MAX_BLOCKS = 2

/**
 * The return block in an agent's reply: the first LINE opening with
 * `STATUS:` — emphasis, a heading mark or a quote mark allowed; a status named
 * mid-sentence is prose — and the `KEY: value` lines after it, up to a fence.
 * A key that repeats keeps its first value.
 */
export function parseReturn(text: unknown): { status: string; fields: Record<string, string> } | null {
  const s = String(text ?? '')
  const m = /^[ \t>#*]*STATUS:[ \t*]*([A-Z_]+)/m.exec(s)
  if (!m) return null
  const fields: Record<string, string> = {}
  for (const line of s.slice(m.index).split(/\r?\n/).slice(1)) {
    if (/^\s*```/.test(line)) break
    const kv = /^[ \t>*]*([A-Z][A-Z_]+):[ \t*]*(.*)$/.exec(line)
    if (kv && !(kv[1] in fields)) fields[kv[1]] = kv[2].trim()
  }
  return { status: m[1], fields }
}

/**
 * `.claude/spec-flow.config.json`'s settings, and why it has none when it
 * should: none and no problem for an empty file. A byte-order mark is not part
 * of the JSON.
 */
export function projectConfig(text: string): { settings: Record<string, unknown>; problem: string } {
  const json = text.replace(/^﻿/, '')
  if (json.trim() === '') return { settings: {}, problem: '' }
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch (err) {
    return { settings: {}, problem: `does not parse as JSON (${(err as Error).message}), so none of its settings apply` }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { settings: {}, problem: 'is not a JSON object, so none of its settings apply' }
  }
  return { settings: value as Record<string, unknown>, problem: '' }
}

/** Each escalation role's cap, its default and its counter (ADR-038). */
export const BUDGETS: Record<'planner' | 'architect', { key: string; fallback: number; counter: string }> = {
  planner: { key: 'max_opus_calls', fallback: 6, counter: 'opus_calls' },
  architect: { key: 'max_architect_calls', fallback: 3, counter: 'architect_calls' },
}

/**
 * A role's cap: its default when the file is missing, malformed or does not
 * set it; NaN when it sets anything that is not a whole number of calls,
 * `null` included — no count compares true against NaN.
 */
export function budgetCap(configText: string, role: string): number {
  const budget = BUDGETS[role as keyof typeof BUDGETS]
  const value = projectConfig(configText).settings[budget.key]
  if (value === undefined) return budget.fallback
  // Digits only, in a string: `Number()` also reads "0x10" as 16 and "1e1" as 10.
  const cap = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN
  return Number.isInteger(cap) && cap >= 0 ? cap : NaN
}

// A work order, in either separator; `milestones/<Mk>.md` starting a path, as
// a fresh session on a milestone under way is handed it. `docs/milestones/M1.md`
// is some other file.
const WORK_ORDER = /specflow[\\/]([^\\/\s"'`]+)[\\/]milestones[\\/](M\d+)\.md/
const BARE = /(?<![\w.-][\\/]?)milestones[\\/](M\d+)\.md/

/** The milestone a spawn's prompt names: its first work order, else a bare `milestones/<Mk>.md`. */
export function milestoneRef(prompt: unknown): { change: string; milestone: string } | null {
  const text = typeof prompt === 'string' ? prompt : ''
  const order = WORK_ORDER.exec(text)
  if (order) return { change: order[1], milestone: order[2] }
  const bare = BARE.exec(text)
  return bare ? { change: '', milestone: bare[1] } : null
}

/** How many of the lines that count a reading hands back: the last, a run's own. */
export const KEEP = 10000

/**
 * Whether a log line counts: it holds `needle` and is stamped at or after
 * `since` (ms). With `since` -Infinity, any line that is not blank, stamped or
 * not, as the run's telemetry mark counts them.
 */
export const counts = (line: string, needle: string, since: number): boolean =>
  line.includes(needle) && (since === -Infinity ? line.trim() !== '' : Date.parse(line.split(' ')[0]) >= since)

/**
 * The lines of `text` that count: how many, and the last `KEEP`. Past what one
 * read takes, `spec-flow lines` answers the same, a line at a time.
 */
export function linesOf(text: string, needle: string, since: number): { n: number; last: string[] } {
  const all = text.split(/\r?\n/).filter((l) => counts(l, needle, since))
  return { n: all.length, last: all.slice(-KEEP) }
}

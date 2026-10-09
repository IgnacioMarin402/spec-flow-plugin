#!/usr/bin/env node
/**
 * Reading the fenced return blocks an agent contract declares.
 *
 * A pure function over a string, in its own module so it can be tested as
 * one: `agent-contracts.mjs` exits the process on a finding, so importing it
 * from a test would end the test run rather than answer a question.
 *
 * **Every line break here is `\r?\n`, and that is the invariant.** These files
 * are read from wherever the plugin was installed, and git hands a Windows
 * checkout CRLF — so an anchor spelled `\n` finds nothing there while finding
 * everything on the machine it was written on. The failure is not subtle once
 * seen and is invisible before: the caller's own "I found no blocks" guard
 * fires, which reads as a moved anchor rather than as a line ending.
 */

/**
 * The field names declared across every fenced block that opens with
 * `STATUS:`, in declaration order, deduplicated.
 *
 * @param {string} text An agent contract's markdown.
 * @returns {{ blocks: number, fields: string[] }} `blocks` is how many were
 *   found, so a caller can tell "this agent declares none" from "the anchor
 *   stopped matching" — they are the same empty field list otherwise.
 */
export function returnBlocks(text) {
  const found = [...String(text ?? '').matchAll(/```\r?\n(STATUS:[\s\S]*?)```/g)];
  const fields = [];
  for (const block of found) {
    for (const line of block[1].split(/\r?\n/)) {
      const key = /^([A-Z][A-Z_]+):/.exec(line);
      if (key && !fields.includes(key[1])) fields.push(key[1]);
    }
  }
  return { blocks: found.length, fields };
}

/**
 * The fields no command names, matched as whole field names: `QUESTIONS` is
 * not named by a command that only says `OPEN_QUESTIONS`, and `READ` is not
 * named by `SPEC_READY`. A substring match let a field pass on a neighbour's
 * name, which reads exactly like a field that is routed.
 *
 * @param {string[]} fields Declared return fields.
 * @param {string} commandsText The commands' text, concatenated.
 * @param {Record<string, string>} [exempt] Fields deliberately not named, by reason.
 * @returns {string[]} The fields that are neither named nor exempt.
 */
export function unroutedFields(fields, commandsText, exempt = {}) {
  return fields.filter((f) => !(f in exempt) && !new RegExp(`(?<![A-Za-z0-9_])${f}(?![A-Za-z0-9_])`).test(commandsText));
}

/** How many questions one `NEEDS_INPUT` round may ask. The spec-writer's contract must state the same number (ADR-030). */
export const MAX_OPEN_QUESTIONS = 3;

/**
 * The statuses an agent contract declares: the `STATUS:` line of each fenced
 * return block.
 *
 * @param {string} text An agent contract's markdown, modes included.
 * @returns {string[]}
 */
export function declaredStatuses(text) {
  return [...new Set([...String(text ?? '').matchAll(/```\r?\nSTATUS:[ \t]*([A-Z_]+)/g)].map((m) => m[1]))];
}

/**
 * The return block in an agent's reply: its status and the `KEY: value` lines
 * after it, up to a closing fence. The first `STATUS:` wins — run-trace has
 * always recorded that one, and the agent gate must judge what is recorded.
 * A key that repeats keeps its first value; a list field's items are not read.
 *
 * @param {string} text What the agent handed back.
 * @returns {{ status: string, fields: Record<string, string> } | null}
 */
export function parseReturn(text) {
  const s = String(text ?? '');
  const m = /STATUS:\s*([A-Z_]+)/.exec(s);
  if (!m) return null;
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of s.slice(m.index).split(/\r?\n/).slice(1)) {
    if (/^\s*```/.test(line)) break;
    const kv = /^\s*([A-Z][A-Z_]+):[ \t]*(.*)$/.exec(line);
    if (kv && !(kv[1] in fields)) fields[kv[1]] = kv[2].trim();
  }
  return { status: m[1], fields };
}

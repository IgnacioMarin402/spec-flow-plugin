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

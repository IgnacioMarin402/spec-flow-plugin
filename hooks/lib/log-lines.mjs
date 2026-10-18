/**
 * The lines of a `.claude/state/` log the live view counts, read whole by the
 * view or, past what one `$.fs.read` takes (4 MiB), streamed by node. One
 * filter for both: a count must not change when a log crosses 4 MiB.
 *
 * Pure — no Node import — because the live view loads it, and a mod runs with
 * no Node (ADR-037). node runs the engine's hooks, so it is there wherever the
 * view has a run to show.
 */

/**
 * Whether a line counts: it holds `needle` and is stamped at or after `since`,
 * in milliseconds. A line with no stamp never counts.
 *
 * Self-contained, because `LINES` carries its source to node.
 *
 * @param {string} line
 * @param {string} needle
 * @param {number} since
 * @returns {boolean}
 */
export const counts = (line, needle, since) => line.includes(needle) && Date.parse(line.split(' ')[0]) >= since;

/** How many of the lines that count a reading hands back: the last, a run's own. */
export const KEEP = 10000;

/**
 * The lines of `text` that count: how many, and the last `KEEP` of them.
 *
 * @param {string} text
 * @param {string} needle
 * @param {number} since
 * @returns {{ n: number, last: string[] }}
 */
export function linesOf(text, needle, since) {
  const all = text.split(/\r?\n/).filter((l) => counts(l, needle, since));
  return { n: all.length, last: all.slice(-KEEP) };
}

/**
 * `linesOf` for a file one read cannot take, as `node -e LINES -- <path>
 * <since> <needle>`: `n` on the first line of its output, then the last `KEEP`
 * lines, oldest first. A line at a time, so the file's size costs no memory.
 */
export const LINES = `
const counts = ${counts};
const [path, since, needle] = process.argv.slice(1);
const last = [];
let n = 0;
require('readline')
  .createInterface({ input: require('fs').createReadStream(path), crlfDelay: Infinity })
  .on('line', (l) => { if (counts(l, needle, Number(since))) last[n++ % ${KEEP}] = l; })
  .on('close', () => process.stdout.write([n, ...last.slice(n % ${KEEP}), ...last.slice(0, n % ${KEEP})].join('\\n')));
`;

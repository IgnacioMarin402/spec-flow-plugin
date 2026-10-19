import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEEP, LINES, linesOf } from '../hooks/lib/log-lines.mjs';

// What node hands the live view for a log one read cannot take, read back as the view reads it.
function streamed(path, since, needle) {
  const [head, ...last] = execFileSync(process.execPath, ['-e', LINES, '--', path, String(since), needle], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
  return { n: Number(head), last: last.filter(Boolean) };
}

test('node streams the lines the live view counts: the same count and the same last lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'log-lines-'));
  try {
    const lines = [];
    for (let i = 0; i < KEEP + 2500; i++) {
      const at = new Date(Date.UTC(2026, 9, 17, 4, 0, 0) + i * 1000).toISOString();
      lines.push(`${at} phase=implement ${i % 3 === 0 ? 'agent-check' : 'tool=Read'} i=${i}`);
    }
    // A blank line, a line with no stamp, and Windows line ends: none of them counts, or splits one that does.
    lines.splice(7, 0, '', 'no stamp agent-check');
    const text = `${lines.join('\r\n')}\r\n`;
    const path = join(dir, 'run-trace.log');
    writeFileSync(path, text);

    const since = Date.UTC(2026, 9, 17, 4, 30, 0);
    for (const { at, needle } of [
      { at: 0, needle: ' agent-check ' },
      { at: since, needle: '' },
      { at: 0, needle: '' },
      { at: 0, needle: 'nothing has this' },
      { at: -Infinity, needle: '' },
    ]) {
      const view = linesOf(text, needle, at);
      assert.deepStrictEqual(streamed(path, at, needle), view, `since ${at}, needle ${JSON.stringify(needle)}`);
    }
    assert.strictEqual(linesOf(text, '', 0).n, KEEP + 2500, 'every stamped line, and only those');
    assert.strictEqual(linesOf(text, '', -Infinity).n, KEEP + 2501, 'every line that is not blank, as the run mark counts them');
    assert.strictEqual(linesOf(text, '', 0).last.length, KEEP, 'the last KEEP of them');
    assert.match(linesOf(text, '', 0).last.at(-1), / i=12499$/, 'oldest first, the newest last');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

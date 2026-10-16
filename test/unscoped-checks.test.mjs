#!/usr/bin/env node
/**
 * Unit tests for `scripts/unscoped-checks.mjs`: which declared check whose
 * file is missing is skipped, and which one fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUnscopedChecks } from '../scripts/unscoped-checks.mjs';

/** The rc of one declared check, run in an empty directory. */
function rcOf(cmd) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-flow-unscoped-'));
  try {
    const { checks } = runUnscopedChecks(dir, { extra_checks: [{ name: 'x', field: 'x', cmd }] });
    return checks.find((c) => c.name === 'x').rc;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The shape init writes for a local bin. Read green, a check whose tool was
// never installed reports that it passed.
test('a missing package entrypoint fails', () => {
  assert.notEqual(rcOf(['node', 'node_modules/typescript/bin/tsc', '--noEmit']), 0);
});

// The grace that case is carved out of: a repo mid-adoption declares a check
// before writing it, and its own pending script does not block it.
test('a repo-local script not written yet is skipped, not failed', () => {
  assert.equal(rcOf(['node', 'scripts/pending-check.mjs']), 0);
});

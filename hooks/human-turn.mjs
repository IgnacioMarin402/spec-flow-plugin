#!/usr/bin/env node
/**
 * Stop, UserPromptSubmit and PostToolUse on AskUserQuestion — records when the
 * session's turn ends and when a prompt or an answer arrives, for the case 3
 * check (ADR-036). Never what was said.
 *
 * A prompt that opens with a tag — `<task-notification>` and the rest of what
 * the harness delivers in that hook — is recorded under the tag's name, not
 * as a person; a person's pasted text opens with `<pasted_content>` and is
 * one. The payload names no source, so `lib/human-turn.mjs` also asks for a
 * turn end before a prompt counts.
 *
 * Only in a repository that adopted this engine, in or out of a run: the
 * prompt that starts a run arrives before its phase is written, and it is the
 * evidence that this build fires the hook at all. Always exits 0, silently.
 */
import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectDir, stateDir, readPayload, run } from './lib/io.mjs';
import { LOG } from './lib/human-turn.mjs';

await run(async () => {
  const root = projectDir();
  if (!existsSync(join(root, '.spec-flow', 'config.json'))) return;

  const payload = await readPayload();
  const event = String(payload.hook_event_name ?? '');
  let line = '';
  if (event === 'Stop') line = 'turn-end';
  else if (event === 'PostToolUse' && payload.tool_name === 'AskUserQuestion') line = 'prompt from=question';
  else if (event === 'UserPromptSubmit') {
    const tag = /^\s*<([\w-]+)/.exec(String(payload.prompt ?? ''))?.[1];
    line = `prompt from=${!tag || tag === 'pasted_content' ? 'human' : tag}`;
  }
  if (!line) return;

  try {
    appendFileSync(join(stateDir(root), LOG), `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* a record must never be why a prompt or a stop fails */
  }
});

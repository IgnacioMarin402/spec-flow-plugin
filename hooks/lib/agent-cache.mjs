#!/usr/bin/env node
/**
 * Whether a SendMessage would resume one of this plugin's agents after its
 * prompt cache expired — and so re-send its whole context before doing
 * anything. See ADR-025.
 *
 * One copy, because `stale-resume.mjs` denies such a message and
 * `opus-budget.mjs` must not charge it: two answers to one question would
 * bill a consult the other hook refused.
 *
 * Returns `null` whenever it cannot tell — no transcript, no id, an agent
 * that is not this plugin's, no cache write on record — and both callers
 * read `null` as "not cold". A hook guessing that a message is expensive
 * would deny work over a guess.
 */
import { readFileSync, statSync } from 'node:fs';
import { shippedAgents } from './routing.mjs';
import { matchAgent, recipientRecord, recipientType } from './agent-name.mjs';

export function coldResume(payload) {
  const rec = recipientRecord(payload);
  if (!rec) return null;
  const { to, file } = rec;
  const type = recipientType(payload);
  let text;
  let mtimeMs;
  try {
    mtimeMs = statSync(file).mtimeMs;
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const agent = matchAgent([type], Object.keys(shippedAgents()));
  if (!agent) return null;

  // The TTL is read off the agent's own last cache write rather than assumed:
  // a subagent writes 5-minute entries and a session 1-hour ones (measured),
  // and whichever it used is the one that expires.
  let ttlMin = 0;
  let context = 0;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && !ttlMin; i -= 1) {
    if (!lines[i].includes('"usage"')) continue;
    let usage;
    try {
      usage = JSON.parse(lines[i]).message?.usage;
    } catch {
      continue;
    }
    if (!usage) continue;
    if (!context) context = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    if ((usage.cache_creation?.ephemeral_1h_input_tokens ?? 0) > 0) ttlMin = 60;
    else if ((usage.cache_creation?.ephemeral_5m_input_tokens ?? 0) > 0) ttlMin = 5;
  }
  if (!ttlMin) return null;

  // The file's last write is AFTER the request that last touched the cache,
  // so measuring from it can only understate the age: a resume it calls cold
  // is cold for certain.
  const ageMin = (Date.now() - mtimeMs) / 60_000;
  return ageMin > ttlMin ? { to, agent, ageMin, ttlMin, context } : null;
}

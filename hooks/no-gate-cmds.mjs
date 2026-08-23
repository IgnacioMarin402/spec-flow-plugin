#!/usr/bin/env node
/**
 * PreToolUse hook on Bash — keep WHOLE-REPO lint/test runs out of a spec-flow
 * run.
 *
 * What this protects against is scope, not the commands. A run of the full
 * suite dumps every file's output into the agent's context, most of it about
 * files the milestone never touched, and it buries the signal about the
 * change being made.
 *
 * So it does NOT ban checking your work. The scoped forms a project declares
 * in `.spec-flow/config.json` — its own check command, and any invocation
 * that names a path — stay allowed. Only the unscoped variants are
 * redirected, and only while the phase is `implement`.
 *
 * This is a consistency guard, not a security boundary: the classifier below
 * splits on `&&|;|` and whitespace, which `sh -c '...'`, a subshell, a
 * heredoc, or `npm t` (an alias `wholeRepoScripts`/`tools` do not name)
 * trivially evade. That is acceptable because `hooks/gate.mjs` re-runs the
 * real scoped checks on Stop regardless of what the agent ran mid-turn — an
 * evasion here wastes context on unscoped output, it does not skip the gate.
 */
import { projectDir, readPhase, readPayload, run } from './lib/io.mjs';
import { loadConfig } from '../scripts/spec-flow-config.mjs';

/** Basename, minus a trailing `.sh` — the shape a declared script name is matched against. */
const scriptName = (tok) => tok.replace(/^.*[\\/]/, '').replace(/\.sh$/, '');
const toolName = (tok) => tok.replace(/^.*[\\/]/, '');

function classify(cmd, denied) {
  if (!cmd) return { verdict: 'allow' };

  // A compound command is denied if ANY of its parts is denied.
  for (const part of cmd.split(/&&|\|\||;|\|/)) {
    const t = part.trim().split(/\s+/).filter(Boolean);
    if (t.length === 0) continue;

    // The scoped escape hatch is always fine, whatever shape it takes.
    // Matched on whole tokens: a substring match would also swallow a flag
    // like `--checkCoverage` on a test runner whose name contains "check",
    // turning the escape hatch into a way to run the whole suite.
    if (t.some((tok) => denied.scopedAllowed.has(scriptName(tok)))) continue;

    let i = 0;
    if (/^(pnpm|npm|yarn|npx)$/.test(t[i])) {
      i++;
      if (t[i] === 'run' || t[i] === 'exec') i++;
      if (!t[i]) continue;
      if (denied.scopedAllowed.has(t[i])) continue;
      if (denied.wholeRepoScripts.has(t[i])) return { verdict: 'deny', name: t[i] };
      if (!denied.tools.has(toolName(t[i]))) continue; // not our business
    } else if (t[i] === 'node') {
      // `node node_modules/<tool>/bin/<tool>.js` is the invocation style the
      // gate itself uses (see .spec-flow/README.md in a consuming repo for
      // why), so it must be scoped exactly like a bare tool name.
      i++;
      while (t[i] && t[i].startsWith('-')) i++; // skip node's own flags, which a runner may need before its own name
      if (!t[i]) continue;
      if (!denied.tools.has(toolName(t[i]).replace(/\.[cm]?js$/, ''))) continue;
    } else if (!denied.tools.has(toolName(t[i]))) {
      continue; // not our business
    }

    // Direct tool invocation: allowed only if it names a path to scope it.
    const args = t.slice(i + 1);
    const scoped = args.some((a) => !a.startsWith('-') && a !== '.' && a !== './');
    if (!scoped) return { verdict: 'deny', name: t[i] };
  }
  return { verdict: 'allow' };
}

await run(async () => {
  const root = projectDir();

  // `readPhase`: this hook DENIES, and a deny driven by a phase the repository
  // committed is a deny nobody in the session can explain — no run is in
  // progress to explain it (ADR-017). Same path helper as every other hook now,
  // rather than the copy this file used to compose itself.
  const phase = readPhase(root);
  if (phase !== 'implement') return;

  const payload = await readPayload();
  const cmd = String(payload.tool_input?.command ?? '');
  if (!cmd) return;

  let config;
  try {
    config = loadConfig(root);
  } catch {
    return; // a bad contract must not block every Bash call — the gate reports it loudly
  }

  const denied = {
    wholeRepoScripts: new Set(config.unscoped_denied.scripts),
    tools: new Set(config.unscoped_denied.tools),
    scopedAllowed: new Set(config.unscoped_denied.scoped_allowed),
  };

  const result = classify(cmd, denied);
  if (result.verdict !== 'deny') return;

  const examples = config.unscoped_denied.scoped_examples ?? [];
  const alternative = config.unscoped_denied.scoped_alternative;
  const rest = examples.filter((e) => e !== alternative);
  const scopedHint = rest.length ? ` (${rest.map((e) => `\`${e}\``).join(', ')})` : '';

  process.stderr.write(
    `[spec-flow] Denied: \`${result.name}\` runs over the WHOLE repo, and the flow is ` +
      `mid-run. Not because checking your work is wrong — because the full output is ` +
      `mostly about files this milestone never touched, and it lands in your context.\n\n` +
      `Run the scoped check instead — same commands, only the files this branch changed:\n\n` +
      `    ${alternative}\n\n` +
      `Scoped invocations are allowed too${scopedHint}. If you are the implementer, ` +
      `you do not need to run anything: end your turn and the gate reports back.\n\n` +
      // No disarm recipe here, on purpose. This message is read by an agent
      // mid-milestone far more often than by a human, and writing `idle` into
      // the phase file stands down the gate, the write-time linter, this deny
      // and the Opus budget at once — with nothing watching that write the way
      // phase-guard watches `done`. Handing a model the exact command to turn
      // off the thing that just stopped it is not a guard rail. A human who
      // genuinely wants a whole-repo run has the README.
      `A human who needs the whole repo can stand the flow down — see the plugin README.\n`,
  );
  process.exit(2); // PreToolUse denial protocol
});

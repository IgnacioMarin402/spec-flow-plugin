#!/usr/bin/env node
/**
 * The planner writes a milestone; the reviewer is the only pass that reads it
 * before an implementer is spent. This asserts the two agree about which of
 * its fields matter.
 *
 * **The failure this closes has already happened here.** A `Skills:` field was
 * added to the milestone template and to the planner's contract, and the
 * reviewer — the one agent whose job is checking the plan — was not told, so a
 * milestone missing it passed review unseen. Nothing could have caught that:
 * the agents are Markdown, and no fixture executes Markdown.
 *
 * It is not a general "review every field" rule, because some fields do not
 * need one — `Definition of done` is boilerplate every milestone repeats, and
 * checking it would be theatre. What is enforced is that the disagreement is a
 * DECISION rather than an oversight: a field is either named in the reviewer's
 * checklist, or listed below with the reason it is not. Adding a field to the
 * template and nothing else turns this red.
 *
 * That direction matters more than its opposite. A field the reviewer checks
 * and the planner never writes is noise in a prompt; a field the planner
 * writes and nobody checks is the bug above.
 *
 * Three more halves, each the same rule aimed at a different seam where prose
 * has to agree with prose or with code:
 *
 *   - a field the spec-writer RETURNS must be read by a command, or be exempt
 *     with a reason. `GAPS:` is the case that forced it — the only channel
 *     for a finding no check here can produce (ADR-020).
 *   - an agent asserting that a check FAILS over a contract-gated subject must
 *     name the field that gates it, since the sentence is false wherever the
 *     project left it off.
 *   - a `tools:` list nobody wrote is not a blank: it is the widest grant the
 *     harness offers, and it looks identical to a deliberate one.
 *
 *   node scripts/agent-contracts.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { returnBlocks } from './agent-blocks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS = join(ROOT, 'agents');
const planner = readFileSync(join(AGENTS, 'planner.md'), 'utf8');
const reviewer = readFileSync(join(AGENTS, 'reviewer.md'), 'utf8');

/**
 * Fields the reviewer deliberately does not check, each with the reason.
 *
 * A field belongs here only when checking it would add nothing — not when
 * nobody has got round to it. Emptying this list is not the goal; deciding
 * each entry is.
 */
const NOT_REVIEWED = {
  Steps: 'the reviewer judges whether the plan will bite during implementation, which is these in aggregate; per-step review is the second pass this flow deliberately cut',
  'Lint/type notes': 'advisory to the implementer, and wrong ones cost a lint cycle rather than a wrong plan',
  'Definition of done': 'boilerplate every milestone repeats verbatim — the gate defines it, not the planner',
  'Depends on': 'covered by "are milestones correctly ordered and independently testable", which is stronger than the field',
};

/**
 * The milestone template: the fenced block introduced by the line naming
 * `milestones/Mk.md`. Anchored to that introduction rather than to "the second
 * fence in the file", so moving a block does not silently change what is
 * checked — if the anchor stops matching, this fails rather than checking an
 * empty set.
 */
function templateFields() {
  const intro = planner.indexOf('milestones/Mk.md`**');
  if (intro === -1) return null;
  const open = planner.indexOf('```', intro);
  const close = planner.indexOf('```', open + 3);
  if (open === -1 || close === -1) return null;

  return [...planner.slice(open, close).matchAll(/^- ([A-Z][^:\n]*):/gm)].map((m) => m[1]);
}

const fields = templateFields();
const problems = [];

if (!fields || fields.length === 0) {
  problems.push(
    "the milestone template could not be found in agents/planner.md. It is anchored to the line naming `milestones/Mk.md` followed by a fenced block; if that moved, fix this check rather than leaving it matching nothing — a check that silently finds no fields passes forever.",
  );
} else {
  for (const field of fields) {
    if (reviewer.toLowerCase().includes(field.toLowerCase())) continue;
    if (field in NOT_REVIEWED) continue;
    problems.push(
      `the planner's milestone template declares "${field}" and agents/reviewer.md never names it. The reviewer is the only pass that reads a milestone before an implementer is spent, so a field nobody checks is a field the planner can silently omit. Add it to the reviewer's checklist, or add it to NOT_REVIEWED in this file with the reason it does not need one.`,
    );
  }

  // The reverse, as a warning about drift rather than a defect: an exemption
  // for a field that no longer exists is stale reasoning about nothing.
  for (const field of Object.keys(NOT_REVIEWED)) {
    if (!fields.includes(field)) {
      problems.push(
        `NOT_REVIEWED exempts "${field}", which the milestone template no longer declares. Remove the entry — an exemption nobody can reach is a decision about a field that does not exist.`,
      );
    }
  }
}

// ---- a field an agent RETURNS must be read by the command driving it -----
//
// Same failure as the milestone-template half above, one hop further along:
// the spec-writer's return blocks are the only channel some findings have, and
// a field no command names is a finding that reaches the orchestrator and
// stops there. `GAPS:` is the case that forced this — it is the only place a
// test that carries a requirement's id and asserts nothing is ever reported
// (ADR-020), so an orchestrator that does not read it drops the one finding
// no check in this engine can produce.
//
// Fields, not prose: this asks whether the command names the key, never
// whether it handles it well.
const commandsText = ['spec-flow.md', 'spec-fix.md']
  .map((f) => readFileSync(join(ROOT, 'commands', f), 'utf8'))
  .join('\n');

/**
 * Return-block fields the commands deliberately do not name, with the reason.
 * An entry belongs here when the orchestrator has nothing to decide from the
 * field — not when nobody has got round to it.
 */
const NOT_ROUTED = {
  STATUS: 'the block\'s own discriminator — every command branches on its VALUE, which is named, rather than on the key',

  // Read by MEANING rather than by key. The orchestrator acts on the path or
  // the text; it never needs to say the label back. Naming these in the
  // commands would be ceremony, and ceremony in a prompt costs tokens on every
  // run of every flow.
  SPEC_PATH: 'the commands work from `specflow/<SLUG>/spec.md` directly — the path is used, the label never has to be',
  PROPOSAL_PATH: 'same as SPEC_PATH: `proposal.md` is named where it is read, at sign-off',
  SUMMARY: 'step 1 already tells the orchestrator to show the user a summary drawn from both artifacts; the key adds nothing to that instruction',
  DELTAS: '/spec-fix routes on CASE, and the deltas it names are the ones the spec file already carries',

  // Confirmations of work already done. There is no branch to take: a fold
  // that archived nothing fails the phase-guard on `done`, and a fold that
  // stamped nothing shows as `0 insertions(+)`, which step 5 already reads.
  SPECS_VERIFIED: 'a confirmation of the verification, not a finding — a delta that did NOT land comes back through GAPS, which is routed',
  FIXED: 'a confirmation of spec-side edits the fold is entitled to make on its own',
  ARCHIVED: 'a confirmation of the move; an unarchived specflow/<SLUG>/ is caught by phase-guard when `done` is written, which is a check rather than a prompt',
};

const declared = returnBlocks(readFileSync(join(AGENTS, 'spec-writer.md'), 'utf8'));

if (declared.blocks === 0) {
  problems.push(
    'agents/spec-writer.md declares no `STATUS:` return block. They are anchored to a fenced block opening with `STATUS:`; if that shape moved, fix this check rather than leaving it matching nothing — a check that silently finds no fields passes forever.',
  );
}

const returnFields = new Set(declared.fields);

for (const field of [...returnFields].sort()) {
  if (field in NOT_ROUTED) continue;
  if (commandsText.includes(field)) continue;
  problems.push(
    `agents/spec-writer.md returns "${field}:" and neither command names it. A return field no command reads is a finding that reaches the orchestrator and stops there — which for a field like GAPS is the only report of something no check in this engine can produce. Name it in the command that drives that mode, or add it to NOT_ROUTED in this file with the reason it needs no handling.`,
  );
}

for (const field of Object.keys(NOT_ROUTED)) {
  if (!returnFields.has(field)) {
    problems.push(
      `NOT_ROUTED exempts "${field}", which no spec-writer return block declares. Remove the entry — an exemption nobody can reach is a decision about a field that does not exist.`,
    );
  }
}

// ---- an agent may not describe a GATED check as unconditional ------------
//
// `spec-trace` has checks the contract can switch off, and one of them was
// unconditional for a single commit. When it became a contract opt-in the
// reviewer's contract was updated and the implementer's was not, so the
// implementer still told the model that spec-trace fails a milestone with no
// `Skills:` field — false in the default contract, and unfalsifiable from
// inside a run, where the only evidence would be a gate that never fired.
//
// The rule is narrow because this file cannot judge whether prose is TRUE.
// What it can insist on is that an agent asserting a spec-trace FAILURE about
// a subject the contract gates names the gating field in the same file. That
// is the fact a reader needs, and it is precisely what goes stale when a
// check moves between unconditional and opt-in.
//
// The gated fields are read out of spec-trace itself rather than listed here:
// a list would keep agreeing with the code exactly until someone gates a
// second check.
const specTrace = readFileSync(join(ROOT, 'scripts', 'spec-trace.mjs'), 'utf8');

/** `if (!CONFIG.trace.require_skills_field) continue;` -> `require_skills_field`. */
const gatedFields = [...specTrace.matchAll(/CONFIG\.trace\.(\w+)\)\s*continue/g)].map((m) => m[1]);

for (const field of gatedFields) {
  // `require_skills_field` -> `skills`: the subject the field decides about,
  // and the word an agent's prose will be using instead of the field name.
  const subject = field.replace(/^require_/, '').replace(/_field$/, '').replace(/_/g, ' ');

  for (const file of readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort()) {
    const text = readFileSync(join(AGENTS, file), 'utf8');
    if (text.includes(field)) continue; // the condition is stated somewhere in this contract

    // Paragraph, not sentence: the assertion and its subject routinely sit in
    // neighbouring sentences, and the implementer's real defect did exactly
    // that — "spec-trace fails a milestone without it" one sentence after the
    // last mention of the field it means.
    for (const para of text.split(/\n\s*\n/)) {
      const lower = para.toLowerCase();
      if (!lower.includes('spec-trace') || !lower.includes(subject)) continue;
      if (!/\bfails?\b|\brejects?\b|\brefuses?\b/.test(lower)) continue;
      problems.push(
        `agents/${file} tells its reader that spec-trace fails over "${subject}", and never names \`${field}\` — the contract field that decides whether that check runs at all. It is off by default, so the sentence is false in most repos, and an agent cannot discover that from inside a run: the only evidence would be a gate that never fires. State the condition, or say what actually always checks it.`,
      );
      break;
    }
  }
}

// ---- every shipped agent says what it may use ----------------------------
//
// An agent with no `tools:` inherits every tool the harness offers, `Task`
// included — so the omission is not "unspecified", it is the widest possible
// grant, granted by saying nothing. Four of the five here were explicitly
// scoped and one was not, and the difference had never been decided: it read
// as an oversight and as a choice in exactly the same way, which is the shape
// this whole file exists to refuse.
//
// The list's CONTENTS stay the author's business — this asks only that the
// question was answered. A narrower rule would be this file having an opinion
// about what a planner needs, which it is not entitled to have.
const agentFiles = readdirSync(AGENTS)
  .filter((f) => f.endsWith('.md'))
  .sort();

if (agentFiles.length === 0) {
  problems.push(
    'agents/ contains no .md files. A scan that finds nothing passes exactly as a clean directory does, so finding no agents is a failure here rather than a quiet OK.',
  );
}

for (const file of agentFiles) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(AGENTS, file), 'utf8'));
  if (!frontmatter) {
    problems.push(`agents/${file} has no YAML frontmatter, so the harness reads neither its name nor its model.`);
    continue;
  }
  if (!/^tools:[ \t]*\S/m.test(frontmatter[1])) {
    problems.push(
      `agents/${file} declares no \`tools:\`, so it inherits every tool the harness offers — including Task, which lets it spawn agents of its own. Name the tools it actually uses. If inheriting everything IS the intent, that is a decision worth a line: say so in the frontmatter and this check still fails, because the field is what records it.`,
    );
  }
}

if (problems.length > 0) {
  console.error(`agent-contracts: ${problems.length} problem(s).\n`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `agent-contracts: OK — ${fields.length} milestone field(s); ` +
    `${fields.length - Object.keys(NOT_REVIEWED).length} named in the reviewer's checklist, ` +
    `${Object.keys(NOT_REVIEWED).length} exempt with a stated reason; ` +
    `${agentFiles.length} agent(s), every one declaring its tools; ` +
    `${returnFields.size} spec-writer return field(s), ${returnFields.size - Object.keys(NOT_ROUTED).length} routed by a command and ${Object.keys(NOT_ROUTED).length} exempt with a stated reason; ` +
    `${gatedFields.length} contract-gated spec-trace check(s), none described as unconditional.`,
);

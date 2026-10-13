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
 * need one — `Depends on` is covered by a stronger question on the checklist,
 * and checking the field itself would be theatre. What is enforced is that the disagreement is a
 * DECISION rather than an oversight: a field is either named in the reviewer's
 * checklist, or listed below with the reason it is not. Adding a field to the
 * template and nothing else turns this red.
 *
 * That direction matters more than its opposite. A field the reviewer checks
 * and the planner never writes is noise in a prompt; a field the planner
 * writes and nobody checks is the bug above.
 *
 * More halves, each the same rule aimed at a different seam where prose has
 * to agree with prose or with code:
 *
 *   - a field the spec-writer RETURNS must be read by a command, or be exempt
 *     with a reason. `GAPS:` is the case that forced it — the only channel
 *     for a finding no check here can produce (ADR-020).
 *   - an agent asserting that a check FAILS over a contract-gated subject must
 *     name the field that gates it, since the sentence is false wherever the
 *     project left it off.
 *   - a `tools:` list nobody wrote is not a blank: it is the widest grant the
 *     harness offers, and it looks identical to a deliberate one.
 *   - the spec-writer's contract must state the question cap and carry the
 *     assumptions section the checks hold its output to.
 *   - each command's fold step must offer a weak test's fix as `/spec-fix`,
 *     and a fresh implementer only to say never (ADR-042).
 *
 *   node scripts/agent-contracts.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { returnBlocks, unroutedFields, MAX_OPEN_QUESTIONS } from './agent-blocks.mjs';
import { assumptionsProblem } from './spec-shape.mjs';

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
  Objective: 'what "done" means for a milestone is judged through its deltas and its tests, which are the checkable form of the same claim',
  Steps: 'the reviewer judges whether the plan will bite during implementation, which is these in aggregate; per-step review is the second pass this flow deliberately cut',
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
    // Whole words, not a substring: a checklist saying the gate checks
    // implementation "objectively" does not name `Objective`.
    if (new RegExp(`\\b${field.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\b`, 'i').test(reviewer)) continue;
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

  // The planner's, read by meaning: each answers the step that asked for it.
  PLAN_PATH: 'same as SPEC_PATH: the commands work from `specflow/<SLUG>/plan.md` directly',
  MILESTONES: 'step 4 walks the milestone index in plan.md, not this line',
  ANSWERS: 'handed whole to the re-invoked reviewer ("with the answers"), which reads them by meaning',
  CHANGES: 'REPLAN\'s account of what it rewrote; the implementer is sent back to the revised Mk.md, not to this line',

  // The architect's answer, handed whole to the implementer as its
  // ARCHITECT_GUIDANCE. The implementer reads it by meaning; the orchestrator
  // branches only on IF_PLAN_WRONG, which is named.
  'architect.DECISIONS': 'relayed whole to the implementer as ARCHITECT_GUIDANCE; nothing branches on it',
  'architect.DESIGN_NOTES': 'relayed whole to the implementer with DECISIONS; nothing branches on it',

  // The reviewer's remarks on a plan it APPROVED. Nothing branches on them:
  // a doubt comes back as ESCALATE, a fixable problem as CHANGES_REQUESTED.
  'reviewer.NOTES': 'optional remarks on an APPROVED plan; a doubt or a problem comes back under a status that is routed',

  // Confirmations of work already done. There is no branch to take: a fold
  // that archived nothing fails the phase-guard on `done`, and a fold that
  // stamped nothing shows as `0 insertions(+)`, which step 5 already reads.
  SPECS_VERIFIED: 'a confirmation of the verification, not a finding — a delta that did NOT land comes back through GAPS, which is routed',
  FIXED: 'a confirmation of spec-side edits the fold is entitled to make on its own',
  ARCHIVED: 'a confirmation of the move; an unarchived specflow/<SLUG>/ is caught by phase-guard when `done` is written, which is a check rather than a prompt',
};

// The agents whose return blocks carry a finding the orchestrator itself must
// act on. The implementer's is left out on purpose: what it returns is handed
// whole to the next agent, so the orchestrator relays it rather than
// branching on its fields. The planner is in: its NOTES are for the human. So
// is the architect: the orchestrator branches on its IF_PLAN_WRONG, and its
// NOTES are for the human (ADR-038).
//
// An agent's blocks live in `agents/<name>.md` and in its `modes/<name>-*.md`,
// which it reads per mode; they are its blocks as much as the main file's are.
const ROUTED_AGENTS = ['spec-writer', 'planner', 'reviewer', 'architect'];
const MODES = join(ROOT, 'modes');

const returnedBy = new Map(); // field -> agents declaring it
for (const name of ROUTED_AGENTS) {
  const modeFiles = readdirSync(MODES)
    .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.md'))
    .sort();
  const declared = returnBlocks(
    [readFileSync(join(AGENTS, `${name}.md`), 'utf8'), ...modeFiles.map((f) => readFileSync(join(MODES, f), 'utf8'))].join('\n'),
  );
  if (declared.blocks === 0) {
    problems.push(
      `agents/${name}.md and modes/${name}-*.md declare no \`STATUS:\` return block. They are anchored to a fenced block opening with \`STATUS:\`; if that shape moved, fix this check rather than leaving it matching nothing — a check that silently finds no fields passes forever.`,
    );
  }
  for (const field of declared.fields) returnedBy.set(field, [...(returnedBy.get(field) ?? []), name]);
}

// An exemption covers a field for every routed agent (`FIELD`) or for one
// (`agent.FIELD`): the same label can be a finding from one agent and a remark
// from another — the planner's NOTES report a spec bug, the reviewer's do not.
for (const [field, agents] of [...returnedBy].sort()) {
  for (const agent of agents) {
    if (`${agent}.${field}` in NOT_ROUTED || unroutedFields([field], commandsText, NOT_ROUTED).length === 0) continue;
    problems.push(
    `agents/${agent}.md returns "${field}:" and neither command names it. A return field no command reads is a finding that reaches the orchestrator and stops there — which for a field like GAPS is the only report of something no check in this engine can produce. Name it in the command that drives that mode, or add it to NOT_ROUTED in this file with the reason it needs no handling.`,
    );
  }
}

for (const key of Object.keys(NOT_ROUTED)) {
  const [agent, field] = key.includes('.') ? key.split('.') : [null, key];
  if (agent ? !(returnedBy.get(field) ?? []).includes(agent) : !returnedBy.has(field)) {
    problems.push(
      `NOT_ROUTED exempts "${key}", which no routed agent's return block declares. Remove the entry — an exemption nobody can reach is a decision about a field that does not exist.`,
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

// Same guard as the template's, for the same reason: a pattern that stops
// matching reads exactly like a spec-trace with nothing gated, and passes
// forever. If the last gated check is ever removed, remove this one with it.
if (gatedFields.length === 0) {
  problems.push(
    'no contract-gated check was found in scripts/spec-trace.mjs (the `if (!CONFIG.trace.<field>) continue` shape). If that line was rewritten, fix the pattern here; if the last gated check was removed, remove this check too — matching nothing, it passes forever.',
  );
}

for (const field of gatedFields) {
  // `require_skills_field` -> `skills`: the subject the field decides about,
  // and the word an agent's prose will be using instead of the field name.
  const subject = field.replace(/^require_/, '').replace(/_field$/, '').replace(/_/g, ' ');

  const contracts = [
    ...readdirSync(AGENTS).filter((f) => f.endsWith('.md')).sort().map((f) => `agents/${f}`),
    ...readdirSync(MODES).filter((f) => f.endsWith('.md')).sort().map((f) => `modes/${f}`),
  ];
  for (const file of contracts) {
    const text = readFileSync(join(ROOT, file), 'utf8');
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
        `${file} tells its reader that spec-trace fails over "${subject}", and never names \`${field}\` — the contract field that decides whether that check runs at all. It is off by default, so the sentence is false in most repos, and an agent cannot discover that from inside a run: the only evidence would be a gate that never fires. State the condition, or say what actually always checks it.`,
      );
      break;
    }
  }
}

// ---- the spec-writer's contract states what the checks hold it to --------
//
// The question cap and the assumptions section are enforced on the
// spec-writer's output, and it learns both only from its contract. Prose that
// says 4 where the code holds 3, or a template the check would reject, fails
// a writer that did what it was told (ADR-030). The sign-off reads the
// section, so both commands that drive one must show it to the human.
const specWriter = readFileSync(join(AGENTS, 'spec-writer.md'), 'utf8');
const specTemplate = (() => {
  const intro = specWriter.indexOf('## Spec format (spec.md)');
  const open = intro === -1 ? -1 : specWriter.indexOf('```', intro);
  const close = open === -1 ? -1 : specWriter.indexOf('```', open + 3);
  return close === -1 ? null : specWriter.slice(open + 3, close);
})();
if (specTemplate === null) {
  problems.push('the spec template could not be found in agents/spec-writer.md (a fenced block after `## Spec format (spec.md)`). Fix this check rather than leaving it matching nothing.');
} else if (assumptionsProblem(specTemplate)) {
  problems.push(`agents/spec-writer.md's spec template ${assumptionsProblem(specTemplate)}: a writer following it writes a spec the check rejects.`);
}
if (!specWriter.includes(`at most ${MAX_OPEN_QUESTIONS} questions`)) {
  problems.push(`agents/spec-writer.md does not say "at most ${MAX_OPEN_QUESTIONS} questions", the cap in MAX_OPEN_QUESTIONS (scripts/agent-blocks.mjs).`);
}
for (const file of ['spec-flow.md', 'resume.md']) {
  if (!/\bAssumptions\b/.test(readFileSync(join(ROOT, 'commands', file), 'utf8'))) {
    problems.push(`commands/${file} never names the spec's Assumptions, so its sign-off does not show the human what the writer decided without asking.`);
  }
}

// A weak test the fold names is fixed after `done`, where the gate, lint-on-write
// and the command deny stand down. Only a new run arms them again: /spec-fix,
// whose triage reads it as case 2 (ADR-042).
for (const file of ['spec-flow.md', 'spec-fix.md']) {
  const foldStep = /^## 5\. FOLD[\s\S]*?(?=^## )/m.exec(readFileSync(join(ROOT, 'commands', file), 'utf8'))?.[0] ?? '';
  const gapsOffer = foldStep.split('\n').find((line) => line.includes('`GAPS:`')) ?? '';
  if (!gapsOffer) {
    problems.push(`commands/${file} step 5 has no line naming \`GAPS:\`; fix this check rather than leaving it matching nothing.`);
  } else if (!gapsOffer.includes('/spec-fix') || /fresh implementer/i.test(gapsOffer.replace(/never a fresh implementer/gi, ''))) {
    problems.push(`commands/${file} step 5 offers a fix for a weak test other than \`/spec-fix\`. Offered after \`done\`, any other fix runs with the gate, lint-on-write and the command deny standing down.`);
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
    `${returnedBy.size} return field(s) from ${ROUTED_AGENTS.join(' and ')}, ${returnedBy.size - Object.keys(NOT_ROUTED).length} routed by a command and ${Object.keys(NOT_ROUTED).length} exempt with a stated reason; ` +
    `${gatedFields.length} contract-gated spec-trace check(s), none described as unconditional.`,
);

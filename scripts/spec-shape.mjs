/**
 * The grammar of a change spec — what spec-trace, and every later reader of a
 * spec, agrees a delta, a kind and an id are.
 *
 * One copy, imported. spec-trace runs its whole check on import, so nothing
 * could reuse these rules without running it; a second copy would be a second
 * opinion about what a CHANGED is, and the two would drift into a spec one
 * reader accepts and the other refuses.
 *
 * Pure: no file is read here. Callers hand in text.
 */
import { basename } from 'node:path';

// `### REQ-USER-001 — Title`. The separator is optional and may be an em
// dash, a hyphen or a colon: the id is what matters.
export const REQ_HEADING = /^###\s+(REQ-[A-Z0-9-]+-\d{3})\b\s*[—:-]?\s*(.*)$/;

// **Deliberately NOT `\b`-delimited.** Go and pytest build test names out of
// identifiers, which cannot hold spaces or hyphens, so a reported name glues
// the id to its neighbours — `TestAuth/REQ-USER-001_rejects`. `_` is a word
// character, so `\b` fails on both sides and a genuine executed proof reads as
// absent.
//
// The boundaries say what matters instead: not glued to a preceding letter or
// digit (a different token), and not followed by a fourth digit (so
// `REQ-USER-0011` never matches as `REQ-USER-001`).
export const REQ_TAG = /(?<![A-Z0-9])REQ-[A-Z0-9-]+-\d{3}(?!\d)/g;

/**
 * The ids a reported line proves, in canonical (hyphenated) spelling.
 *
 * The line is read TWICE: as reported, and with `_` read as `-`. The second
 * pass is the other half of the premise stated just above, and it is the half
 * that was missed. A language whose test name is an IDENTIFIER cannot spell the
 * id at all — `def test_REQ_CORE_001_...` is the closest a Python function name
 * can come, and Java methods and Rust `fn`s are in the same position. Matching
 * only the hyphenated form made a real, executed, passing test read as "has no
 * test that RAN", which is the exact defect ADR-001 was written to remove,
 * arriving through the spelling instead of through source parsing.
 *
 * Both passes, not the normalized one alone: normalizing first would let
 * `REQ-USER-001_002` read as the single id `REQ-USER-001-002`, since that also
 * ends in three digits. The raw pass keeps answering `REQ-USER-001` there, and
 * the union takes whichever a line genuinely names.
 */
export function idsIn(line) {
  const found = new Set(line.match(REQ_TAG) ?? []);
  for (const id of line.replace(/_/g, '-').match(REQ_TAG) ?? []) found.add(id);
  return found;
}

/** `specs/user-profile.md` -> `REQ-USER-PROFILE-`, so ids cannot drift across files. */
export function expectedPrefix(specFile) {
  return `REQ-${basename(specFile, '.md').toUpperCase()}-`;
}

/** The ids a capability spec declares, one per `### REQ-…` heading. */
export function declaredIds(body) {
  return new Set(
    String(body)
      .split(/\r?\n/)
      .map((l) => REQ_HEADING.exec(l.trim())?.[1])
      .filter(Boolean),
  );
}

/**
 * The capability spec a delta on `id` touches: the file declaring it, else the
 * file its capability names (`REQ-USER-PROFILE-001` is `user-profile.md`'s,
 * never `user.md`'s), else null — a capability with no file yet.
 *
 * @param {string} id
 * @param {{ file: string, ids: Set<string> }[]} specs
 * @returns {string | null}
 */
export function capabilityOf(id, specs) {
  const declaring = specs.find((s) => s.ids.has(id));
  if (declaring) return declaring.file;
  const prefix = `${id.replace(/-\d{3}$/, '')}-`;
  return specs.find((s) => expectedPrefix(s.file) === prefix)?.file ?? null;
}

// `**Status:** SHIPPED 2026-07-30`, on an archived change spec.
export const ARCHIVE_STATUS = /^\*\*Status:\*\*\s+(SHIPPED|REJECTED|SUPERSEDED)\b/m;

// `- CHANGED REQ-USER-001 (wording) — was X, now Y`, inside a change spec's
// `## Requirement deltas` section. The marker is OPTIONAL to this regex and
// required by the check that reads it: matching the line without one is what
// lets the failure quote the line it is complaining about, instead of
// reporting that it found nothing.
const CHANGED_DELTA = /^[-*]\s*CHANGED\s+(REQ-[A-Z0-9-]+-\d{3})(?!\d)[ \t]*(?:\(([a-z]+)\))?.*$/gm;

/** The two edits a CHANGED may legitimately be. Everything else decomposes. */
export const CHANGED_KINDS = ['wording', 'correction'];

/**
 * The body of `## Requirement deltas`, or '' when the spec has no such
 * section.
 *
 * Scoped to that section rather than read over the whole file: a spec's prose
 * is entitled to DISCUSS a changed requirement without DECLARING one, and a
 * check that reads a sentence as a delta fails runs that are correct — which
 * costs more trust than the case it would catch.
 */
export function deltasSection(body) {
  const heading = /^## Requirement deltas\b.*$/m.exec(body);
  if (!heading) return '';
  const after = body.slice(heading.index + heading[0].length);
  const next = after.search(/^## /m);
  return next === -1 ? after : after.slice(0, next);
}

/** Every CHANGED delta a change spec declares, with the kind it claims. */
export function* changedDeltas(body) {
  for (const m of deltasSection(body).matchAll(CHANGED_DELTA)) {
    yield { line: m[0], id: m[1], kind: m[2] ?? null };
  }
}

/** Why one CHANGED line was rejected, in the failure's own voice. */
export function explainKind(kind) {
  if (!kind) return 'does not say which kind of change it is';
  if (kind === 'correction') return 'is marked (correction), which only a `/spec-fix` brief may use';
  return `is marked (${kind}), which is not one of the two kinds a CHANGED may be (${CHANGED_KINDS.join(', ')})`;
}

/**
 * `## Source`, `## Context`, `## Decision`: the proposal's sections. A live
 * `spec.md` that carries one has let the rationale back into the file the
 * planner re-reads on every fresh context.
 */
export const HEAVY_HEADINGS = ['## Source', '## Context', '## Decision'];

// Any delta line, whatever its kind: `- ADDED REQ-USER-004 — ...`.
const DELTA = /^[-*]\s*(ADDED|CHANGED|REMOVED)\s+(REQ-[A-Z0-9-]+-\d{3})(?!\d)/gm;

/** Every delta a change spec declares, as `{ verb, id }`, read from its deltas section only. */
export function* deltas(body) {
  for (const m of deltasSection(body).matchAll(DELTA)) yield { verb: m[1], id: m[2] };
}

/**
 * ADDED ids that are not new: removed by the same spec, or by a change already
 * SHIPPED. Ids are permanent so that retiring one is safe — an old record, an
 * old test name or an archived spec that names a retired id must keep meaning
 * the behaviour that was removed. Giving the id to a new requirement makes
 * every one of them point at two claims, and nothing else in the flow notices.
 *
 * `archivedBodies` are the archived change specs' texts; only SHIPPED ones
 * count, because a REJECTED or SUPERSEDED change removed nothing.
 */
export function reusedIds(body, archivedBodies) {
  const own = [...deltas(body)];
  const retired = new Set(own.filter((d) => d.verb === 'REMOVED').map((d) => d.id));
  for (const archived of archivedBodies) {
    if (!/^\*\*Status:\*\*\s+SHIPPED\b/m.test(archived)) continue;
    for (const d of deltas(archived)) if (d.verb === 'REMOVED') retired.add(d.id);
  }
  return [...new Set(own.filter((d) => d.verb === 'ADDED' && retired.has(d.id)).map((d) => d.id))];
}

/** The section where a spec says what its writer decided without asking. */
export const ASSUMPTIONS_HEADING = '## Assumptions';

/**
 * Why a change spec's assumptions section does not do its job, or '' when it
 * does. `- none` is an answer; a missing section or one with no item is not —
 * neither can be told from a writer that never looked, which is the case the
 * section exists to make visible at sign-off. A fix brief (`## Case`) is
 * exempt: it is triaged against `specs/`, not signed off as a new claim.
 *
 * Read at spec time only (leaving `spec`, the spec-writer's return), never at
 * the gate: it is a sign-off artifact, and a run planned before the section
 * existed must not fail its milestones over it (ADR-030).
 */
export function assumptionsProblem(body) {
  if (/^## Case\b/m.test(body)) return '';
  const heading = new RegExp(`^${ASSUMPTIONS_HEADING}\\b.*$`, 'm').exec(body);
  if (!heading) return `has no \`${ASSUMPTIONS_HEADING}\` section`;
  const after = body.slice(heading.index + heading[0].length);
  const next = after.search(/^## /m);
  const section = next === -1 ? after : after.slice(0, next);
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/m.test(section) ? '' : `has an empty \`${ASSUMPTIONS_HEADING}\` section — write what was assumed, or \`- none\``;
}

/**
 * What makes a requirement a prohibition. One list: the rule below reads
 * these and the spec-writer's contract must name each (ADR-045).
 */
export const PROHIBITION_WORDS = ['cannot', 'must not', 'never', 'only'];

const WORD = `(?:${PROHIBITION_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})`;

// Not in a compound or an identifier (`read-only`, `neverExpires`), not
// `not only`, which adds a claim, and not `the only`, which names one thing.
const PROHIBITION = new RegExp(`(?<![\\w-])(?<!\\b(?:not|the|an)\\s+)${WORD}(?![\\w-])`, 'i');

// Where one claim ends and another begins. Not a bare `and`: it joins the
// object of a single prohibition as often as two claims ("only admins and
// owners may delete").
const CLAUSE_BREAK = new RegExp(
  [
    ';',
    '\\s[—–]\\s',
    '\\s--?\\s',
    ',\\s*(?:and|but|yet|while|whereas)\\b',
    '\\s(?:but|yet|whereas)\\s',
    `(?:,|\\sand)\\s+(?=${WORD}(?![\\w-]))`,
  ].join('|'),
  'i',
);

// A word after one of these, up to the next comma, describes a thing rather
// than forbids one: "returns 404 when the user cannot be found".
const SUBORDINATE = /\b(?:when|whenever|if|unless|once|until|because|since|after|before|where|whether|that|which|who|whom|whose)\b/i;

/** The prohibition word a clause states, or null. */
function prohibitionIn(clause) {
  for (const segment of clause.split(',')) {
    const word = PROHIBITION.exec(segment);
    if (!word) continue;
    const sub = SUBORDINATE.exec(segment);
    if (!sub || sub.index > word.index) return word[0].toLowerCase().replace(/\s+/g, ' ');
  }
  return null;
}

const ADDED_DELTA = /^[-*]\s*ADDED\s+(REQ-[A-Z0-9-]+-\d{3})(?!\d)(.*)$/gm;

/**
 * Every ADDED delta that states a prohibition and another claim on one id,
 * with the word that made it one. Quoted and code text is not read: a message
 * or a flag may hold any of the words.
 */
export function* pairedProhibitions(body) {
  for (const m of deltasSection(body).matchAll(ADDED_DELTA)) {
    const claim = m[2]
      .replace(/^\s*[—–:-]?\s*/, '')
      .replace(/`[^`]*`|"[^"]*"|“[^”]*”/g, ' ');
    const clauses = claim.split(CLAUSE_BREAK).filter((c) => c.trim());
    if (clauses.length < 2) continue;
    const word = clauses.map(prohibitionIn).find(Boolean);
    if (word) yield { line: m[0], id: m[1], word };
  }
}

/**
 * Why a live change spec cannot be built from, one message per problem: the
 * checks spec-trace makes of every live change at the gate. phase-guard makes
 * the same ones when a run leaves `spec`, so a spec that would fail its first
 * gate fails before a planner is spent on it.
 *
 * `hasProposal` says whether `specflow/<slug>/proposal.md` exists;
 * `archivedBodies` are the archived change specs' texts, for the reuse check.
 */
export function liveSpecProblems(slug, body, { hasProposal, archivedBodies }) {
  const problems = [];
  const isFixBrief = /^## Case\b/m.test(body);

  // ---- a CHANGED delta says which kind it is ------------------------------
  //
  // ADDED and REMOVED are both PROVEN by spec-trace: a new id with no test
  // that ran fails, and a test naming an id no spec declares fails. CHANGED
  // is neither, and the asymmetry is invisible because the three read as
  // peers in the template. The id already exists and already has a test, so
  // the binding spec-trace checks is satisfied before the edit and after it,
  // whatever the body now says.
  //
  // The suite covers most of the gap without help: if behaviour really
  // changed, the code changed, and a test asserting the old behaviour goes
  // red. What survives is a CHANGED that WIDENS — "A and B" becomes "A, B and
  // C". Nothing breaks, because nothing that used to pass stopped passing,
  // and C is now claimed by the spec layer and proven by nobody. Declared as
  // ADDED, that same clause fails spec-trace on sight.
  //
  // So the rule routes the unprovable case back into the provable deltas: a
  // behaviour claim that appears, disappears or changes is REMOVED + ADDED —
  // ids are permanent, which is exactly what makes retiring one safe — and
  // CHANGED keeps only the two edits that genuinely move no proof:
  //
  //   (wording)    the requirement means what it meant; the text is clearer.
  //                What MODE=FOLD does when it fixes tense, and the only
  //                delta a pure re-wording run has to declare.
  //   (correction) the requirement was WRONG and is corrected to match
  //                behaviour that already exists and is already proven.
  //                `/spec-fix` case 3, and fix briefs only — the one case
  //                that flow stops for a human on, precisely because a diff
  //                cannot tell it from rewriting the spec to agree with the
  //                bug. The marker records that the human was asked; it does
  //                not stand in for them.
  //
  // What this does NOT do: verify the kind is TRUE. `(wording)` written over a
  // requirement that grew three clauses passes, exactly as a bare CHANGED did.
  // The machine checks that the claim was declared; the reviewer and the
  // sign-off check that it holds. Said here because a check whose reach is
  // overestimated is the same failure as one that is disarmed. See ADR-009.
  //
  // Unconditional, unlike spec-trace's `require_skills_field`, and the difference is
  // the peer test that field's own history turned on: its siblings are
  // checked by the reviewer alone, so enforcing one of them was an asymmetry.
  // This delta's siblings are enforced by spec-trace, on every gate. Leaving CHANGED
  // out is the asymmetry. See ADR-009.
  for (const { line, id, kind } of changedDeltas(body)) {
    if (kind === 'wording') continue;
    if (kind === 'correction' && isFixBrief) continue;

    problems.push(
      `specflow/${slug}/spec.md: "${line.trim()}" ${explainKind(kind)}. ` +
        `CHANGED is the one delta spec-trace cannot prove — ${id} already exists and already has a test, ` +
        `so the spec/test binding passes before the edit and after it, whatever the body now says. ` +
        `If the requirement means exactly what it meant and no test moves, write \`CHANGED ${id} (wording)\`. ` +
        `Otherwise this is not a CHANGED: split it into \`REMOVED ${id}\` plus an \`ADDED\` on a NEW id, ` +
        `which spec-trace proves in both directions. Widening counts — a clause added to an existing ` +
        `requirement is claimed by the spec layer and proven by nobody.`,
    );
  }

  // ---- an ADDED id is new ---------------------------------------------------
  const reused = reusedIds(body, archivedBodies);
  if (reused.length > 0) {
    problems.push(
      `specflow/${slug}/spec.md ADDs ${reused.join(', ')}, which this spec or a shipped change REMOVED. ` +
        `A retired id keeps meaning the behaviour that was removed — in the archive and in any test or record that names it — ` +
        `so a new requirement takes the next unused id in its capability's sequence.`,
    );
  }

  // ---- a prohibition has an id of its own ----------------------------------
  //
  // spec-trace binds an id to a test that ran under its name, so one test of
  // "filters by A and B, never by C" passes while it asserts only A and B: the
  // half that forbids is the half a test of the other half never reaches.
  // Alone on its id, the prohibition keeps the gate red until a test named
  // for it runs. Fix briefs too: a case 1 ADDs exactly as a feature does.
  //
  // What this does NOT do: read grammar. It reads PROHIBITION_WORDS and the
  // punctuation and conjunctions that join clauses, so "does not", "refuses"
  // and "admins can delete and guests cannot" pass, and so does a single
  // clause with "only", which allows as well as forbids. Nor does it check
  // that the test named for the prohibition asserts it; the fold reads that
  // (ADR-020). See ADR-045.
  for (const { line, id, word } of pairedProhibitions(body)) {
    problems.push(
      `specflow/${slug}/spec.md: "${line.trim()}" pairs a prohibition ("${word}") with another claim on one id. ` +
        `spec-trace binds ${id} to any test that ran under its name, so a test of what the requirement allows passes ` +
        `while nothing checks what it forbids. Give the prohibition an ADDED id of its own — "filters by A and B" on one id, ` +
        `"never filters by C" on the next — so the gate stays red until a test named for it runs.`,
    );
  }

  if (isFixBrief) return problems; // exempt from the split below, by design

  const leaked = HEAVY_HEADINGS.filter((h) => new RegExp(`^${h}\\b`, 'm').test(body));
  if (leaked.length > 0) {
    problems.push(
      `specflow/${slug}/spec.md carries ${leaked.join(', ')}. Those belong in specflow/${slug}/proposal.md — the spec says what changes, the proposal says why it was chosen and what was rejected. The planner reads the first on every fresh context; only a human reads the second.`,
    );
  }

  if (!hasProposal) {
    problems.push(
      `specflow/${slug}/ has no proposal.md. A change spec with no recorded reasoning is a decision nobody can audit later — the archive's whole job is answering "was this considered, and what was turned down?".`,
    );
  }

  return problems;
}

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

/** Whether an archived change spec is stamped SHIPPED: its deltas claim to be in `specs/`. */
export const isShipped = (body) => /^\*\*Status:\*\*\s+SHIPPED\b/m.test(body);

// ---- a delta: one grammar ----------------------------------------------------
//
// A delta is one line of the `## Requirement deltas` section: a dash at the
// start, the verb, the id, then its text — `- ADDED REQ-USER-004 — ...`. Every
// reader below takes it from `sectionLines`; a second reading would drift into a
// spec one check binds and another passes.

const VERB = 'ADDED|CHANGED|REMOVED';
const ID = 'REQ-[A-Z0-9-]+-\\d{3}(?!\\d)';
// The verb and the id share the line: a delta wrapped after its verb is two
// lines, and neither reads as one.
const DELTA_LINE = new RegExp(`^[-*][ \\t]*(${VERB})[ \\t]+(${ID})(.*)$`);

/** The two edits a CHANGED may legitimately be. Everything else decomposes. */
export const CHANGED_KINDS = ['wording', 'correction'];

/** `text` with fenced code blanked: an example in a fence declares nothing. */
function withoutFences(text) {
  let fenced = false;
  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^[ \t]*(?:```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

/**
 * The body of `## Requirement deltas`, fenced code blanked, or '' when the
 * spec has no such section.
 *
 * Scoped to that section rather than read over the whole file: a spec's prose
 * is entitled to DISCUSS a changed requirement without DECLARING one, and a
 * check that reads a sentence as a delta fails runs that are correct — which
 * costs more trust than the case it would catch.
 */
export function deltasSection(body) {
  const text = withoutFences(body);
  const heading = /^## Requirement deltas\b.*$/m.exec(text);
  if (!heading) return '';
  const after = text.slice(heading.index + heading[0].length);
  const next = after.search(/^## /m);
  return next === -1 ? after : after.slice(0, next);
}

/** Each line of the deltas section, with the verb, id and text it reads as a delta, if it does. */
function* sectionLines(body) {
  for (const line of deltasSection(body).split('\n')) {
    const m = DELTA_LINE.exec(line);
    yield m ? { line, verb: m[1], id: m[2], rest: m[3] } : { line };
  }
}

/**
 * Every CHANGED delta a change spec declares, with the kind it claims. The
 * kind is optional here and required by the check that reads it: read without
 * one, the failure can quote the line instead of reporting it found nothing.
 */
export function* changedDeltas(body) {
  for (const d of sectionLines(body)) {
    if (d.verb === 'CHANGED') yield { line: d.line, id: d.id, kind: /^[ \t]*\(([a-z]+)\)/.exec(d.rest)?.[1] ?? null };
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

/** Every delta a change spec declares, as `{ verb, id }`, read from its deltas section only. */
export function* deltas(body) {
  for (const d of sectionLines(body)) if (d.verb) yield { verb: d.verb, id: d.id };
}

// A line written as a delta: the verb is its first word — after a list marker,
// a heading's hashes, a table's pipe, a checkbox, a bracket or emphasis — or
// sits in brackets beside an id, `REQ-A-002 (ADDED)`. In capitals the verb
// makes the line a delta whatever follows; in any other case only beside an
// id, since a note may start "Changed".
const LEADS = new RegExp(`^[ \\t]*(?:(?:[-*+]|\\d+[.)]|#{1,6}|\\|)[ \\t]*)?(?:\\[[ xX]\\][ \\t]*)?[[(*_\`]*[ \\t]*(${VERB})\\b`, 'i');
const BESIDE = new RegExp(`${ID}[ \\t]*[[(*_\`|]+[ \\t]*(?:${VERB})\\b`, 'i');
const AN_ID = new RegExp(ID);
const IDS = new RegExp(ID, 'g');
// Between two ids, what makes the second one more of the same delta: a list or
// a range. A dash, a colon or a parenthesis starts the text instead, so
// `REQ-A-001 (REQ-A-004 supersedes it)` is one delta.
const BETWEEN = /^(?:[ \t]*\([a-z]+\))?[ \t]*(?:[,/&+;–-]|\.\.|(?:and|or|to|through)(?![\w-]))[ \t]*$/i;
// `REQ-A-001–003`, `REQ-A-001..003`: a range written with one id.
const RANGE = /^(?:–|\.\.)\d{3}(?!\d)/;

/** The verb a line declares a delta with, or '' when it is not written as one. */
function declared(line) {
  const lead = LEADS.exec(line);
  if (lead && lead[1] === lead[1].toUpperCase()) return lead[1];
  if (!AN_ID.test(line)) return '';
  return (lead?.[1] ?? new RegExp(`(${VERB})\\b`, 'i').exec(line.slice(line.search(BESIDE)))?.[1] ?? '').toUpperCase();
}

/** The ids a line names before its text: the first, and each listed after it. */
function idsBeforeText(line) {
  const found = [...line.matchAll(IDS)];
  const ids = [];
  for (const [i, m] of found.entries()) {
    if (i > 0 && !BETWEEN.test(line.slice(found[i - 1].index + found[i - 1][0].length, m.index))) break;
    ids.push(m[0]);
  }
  return ids;
}

/**
 * Lines of the deltas section written as a delta that `deltas` does not read
 * whole: another spelling of the line, a heading grouping deltas, or a second
 * id before its text. Every check that binds a delta reads `deltas`, so such a
 * line is checked by none of them.
 */
export function* unreadDeltas(body) {
  for (const d of sectionLines(body)) {
    if (!declared(d.line)) continue;
    if (!d.verb) yield { line: d.line, why: 'unread' };
    else if (idsBeforeText(d.line).length > 1 || RANGE.test(d.rest)) yield { line: d.line, why: 'two-ids' };
  }
}

/** Why one line `unreadDeltas` found is refused, in the failure's own voice. */
export function explainUnread({ line, why }) {
  return why === 'two-ids'
    ? `"${line.trim()}" names more than one id before its text, and the engine reads the first alone. One delta per line, so each id is checked.`
    : `"${line.trim()}" reads as a delta, and the engine does not read it as one, so no check binds it. ` +
        'A delta is one line, `- ADDED REQ-<CAP>-0NN — <text>`: a dash at the start, the verb in capitals, then the id. Write it so, or keep the note out of this section.';
}

/**
 * Why the deltas of a change spec are not where every reader looks, or '': a
 * heading spelled another way, or a delta declared outside `## Requirement
 * deltas`, where no check reads it. With `needed`, a spec with no such section
 * is one too: a spec says what it does to `specs/`, `- none` included.
 *
 * Outside the section only a verb in capitals counts, `## ADDED Requirements`
 * or `- ADDED REQ-…`: prose elsewhere may say a requirement was added.
 */
export function deltasSectionProblem(body, { needed }) {
  const text = withoutFences(body);
  const lines = text.split('\n');
  const misspelled = lines.find((l) => /^#{1,6}[ \t]*requirements?[ \t]+deltas?\b/i.test(l) && !/^## Requirement deltas\b/.test(l));
  if (misspelled) {
    return `has "${misspelled.trim()}", and the engine reads deltas under \`## Requirement deltas\` alone, spelled so: no check binds a delta under it. Rename the heading.`;
  }
  const section = deltasSection(body);
  const heading = /^## Requirement deltas\b.*$/m.exec(text);
  const outside = heading ? `${text.slice(0, heading.index)}\n${text.slice(heading.index + heading[0].length + section.length)}` : text;
  const stray = outside.split('\n').find((l) => /^(?:ADDED|CHANGED|REMOVED)$/.test(LEADS.exec(l)?.[1] ?? ''));
  if (stray) {
    return `declares a delta outside \`## Requirement deltas\` ("${stray.trim()}"), where no check reads it. Write each delta in that section, one line each: \`- ADDED REQ-<CAP>-0NN — <text>\`.`;
  }
  if (needed && !heading) return 'has no `## Requirement deltas` section. Write its deltas there, or `- none — <why>` when it has none.';
  return '';
}

/**
 * The ids a change spec retires: each id a REMOVED line names before its
 * text, read as leniently as a line is refused, so an archive written in
 * another spelling still retires what it removed.
 */
export function retiredIds(body) {
  const ids = [];
  for (const { line } of sectionLines(body)) if (declared(line) === 'REMOVED') ids.push(...idsBeforeText(line));
  return ids;
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
  const retired = new Set(retiredIds(body));
  for (const archived of archivedBodies) if (isShipped(archived)) for (const id of retiredIds(archived)) retired.add(id);
  return [...new Set([...deltas(body)].filter((d) => d.verb === 'ADDED' && retired.has(d.id)).map((d) => d.id))];
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

/**
 * Every ADDED delta that states a prohibition and another claim on one id,
 * with the word that made it one. Quoted and code text is not read: a message
 * or a flag may hold any of the words.
 */
export function* pairedProhibitions(body) {
  for (const d of sectionLines(body)) {
    if (d.verb !== 'ADDED') continue;
    const claim = d.rest
      .replace(/^\s*[—–:-]?\s*/, '')
      .replace(/`[^`]*`|"[^"]*"|“[^”]*”/g, ' ');
    const clauses = claim.split(CLAUSE_BREAK).filter((c) => c.trim());
    if (clauses.length < 2) continue;
    const word = clauses.map(prohibitionIn).find(Boolean);
    if (word) yield { line: d.line, id: d.id, word };
  }
}

/**
 * The problem with naming a live change `slug`, or null. The fold moves it to
 * specflow/archive/<slug>/; onto a folder that exists, in any case a
 * case-insensitive filesystem folds together, it lands inside that change,
 * where no archive check reads it.
 *
 * @param {string} slug
 * @param {string[]} archivedSlugs the folder names under `specflow/archive/`
 * @returns {string | null}
 */
export function archiveClash(slug, archivedSlugs) {
  const taken = archivedSlugs.find((a) => a.toLowerCase() === slug.toLowerCase());
  if (!taken) return null;
  return (
    `specflow/${slug}/ has the name of an archived change, specflow/archive/${taken}/. The fold moves a change to specflow/archive/<its name>/, ` +
    `and onto a folder that exists it lands inside that change instead. Give this change a name of its own: rename specflow/${slug}/.`
  );
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

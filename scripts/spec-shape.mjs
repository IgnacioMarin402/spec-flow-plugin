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

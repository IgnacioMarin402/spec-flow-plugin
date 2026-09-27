---
name: engine-comments
description: Decide where a piece of reasoning belongs when writing or editing this engine — an invariant beside the code, a transition in the commit message, or a decision in decisions/. Use when adding a comment or a file header to hooks/, scripts/, commands/ or agents/, when a header has grown past what a reader needs, or when explaining why something changed.
---

# Where reasoning goes in this engine

Before writing a comment, decide which of three things you are writing.

## 1. Invariant — why this line must be this way → beside the code

Read exactly when someone is about to undo it, and whoever changes the line
already has the file open. Write one when the code would look arbitrary, or
improvable, to a competent reader who does not know what it defends against.
Keep it to what they need to not break it — not the story of how it was found.

```js
// AFTER the phase guard: this hook fires on every subagent spawn in every
// repository the user opens, so a check ahead of it would deny unrelated agents.
```

## 2. Transition — what the code used to be → the commit message

"This used to match `it(...)`, then Python arrived" is a commit message that
leaked into the source. Git holds it with the diff attached, and it cannot
drift. **Test:** would the sentence read as history to someone who never saw
the old version? Then it goes in the commit body. Recover one with
`git log -S`, `git log -L` or `git blame -L`.

One narrow exception: when an old shape is a trap someone is likely to
reintroduce, a single line naming it is an invariant —
`// not \b-delimited: Go and pytest glue ids to their neighbours`.

## 3. Decision — why the system has this shape → `decisions/`

Spans files and has refused alternatives, which is why it ends up copied into
several headers and drifting between them. Write it once as a dated record in
`decisions/` and cite it from the code as `see ADR-NNN` (with the record's real
number). `scripts/decisions.mjs` fails on a citation that does not resolve and
on a record nobody cites. A record claims a moment, so it stays true after the
decision is reversed; a reversal writes a new record.

Prose describing how the code works *today* belongs in none of these places.

## Applying it to an existing header

Sort each paragraph into 1, 2 or 3. What is left should say what the file
guarantees, what a reader must not break, and where the rest lives.

Do not chase a comment percentage. Ratio and transition text turn out to be
nearly independent here, which is why a percentage is a poor way to decide
where to look and a worse way to decide when to stop. A file whose comments
are all invariants is finished; a header that opens with what the file *used
to do* is not. `scripts/comment-transitions.mjs` counts transition text.

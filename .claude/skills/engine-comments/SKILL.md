---
name: engine-comments
description: Decide where a piece of reasoning belongs when writing or editing this engine — an invariant beside the code, a transition in the commit message, or a decision in decisions/. Use when adding a comment or a file header to hooks/, scripts/, commands/ or agents/, when a header has grown past what a reader needs, or when explaining why something changed.
---

# Where reasoning goes in this engine

This engine's comments are unusually dense, and that density was earned: the
defects this project exists to close are the ones where a check *looks* armed
and is not, and the only thing standing between a future edit and that failure
is an explanation sitting where the edit happens.

It also went too far. At the time this was written the engine's files ran
around 50% comment, and `spec-trace.mjs` had 61 lines before its first import.
The cause was not "too many comments" — it was three different kinds of
reasoning all defaulting to the same place.

**Before writing a comment, decide which of the three you are writing.**

---

## 1. Invariant — why this line must be this way

Read exactly when someone is about to undo it. This is the kind that earns
co-location: whoever changes the line has already opened the file, and no
separate document reaches them at that moment.

Write it when the code would look arbitrary — or look improvable — to a
competent reader who does not know what it is defending against.

```js
// AFTER the phase guard: this hook fires on every subagent spawn in every
// repository the user opens, so a check ahead of the guard would deny agents
// that have nothing to do with this engine.
```

Keep it to what the reader needs to not break it. An invariant does not need
the story of how it was discovered.

**Stays in the code. Always.**

---

## 2. Transition — what the code used to be, and why it changed

```js
// This used to match `it(...)` call shapes, which meant a pytest proof read
// as absent...
```

This is a commit message that leaked into the source. Git already holds it,
with the diff attached, and unlike a comment it cannot drift from what
actually happened.

**Goes in the commit message.** See `CLAUDE.md` for the three commands that
recover it — `git log -S`, `git log -L`, `git blame -L`.

The test: *would this sentence read as history to someone who never saw the
old version?* If yes, it belongs in the commit.

One exception, and it is narrow: when the old shape is a trap someone is
likely to reintroduce, a single line naming it is an invariant, not history.
`// not `\b`-delimited — Go and pytest glue ids to their neighbours` earns its
place. Three paragraphs on how that was discovered do not.

---

## 3. Decision — why the system has this shape

Spans files. Has alternatives that were considered and refused. Is not about
any one line, which is why it ends up copied into several headers and then
drifts between them.

```
The engine may know a data shape; it may not know a technology.
Proof comes from what the runner reported, not from parsing source.
```

**Goes in `decisions/`,** as a dated record: the question, what was chosen,
what was refused and why.

Then **cite it from the code** — `// see ADR-NNN`, with the record's real
number — rather than restating it.
The citation is what keeps the record honest: `scripts/decisions.mjs` binds the two
directions, so a record nobody references and a reference to a record that
does not exist both fail. (This page writes `ADR-NNN` rather than a real
number on purpose: an example is not a citation, and it would otherwise
satisfy that check while governing nothing.)

### Why this does not rot the way `.spec-flow/skills.md` did

That file was deleted because nothing read it and it claimed a *present state*
— "these are the skills" — which went stale silently.

A decision record makes a different kind of claim: *on this date, for these
reasons, we chose X*. That stays true even after the decision is reversed. A
reversal does not edit the old record; it writes a new one that supersedes it.

This distinction is the whole reason `decisions/` is allowed to exist in a
repo that deleted its last standalone document. Prose describing how the code
works today is still forbidden — that is what the code and its invariants are
for.

---

## Applying this to an existing header

Read it top to bottom and sort each paragraph into 1, 2 or 3. In practice a
long header is mostly 2, some 3, and a short spine of 1.

What is left should answer, in order:

1. What does this file guarantee?
2. What must a reader not break?
3. Where does the rest live? (a `decisions/` citation)

A header that opens with what the file *used to do* is the shape this skill
exists to prevent.

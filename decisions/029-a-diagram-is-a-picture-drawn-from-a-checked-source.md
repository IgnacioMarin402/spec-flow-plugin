# ADR-029 — a diagram is a picture, drawn from a source a check holds it to

**Date:** 2026-10-06 · **Status:** accepted · **Governs:** `scripts/diagrams.mjs`, `diagrams/`, `REFERENCE.md`, `scripts/no-repo-refs.mjs`, `scripts/model-pins.mjs`, `scripts/decisions.mjs`

**Question.** REFERENCE drew its three flowcharts in ```` ```mermaid ```` fences.
What does a reader see?

**Measured.** On github.com, the diagrams. In GitHub's mobile app, the fence
printed as code: the source, cut off at the screen's edge, in place of the
picture.

**Decision.** A diagram is `diagrams/<name>.mmd` and a PNG drawn from it with a
pinned `mermaid-cli`; the doc shows the PNG, which every viewer renders.
`diagrams/rendered.json` records the sha256 of the source each PNG was drawn
from, and `scripts/diagrams.mjs` fails on a source edited without a redraw, on
a picture no doc shows, and on a mermaid fence in a doc a person reads on
GitHub. The sources are scanned and cited like the doc they left.

**Refused.**

- The fence plus the picture: the mobile app shows both, so the source still
  sits under the diagram.
- SVG: its text is measured with the fonts of the machine that drew it and
  drawn with the viewer's, so a label can overflow its box on a phone.
- Drawing in CI: it needs a browser on every leg of the matrix to produce a
  file the hash already proves current.

**Cost.** A redraw needs a Chromium, which `mermaid-cli` fetches on first use,
and the PNGs are binary in the history.

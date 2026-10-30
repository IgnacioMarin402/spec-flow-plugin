#!/usr/bin/env bash
# A change on the cart repo, signed off and planned: `sound` is a plan the
# reviewer should approve; `flawed` drops a delta, names tests by path only,
# omits the Skills field and answers its risk with a verdict.
set -euo pipefail
variant="${1:-}"
case "$variant" in
  sound | flawed) ;;
  *) echo "remove-item-change.sh: want sound or flawed, got '$variant'" >&2; exit 2 ;;
esac
dir=specflow/remove-item
mkdir -p "$dir/milestones"

cat > "$dir/spec.md" <<'MD'
# Spec — remove-item: removing an item from the cart

## User stories
- **US-1** — As a shopper, I remove one unit of an item so the cart matches what I want.
- **US-2** — As a shopper, removing an item I do not have changes nothing.

## Requirement deltas
- ADDED   REQ-CART-004 — removing an item lowers its quantity by one, and drops the line at zero
- ADDED   REQ-CART-005 — removing an item that is not in the cart leaves the cart unchanged

## Non-functional / constraints
- `removeItem` keeps its signature: `removeItem(cart, sku)` returns the cart.

## Assumptions
- none

## Out of scope
- Removing every unit of a line at once.
MD

cat > "$dir/proposal.md" <<'MD'
# Proposal — remove-item: removing an item from the cart

## Source
Shoppers need to take an item back out of the cart.

## Context
`removeItem` in `lib/cart.js` lowers a quantity but keeps a line at zero, and
throws on a sku the cart does not hold: `findIndex` returns -1 and the line it
reads is undefined.

## Decision
- **Chosen:** drop a line at zero, and guard the index, so an absent sku leaves the cart as it was.
- **Rejected: throw a named error** — the caller has nothing to do with it; the cart is already right.
MD

cat > "$dir/plan.md" <<'MD'
# Plan — remove-item

## Approach
Fix `removeItem` in `lib/cart.js` so a line at zero is dropped and an absent sku is a no-op, and prove both deltas in the cart suite.

## Milestones
| Id | Name | Covers | Depends on | Detail |
|----|------|--------|------------|--------|
| M1 | removeItem | US-1, US-2 | none | `milestones/M1.md` |

## Spec AC traceability
US-1 -> M1, US-2 -> M1
MD

if [ "$variant" = sound ]; then
cat > "$dir/milestones/M1.md" <<'MD'
# M1 — removeItem  (covers US-1, US-2)

- Objective: `removeItem` lowers a quantity, drops a line at zero, and ignores an absent sku.
- Skills: none — the change is one function and its tests; this repo ships no skill that applies.
- Files to add/change: `lib/cart.js`, `test/cart.test.js`, `specs/cart.md`
- Steps: write both REQ-named tests first and see them fail; append both requirements to `specs/cart.md`; then drop the line once its quantity reaches zero, and guard the index `findIndex` returns before touching the line.
- Spec deltas:
  - ADDED REQ-CART-004 — removing an item lowers its quantity by one, and drops the line at zero
  - ADDED REQ-CART-005 — removing an item that is not in the cart leaves the cart unchanged
- Tests to add/change: in `test/cart.test.js`, `REQ-CART-004 removing an item lowers its quantity and drops the line at zero`, and `REQ-CART-005 removing an absent item leaves the cart unchanged`.
- What this could break: callers that relied on `removeItem` throwing for an absent sku, or on a line kept at zero; none in this repo (`grep removeItem` finds only the cart module), so nothing outside the deltas.
- Depends on: none
MD
else
cat > "$dir/milestones/M1.md" <<'MD'
# M1 — removeItem  (covers US-1, US-2)

- Objective: make `removeItem` work.
- Files to add/change: `lib/cart.js`
- Steps: fix the function.
- Spec deltas:
  - ADDED REQ-CART-004 — removing an item lowers its quantity by one, and drops the line at zero
- Tests to add/change: `test/cart.test.js`
- What this could break: low risk.
- Depends on: none
MD
fi

git -c user.email=fixture@example.com -c user.name=fixture add -A
git -c user.email=fixture@example.com -c user.name=fixture commit -qm "plan remove-item"

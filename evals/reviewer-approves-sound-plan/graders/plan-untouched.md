---
type: regex
target:
  source: file
  path: specflow/remove-item/milestones/M1.md
pattern: '^# M1 — removeItem  \(covers US-1, US-2\)\n\n- Objective: `removeItem` lowers a quantity, drops a line at zero, and ignores an absent sku\.\n- Skills: none — the change is one function and its tests; this repo ships no skill that applies\.\n- Files to add/change: `lib/cart\.js`, `test/cart\.test\.js`, `specs/cart\.md`\n- Steps: write both REQ-named tests first and see them fail; append both requirements to `specs/cart\.md`; then drop the line once its quantity reaches zero, and guard the index `findIndex` returns before touching the line\.\n- Spec deltas:\n  - ADDED REQ-CART-004 — removing an item lowers its quantity by one, and drops the line at zero\n  - ADDED REQ-CART-005 — removing an item that is not in the cart leaves the cart unchanged\n- Tests to add/change: in `test/cart\.test\.js`, `REQ-CART-004 removing an item lowers its quantity and drops the line at zero`, and `REQ-CART-005 removing an absent item leaves the cart unchanged`\.\n- What this could break: callers that relied on `removeItem` throwing for an absent sku, or on a line kept at zero; none in this repo \(`grep removeItem` finds only the cart module\), so nothing outside the deltas\.\n- Depends on: none\n$'
arm: both
---

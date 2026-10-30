---
type: regex
target:
  source: file
  path: specflow/remove-item/milestones/M1.md
pattern: '^# M1 — removeItem  \(covers US-1, US-2\)\n\n- Objective: make `removeItem` work\.\n- Files to add/change: `lib/cart\.js`\n- Steps: fix the function\.\n- Spec deltas:\n  - ADDED REQ-CART-004 — removing an item lowers its quantity by one, and drops the line at zero\n- Tests to add/change: `test/cart\.test\.js`\n- What this could break: low risk\.\n- Depends on: none\n$'
arm: both
---

---
type: regex
target:
  source: file
  path: specs/cart.md
pattern: '^<!-- spec-scope: lib -->\n\n# Cart\n\n### REQ-CART-001 — adding an item raises its quantity\n\nAdding an item already in the cart raises its quantity by one instead of adding\na second line\.\n\n### REQ-CART-002 — the total sums every line\n\nThe total is the sum, over every line, of its unit price times its quantity\.\n\n### REQ-CART-003 — SAVE10 takes ten percent off\n\nThe code SAVE10 takes ten percent off the total, rounded down to the cent once\nthe lines are summed\.\n$'
weight: 0.4
arm: both
---

---
type: regex
target:
  source: file
  path: lib/cart.js
pattern: 'findIndex\(\(l\) => l\.sku === sku\);\n  cart\[at\]\.qty -= 1;'
arm: both
---

---
type: regex
target:
  source: file
  path: test/cart.test.js
pattern: '^import \{ test \} from ''node:test'';\nimport assert from ''node:assert'';\nimport \{ addItem, total \} from ''\.\./lib/cart\.js'';\n\ntest\(''REQ-CART-001 adding an item twice raises its quantity'', \(\) => \{\n  const cart = addItem\(addItem\(\[\], ''a'', 100\), ''a'', 100\);\n  assert\.equal\(cart\.length, 1\);\n  assert\.equal\(cart\[0\]\.qty, 2\);\n\}\);\n\ntest\(''REQ-CART-002 the total sums every line'', \(\) => \{\n  assert\.equal\(total\(addItem\(addItem\(\[\], ''a'', 100\), ''b'', 250\)\), 350\);\n\}\);\n\ntest\(''REQ-CART-003 SAVE10 takes ten percent off'', \(\) => \{\n  assert\.equal\(total\(addItem\(\[\], ''a'', 1000\), ''SAVE10''\), 900\);\n\}\);\n$'
weight: 0.4
arm: both
---

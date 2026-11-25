---
type: regex
target:
  source: file
  path: adapters/http.js
pattern: '^import \{ addItem \} from ''\.\./lib/cart\.js'';\n\n// Wiring: parses the request body and hands it to the cart\.\nexport function handleAdd\(req, cart\) \{\n  try \{\n    const \{ sku, price \} = JSON\.parse\(req\.body\);\n    return \{ status: 200, body: addItem\(cart, sku, price\) \};\n  \} catch \{\n    return \{ status: 500, body: ''internal error'' \};\n  \}\n\}\n$'
weight: 0.4
arm: both
---

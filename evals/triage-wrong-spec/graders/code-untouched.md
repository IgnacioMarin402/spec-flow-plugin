---
type: regex
target:
  source: file
  path: lib/cart.js
pattern: '^export function addItem\(cart, sku, price\) \{\n  const line = cart\.find\(\(l\) => l\.sku === sku\);\n  if \(line\) line\.qty \+= 1;\n  else cart\.push\(\{ sku, price, qty: 1 \}\);\n  return cart;\n\}\n\nexport function removeItem\(cart, sku\) \{\n  const at = cart\.findIndex\(\(l\) => l\.sku === sku\);\n  cart\[at\]\.qty -= 1;\n  return cart;\n\}\n\n// In cents\.\nexport function total\(cart, code\) \{\n  return cart\.reduce\(\(sum, l\) => \{\n    const price = code === ''SAVE10'' \? Math\.floor\(l\.price \* 0\.9\) : l\.price;\n    return sum \+ price;\n  \}, 0\);\n\}\n$'
weight: 0.4
arm: both
---

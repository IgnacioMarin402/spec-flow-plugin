#!/usr/bin/env bash
# A small cart module adopted by spec-flow: a contract, a capability spec with
# its tests, and code with one bug each triage case can be pointed at.
# `wrong-spec` plants the one defect that lives in the spec: REQ-CART-003
# rounds each line, against the glossary. Only the case that triages it gets
# it, since every triage reads the requirement its report lands on.
set -euo pipefail
variant="${1:-}"
case "$variant" in
  '' | wrong-spec) ;;
  *) echo "cart-repo.sh: want no argument or wrong-spec, got '$variant'" >&2; exit 2 ;;
esac

mkdir -p .spec-flow specs test lib adapters specflow/archive

cat > package.json <<'JSON'
{ "name": "cart", "version": "1.0.0", "type": "module", "scripts": { "test": "node --test", "lint": "node --check" } }
JSON

cat > .spec-flow/config.json <<'JSON'
{
  "contract_version": 1,
  "verify": {
    "scope_globs": ["*.js"],
    "lint": ["node", "--check"],
    "lint_no_fix": ["node", "--check"],
    "test": ["node", "--test", "--test-reporter=junit", "--test-reporter-destination=reports/junit.xml"],
    "test_name": "node --test",
    "lint_name": "node-check",
    "lint_config_hint": "package.json"
  },
  "trace": {
    "specs_dir": "specs",
    "proof_dir": "test",
    "proof_suffix": ".test.js",
    "report": { "format": "junit", "path": "reports/junit.xml" },
    "not_a_capability": ["README.md", "glossary.md"],
    "require_skills_field": false
  }
}
JSON

cat > specs/glossary.md <<'MD'
# Glossary

- **Total** — the amount a customer pays, in cents, rounded once: after every
  line and every discount has been applied, never per line.
MD

cat > specs/cart.md <<'MD'
<!-- spec-scope: lib -->

# Cart

### REQ-CART-001 — adding an item raises its quantity

Adding an item already in the cart raises its quantity by one instead of adding
a second line.

### REQ-CART-002 — the total sums every line

The total is the sum, over every line, of its unit price times its quantity.

### REQ-CART-003 — SAVE10 takes ten percent off

MD
if [ "$variant" = wrong-spec ]; then
cat >> specs/cart.md <<'MD'
The code SAVE10 takes ten percent off each line's price, each line rounded down
to the cent before the lines are summed.
MD
else
cat >> specs/cart.md <<'MD'
The code SAVE10 takes ten percent off the total, rounded down to the cent once
the lines are summed.
MD
fi

cat > lib/cart.js <<'JS'
export function addItem(cart, sku, price) {
  const line = cart.find((l) => l.sku === sku);
  if (line) line.qty += 1;
  else cart.push({ sku, price, qty: 1 });
  return cart;
}

export function removeItem(cart, sku) {
  const at = cart.findIndex((l) => l.sku === sku);
  cart[at].qty -= 1;
  return cart;
}

JS
if [ "$variant" = wrong-spec ]; then
cat >> lib/cart.js <<'JS'
// In cents.
export function total(cart, code) {
  return cart.reduce((sum, l) => {
    const price = code === 'SAVE10' ? Math.floor(l.price * 0.9) : l.price;
    return sum + price;
  }, 0);
}
JS
else
cat >> lib/cart.js <<'JS'
// In cents.
export function total(cart, code) {
  const sum = cart.reduce((acc, l) => acc + l.price, 0);
  return code === 'SAVE10' ? Math.floor(sum * 0.9) : sum;
}
JS
fi

cat > adapters/http.js <<'JS'
import { addItem } from '../lib/cart.js';

// Wiring: parses the request body and hands it to the cart.
export function handleAdd(req, cart) {
  try {
    const { sku, price } = JSON.parse(req.body);
    return { status: 200, body: addItem(cart, sku, price) };
  } catch {
    return { status: 500, body: 'internal error' };
  }
}
JS

cat > test/cart.test.js <<'JS'
import { test } from 'node:test';
import assert from 'node:assert';
import { addItem, total } from '../lib/cart.js';

test('REQ-CART-001 adding an item twice raises its quantity', () => {
  const cart = addItem(addItem([], 'a', 100), 'a', 100);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].qty, 2);
});

test('REQ-CART-002 the total sums every line', () => {
  assert.equal(total(addItem(addItem([], 'a', 100), 'b', 250)), 350);
});

test('REQ-CART-003 SAVE10 takes ten percent off', () => {
  assert.equal(total(addItem([], 'a', 1000), 'SAVE10'), 900);
});
JS

git init -q .
git -c user.email=fixture@example.com -c user.name=fixture add -A
git -c user.email=fixture@example.com -c user.name=fixture commit -qm baseline

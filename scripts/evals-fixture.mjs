#!/usr/bin/env node
/**
 * Behaviour fixture for the eval suite under evals/.
 *
 * An eval run costs a model and minutes, so nobody runs one to find out
 * whether a grader can fail. This builds every case's scaffold the way
 * `claude plugin eval --scaffold` does and holds what can be held without a
 * model:
 *
 *   - every regex grader agrees with the untouched scaffold, and every
 *     `*-untouched` grader is the scaffold's file byte for byte;
 *   - a triage that "fixes it anyway" fails a grader, whichever guarded file
 *     it touches or adds;
 *   - each bug report is true of its scaffold, and the wrong-spec plant lives
 *     in its own case only;
 *   - the sound plan's steps can be followed: both its REQ tests fail first;
 *   - a fixture milestone has the planner template's fields, minus what its
 *     case deliberately leaves out;
 *   - graders copied across the triage cases are still the same copy.
 *
 *   node scripts/evals-fixture.mjs           check
 *   node scripts/evals-fixture.mjs --write   regenerate the `*-untouched` patterns
 *
 * Needs bash, as the harness does to run a scaffold.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, cpSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTemp } from './temp-dir.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EVALS = join(ROOT, 'evals');
const WRITE = process.argv.includes('--write');
const failures = [];

function check(name, fn) {
  try {
    const problem = fn();
    if (problem) failures.push({ name, problem });
  } catch (err) {
    failures.push({ name, problem: `threw: ${err?.stack ?? err}` });
  }
}

// ---- reading a case -------------------------------------------------------

/**
 * The frontmatter subset these graders use: `key: value`, single-quoted
 * strings, and one nested map (`target:`). Anything else throws, so a grader
 * written in a shape this cannot read fails here instead of being skipped.
 */
function frontmatter(text, where) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${where}: no frontmatter`);
  const out = {};
  let nested = null;
  for (const line of m[1].split('\n')) {
    const kv = /^( {2})?([a-z_]+):(?: (.*))?$/.exec(line);
    if (!kv) throw new Error(`${where}: cannot read frontmatter line ${JSON.stringify(line)}`);
    const [, indent, key, raw] = kv;
    const value = raw === undefined ? undefined : scalar(raw);
    if (indent) {
      if (!nested) throw new Error(`${where}: indented "${key}" outside a map`);
      nested[key] = value;
    } else if (value === undefined) {
      nested = out[key] = {};
    } else {
      nested = null;
      out[key] = value;
    }
  }
  return { fm: out, body: m[2] };
}

function scalar(raw) {
  if (raw.startsWith("'")) {
    if (!raw.endsWith("'") || raw.length < 2) throw new Error(`unterminated string ${raw}`);
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function readCases() {
  return readdirSync(EVALS)
    .filter((d) => existsSync(join(EVALS, d, 'case.yaml')))
    .sort()
    .map((name) => {
      const dir = join(EVALS, name);
      const yaml = readFileSync(join(dir, 'case.yaml'), 'utf8');
      const graders = readdirSync(join(dir, 'graders'))
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((file) => {
          const path = join(dir, 'graders', file);
          const text = readFileSync(path, 'utf8');
          return { file, path, text, ...frontmatter(text, relative(ROOT, path)) };
        });
      return {
        name,
        dir,
        triage: /^tags: \[[^\]]*\btriage\b/m.test(yaml),
        scaffold: /scaffold_script: (\S+)/.exec(yaml)?.[1],
        graders,
      };
    });
}

// ---- running a scaffold ---------------------------------------------------

function build(c) {
  const cwd = mkdtempSync(join(tmpdir(), `spec-flow-eval-${c.name}-`));
  const res = spawnSync('bash', [join(c.dir, c.scaffold)], { cwd, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`${c.name}: scaffold exited ${res.status}\n${res.stderr}`);
  return cwd;
}

/** Every file under `dir`, as the harness lists a run directory: `/`-separated, `.git` included. */
function listing(dir, base = dir, out = new Set()) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listing(full, base, out);
    else out.add(relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * A regex grader as the harness scores it. `files` is the run's file diff,
 * which lists the paths the run CREATED — an edit to an existing file never
 * shows there, which is why the guards against an edit read the file itself.
 */
function passes(g, cwd, before) {
  let text;
  if (g.target === 'files') text = [...listing(cwd)].filter((p) => !before.has(p)).sort().join('\n');
  else if (g.target?.source === 'file') {
    const p = join(cwd, g.target.path);
    if (!existsSync(p)) return false;
    text = readFileSync(p, 'utf8');
  } else return null;
  const found = new RegExp(g.pattern, g.flags ?? '').test(text);
  const match = g.match ?? 'contains';
  if (match === 'contains') return found;
  if (match === 'not_contains') return !found;
  throw new Error(`${g.file}: match "${match}" is not handled here`);
}

/** The regex graders this can score without a model, and their verdicts. */
function verdicts(c, cwd, before) {
  return c.graders
    .filter((g) => g.fm.type === 'regex')
    .map((g) => ({ file: g.file, passed: passes(g.fm, cwd, before) }))
    .filter((v) => v.passed !== null);
}

function node(cwd, script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd, encoding: 'utf8' });
}

// ---- exact guards ---------------------------------------------------------

const isGuard = (g) => g.file.endsWith('-untouched.md') && g.fm.target?.source === 'file';

/** A pattern that matches `text` and nothing else. */
function exact(text) {
  return `^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\n')}$`;
}

const quote = (s) => `'${s.replace(/'/g, "''")}'`;

// ---- what each case plants ------------------------------------------------

// Rounding three 3.33 lines: once is 8.99, per line 8.97. Only the wrong-spec
// case may round per line; anywhere else the same plant confounds the triage
// that reads REQ-CART-003 for an unrelated report.
const ROUNDING = "import { addItem, total } from './lib/cart.js'; console.log(total(addItem(addItem(addItem([], 'a', 333), 'b', 333), 'c', 333), 'SAVE10'));";

/** What each triage report says happens, run against its own scaffold. */
const REPORTS = {
  'triage-infra': {
    script: "import { handleAdd } from './adapters/http.js'; console.log(handleAdd({ body: '{' }, []).status);",
    expect: '500',
  },
  'triage-not-a-fix': {
    script: "import { addItem, total } from './lib/cart.js'; console.log(total(addItem([], 'a', 1000), 'SAVE10'));",
    expect: '900',
  },
  'triage-unspecified': {
    script: "import { removeItem } from './lib/cart.js'; try { removeItem([], 'a'); console.log('no throw'); } catch (e) { console.log(e.constructor.name); }",
    expect: 'TypeError',
  },
  'triage-weak-test': {
    script: "import { addItem, total } from './lib/cart.js'; console.log(total(addItem(addItem([], 'a', 100), 'a', 100)));",
    expect: '100',
  },
  'triage-wrong-spec': { script: ROUNDING, expect: '897' },
};

/** Fields a fixture milestone leaves out on purpose, by case. */
const MILESTONE_OMITS = {
  'reviewer-approves-sound-plan': [],
  'reviewer-requests-changes': ['Skills'],
};

/** The milestone template's field labels, read as agent-contracts reads them. */
function templateFields() {
  const planner = readFileSync(join(ROOT, 'agents', 'planner.md'), 'utf8');
  const intro = planner.indexOf('milestones/Mk.md`**');
  const open = planner.indexOf('```', intro);
  const close = planner.indexOf('```', open + 3);
  if (intro === -1 || open === -1 || close === -1) return null;
  return [...planner.slice(open, close).matchAll(/^- ([A-Z][^:\n]*):/gm)].map((m) => m[1]);
}

const fieldsOf = (text) => [...text.matchAll(/^- ([A-Z][^:\n]*):/gm)].map((m) => m[1]);

// The sound plan says "write both REQ-named tests first and see them fail".
const REMOVE_TESTS = {
  'REQ-CART-004': `test('REQ-CART-004 removing an item lowers its quantity and drops the line at zero', () => {
  const cart = addItem(addItem([], 'a', 100), 'a', 100);
  removeItem(cart, 'a');
  assert.equal(cart[0].qty, 1);
  removeItem(cart, 'a');
  assert.equal(cart.length, 0);
});`,
  'REQ-CART-005': `test('REQ-CART-005 removing an absent item leaves the cart unchanged', () => {
  const cart = addItem([], 'a', 100);
  assert.deepEqual(removeItem(cart, 'b'), [{ sku: 'a', price: 100, qty: 1 }]);
});`,
};
const TEST_HEAD = "import { test } from 'node:test';\nimport assert from 'node:assert';\nimport { addItem, removeItem } from '../lib/cart.js';\n\n";
const REMOVE_DONE = `export function removeItem(cart, sku) {
  const at = cart.findIndex((l) => l.sku === sku);
  if (at === -1) return cart;
  cart[at].qty -= 1;
  if (cart[at].qty === 0) cart.splice(at, 1);
  return cart;
}`;

// What a triage told to "fix nothing" might write anyway. Generic edits reach
// every guarded file; the named ones are the fixes each report invites.
const GUARDED = ['lib/cart.js', 'adapters/http.js', 'test/cart.test.js', 'specs/cart.md'];
const EDITS = [
  ...GUARDED.map((file) => ({ name: `a line added to ${file}`, file, edit: (s) => `${s}\n// fixed\n` })),
  {
    name: 'a SyntaxError branch kept beside the 500',
    file: 'adapters/http.js',
    edit: (s) => s.replace('  } catch {\n', "  } catch (e) {\n    if (e instanceof SyntaxError) return { status: 400, body: 'bad request' };\n"),
  },
  { name: 'quantity multiplied into the total', file: 'lib/cart.js', edit: (s) => s.replace('acc + l.price', 'acc + l.price * l.qty').replace('return sum + price;', 'return sum + price * l.qty;') },
  {
    name: 'the missing two-unit case written into the suite',
    file: 'test/cart.test.js',
    edit: (s) => `${s}\ntest('REQ-CART-002 two units of one item', () => {\n  assert.equal(total(addItem(addItem([], 'a', 100), 'a', 100)), 200);\n});\n`,
  },
  { name: 'REQ-CART-002 reworded', file: 'specs/cart.md', edit: (s) => s.replace('times its quantity', 'times its quantity, every unit counted') },
  { name: 'a new test file', file: 'test/total.test.js', edit: () => "import { test } from 'node:test';\n" },
];

// Graders every triage case carries; a copy that drifts grades one case
// differently from the rest. The others are what makes each case itself. A
// guard's pattern is its own scaffold's file, checked above; the rest of it is
// a copy like any other.
const PER_CASE = new Set(['case.md', 'work-order.md']);

// ---- checks ---------------------------------------------------------------

const cases = readCases();
const built = new Map();
try {
  for (const c of cases) {
    if (!c.scaffold) continue;
    let cwd;
    try {
      cwd = build(c);
    } catch (err) {
      failures.push({ name: `${c.name} scaffolds`, problem: String(err.message) });
      continue;
    }
    built.set(c.name, cwd);
  }

  if (WRITE) {
    for (const c of cases) {
      const cwd = built.get(c.name);
      if (!cwd) continue;
      for (const g of c.graders.filter(isGuard)) {
        const pattern = exact(readFileSync(join(cwd, g.fm.target.path), 'utf8'));
        writeFileSync(g.path, g.text.replace(/^pattern: .*$/m, () => `pattern: ${quote(pattern)}`));
      }
    }
  }

  for (const c of WRITE ? readCases() : cases) {
    const cwd = built.get(c.name);
    if (!cwd) continue;
    const before = listing(cwd);

    check(`${c.name}: every regex grader agrees with the untouched scaffold`, () => {
      const wrong = verdicts(c, cwd, before).filter((v) => !v.passed);
      return wrong.length === 0
        ? ''
        : `${wrong.map((v) => v.file).join(', ')} fail(s) before the agent has done anything, so it cannot tell a run that left the repo alone from one that did not.`;
    });

    check(`${c.name}: every *-untouched grader is its file byte for byte`, () => {
      const loose = c.graders.filter(isGuard).filter((g) => g.fm.pattern !== exact(readFileSync(join(cwd, g.fm.target.path), 'utf8')));
      return loose.length === 0
        ? ''
        : `${loose.map((g) => g.file).join(', ')} accept(s) more than the scaffold's file, so an edit that keeps the matched part passes. Run \`node scripts/evals-fixture.mjs --write\` after changing a fixture.`;
    });

    check(`${c.name}: every file_exists grader states what it expects`, () => {
      const implicit = c.graders.filter((g) => g.fm.type === 'file_exists' && typeof g.fm.exists !== 'boolean');
      return implicit.length === 0 ? '' : `${implicit.map((g) => g.file).join(', ')} rely on the default \`exists\`.`;
    });

    if (c.triage) {
      for (const e of EDITS) {
        check(`${c.name}: ${e.name} fails a grader`, () => {
          const copy = mkdtempSync(join(tmpdir(), 'spec-flow-eval-edit-'));
          try {
            cpSync(cwd, copy, { recursive: true });
            const p = join(copy, e.file);
            const was = existsSync(p) ? readFileSync(p, 'utf8') : '';
            const now = e.edit(was);
            if (now === was) return `the edit changed nothing in ${e.file}; it no longer fits the fixture.`;
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, now);
            return verdicts(c, copy, before).some((v) => !v.passed)
              ? ''
              : `every grader still passes after ${e.name}, so a triage that did it scores as one that fixed nothing.`;
          } finally {
            removeTemp(copy);
          }
        });
      }
    }

    if (c.triage || c.name in MILESTONE_OMITS) {
      check(`${c.name}: only the wrong-spec case rounds per line`, () => {
        const res = node(cwd, ROUNDING);
        const want = c.name === 'triage-wrong-spec' ? '897' : '899';
        return res.stdout.trim() === want ? '' : `three 3.33 lines with SAVE10 total ${res.stdout.trim() || res.stderr} here, where ${want} was expected.`;
      });
    }

    if (REPORTS[c.name]) {
      check(`${c.name}: the bug report is true of its scaffold`, () => {
        const res = node(cwd, REPORTS[c.name].script);
        return res.stdout.trim() === REPORTS[c.name].expect
          ? ''
          : `expected ${REPORTS[c.name].expect}, got ${res.stdout.trim() || res.stderr}.`;
      });
    } else if (c.triage) {
      failures.push({ name: `${c.name}: has a report probe`, problem: 'add it to REPORTS, so its plant is checked like the others.' });
    }

    if (c.name in MILESTONE_OMITS) {
      check(`${c.name}: the fixture milestone has the planner template's fields`, () => {
        const template = templateFields();
        if (!template) return 'the milestone template could not be found in agents/planner.md.';
        const want = template.filter((f) => !MILESTONE_OMITS[c.name].includes(f));
        const got = fieldsOf(readFileSync(join(cwd, 'specflow/remove-item/milestones/M1.md'), 'utf8'));
        return JSON.stringify(got) === JSON.stringify(want) ? '' : `M1.md has ${JSON.stringify(got)}, the template less what this case omits is ${JSON.stringify(want)}.`;
      });
    }

    if (c.name === 'reviewer-approves-sound-plan') {
      check(`${c.name}: each REQ test the plan names fails first, and passes once built`, () => {
        const problems = [];
        const run = (id) => {
          writeFileSync(join(cwd, 'test', 'remove.test.js'), TEST_HEAD + REMOVE_TESTS[id]);
          return spawnSync(process.execPath, ['--test', 'test/remove.test.js'], { cwd, encoding: 'utf8' }).status;
        };
        for (const id of Object.keys(REMOVE_TESTS)) if (run(id) === 0) problems.push(`${id} passes before removeItem changes, so "see them fail" cannot be followed`);
        const lib = join(cwd, 'lib', 'cart.js');
        writeFileSync(lib, readFileSync(lib, 'utf8').replace(/export function removeItem[\s\S]*?\n}/, REMOVE_DONE));
        for (const id of Object.keys(REMOVE_TESTS)) if (run(id) !== 0) problems.push(`${id} still fails once removeItem is built, so it fails for some other reason`);
        return problems.join('; ');
      });
    }
  }

  const triage = cases.filter((c) => c.triage);
  check('graders copied across the triage cases are the same copy', () => {
    const problems = [];
    const names = new Set(triage.flatMap((c) => c.graders.map((g) => g.file)));
    for (const file of names) {
      if (PER_CASE.has(file)) continue;
      const missing = triage.filter((c) => !existsSync(join(c.dir, 'graders', file)));
      if (missing.length > 0) {
        problems.push(`${file} is missing from ${missing.map((c) => c.name).join(', ')}`);
        continue;
      }
      const texts = triage.map((c) => {
        const g = c.graders.find((x) => x.file === file);
        return { c: c.name, text: isGuard(g) ? g.text.replace(/^pattern: .*$/m, '') : g.text };
      });
      if (new Set(texts.map((t) => t.text)).size > 1) problems.push(`${file} differs between ${texts.map((t) => t.c).join(', ')}`);
    }
    return problems.join('; ');
  });

  check('every fixture.sh is executable in the index', () => {
    const res = spawnSync('git', ['ls-files', '-s', '--', 'evals'], { cwd: ROOT, encoding: 'utf8' });
    const loose = res.stdout.split('\n').filter((l) => /\/fixture\.sh$/.test(l) && !l.startsWith('100755'));
    return loose.length === 0 ? '' : loose.map((l) => l.split('\t')[1]).join(', ');
  });

  check('npm run evals keeps its report local', () => {
    const script = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts.evals;
    // Publishing is the CLI's default; a local run says so.
    return script.includes('--no-publish') ? '' : `"${script}" publishes every run's report, prompts and transcripts included, to claude.ai.`;
  });
} finally {
  for (const cwd of built.values()) removeTemp(cwd);
}

if (failures.length > 0) {
  console.error(`evals: ${failures.length} case(s) failed.\n`);
  for (const f of failures) console.error(`  - ${f.name}\n    ${f.problem}\n`);
  process.exit(1);
}
console.log(`evals: OK — ${built.size} scaffold(s) hold what their graders claim.`);

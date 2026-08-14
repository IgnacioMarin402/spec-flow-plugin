#!/usr/bin/env node
/**
 * Behaviour fixture for scripts/init.mjs.
 *
 * This is the reason `init` replaced a worked example file. An example is a
 * static artifact nothing executes: when the contract gains a required field
 * or renames one, the example keeps reading as authoritative while being
 * wrong, and the first person to notice is an adopter whose gate will not
 * start. A generator can be held to the claim it makes — that what it writes
 * VALIDATES, through the same reader every hook uses — so the same contract
 * change turns this red instead.
 *
 * Every case builds a throwaway repo, runs the real CLI against it, and reads
 * back the file it produced.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INIT = join(ROOT, 'scripts', 'init.mjs');
const failures = [];

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('node', [INIT, ...args], { cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function check(name, fn) {
  try {
    const problem = await fn();
    if (problem) failures.push(`${name}\n    ${problem}`);
  } catch (err) {
    failures.push(`${name}\n    threw: ${err.message}`);
  }
}

/**
 * A throwaway repo. `scripts` goes into package.json verbatim, `files` is a
 * map of repo-relative path to contents, and `bins` are the entries faked
 * under node_modules/.bin so `init` prefers the local binary path the way it
 * would in a real install.
 */
function repo({ scripts = {}, files = {}, bins = [], gitignore = null, existingConfig = null, git = true }) {
  const dir = mkdtempSync(join(tmpdir(), 'spec-flow-init-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts }, null, 2));

  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  }
  for (const bin of bins) {
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', bin), '');
  }
  if (gitignore !== null) writeFileSync(join(dir, '.gitignore'), gitignore);
  if (existingConfig !== null) {
    mkdirSync(join(dir, '.spec-flow'), { recursive: true });
    writeFileSync(join(dir, '.spec-flow', 'config.json'), existingConfig);
  }

  // A real repo with a real base branch, because that is what the engine
  // supports — `git` is in the README's requirements, and scope is a
  // merge-base diff. A fixture repo without one would put `base_ref` in the
  // MISSING bucket on every case, which is a property of the fixture rather
  // than of anything init does.
  if (git) {
    const run = (...args) => spawnSync('git', args, { cwd: dir, stdio: 'ignore' });
    run('init', '-q', '.');
    run('symbolic-ref', 'HEAD', 'refs/heads/main');
    run('config', 'user.email', 'fixture@example.com');
    run('config', 'user.name', 'fixture');
    run('add', '-A');
    run('commit', '-qm', 'baseline');
  }

  return dir;
}

const readContract = (dir) => JSON.parse(readFileSync(join(dir, '.spec-flow', 'config.json'), 'utf8'));

async function withRepo(opts, assert) {
  const dir = repo(opts);
  try {
    return await assert(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A repo with everything discoverable: scripts, local bins, a lint config, tests in their own directory. */
const COMPLETE = {
  scripts: { test: 'vitest run', lint: 'eslint .', 'lint:fix': 'eslint . --fix' },
  bins: ['vitest', 'eslint'],
  files: {
    'eslint.config.js': '',
    'lib/a.ts': 'export const a = 1;\n',
    'lib/b.ts': 'export const b = 2;\n',
    'lib/c.ts': 'export const c = 3;\n',
    'test/a.test.ts': 'it("a", () => {});\n',
    'test/b.test.ts': 'it("b", () => {});\n',
  },
};

await Promise.all([
  // ---- the claim this file exists to hold ----
  check('what init writes validates through the same reader the hooks use', () =>
    withRepo(COMPLETE, async (dir) => {
      const res = await run([], dir);
      if (res.status !== 0) return `init exited ${res.status} on a fully discoverable repo: ${res.stdout} ${res.stderr}`;
      if (!/The contract is valid/.test(res.stdout)) {
        return `init wrote a contract it could not validate — an adopter's gate would refuse to start. stdout: ${res.stdout}`;
      }
      return null;
    }),
  ),

  check('it reads the runner and linter out of the repo\'s own scripts', () =>
    withRepo(COMPLETE, async (dir) => {
      await run([], dir);
      const c = readContract(dir);
      if (c.verify.test_name !== 'vitest') return `test_name is "${c.verify.test_name}", not the binary the test script names`;
      if (!c.verify.test.join(' ').includes('vitest')) return `verify.test does not invoke the declared runner: ${c.verify.test.join(' ')}`;
      if (!c.verify.test.includes('run')) return `verify.test dropped the script's own arguments: ${c.verify.test.join(' ')}`;
      if (c.verify.lint_name !== 'eslint') return `lint_name is "${c.verify.lint_name}"`;
      if (c.verify.lint.join(' ') === c.verify.lint_no_fix.join(' ')) {
        return 'lint and lint_no_fix are identical even though the repo declares a separate autofix script';
      }
      return null;
    }),
  ),

  check('it prefers the locally installed binary over a bare command name', () =>
    withRepo(COMPLETE, async (dir) => {
      await run([], dir);
      const c = readContract(dir);
      if (!c.verify.test[1]?.includes(join('node_modules', '.bin'))) {
        return `verify.test does not point at the local binary: ${c.verify.test.join(' ')}`;
      }
      return null;
    }),
  ),

  check('it finds the proof surface when tests live in their own directory', () =>
    withRepo(COMPLETE, async (dir) => {
      await run([], dir);
      const c = readContract(dir);
      if (c.trace.proof_dir !== 'test') return `proof_dir is "${c.trace.proof_dir}", not the directory the tests are in`;
      if (c.trace.proof_suffix !== '.test.ts') return `proof_suffix is "${c.trace.proof_suffix}"`;
      return null;
    }),
  ),

  // ---- the target a lint script carries must not reach the contract ----
  //
  // `verify.lint` receives the changed files APPENDED, so a script written as
  // `eslint .` becomes `eslint . <changed-file>` — the whole repo plus the
  // file. That is not a slow lint but a disarmed one: lint scoping exists so
  // a milestone is never blocked by pre-existing debt in files it never
  // touched, and one stray `.` puts every one of those files back in front of
  // the gate. init generated exactly that argv until this case existed.
  check('a lint script\'s target is dropped, so appending a file cannot widen the scope', () =>
    withRepo(COMPLETE, async (dir) => {
      await run([], dir);
      const c = readContract(dir);
      for (const [field, argv] of [['lint', c.verify.lint], ['lint_no_fix', c.verify.lint_no_fix]]) {
        if (argv.includes('.')) {
          return `verify.${field} is ${JSON.stringify(argv)} — with a file appended that lints the whole repo, which silently undoes lint scoping`;
        }
      }
      if (!c.verify.lint.includes('--fix')) return `the autofix flag was dropped along with the target: ${c.verify.lint.join(' ')}`;
      return null;
    }),
  ),

  check('dropping a target is reported, never silent', () =>
    withRepo(COMPLETE, async (dir) => {
      const res = await run([], dir);
      if (!/REVIEW.*verify\.lint dropped/s.test(res.stdout)) {
        return `init changed the linter invocation without saying so: ${res.stdout}`;
      }
      return null;
    }),
  ),

  check('a flag\'s value that looks like a path is not mistaken for a target', () =>
    withRepo(
      { ...COMPLETE, scripts: { test: 'vitest run', lint: 'eslint --ignore-path .gitignore --ext .ts' } },
      async (dir) => {
        await run([], dir);
        const c = readContract(dir);
        for (const token of ['--ignore-path', '.gitignore', '--ext', '.ts']) {
          if (!c.verify.lint_no_fix.includes(token)) {
            return `"${token}" was stripped out of a flag pair: ${c.verify.lint_no_fix.join(' ')}`;
          }
        }
        return null;
      },
    ),
  ),

  // ---- the honesty rule: an inference is offered for review, never as a reading ----
  check('colocated tests yield a REVIEW line, not a silent guess', () =>
    withRepo(
      {
        ...COMPLETE,
        files: {
          'eslint.config.js': '',
          'lib/a.ts': 'export const a = 1;\n',
          'lib/b.ts': 'export const b = 2;\n',
          'lib/c.ts': 'export const c = 3;\n',
          'lib/a.test.ts': 'it("a", () => {});\n',
          'lib/b.test.ts': 'it("b", () => {});\n',
        },
      },
      async (dir) => {
        const res = await run([], dir);
        if (!/REVIEW/.test(res.stdout)) {
          return `no segment identifies a test in this repo, yet init presented proof_dir as settled. stdout: ${res.stdout}`;
        }
        if (!/proof_dir/.test(res.stdout)) return `the REVIEW line does not name the field it is about: ${res.stdout}`;
        return null;
      },
    ),
  ),

  // ---- the rule from spec-flow-config.mjs's header, enforced here ----
  check('an undetectable runner is left empty and reported, never defaulted', () =>
    withRepo({ ...COMPLETE, scripts: { lint: 'eslint .' }, bins: ['eslint'] }, async (dir) => {
      const res = await run([], dir);
      const c = readContract(dir);
      if (c.verify.test.length > 0) {
        return `init invented a test command for a repo that declares none: ${c.verify.test.join(' ')}. A plausible wrong default runs; a missing one is reported.`;
      }
      if (!/MISSING/.test(res.stdout)) return `nothing told the human the runner is missing: ${res.stdout}`;
      if (res.status === 0) return 'init exited 0 having written a contract that cannot validate';
      return null;
    }),
  ),

  check('a compound test script is left to the human rather than half-parsed', () =>
    withRepo({ ...COMPLETE, scripts: { test: 'npm run build && vitest run', lint: 'eslint .' } }, async (dir) => {
      await run([], dir);
      const c = readContract(dir);
      if (c.verify.test.length > 0) {
        return `init took one half of a chained script as the whole test command: ${c.verify.test.join(' ')}`;
      }
      return null;
    }),
  ),

  // ---- an interpreter is not a runner ----
  //
  // Found by running init against a real repo, not by this fixture: a test
  // script of `node <a-script>` yielded `test_name: "node"`, which lands in
  // `unscoped_denied.tools` — where it denies EVERY node invocation while
  // implementing — and in `run-trace`, which matches the name against Bash
  // commands to spot a test run. The argv is fine; only the name is
  // undeterminable, so it has to be reported rather than filled.
  check('an interpreter is never taken as the runner name', () =>
    withRepo({ ...COMPLETE, scripts: { test: 'node run-my-tests.mjs', lint: 'eslint .' } }, async (dir) => {
      const res = await run([], dir);
      const c = readContract(dir);
      if (c.verify.test_name === 'node') {
        return 'test_name is "node" — that denies every node command while implementing and matches every Bash line in the run trace';
      }
      if (c.unscoped_denied.tools.includes('node')) return `"node" reached unscoped_denied.tools: ${c.unscoped_denied.tools.join(', ')}`;
      if (c.verify.test.join(' ') !== 'node run-my-tests.mjs') return `the argv itself should still be correct, got: ${c.verify.test.join(' ')}`;
      if (!/MISSING.*test_name/s.test(res.stdout)) return `nothing reported test_name as needing a human: ${res.stdout}`;
      return null;
    }),
  ),

  check('a runtime that really is the runner keeps its name', () =>
    withRepo({ ...COMPLETE, scripts: { test: 'bun test', lint: 'eslint .' } }, async (dir) => {
      await run([], dir);
      const c = readContract(dir);
      if (c.verify.test_name !== 'bun') return `test_name is "${c.verify.test_name}" — here the runtime IS the runner`;
      return null;
    }),
  ),

  // A base it cannot resolve is reported and blocks the exit code, even
  // though the READER treats base_ref as optional. The two disagree on
  // purpose: most repos resolve a base without the field, so requiring it in
  // `validate()` would be wrong — but when resolution fails here it will fail
  // at the first gate too, and the gate blocks. Reporting "valid" over that
  // would be a half-truth.
  check('an unresolvable base is reported and holds the exit code, though the reader allows it', () =>
    withRepo({ ...COMPLETE, git: false }, async (dir) => {
      const res = await run([], dir);
      if (!/MISSING.*base_ref/s.test(res.stdout)) return `base_ref was not reported as missing: ${res.stdout}`;
      if (res.status === 0) return 'init exited 0 over a base the first gate will refuse to resolve';
      return null;
    }),
  ),

  // ---- the CLI is how anyone actually reaches this ----
  //
  // Every case above invokes scripts/init.mjs directly, and that is not how a
  // consuming repo runs it: `spec-flow init` goes through bin/spec-flow.mjs,
  // which imports the target module. `init.mjs` guards its CLI section with
  // `fileURLToPath(import.meta.url) === process.argv[1]`, and the dispatcher
  // used to leave argv[1] pointing at ITSELF — so the guard was false, the
  // module imported cleanly, nothing ran, and the process exited 0. A
  // documented command that silently does nothing. Direct-invocation cases
  // cannot see that, which is the whole reason this one exists.
  check('`spec-flow init` through the CLI actually writes the contract', () =>
    withRepo(COMPLETE, async (dir) => {
      const res = await new Promise((resolve) => {
        const child = spawn('node', [join(ROOT, 'bin', 'spec-flow.mjs'), 'init'], {
          cwd: dir,
          env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
        });
        let stdout = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => (stdout += d));
        child.on('close', (status) => resolve({ status, stdout }));
      });
      if (!existsSync(join(dir, '.spec-flow', 'config.json'))) {
        return `the CLI exited ${res.status} and wrote nothing — the dispatcher is not reaching the script's CLI section. stdout: ${JSON.stringify(res.stdout)}`;
      }
      return null;
    }),
  ),

  // ---- scaffolding ----
  check('it creates the directories and the gitignore line', () =>
    withRepo(COMPLETE, async (dir) => {
      await run([], dir);
      for (const path of ['specs', join('specflow', 'archive')]) {
        if (!existsSync(join(dir, path))) return `${path} was not created`;
      }
      const ignore = readFileSync(join(dir, '.gitignore'), 'utf8');
      if (!ignore.split('\n').some((l) => l.trim() === '.claude/state/')) {
        return `.claude/state/ is not gitignored, so the gate's quiescence guard will skip every run after the first: ${JSON.stringify(ignore)}`;
      }
      return null;
    }),
  ),

  check('it does not duplicate a gitignore line the repo already has', () =>
    withRepo({ ...COMPLETE, gitignore: 'node_modules/\n.claude/state/\n' }, async (dir) => {
      await run([], dir);
      const lines = readFileSync(join(dir, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() === '.claude/state/');
      if (lines.length !== 1) return `expected exactly one .claude/state/ line, found ${lines.length}`;
      return null;
    }),
  ),

  // ---- never destroy a contract a human has already tuned ----
  check('an existing contract is never overwritten without --force', () =>
    withRepo({ ...COMPLETE, existingConfig: '{"mine":true}' }, async (dir) => {
      const res = await run([], dir);
      if (readContract(dir).mine !== true) return 'init overwrote a contract that was already there';
      if (res.status !== 0) return `init failed instead of declining politely: ${res.stdout}`;
      if (!/--force/.test(res.stdout)) return `it did not say how to overwrite on purpose: ${res.stdout}`;
      return null;
    }),
  ),

  check('--force overwrites it', () =>
    withRepo({ ...COMPLETE, existingConfig: '{"mine":true}' }, async (dir) => {
      await run(['--force'], dir);
      if (readContract(dir).mine === true) return '--force left the old contract in place';
      return null;
    }),
  ),

  // ---- a repo with nothing to read still gets a starting point ----
  check('a repo with no package.json still gets a file and a full MISSING list', () =>
    withRepo({ scripts: {}, files: {} }, async (dir) => {
      rmSync(join(dir, 'package.json'));
      const res = await run([], dir);
      if (!existsSync(join(dir, '.spec-flow', 'config.json'))) return 'no contract was written at all';
      if (res.status === 0) return 'init reported success for a contract with every required field empty';
      if (!/MISSING/.test(res.stdout)) return `nothing named the fields a human has to fill: ${res.stdout}`;
      return null;
    }),
  ),
]);

if (failures.length > 0) {
  console.error(`init-fixture: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.error(`  ✕ ${f}\n`);
  process.exit(1);
}

console.log('init-fixture: OK — what init writes validates, and what it cannot read it reports instead of inventing.');

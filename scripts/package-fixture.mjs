#!/usr/bin/env node
/**
 * The distribution works, checked by installing it the way it ships.
 *
 * This repository is the only distribution unit (ADR-016): nothing is
 * published to a registry, and a consuming repo's terminal and CI reach the
 * engine through a git spec — `npm install --save-dev github:<owner>/<repo>`.
 * npm clones that repo and packs it, and packing is the only place the `files`
 * allowlist in package.json is evaluated. Everything else here runs against
 * the working tree, where every file is present whether or not it ships. So a
 * module dropped from the allowlist breaks nothing in this repo, passes every
 * other check, and fails on the first `spec-flow init` in somebody's project —
 * the failure this whole engine is organised against, moved into the
 * distribution.
 *
 * So: clone this repo, install the clone into a throwaway repo through a git
 * spec, and drive the documented CLI route through the installed bin.
 * `spec-flow` is the name of the binary, not of the package (that name is taken
 * on npm by an unrelated project), and this is where that distinction is
 * exercised rather than assumed.
 *
 * A clone carries what is COMMITTED and nothing else, which is exactly what a
 * git install can reach. A file that exists in your working tree but not in
 * HEAD failing here is this check working, not a false alarm.
 *
 *   node scripts/package-fixture.mjs
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLocalBin } from './argv.mjs';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

const check = (name, problem) => {
  if (problem) failures.push(`${name}\n    ${problem}`);
};

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

/**
 * How to invoke npm without going through a shell.
 *
 * On POSIX `npm` is on PATH and spawns directly. On Windows it is `npm.cmd`,
 * and neither spelling reaches it: the bare name is ENOENT, because
 * `spawnSync` consults PATHEXT only under a shell, and the explicit `.cmd` is
 * EINVAL, because Node refuses to spawn a batch file unshelled (the
 * CVE-2024-27980 mitigation). Both verified on this platform, not inferred.
 *
 * `shell: true` is the third spelling and the wrong trade. It works, and it
 * concatenates the arguments rather than escaping them — Node deprecates it
 * for exactly that (DEP0190) — while every path here comes out of `mkdtemp`,
 * under a home directory that is allowed to contain a space.
 *
 * So on Windows this runs npm's own JavaScript entrypoint under `node`, which
 * needs no shell and no quoting. npm sets `npm_execpath` for the scripts it
 * runs, so it is present whenever this fixture is reached the documented way.
 */
const NPM = process.platform !== 'win32'
  ? ['npm']
  : process.env.npm_execpath?.endsWith('.js')
    ? [process.execPath, process.env.npm_execpath]
    : null;

/** npm, or a synthetic failure that says why rather than an unexplained empty result. */
function npm(args, opts) {
  if (!NPM) {
    return {
      status: 1,
      stdout: '',
      stderr:
        'npm could not be invoked without a shell on this platform. Run this through `npm run pack:check`, which sets npm_execpath.',
      error: null,
    };
  }
  return spawnSync(NPM[0], [...NPM.slice(1), ...args], opts);
}

/** What a spawn actually did, including the failures that leave stdout and stderr undefined. */
const why = (res) =>
  res.error ? `${/** @type {NodeJS.ErrnoException} */ (res.error).code ?? res.error.message}` : `${res.stdout ?? ''}${res.stderr ?? ''}`;

/**
 * The installed binary, run the way a consuming repo's scripts run it.
 *
 * Resolved past `node_modules/.bin`, for the reason ADR-011 gives: that name
 * is a symlink to JavaScript on POSIX and a `#!/bin/sh` script on Windows, so
 * handing it to `node` runs the CLI on one platform and dies parsing it on the
 * other. This is the same resolution the contract goes through, against a real
 * npm install rather than a fabricated one.
 */
function cli(cwd, sub, args = []) {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  const entrypoint = resolveLocalBin(cwd, 'spec-flow');
  return spawnSync(process.execPath, [join(cwd, entrypoint ?? join('node_modules', '.bin', 'spec-flow')), sub, ...args], {
    cwd,
    env,
    encoding: 'utf8',
  });
}

const work = mkdtempSync(join(tmpdir(), 'spec-flow-pack-'));

/**
 * Returns early instead of throwing when a step leaves nothing for the next
 * one to look at. A stack trace here would exit non-zero, which looks like a
 * pass of the failure report and is not one: the case that actually failed is
 * already in `failures`, and every case after it is simply unrun. Reporting
 * both is the difference between "the packaged CLI wrote no contract" and a
 * line number in this file.
 */
async function run() {
  // ---- the engine, as the git source a consumer installs from --------------
  // `--no-hardlinks` because the clone is deleted at the end of this run and
  // its objects would otherwise be shared with this repository's own.
  const clone = join(work, 'engine.git');
  const cloned = git(work, 'clone', '--quiet', '--no-hardlinks', ENGINE, clone);
  check('the engine clones', cloned.status === 0 ? null : `git clone of the engine failed:\n${why(cloned)}`);
  if (cloned.status !== 0) return;

  // `pathToFileURL` rather than string concatenation: a Windows path is not a
  // URL, and npm reads the `C:` of a hand-spelled `git+file://C:\...` as a
  // host. This is the one conversion that holds on both platforms.
  const spec = `git+${pathToFileURL(clone).href}`;

  // ---- a repo that consumes it --------------------------------------------
  const repo = join(work, 'consumer');
  mkdirSync(join(repo, 'lib'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify(
      {
        name: 'consumer',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node --test', lint: 'node -e "process.exit(0)"' },
      },
      null,
      2,
    )}\n`,
  );
  for (const name of ['a', 'b', 'c', 'd', 'e']) {
    writeFileSync(join(repo, 'lib', `${name}.js`), `export const ${name} = () => '${name}';\n`);
  }
  writeFileSync(
    join(repo, 'test', 'core.test.js'),
    "import { test } from 'node:test';\n\ntest('REQ-CORE-001 it holds', () => {});\n",
  );
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');

  git(repo, 'init', '-q', '.');
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(repo, 'config', 'user.email', 'pack@fixture.test');
  git(repo, 'config', 'user.name', 'package-fixture');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'baseline');

  const install = npm(['install', '--no-audit', '--no-fund', '--save-dev', spec], {
    cwd: repo,
    encoding: 'utf8',
  });
  check(
    'the engine installs as a devDependency from a git spec',
    install.status === 0 ? null : `npm install from ${spec} failed:\n${why(install)}`,
  );

  // The bin name and the package name differ on purpose. If this is ever
  // missing, `npx spec-flow` in a consuming repo reaches PAST the install to
  // an unrelated package of that name on the registry, which is a far worse
  // failure than a missing file — it runs somebody else's code.
  // The listing is guarded because the directory is absent, not empty, when
  // the install failed outright — and a `readdirSync` throwing here would exit
  // non-zero through a stack trace, which this file's `run` exists to avoid:
  // the install's own message is already in `failures` and would never print.
  const bin = join(repo, 'node_modules', '.bin');
  check(
    'the package installs a `spec-flow` binary',
    existsSync(join(bin, 'spec-flow'))
      ? null
      : `no spec-flow bin was linked: ${existsSync(bin) ? readdirSync(bin).join(', ') : 'node_modules/.bin does not exist'}`,
  );

  // ---- the documented route, through the installed bin ---------------------
  const init = cli(repo, 'init');
  const initOut = `${init.stdout}${init.stderr}`;
  const contractPath = join(repo, '.spec-flow', 'config.json');

  check(
    'spec-flow init runs from the installed package',
    existsSync(contractPath) ? null : `no contract was written by the installed CLI:\n${initOut}`,
  );
  if (!existsSync(contractPath)) return;

  const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
  check(
    'the packaged init still appends the reporter flag',
    contract.verify.test.some((token) => token.includes(contract.trace.report.path))
      ? null
      : `verify.test does not write the report: ${JSON.stringify(contract.verify.test)}`,
  );

  contract.verify.test_name = 'node-test';
  contract.verify.lint_name = 'fixture-lint';
  contract.verify.lint_config_hint = 'package.json';
  writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  writeFileSync(
    join(repo, 'specs', 'core.md'),
    '<!-- spec-scope: lib -->\n\n# Core\n\n### REQ-CORE-001 — it holds\n\nThe system holds.\n',
  );

  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'adopt');
  git(repo, 'checkout', '-qb', 'feature');
  writeFileSync(join(repo, 'lib', 'a.js'), "export const a = () => 'a2';\n");
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'work');

  const green = cli(repo, 'check');
  const out = `${green.stdout}${green.stderr}`;
  check(
    'spec-flow check reaches green from the installed package',
    green.status !== 0 ? `the packaged CLI could not get a configured repo to green:\n${out}` : null,
  );
  check(
    'traceability works from the installed package',
    /every one proven by a test/.test(out) ? null : `spec-trace did not bind the requirement:\n${out}`,
  );

  // The plugin stamps `engine=` into every gate-history line; this is the
  // OTHER install (ADR-016), and the two move independently. Without this end
  // naming its own revision there is nothing to compare a CI log against, so a
  // drift between the two copies is invisible from both sides. Asserted HERE
  // because this is the only fixture that runs the CLI the way a consumer
  // installs it — from a tarball with no `.git`, which is exactly the case
  // whose answer is the `v`-prefixed fallback.
  check(
    'spec-flow check names the engine revision that ran',
    /^engine \S+$/m.test(out) ? null : `the CLI reported no engine revision, so this install cannot be compared with the plugin's:\n${out}`,
  );

  // `trace` and `stats` are dispatched by the same bin and reach different
  // modules. A `files` list that covers the check route and drops one of these
  // ships a CLI whose other subcommands throw on a missing import.
  for (const sub of ['trace', 'stats']) {
    const res = cli(repo, sub);
    check(
      `spec-flow ${sub} resolves its module from the package`,
      /Cannot find module|ERR_MODULE_NOT_FOUND/.test(`${res.stdout}${res.stderr}`)
        ? `spec-flow ${sub} could not load its script from the tarball:\n${res.stdout}${res.stderr}`
        : null,
    );
  }
}

try {
  await run();
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`package-fixture: ${failures.length} case(s) failed\n`);
  for (const f of failures) console.error(`  ✕ ${f}\n`);
  process.exit(1);
}

console.log(
  'package-fixture: OK — a git spec installs, links a spec-flow binary, and takes a repo to a green check from node_modules.',
);

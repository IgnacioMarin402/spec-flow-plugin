//! What each runner init knows printed, in a real run, for a test file whose
//! import does not resolve yet (…Load) and for a loaded test that fails
//! (…Fail). Run with no terminal, as the Bash tool runs them: node 22 prints
//! TAP there, node 24 its default reporter. Only the absolute paths were
//! rewritten to `/v/`, by script; re-capture rather than hand-edit.

/// jest 30.5.2
pub const JEST_LOAD: &str = r#"FAIL tests/load.test.js
  ● Test suite failed to run

    Cannot find module '../lib/area' from 'tests/load.test.js'

    > 1 | const { area } = require('../lib/area');
        |                  ^
      2 | test('REQ-GEO-001 area of a square', () => { expect(area(2)).toBe(4); });
      3 |

      at Resolver._throwModNotFoundError (node_modules/jest-resolve/build/index.js:1031:11)
      at Object.require (tests/load.test.js:1:18)

Test Suites: 1 failed, 1 total
Tests:       0 total
Snapshots:   0 total
Time:        0.365 s
Ran all test suites matching tests/load.test.js.
"#;

/// jest 30.5.2
pub const JEST_FAIL: &str = r#"FAIL tests/fail.test.js
  ● REQ-GEO-002 perimeter of a square

    expect(received).toBe(expected) // Object.is equality

    Expected: 8
    Received: 0

      1 | const { perim } = require('../lib/perim');
    > 2 | test('REQ-GEO-002 perimeter of a square', () => { expect(perim(2)).toBe(8); });
        |                                                                    ^
      3 |

      at Object.toBe (tests/fail.test.js:2:68)

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Snapshots:   0 total
Time:        0.35 s, estimated 1 s
Ran all test suites matching tests/fail.test.js.
"#;

/// vitest 5.1.0
pub const VITEST_LOAD: &str = r#"
 RUN  v5.1.0 /v

 ❯ vt/load.spec.mjs (0 test)

⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  vt/load.spec.mjs [ vt/load.spec.mjs ]
Error: Cannot find module './area.mjs' imported from /v/vt/load.spec.mjs
 ❯ vt/load.spec.mjs:2:1
      1| import { test, expect } from 'vitest';
      2| import { area } from './area.mjs';
       | ^
      3| test('REQ-GEO-001 area of a square', () => { expect(area(2)).toBe(4); …
      4|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  no tests
   Start at  21:29:13
   Duration  190ms (worker 96%, environment 4%)

"#;

/// vitest 5.1.0
pub const VITEST_FAIL: &str = r#"
 RUN  v5.1.0 /v

 ❯ vt/fail.spec.mjs (1 test | 1 failed) 12ms
   × REQ-GEO-002 perimeter of a square 10ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  vt/fail.spec.mjs > REQ-GEO-002 perimeter of a square
AssertionError: expected +0 to be 8 // Object.is equality

- Expected
+ Received

- 8
+ 0

 ❯ vt/fail.spec.mjs:3:68
      1| import { test, expect } from 'vitest';
      2| import { perim } from './perim.mjs';
      3| test('REQ-GEO-002 perimeter of a square', () => { expect(perim(2)).toB…
       |                                                                    ^
      4|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  21:29:14
   Duration  210ms (transform 35%, import 29%, tests 23%, worker 12%)

"#;

/// mocha 12.0.3
pub const MOCHA_LOAD: &str = r#"
 Exception during run: Error: Cannot find module './area'
Require stack:
- /v/mo/load.spec.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1564:15)
    at wrapResolveFilename (node:internal/modules/cjs/loader:1118:27)
    at defaultResolveImplForCJSLoading (node:internal/modules/cjs/loader:1142:10)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1169:12)
    at Module._load (node:internal/modules/cjs/loader:1341:5)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at Module.require (node:internal/modules/cjs/loader:1674:12)
    at require (node:internal/modules/helpers:157:16)
    at Object.<anonymous> (/v/mo/load.spec.js:2:18)
    at Module._compile (node:internal/modules/cjs/loader:1929:14)
    at Object..js (node:internal/modules/cjs/loader:2060:10)
    at Module.load (node:internal/modules/cjs/loader:1651:32)
    at Module._load (node:internal/modules/cjs/loader:1443:12)
    at wrapModuleLoad (node:internal/modules/cjs/loader:261:19)
    at loadCJSModuleWithModuleLoad (node:internal/modules/esm/translators:372:15)
    at ModuleWrap.<anonymous> (node:internal/modules/esm/translators:244:9)
    at ModuleJob.run (node:internal/modules/esm/module_job:561:25)
    at async node:internal/modules/esm/loader:647:26
    at async formattedImport (/v/node_modules/mocha/lib/nodejs/esm-utils.cjs:11:14)
    at async Object.requireModule [as requireOrImport] (/v/node_modules/mocha/lib/nodejs/esm-utils.cjs:106:30)
    at async exports.loadFilesAsync (/v/node_modules/mocha/lib/nodejs/esm-utils.cjs:182:20)
    at async singleRun (/v/node_modules/mocha/lib/cli/run-helpers.cjs:174:3)
    at async exports.handler (/v/node_modules/mocha/lib/cli/run.cjs:143:5) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    '/v/mo/load.spec.js'
  ]
}
"#;

/// mocha 12.0.3
pub const MOCHA_FAIL: &str = r#"

  1) REQ-GEO-002 perimeter of a square

  0 passing (3ms)
  1 failing

  1) REQ-GEO-002 perimeter of a square:

      AssertionError [ERR_ASSERTION]: 0 == 8
      + expected - actual

      -0
      +8
      
      at Context.<anonymous> (mo/fail.spec.js:3:56)
      at process.processImmediate (node:internal/timers:574:21)



"#;

/// node 24.22.2 --test
pub const NODE24_LOAD: &str = r#"node:internal/modules/esm/resolve:272
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/v/lib/area.mjs' imported from /v/tests/load.test.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:272:11)
    at moduleResolve (node:internal/modules/esm/resolve:879:10)
    at defaultResolve (node:internal/modules/esm/resolve:1006:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:705:20)
    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:725:38)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:763:56)
    at #resolve (node:internal/modules/esm/loader:687:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:607:35)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:276:33)
    at ModuleJob.link (node:internal/modules/esm/module_job:381:17) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///v/lib/area.mjs'
}

Node.js v24.22.2
✖ tests/load.test.mjs (47.148237ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 55.783011

✖ failing tests:

test at tests/load.test.mjs:1:1
✖ tests/load.test.mjs (47.148237ms)
  'test failed'
"#;

/// node 24.22.2 --test
pub const NODE24_FAIL: &str = r#"✖ REQ-GEO-002 perimeter of a square (1.335536ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 67.081482

✖ failing tests:

test at tests/fail.test.mjs:4:1
✖ REQ-GEO-002 perimeter of a square (1.335536ms)
  AssertionError [ERR_ASSERTION]: 0 == 8
      at TestContext.<anonymous> (file:///v/tests/fail.test.mjs:4:58)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 8,
    operator: '==',
    diff: 'simple'
  }
"#;

/// node 22.23.4 --test
pub const NODE22_LOAD: &str = r#"TAP version 13
# node:internal/modules/esm/resolve:275
#     throw new ERR_MODULE_NOT_FOUND(
#           ^
# Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/v/lib/area.mjs' imported from /v/tests/load.test.mjs
#     at finalizeResolution (node:internal/modules/esm/resolve:275:11)
#     at moduleResolve (node:internal/modules/esm/resolve:865:10)
#     at defaultResolve (node:internal/modules/esm/resolve:989:11)
#     at \#cachedDefaultResolve (node:internal/modules/esm/loader:747:20)
#     at ModuleLoader.resolve (node:internal/modules/esm/loader:724:38)
#     at ModuleLoader.getModuleJobForImport (node:internal/modules/esm/loader:320:38)
#     at ModuleJob._link (node:internal/modules/esm/module_job:182:49) {
#   code: 'ERR_MODULE_NOT_FOUND',
#   url: 'file:///v/lib/area.mjs'
# }
# Node.js v22.23.4
# Subtest: tests/load.test.mjs
not ok 1 - tests/load.test.mjs
  ---
  duration_ms: 43.624422
  type: 'test'
  location: '/v/tests/load.test.mjs:1:1'
  failureType: 'testCodeFailure'
  exitCode: 1
  signal: ~
  error: 'test failed'
  code: 'ERR_TEST_FAILURE'
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 51.970685
"#;

/// node 22.23.4 --test
pub const NODE22_FAIL: &str = r#"TAP version 13
# Subtest: REQ-GEO-002 perimeter of a square
not ok 1 - REQ-GEO-002 perimeter of a square
  ---
  duration_ms: 1.218711
  type: 'test'
  location: '/v/tests/fail.test.mjs:4:1'
  failureType: 'testCodeFailure'
  error: '0 == 8'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 8
  actual: 0
  operator: '=='
  stack: |-
    TestContext.<anonymous> (file:///v/tests/fail.test.mjs:4:58)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.start (node:internal/test_runner/test:944:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
1..1
# tests 1
# suites 0
# pass 0
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 63.041528
"#;

/// node 24.22.2 --test over tests/*.test.mjs: both files above, in one run.
pub const NODE24_MIXED: &str = r#"✖ REQ-GEO-002 perimeter of a square (1.386789ms)
node:internal/modules/esm/resolve:272
    throw new ERR_MODULE_NOT_FOUND(
          ^

Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/v/lib/area.mjs' imported from /v/tests/load.test.mjs
    at finalizeResolution (node:internal/modules/esm/resolve:272:11)
    at moduleResolve (node:internal/modules/esm/resolve:879:10)
    at defaultResolve (node:internal/modules/esm/resolve:1006:11)
    at #cachedDefaultResolve (node:internal/modules/esm/loader:705:20)
    at #resolveAndMaybeBlockOnLoaderThread (node:internal/modules/esm/loader:725:38)
    at ModuleLoader.resolveSync (node:internal/modules/esm/loader:763:56)
    at #resolve (node:internal/modules/esm/loader:687:17)
    at ModuleLoader.getOrCreateModuleJob (node:internal/modules/esm/loader:607:35)
    at ModuleJob.syncLink (node:internal/modules/esm/module_job:276:33)
    at ModuleJob.link (node:internal/modules/esm/module_job:381:17) {
  code: 'ERR_MODULE_NOT_FOUND',
  url: 'file:///v/lib/area.mjs'
}

Node.js v24.22.2
✖ tests/load.test.mjs (51.955314ms)
ℹ tests 2
ℹ suites 0
ℹ pass 0
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 69.968347

✖ failing tests:

test at tests/fail.test.mjs:4:1
✖ REQ-GEO-002 perimeter of a square (1.386789ms)
  AssertionError [ERR_ASSERTION]: 0 == 8
      at TestContext.<anonymous> (file:///v/tests/fail.test.mjs:4:58)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.start (node:internal/test_runner/test:1262:17)
      at startSubtestAfterBootstrap (node:internal/test_runner/harness:387:17) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 0,
    expected: 8,
    operator: '==',
    diff: 'simple'
  }

test at tests/load.test.mjs:1:1
✖ tests/load.test.mjs (51.955314ms)
  'test failed'
"#;

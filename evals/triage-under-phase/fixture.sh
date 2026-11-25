#!/usr/bin/env bash
# The unspecified report's repo, with the run already at `spec`, as /spec-fix
# step 0 leaves it: agent-gate judges the triage's return, and run-trace
# records it. run-trace.log starts empty so its grader reads a file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../_fixture/cart-repo.sh"
mkdir -p .claude/state
printf spec > .claude/state/phase
: > .claude/state/run-trace.log

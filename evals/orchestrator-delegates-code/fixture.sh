#!/usr/bin/env bash
# The cart repo as `spec-flow init` leaves an adopter's: the hooks' state and
# the suite's report ignored, so the gate reads a clean tree at each stop.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../_fixture/cart-repo.sh"
printf '.claude/state/\nreports/\n' > .gitignore
git -c user.email=fixture@example.com -c user.name=fixture add .gitignore
git -c user.email=fixture@example.com -c user.name=fixture commit -qm "ignore the engine's state"

#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$here/../_fixture/cart-repo.sh"
bash "$here/../_fixture/remove-item-change.sh" sound

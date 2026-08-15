#!/usr/bin/env bash
#
# Record the accessibility baseline, BEFORE any CSS change.
#
# The point is the delta. "The redesign improved accessibility" is worth nothing
# without the number it started from, and the moment the stylesheet is rewritten
# the old number is unrecoverable. So this runs the same axe spec the gate runs,
# but in BASELINE=1 mode, where the spec records its findings instead of failing
# the run, and writes a violation count per route per colour scheme.
#
# Output: docs/a11y-baseline.json. `docs/` is gitignored and local only, by the
# portfolio's publishing rules, so this file never reaches GitHub. It is a working
# note for whoever is doing the redesign, not an artifact of the repo.
#
# What breaks without it: nothing fails, which is the problem. A redesign lands,
# the axe gate goes green, and nobody can say whether the count went from 11 to 0
# or from 0 to 0 because the routes stopped rendering.
#
# Usage: ./scripts/a11y-baseline.sh [playwright args...]
# Assumes Postgres and Redis are up: docker compose -f infra/docker-compose.yml up -d
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="${OUT_DIR:-$ROOT/docs}"
OUT_FILE="$OUT_DIR/a11y-baseline.json"
REPORT="${REPORT:-/tmp/chat-a11y/report.json}"

mkdir -p "$OUT_DIR" "$(dirname "$REPORT")"

# Read by e2e/tests/a11y.spec.ts. In baseline mode the spec attaches each route's
# axe result and does not fail on violations, because a baseline that refuses to
# be recorded while the app is broken is the one moment a baseline is needed.
export BASELINE=1

# Playwright writes its JSON report wherever this points. Absolute, because the
# reporter resolves it against the e2e package directory, not the repo root.
export PLAYWRIGHT_JSON_OUTPUT_NAME="$REPORT"

echo "==> Running the axe spec (chromium only, JSON reporter)"
# One browser is enough: axe's rule engine returns the same answer in both, and a
# second project would double the runtime for an identical result. Both colour
# schemes still run, because that is the axis where a palette regresses -- this
# project's online green and offline grey sit at a 1.00 greyscale ratio in light
# mode (identical relative luminance; see docs/SPECS.md section 6.3), so a presence
# chip that relies on its swatch alone stops telling two people apart entirely.
#
# `|| true` on purpose: a violation makes the spec fail outside baseline mode, and
# even in baseline mode a route can 500. The summary below is what reports the
# outcome, and it is more useful than an exit code.
./scripts/e2e.sh --project=chromium a11y.spec.ts --reporter=json "$@" || true

if [[ ! -s "$REPORT" ]]; then
  echo "Playwright wrote no JSON report to ${REPORT}. Nothing to summarise." >&2
  exit 1
fi

node scripts/a11y-summary.mjs "$REPORT" "$OUT_FILE"

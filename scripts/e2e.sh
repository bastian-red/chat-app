#!/usr/bin/env bash
#
# Run the E2E lane: migrate, build, reseed, boot the api, the realtime gateway and
# the web app, run Playwright, tear everything down.
#
# What it proves: the flows a person actually performs. Sign in, send a message
# and watch a second browser context receive it without a reload, see the typing
# indicator appear and time out, be refused an action the role matrix does not
# allow, upload a file, and come back from a disconnection with no gap and no
# duplicate. Those cross every boundary in the repo at once, which is the one
# thing no unit test does.
#
# Three servers, not two. Live delivery comes from apps/realtime, so a lane that
# started only the api and the web app would run every messaging spec against a
# page whose socket never connects -- and the composer's optimistic line would
# make most of them pass anyway, on the client's own guess rather than on the
# server's broadcast. The second browser context is what makes that impossible to
# fake: only somebody else's browser rendering the line proves the write reached
# Postgres, got a seq, and came back out through the gateway.
#
# The reseed is part of the lane, not a prerequisite. The specs send messages,
# create channels and add members, so a second run against a used database would
# fail for reasons that have nothing to do with the code. The seed is idempotent,
# which is what makes the lane repeatable.
#
# The apps are started here rather than through `pnpm dev` or turbo on purpose:
# Playwright owns the lifecycle, the build is the production build, and turbo's
# persistent dev tasks would keep the shell alive after the suite finished. That
# also means this lane cannot see the failure scripts/dev-smoke.sh exists for,
# which is why both lanes exist.
#
# The env-loading block is deliberately the same shape as scripts/dev.sh.
#
# Usage: ./scripts/e2e.sh [playwright args...]
#   ./scripts/e2e.sh --headed
#   ./scripts/e2e.sh a11y.spec.ts
# Assumes Postgres and Redis are up: docker compose -f infra/docker-compose.yml up -d
set -euo pipefail

# Job control, so each server lands in its own process group. `pnpm exec next
# start` is a wrapper: killing the wrapper alone leaves the real server holding
# the port, and the next run then silently tests a stale build.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_LOG=/tmp/chat-e2e-api.log
RT_LOG=/tmp/chat-e2e-realtime.log
WEB_LOG=/tmp/chat-e2e-web.log
API_PID=""
RT_PID=""
WEB_PID=""

WAIT_SECONDS="${WAIT_SECONDS:-90}"

cleanup() {
  for pid in "$WEB_PID" "$RT_PID" "$API_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- -"$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# Defaults match .env.example so the lane runs on a CI runner with service
# containers and no .env file.
export DATABASE_URL="${DATABASE_URL:-postgresql://chat:chat@localhost:5438/chat?schema=public}"
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6385}"
export AUTH_SECRET="${AUTH_SECRET:-ci-secret-at-least-32-characters-long}"
export APP_VERSION="${APP_VERSION:-0.1.0}"
export SEND_RETRY_ATTEMPTS="${SEND_RETRY_ATTEMPTS:-5}"
export HISTORY_PAGE_SIZE="${HISTORY_PAGE_SIZE:-40}"
export CATCHUP_MAX_MESSAGES="${CATCHUP_MAX_MESSAGES:-200}"
export SOCKET_MAX_PAYLOAD_BYTES="${SOCKET_MAX_PAYLOAD_BYTES:-65536}"
export UPLOAD_MAX_BYTES="${UPLOAD_MAX_BYTES:-10485760}"
export UPLOAD_DIR="${UPLOAD_DIR:-var/uploads}"
export API_PORT="${API_PORT:-4000}"
export REALTIME_PORT="${REALTIME_PORT:-4100}"
export WEB_PORT="${WEB_PORT:-3000}"
export API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
export REALTIME_BASE_URL="${REALTIME_BASE_URL:-http://localhost:${REALTIME_PORT}}"
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT}}"
export AUTH_URL="${AUTH_URL:-$APP_BASE_URL}"

# Only one gateway in this lane. The E2E suite is about what a person sees in a
# browser, and a person cannot tell which replica served them; the two-replica
# proof belongs to scripts/integration.sh, which can assert on it directly rather
# than through a UI. The name is still exported because the /status page reads
# it, and an unset value there would render an unknown-state row the a11y spec
# would then have to special-case.
# Forced, not defaulted. This lane starts ONE gateway, and `.env` is sourced above
# it, so a `:-` default never applies on a developer machine whose .env points
# REALTIME_BASE_URL_2 at :4101. The /status page would then correctly report a
# replica that is genuinely not running, and the spec asserting "every dependency
# answered" would fail for a true statement about a stack this lane never built.
# Two gateways are scripts/integration.sh's job.
export REALTIME_BASE_URL_2="$REALTIME_BASE_URL"

# Presence is on the screen in this lane, so the timings stay production-shaped
# rather than compressed the way scripts/integration.sh compresses them: the spec
# that asserts a chip disappears is asserting on what a user experiences, and a
# 3-second TTL would prove that a different product works.
export PRESENCE_HEARTBEAT_SECONDS="${PRESENCE_HEARTBEAT_SECONDS:-10}"
export PRESENCE_TTL_SECONDS="${PRESENCE_TTL_SECONDS:-25}"
# Same reasoning. 5 seconds is short by design -- a typing indicator that outlives
# the typing is a lie about who is in the conversation -- and the spec that waits
# for the chip to clear is waiting the length a real reader would wait.
export TYPING_TTL_SECONDS="${TYPING_TTL_SECONDS:-5}"

# Inlined into the browser bundle by `next build`, so both must be exported before
# the build and not only before the server starts. NEXT_PUBLIC_REALTIME_URL is the
# one that decides whether the conversation receives live updates at all.
export NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-$API_BASE_URL}"
export NEXT_PUBLIC_REALTIME_URL="${NEXT_PUBLIC_REALTIME_URL:-$REALTIME_BASE_URL}"

# A suite driving several browser contexts from one address looks exactly like
# abuse to a production-shaped per-IP budget, and the sign-in limit of 5/min would
# fail the second spec every time. The socket budget matters as much here: every
# context heartbeats. Raised here rather than lowered in .env.example.
export RATE_LIMIT_GLOBAL=100000
# Below the global one, because apps/api/src/config/boot.ts refuses to start
# otherwise: auth is the credential-stuffing surface, and a budget at or above the
# general one is not a limit. Raising both to the same number here would be the
# lane weakening a check instead of the check doing its job.
export RATE_LIMIT_AUTH=90000
export SOCKET_EVENT_RATE_LIMIT=100000

# Same /dev/tcp probe as scripts/dev.sh.
check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0
  fi
  host="${BASH_REMATCH[2]}"
  port="${BASH_REMATCH[3]}"
  if ! (exec 3<>"/dev/tcp/${host}/${port}") 2>/dev/null; then
    echo "${label} is not reachable at ${host}:${port}. Start the datastores:" >&2
    echo "  docker compose -f infra/docker-compose.yml up -d" >&2
    return 1
  fi
}

failed=0
check_reachable "$DATABASE_URL" Postgres || failed=1
check_reachable "$REDIS_URL" Redis || failed=1
[[ $failed -eq 0 ]] || exit 1

# A leftover server from an interrupted run is the nastiest failure mode this
# script has: the new process fails to bind, the suite happily talks to the stale
# one, and the results describe code that is no longer on disk. The api and the
# gateway are probed on /health because their root paths 404, which `curl -f`
# reads as "nothing is listening".
for url in "${API_BASE_URL}/health" "${REALTIME_BASE_URL}/health" "${APP_BASE_URL}/"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo "Something is already serving ${url}. Stop it first:" >&2
    echo "  pkill -f 'apps/api/dist/main.js'; pkill -f 'apps/realtime/dist/main.js'; pkill -f 'next start'" >&2
    exit 1
  fi
done

echo "==> Applying migrations"
pnpm --filter @chat/db exec prisma migrate deploy >/dev/null

echo "==> Building"
# NODE_ENV=production is required: `next build` under development produces a
# broken prerender that the build itself reports as successful.
NODE_ENV=production pnpm build

echo "==> Seeding the demo conversation"
pnpm --filter @chat/db run seed

# Drop Next's fetch cache, which the seed cannot invalidate.
#
# Server components read the API through fetch, which Next caches on disk under
# .next/cache/fetch-cache. That cache survives both a rebuild and a restart, so
# `next start` will serve a response captured during the previous run, from rows
# the seed has since deleted. `revalidateTag` is the normal way to clear it, but
# the seed is a separate process with no route to call it. The database is correct
# and the page is stale, which is the hardest kind of failure to read.
FETCH_CACHE="$ROOT/apps/web/.next/cache/fetch-cache"
if [[ -d "$FETCH_CACHE" ]]; then
  find "$FETCH_CACHE" -type f -delete
  echo "==> Cleared the Next fetch cache"
fi

echo "==> Starting the api on :${API_PORT} (log: ${API_LOG})"
# Plain `node`, not `nest start` or `pnpm start`: killing a wrapper only kills the
# wrapper, and the grandchild keeps the socket. `$!` here is the process that
# actually holds it.
node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!

echo "==> Starting the realtime gateway on :${REALTIME_PORT} (log: ${RT_LOG})"
node apps/realtime/dist/main.js >"$RT_LOG" 2>&1 &
RT_PID=$!

echo "==> Starting the web app on :${WEB_PORT} (log: ${WEB_LOG})"
pnpm --filter @chat/web exec next start -p "$WEB_PORT" >"$WEB_LOG" 2>&1 &
WEB_PID=$!

wait_for() {
  local url="$1" name="$2" pid="$3" log="$4"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    # A process that has already exited will never become healthy, and waiting out
    # the full timeout hides the reason it died.
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "${name} exited during startup. Last 30 lines of ${log}:" >&2
      tail -30 "$log" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 30 lines of ${log}:" >&2
  tail -30 "$log" >&2
  exit 1
}

wait_for "${API_BASE_URL}/health" api "$API_PID" "$API_LOG"
# The gateway's /health completes a pub/sub round trip on the adapter's own
# channel before it answers 200, so waiting for it green means the socket layer is
# ready and not merely bound. A spec that opened a channel before that would see an
# empty roster and a message that never broadcast, and would read as a UI bug.
wait_for "${REALTIME_BASE_URL}/health" realtime "$RT_PID" "$RT_LOG"
wait_for "${APP_BASE_URL}/" web "$WEB_PID" "$WEB_LOG"

echo "==> Running Playwright"
# `exec playwright`, not `run test:e2e --`. pnpm 9 forwards the `--` itself to the
# script, so `./scripts/e2e.sh --project=chromium` became
# `playwright test -- --project=chromium`; Playwright read the bare `--` as a
# positional test filter, silently ignored the flag after it, and ran the whole
# suite in every browser while reporting nothing about the argument it dropped.
pnpm --filter @chat/e2e exec playwright test "$@"

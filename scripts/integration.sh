#!/usr/bin/env bash
#
# Run the integration lane against a real Postgres, a real Redis, and two real
# Socket.io gateways.
#
# What it proves, and why none of it can be proven in the gate lane. Each item is
# docs/SPECS.md section 7.1:
#
#   1. Sequence under concurrency. N simultaneous sends into one channel. All N
#      succeed, and the resulting seq set is exactly 1..N -- no duplicate, no
#      gap -- with every body present once. The mechanism under test is
#      `UPDATE channels SET next_seq = next_seq + 1 RETURNING next_seq` taking a
#      row lock, plus `UNIQUE (channel_id, seq)` behind it. A mocked Postgres
#      cannot refuse a duplicate, so a suite that mocks it is asserting on its
#      own mock.
#   2. Idempotency under a lost ack. The same clientMessageId sent twice
#      concurrently yields one row, and the second answer carries
#      `duplicate: true` with the first row's seq. `sendMessage` inserts
#      optimistically and catches 23505 on
#      `UNIQUE (channel_id, client_message_id)`; checking first would be a race
#      that loses exactly when it matters, which is two tabs retrying one failed
#      send at once.
#   3. Cross-replica broadcast. This is the reason the script starts two gateway
#      processes instead of importing the gateway module. With one process every
#      socket shares one in-memory adapter and broadcasts work whether or not
#      @socket.io/redis-adapter is wired at all. Only a client on :4100 receiving
#      a message sent by a client on :4101 proves the pub/sub path is real.
#   4. Schema invariants. The guard rails live in the schema
#      (`20260811090000_chat_invariants`): the CHECKs on seq, dm_key shape and a
#      tombstone's blank body, and the partial unique index that allows at most
#      one OWNER per channel. Nothing in the gate lane touches the schema, so a
#      migration that dropped one would otherwise ship green.
#   5. Presence TTL. A client that stops heartbeating leaves the roster within
#      PRESENCE_TTL_SECONDS. That is a Redis expiry, so it needs Redis.
#   6. Catch-up bound. A gap larger than CATCHUP_MAX_MESSAGES answers
#      `complete: false` rather than streaming a week of backlog through a socket
#      to a client that will render forty lines of it.
#
# The migrate-and-seed step is part of the lane rather than a prerequisite. The
# suite asserts on a known channel, and the seed is idempotent, which is what
# makes this runnable twice in a row with no manual cleanup.
#
# The env-loading block is deliberately the same shape as scripts/dev.sh, so the
# repo has one idiom for this rather than two that can drift apart.
#
# Usage: ./scripts/integration.sh [vitest args...]
# Assumes Postgres and Redis are up: docker compose -f infra/docker-compose.yml up -d
set -euo pipefail

# Job control, so each gateway lands in its own process group and the cleanup
# below can kill a wrapper's grandchildren along with it.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_LOG=/tmp/chat-integration-api.log
RT1_LOG=/tmp/chat-integration-realtime-4100.log
RT2_LOG=/tmp/chat-integration-realtime-4101.log
API_PID=""
RT1_PID=""
RT2_PID=""

WAIT_SECONDS="${WAIT_SECONDS:-90}"

cleanup() {
  for pid in "$RT2_PID" "$RT1_PID" "$API_PID"; do
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

# Defaults match .env.example, so the lane runs on a CI runner that has service
# containers but no .env file. They are not a second source of truth: if these
# and .env.example ever disagree, .env.example wins and this is the bug.
export DATABASE_URL="${DATABASE_URL:-postgresql://chat:chat@localhost:5438/chat?schema=public}"
# Prisma requires directUrl to be set; with no pooler locally it is the same value.
export DIRECT_DATABASE_URL="${DIRECT_DATABASE_URL:-$DATABASE_URL}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6385}"
export AUTH_SECRET="${AUTH_SECRET:-ci-secret-at-least-32-characters-long}"
export APP_VERSION="${APP_VERSION:-0.1.0}"
# Required by both processes' config, and by the gateway's CORS origin. Not
# optional and not defaulted in the code: a gateway that accepted a socket from
# any origin would accept one from a page that phished the token.
export APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT:-3000}}"
export API_PORT="${API_PORT:-4000}"
export API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
# The suite boots the Nest application in-process for the REST assertions, so it
# needs the upload knobs even though no gateway reads them.
export UPLOAD_DIR="${UPLOAD_DIR:-var/uploads}"
export UPLOAD_MAX_BYTES="${UPLOAD_MAX_BYTES:-10485760}"
export SEND_RETRY_ATTEMPTS="${SEND_RETRY_ATTEMPTS:-5}"
export HISTORY_PAGE_SIZE="${HISTORY_PAGE_SIZE:-40}"
export SOCKET_MAX_PAYLOAD_BYTES="${SOCKET_MAX_PAYLOAD_BYTES:-65536}"
# Left at its production value on purpose. Proof 6 in the header asserts that a
# gap wider than this answers `complete: false`, so lowering it here to make the
# test cheaper would mean the lane never exercises the number the app ships with.
export CATCHUP_MAX_MESSAGES="${CATCHUP_MAX_MESSAGES:-200}"

# Presence timings are compressed for the lane. The production defaults (10s
# heartbeat, 25s TTL) would make the TTL expiry test alone take half a minute of
# wall clock, and a suite nobody wants to run is a suite that stops being run.
# The property under test is "the roster forgets a client that stops
# heartbeating", which is TTL-value-independent; the numbers in .env.example stay
# at their production shape rather than being lowered to suit a test.
#
# The ratio is preserved, not just the magnitude: 3 is more than twice 1, so the
# gateway's own assertPresenceConfig still accepts it. Compressing to 1/2 would
# refuse to boot, which is the check doing its job.
export PRESENCE_HEARTBEAT_SECONDS="${INTEGRATION_PRESENCE_HEARTBEAT_SECONDS:-1}"
export PRESENCE_TTL_SECONDS="${INTEGRATION_PRESENCE_TTL_SECONDS:-3}"
# Typing is already short-lived in production (5s); 2 keeps the lane quick while
# leaving it long enough that a set read immediately after a start still sees it.
export TYPING_TTL_SECONDS="${INTEGRATION_TYPING_TTL_SECONDS:-2}"

# The concurrency proof fires N simultaneous sends and the cross-replica test
# opens a burst of sockets, both from one address, which a
# production-shaped per-IP budget is supposed to refuse. Raising the limits here
# keeps the production defaults in .env.example honest instead of weakening them
# so a test can pass.
export RATE_LIMIT_GLOBAL=100000
# Below the global one, because apps/api/src/config/boot.ts refuses to start
# otherwise: auth is the credential-stuffing surface and a budget at or above the
# general one is not a limit. Raising both to the same number here would be the
# lane weakening a check instead of the check doing its job, and it did exactly
# that once.
export RATE_LIMIT_AUTH=90000
export SOCKET_EVENT_RATE_LIMIT=100000

# The two gateway instances. 4101 is not decoration: see note 3 in the header.
# REALTIME_PORT_2 stays a shell local; the suite is handed the second gateway as
# a URL (REALTIME_BASE_URL_2, declared in turbo.json and documented in
# .env.example) so it never has to assume a hostname, the same way it is handed
# the first one.
export REALTIME_PORT="${REALTIME_PORT:-4100}"
REALTIME_PORT_2="${REALTIME_PORT_2:-4101}"
export REALTIME_BASE_URL="${REALTIME_BASE_URL:-http://localhost:${REALTIME_PORT}}"
export REALTIME_BASE_URL_2="${REALTIME_BASE_URL_2:-http://localhost:${REALTIME_PORT_2}}"

# Same /dev/tcp probe as scripts/dev.sh: bash's own, because nc is not installed
# everywhere. Postgres or Redis being absent presents as a slow hang or a wall of
# connection errors rather than as one clear line, so it gets named up front.
check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0 # No explicit host:port to check. Let the tool report it.
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

# A leftover gateway from an interrupted run is the nastiest failure this script
# has: the new process fails to bind, the suite happily talks to the stale one,
# and the results describe code that is no longer on disk. Worse here than in a
# REST lane, because a stale gateway on 4101 makes the cross-instance test pass
# for the wrong reason.
for url in "${API_BASE_URL}/health" "${REALTIME_BASE_URL}/health" "${REALTIME_BASE_URL_2}/health"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    echo "Something is already serving ${url}. Stop it first:" >&2
    echo "  pkill -f 'apps/(api|realtime)/dist/main.js'" >&2
    exit 1
  fi
done

echo "==> Applying migrations"
pnpm --filter @chat/db exec prisma migrate deploy >/dev/null

# Built directly rather than through `turbo run test:integration`, because this
# lane is about the datastores and turbo's task graph is not what is under test.
# `@chat/api^...` selects the API's workspace dependencies without the API itself,
# so a package added to apps/api/package.json next month is built without anyone
# editing this line. @chat/realtime is built in full because this script runs its
# compiled output as two separate processes.
# The API is built in full, not just its dependencies. The suite drives it over
# HTTP as a separate process rather than importing it, for a reason that is not
# style: NestJS resolves constructor dependencies from the `design:paramtypes`
# metadata `emitDecoratorMetadata` writes at compile time, and vitest transforms
# with esbuild, which does not emit it. `Test.createTestingModule` under vitest
# therefore builds a graph where every injected dependency is `undefined`, and the
# symptom is a 500 from a guard reading a property of nothing. Running the
# compiled artifact also means the lane exercises what the Dockerfile ships.
echo "==> Building the API"
pnpm --filter "@chat/api..." run build >/dev/null
echo "==> Building the realtime gateway"
pnpm --filter "@chat/realtime..." run build >/dev/null

echo "==> Seeding the demo conversation"
pnpm --filter @chat/db run seed

echo "==> Starting the API on :${API_PORT} (log: ${API_LOG})"
PORT="$API_PORT" node apps/api/dist/main.js >"$API_LOG" 2>&1 &
API_PID=$!

echo "==> Starting gateway 1 on :${REALTIME_PORT} (log: ${RT1_LOG})"
# Plain `node`, not `nest start` or `pnpm start`: killing a wrapper only kills the
# wrapper, and the grandchild keeps the socket. `$!` here is the process that
# actually holds it.
PORT="$REALTIME_PORT" node apps/realtime/dist/main.js >"$RT1_LOG" 2>&1 &
RT1_PID=$!

echo "==> Starting gateway 2 on :${REALTIME_PORT_2} (log: ${RT2_LOG})"
PORT="$REALTIME_PORT_2" node apps/realtime/dist/main.js >"$RT2_LOG" 2>&1 &
RT2_PID=$!

wait_for() {
  local url="$1" name="$2" pid="$3" log="$4"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if curl -sf -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    # A process that has already exited will never become healthy, and waiting
    # out the full timeout hides the reason it died.
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

# /health on the gateway is not a liveness probe: it publishes a nonce on the
# adapter's own Redis channel and waits to receive it back, so waiting for it
# green also establishes that both processes have joined the same pub/sub before
# a single test runs. Without that, a slow adapter subscription would make the
# cross-instance test flaky and look like a bug in the broadcast code.
wait_for "${API_BASE_URL}/health" "the API" "$API_PID" "$API_LOG"
wait_for "${REALTIME_BASE_URL}/health" "gateway 1" "$RT1_PID" "$RT1_LOG"
wait_for "${REALTIME_BASE_URL_2}/health" "gateway 2" "$RT2_PID" "$RT2_LOG"

echo "==> Running the integration suite"
pnpm --filter @chat/api run test:integration -- "$@"

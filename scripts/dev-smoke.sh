#!/usr/bin/env bash
#
# Smoke the documented developer command: `pnpm dev`.
#
# scripts/env-contract.mjs proves the variable names are declared. It cannot
# prove they arrive. That depends on package.json pointing "dev" at
# scripts/dev.sh, on dev.sh sourcing .env, and on turbo passing every name
# through in strict mode. This boots the real `pnpm dev` and asserts the app
# serves a page built from the database and a socket that actually delivers a
# conversation.
#
# Why it is not folded into scripts/e2e.sh: that lane sources .env itself and
# starts the built apps directly, never touching turbo. It is a different code
# path, and in three sibling projects it stayed green for months while the
# documented `pnpm dev` was broken. A lane that cannot fail the way the README
# fails is not covering the README.
#
# The one rule that makes this check real: it supplies the child with NOTHING.
# Every name .env.example documents is stripped with `env -u` before `pnpm dev`
# starts, so the only path configuration can take is .env -> dev.sh -> turbo ->
# the process. An earlier version of this idea in a sibling project did
# `set -a; . ./.env` first, which put every value into its own environment, so
# the app was configured by the test rather than by the repo and the check passed
# with the fix reverted.
#
# Three processes here, not two, and the socket probe at the end is the part that
# is specific to this project. NEXT_PUBLIC_REALTIME_URL is inlined into the
# browser bundle at build time, so getting it wrong produces a conversation that
# renders perfectly, answers 200 on every route, and never receives a single
# message. Every HTTP assertion in this file would pass through that, which is
# why the last thing this script does is open a socket and wait for a channel.
#
# Usage: ./scripts/dev-smoke.sh
# Assumes Postgres and Redis are up and the database is migrated and seeded:
#   docker compose -f infra/docker-compose.yml up -d
#   pnpm db:deploy && pnpm db:seed
set -euo pipefail

# Job control, so each background job lands in its own process group and the
# cleanup below can take down turbo *and* the next/nest children it spawned.
# Killing only the turbo PID leaves servers holding :3000, :4000 and :4100, which
# makes the next run fail for a reason unrelated to the code.
set -m

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOG=/tmp/chat-dev-smoke.log
COOKIES="$(mktemp -t chat-dev-smoke-cookies.XXXXXX)"
DEV_PID=""

# Bounded, and stated once. A cold .next on a loaded machine is slow, so it is
# overridable, but there is no unbounded wait anywhere in this file: a hang has to
# fail with a message rather than sit there.
WAIT_SECONDS="${WAIT_SECONDS:-60}"

cleanup() {
  if [[ -n "$DEV_PID" ]] && kill -0 "$DEV_PID" 2>/dev/null; then
    kill -- -"$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  rm -f "$COOKIES"
}
trap cleanup EXIT

die() {
  echo >&2
  echo "FAIL: $*" >&2
  exit 1
}

[[ -f .env ]] || die "no .env in the repo root. See README.md, 'Running it'."
[[ -f .env.example ]] || die "no .env.example, so there is no list of names to strip."

# Read what the probes need WITHOUT sourcing .env, for the reason in the header.
env_value() {
  sed -n "s/^[[:space:]]*$1=//p" .env | tail -1
}

API_PORT="$(env_value API_PORT)"
REALTIME_PORT="$(env_value REALTIME_PORT)"
WEB_PORT="$(env_value WEB_PORT)"
API_PORT="${API_PORT:-4000}"
REALTIME_PORT="${REALTIME_PORT:-4100}"
WEB_PORT="${WEB_PORT:-3000}"
API_BASE_URL="$(env_value API_BASE_URL)"
REALTIME_BASE_URL="$(env_value REALTIME_BASE_URL)"
APP_BASE_URL="$(env_value APP_BASE_URL)"
API_BASE_URL="${API_BASE_URL:-http://localhost:${API_PORT}}"
REALTIME_BASE_URL="${REALTIME_BASE_URL:-http://localhost:${REALTIME_PORT}}"
APP_BASE_URL="${APP_BASE_URL:-http://localhost:${WEB_PORT}}"

# The route the channel list lives under. Overridable so a rename is a one-line
# change here rather than a rewrite, but defaulted to what the README documents.
CHANNELS_PATH="${CHANNELS_PATH:-/channels}"

# Every signed-in route in components/nav.tsx, read out of the file rather than
# retyped. A route added to the nav and forgotten here would be a route nobody
# ever loads until a reader does. Two probed routes cannot catch a third route
# being broken, and that exact miss shipped in a sibling project.
mapfile -t NAV_PATHS < <(
  sed -n "s/^[[:space:]]*{ href: '\([^']*\)'.*/\1/p" apps/web/components/nav.tsx
)
[[ ${#NAV_PATHS[@]} -gt 0 ]] ||
  die "could not read any hrefs out of apps/web/components/nav.tsx."

# --- Facts read out of the seed, never retyped here -------------------------
#
# A copy of a seeded string that drifts from the seed produces a check that is
# confidently about data that no longer exists, which is worse than no check.
# packages/db/prisma/seed.ts declares these as named constants precisely so this
# script can read them with one sed each; see the note above them there.

SEED=packages/db/prisma/seed.ts

seed_const() {
  sed -n "s/^const $1 = '\([^']*\)';.*/\1/p" "$SEED"
}

DEMO_EMAIL="$(seed_const DEMO_EMAIL)"
DEMO_PASSWORD="$(seed_const DEMO_PASSWORD)"
DEMO_CHANNEL="$(seed_const DEMO_CHANNEL)"
DEMO_MESSAGE="$(seed_const DEMO_MESSAGE)"
for pair in \
  "DEMO_EMAIL:$DEMO_EMAIL" \
  "DEMO_PASSWORD:$DEMO_PASSWORD" \
  "DEMO_CHANNEL:$DEMO_CHANNEL" \
  "DEMO_MESSAGE:$DEMO_MESSAGE"; do
  [[ -n "${pair#*:}" ]] || die "could not read ${pair%%:*} out of ${SEED}."
done

# --- Refuse to run against somebody else's server ---------------------------
#
# A leftover dev server is the worst failure mode here: the new process fails to
# bind, the probes talk to the stale one, and the result describes code that is no
# longer on disk.
for url in "${API_BASE_URL}/health" "${REALTIME_BASE_URL}/health" "${APP_BASE_URL}/"; do
  if curl -sf -o /dev/null "$url" 2>/dev/null; then
    die "something is already serving ${url}. Stop it first."
  fi
done

# --- Throw away every build output the apps have ----------------------------
#
# A fresh clone has no `apps/*/dist` and no `apps/web/.next`, and this script
# exists to behave like a fresh clone. Leaving yesterday's build in place is the
# same class of hole as leaving the environment in place: the check passes
# because of state the repo does not carry.
#
# It is not hypothetical. `apps/realtime`'s dev script was
#
#     tsc --watch & node --watch dist/main.js
#
# which starts `node` on a file `tsc` has not written yet. With a warm `dist/`
# that works every time; with a cold one `node` exits MODULE_NOT_FOUND
# immediately and never picks the file up when tsc emits it a second later. It
# passed here for as long as the directory happened to exist and failed on the
# first CI runner that had never built the repo. The fix is `tsc && (tsc --watch
# & node --watch ...)`; this deletion is what makes the failure reachable from a
# developer's machine.
#
# Library builds under packages/ and services/ are left alone: turbo's `^build`
# rebuilds them on every `dev` anyway, so their staleness is not a thing this can
# observe, and deleting them turns a 40-second check into a three-minute one.
echo "==> Removing app build outputs so this starts as cold as a fresh clone"
for stale in apps/*/dist apps/*/.next; do
  # Guarded on the glob actually matching, and rooted at $ROOT by the `cd` at the
  # top of the file, so this cannot walk outside the repo.
  [[ -e "$stale" ]] || continue
  rm -rf "${ROOT:?}/${stale}"
  echo "    removed ${stale}"
done

# --- Strip the environment and start ----------------------------------------
#
# Derived from .env.example rather than hardcoded, so a variable added next month
# is stripped without anyone remembering to come back here. .env is unioned in
# because a local file may carry a name the example does not yet document, and an
# unstripped name is a hole in exactly this check.
mapfile -t ENV_KEYS < <(
  sed -n 's/^[[:space:]]*#\?[[:space:]]*\([A-Z][A-Z0-9_]*\)[[:space:]]*=.*/\1/p' .env.example .env |
    sort -u
)
[[ ${#ENV_KEYS[@]} -gt 0 ]] || die "parsed no variable names out of .env.example."

UNSET_ARGS=()
for key in "${ENV_KEYS[@]}"; do UNSET_ARGS+=(-u "$key"); done

echo "==> Starting: pnpm dev (${#ENV_KEYS[@]} .env names stripped from the child environment)"
echo "    log: ${LOG}"
env "${UNSET_ARGS[@]}" pnpm dev >"$LOG" 2>&1 &
DEV_PID=$!

# The two API-shaped services are polled for ANY response rather than a 2xx:
# /health answers 503 when a dependency is down, and a 503 that names the failing
# check is far more useful than a timeout that says nothing. Both bodies are
# asserted below either way.
wait_for() {
  local url="$1" name="$2" mode="${3:-ok}"
  local i
  for ((i = 0; i < WAIT_SECONDS; i++)); do
    if [[ "$mode" == "any" ]]; then
      curl -s -o /dev/null "$url" 2>/dev/null && return 0
    elif curl -sf -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    # A process that has already exited will never become healthy, and waiting out
    # the full timeout hides the reason it died.
    if ! kill -0 "$DEV_PID" 2>/dev/null; then
      echo "pnpm dev exited before ${name} came up. Last 40 lines of ${LOG}:" >&2
      tail -40 "$LOG" >&2
      exit 1
    fi
    sleep 1
  done
  echo "${name} never came up at ${url} within ${WAIT_SECONDS}s. Last 40 lines of ${LOG}:" >&2
  tail -40 "$LOG" >&2
  exit 1
}

echo "==> Waiting for api :${API_PORT}, realtime :${REALTIME_PORT}, web :${WEB_PORT}"
wait_for "${API_BASE_URL}/health" "api (:${API_PORT})" any
wait_for "${REALTIME_BASE_URL}/health" "realtime (:${REALTIME_PORT})" any
wait_for "${APP_BASE_URL}/" "web (:${WEB_PORT})"

# --- /health, parsed as JSON rather than grepped ----------------------------
#
# The shape is packages/shared/src/contracts/health.ts `healthSchema`:
# { status, version, uptimeSeconds, checks: [{ name, status, latencyMs, detail }] }.
# A regex over JSON passes on a body that happens to contain the right substring
# in the wrong place; JSON.parse does not.
#
# The gateway's required checks include `adapter`, which is not a ping. It
# publishes a nonce on the Socket.io adapter's own Redis channel and waits to
# receive it back. A gateway that answers "redis: ok" and cannot round-trip its
# own broadcast serves every socket it holds and silently stops relaying to the
# other replicas.
assert_health() {
  local url="$1" label="$2" required="$3" body
  body="$(curl -s "$url")"
  # The single quotes are the point: everything inside is JavaScript, and the
  # `${...}` in it is a JS template literal, not a shell expansion. The three
  # values the script needs are handed to it through the environment on the line
  # below, which also keeps a body containing a quote from ending the program.
  # shellcheck disable=SC2016
  if ! HEALTH_BODY="$body" REQUIRED="$required" LABEL="$label" node -e '
    let health;
    try {
      health = JSON.parse(process.env.HEALTH_BODY ?? "");
    } catch {
      console.error(`  ${process.env.LABEL} /health did not return JSON:`, (process.env.HEALTH_BODY ?? "").slice(0, 400));
      process.exit(1);
    }
    const problems = [];
    if (health.status !== "ok") problems.push(`status is ${JSON.stringify(health.status)}, not "ok"`);
    const checks = Array.isArray(health.checks) ? health.checks : [];
    for (const required of process.env.REQUIRED.split(",")) {
      const check = checks.find((c) => String(c?.name ?? "").toLowerCase().startsWith(required));
      if (!check) problems.push(`no "${required}" entry in checks[]`);
      else if (check.status !== "ok") problems.push(`${required} reports ${check.status}: ${check.detail ?? "no detail"}`);
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`  ${problem}`);
      process.exit(1);
    }
  '; then
    echo "  body: ${body}" >&2
    die "${label} /health is not green. A green endpoint with a dead dependency behind it is the bug this catches."
  fi
}

echo "==> Checking both /health endpoints"
assert_health "${API_BASE_URL}/health" api postgres,redis,uploads
assert_health "${REALTIME_BASE_URL}/health" realtime redis,adapter

# --- Sign in, the way a person does -----------------------------------------
#
# Every page worth asserting on is behind the session, so there is no anonymous
# database-backed page to grep. Auth.js exposes a stable HTTP interface for this:
# GET /api/auth/csrf, then POST the token back to the credentials callback with
# the cookie jar carrying the double-submit cookie.
echo "==> Signing in as ${DEMO_EMAIL}"
csrf="$(
  curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/csrf" |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          process.stdout.write(String(JSON.parse(raw).csrfToken ?? ""));
        } catch {
          /* Not JSON. The caller fails on the empty value with a better message. */
        }
      });
    '
)"
[[ -n "$csrf" ]] || die "GET ${APP_BASE_URL}/api/auth/csrf returned no csrfToken. Auth.js is not mounted."

curl -s -o /dev/null -L -c "$COOKIES" -b "$COOKIES" \
  --data-urlencode "csrfToken=${csrf}" \
  --data-urlencode "email=${DEMO_EMAIL}" \
  --data-urlencode "password=${DEMO_PASSWORD}" \
  "${APP_BASE_URL}/api/auth/callback/credentials"

session="$(curl -s -c "$COOKIES" -b "$COOKIES" "${APP_BASE_URL}/api/auth/session")"
if ! grep -qF "$DEMO_EMAIL" <<<"$session"; then
  echo "  session: ${session}" >&2
  echo "  Last 40 lines of ${LOG}:" >&2
  tail -40 "$LOG" >&2
  die "sign-in did not produce a session. Either AUTH_SECRET never reached the web app or the seed did not run."
fi

# --- The load-bearing assertions --------------------------------------------
#
# Content, not status codes. A broken app answers 200 with an error page, and an
# error page is exactly what a missing AUTH_SECRET or an unreachable API_BASE_URL
# produces, so a `curl -f` check would have passed through the whole outage this
# script exists for.
echo "==> Checking ${CHANNELS_PATH} lists the seeded channel"
channels="$(curl -s -L -b "$COOKIES" -c "$COOKIES" "${APP_BASE_URL}${CHANNELS_PATH}")"
grep -qF "$DEMO_CHANNEL" <<<"$channels" ||
  { tail -40 "$LOG" >&2; die "${CHANNELS_PATH} does not contain the seeded channel '${DEMO_CHANNEL}'. It is an error page or an empty shell."; }

# The channel's own page, found by following the links the list just rendered
# rather than by guessing an id. Channel ids are cuids: they change on every seed,
# so any hardcoded path here would be wrong by the second run.
#
# Every link is tried and the one whose page carries DEMO_MESSAGE wins, rather
# than taking the first link. The list is ordered by the newest message, so which
# channel comes first is a property of when the seed happened to write each row --
# and following the wrong one makes this script report that the seeded message is
# missing from a conversation that never had it. That failure reads as a broken
# renderer and is a broken test, which is worse than no test.
mapfile -t CHANNEL_HREFS < <(
  grep -o "href=\"${CHANNELS_PATH}/[A-Za-z0-9_-]*\"" <<<"$channels" |
    sed 's/href="//;s/"//' | sort -u
)
[[ ${#CHANNEL_HREFS[@]} -gt 0 ]] ||
  { tail -40 "$LOG" >&2; die "${CHANNELS_PATH} rendered no link to a channel, so the list is chrome with no data behind it."; }

CHANNEL_HREF=""
channel=""
for href in "${CHANNEL_HREFS[@]}"; do
  candidate="$(curl -s -L -b "$COOKIES" -c "$COOKIES" "${APP_BASE_URL}${href}")"
  if grep -qF "$DEMO_MESSAGE" <<<"$candidate"; then
    CHANNEL_HREF="$href"
    channel="$candidate"
    break
  fi
done

[[ -n "$CHANNEL_HREF" ]] ||
  { tail -40 "$LOG" >&2; die "none of the ${#CHANNEL_HREFS[@]} channel pages linked from ${CHANNELS_PATH} rendered the seeded message."; }

echo "==> Checking ${CHANNEL_HREF} rendered the conversation"
grep -qF "$DEMO_CHANNEL" <<<"$channel" ||
  { tail -40 "$LOG" >&2; die "${CHANNEL_HREF} does not carry the channel name '${DEMO_CHANNEL}'."; }
grep -qF "$DEMO_MESSAGE" <<<"$channel" ||
  { tail -40 "$LOG" >&2; die "${CHANNEL_HREF} does not contain the seeded message, so no message came from the database."; }

# --- Every route in the nav, not just the two above -------------------------
#
# Status *and* content, in that order. A server component that throws answers 500,
# which the checks above would catch on their own routes and nowhere else; a route
# whose API call quietly returns nothing answers 200 with an empty shell, which a
# status check alone would pass. Both are real failures this portfolio has shipped.
echo "==> Checking every route in the nav renders for a signed-in reader"
route_failures=0
for path in "${NAV_PATHS[@]}"; do
  route_body="$(curl -s -L -b "$COOKIES" -c "$COOKIES" -w '\n%{http_code}' "${APP_BASE_URL}${path}")"
  route_status="${route_body##*$'\n'}"
  route_html="${route_body%$'\n'*}"

  if [[ "$route_status" != "200" ]]; then
    echo "  ${path} answered ${route_status}" >&2
    route_failures=$((route_failures + 1))
    continue
  fi

  # The primary nav only renders inside the signed-in layout, so its absence means
  # an error boundary or the login page, whatever the status said.
  if ! grep -qF 'aria-label="Main"' <<<"$route_html"; then
    echo "  ${path} answered 200 without the signed-in chrome. It is an error page." >&2
    route_failures=$((route_failures + 1))
    continue
  fi

  # And something only a *working* render of that particular route produces.
  #
  # One string per route rather than one for the whole app. The seeded channel
  # name is the right proof for the channel list and means nothing on /status,
  # which shows no channels at all: asserting it everywhere would either fail on a
  # page that is fine or force /status to render a channel name it has no reason
  # to.
  #
  # /status's proof is the word `postgres`, which is a dependency name out of the
  # API's own /health body. It appears only if this page fetched that endpoint
  # server-side and parsed it against the shared contract -- an unreachable API
  # renders "unreachable" and no checks table at all, which is exactly the
  # 200-with-an-empty-shell this whole section exists to catch.
  case "$path" in
    /status) route_needle="postgres" ;;
    *) route_needle="$DEMO_CHANNEL" ;;
  esac

  if ! grep -qF "$route_needle" <<<"$route_html"; then
    echo "  ${path} rendered without '${route_needle}', so nothing on it came from a real fetch." >&2
    route_failures=$((route_failures + 1))
    continue
  fi

  echo "    ${path} ok"
done

if [[ "$route_failures" -gt 0 ]]; then
  tail -40 "$LOG" >&2
  die "${route_failures} of ${#NAV_PATHS[@]} nav routes did not render."
fi

# --- The socket, which no HTTP assertion above can reach --------------------
#
# This is the check that is specific to this project. Everything above passes on a
# conversation that never receives a live update: the page is server-rendered, so a
# gateway that is unreachable from the browser, a handshake that is rejected, or a
# NEXT_PUBLIC_REALTIME_URL that turbo stripped all produce a perfectly good HTML
# document and a dead socket.
#
# The token comes from the web app's own /api/socket-token route, mounted for the
# session, which is exactly how the browser gets one -- AUTH_SECRET never leaves
# the server, and this script never learns it either. Asking the app for the token
# also means a broken minting route fails here rather than as a silent reconnect
# loop in a browser nobody is watching.
echo "==> Opening a socket to the realtime gateway"
socket_token="$(
  curl -s -b "$COOKIES" -c "$COOKIES" "${APP_BASE_URL}/api/socket-token" |
    node -e '
      let raw = "";
      process.stdin.on("data", (chunk) => (raw += chunk));
      process.stdin.on("end", () => {
        try {
          process.stdout.write(String(JSON.parse(raw).token ?? ""));
        } catch {
          /* Not JSON. The caller fails on the empty value with a better message. */
        }
      });
    '
)"
[[ -n "$socket_token" ]] ||
  die "GET ${APP_BASE_URL}/api/socket-token returned no token. The browser could not open a socket either."

CHANNEL_ID="${CHANNEL_HREF##*/}"
# Run from apps/web so `socket.io-client` resolves through that package's own
# node_modules; pnpm's store is not flat, so a bare require from the repo root
# would fail with ERR_MODULE_NOT_FOUND and look like a missing dependency.
# shellcheck disable=SC2016  # JS template literals, not shell expansions; see assert_health.
if ! (
  cd apps/web && SOCKET_URL="$REALTIME_BASE_URL" TOKEN="$socket_token" \
    CHANNEL_ID="$CHANNEL_ID" EXPECT_CHANNEL="$DEMO_CHANNEL" EXPECT_MESSAGE="$DEMO_MESSAGE" node -e '
    const { io } = require("socket.io-client");
    const socket = io(process.env.SOCKET_URL, {
      transports: ["websocket"],
      auth: { token: process.env.TOKEN },
      reconnection: false,
    });
    // Bounded like every other wait in this file. A socket that never connects
    // must fail with a sentence, not hang the CI job until the runner times out.
    const timer = setTimeout(() => {
      console.error("  no channel.state within 15s of connecting");
      process.exit(1);
    }, 15000);
    const fail = (message) => {
      clearTimeout(timer);
      console.error(`  ${message}`);
      process.exit(1);
    };
    socket.on("connect_error", (error) => fail(`handshake refused: ${error.message}`));
    socket.on("server.error", (payload) => fail(`gateway error: ${JSON.stringify(payload)}`));
    socket.on("connect", () => {
      socket.emit("channel.join", { channelId: process.env.CHANNEL_ID }, (ack) => {
        if (!ack || ack.ok !== true) {
          fail(`channel.join was not acknowledged: ${JSON.stringify(ack)}`);
        }
      });
    });
    socket.on("channel.state", (state) => {
      clearTimeout(timer);
      // Content, not merely "an event arrived". An empty channel.state is what a
      // gateway with no database access sends, and it is a 200-shaped failure.
      const messages = Array.isArray(state?.messages) ? state.messages : [];
      if (state?.name !== process.env.EXPECT_CHANNEL) {
        fail(`channel.state named ${JSON.stringify(state?.name)}, not the seeded channel`);
      }
      if (!messages.some((message) => message.body === process.env.EXPECT_MESSAGE)) {
        fail(`channel.state carried no message reading ${JSON.stringify(process.env.EXPECT_MESSAGE)}`);
      }
      // The seq is what this whole project is about. A page of history whose
      // messages have no sequence numbers is a page the client cannot order, and
      // it would render identically to a correct one.
      if (!messages.every((message) => Number.isInteger(message.seq) && message.seq > 0)) {
        fail("channel.state carried a message with no usable seq");
      }
      socket.close();
      process.exit(0);
    });
  '
); then
  tail -40 "$LOG" >&2
  die "the realtime gateway never delivered the seeded channel over a socket. The page renders and the conversation is dead."
fi
echo "    channel.state carried '${DEMO_CHANNEL}' and the seeded message, every seq present"

# --- The symptoms of the original outage, by name ---------------------------
echo "==> Checking the dev log is clean"
PATTERN='ECONNREFUSED|MissingSecret|AUTH_SECRET is not set|AUTH_SECRET must be|Invalid environment|is not defined in the environment'
if grep -qE "$PATTERN" "$LOG"; then
  echo "pnpm dev logged an environment failure even though the pages rendered:" >&2
  grep -nE "$PATTERN" "$LOG" | head -5 >&2
  exit 1
fi

echo
echo "PASS: pnpm dev serves all ${#NAV_PATHS[@]} nav routes from the seeded database,"
echo "      both /health endpoints green (api: postgres+redis+uploads, realtime: redis+adapter),"
echo "      and a socket received the seeded conversation, with ${#ENV_KEYS[@]} .env names stripped."

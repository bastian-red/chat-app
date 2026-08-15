#!/usr/bin/env bash
#
# Start the dev stack: load .env, check the datastores are reachable, hand off to
# turbo.
#
# `turbo run dev` on its own does not read .env. Turbo does not load dotenv files,
# and Next.js only reads a .env inside its own package directory (apps/web/.env),
# which this monorepo does not have. Three sibling projects in this portfolio
# shipped without this wrapper and their documented `pnpm dev` started an API with
# no AUTH_SECRET, which died at boot and left every server render failing with
# ECONNREFUSED. This repo has the wrapper from its first commit.
#
# The env-loading block below is deliberately the same shape as the one in
# scripts/e2e.sh, so the repo has one idiom for this rather than two that can
# drift apart.
#
# Usage: pnpm dev   (package.json points "dev" here)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ ! -f .env ]]; then
  cat >&2 <<'MSG'
No .env in the repo root.

  cp .env.example .env
  sed -i "s|^AUTH_SECRET=|AUTH_SECRET=$(openssl rand -base64 32)|" .env

See README.md, "Running it".
MSG
  exit 1
fi

set -a
# shellcheck disable=SC1091
. ./.env
set +a

# Fail here, naming the variable, rather than 40 lines into a Nest stack trace.
# All three processes verify the same HS256 signature with it -- the web app mints
# the token, the API and the realtime gateway check it -- so a missing secret does
# not merely break sign-in, it makes every socket handshake fail too.
if [[ ${#AUTH_SECRET} -lt 16 ]]; then
  echo "AUTH_SECRET must be at least 16 characters. Generate one:" >&2
  echo "  sed -i \"s|^AUTH_SECRET=.*|AUTH_SECRET=\$(openssl rand -base64 32)|\" .env" >&2
  exit 1
fi

# Postgres and Redis being absent is the other failure that presents as a slow or
# broken page rather than as an error, so it gets named up front too. Uses bash's
# own /dev/tcp rather than nc, which is not installed everywhere.
check_reachable() {
  local url="$1" label="$2" host port
  if [[ ! "$url" =~ ^[a-z+]+://([^@/]*@)?([^:/?#]+):([0-9]+) ]]; then
    return 0 # No explicit host:port to check. Let the app report it.
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
check_reachable "${DATABASE_URL:-}" Postgres || failed=1
# Redis is not optional here the way a cache is. It carries the Socket.io
# adapter's pub/sub, so without it two browser windows on the same channel stop
# seeing each other -- which looks like a bug in the app, not a missing
# datastore.
check_reachable "${REDIS_URL:-}" Redis || failed=1
[[ $failed -eq 0 ]] || exit 1

# `exec` so Ctrl-C reaches turbo directly and the persistent tasks shut down
# cleanly instead of being orphaned behind a wrapper shell.
exec pnpm exec turbo run dev "$@"

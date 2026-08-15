#!/usr/bin/env bash
#
# Prove the seed is deterministic and idempotent, against a real database.
#
# Two properties, both of which everything downstream assumes and neither of
# which a unit test can see:
#
#   deterministic - two runs produce the same conversation. The E2E suite signs in
#                   as a named person and asserts on a named channel and a known
#                   message body, and the README quotes those; a generator that
#                   drifts turns those into flaky failures that look like product
#                   bugs.
#   idempotent    - running it twice leaves one conversation, not two. A missing
#                   `ON DELETE CASCADE`, or a teardown that runs in the wrong
#                   order against a restricting foreign key, shows up here as a
#                   doubled row count or a failed second run and nowhere else.
#
# The digest covers content only: the channel's kind and address, each message's
# seq, author and body, and the set of people it mentions. Primary keys are
# excluded, because they are cuids and differ on every run by design; an id in the
# digest would fail every time and teach nothing.
#
# `seq` IS in the digest, and that is the difference from the sibling project this
# script's shape came from. There, `position` is a jittered fractional index --
# random by construction, so only the *rank* it encodes could be digested. Here the
# sequence is dense and allocated by `UPDATE channels SET next_seq = next_seq + 1
# RETURNING next_seq`, so a deterministic seed must produce byte-identical seqs.
# If it does not, either the seed is racing itself or the allocator is not doing
# what the whole project claims it does.
#
#   ./scripts/seed-check.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

# `.env` when there is one, the environment otherwise, and .env.example's value
# as the last resort -- the same three-step shape scripts/integration.sh and
# scripts/e2e.sh use. This file used to require `.env` outright, which was fine
# locally and wrong on CI: the integration job hands DATABASE_URL in through the
# job's `env:` block and never writes a dotenv file, so the check exited 1 with
# one line of output before it read a single row. A lane that cannot run where it
# is meant to run is not a lane.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgresql://chat:chat@localhost:5438/chat?schema=public}"

# Prisma's URL carries `?schema=public`, which libpq rejects outright.
PSQL_URL="${DATABASE_URL%%\?*}"

# The demo account's email, read out of the seed rather than retyped, for the same
# reason scripts/dev-smoke.sh reads it: a copy that drifts produces a digest
# confidently computed over zero rows, which passes.
DEMO_EMAIL="$(sed -n "s/^const DEMO_EMAIL = '\([^']*\)';.*/\1/p" packages/db/prisma/seed.ts)"
[[ -n "$DEMO_EMAIL" ]] ||
  { echo "could not read DEMO_EMAIL out of packages/db/prisma/seed.ts." >&2; exit 1; }

# `string_agg` needs the ORDER BY: without it the row order is whatever the
# planner produced, and the digest changes between two identical conversations.
#
# Scoped to the channels the demo account is a member of, so a stray row left by
# some other lane cannot move the digest.
#
# A DM has no slug and is collapsed to the literal 'dm' rather than addressed by
# `dm_key`. The key is `least(a,b):greatest(a,b)` over two user cuids, which are
# regenerated on every run, so digesting it would report a correct seed as
# non-deterministic every single time. What a DM contributes to the digest is its
# messages, which is the part that has to stay put.
read -r -d '' DIGEST_SQL <<'SQL_END' || true
SELECT count(*) || ' ' || coalesce(md5(string_agg(x, '|' ORDER BY x)), '-')
FROM (
  SELECT ch.kind
         || ':' || coalesce(ch.slug, 'dm')
         || ':' || m.seq
         || ':' || coalesce(author.email, '-')
         || ':' || m.body
         || ':' || coalesce(
              (SELECT string_agg(mentioned.email, ',' ORDER BY mentioned.email)
                 FROM mentions mn
                 JOIN users mentioned ON mentioned.id = mn.user_id
                WHERE mn.message_id = m.id), '-') AS x
  FROM messages m
  JOIN channels ch ON ch.id = m.channel_id
  -- LEFT, because author_id is SetNull on user delete and a message outlives its
  -- author. An INNER join here would silently drop exactly the rows that prove
  -- the tombstone and orphan handling work.
  LEFT JOIN users author ON author.id = m.author_id
  WHERE EXISTS (
    SELECT 1 FROM channel_members cm
      JOIN users demo ON demo.id = cm.user_id
     WHERE cm.channel_id = ch.id AND demo.email = :'demo_email'
  )
) conversation;
SQL_END

# The SQL goes in on stdin, not through --command, and that is not a style
# choice: psql performs variable interpolation on input it reads, and does NOT
# perform it on a string given with -c. With --command the `:'demo_email'` above
# reaches the server verbatim and Postgres answers
#
#   ERROR:  syntax error at or near ":"
#
# The alternative -- pasting the address straight into the SQL -- would work here
# and is how a seed value ends up concatenated into a query somewhere it matters.
# `--variable` plus stdin quotes and escapes it properly for nothing.
digest() {
  printf '%s\n' "$DIGEST_SQL" |
    psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align \
      --variable "demo_email=${DEMO_EMAIL}"
}

# Three invariants the digest cannot see, asked of Postgres directly. Each is
# something the schema is supposed to make impossible, so a non-zero answer means
# a constraint from the 20260811090000_chat_invariants migration is missing or was
# dropped -- and every one of them would otherwise ship green.
#
#   duplicates - two messages sharing a (channel_id, seq). `UNIQUE (channel_id,
#                seq)` forbids it. Two messages at one seq is two clients
#                disagreeing about what the conversation said, permanently.
#   gaps       - a channel where max(seq) <> count(*). The sequence is DENSE, and
#                density is the requirement rather than a simplification: "have I
#                missed anything?" is answerable only if the absence of n+1 means
#                something. Soft deletes keep their row and their seq, so this
#                stays exact -- a hard delete anywhere would show up here.
#   owners     - a channel with two OWNERs, which
#                `channel_members_one_owner_per_channel` (a partial unique index,
#                the only way to say "at most one" in Postgres) forbids. Two
#                owners makes "who may delete this channel" a query with two
#                answers, which is a permission check that depends on row order.
read -r -d '' INVARIANT_SQL <<'SQL_END' || true
SELECT
  (SELECT coalesce(sum(n - 1), 0) FROM (
     SELECT count(*) AS n FROM messages GROUP BY channel_id, seq HAVING count(*) > 1
   ) d)
  || '|' ||
  (SELECT count(*) FROM (
     SELECT channel_id FROM messages GROUP BY channel_id HAVING max(seq) <> count(*)
   ) g)
  || '|' ||
  (SELECT count(*) FROM (
     SELECT channel_id FROM channel_members WHERE role = 'OWNER'
      GROUP BY channel_id HAVING count(*) > 1
   ) o);
SQL_END

run_seed() {
  pnpm --filter @chat/db exec tsx prisma/seed.ts >/dev/null
}

echo "seed-check: first run"
run_seed
FIRST="$(digest)"
echo "  $FIRST"

echo "seed-check: second run"
run_seed
SECOND="$(digest)"
echo "  $SECOND"

if [[ "$FIRST" != "$SECOND" ]]; then
  echo >&2
  echo "FAIL: the seed is not deterministic or not idempotent." >&2
  echo "  run 1: $FIRST" >&2
  echo "  run 2: $SECOND" >&2
  echo "A changed message count means the teardown left rows behind, or a cascade" >&2
  echo "is missing. The same count with a changed digest means something in the" >&2
  echo "generator reads the clock or Math.random, or that the seq allocation is" >&2
  echo "not deterministic under the order the seed writes in." >&2
  exit 1
fi

if [[ "${FIRST%% *}" == "0" ]]; then
  echo "FAIL: the seed produced no messages." >&2
  echo "A digest over zero rows is stable across two runs and proves nothing." >&2
  exit 1
fi

INVARIANTS="$(printf '%s\n' "$INVARIANT_SQL" |
  psql "$PSQL_URL" --no-psqlrc --quiet --tuples-only --no-align)"
IFS='|' read -r DUP_SEQ GAPPY MULTI_OWNER <<<"$INVARIANTS"

failed=0
if [[ "$DUP_SEQ" != "0" ]]; then
  echo "FAIL: ${DUP_SEQ} message(s) share a (channel_id, seq) with another message." >&2
  echo "The UNIQUE (channel_id, seq) index is missing or was dropped." >&2
  failed=1
fi
if [[ "$GAPPY" != "0" ]]; then
  echo "FAIL: ${GAPPY} channel(s) have a gap in their sequence (max(seq) <> count(*))." >&2
  echo "Either a message was hard-deleted, or the seq allocator skipped a number." >&2
  echo "A gap is indistinguishable from a message a client has not received yet," >&2
  echo "so every reader of that channel catches up forever." >&2
  failed=1
fi
if [[ "$MULTI_OWNER" != "0" ]]; then
  echo "FAIL: ${MULTI_OWNER} channel(s) have more than one OWNER." >&2
  echo "channel_members_one_owner_per_channel is missing or was dropped." >&2
  failed=1
fi
[[ $failed -eq 0 ]] || exit 1

echo
echo "PASS: two runs, ${FIRST%% *} messages, identical content digest,"
echo "      no duplicate seq, no gap in any channel, at most one owner each."

import { defineConfig } from 'vitest/config';

// Integration lane: needs a real Postgres, a real Redis, and two real gateway
// processes on :4100 and :4101 (started by scripts/integration.sh). These tests
// are the proof of both halves of the technical challenge this project is judged
// on, and neither can be shown without real infrastructure:
//
//   - Ordered delivery. A mocked database cannot serialise two concurrent
//     `UPDATE channels SET next_seq = next_seq + 1 RETURNING next_seq`
//     statements, which is the entire mechanism behind a gapless seq. The
//     in-memory repository in services/messaging returns whatever the fake
//     counter says and would pass against a SELECT-then-UPDATE allocator.
//   - Horizontal scaling. A single in-process Socket.io server broadcasts
//     correctly whether or not the Redis adapter is wired, so a one-process
//     assertion is vacuous. Two processes is the smallest number at which the
//     pub/sub path can fail.
//
// Serial by design: the files share one seeded channel, and the concurrency test
// deliberately races writers into one sequence, so a second file running at the
// same time would make its assertions non-deterministic.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});

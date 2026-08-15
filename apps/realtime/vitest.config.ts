import { defineConfig } from 'vitest/config';

// Gate lane. The gateway's decisions -- who may join a room, which ack a failure
// maps to, when a socket has spent its event budget, whether a catch-up gap is
// too large to splice -- are pure functions in `dispatch.ts`, `rate-limit.ts` and
// `config.ts`, so they are tested here without a socket server.
//
// The one thing this lane deliberately does not attempt is the Redis adapter. Two
// processes is the smallest number at which cross-replica broadcast can fail, and
// a test that starts one server proves the opposite of what it looks like it
// proves. That assertion lives in the integration lane, which runs two real
// gateways on :4100 and :4101.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});

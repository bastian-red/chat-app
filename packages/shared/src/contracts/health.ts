/**
 * The health contract, shared by both services.
 *
 * One schema for `apps/api` and `apps/realtime`, because the /status page renders
 * them side by side and a reader comparing two shapes learns nothing. The
 * difference between the two lives in `checks[]`, not in the envelope: the API
 * reports `postgres` and `redis`, the gateway reports `redis`, `adapter` and its
 * socket counts.
 *
 * `status` is `ok` or `degraded`, and the HTTP status code follows it (200 or
 * 503). Both matter: `scripts/dev-smoke.sh` parses the body because a 503 that
 * names the failing check is far more useful than a bare code, and the Docker
 * HEALTHCHECKs read the code because a container runtime cannot parse JSON.
 */
import { z } from 'zod';

export const healthCheckSchema = z.object({
  name: z.string(),
  status: z.enum(['ok', 'fail']),
  latencyMs: z.number(),
  detail: z.string().nullable(),
});

export const healthSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  uptimeSeconds: z.number(),
  checks: z.array(healthCheckSchema),
});

/**
 * The gateway's extra facts, present only on `apps/realtime`.
 *
 * Optional rather than a separate schema so the /status page can render one
 * component for both services. `connectedSockets` and `rooms` are what turn a
 * green tick into something diagnosable: a gateway with zero sockets after a
 * deploy is either idle or unreachable, and the number is the first question
 * anybody asks.
 */
export const realtimeHealthSchema = healthSchema.extend({
  connectedSockets: z.number().int().nonnegative().optional(),
  rooms: z.number().int().nonnegative().optional(),
});

export type HealthCheck = z.infer<typeof healthCheckSchema>;
export type Health = z.infer<typeof healthSchema>;
export type RealtimeHealth = z.infer<typeof realtimeHealthSchema>;

/**
 * Auth.js's HTTP surface.
 *
 * Re-exported rather than reimplemented: `/api/auth/csrf`, `/api/auth/session`
 * and `/api/auth/callback/credentials` are a stable interface, and
 * `scripts/dev-smoke.sh` signs in through exactly those three the way a browser
 * does. A hand-rolled sign-in route would work and would take that lane's ability
 * to test the real path with it.
 */
import { handlers } from '../../../../auth';

export const { GET, POST } = handlers;

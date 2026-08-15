import type { ReactNode } from 'react';

import { Nav } from '../../components/nav';

/**
 * The same chrome as the signed-in shell, without the session.
 *
 * `/status` is deliberately reachable without signing in: it reports dependency
 * state and no data, and a page that needed a credential is a page nobody can
 * check during the outage it exists to describe. That is why it sits outside the
 * `(app)` route group.
 *
 * It still carries the nav, for two reasons. A reader who is signed in reaches it
 * from that nav and should not fall off the edge of the app when they do; and
 * `scripts/dev-smoke.sh` loads every route in `components/nav.tsx` and asserts the
 * chrome is present, because a 200 with no chrome is what an error boundary
 * renders.
 *
 * No `auth()` call here, so the route stays as cheap as it is public.
 */
export default function StatusLayout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header className="shell-header">
        <span className="shell-brand">chat</span>
        <Nav current="/status" />
      </header>
      <main className="shell-main" id="main">
        {children}
      </main>
    </div>
  );
}

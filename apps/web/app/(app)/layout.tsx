import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { Nav } from '../../components/nav';
import { auth, signOut } from '../../auth';

/**
 * The shell every signed-in route sits in.
 *
 * The session is read **here**, in a route-group layout, and deliberately not in
 * the root `app/layout.tsx`. A root layout that awaits `auth()` opts every route
 * in the app into dynamic rendering, including the landing page and `/login`,
 * which have no session to read and are the two pages that most want to be
 * static. A sibling repo lost static rendering on every route that way and the
 * only symptom was a slower cold page nobody could attribute.
 *
 * The redirect is the authorisation boundary for the *browser*, not for the data:
 * every API call is authenticated by its own service token, so a reader who
 * skipped this page would still get a 401 from the API rather than somebody
 * else's messages.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  return (
    <div className="shell">
      <header className="shell-header">
        <span className="shell-brand">chat</span>
        <Nav current="/channels" />
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/login' });
          }}
        >
          <button className="button button-quiet" type="submit">
            Sign out as {session.user.name}
          </button>
        </form>
      </header>
      <main className="shell-main" id="main">
        {children}
      </main>
    </div>
  );
}

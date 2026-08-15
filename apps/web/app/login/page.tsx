import Link from 'next/link';

import { SignInForm } from '../../components/sign-in-form';

/**
 * Sign in.
 *
 * Static, and it must stay that way: it is the page a signed-out reader lands on,
 * and it has no session to read. That is the whole reason `auth()` is called in
 * `app/(app)/layout.tsx` rather than in the root layout.
 */
export const metadata = { title: 'Sign in' };

export default function LoginPage() {
  return (
    <div className="page">
      <div className="panel stack">
        <h1 className="panel-title">Sign in</h1>
        <SignInForm />
        <p className="status-note">
          No account yet? <Link href="/signup">Create one</Link>.
        </p>
      </div>
    </div>
  );
}

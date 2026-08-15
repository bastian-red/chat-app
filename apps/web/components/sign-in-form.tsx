'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The credentials form.
 *
 * `redirect: false` so the failure can be rendered on this page rather than
 * bouncing through Auth.js's error route, which would replace the form the reader
 * has already filled in.
 *
 * **The failure message does not say which half was wrong.** "No such account" and
 * "wrong password" are the same answer to anybody who is not the account holder,
 * and the API equalises the timing of the two for the same reason. A friendlier
 * message here would undo that at the last step.
 */
export function SignInForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        setBusy(true);
        setError(null);

        void signIn('credentials', {
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
          redirect: false,
        }).then((result) => {
          setBusy(false);
          if (result?.error) {
            setError('That email and password do not match an account.');
            return;
          }
          router.push('/channels');
          router.refresh();
        });
      }}
    >
      <label className="field">
        <span className="field-label">Email</span>
        <input className="field-input" name="email" type="email" required autoComplete="username" />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input
          className="field-input"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
      </label>
      {/* `role="alert"` so a screen reader is told the attempt failed. Without it
          the only signal is a colour change the reader cannot see. */}
      {error === null ? null : (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? 'Signing in' : 'Sign in'}
      </button>
    </form>
  );
}

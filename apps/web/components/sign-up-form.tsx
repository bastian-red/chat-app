'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { publicApiBaseUrl } from '../lib/config';

/**
 * Register, then sign in with the same credentials.
 *
 * Two calls rather than one, and deliberately: the API's register route returns a
 * session shape and no token, because minting is the web app's job (one minter,
 * two verifiers). Signing in immediately afterwards is what turns that into a
 * cookie, and it also means the sign-in path is exercised on every new account
 * rather than only by returning readers.
 *
 * The time zone is read from the browser and sent once, at registration. It is
 * stored on the user row from then on, because the conversation's day dividers
 * are computed against the reader's *stored* zone: deriving it per render would
 * move every divider the moment somebody travelled, including on messages they
 * had already read.
 */
export function SignUpForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const email = String(form.get('email') ?? '');
        const password = String(form.get('password') ?? '');
        setBusy(true);
        setError(null);

        void (async () => {
          const response = await fetch(`${publicApiBaseUrl}/auth/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email,
              password,
              name: String(form.get('name') ?? ''),
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            }),
          });

          if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { message?: string } | null;
            setBusy(false);
            setError(body?.message ?? 'That account could not be created.');
            return;
          }

          const result = await signIn('credentials', { email, password, redirect: false });
          setBusy(false);
          if (result?.error) {
            setError('The account was created but signing in failed. Try signing in.');
            return;
          }
          router.push('/channels');
          router.refresh();
        })();
      }}
    >
      <label className="field">
        <span className="field-label">Name</span>
        <input className="field-input" name="name" required autoComplete="name" />
      </label>
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
          minLength={12}
          autoComplete="new-password"
        />
        {/* The rule, stated before the request rather than after it. A length
            requirement discovered by being refused is a form somebody fills in
            twice. */}
        <span className="field-hint">At least 12 characters. Length is what actually helps.</span>
      </label>
      {error === null ? null : (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? 'Creating' : 'Create account'}
      </button>
    </form>
  );
}

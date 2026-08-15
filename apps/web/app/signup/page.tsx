import Link from 'next/link';

import { SignUpForm } from '../../components/sign-up-form';

export const metadata = { title: 'Create an account' };

export default function SignUpPage() {
  return (
    <div className="page">
      <div className="panel stack">
        <h1 className="panel-title">Create an account</h1>
        <SignUpForm />
        <p className="status-note">
          Already have one? <Link href="/login">Sign in</Link>.
        </p>
      </div>
    </div>
  );
}

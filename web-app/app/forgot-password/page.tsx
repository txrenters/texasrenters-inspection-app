'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';

import { api } from '@/lib/api';


export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    // Ours rather than Supabase's resetPasswordForEmail: that sent the stock
    // template, and tied the link to a verifier held only by this browser, so
    // opening the mail on a phone could never complete. The API mints the link
    // with the service role and sends it through the same mailer as every other
    // message from the product.
    try {
      await api<void>('/api/v1/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      // Always the same outcome. Whether the address has an account is not
      // something this form is willing to tell an anonymous visitor.
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The reset email could not be sent.');
    }
  };
  return (
    <main className="auth-page">
      <section className="auth-card">
        <span className="auth-eyebrow">ACCOUNT RECOVERY</span>
        <h1>Reset your password</h1>
        <p>Enter your administrator email and we’ll send a secure reset link.</p>
        {sent ? (
          <div className="auth-success" role="status">
            <strong>Check your inbox</strong>
            <span>A reset link was sent if the account exists.</span>
          </div>
        ) : (
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <Field>
              <FieldLabel htmlFor="email">Email address</FieldLabel>
              <Input
                id="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </Field>
            {error ? <div className="auth-error">{error}</div> : null}
            <button className={buttonVariants({ variant: 'primary' })}>Send reset link</button>
          </form>
        )}
        <Link className="auth-back" href="/login">
          ← Back to sign in
        </Link>
      </section>
    </main>
  );
}

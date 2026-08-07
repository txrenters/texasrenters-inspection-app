'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';

import { firstUnmetPasswordRule } from '@texasrenters/shared';

import { api, publicApiSend } from '@/lib/api';
import { signOut } from '@/lib/session';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [required, setRequired] = useState(false);
  const [linkState, setLinkState] = useState<'checking' | 'ready' | 'invalid'>('checking');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  // The token is redeemed at submit, not exchanged for a session on arrival.
  // The Supabase flow it replaces turned the emailed link into a full sign-in
  // before the form was even filled in — so anyone holding the mail was
  // authenticated and merely trusted to change the password. There is no
  // session anywhere in this flow now, and nothing to validate up front:
  // checking the token early would have to consume it.
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isRequired = params.get('required') === '1';
    setRequired(isRequired);
    if (isRequired) {
      setLinkState('ready');
      return;
    }
    const linkToken = params.get('token');
    setToken(linkToken);
    setLinkState(linkToken ? 'ready' : 'invalid');
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const unmet = firstUnmetPasswordRule(password);
    if (unmet) {
      setError(unmet.message);
      return;
    }
    if (password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }
    setError(undefined);
    try {
      if (required) {
        await api<void>('/api/v1/auth/change-required-password', {
          method: 'POST',
          body: JSON.stringify({ password }),
        });
        // The password changed, so every session opened with the old one is
        // now dead server-side. Clearing the cookies here keeps this tab from
        // acting signed in until its next request finds out.
        await signOut();
      } else {
        await publicApiSend<void>('/api/v1/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token, password }),
        });
      }
      setDone(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The password could not be updated.');
    }
  };
  return (
    <main className="auth-page">
      <section className="auth-card">
        <span className="auth-eyebrow">
          {required ? 'TEMPORARY PASSWORD REPLACEMENT' : 'SECURE PASSWORD RESET'}
        </span>
        <h1>{required ? 'Create your permanent password' : 'Choose a new password'}</h1>
        {required ? (
          <p>Your temporary password must be replaced before administrator access is enabled.</p>
        ) : null}
        {!required && linkState !== 'ready' && !done ? (
          /* Said before the form rather than after a failed submit: a spent or
             foreign-browser link cannot be fixed by anything typed here, and
             the only useful action is to ask for a new one. */
          linkState === 'checking' ? (
            <p>Checking your reset link…</p>
          ) : (
            <>
              <div className="auth-error" role="alert">
                <strong>This reset link is no longer usable</strong>
                <span>
                  It may have already been used, expired, or been opened in a different browser
                  from the one that requested it.
                </span>
              </div>
              <Link className={buttonVariants({ variant: 'primary' })} href="/forgot-password">
                Request a new link
              </Link>
            </>
          )
        ) : done ? (
          <>
            <div className="auth-success">Your password was updated.</div>
            <Link className={buttonVariants({ variant: 'primary' })} href="/login">
              Continue to sign in
            </Link>
          </>
        ) : (
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <Field>
              <FieldLabel htmlFor="password">New password</FieldLabel>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="password-confirmation">Confirm new password</FieldLabel>
              <Input
                id="password-confirmation"
                type="password"
                autoComplete="new-password"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </Field>
            {error ? <div className="auth-error">{error}</div> : null}
            <button className={buttonVariants({ variant: 'primary' })}>Update password</button>
          </form>
        )}
      </section>
    </main>
  );
}

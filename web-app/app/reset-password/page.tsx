'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';

import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';

/**
 * Mirrors ChangeRequiredPasswordDto on the API, rule for rule.
 *
 * This page can post to `change-required-password`, which enforces exactly
 * these. Checking eight characters here while the API asked for its own set
 * meant a password could pass the form and be refused by the server.
 */
const PASSWORD_RULES: { test: (value: string) => boolean; message: string }[] = [
  { test: (value) => value.length >= 6, message: 'Use at least 6 characters.' },
  { test: (value) => /[A-Z]/.test(value), message: 'Include at least one capital letter.' },
  { test: (value) => /[0-9]/.test(value), message: 'Include at least one number.' },
  {
    test: (value) => /[^A-Za-z0-9]/.test(value),
    message: 'Include at least one special character.',
  },
];

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [required, setRequired] = useState(false);
  const [linkState, setLinkState] = useState<'checking' | 'ready' | 'invalid'>('checking');
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const isRequired = params.get('required') === '1';
    setRequired(isRequired);
    if (isRequired) {
      setLinkState('ready');
      return;
    }
    // The browser client uses PKCE, so a recovery link arrives as ?code= and
    // has to be exchanged for a session before updateUser will do anything.
    // Without this the form submitted against no session at all and failed with
    // whatever Supabase said about a missing session — which is why resetting a
    // password never worked, though the email itself arrived fine.
    const code = params.get('code');
    void (async () => {
      if (code) {
        const exchanged = await supabase().auth.exchangeCodeForSession(code);
        setLinkState(exchanged.error ? 'invalid' : 'ready');
        return;
      }
      // No code: either the link was opened in a different browser from the one
      // that asked, or it has already been used.
      const session = await supabase().auth.getSession();
      setLinkState(session.data.session ? 'ready' : 'invalid');
    })();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const unmet = PASSWORD_RULES.find((rule) => !rule.test(password));
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
        await supabase().auth.signOut({ scope: 'local' });
      } else {
        const result = await supabase().auth.updateUser({ password });
        if (result.error) throw result.error;
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

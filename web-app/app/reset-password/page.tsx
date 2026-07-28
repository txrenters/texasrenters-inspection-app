'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Input } from '@/components/ui/input';
import { Field, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';

import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [required, setRequired] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setRequired(new URLSearchParams(window.location.search).get('required') === '1');
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < 8) {
      setError('Use at least 8 characters.');
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
        {done ? (
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

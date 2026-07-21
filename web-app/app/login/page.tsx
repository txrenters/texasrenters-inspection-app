'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';

const schema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

export default function LoginPage() {
  const router = useRouter();
  const auth = useAuth();
  const [error, setError] = useState<string>();
  const [errorTitle, setErrorTitle] = useState('Sign in failed');
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });
  const submit = form.handleSubmit(async (values) => {
    setError(undefined);
    setErrorTitle('Sign in failed');
    const result = await supabase().auth.signInWithPassword(values);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    if (result.data.user?.app_metadata.must_change_password === true) {
      router.replace('/reset-password?required=1');
      return;
    }
    const verification = await auth.refresh();
    if (!verification.profile) {
      setErrorTitle('Administrator access unavailable');
      setError(
        verification.error ??
          'Your session is valid, but administrator access could not be loaded.',
      );
      return;
    }
    router.replace('/dashboard');
  });
  return (
    <main className="auth-page">
      <section className="auth-card">
        <div className="brand auth-brand">
          <div className="brand-mark">★</div>
          <div>
            <strong>
              <span>Texas</span>Renters
            </strong>
            <small>Inspection Administration</small>
          </div>
        </div>
        <div>
          <span className="auth-eyebrow">SECURE ADMINISTRATOR ACCESS</span>
          <h1>Welcome back</h1>
          <p>Sign in to manage properties, inspections, assignments, and integrations.</p>
        </div>
        <form onSubmit={submit} className="stack" noValidate>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input id="email" autoComplete="email" {...form.register('email')} />
            {form.formState.errors.email ? (
              <span className="field-error">{form.formState.errors.email.message}</span>
            ) : null}
          </div>
          <div className="field">
            <div className="label-line">
              <label htmlFor="password">Password</label>
              <Link href="/forgot-password">Forgot password?</Link>
            </div>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
            {form.formState.errors.password ? (
              <span className="field-error">{form.formState.errors.password.message}</span>
            ) : null}
          </div>
          {error ? (
            <div className="auth-error" role="alert">
              <strong>{errorTitle}</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <button
            className="button button-primary"
            disabled={form.formState.isSubmitting}
            type="submit"
          >
            {form.formState.isSubmitting ? 'Verifying account…' : 'Sign in'}
          </button>
        </form>
        <p className="auth-footnote">
          Administrator accounts are provisioned by TexasRenters. Public registration is disabled.
        </p>
      </section>
    </main>
  );
}

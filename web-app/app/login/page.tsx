'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Input } from '@/components/ui/input';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { buttonVariants } from '@/components/ui/button';

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
        {/* The real wordmark, not a star glyph standing in for it. "Inspection"
            is set as its own line beneath rather than run on: the logo already
            says who this is, so the line under it only has to say which product
            — and the two used to collide into "TexasRentersInspection". */}
        <div className="flex flex-col items-start gap-2.5">
          <Image
            alt="TexasRenters.com"
            className="h-auto w-[220px] max-w-full"
            height={64}
            priority
            src="/texasrenterslogo-transparent.png"
            width={220}
          />
          <span className="text-[13px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Inspection
          </span>
        </div>
        <div>
          <span className="auth-eyebrow">Secure administrator access</span>
          <h1>Welcome back</h1>
          <p>Sign in to manage properties, inspections, assignments, and integrations.</p>
        </div>
        <form onSubmit={submit} className="stack" noValidate>
          <Field>
            <FieldLabel htmlFor="email">Email address</FieldLabel>
            <Input id="email" autoComplete="email" {...form.register('email')} />
            {form.formState.errors.email ? (
              <FieldError>{form.formState.errors.email.message}</FieldError>
            ) : null}
          </Field>
          <Field>
            <div className="label-line">
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <Link href="/forgot-password">Forgot password?</Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
            {form.formState.errors.password ? (
              <FieldError>{form.formState.errors.password.message}</FieldError>
            ) : null}
          </Field>
          {error ? (
            <div className="auth-error" role="alert">
              <strong>{errorTitle}</strong>
              <span>{error}</span>
            </div>
          ) : null}
          <button
            className={buttonVariants({ variant: 'primary' })}
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

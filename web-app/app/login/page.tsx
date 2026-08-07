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
import { signIn } from '@/lib/session';

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
    let session;
    try {
      session = await signIn(values.email, values.password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign in failed.');
      return;
    }
    if (session.mustChangePassword) {
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
      <div className="auth-split">
        {/* Brand on its own side so the form column carries nothing but the
            form. Below 860px this collapses above it and the supporting points
            drop away — on a phone the form is the whole reason for the screen. */}
        <aside className="auth-aside">
          <div className="flex flex-col items-start gap-2.5">
            <Image
              alt="TexasRenters.com"
              className="h-auto w-[240px] max-w-full"
              height={70}
              priority
              src="/texasrenterslogo-transparent.png"
              width={240}
            />
            <span className="text-[13px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              Inspection
            </span>
          </div>
          <p className="auth-aside-copy">
            Property condition captured on site, reviewed in one place, and kept as evidence for the
            whole tenancy.
          </p>
          <ul className="auth-aside-points">
            <li>Floor-plan areas with video and photo evidence</li>
            <li>AI-assisted findings that a person approves</li>
            <li>Move-in and move-out compared side by side</li>
          </ul>
        </aside>

        <section className="auth-card">
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
      </div>
    </main>
  );
}

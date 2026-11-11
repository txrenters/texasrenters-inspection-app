'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { AuthLayout } from '@/components/auth-layout';
import { PasswordInput } from '@/components/password-input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/lib/auth';
import { PORTAL_REFUSAL_MESSAGES, portalRefusalOf, portalSignInPath } from '@/lib/portal';
import { signIn } from '@/lib/session';

const schema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
  /** "Remember me" (the office, 2026-10-02). Off by default: a workstation may be shared. */
  remember: z.boolean(),
});

export default function LoginPage() {
  const router = useRouter();
  const auth = useAuth();
  const [error, setError] = useState<string>();
  const [errorTitle, setErrorTitle] = useState('Sign in failed');
  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '', remember: false },
  });
  // "Sign in with TR Staff Portal", shown only once the API says it is on: a
  // console with the portal switched off looks exactly as it did before.
  const [portalEnabled, setPortalEnabled] = useState(false);
  const [portalHref, setPortalHref] = useState(portalSignInPath());

  useEffect(() => {
    // Read here rather than with useSearchParams, which would make this
    // statically rendered page wait on a Suspense boundary.
    const params = new URLSearchParams(window.location.search);
    setPortalHref(portalSignInPath(params.get('next')));
    // A refusal from the portal's callback. Only a known code picks one of the
    // fixed sentences; anything else in the URL is ignored.
    const refusal = portalRefusalOf(params.get('portal_error'));
    if (refusal) {
      setErrorTitle('Could not sign you in with TR Staff Portal');
      setError(PORTAL_REFUSAL_MESSAGES[refusal]);
    }

    let cancelled = false;
    void fetch('/api/session/portal')
      .then((response) => (response.ok ? (response.json() as Promise<{ enabled?: unknown }>) : null))
      .then((body) => {
        if (!cancelled && body?.enabled === true) setPortalEnabled(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = form.handleSubmit(async (values) => {
    setError(undefined);
    setErrorTitle('Sign in failed');
    let session;
    try {
      session = await signIn(values.email, values.password, values.remember);
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
        verification.error ?? 'Your session is valid, but administrator access could not be loaded.',
      );
      return;
    }
    router.replace('/dashboard');
  });

  return (
    <AuthLayout
      title="Welcome back"
      description="Sign in to manage properties, inspections, assignments and integrations."
      footer="Administrator accounts are provisioned by TexasRenters. Public registration is disabled."
    >
      {portalEnabled ? (
        <div className="mb-4 grid gap-4">
          {/* A plain link: the route handler behind it sends the browser to the portal. */}
          <a className={buttonVariants({ className: 'w-full' })} href={portalHref}>
            Sign in with TR Staff Portal
          </a>
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span className="bg-border h-px flex-1" />
            or sign in with your password
            <span className="bg-border h-px flex-1" />
          </div>
        </div>
      ) : null}

      <form className="grid gap-4" noValidate onSubmit={submit}>
        <Field>
          <FieldLabel htmlFor="email">Email address</FieldLabel>
          <Input
            aria-invalid={form.formState.errors.email ? true : undefined}
            autoComplete="email"
            id="email"
            // The email keyboard on a phone, and announced as an email field
            // (console-development). `noValidate` on the form keeps the zod
            // message as the only one.
            type="email"
            {...form.register('email')}
          />
          <FieldError>{form.formState.errors.email?.message}</FieldError>
        </Field>

        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <Link
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              href="/forgot-password"
            >
              Forgot password?
            </Link>
          </div>
          <PasswordInput
            aria-invalid={form.formState.errors.password ? true : undefined}
            autoComplete="current-password"
            id="password"
            {...form.register('password')}
          />
          <FieldError>{form.formState.errors.password?.message}</FieldError>
        </Field>

        {/* Said plainly what it does and when not to use it, because the
            default -- signed out when the browser closes -- is the safe one on
            a shared office computer. */}
        <label className="flex cursor-pointer items-start gap-2.5" htmlFor="remember">
          <Controller
            control={form.control}
            name="remember"
            render={({ field }) => (
              <Checkbox
                checked={field.value}
                className="mt-0.5"
                id="remember"
                onBlur={field.onBlur}
                onCheckedChange={(checked) => field.onChange(checked === true)}
              />
            )}
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">Remember me</span>
            <span className="text-muted-foreground text-xs leading-relaxed">
              Stay signed in on this computer, even after closing the browser, until 30 days
              without use. Leave it off on a shared computer.
            </span>
          </span>
        </label>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{errorTitle}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Button
          className="w-full"
          disabled={form.formState.isSubmitting}
          type="submit"
          // The portal is the main way in once it is on; the password is the second.
          variant={portalEnabled ? 'outline' : 'default'}
        >
          {form.formState.isSubmitting ? (
            <>
              <Spinner />
              Verifying account…
            </>
          ) : (
            'Sign in'
          )}
        </Button>
      </form>
    </AuthLayout>
  );
}

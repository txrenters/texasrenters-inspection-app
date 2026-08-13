'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { AuthLayout } from '@/components/auth-layout';
import { PasswordInput } from '@/components/password-input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
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
      <form className="grid gap-4" noValidate onSubmit={submit}>
        <Field>
          <FieldLabel htmlFor="email">Email address</FieldLabel>
          <Input
            aria-invalid={form.formState.errors.email ? true : undefined}
            autoComplete="email"
            id="email"
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

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{errorTitle}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Button className="w-full" disabled={form.formState.isSubmitting} type="submit">
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

'use client';

import { CheckCircle2Icon } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';

import { PASSWORD_RULES, firstUnmetPasswordRule } from '@texasrenters/shared';

import { AuthLayout } from '@/components/auth-layout';
import { PasswordInput, PasswordRules } from '@/components/password-input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Spinner } from '@/components/ui/spinner';
import { api, publicApiSend } from '@/lib/api';
import { signOut } from '@/lib/session';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [required, setRequired] = useState(false);
  const [linkState, setLinkState] = useState<'checking' | 'ready' | 'invalid'>('checking');
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
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

  const mismatch = confirmation.length > 0 && password !== confirmation;

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
    setPending(true);
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
    } finally {
      setPending(false);
    }
  };

  const title = required ? 'Create your permanent password' : 'Choose a new password';
  const description = required
    ? 'Your temporary password must be replaced before administrator access is enabled.'
    : undefined;

  if (done) {
    return (
      <AuthLayout title={title}>
        <div className="grid gap-4">
          <Alert variant="success">
            <CheckCircle2Icon />
            <AlertTitle>Your password was updated</AlertTitle>
          </Alert>
          <Button asChild className="w-full">
            <Link href="/login">Continue to sign in</Link>
          </Button>
        </div>
      </AuthLayout>
    );
  }

  // Said before the form rather than after a failed submit: a spent or
  // foreign-browser link cannot be fixed by anything typed here, and the only
  // useful action is to ask for a new one.
  if (!required && linkState !== 'ready') {
    return (
      <AuthLayout title={title}>
        {linkState === 'checking' ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Spinner />
            Checking your reset link…
          </p>
        ) : (
          <div className="grid gap-4">
            <Alert variant="destructive">
              <AlertTitle>This reset link is no longer usable</AlertTitle>
              <AlertDescription>
                It may have already been used, expired, or been opened in a different browser from
                the one that requested it.
              </AlertDescription>
            </Alert>
            <Button asChild className="w-full">
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
          </div>
        )}
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={title} description={description}>
      <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
        <Field>
          <FieldLabel htmlFor="password">New password</FieldLabel>
          <PasswordInput
            autoComplete="new-password"
            id="password"
            onChange={(event) => setPassword(event.target.value)}
            value={password}
          />
        </Field>

        <PasswordRules rules={PASSWORD_RULES} value={password} />

        <Field>
          <FieldLabel htmlFor="password-confirmation">Confirm new password</FieldLabel>
          <PasswordInput
            aria-invalid={mismatch || undefined}
            autoComplete="new-password"
            id="password-confirmation"
            onChange={(event) => setConfirmation(event.target.value)}
            value={confirmation}
          />
          {mismatch ? (
            <p className="text-destructive text-xs font-medium" role="alert">
              Passwords do not match.
            </p>
          ) : null}
        </Field>

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <Button className="w-full" disabled={pending} type="submit">
          {pending ? <Spinner /> : null}
          Update password
        </Button>
      </form>
    </AuthLayout>
  );
}

'use client';

import { ArrowLeftIcon, MailCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';

import { AuthLayout } from '@/components/auth-layout';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { publicApiSend } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setPending(true);
    // Ours rather than Supabase's resetPasswordForEmail: that sent the stock
    // template, and tied the link to a verifier held only by this browser, so
    // opening the mail on a phone could never complete. The API mints the link
    // with the service role and sends it through the same mailer as every other
    // message from the product.
    try {
      await publicApiSend<void>('/api/v1/auth/request-password-reset', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });
      // Always the same outcome. Whether the address has an account is not
      // something this form is willing to tell an anonymous visitor.
      setSent(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The reset email could not be sent.');
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      title="Reset your password"
      description="Enter your administrator email and we'll send a secure reset link."
    >
      {sent ? (
        <div className="grid gap-4">
          <Alert variant="success">
            <MailCheckIcon />
            <AlertTitle>Check your inbox</AlertTitle>
            <AlertDescription>A reset link was sent if the account exists.</AlertDescription>
          </Alert>
          <Button asChild variant="outline" className="w-full">
            <Link href="/login">
              <ArrowLeftIcon />
              Back to sign in
            </Link>
          </Button>
        </div>
      ) : (
        <form className="grid gap-4" onSubmit={(event) => void submit(event)}>
          <Field>
            <FieldLabel htmlFor="email">Email address</FieldLabel>
            <Input
              autoComplete="email"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              required
              type="email"
              value={email}
            />
          </Field>

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Button className="w-full" disabled={pending} type="submit">
            {pending ? <Spinner /> : null}
            Send reset link
          </Button>
          <Button asChild variant="ghost" size="sm" className="w-full">
            <Link href="/login">
              <ArrowLeftIcon />
              Back to sign in
            </Link>
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

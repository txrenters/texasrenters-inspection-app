'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';

import { Badge, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import { useProviders, useTestMail } from '@/lib/queries';

const descriptions: Record<string, string> = {
  Propertyware: 'Portfolio, property, unit, and lease source synchronization.',
  Supabase: 'Administrator authentication and managed PostgreSQL services.',
  Deepgram: 'Video transcription provider.',
  Anthropic: 'AI-assisted inspection analysis. Human review remains mandatory.',
  OpenAI: 'Alternative AI extraction and analysis provider. Human review remains mandatory.',
  'Cloudflare Stream': 'Direct video upload and processing.',
  Sentry: 'Application error monitoring and diagnostics.',
  Redis: 'Shared backend response cache and cache-health diagnostics.',
  Mailer: 'Microsoft Graph delivery for account invitations and inspection report links.',
};

export default function ProvidersPage() {
  const providers = useProviders();
  const canManage = usePermissions().has('integrations:manage');
  const testMail = useTestMail();
  const [testRecipient, setTestRecipient] = useState('');

  async function submitMailTest(event: React.FormEvent) {
    event.preventDefault();
    await testMail.mutateAsync(testRecipient.trim().toLowerCase());
  }

  return (
    <>
      <PageHeader
        title="Provider readiness"
        description="Configuration presence and operational availability without exposing credentials."
      />
      {providers.isLoading ? (
        <LoadingState />
      ) : providers.isError ? (
        <ErrorState error={providers.error} retry={() => void providers.refetch()} />
      ) : (
        <>
          <div className="provider-grid">
            {providers.data?.providers.map((provider) => (
              <Card className="p-5" key={provider.provider} asChild>
                <article>
                <div className="provider-symbol" aria-hidden>
                  ◇
                </div>
                <Badge value={provider.status} />
                {/* Margins and 17px sizing previously came from `.provider-card h2`
                    and `.panel h2`, both of which die with the class. */}
                <CardTitle className="mt-3 mb-1.5 text-[17px]">{provider.provider}</CardTitle>
                <CardDescription>
                  {descriptions[provider.provider] ?? 'External service provider.'}
                </CardDescription>
                {provider.detail ? (
                  <Alert variant="warning">{provider.detail}</Alert>
                ) : null}
                {provider.provider === 'Mailer' && canManage ? (
                  <form
                    className="provider-test-form"
                    onSubmit={(event) => void submitMailTest(event)}
                  >
                    <Field>
                      <FieldLabel htmlFor="mail-test-recipient">Test recipient</FieldLabel>
                      <Input
                        id="mail-test-recipient"
                        type="email"
                        required
                        value={testRecipient}
                        placeholder="you@example.com"
                        onChange={(event) => setTestRecipient(event.target.value)}
                      />
                    </Field>
                    <button
                      className={buttonVariants({ variant: 'secondary' })}
                      disabled={testMail.isPending || !testRecipient.trim()}
                    >
                      {testMail.isPending ? 'Sending…' : 'Send test email'}
                    </button>
                    {testMail.data ? (
                      <div
                        className={`alert ${
                          testMail.data.status === 'SENT' ? 'alert-success' : 'alert-warning'
                        }`}
                        role="status"
                      >
                        {testMail.data.message}
                      </div>
                    ) : null}
                    {testMail.error ? (
                      <FieldError>{testMail.error.message}</FieldError>
                    ) : null}
                  </form>
                ) : null}
                </article>
              </Card>
            ))}
          </div>
          <p className="footnote">Last checked {formatDate(providers.data?.checkedAt)}</p>
        </>
      )}
    </>
  );
}

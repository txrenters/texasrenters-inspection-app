'use client';

import { useState } from 'react';

import { Badge, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/ui';
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
              <article className="panel provider-card" key={provider.provider}>
                <div className="provider-symbol" aria-hidden>
                  ◇
                </div>
                <Badge value={provider.status} />
                <h2>{provider.provider}</h2>
                <p>{descriptions[provider.provider] ?? 'External service provider.'}</p>
                {provider.detail ? (
                  <div className="alert alert-warning">{provider.detail}</div>
                ) : null}
                {provider.provider === 'Mailer' && canManage ? (
                  <form
                    className="provider-test-form"
                    onSubmit={(event) => void submitMailTest(event)}
                  >
                    <div className="field">
                      <label htmlFor="mail-test-recipient">Test recipient</label>
                      <input
                        id="mail-test-recipient"
                        type="email"
                        required
                        value={testRecipient}
                        placeholder="you@example.com"
                        onChange={(event) => setTestRecipient(event.target.value)}
                      />
                    </div>
                    <button
                      className="button button-secondary"
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
                      <p className="field-error">{testMail.error.message}</p>
                    ) : null}
                  </form>
                ) : null}
              </article>
            ))}
          </div>
          <p className="footnote">Last checked {formatDate(providers.data?.checkedAt)}</p>
        </>
      )}
    </>
  );
}

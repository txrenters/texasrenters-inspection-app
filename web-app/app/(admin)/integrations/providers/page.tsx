'use client';

import { Badge, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/ui';
import { useProviders } from '@/lib/queries';

const descriptions: Record<string, string> = {
  Propertyware: 'Portfolio, property, unit, and lease source synchronization.',
  Supabase: 'Administrator authentication and managed PostgreSQL services.',
  Deepgram: 'Video transcription provider.',
  Anthropic: 'AI-assisted inspection analysis. Human review remains mandatory.',
  'Cloudflare Stream': 'Direct video upload and processing.',
  Sentry: 'Application error monitoring and diagnostics.',
  Redis: 'Shared backend response cache and cache-health diagnostics.',
};

export default function ProvidersPage() {
  const providers = useProviders();
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
              </article>
            ))}
          </div>
          <p className="footnote">Last checked {formatDate(providers.data?.checkedAt)}</p>
        </>
      )}
    </>
  );
}

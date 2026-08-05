'use client';

import { useState } from 'react';
import {
  Activity,
  AudioLines,
  Bot,
  Boxes,
  Bug,
  Building2,
  Database,
  HardDrive,
  Mail,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Zap,
} from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardDescription, CardTitle } from '@/components/ui/card';

import { Badge, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/shared';
import { usePermissions } from '@/lib/auth';
import { useProviders, useTestMail } from '@/lib/queries';

/**
 * What each provider is for, and what its footer row reports.
 *
 * `metric` names the one fact worth reading at a glance. "Ready" says the
 * credentials are present, which is not the same as the thing the provider does
 * actually working — Propertyware being configured and Propertyware syncing are
 * different questions, and the second is the one an operator came here for.
 */
/**
 * Icons say what the provider does, not whose logo it is.
 *
 * Brand marks would mean shipping image assets and, for several of these,
 * reproducing a trademark. A function icon is unambiguous at this size, needs
 * no network, and survives a provider being swapped for a competitor — the card
 * for object storage should not have to be redrawn because the vendor changed.
 *
 * Each carries its own tint so the three cards in a row are told apart at a
 * glance rather than read.
 */
const PROVIDER_META: Record<
  string,
  { description: string; metric: string; icon: typeof Boxes; tint: string }
> = {
  Propertyware: {
    description: 'Portfolio, property, unit, and lease source synchronization.',
    metric: 'Source sync',
    icon: Building2,
    tint: 'bg-primary/10 text-primary',
  },
  Supabase: {
    description: 'Administrator authentication and managed PostgreSQL services.',
    metric: 'Database',
    icon: Database,
    tint: 'bg-chart-3/15 text-chart-3',
  },
  Deepgram: {
    description: 'Video transcription provider.',
    metric: 'Transcription',
    icon: AudioLines,
    tint: 'bg-chart-2/15 text-chart-2',
  },
  Anthropic: {
    description: 'AI-assisted inspection analysis. Human review remains mandatory.',
    metric: 'Model access',
    icon: Sparkles,
    tint: 'bg-chart-4/15 text-chart-4',
  },
  OpenAI: {
    description: 'Alternative AI extraction and analysis provider. Human review remains mandatory.',
    metric: 'Model access',
    icon: Bot,
    tint: 'bg-chart-3/15 text-chart-3',
  },
  'Cloudflare R2': {
    description: 'Object storage for inspection video and photo evidence.',
    metric: 'Inspection media bucket',
    icon: HardDrive,
    tint: 'bg-chart-4/15 text-chart-4',
  },
  Sentry: {
    description: 'Application error monitoring and diagnostics.',
    metric: 'Monitoring',
    icon: Bug,
    tint: 'bg-destructive/10 text-destructive',
  },
  Redis: {
    description: 'Shared backend response cache and cache-health diagnostics.',
    metric: 'Connection',
    icon: Zap,
    tint: 'bg-chart-2/15 text-chart-2',
  },
  Mailer: {
    description: 'Microsoft Graph delivery for account invitations and inspection report links.',
    metric: 'Sender identity',
    icon: Mail,
    tint: 'bg-primary/10 text-primary',
  },
};

/**
 * Grouped by what breaks when the provider does, which is how this page is
 * read: core data stops the app, an AI provider degrades analysis a human was
 * reviewing anyway, and infrastructure is felt indirectly.
 *
 * Anything the API adds later falls into a trailing group rather than
 * disappearing — a provider missing from this page is worse than one filed
 * loosely.
 */
const GROUPS: { key: string; label: string; icon: typeof Boxes; members: string[] }[] = [
  { key: 'core', label: 'Core data', icon: Boxes, members: ['Propertyware', 'Supabase', 'Deepgram'] },
  { key: 'ai', label: 'AI providers', icon: Sparkles, members: ['Anthropic', 'OpenAI'] },
  {
    key: 'infra',
    label: 'Infrastructure & delivery',
    icon: Activity,
    // Mailer leads: it is the only card carrying a form, so anywhere else it
    // lands alone on a second row and stretches it to twice the height of the
    // one above.
    members: ['Mailer', 'Cloudflare R2', 'Sentry', 'Redis'],
  },
];

/** Initials for the tile. No remote logos — a strict CSP blocks them anyway. */
function monogram(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}

/**
 * The footer value. `detail` is the provider's own words where it has any —
 * "Inspection media bucket: default" — so the label half is stripped rather
 * than printed twice beside the label it already matches.
 */
function metricValue(status: string, detail?: string | null) {
  if (detail) {
    const [, afterColon] = detail.split(/:\s*(.+)/);
    const value = afterColon ?? detail;
    // Providers report their own state in their own casing — Redis answers
    // "connected" — and a column of values in mixed case reads as a bug rather
    // than as data. Only the first letter: "no-reply@texasrenters.com" and
    // "Microsoft Graph" must survive untouched.
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
  if (status === 'CONNECTED') return 'Healthy';
  if (status === 'READY' || status === 'CONFIGURED') return 'Available';
  return 'Not configured';
}

const isProblem = (status: string) => status === 'NOT_CONFIGURED' || status === 'ERROR';

export default function ProvidersPage() {
  const providers = useProviders();
  const canManage = usePermissions().has('integrations:manage');
  const testMail = useTestMail();
  const [testRecipient, setTestRecipient] = useState('');

  async function submitMailTest(event: React.FormEvent) {
    event.preventDefault();
    await testMail.mutateAsync(testRecipient.trim().toLowerCase());
  }

  const all = providers.data?.providers ?? [];
  const grouped = GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    icon: group.icon,
    // Sorted by the order declared above, not the order the API happens to
    // return: `members` is where the layout decides which card leads a row.
    items: all
      .filter((provider) => group.members.includes(provider.provider))
      .sort(
        (left, right) =>
          group.members.indexOf(left.provider) - group.members.indexOf(right.provider),
      ),
  })).filter((group) => group.items.length);
  const ungrouped = all.filter(
    (provider) => !GROUPS.some((group) => group.members.includes(provider.provider)),
  );
  const sections = ungrouped.length
    ? [...grouped, { key: 'other', label: 'Other', icon: Boxes, items: ungrouped }]
    : grouped;

  return (
    <>
      <PageHeader
        title="Provider readiness"
        description="Configuration presence and operational availability without exposing credentials."
        action={
          // Beside the timestamp, because "is this current?" and "check again"
          // are the same thought.
          <div className="flex items-center gap-4">
            <span className="text-right text-[13px] leading-tight text-muted-foreground">
              Last checked
              <span className="block text-foreground">{formatDate(providers.data?.checkedAt)}</span>
            </span>
            <button
              className={buttonVariants({ variant: 'secondary' })}
              disabled={providers.isFetching}
              onClick={() => void providers.refetch()}
              type="button"
            >
              <RefreshCw
                aria-hidden
                className={`mr-2 size-4 ${providers.isFetching ? 'animate-spin' : ''}`}
              />
              {providers.isFetching ? 'Checking…' : 'Refresh status'}
            </button>
          </div>
        }
      />
      {providers.isLoading ? (
        <LoadingState />
      ) : providers.isError ? (
        <ErrorState error={providers.error} retry={() => void providers.refetch()} />
      ) : (
        <>
          {sections.map((section) => (
            <section className="section-gap" key={section.key}>
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-foreground">
                <section.icon aria-hidden className="size-4 text-muted-foreground" />
                {section.label}
              </h2>
              <div className="grid grid-cols-3 gap-4 max-[1100px]:grid-cols-2 max-[720px]:grid-cols-1">
                {section.items.map((provider) => {
                  const meta = PROVIDER_META[provider.provider];
                  const problem = isProblem(provider.status);
                  return (
                    <Card className="flex flex-col gap-4 p-5" key={provider.provider} asChild>
                      <article>
                        <div className="flex items-start gap-3">
                          <span
                            aria-hidden
                            className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                              meta?.tint ?? 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {/* Initials only for a provider this page has never
                                heard of — better than a wrong icon asserting
                                what it does. */}
                            {meta ? (
                              <meta.icon className="size-5" />
                            ) : (
                              <span className="text-[13px] font-bold tracking-wide">
                                {monogram(provider.provider)}
                              </span>
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <CardTitle className="text-[15px]">{provider.provider}</CardTitle>
                            <CardDescription className="mt-1 text-[13px] leading-5">
                              {meta?.description ?? 'External service provider.'}
                            </CardDescription>
                          </div>
                          <Badge value={provider.status} />
                        </div>

                        {/* Pinned to the bottom so every card in a row lines up
                            however long its description runs. */}
                        <div className="mt-auto flex items-center justify-between gap-3 border-t border-border pt-3 text-[13px]">
                          <span className="text-muted-foreground">
                            {meta?.metric ?? 'Availability'}
                          </span>
                          <span
                            className={`font-semibold ${
                              problem ? 'text-warning-foreground' : 'text-foreground'
                            }`}
                          >
                            {metricValue(provider.status, provider.detail)}
                          </span>
                        </div>

                        {/* Only when something is wrong: a detail that merely
                            repeats the footer value would be the same sentence
                            twice. */}
                        {problem && provider.detail ? (
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
                  );
                })}
              </div>
            </section>
          ))}

          {/* Carries the same 20px the sections above use. It is not a section
              itself, so it inherited no gap and sat flush against the last row
              of cards. */}
          <Alert className="section-gap">
            <ShieldCheck aria-hidden className="size-4" />
            All providers are checked on a regular schedule. Status reflects availability and
            configuration only — no credentials are stored or displayed.
          </Alert>
        </>
      )}
    </>
  );
}

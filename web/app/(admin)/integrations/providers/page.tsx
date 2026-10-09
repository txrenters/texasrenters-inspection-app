'use client';

import {
  AudioLinesIcon,
  BotIcon,
  BugIcon,
  Building2Icon,
  HardDriveIcon,
  MailIcon,
  RefreshCwIcon,
  SparklesIcon,
  ZapIcon,
} from 'lucide-react';
import { useState, type ComponentType, type FormEvent } from 'react';

import { PageHeader } from '@/components/page-header';
import { SECTION_LABEL } from '@/components/panel';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { usePermissions } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import { useProviders, useTestMail } from '@/lib/queries';
import { cn } from '@/lib/utils';

type Icon = ComponentType<{ className?: string }>;

/**
 * What each provider is for, and what its footer row reports.
 *
 * `metric` names the one fact worth reading at a glance. "Ready" says the
 * credentials are present, which is not the same as the thing the provider does
 * actually working — Propertyware being configured and Propertyware syncing are
 * different questions, and the second is the one an operator came here for.
 *
 * Icons say what the provider does, not whose logo it is. Brand marks would mean
 * shipping image assets and, for several of these, reproducing a trademark. A
 * function icon is unambiguous at this size, needs no network, and survives a
 * provider being swapped for a competitor.
 */
/**
 * One quiet tile for every provider (console-development). Each had its own
 * chart tint -- and Sentry the destructive red -- so the page read as eight
 * statuses before any badge was looked at, and a healthy Sentry looked broken.
 */
const TILE = 'bg-muted text-muted-foreground';

const PROVIDER_META: Record<string, { description: string; metric: string; icon: Icon }> =
  {
    Propertyware: {
      description: 'Portfolio, property, unit, and lease source synchronization.',
      metric: 'Source sync',
      icon: Building2Icon,
    },
    Deepgram: {
      description: 'Video transcription provider.',
      metric: 'Transcription',
      icon: AudioLinesIcon,
    },
    Anthropic: {
      description: 'AI-assisted inspection analysis. Human review remains mandatory.',
      metric: 'Model access',
      icon: SparklesIcon,
    },
    OpenAI: {
      description: 'Alternative AI extraction and analysis provider. Human review remains mandatory.',
      metric: 'Model access',
      icon: BotIcon,
    },
    'Cloudflare R2': {
      description: 'Object storage for inspection video and photo evidence.',
      metric: 'Inspection media bucket',
      icon: HardDriveIcon,
    },
    Sentry: {
      description: 'Application error monitoring and diagnostics.',
      metric: 'Monitoring',
      icon: BugIcon,
    },
    Redis: {
      description: 'Shared backend response cache and cache-health diagnostics.',
      metric: 'Connection',
      icon: ZapIcon,
    },
    Mailer: {
      description: 'Microsoft Graph delivery for account invitations and inspection report links.',
      metric: 'Sender identity',
      icon: MailIcon,
    },
  };

/**
 * Grouped by what breaks when the provider does, which is how this page is read:
 * core data stops the app, an AI provider degrades analysis a human was
 * reviewing anyway, and infrastructure is felt indirectly.
 *
 * Anything the API adds later falls into a trailing group rather than
 * disappearing — a provider missing from this page is worse than one filed
 * loosely.
 */
const GROUPS: Array<{ key: string; label: string; members: string[] }> = [
  {
    key: 'core',
    label: 'Core data',
    // Supabase is gone from here with the migration off it. The database is
    // now Postgres the deployment runs itself, and a self-hosted dependency is
    // not a third-party integration to show an administrator.
    members: ['Propertyware', 'Deepgram'],
  },
  { key: 'ai', label: 'AI providers', members: ['Anthropic', 'OpenAI'] },
  {
    key: 'infra',
    label: 'Infrastructure & delivery',
    // Mailer leads: it is the only card carrying a form, so anywhere else it
    // lands alone on a second row and stretches it to twice the height.
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
 * "Inspection media bucket: default" — so the label half is stripped rather than
 * printed twice beside the label it already matches.
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

  async function submitMailTest(event: FormEvent) {
    event.preventDefault();
    try {
      await testMail.mutateAsync(testRecipient.trim().toLowerCase());
    } catch {
      // The mutation surfaces the sanitized API error inline.
    }
  }

  const all = providers.data?.providers ?? [];
  const grouped = GROUPS.map((group) => ({
    key: group.key,
    label: group.label,
    // Sorted by the order declared above, not the order the API happens to
    // return: `members` is where the layout decides which card leads a row.
    items: all
      .filter((provider) => group.members.includes(provider.provider))
      .sort(
        (left, right) => group.members.indexOf(left.provider) - group.members.indexOf(right.provider),
      ),
  })).filter((group) => group.items.length);
  const ungrouped = all.filter(
    (provider) => !GROUPS.some((group) => group.members.includes(provider.provider)),
  );
  const sections = ungrouped.length
    ? [...grouped, { key: 'other', label: 'Other', items: ungrouped }]
    : grouped;

  return (
    <>
      <PageHeader
        actions={
          // Beside the timestamp, because "is this current?" and "check again"
          // are the same thought.
          <div className="flex items-center gap-3">
            <span className="text-muted-foreground text-right text-xs leading-tight">
              Last checked
              <span className="text-foreground block font-medium">
                {formatRelative(providers.data?.checkedAt)}
              </span>
            </span>
            <Button
              disabled={providers.isFetching}
              onClick={() => void providers.refetch()}
              type="button"
              variant="outline"
            >
              <RefreshCwIcon className={cn(providers.isFetching && 'animate-spin')} />
              {providers.isFetching ? 'Checking…' : 'Refresh status'}
            </Button>
          </div>
        }
        description="Configuration presence and operational availability without exposing credentials."
        // Was a note at the foot of the page (console-development).
        info={
          <p>
            All providers are checked on a regular schedule. Status reflects availability and
            configuration only - no credentials are stored or displayed.
          </p>
        }
        infoLabel="How readiness is checked"
        title="Provider readiness"
      />

      {providers.isLoading ? (
        <PageSkeleton cards={3} />
      ) : providers.isError ? (
        <ErrorState error={providers.error} retry={() => void providers.refetch()} />
      ) : (
        <div className="space-y-6">
          {sections.map((section) => (
            <section className="space-y-3" key={section.key}>
              {/* A group's name is a label, not a headline (console-development). */}
              <h2 className={SECTION_LABEL}>{section.label}</h2>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {section.items.map((provider) => {
                  const meta = PROVIDER_META[provider.provider];
                  const problem = isProblem(provider.status);
                  return (
                    <Card className="p-4" key={provider.provider}>
                      {/* Wraps: on a narrow tile (two across at 768px, beside
                          the sidebar) a one-word name ran under the status. The
                          name keeps at least 7rem; past that the status drops
                          to its own line. */}
                      <div className="flex flex-wrap items-start gap-3">
                        <span
                          aria-hidden
                          className={cn(
                            'flex size-10 shrink-0 items-center justify-center rounded-lg',
                            TILE,
                          )}
                        >
                          {/* Initials only for a provider this page has never
                              heard of — better than a wrong icon asserting what
                              it does. */}
                          {meta ? (
                            <meta.icon className="size-5" />
                          ) : (
                            <span className="text-xs font-bold tracking-wide">
                              {monogram(provider.provider)}
                            </span>
                          )}
                        </span>
                        <div className="min-w-28 flex-1 space-y-1">
                          <p className="text-sm leading-none font-semibold">{provider.provider}</p>
                          <p className="text-muted-foreground text-xs leading-relaxed">
                            {meta?.description ?? 'External service provider.'}
                          </p>
                        </div>
                        <StatusBadge value={provider.status} />
                      </div>

                      {/* Only when something is wrong: a detail that merely
                          repeats the footer value would be the same sentence
                          twice. */}
                      {problem && provider.detail ? (
                        <Alert variant="warning">
                          <AlertDescription>{provider.detail}</AlertDescription>
                        </Alert>
                      ) : null}

                      {provider.provider === 'Mailer' && canManage ? (
                        <form className="grid gap-2" onSubmit={(event) => void submitMailTest(event)}>
                          <Field>
                            <FieldLabel htmlFor="mail-test-recipient">Test recipient</FieldLabel>
                            <div className="flex gap-2">
                              <Input
                                id="mail-test-recipient"
                                onChange={(event) => setTestRecipient(event.target.value)}
                                placeholder="you@example.com"
                                required
                                type="email"
                                value={testRecipient}
                              />
                              <Button
                                disabled={testMail.isPending || !testRecipient.trim()}
                                type="submit"
                                variant="outline"
                              >
                                {testMail.isPending ? <Spinner /> : null}
                                Send
                              </Button>
                            </div>
                            <FieldError>{testMail.error?.message}</FieldError>
                          </Field>
                          {testMail.data ? (
                            <Alert variant={testMail.data.status === 'SENT' ? 'success' : 'warning'}>
                              <AlertDescription>{testMail.data.message}</AlertDescription>
                            </Alert>
                          ) : null}
                        </form>
                      ) : null}

                      {/* Pinned to the bottom so every card in a row lines up
                          however long its description runs. */}
                      <div className="mt-auto flex items-center justify-between gap-3 border-t pt-3 text-sm">
                        <span className="text-muted-foreground">{meta?.metric ?? 'Availability'}</span>
                        <span className={cn('font-medium', problem && 'text-warning')}>
                          {metricValue(provider.status, provider.detail)}
                        </span>
                      </div>
                    </Card>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

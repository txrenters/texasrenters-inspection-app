'use client';

import type { AiProviderConfiguration, AiProviderName } from '@texasrenters/shared';
import { InfoIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';

import { AiHouseRules } from '@/components/ai-house-rules';
import { AiScorecard } from '@/components/ai-scorecard';
import { AiTestRuns } from '@/components/ai-test-runs';
import { PageHeader } from '@/components/page-header';
import { SECTION_LABEL } from '@/components/panel';
import { PasswordInput } from '@/components/password-input';
import { Stat, StatGroup } from '@/components/stat-card';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useAuth, usePermissions } from '@/lib/auth';
import { formatCount, formatDate, formatRelative } from '@/lib/format';
import { useAiSettings, useAiSettingsMutations } from '@/lib/queries';
import { cn } from '@/lib/utils';

const PROVIDER_LABEL: Record<AiProviderName, string> = {
  ANTHROPIC: 'Anthropic',
  OPENAI: 'OpenAI',
};

const PROVIDER_OPTIONS = (['ANTHROPIC', 'OPENAI'] as const).map((value) => ({
  value,
  label: PROVIDER_LABEL[value],
}));

/**
 * The rules behind one section, one click away (console-development).
 *
 * The page opened with a card about where credentials live, then a paragraph
 * per section and a cost note, so the controls started a screen down. The same
 * shape as the page header's own (i).
 */
function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button aria-label={label} className="text-muted-foreground -my-1" size="icon-sm" variant="ghost">
          <InfoIcon />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] text-sm">
        <p className={cn(SECTION_LABEL, 'mb-2')}>{label}</p>
        <div className="space-y-2 leading-relaxed">{children}</div>
      </PopoverContent>
    </Popover>
  );
}

/** A section's name as a label, with its rules behind an (i). */
function SettingsSectionTitle({ id, title, info }: { id?: string; title: string; info: ReactNode }) {
  return (
    <div className="flex items-center gap-1">
      <h2 className={SECTION_LABEL} id={id}>
        {title}
      </h2>
      <InfoPopover label={`About ${title.toLowerCase()}`}>{info}</InfoPopover>
    </div>
  );
}

export default function SettingsPage() {
  const { profile } = useAuth();
  const membership = profile?.memberships[0];
  // "Custom RBAC access" was jargon for "the roles you were given"
  // (console-development).
  const accessLabel = profile?.memberships.some(({ role }) => role === 'SYSTEM_ADMIN')
    ? 'System admin'
    : 'Assigned roles';
  const aiSettings = useAiSettings();
  const actions = useAiSettingsMutations();
  const canManageSecrets = usePermissions().has('ai:configure');

  return (
    <>
      <PageHeader
        description="Organization controls, AI routing, usage visibility, and operating safeguards."
        // What was two cards of reassurance -- four green shields and a
        // heading-sized "Credentials stay on the backend" -- before any control
        // (console-development). Every sentence kept, one click away.
        info={
          <>
            <p>
              <span className="text-foreground font-medium">Credentials stay on the backend.</span>{' '}
              Provider keys are encrypted before persistence and are never returned to the browser,
              audit log, or frontend bundle.
            </p>
            <p className="text-foreground font-medium">Human review safeguards</p>
            <ul className="list-disc space-y-1 pl-5">
              {[
                'AI room tags remain drafts until an authorized person approves them.',
                'AI findings remain pending review until an authorized person reviews them.',
                'AI does not approve tenant charges or decide legal responsibility.',
                'One video belongs to exactly one approved room and one inspection area.',
              ].map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </>
        }
        infoLabel="Credentials and safeguards"
        title="Settings"
      />

      <Card>
        <CardHeader>
          <CardTitle>{membership?.organization.name ?? 'Organization unavailable'}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0 space-y-1">
              <dt className="text-muted-foreground text-xs font-medium">Organization ID</dt>
              <dd className="font-mono text-sm break-all">
                {membership?.organization.id ?? 'Unavailable'}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className="text-muted-foreground text-xs font-medium">Your role</dt>
              <dd className="text-sm font-medium">{accessLabel}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <section aria-labelledby="ai-settings-title" className="mt-6 space-y-4">
        <SettingsSectionTitle
          id="ai-settings-title"
          info={
            <>
              <p>
                Choose the provider used by new AI jobs and configure each provider independently.
                For transcript summaries and finding extraction, the balanced tiers are recommended
                — the premium flagships rarely improve results for this workload.
              </p>
              {aiSettings.data ? (
                <p>
                  Consumption covers AI calls recorded by TexasRenters since{' '}
                  {formatDate(aiSettings.data.usageWindow.startsAt)}. Standard provider API keys do
                  not expose account credit balances; the optional monthly token budget is a local
                  control, not a provider billing balance.
                </p>
              ) : null}
            </>
          }
          title="Provider routing and consumption"
        />

        {aiSettings.isLoading ? (
          <PageSkeleton cards={2} />
        ) : aiSettings.isError ? (
          <ErrorState error={aiSettings.error} retry={() => void aiSettings.refetch()} />
        ) : aiSettings.data ? (
          <>
            {!aiSettings.data.keyStorageAvailable ? (
              <Alert variant="warning">
                <AlertDescription>
                  Secure key entry is disabled until <code>AI_CREDENTIALS_ENCRYPTION_KEY</code> is
                  configured on the backend. Existing environment keys continue to work.
                </AlertDescription>
              </Alert>
            ) : null}

            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <p className="text-muted-foreground text-xs font-medium">
                    Default provider routing
                  </p>
                  <p className="text-sm font-medium">
                    New AI jobs use {PROVIDER_LABEL[aiSettings.data.activeProvider]}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Existing jobs keep the provider and model recorded when they started.
                  </p>
                </div>
                {/* The console's one toggle (console-development): an ink
                    button with a tick, a primary border on the card below and a
                    blue "Active" badge said the same thing three ways. The
                    fieldset carries the permission and the pending state, which
                    the control itself has no prop for. */}
                <fieldset
                  className="m-0 min-w-0 border-0 p-0 disabled:opacity-60"
                  disabled={!canManageSecrets || actions.setActiveProvider.isPending}
                >
                  <SegmentedControl
                    aria-label="Active AI provider"
                    onChange={(providerName) => {
                      if (providerName !== aiSettings.data?.activeProvider)
                        actions.setActiveProvider.mutate(providerName);
                    }}
                    options={PROVIDER_OPTIONS}
                    value={aiSettings.data.activeProvider}
                  />
                </fieldset>
              </CardContent>
            </Card>
            {actions.setActiveProvider.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{actions.setActiveProvider.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-1">
                    <p className="text-muted-foreground text-xs font-medium">AI checks the video</p>
                    <InfoPopover label="What the video check does">
                      <p>
                        When on, the AI looks through each room&apos;s recording, and the
                        technician&apos;s photos of the room, after the narration is analysed:
                        whether every finding can be seen, a suggested photograph for each, whether
                        a move-in photograph already shows it, and problems nobody mentioned.
                      </p>
                      <p>
                        Everything stays a suggestion for review. About $0.15 a room on GPT-5.6
                        Sol, measured on a move-out on Oct 3, 2026.
                      </p>
                    </InfoPopover>
                  </div>
                  <p className="text-sm font-medium">
                    {aiSettings.data.visualReviewEnabled
                      ? 'Each finding is checked against the recording'
                      : 'Findings come from the narration only'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {actions.setVisualReview.isPending ? <Spinner /> : null}
                  <Switch
                    aria-label="AI checks findings against the video"
                    checked={Boolean(aiSettings.data.visualReviewEnabled)}
                    disabled={!canManageSecrets || actions.setVisualReview.isPending}
                    onCheckedChange={(checked) => actions.setVisualReview.mutate(checked)}
                  />
                </div>
              </CardContent>
            </Card>
            {actions.setVisualReview.isError ? (
              <Alert variant="destructive">
                <AlertDescription>{actions.setVisualReview.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <div className="grid gap-4 xl:grid-cols-2">
              {aiSettings.data.providers.map((provider) => (
                <AiProviderPanel
                  active={aiSettings.data?.activeProvider === provider.provider}
                  canManage={canManageSecrets}
                  key={provider.provider}
                  keyStorageAvailable={aiSettings.data?.keyStorageAvailable ?? false}
                  onSave={(input) => actions.updateProvider.mutateAsync(input)}
                  onValidate={() => actions.validateProvider.mutateAsync(provider.provider)}
                  provider={provider}
                />
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section aria-labelledby="teaching-the-ai-title" className="mt-6 space-y-4">
        <SettingsSectionTitle
          id="teaching-the-ai-title"
          info={
            <p>
              The office teaches the AI two ways: house rules it reads with every recording, and its
              reviewers&apos; decisions, which it is shown as examples. A rejection&apos;s reason
              and a correction both count.
            </p>
          }
          title="Teaching the AI"
        />
        <AiHouseRules canConfigure={canManageSecrets} />
        <AiTestRuns />
        <AiScorecard />
      </section>
    </>
  );
}

function AiProviderPanel({
  provider,
  active,
  canManage,
  keyStorageAvailable,
  onSave,
  onValidate,
}: {
  provider: AiProviderConfiguration;
  active: boolean;
  canManage: boolean;
  keyStorageAvailable: boolean;
  onSave: (input: {
    provider: AiProviderName;
    modelId: string;
    apiKey?: string;
    clearApiKey?: boolean;
    monthlyTokenBudget?: number | null;
  }) => Promise<unknown>;
  onValidate: () => Promise<unknown>;
}) {
  const [modelId, setModelId] = useState(provider.modelId);
  const [apiKey, setApiKey] = useState('');
  const [budget, setBudget] = useState(provider.monthlyTokenBudget?.toString() ?? '');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [pending, setPending] = useState<'save' | 'validate' | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'destructive'; text: string } | null>(
    null,
  );

  useEffect(() => {
    setModelId(provider.modelId);
    setBudget(provider.monthlyTokenBudget?.toString() ?? '');
    setApiKey('');
    setClearApiKey(false);
  }, [provider.modelId, provider.monthlyTokenBudget, provider.hasApiKey]);

  const run = async (kind: 'save' | 'validate', task: () => Promise<unknown>) => {
    setPending(kind);
    setMessage(null);
    try {
      await task();
      setMessage({
        tone: 'success',
        text: kind === 'save' ? 'Provider settings saved.' : 'Credential check completed.',
      });
    } catch (error) {
      setMessage({
        tone: 'destructive',
        text: error instanceof Error ? error.message : 'The request could not be completed.',
      });
    } finally {
      setPending(null);
    }
  };

  const selectedModel = provider.models.find((model) => model.id === modelId);
  const budgetUsed = provider.usage.budgetPercentUsed;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            {provider.displayName}
            {/* One word in the accent, the only mark of which is active
                (console-development). */}
            {active ? <span className="text-highlight text-xs font-medium">Active</span> : null}
          </CardTitle>
          <p className="text-muted-foreground text-sm">
            {selectedModel ? `${selectedModel.name} · ${selectedModel.tier}` : 'AI provider'}
          </p>
        </div>
        <div className="text-right">
          <p className="text-muted-foreground mb-1 text-xs">Credential</p>
          <StatusBadge value={provider.credentialStatus} />
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className={SECTION_LABEL}>Usage this month</p>
            <p className="text-muted-foreground font-mono text-xs tabular-nums">
              {formatCount(provider.usage.requests)} requests recorded
            </p>
          </div>
          {/* One figure panel, mono like every other (console-development):
              four tinted boxes with their own figures in a sans weight. The
              budget is the one that can want a person: a dot at 90%, never an
              amber number. Two across at most: token counts run to eight
              digits at figure size, and four across a provider card ran into
              each other at 768px. */}
          <StatGroup columns="grid-cols-1 sm:grid-cols-2">
            <Stat label="Total tokens" value={formatCount(provider.usage.totalTokens)} />
            <Stat label="Input tokens" value={formatCount(provider.usage.inputTokens)} />
            <Stat label="Output tokens" value={formatCount(provider.usage.outputTokens)} />
            <Stat
              detail={budgetUsed !== null ? `${budgetUsed}% used` : undefined}
              label="Budget left"
              tone={budgetUsed !== null && budgetUsed >= 90 ? 'warning' : 'default'}
              value={
                provider.usage.remainingBudgetTokens === null
                  ? 'Not set'
                  : formatCount(provider.usage.remainingBudgetTokens)
              }
            />
          </StatGroup>
          {budgetUsed !== null ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">Monthly token budget</span>
                <span className="font-mono font-medium tabular-nums">{budgetUsed}% used</span>
              </div>
              <Progress value={budgetUsed} />
            </div>
          ) : null}
        </div>

        <div className="grid gap-4 border-t pt-5">
          <Field>
            <FieldLabel htmlFor={`${provider.provider}-model`}>Model</FieldLabel>
            <Select disabled={!canManage} onValueChange={setModelId} value={modelId}>
              <SelectTrigger className="w-full" id={`${provider.provider}-model`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {provider.models.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name} - {model.tier}
                    {model.recommended ? ' · Recommended' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedModel ? (
              <FieldDescription>
                {selectedModel.recommended ? (
                  <span className="text-foreground font-medium">Recommended for inspections · </span>
                ) : null}
                {selectedModel.description}
                {selectedModel.pricing ? <em> {selectedModel.pricing}.</em> : null}
              </FieldDescription>
            ) : null}
          </Field>

          <Field>
            <FieldLabel htmlFor={`${provider.provider}-budget`}>
              Monthly token budget (optional)
            </FieldLabel>
            <Input
              disabled={!canManage}
              id={`${provider.provider}-budget`}
              min="1000"
              onChange={(event) => setBudget(event.target.value)}
              placeholder="e.g. 1000000"
              step="1000"
              type="number"
              value={budget}
            />
            <FieldDescription>
              Soft limit for this provider&apos;s monthly token use. Leave blank for no local cap.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={`${provider.provider}-key`}>API key</FieldLabel>
            <PasswordInput
              autoComplete="new-password"
              disabled={!canManage || !keyStorageAvailable || clearApiKey}
              id={`${provider.provider}-key`}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={
                provider.hasApiKey ? 'Configured - enter a new key to replace' : 'Enter provider API key'
              }
              value={apiKey}
            />
            <FieldDescription>
              {provider.hasApiKey
                ? `Configured from ${provider.keySource.toLowerCase()}; the value is never displayed.`
                : 'No key is configured.'}
            </FieldDescription>
          </Field>

          {provider.keySource === 'SETTINGS' && canManage ? (
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <Checkbox
                checked={clearApiKey}
                className="mt-0.5"
                onCheckedChange={(checked) => setClearApiKey(checked === true)}
              />
              Remove the stored key and fall back to the backend environment key
            </label>
          ) : null}
        </div>

        {message ? (
          <Alert variant={message.tone}>
            <AlertDescription>{message.text}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <div className="text-muted-foreground grid gap-0.5 text-xs">
            <span>Validated {formatRelative(provider.lastValidatedAt)}</span>
            <span>Last used {formatRelative(provider.usage.lastUsedAt)}</span>
          </div>
          <div className="flex gap-2">
            <Button
              disabled={!canManage || !provider.hasApiKey || pending !== null}
              onClick={() => void run('validate', onValidate)}
              type="button"
              variant="outline"
            >
              {pending === 'validate' ? <Spinner /> : null}
              {pending === 'validate' ? 'Checking…' : 'Test connection'}
            </Button>
            <Button
              disabled={!canManage || pending !== null}
              onClick={() =>
                void run('save', () =>
                  onSave({
                    provider: provider.provider,
                    modelId,
                    apiKey: apiKey.trim() || undefined,
                    clearApiKey,
                    monthlyTokenBudget: budget ? Number(budget) : null,
                  }),
                )
              }
              type="button"
            >
              {pending === 'save' ? <Spinner /> : null}
              {pending === 'save' ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

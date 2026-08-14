'use client';

import type { AiProviderConfiguration, AiProviderName } from '@texasrenters/shared';
import { CheckIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { PageHeader, SectionHeader } from '@/components/page-header';
import { PasswordInput } from '@/components/password-input';
import { ErrorState, PageSkeleton } from '@/components/states';
import { StatusBadge } from '@/components/status-badge';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useAuth, usePermissions } from '@/lib/auth';
import { formatCount, formatDate, formatRelative } from '@/lib/format';
import { useAiSettings, useAiSettingsMutations } from '@/lib/queries';
import { cn } from '@/lib/utils';

const PROVIDER_LABEL: Record<AiProviderName, string> = {
  ANTHROPIC: 'Anthropic',
  OPENAI: 'OpenAI',
};

export default function SettingsPage() {
  const { profile } = useAuth();
  const membership = profile?.memberships[0];
  const accessLabel = profile?.memberships.some(({ role }) => role === 'SYSTEM_ADMIN')
    ? 'System admin'
    : 'Custom RBAC access';
  const aiSettings = useAiSettings();
  const actions = useAiSettingsMutations();
  const canManageSecrets = usePermissions().has('ai:configure');

  return (
    <>
      <PageHeader
        description="Organization controls, AI routing, usage visibility, and operating safeguards."
        title="Settings"
      />

      <div className="grid gap-4 lg:grid-cols-2">
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheckIcon className="text-success size-4" />
              Credentials stay on the backend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              Provider keys are encrypted before persistence and are never returned to the browser,
              audit log, or frontend bundle.
            </p>
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="ai-settings-title" className="mt-6 space-y-4">
        <SectionHeader
          description="Choose the provider used by new AI jobs and configure each provider independently. For transcript summaries and finding extraction, the balanced tiers are recommended — the premium flagships rarely improve results for this workload."
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
                <div
                  aria-label="Active AI provider"
                  className="bg-muted flex items-center gap-1 rounded-lg p-1"
                  role="group"
                >
                  {(['ANTHROPIC', 'OPENAI'] as const).map((providerName) => {
                    const selected = aiSettings.data?.activeProvider === providerName;
                    return (
                      <Button
                        aria-pressed={selected}
                        className={cn(!selected && 'text-muted-foreground')}
                        disabled={!canManageSecrets || actions.setActiveProvider.isPending}
                        key={providerName}
                        onClick={() => {
                          if (!selected) actions.setActiveProvider.mutate(providerName);
                        }}
                        size="sm"
                        type="button"
                        variant={selected ? 'default' : 'ghost'}
                      >
                        {selected ? <CheckIcon /> : null}
                        {PROVIDER_LABEL[providerName]}
                      </Button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

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

            <p className="text-muted-foreground text-xs">
              Consumption covers AI calls recorded by TexasRenters since{' '}
              {formatDate(aiSettings.data.usageWindow.startsAt)}. Standard provider API keys do not
              expose account credit balances; the optional monthly token budget is a local control,
              not a provider billing balance.
            </p>
          </>
        ) : null}
      </section>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Human review safeguards</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2">
            {[
              'AI room tags remain drafts until an authorized person approves them.',
              'AI findings remain pending review until an authorized person reviews them.',
              'AI does not approve tenant charges or decide legal responsibility.',
              'One video belongs to exactly one approved room and one inspection area.',
            ].map((rule) => (
              <li className="flex items-start gap-2 text-sm" key={rule}>
                <ShieldCheckIcon aria-hidden className="text-success mt-0.5 size-4 shrink-0" />
                {rule}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
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
    <Card className={cn(active && 'border-primary')}>
      <CardHeader className="flex-row items-start justify-between">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2">
            {provider.displayName}
            {active ? <Badge variant="info">Active</Badge> : null}
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
            <p className="text-sm font-medium">Usage this month</p>
            <p className="text-muted-foreground text-xs">
              {formatCount(provider.usage.requests)} requests recorded
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Total tokens', value: provider.usage.totalTokens },
              { label: 'Input tokens', value: provider.usage.inputTokens },
              { label: 'Output tokens', value: provider.usage.outputTokens },
              { label: 'Budget left', value: provider.usage.remainingBudgetTokens },
            ].map((item) => (
              <div className="bg-muted/50 rounded-lg p-3" key={item.label}>
                <dt className="text-muted-foreground text-xs">{item.label}</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  {item.value === null ? 'Not set' : formatCount(item.value)}
                </dd>
              </div>
            ))}
          </dl>
          {budgetUsed !== null ? (
            <div className="mt-3 space-y-1.5">
              <div className="flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">Monthly token budget</span>
                <span className={cn('font-medium tabular-nums', budgetUsed >= 90 && 'text-warning')}>
                  {budgetUsed}% used
                </span>
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
                  <span className="text-success font-medium">Recommended for inspections · </span>
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

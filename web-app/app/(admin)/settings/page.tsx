'use client';

import type { AiProviderConfiguration, AiProviderName } from '@texasrenters/shared';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Card, CardTitle } from '@/components/ui/card';
import { useEffect, useState } from 'react';
import { buttonVariants } from '@/components/ui/button';

import { Badge, ErrorState, LoadingState, PageHeader, formatDate } from '@/components/shared';
import { useAuth, usePermissions } from '@/lib/auth';
import { useAiSettings, useAiSettingsMutations } from '@/lib/queries';

export default function SettingsPage() {
  const { profile } = useAuth();
  const membership = profile?.memberships[0];
  const accessLabel = profile?.memberships.some(({ role }) => role === 'SYSTEM_ADMIN')
    ? 'SYSTEM ADMIN'
    : 'CUSTOM RBAC ACCESS';
  const aiSettings = useAiSettings();
  const actions = useAiSettingsMutations();
  const canManageSecrets = usePermissions().has('ai:configure');

  return (
    <>
      <PageHeader
        title="Settings"
        description="Organization controls, AI routing, usage visibility, and operating safeguards."
      />
      <div className="dashboard-grid settings-overview-grid">
        <Card className="p-[22px] max-[560px]:p-4 min-h-[178px]" asChild>
          <section>
          <span className="section-eyebrow">Organization</span>
          <CardTitle className="text-[17px]">{membership?.organization.name ?? 'Unavailable'}</CardTitle>
          <div className="grid grid-cols-3 gap-4 max-[560px]:grid-cols-1 compact-grid">
            <div className="rounded-xl bg-background p-3.5">
              <span>Organization ID</span>
              <strong className="mono">{membership?.organization.id ?? 'Unavailable'}</strong>
            </div>
            <div className="rounded-xl bg-background p-3.5">
              <span>Your role</span>
              <strong>{accessLabel}</strong>
            </div>
          </div>
          </section>
        </Card>
        <Card className="p-[22px] max-[560px]:p-4 min-h-[178px]" asChild>
          <section className="settings-boundary-panel">
          <span className="section-eyebrow">Security boundary</span>
          <CardTitle className="text-[17px]">Credentials stay on the backend</CardTitle>
          <p>
            Provider keys are encrypted before persistence and are never returned to the browser,
            audit log, or frontend bundle.
          </p>
          </section>
        </Card>
      </div>

      <section className="settings-section section-gap" aria-labelledby="ai-settings-title">
        <div className="section-heading-row">
          <div>
            <span className="section-eyebrow">AI operations</span>
            <h2 id="ai-settings-title">Provider routing and consumption</h2>
            <p>
              Choose the provider used by new AI jobs and configure each provider independently. For
              transcript summaries and finding extraction, the balanced tiers are recommended — the
              premium flagships rarely improve results for this workload.
            </p>
          </div>
        </div>

        {aiSettings.isLoading ? (
          <LoadingState label="Loading AI configuration…" />
        ) : aiSettings.isError ? (
          <ErrorState error={aiSettings.error} retry={() => void aiSettings.refetch()} />
        ) : aiSettings.data ? (
          <>
            {!aiSettings.data.keyStorageAvailable ? (
              <Alert variant="warning" className="ai-storage-warning">
                Secure key entry is disabled until <code>AI_CREDENTIALS_ENCRYPTION_KEY</code> is
                configured on the backend. Existing environment keys continue to work.
              </Alert>
            ) : null}
            <div className="ai-routing-control">
              <div className="ai-routing-icon" aria-hidden>
                <svg viewBox="0 0 24 24">
                  <path d="M5 5h5a4 4 0 0 1 4 4v10M5 19h5a4 4 0 0 0 4-4V9m0 0 3-3m-3 3 3 3" />
                </svg>
              </div>
              <div className="ai-routing-copy">
                <span>Default provider routing</span>
                <strong>
                  New AI jobs use{' '}
                  {aiSettings.data.activeProvider === 'OPENAI' ? 'OpenAI' : 'Anthropic'}
                </strong>
                <small>Existing jobs keep the provider and model recorded when they started.</small>
              </div>
              <div className="ai-provider-switch" role="group" aria-label="Active AI provider">
                {(['ANTHROPIC', 'OPENAI'] as const).map((providerName) => {
                  const selected = aiSettings.data?.activeProvider === providerName;
                  return (
                    <button
                      key={providerName}
                      className={selected ? 'is-selected' : ''}
                      type="button"
                      aria-pressed={selected}
                      disabled={!canManageSecrets || actions.setActiveProvider.isPending}
                      onClick={() => {
                        if (!selected) actions.setActiveProvider.mutate(providerName);
                      }}
                    >
                      <span className="ai-switch-mark" aria-hidden>
                        {providerName === 'ANTHROPIC' ? 'A' : 'O'}
                      </span>
                      {providerName === 'ANTHROPIC' ? 'Anthropic' : 'OpenAI'}
                      {selected ? (
                        <span className="ai-switch-check" aria-hidden>
                          ✓
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="ai-provider-grid">
              {aiSettings.data.providers.map((provider) => (
                <AiProviderPanel
                  key={provider.provider}
                  provider={provider}
                  active={aiSettings.data?.activeProvider === provider.provider}
                  canManage={canManageSecrets}
                  keyStorageAvailable={aiSettings.data?.keyStorageAvailable ?? false}
                  onSave={(input) => actions.updateProvider.mutateAsync(input)}
                  onValidate={() => actions.validateProvider.mutateAsync(provider.provider)}
                />
              ))}
            </div>
            <p className="footnote ai-usage-note">
              Consumption covers AI calls recorded by TexasRenters since{' '}
              {formatDate(aiSettings.data.usageWindow.startsAt)}. Standard provider API keys do not
              expose account credit balances; the optional monthly token budget is a local control,
              not a provider billing balance.
            </p>
          </>
        ) : null}
      </section>

      <Card className="p-[22px] max-[560px]:p-4" asChild>
        <section className="section-gap">
        <span className="section-eyebrow">Governance</span>
        <CardTitle className="text-[17px]">Human review safeguards</CardTitle>
        <ul className="plain-list">
          <li>AI room tags remain drafts until an authorized person approves them.</li>
          <li>AI findings remain pending review until an authorized person reviews them.</li>
          <li>AI does not approve tenant charges or decide legal responsibility.</li>
          <li>One video belongs to exactly one approved room and one inspection area.</li>
        </ul>
        </section>
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
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

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
        tone: 'danger',
        text: error instanceof Error ? error.message : 'The request could not be completed.',
      });
    } finally {
      setPending(null);
    }
  };

  return (
    <Card
      className={cn('p-[22px] max-[560px]:p-4', 'ai-provider-panel', active && 'is-active')}
      asChild
    >
    <article>
      <div className="ai-provider-heading">
        <div className="ai-provider-identity">
          <div className="ai-provider-mark" aria-hidden>
            {provider.provider === 'ANTHROPIC' ? 'A' : 'O'}
          </div>
          <div>
            <div className="ai-provider-title-row">
              <h3>{provider.displayName}</h3>
              {active ? <Badge value="ACTIVE" /> : null}
            </div>
            <p>
              {(() => {
                const selected = provider.models.find((model) => model.id === modelId);
                return selected ? `${selected.name} · ${selected.tier}` : 'AI provider';
              })()}
            </p>
          </div>
        </div>
        <div className="ai-credential-status">
          <span>Credential</span>
          <Badge value={provider.credentialStatus} />
        </div>
      </div>

      <div className="ai-subsection-heading">
        <div>
          <span>Usage</span>
          <strong>This month</strong>
        </div>
        <small>{provider.usage.requests.toLocaleString()} requests recorded</small>
      </div>
      <div className="ai-usage-grid">
        <div className="ai-usage-primary">
          <span>Total tokens</span>
          <strong>{provider.usage.totalTokens.toLocaleString()}</strong>
          <small>Processed by TexasRenters</small>
        </div>
        <div>
          <span>Input tokens</span>
          <strong>{provider.usage.inputTokens.toLocaleString()}</strong>
        </div>
        <div>
          <span>Output tokens</span>
          <strong>{provider.usage.outputTokens.toLocaleString()}</strong>
        </div>
        <div>
          <span>Budget remaining</span>
          <strong>
            {provider.usage.remainingBudgetTokens === null
              ? 'Not set'
              : provider.usage.remainingBudgetTokens.toLocaleString()}
          </strong>
        </div>
      </div>

      {provider.usage.budgetPercentUsed !== null ? (
        <div className="ai-budget-meter">
          <div>
            <span>Monthly token budget</span>
            <strong>{provider.usage.budgetPercentUsed}% used</strong>
          </div>
          <progress max="100" value={provider.usage.budgetPercentUsed} />
        </div>
      ) : null}

      <div className="ai-subsection-heading ai-configuration-heading">
        <div>
          <span>Configuration</span>
          <strong>Model, budget, and credential</strong>
        </div>
      </div>
      <div className="ai-provider-form">
        <label className="col-span-full">
          <span>Model</span>
          <Select disabled={!canManage} onValueChange={setModelId} value={modelId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {provider.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.name} — {model.tier}
                  {model.recommended ? ' · Recommended' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {(() => {
            const selected = provider.models.find((model) => model.id === modelId);
            if (!selected) return null;
            return (
              <span className="ai-model-hint">
                {selected.recommended ? (
                  <strong className="ai-model-recommended">Recommended for inspections · </strong>
                ) : null}
                {selected.description}
                {selected.pricing ? <em> {selected.pricing}.</em> : null}
              </span>
            );
          })()}
        </label>
        <label>
          <span>Monthly token budget (optional)</span>
          <input
            type="number"
            min="1000"
            step="1000"
            value={budget}
            disabled={!canManage}
            placeholder="e.g. 1000000"
            onChange={(event) => setBudget(event.target.value)}
          />
          <small className="text-[10px] text-muted-foreground">
            Soft limit for this provider&apos;s monthly token use. Leave blank for no local cap.
          </small>
        </label>
        <label className="col-span-full">
          <span>API key</span>
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={!canManage || !keyStorageAvailable || clearApiKey}
            placeholder={
              provider.hasApiKey
                ? 'Configured — enter a new key to replace'
                : 'Enter provider API key'
            }
            onChange={(event) => setApiKey(event.target.value)}
          />
          <small>
            {provider.hasApiKey
              ? `Configured from ${provider.keySource.toLowerCase()}; the value is never displayed.`
              : 'No key is configured.'}
          </small>
        </label>
        {provider.keySource === 'SETTINGS' && canManage ? (
          <label className="checkbox-label ai-clear-key">
            <Checkbox
              checked={clearApiKey}
              onCheckedChange={(checked) => setClearApiKey(checked === true)}
            />
            Remove the stored key and fall back to the backend environment key
          </label>
        ) : null}
      </div>

      {message ? <div className={`alert alert-${message.tone}`}>{message.text}</div> : null}
      <div className="ai-provider-footer">
        <div className="ai-provider-meta">
          <span>Validated {formatDate(provider.lastValidatedAt)}</span>
          <span>Last used {formatDate(provider.usage.lastUsedAt)}</span>
        </div>
        <div className="form-actions ai-provider-actions">
          <button
            className={buttonVariants({ variant: 'secondary' })}
            type="button"
            disabled={!canManage || !provider.hasApiKey || pending !== null}
            onClick={() => void run('validate', onValidate)}
          >
            {pending === 'validate' ? 'Checking…' : 'Test connection'}
          </button>
          <button
            className={buttonVariants({ variant: 'primary' })}
            type="button"
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
          >
            {pending === 'save' ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </article>
    </Card>
  );
}

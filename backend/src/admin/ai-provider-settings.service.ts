import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { AiCredentialStatus, AiProvider } from '@prisma/client';
import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import type { UpdateAiProviderDto } from './admin.dto';

// Ordered economical → most capable. The TexasRenters AI workload (transcript
// summarization, finding extraction, floor-plan parsing) is well served by the
// balanced tiers; the premium tiers are available but rarely worth their cost
// here, and frontier agentic models (e.g. Claude Fable 5) are intentionally
// excluded as overkill for this task profile.
export const AI_MODEL_CATALOG = {
  ANTHROPIC: [
    {
      id: 'claude-haiku-4-5-20251001',
      name: 'Claude Haiku 4.5',
      tier: 'Economical',
      pricing: '$1 in / $5 out per 1M tokens',
      description: 'Fastest and cheapest — short transcripts and routine summaries at volume.',
    },
    {
      id: 'claude-sonnet-4-6',
      name: 'Claude Sonnet 4.6',
      tier: 'Balanced (previous generation)',
      pricing: '$3 in / $15 out per 1M tokens',
      description: 'Previous-generation balanced model; a stable fallback tier.',
    },
    {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      tier: 'Balanced',
      pricing: '$3 in / $15 out per 1M tokens (intro $2 / $10 through Aug 2026)',
      description:
        'Near-Opus quality on analysis and extraction at Sonnet cost — the best fit for inspection findings.',
      recommended: true,
    },
    {
      id: 'claude-opus-4-8',
      name: 'Claude Opus 4.8',
      tier: 'Highest capability',
      pricing: '$5 in / $25 out per 1M tokens',
      description: 'Premium tier for the hardest analyses; rarely needed for routine inspections.',
    },
  ],
  OPENAI: [
    {
      id: 'gpt-5-nano',
      name: 'GPT-5 nano',
      tier: 'Ultra-economical',
      pricing: '$0.05 in / $0.40 out per 1M tokens',
      description: 'Cheapest option — bulk classification and very short summaries only.',
    },
    {
      id: 'gpt-5.6-luna',
      name: 'GPT-5.6 Luna',
      tier: 'Economical',
      pricing: '$1 in / $6 out per 1M tokens',
      description: 'Fast, low-cost tier for high-volume, latency-sensitive jobs.',
    },
    {
      id: 'gpt-5.6-terra',
      name: 'GPT-5.6 Terra',
      tier: 'Balanced',
      pricing: '$2.50 in / $15 out per 1M tokens',
      description: 'Everyday workhorse — the best fit for inspection findings on OpenAI.',
      recommended: true,
    },
    {
      id: 'gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      tier: 'Highest capability',
      pricing: '$5 in / $30 out per 1M tokens',
      description: 'Flagship tier for the hardest analyses; rarely needed for routine inspections.',
    },
  ],
} as const;

// Defaults deliberately point at the balanced tier, not the premium flagship.
const DEFAULT_MODELS: Record<AiProvider, string> = {
  ANTHROPIC: 'claude-sonnet-5',
  OPENAI: 'gpt-5.6-terra',
};

export interface ResolvedAiConfiguration {
  provider: AiProvider;
  modelId: string;
  apiKey: string;
}

export interface AiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

@Injectable()
export class AiProviderSettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async settings(organizationId: string) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [routing, configurations, usage, recent] = await Promise.all([
      this.prisma.organizationAiSettings.findUnique({ where: { organizationId } }),
      this.prisma.aiProviderConfiguration.findMany({ where: { organizationId } }),
      this.prisma.aiUsageEvent.groupBy({
        by: ['provider'],
        where: { organizationId, createdAt: { gte: monthStart } },
        _sum: { inputTokens: true, outputTokens: true, totalTokens: true },
        _count: { _all: true },
      }),
      this.prisma.aiUsageEvent.findMany({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        distinct: ['provider'],
        select: { provider: true, createdAt: true },
      }),
    ]);
    const activeProvider = routing?.activeProvider ?? this.environmentProvider();
    return {
      activeProvider,
      keyStorageAvailable: Boolean(this.encryptionKey(false)),
      usageWindow: { startsAt: monthStart.toISOString(), endsAt: this.monthEnd().toISOString() },
      providers: ([AiProvider.ANTHROPIC, AiProvider.OPENAI] as const).map((provider) => {
        const configuration = configurations.find((item) => item.provider === provider);
        const aggregate = usage.find((item) => item.provider === provider);
        const used = aggregate?._sum.totalTokens ?? 0;
        const budget = configuration?.monthlyTokenBudget ?? null;
        const hasStoredKey = Boolean(configuration?.encryptedApiKey);
        const hasEnvironmentKey = Boolean(this.environmentApiKey(provider));
        return {
          provider,
          displayName: provider === AiProvider.ANTHROPIC ? 'Anthropic' : 'OpenAI',
          modelId: configuration?.modelId ?? this.environmentModel(provider),
          models: AI_MODEL_CATALOG[provider],
          hasApiKey: hasStoredKey || hasEnvironmentKey,
          keySource: hasStoredKey ? 'SETTINGS' : hasEnvironmentKey ? 'ENVIRONMENT' : 'NONE',
          credentialStatus:
            configuration && (hasStoredKey || hasEnvironmentKey)
              ? configuration.credentialStatus
              : hasEnvironmentKey
                ? AiCredentialStatus.UNVERIFIED
                : 'NOT_CONFIGURED',
          lastValidatedAt: configuration?.lastValidatedAt?.toISOString() ?? null,
          monthlyTokenBudget: budget,
          usage: {
            requests: aggregate?._count._all ?? 0,
            inputTokens: aggregate?._sum.inputTokens ?? 0,
            outputTokens: aggregate?._sum.outputTokens ?? 0,
            totalTokens: used,
            remainingBudgetTokens: budget === null ? null : Math.max(0, budget - used),
            budgetPercentUsed: budget ? Math.min(100, Math.round((used / budget) * 1000) / 10) : null,
            lastUsedAt:
              recent.find((item) => item.provider === provider)?.createdAt.toISOString() ?? null,
          },
          balanceStatus: 'NOT_EXPOSED_BY_STANDARD_API_KEY',
        };
      }),
    };
  }

  async setActiveProvider(user: AuthenticatedUser, provider: AiProvider) {
    await this.prisma.organizationAiSettings.upsert({
      where: { organizationId: user.organizationId },
      create: { organizationId: user.organizationId, activeProvider: provider },
      update: { activeProvider: provider },
    });
    await this.audit(user, 'AI_ACTIVE_PROVIDER_CHANGED', { provider });
    return this.settings(user.organizationId);
  }

  async updateProvider(user: AuthenticatedUser, provider: AiProvider, input: UpdateAiProviderDto) {
    this.assertSupportedModel(provider, input.modelId);
    const existing = await this.prisma.aiProviderConfiguration.findUnique({
      where: { organizationId_provider: { organizationId: user.organizationId, provider } },
    });
    let encryptedApiKey = existing?.encryptedApiKey ?? null;
    let credentialStatus = existing?.credentialStatus ?? AiCredentialStatus.UNVERIFIED;
    let lastValidatedAt = existing?.lastValidatedAt ?? null;
    if (input.clearApiKey) {
      encryptedApiKey = null;
      credentialStatus = AiCredentialStatus.UNVERIFIED;
      lastValidatedAt = null;
    } else if (input.apiKey) {
      encryptedApiKey = this.encrypt(input.apiKey.trim());
      credentialStatus = AiCredentialStatus.UNVERIFIED;
      lastValidatedAt = null;
    }
    await this.prisma.aiProviderConfiguration.upsert({
      where: { organizationId_provider: { organizationId: user.organizationId, provider } },
      create: {
        organizationId: user.organizationId,
        provider,
        modelId: input.modelId,
        encryptedApiKey,
        credentialStatus,
        lastValidatedAt,
        monthlyTokenBudget: input.monthlyTokenBudget ?? null,
      },
      update: {
        modelId: input.modelId,
        encryptedApiKey,
        credentialStatus,
        lastValidatedAt,
        monthlyTokenBudget: input.monthlyTokenBudget ?? null,
      },
    });
    await this.audit(user, 'AI_PROVIDER_CONFIGURATION_UPDATED', {
      provider,
      modelId: input.modelId,
      apiKeyChanged: Boolean(input.apiKey || input.clearApiKey),
      monthlyTokenBudget: input.monthlyTokenBudget ?? null,
    });
    return this.settings(user.organizationId);
  }

  async validateProvider(user: AuthenticatedUser, provider: AiProvider) {
    const resolved = await this.resolve(user.organizationId, provider);
    const valid = await this.validateCredential(resolved);
    await this.prisma.aiProviderConfiguration.upsert({
      where: { organizationId_provider: { organizationId: user.organizationId, provider } },
      create: {
        organizationId: user.organizationId,
        provider,
        modelId: resolved.modelId,
        credentialStatus: valid ? AiCredentialStatus.VALID : AiCredentialStatus.INVALID,
        lastValidatedAt: new Date(),
      },
      update: {
        credentialStatus: valid ? AiCredentialStatus.VALID : AiCredentialStatus.INVALID,
        lastValidatedAt: new Date(),
      },
    });
    await this.audit(user, 'AI_PROVIDER_CREDENTIAL_VALIDATED', { provider, valid });
    if (!valid)
      throw new ApplicationError(
        422,
        'AI_PROVIDER_CREDENTIAL_INVALID',
        'The provider did not accept this credential or could not be reached. Verify the key and retry.',
      );
    return this.settings(user.organizationId);
  }

  async resolve(organizationId: string, requestedProvider?: AiProvider) {
    const [routing, configuration] = await Promise.all([
      requestedProvider
        ? null
        : this.prisma.organizationAiSettings.findUnique({ where: { organizationId } }),
      requestedProvider
        ? this.prisma.aiProviderConfiguration.findUnique({
            where: { organizationId_provider: { organizationId, provider: requestedProvider } },
          })
        : null,
    ]);
    const provider = requestedProvider ?? routing?.activeProvider ?? this.environmentProvider();
    const selected =
      configuration ??
      (await this.prisma.aiProviderConfiguration.findUnique({
        where: { organizationId_provider: { organizationId, provider } },
      }));
    const apiKey = selected?.encryptedApiKey
      ? this.decrypt(selected.encryptedApiKey)
      : this.environmentApiKey(provider);
    if (!apiKey)
      throw new ApplicationError(
        503,
        'AI_PROVIDER_NOT_CONFIGURED',
        `${provider === AiProvider.ANTHROPIC ? 'Anthropic' : 'OpenAI'} is selected but has no API key. Configure it in Settings.`,
      );
    // Stored configurations can carry an empty modelId (e.g. created by a
    // credential validation before a model was chosen) — treat it as unset.
    const modelId = selected?.modelId?.trim() || this.environmentModel(provider);
    return { provider, modelId, apiKey } satisfies ResolvedAiConfiguration;
  }

  async recordUsage(
    organizationId: string,
    configuration: Pick<ResolvedAiConfiguration, 'provider' | 'modelId'>,
    operation: string,
    usage: AiTokenUsage,
    sourceId?: string,
  ) {
    await this.prisma.aiUsageEvent.create({
      data: {
        organizationId,
        provider: configuration.provider,
        modelId: configuration.modelId,
        operation,
        sourceId,
        inputTokens: Math.max(0, usage.inputTokens),
        outputTokens: Math.max(0, usage.outputTokens),
        totalTokens: Math.max(0, usage.totalTokens),
      },
    });
  }

  private async validateCredential(configuration: ResolvedAiConfiguration) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(
        configuration.provider === AiProvider.ANTHROPIC
          ? 'https://api.anthropic.com/v1/models?limit=100'
          : 'https://api.openai.com/v1/models',
        {
          signal: controller.signal,
          headers:
            configuration.provider === AiProvider.ANTHROPIC
              ? { 'x-api-key': configuration.apiKey, 'anthropic-version': '2023-06-01' }
              : { authorization: `Bearer ${configuration.apiKey}` },
        },
      );
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertSupportedModel(provider: AiProvider, modelId: string) {
    if (!AI_MODEL_CATALOG[provider].some((model) => model.id === modelId))
      throw new ApplicationError(
        422,
        'AI_MODEL_NOT_SUPPORTED',
        'Select a supported model from the provider catalog.',
      );
  }

  private environmentProvider() {
    return process.env.FLOOR_PLAN_EXTRACTION_PROVIDER === 'openai'
      ? AiProvider.OPENAI
      : AiProvider.ANTHROPIC;
  }

  private environmentApiKey(provider: AiProvider) {
    return provider === AiProvider.ANTHROPIC
      ? process.env.ANTHROPIC_API_KEY
      : process.env.OPENAI_API_KEY;
  }

  private environmentModel(provider: AiProvider) {
    return (
      (provider === AiProvider.ANTHROPIC
        ? process.env.ANTHROPIC_FLOOR_PLAN_MODEL
        : process.env.OPENAI_FLOOR_PLAN_MODEL) ?? DEFAULT_MODELS[provider]
    );
  }

  private encryptionKey(required = true) {
    const value = process.env.AI_CREDENTIALS_ENCRYPTION_KEY?.trim();
    if (!value) {
      if (required)
        throw new ApplicationError(
          503,
          'AI_KEY_STORAGE_NOT_CONFIGURED',
          'Secure AI key storage is not configured on the backend.',
        );
      return null;
    }
    const key = /^[a-f\d]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
    if (key.length !== 32) {
      if (required)
        throw new ApplicationError(
          503,
          'AI_KEY_STORAGE_NOT_CONFIGURED',
          'Secure AI key storage is not configured correctly on the backend.',
        );
      return null;
    }
    return key;
  }

  private encrypt(value: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey()!, iv);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  private decrypt(value: string) {
    try {
      const [version, iv, tag, ciphertext] = value.split('.');
      if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('invalid envelope');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey()!,
        Buffer.from(iv, 'base64url'),
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(ciphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError(
        503,
        'AI_CREDENTIAL_DECRYPTION_FAILED',
        'The stored AI credential could not be read safely. Replace it in Settings.',
      );
    }
  }

  private monthEnd() {
    const date = new Date();
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  }

  private audit(user: AuthenticatedUser, action: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType: 'OrganizationAiSettings',
        entityId: user.organizationId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

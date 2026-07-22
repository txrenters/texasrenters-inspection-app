import { AiCredentialStatus, AiProvider } from '@prisma/client';

import { AiProviderSettingsService } from '../src/admin/ai-provider-settings.service';
import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';

describe('AI provider settings security', () => {
  const originalEncryptionKey = process.env.AI_CREDENTIALS_ENCRYPTION_KEY;
  const user = {
    id: '00000000-0000-4000-8000-000000000001',
    organizationId: '00000000-0000-4000-8000-000000000002',
  } as AuthenticatedUser;

  beforeEach(() => {
    process.env.AI_CREDENTIALS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterAll(() => {
    if (originalEncryptionKey === undefined) delete process.env.AI_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.AI_CREDENTIALS_ENCRYPTION_KEY = originalEncryptionKey;
  });

  it('encrypts a submitted key and never places it in audit metadata', async () => {
    const prisma = prismaMock();
    const service = new AiProviderSettingsService(prisma as unknown as PrismaService);
    const secret = 'sk-ant-this-is-a-private-test-key';

    await service.updateProvider(user, AiProvider.ANTHROPIC, {
      modelId: 'claude-sonnet-5',
      apiKey: secret,
      monthlyTokenBudget: 100_000,
    });

    const persisted = prisma.aiProviderConfiguration.upsert.mock.calls[0][0].create;
    expect(persisted.encryptedApiKey).toMatch(/^v1\./);
    expect(persisted.encryptedApiKey).not.toContain(secret);
    expect(JSON.stringify(prisma.auditLog.create.mock.calls)).not.toContain(secret);
  });

  it('decrypts stored credentials only when resolving a backend provider call', async () => {
    const prisma = prismaMock();
    const service = new AiProviderSettingsService(prisma as unknown as PrismaService);
    const secret = 'sk-ant-this-is-another-private-key';
    await service.updateProvider(user, AiProvider.ANTHROPIC, {
      modelId: 'claude-sonnet-5',
      apiKey: secret,
    });
    const encryptedApiKey =
      prisma.aiProviderConfiguration.upsert.mock.calls[0][0].create.encryptedApiKey;
    prisma.aiProviderConfiguration.findUnique.mockResolvedValue({
      provider: AiProvider.ANTHROPIC,
      modelId: 'claude-sonnet-5',
      encryptedApiKey,
      credentialStatus: AiCredentialStatus.UNVERIFIED,
    });

    await expect(service.resolve(user.organizationId, AiProvider.ANTHROPIC)).resolves.toEqual({
      provider: AiProvider.ANTHROPIC,
      modelId: 'claude-sonnet-5',
      apiKey: secret,
    });
  });
});

function prismaMock() {
  return {
    organizationAiSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    aiProviderConfiguration: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({}),
    },
    aiUsageEvent: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

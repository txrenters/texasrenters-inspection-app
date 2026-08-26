/* Injection tokens are runtime imports required by Nest metadata. */
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ApiClient, ApiClientKey } from '@prisma/client';

import { MACHINE_GRANTABLE_PERMISSIONS } from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { apiKeyPepper, generateApiKey, type ApiKeyEnvironment } from './api-key';
import {
  isWritePermission,
  type ApiClientListQueryDto,
  type CreateApiClientDto,
  type CreateApiClientKeyDto,
  type UpdateApiClientDto,
} from './api-client.dto';

const GRANTABLE: ReadonlySet<string> = new Set(MACHINE_GRANTABLE_PERMISSIONS);

type ClientWithKeys = ApiClient & { keys?: ApiClientKey[] };

/**
 * Registration and key lifecycle for third-party integrations.
 *
 * Everything here is an operator action behind `system:manage`. The
 * corresponding *authentication* path lives in `ApiKeyGuard`, and the two share
 * only the hashing primitives — this service never sees a secret again after the
 * moment it mints one.
 */
@Injectable()
export class ApiClientService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser, query: ApiClientListQueryDto) {
    const where: Prisma.ApiClientWhereInput = { organizationId: user.organizationId };
    if (query.search) where.name = { contains: query.search, mode: Prisma.QueryMode.insensitive };
    if (query.active === 'true') where.isActive = true;
    if (query.active === 'false') where.isActive = false;

    const [total, records] = await Promise.all([
      this.prisma.apiClient.count({ where }),
      this.prisma.apiClient.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { keys: { orderBy: { createdAt: 'desc' } } },
      }),
    ]);

    return {
      data: records.map((record) => this.mapClient(record)),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  async get(user: AuthenticatedUser, id: string) {
    return this.mapClient(await this.require(user, id));
  }

  async create(user: AuthenticatedUser, input: CreateApiClientDto) {
    const permissions = this.sanitize(input.permissions);
    const requireSignature = input.requireSignature ?? false;
    this.assertWritesAreSigned(permissions, requireSignature);
    try {
      const client = await this.prisma.apiClient.create({
        data: {
          organizationId: user.organizationId,
          name: input.name,
          description: input.description || null,
          environment: (input.environment ?? 'LIVE') as ApiKeyEnvironment,
          permissions,
          rateLimitPerMinute: input.rateLimitPerMinute ?? 60,
          requireSignature,
          allowedIps: input.allowedIps ?? [],
          createdByUserId: user.id,
        },
        include: { keys: true },
      });
      await this.audit(user, 'API_CLIENT_CREATED', client.id, {
        name: client.name,
        environment: client.environment,
        permissions,
      });
      return this.mapClient(client);
    } catch (error) {
      throw this.mapDuplicateName(error);
    }
  }

  async update(user: AuthenticatedUser, id: string, input: UpdateApiClientDto) {
    const existing = await this.require(user, id);
    const data: Prisma.ApiClientUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description || null;
    if (input.permissions !== undefined) data.permissions = this.sanitize(input.permissions);
    if (input.rateLimitPerMinute !== undefined) data.rateLimitPerMinute = input.rateLimitPerMinute;
    if (input.requireSignature !== undefined) data.requireSignature = input.requireSignature;
    if (input.allowedIps !== undefined) data.allowedIps = input.allowedIps;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    // Checked against the *resulting* state rather than the submitted fields:
    // granting a write permission and clearing `requireSignature` in two
    // separate requests must be refused just as firmly as doing both in one.
    this.assertWritesAreSigned(
      input.permissions === undefined ? existing.permissions : this.sanitize(input.permissions),
      input.requireSignature ?? existing.requireSignature,
    );

    try {
      const client = await this.prisma.apiClient.update({
        where: { id },
        data,
        include: { keys: { orderBy: { createdAt: 'desc' } } },
      });
      await this.audit(user, 'API_CLIENT_UPDATED', client.id, {
        name: client.name,
        permissions: client.permissions,
        isActive: client.isActive,
        requireSignature: client.requireSignature,
      });
      return this.mapClient(client);
    } catch (error) {
      throw this.mapDuplicateName(error);
    }
  }

  /**
   * Revoke a client and every key it holds.
   *
   * Deliberately not a delete. The audit trail references this client by id, and
   * removing the row would turn every third-party action it ever took into an
   * unattributable one. Revocation stops it immediately — `ApiKeyGuard` refuses
   * an inactive client — while leaving the history readable.
   */
  async revoke(user: AuthenticatedUser, id: string) {
    const client = await this.require(user, id);
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.apiClient.update({ where: { id }, data: { isActive: false, revokedAt } }),
      this.prisma.apiClientKey.updateMany({
        where: { apiClientId: id, revokedAt: null },
        data: { revokedAt },
      }),
    ]);
    await this.audit(user, 'API_CLIENT_REVOKED', id, { name: client.name });
    return { id, revoked: true as const, revokedAt: revokedAt.toISOString() };
  }

  /**
   * Mint a key.
   *
   * The secret is returned here and nowhere else, ever: only a keyed hash is
   * stored, so a lost key is replaced rather than recovered.
   */
  async createKey(user: AuthenticatedUser, clientId: string, input: CreateApiClientKeyDto) {
    const client = await this.require(user, clientId);
    if (!client.isActive || client.revokedAt)
      throw new ApplicationError(
        409,
        'API_CLIENT_REVOKED',
        'Keys cannot be issued for a revoked client.',
      );
    if (!apiKeyPepper())
      throw new ApplicationError(
        503,
        'API_KEY_SIGNING_NOT_CONFIGURED',
        'API_KEY_PEPPER is not configured on this deployment, so keys cannot be issued.',
      );
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now())
      throw new ApplicationError(
        422,
        'API_KEY_EXPIRY_IN_PAST',
        'The expiry date must be in the future.',
      );

    const generated = generateApiKey(client.environment);
    const record = await this.prisma.apiClientKey.create({
      data: {
        apiClientId: client.id,
        organizationId: client.organizationId,
        prefix: generated.prefix,
        secretHash: generated.secretHash,
        label: input.label || null,
        expiresAt,
        createdByUserId: user.id,
      },
    });
    await this.audit(user, 'API_CLIENT_KEY_ISSUED', client.id, {
      keyId: record.id,
      prefix: record.prefix,
      label: record.label,
      expiresAt: expiresAt?.toISOString() ?? null,
    });
    return {
      ...this.mapKey(record),
      // Returned once, here. The console has to say so plainly, because there is
      // no second chance to read it.
      key: generated.key,
    };
  }

  async revokeKey(user: AuthenticatedUser, clientId: string, keyId: string) {
    await this.require(user, clientId);
    const key = await this.prisma.apiClientKey.findFirst({
      where: { id: keyId, apiClientId: clientId },
    });
    if (!key) throw new ApplicationError(404, 'API_KEY_NOT_FOUND', 'The API key was not found.');
    if (key.revokedAt) return this.mapKey(key);
    const updated = await this.prisma.apiClientKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
    await this.audit(user, 'API_CLIENT_KEY_REVOKED', clientId, {
      keyId,
      prefix: key.prefix,
      label: key.label,
    });
    return this.mapKey(updated);
  }

  private async require(user: AuthenticatedUser, id: string) {
    const client = await this.prisma.apiClient.findFirst({
      where: { id, organizationId: user.organizationId },
      include: { keys: { orderBy: { createdAt: 'desc' } } },
    });
    if (!client)
      throw new ApplicationError(404, 'API_CLIENT_NOT_FOUND', 'The API client was not found.');
    return client;
  }

  /**
   * Drop anything not machine-grantable.
   *
   * The DTO already refuses these, so reaching this is a bug rather than user
   * input — but the cost of being wrong is a live credential holding a
   * permission the catalog says it may never hold, so it is checked on both
   * sides.
   */
  private sanitize(permissions: string[]) {
    return permissions.filter((permission) => GRANTABLE.has(permission));
  }

  private assertWritesAreSigned(permissions: string[], requireSignature: boolean) {
    if (requireSignature) return;
    const writes = permissions.filter((permission) => isWritePermission(permission));
    if (writes.length === 0) return;
    throw new ApplicationError(
      422,
      'API_CLIENT_SIGNATURE_REQUIRED',
      'A client granted write permissions must require request signing.',
      writes,
    );
  }

  private mapClient(client: ClientWithKeys) {
    return {
      id: client.id,
      name: client.name,
      description: client.description,
      environment: client.environment,
      permissions: client.permissions,
      rateLimitPerMinute: client.rateLimitPerMinute,
      requireSignature: client.requireSignature,
      allowedIps: client.allowedIps,
      isActive: client.isActive && !client.revokedAt,
      createdAt: client.createdAt.toISOString(),
      updatedAt: client.updatedAt.toISOString(),
      revokedAt: client.revokedAt?.toISOString() ?? null,
      keys: (client.keys ?? []).map((key) => this.mapKey(key)),
    };
  }

  private mapKey(key: ApiClientKey) {
    return {
      id: key.id,
      // The prefix, never the secret. Safe to show and to log — that is what it
      // is for.
      prefix: key.prefix,
      label: key.label,
      createdAt: key.createdAt.toISOString(),
      expiresAt: key.expiresAt?.toISOString() ?? null,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      lastUsedIp: key.lastUsedIp,
      revokedAt: key.revokedAt?.toISOString() ?? null,
    };
  }

  private mapDuplicateName(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      return new ApplicationError(
        409,
        'API_CLIENT_NAME_EXISTS',
        'An API client with that name already exists in this organization.',
      );
    return error;
  }

  private async audit(
    user: AuthenticatedUser,
    action: string,
    clientId: string,
    metadata: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        ...auditActor(user),
        action,
        entityType: 'ApiClient',
        entityId: clientId,
        metadata,
      },
    });
  }
}

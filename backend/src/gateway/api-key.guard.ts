/* Injection tokens are runtime imports required by Nest metadata. */
import { Inject, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { isPermissionKey, type PermissionKey } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { withSystemTenant } from '../database/tenant-context';
import { API_KEY_HEADER } from '../openapi/openapi.document';
import { apiKeySecretMatches, parseApiKey, verifySignature } from './api-key';
import { MACHINE_ACCESSIBLE_METADATA_KEY } from './machine-accessible.decorator';

export const SIGNATURE_HEADER = 'x-signature';
export const TIMESTAMP_HEADER = 'x-timestamp';

/** Methods that change state, and therefore may not be replayed. */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Only touch `lastUsedAt` this often, rather than writing on every request. */
const LAST_USED_REFRESH_MS = 60_000;

export interface ApiKeyRequest extends Request {
  user: AuthenticatedUser;
  /** Populated by Nest because the application is created with `rawBody: true`. */
  rawBody?: Buffer;
  /**
   * The calling client's per-minute allowance, carried from this guard to the
   * rate limiter so the limiter does not repeat the database read that
   * authentication has already done.
   */
  apiClientRateLimit?: number;
}

/**
 * The caller's address as the allowlist should see it.
 *
 * `request.ips` is populated only when Express is told to trust a proxy, and is
 * ordered client-first. Behind the production nginx with no such configuration
 * every request appears to come from the proxy — so an allowlist would either
 * match nothing or match everything, both silently. Falling back to
 * `request.ip` keeps direct deployments correct; the configuration note lives
 * with TRUST_PROXY_HOPS.
 */
export function clientIp(request: Request) {
  return request.ips?.[0] ?? request.ip ?? '';
}

/**
 * Authenticates a registered third-party integration from its API key.
 *
 * Resolves the key to the same {@link AuthenticatedUser} shape a signed-in
 * person produces, which is what makes the rest of the system apply unchanged:
 * `PermissionsGuard` authorizes it, `TenantScopeInterceptor` scopes its queries,
 * and row-level security polices them. There is no second authorization path for
 * machines to drift out of step with.
 *
 * Every rejection below says the same thing to the caller. Distinguishing
 * "unknown key" from "wrong secret" from "revoked" hands an attacker a probe.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>();
    const parsed = parseApiKey(request.header(API_KEY_HEADER));
    // Distinguishable from a rejected key on purpose: "you sent nothing" tells
    // an attacker nothing, and tells an integrator exactly what to fix.
    if (!parsed)
      throw new ApplicationError(
        401,
        'API_KEY_MISSING',
        `A valid ${API_KEY_HEADER} header is required.`,
      );

    // Before the tenant exists, because this lookup is what produces it — the
    // same exception the user-profile lookup needs, and the reason the policy on
    // ApiClientKey permits the system tenant.
    const record = await withSystemTenant(() =>
      this.prisma.apiClientKey.findUnique({
        where: { prefix: parsed.prefix },
        include: { client: true },
      }),
    );

    /**
     * One code and one message for every way a key can be rejected.
     *
     * Unknown prefix, wrong secret, revoked, expired, wrong environment, dead
     * client — all identical from outside. Splitting them would hand an attacker
     * a probe for which prefixes exist and which are still live, and the
     * integrator's next step is the same in every case: check the key.
     */
    const invalid = new ApplicationError(401, 'API_KEY_INVALID', 'The API key is not valid.');
    if (!record) throw invalid;
    if (!apiKeySecretMatches(parsed.prefix, parsed.secret, record.secretHash)) throw invalid;
    if (record.revokedAt) throw invalid;
    if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) throw invalid;

    const client = record.client;
    if (!client.isActive || client.revokedAt) throw invalid;
    // A test key must not reach a live client's data, nor the reverse. The
    // environment travels in the credential precisely so this can be checked.
    if (client.environment !== parsed.environment) throw invalid;

    if (client.allowedIps.length > 0 && !client.allowedIps.includes(clientIp(request)))
      throw new ApplicationError(
        403,
        'API_KEY_ADDRESS_NOT_ALLOWED',
        'This API key is not permitted from this address.',
      );

    // Authenticated first, so an unauthenticated caller cannot map which routes
    // are open to integrations by reading the difference between 401 and 403.
    const machineAccessible = this.reflector.getAllAndOverride<boolean>(
      MACHINE_ACCESSIBLE_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!machineAccessible)
      throw new ApplicationError(
        403,
        'API_ROUTE_NOT_OPEN_TO_KEYS',
        'This endpoint is not available to API key clients.',
      );

    const method = request.method.toUpperCase();
    if (WRITE_METHODS.has(method)) {
      // Enforced here and not only where the client was created, so relaxing the
      // flag afterwards cannot quietly open unsigned writes.
      if (!client.requireSignature)
        throw new ApplicationError(
          403,
          'API_CLIENT_WRITE_NOT_ENABLED',
          'This client is not configured for write access. Request signing is required to write.',
        );
      const failure = verifySignature(
        parsed.secret,
        method,
        request.originalUrl.split('?')[0] ?? request.path,
        request.header(TIMESTAMP_HEADER),
        request.header(SIGNATURE_HEADER),
        request.rawBody,
      );
      // Distinguished from API_KEY_INVALID, and safely so: this is only
      // reachable once the key has already been accepted, so the caller learns
      // nothing they did not already hold.
      if (failure)
        throw new ApplicationError(
          401,
          'API_SIGNATURE_INVALID',
          `The request signature could not be verified (${failure}).`,
          [failure],
        );
    }

    request.user = {
      id: client.id,
      // No auth user exists behind a machine credential. The client id stands in
      // so anything keying off `authUserId` has a stable, non-null value that is
      // obviously not a person's.
      authUserId: `api-client:${client.id}`,
      organizationId: client.organizationId,
      displayName: client.name,
      roles: [],
      permissions: client.permissions.filter((value): value is PermissionKey =>
        isPermissionKey(value),
      ),
      mustChangePassword: false,
      principalType: 'API_KEY',
      apiClientId: client.id,
    };

    request.apiClientRateLimit = client.rateLimitPerMinute;

    this.touch(record.id, record.lastUsedAt, clientIp(request));
    return true;
  }

  /**
   * Record that the key was used, at most once a minute.
   *
   * Fire-and-forget and deliberately unawaited: this is operational telemetry
   * for the console's "last used" column, and a write failure here must not fail
   * an otherwise valid request. Throttled because writing a row on every request
   * would make the busiest key the most expensive one to authenticate.
   */
  private touch(keyId: string, lastUsedAt: Date | null, ip: string) {
    if (lastUsedAt && Date.now() - lastUsedAt.getTime() < LAST_USED_REFRESH_MS) return;
    void withSystemTenant(() =>
      this.prisma.apiClientKey.update({
        where: { id: keyId },
        data: { lastUsedAt: new Date(), lastUsedIp: ip || null },
      }),
    ).catch(() => undefined);
  }
}

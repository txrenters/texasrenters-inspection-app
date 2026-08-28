import type { ExecutionContext } from '@nestjs/common';
import { ForbiddenException, HttpException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import {
  MACHINE_FORBIDDEN_PERMISSIONS,
  MACHINE_GRANTABLE_PERMISSIONS,
  PERMISSION_KEYS,
} from '@texasrenters/shared';

import type { PrismaService } from '../src/common/prisma.service';
import { GatewayController } from '../src/gateway/gateway.controller';
import { ApiClientService } from '../src/gateway/api-client.service';
import {
  apiKeySecretMatches,
  computeSignature,
  generateApiKey,
  hashApiKeySecret,
  parseApiKey,
  verifySignature,
} from '../src/gateway/api-key';
import { ApiKeyGuard, type ApiKeyRequest } from '../src/gateway/api-key.guard';
import { MACHINE_ACCESSIBLE_METADATA_KEY } from '../src/gateway/machine-accessible.decorator';
import { ApiRateLimitGuard } from '../src/gateway/rate-limit.guard';

const PEPPER = 'a'.repeat(48);

function withPepper<T>(fn: () => T) {
  process.env.API_KEY_PEPPER = PEPPER;
  try {
    return fn();
  } finally {
    delete process.env.API_KEY_PEPPER;
  }
}

describe('API key credentials', () => {
  it('round-trips a generated key and rejects a secret that is one character off', () => {
    withPepper(() => {
      const generated = generateApiKey('LIVE');
      const parsed = parseApiKey(generated.key);

      expect(parsed).toMatchObject({ environment: 'LIVE', prefix: generated.prefix });
      expect(apiKeySecretMatches(parsed!.prefix, parsed!.secret, generated.secretHash)).toBe(true);

      const tampered = `${parsed!.secret.slice(0, -1)}${parsed!.secret.endsWith('A') ? 'B' : 'A'}`;
      expect(apiKeySecretMatches(parsed!.prefix, tampered, generated.secretHash)).toBe(false);
    });
  });

  it('binds the hash to the prefix, so a stored hash cannot be moved to another key row', () => {
    withPepper(() => {
      const generated = generateApiKey('LIVE');
      const secret = parseApiKey(generated.key)!.secret;

      // Same secret, different prefix. If the prefix were not part of the hashed
      // material an operator could transplant one row's hash onto another and
      // the old credential would keep working under a new identity.
      expect(apiKeySecretMatches('ffffffffffff', secret, generated.secretHash)).toBe(false);
    });
  });

  it('carries the environment in the credential itself', () => {
    withPepper(() => {
      expect(parseApiKey(generateApiKey('TEST').key)?.environment).toBe('TEST');
      expect(parseApiKey(generateApiKey('LIVE').key)?.environment).toBe('LIVE');
    });
  });

  it('derives a hashing key from the signing secret when none is configured', () => {
    delete process.env.API_KEY_PEPPER;
    process.env.AUTH_JWT_SECRET = 'a-signing-secret-that-every-deployment-has';

    // The feature used to ship switched off: without its own API_KEY_PEPPER,
    // issuing a key returned 503 on a perfectly healthy deployment. A 256-bit
    // random secret cannot be guessed whether or not the hash is peppered, so
    // demanding separate configuration bought nothing and cost the feature.
    const generated = generateApiKey('LIVE');
    const parsed = parseApiKey(generated.key)!;
    expect(apiKeySecretMatches(parsed.prefix, parsed.secret, generated.secretHash)).toBe(true);

    delete process.env.AUTH_JWT_SECRET;
  });

  it('derives a different key per signing secret, so deployments never validate each other', () => {
    delete process.env.API_KEY_PEPPER;
    process.env.AUTH_JWT_SECRET = 'deployment-one-signing-secret-value';
    const generated = generateApiKey('LIVE');
    const parsed = parseApiKey(generated.key)!;

    // The property the old hard requirement was protecting, kept.
    process.env.AUTH_JWT_SECRET = 'deployment-two-signing-secret-value';
    expect(apiKeySecretMatches(parsed.prefix, parsed.secret, generated.secretHash)).toBe(false);

    delete process.env.AUTH_JWT_SECRET;
  });

  it('lets an explicit pepper override the derived one, for independent rotation', () => {
    process.env.AUTH_JWT_SECRET = 'a-signing-secret-that-every-deployment-has';
    const generated = withPepper(() => generateApiKey('LIVE'));
    const parsed = parseApiKey(generated.key)!;

    // Hashed under the explicit pepper, so the derived key must not match it.
    expect(apiKeySecretMatches(parsed.prefix, parsed.secret, generated.secretHash)).toBe(false);
    process.env.API_KEY_PEPPER = PEPPER;
    expect(apiKeySecretMatches(parsed.prefix, parsed.secret, generated.secretHash)).toBe(true);

    delete process.env.API_KEY_PEPPER;
    delete process.env.AUTH_JWT_SECRET;
  });

  it('refuses to match when the deployment has no secret of any kind', () => {
    const generated = withPepper(() => generateApiKey('LIVE'));
    const parsed = parseApiKey(generated.key)!;

    // Unreachable in a booted application — the environment schema refuses to
    // start without AUTH_JWT_SECRET — but it must still fail closed rather than
    // degrade to an unkeyed hash.
    delete process.env.API_KEY_PEPPER;
    delete process.env.AUTH_JWT_SECRET;
    expect(apiKeySecretMatches(parsed.prefix, parsed.secret, generated.secretHash)).toBe(false);
  });

  it('rejects malformed keys without touching the database', () => {
    for (const candidate of [
      undefined,
      '',
      'trk_live_short.secret',
      'bearer eyJhbGciOi',
      // Right shape, wrong environment label.
      'trk_prod_0123456789ab.' + 'a'.repeat(43),
    ])
      expect(parseApiKey(candidate)).toBeNull();
  });

  it('produces a different hash for the same secret under a different pepper', () => {
    const generated = withPepper(() => generateApiKey('LIVE'));
    const secret = parseApiKey(generated.key)!.secret;

    const elsewhere = hashApiKeySecret(generated.prefix, secret, 'b'.repeat(48));
    expect(elsewhere).not.toEqual(generated.secretHash);
  });
});

describe('request signatures', () => {
  const secret = 'z'.repeat(43);
  const now = 1_800_000_000;
  const body = Buffer.from(JSON.stringify({ note: 'hello' }));
  const sign = (method: string, path: string, timestamp = String(now), payload = body) =>
    computeSignature(secret, method, path, timestamp, payload);

  it('accepts a correctly signed request', () => {
    expect(
      verifySignature(secret, 'POST', '/api/v1/gateway/x', String(now), sign('POST', '/api/v1/gateway/x'), body, now),
    ).toBeNull();
  });

  it('rejects a body that changed after signing', () => {
    const signature = sign('POST', '/api/v1/gateway/x');
    const altered = Buffer.from(JSON.stringify({ note: 'goodbye' }));

    expect(
      verifySignature(secret, 'POST', '/api/v1/gateway/x', String(now), signature, altered, now),
    ).toBe('mismatch');
  });

  it('will not let a signature captured on one route be replayed onto another', () => {
    const signature = sign('POST', '/api/v1/gateway/harmless');

    // The failure body-only schemes have: a signature over the payload alone
    // says nothing about where the payload was going.
    expect(
      verifySignature(secret, 'POST', '/api/v1/gateway/dangerous', String(now), signature, body, now),
    ).toBe('mismatch');
    expect(
      verifySignature(secret, 'DELETE', '/api/v1/gateway/harmless', String(now), signature, body, now),
    ).toBe('mismatch');
  });

  it('rejects a replay from outside the tolerance window', () => {
    const stale = String(now - 3_600);

    expect(
      verifySignature(secret, 'POST', '/api/v1/gateway/x', stale, sign('POST', '/api/v1/gateway/x', stale), body, now),
    ).toBe('timestamp-outside-tolerance');
  });

  it('distinguishes an unsigned request from a badly signed one', () => {
    expect(verifySignature(secret, 'POST', '/x', undefined, undefined, body, now)).toBe('missing');
    expect(verifySignature(secret, 'POST', '/x', 'not-a-number', 'abc', body, now)).toBe(
      'malformed-timestamp',
    );
  });
});

describe('machine permission catalog', () => {
  it('never offers a permission that would let a key escalate itself', () => {
    for (const forbidden of MACHINE_FORBIDDEN_PERMISSIONS)
      expect(MACHINE_GRANTABLE_PERMISSIONS).not.toContain(forbidden);

    // roles:manage composes the very keys this list restricts, and users:manage
    // assigns the roles that carry them. Either one would make the rest of the
    // list decorative.
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('roles:manage');
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('users:manage');
    // Irreversible: there is no restore for a deleted inspection's media.
    expect(MACHINE_FORBIDDEN_PERMISSIONS).toContain('inspections:delete');
  });

  it('still offers the read permissions an integration actually needs', () => {
    expect(MACHINE_GRANTABLE_PERMISSIONS).toContain('properties:read');
    expect(MACHINE_GRANTABLE_PERMISSIONS).toContain('inspections:read');
  });

  it('accounts for every permission in the catalog, so a new key cannot go unclassified', () => {
    expect(MACHINE_GRANTABLE_PERMISSIONS.length + MACHINE_FORBIDDEN_PERMISSIONS.length).toBe(
      PERMISSION_KEYS.length,
    );
  });
});

interface FakeRequestOptions {
  key?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  ip?: string;
  rawBody?: Buffer;
}

function fakeRequest(options: FakeRequestOptions = {}) {
  const headers: Record<string, string> = {
    ...(options.key ? { 'x-api-key': options.key } : {}),
    ...(options.headers ?? {}),
  };
  return {
    method: options.method ?? 'GET',
    originalUrl: options.path ?? '/api/v1/gateway/properties',
    path: options.path ?? '/api/v1/gateway/properties',
    ip: options.ip ?? '203.0.113.10',
    ips: [] as string[],
    rawBody: options.rawBody,
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as ApiKeyRequest;
}

function contextFor(request: unknown, handler: () => void, response: unknown = {}) {
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
    getHandler: () => handler,
    getClass: () => class Anonymous {},
  } as unknown as ExecutionContext;
}

function openRoute() {
  const handler = () => undefined;
  Reflect.defineMetadata(MACHINE_ACCESSIBLE_METADATA_KEY, true, handler);
  return handler;
}

const closedRoute = () => undefined;

interface StoredKeyOverrides {
  revokedAt?: Date | null;
  expiresAt?: Date | null;
  client?: Record<string, unknown>;
}

function guardFor(generated: ReturnType<typeof generateApiKey>, overrides: StoredKeyOverrides = {}) {
  const record = {
    id: 'key-1',
    prefix: generated.prefix,
    secretHash: generated.secretHash,
    lastUsedAt: new Date(),
    revokedAt: overrides.revokedAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    client: {
      id: 'client-1',
      organizationId: 'org-1',
      name: 'Reporting integration',
      permissions: ['properties:read'],
      environment: 'LIVE',
      isActive: true,
      revokedAt: null,
      allowedIps: [] as string[],
      requireSignature: false,
      rateLimitPerMinute: 60,
      ...(overrides.client ?? {}),
    },
  };
  const prisma = {
    apiClientKey: {
      findUnique: jest.fn().mockResolvedValue(record),
      update: jest.fn().mockResolvedValue(record),
    },
  } as unknown as PrismaService;
  return { guard: new ApiKeyGuard(prisma, new Reflector()), prisma, record };
}

describe('ApiKeyGuard', () => {
  beforeEach(() => {
    process.env.API_KEY_PEPPER = PEPPER;
  });
  afterEach(() => {
    delete process.env.API_KEY_PEPPER;
  });

  it('resolves a valid key to a machine principal carrying the client organization', async () => {
    const generated = generateApiKey('LIVE');
    const { guard } = guardFor(generated);
    const request = fakeRequest({ key: generated.key });

    await expect(guard.canActivate(contextFor(request, openRoute()))).resolves.toBe(true);
    // The same shape a person produces, which is what makes PermissionsGuard,
    // the tenant interceptor and row-level security apply unchanged.
    expect(request.user).toMatchObject({
      organizationId: 'org-1',
      principalType: 'API_KEY',
      apiClientId: 'client-1',
      permissions: ['properties:read'],
      roles: [],
    });
  });

  it('refuses a route that has not been opened to machines, even with the right permission', async () => {
    const generated = generateApiKey('LIVE');
    const { guard } = guardFor(generated);

    // The load-bearing default. Without it, shipping the gateway would have made
    // every route third-party reachable on the same day.
    await expect(
      guard.canActivate(contextFor(fakeRequest({ key: generated.key }), closedRoute)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a test key against a live client, and the reverse', async () => {
    const generated = generateApiKey('TEST');
    const { guard } = guardFor(generated, { client: { environment: 'LIVE' } });

    await expect(
      guard.canActivate(contextFor(fakeRequest({ key: generated.key }), openRoute())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it.each([
    ['revoked', { revokedAt: new Date() }],
    ['expired', { expiresAt: new Date(Date.now() - 1_000) }],
    ['belonging to a deactivated client', { client: { isActive: false } }],
  ])('refuses a key that is %s', async (_label, overrides) => {
    const generated = generateApiKey('LIVE');
    const { guard } = guardFor(generated, overrides as StoredKeyOverrides);

    await expect(
      guard.canActivate(contextFor(fakeRequest({ key: generated.key }), openRoute())),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('enforces the source address allowlist when one is configured', async () => {
    const generated = generateApiKey('LIVE');
    const { guard } = guardFor(generated, { client: { allowedIps: ['198.51.100.4'] } });

    await expect(
      guard.canActivate(
        contextFor(fakeRequest({ key: generated.key, ip: '203.0.113.10' }), openRoute()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(
        contextFor(fakeRequest({ key: generated.key, ip: '198.51.100.4' }), openRoute()),
      ),
    ).resolves.toBe(true);
  });

  it('refuses an unsigned write even when the client holds the permission', async () => {
    const generated = generateApiKey('LIVE');
    const { guard } = guardFor(generated, {
      client: { permissions: ['properties:manage'], requireSignature: false },
    });

    // Enforced at request time and not only where the client was created, so
    // relaxing the flag afterwards cannot quietly open unsigned writes.
    await expect(
      guard.canActivate(
        contextFor(fakeRequest({ key: generated.key, method: 'POST' }), openRoute()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a correctly signed write for a signature-enabled client', async () => {
    const generated = generateApiKey('LIVE');
    const { guard } = guardFor(generated, { client: { requireSignature: true } });
    const secret = parseApiKey(generated.key)!.secret;
    const rawBody = Buffer.from('{"note":"hi"}');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const path = '/api/v1/gateway/things';

    const request = fakeRequest({
      key: generated.key,
      method: 'POST',
      path,
      rawBody,
      headers: {
        'x-timestamp': timestamp,
        'x-signature': computeSignature(secret, 'POST', path, timestamp, rawBody),
      },
    });

    await expect(guard.canActivate(contextFor(request, openRoute()))).resolves.toBe(true);
  });

  it('signs over the path without its query string, so pagination does not break the signature', async () => {
    const generated = generateApiKey('LIVE');
    const { guard } = guardFor(generated, { client: { requireSignature: true } });
    const secret = parseApiKey(generated.key)!.secret;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const path = '/api/v1/gateway/things';

    const request = fakeRequest({
      key: generated.key,
      method: 'DELETE',
      path: `${path}?page=2`,
      headers: {
        'x-timestamp': timestamp,
        'x-signature': computeSignature(secret, 'DELETE', path, timestamp, undefined),
      },
    });

    await expect(guard.canActivate(contextFor(request, openRoute()))).resolves.toBe(true);
  });

  it('says the same thing about an unknown key and a wrong secret', async () => {
    const generated = generateApiKey('LIVE');
    const wrong = generateApiKey('LIVE');
    const { guard, prisma } = guardFor(generated);

    const unknown = new ApiKeyGuard(
      { apiClientKey: { findUnique: jest.fn().mockResolvedValue(null) } } as unknown as PrismaService,
      new Reflector(),
    );

    // Distinguishing them hands an attacker a probe for which prefixes exist.
    const first = await guard
      .canActivate(contextFor(fakeRequest({ key: wrong.key }), openRoute()))
      .catch((error: Error) => error.message);
    const second = await unknown
      .canActivate(contextFor(fakeRequest({ key: generated.key }), openRoute()))
      .catch((error: Error) => error.message);

    expect(first).toEqual(second);
    expect(prisma.apiClientKey.findUnique).toHaveBeenCalled();
  });
});

describe('ApiRateLimitGuard', () => {
  function limiterContext(limit: number) {
    const headers: Record<string, string> = {};
    const response = { setHeader: (name: string, value: string) => (headers[name] = value) };
    const request = {
      user: { apiClientId: 'client-1' },
      apiClientRateLimit: limit,
    };
    return { context: contextFor(request, () => undefined, response), headers };
  }

  it('publishes the allowance on every response, not only on rejection', async () => {
    const guard = new ApiRateLimitGuard();
    const { context, headers } = limiterContext(5);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    // An integrator should be able to pace themselves rather than discover the
    // limit by hitting it.
    expect(headers['x-ratelimit-limit']).toBe('5');
    expect(headers['x-ratelimit-remaining']).toBe('4');
    expect(Number(headers['x-ratelimit-reset'])).toBeGreaterThan(0);
  });

  it('rejects with 429 and a retry hint once the window is spent', async () => {
    const guard = new ApiRateLimitGuard();
    const limit = 3;

    for (let attempt = 0; attempt < limit; attempt += 1)
      await expect(guard.canActivate(limiterContext(limit).context)).resolves.toBe(true);

    const { context, headers } = limiterContext(limit);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      // HttpException carries the status; asserting it rather than the class
      // keeps this honest about what a caller actually sees.
      response: 'Rate limit exceeded for this API client.',
    });
    expect(headers['retry-after']).toBeDefined();
  });

  it('leaves human traffic alone', async () => {
    const guard = new ApiRateLimitGuard();
    const request = { user: { id: 'user-1', principalType: 'USER' } };

    await expect(
      guard.canActivate(contextFor(request, () => undefined, { setHeader: () => undefined })),
    ).resolves.toBe(true);
  });
});

describe('ApiClientService safeguards', () => {
  const admin = {
    id: 'user-1',
    organizationId: 'org-1',
    principalType: 'USER' as const,
    authUserId: 'auth-1',
    displayName: 'Admin',
    roles: [],
    permissions: [],
    mustChangePassword: false,
  };

  function serviceWith(existing?: Record<string, unknown>) {
    const prisma = {
      apiClient: {
        create: jest.fn(),
        update: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(existing ?? null),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    return { service: new ApiClientService(prisma), prisma };
  }

  it('refuses to register a client with write scopes but no request signing', async () => {
    const { service, prisma } = serviceWith();

    await expect(
      service.create(admin, { name: 'Writer', permissions: ['properties:manage'] }),
    ).rejects.toMatchObject({ code: 'API_CLIENT_SIGNATURE_REQUIRED' });
    expect(prisma.apiClient.create).not.toHaveBeenCalled();
  });

  it('refuses to strip signing from a client that already holds write scopes', async () => {
    // The two-step version of the same mistake: grant the write scope in one
    // request, turn signing off in the next. Validating the submitted fields
    // alone would wave this through.
    const { service, prisma } = serviceWith({
      id: 'client-1',
      organizationId: 'org-1',
      permissions: ['properties:manage'],
      requireSignature: true,
      keys: [],
    });

    await expect(
      service.update(admin, 'client-1', { requireSignature: false }),
    ).rejects.toMatchObject({ code: 'API_CLIENT_SIGNATURE_REQUIRED' });
    expect(prisma.apiClient.update).not.toHaveBeenCalled();
  });

  it('drops a forbidden permission even if one reaches the service past the DTO', async () => {
    const { service, prisma } = serviceWith();
    (prisma.apiClient.create as jest.Mock).mockImplementation(({ data }: never) => ({
      ...(data as Record<string, unknown>),
      id: 'client-1',
      createdAt: new Date(),
      updatedAt: new Date(),
      revokedAt: null,
      isActive: true,
      keys: [],
    }));

    const created = await service.create(admin, {
      name: 'Reader',
      permissions: ['properties:read', 'inspections:delete'],
    });

    expect(created.permissions).toEqual(['properties:read']);
  });

  it('will not issue a key on a deployment with no secret at all', async () => {
    delete process.env.API_KEY_PEPPER;
    delete process.env.AUTH_JWT_SECRET;
    const { service } = serviceWith({
      id: 'client-1',
      organizationId: 'org-1',
      permissions: ['properties:read'],
      requireSignature: false,
      environment: 'LIVE',
      isActive: true,
      revokedAt: null,
      keys: [],
    });

    await expect(service.createKey(admin, 'client-1', {})).rejects.toMatchObject({
      code: 'API_KEY_SIGNING_NOT_CONFIGURED',
    });
  });

  it('refuses to issue a key for a revoked client', async () => {
    process.env.API_KEY_PEPPER = PEPPER;
    const { service } = serviceWith({
      id: 'client-1',
      organizationId: 'org-1',
      permissions: ['properties:read'],
      environment: 'LIVE',
      isActive: false,
      revokedAt: new Date(),
      keys: [],
    });

    await expect(service.createKey(admin, 'client-1', {})).rejects.toMatchObject({
      code: 'API_CLIENT_REVOKED',
    });
    delete process.env.API_KEY_PEPPER;
  });
});

describe('HttpException surface', () => {
  it('reports rate limiting as 429', async () => {
    const guard = new ApiRateLimitGuard();
    const request = { user: { apiClientId: 'client-429' }, apiClientRateLimit: 1 };
    const response = { setHeader: () => undefined };

    await guard.canActivate(contextFor(request, () => undefined, response));
    const error = await guard
      .canActivate(contextFor(request, () => undefined, response))
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });
});

describe('the third-party gateway surface', () => {
  const prototype = GatewayController.prototype as unknown as Record<string, unknown>;
  const handlers = Object.getOwnPropertyNames(prototype).filter(
    (name) => name !== 'constructor' && typeof prototype[name] === 'function',
  );

  it('exposes only routes that were deliberately opened to machines', () => {
    expect(handlers.length).toBeGreaterThan(0);
    for (const name of handlers)
      expect(
        Reflect.getMetadata(MACHINE_ACCESSIBLE_METADATA_KEY, prototype[name] as object),
      ).toBe(true);
  });

  it('is read-only, so nothing outside this system can write through it', () => {
    // The property worth defending as this surface grows: a key can be granted
    // write permissions and still reach nothing that writes here, because the
    // gateway offers nothing that does. A POST added without thinking would
    // fail this rather than quietly becoming a public contract.
    for (const name of handlers)
      expect({
        route: name,
        // RequestMethod.GET is 0.
        method: Reflect.getMetadata('method', prototype[name] as object),
      }).toEqual({ route: name, method: 0 });
  });

  it('keeps tracking behind its own grant, not the directory grant', () => {
    const permissionsFor = (name: string) =>
      (Reflect.getMetadata('permissions', prototype[name] as object) as string[] | undefined) ?? [];

    // The whole point of splitting `technicians:locate` out: "see the technician
    // directory" and "watch where a named employee is right now" are different
    // decisions. If the position feed ever falls back to `technicians:read`,
    // granting the directory silently grants live tracking again — which is
    // exactly the state this replaced, and it is invisible from the console.
    expect(permissionsFor('technicianLocations')).toEqual(['technicians:locate']);
    expect(permissionsFor('technicians')).toEqual(['technicians:read']);
  });

  it('never grants itself a permission a machine may not hold', () => {
    for (const name of handlers) {
      const required =
        (Reflect.getMetadata('permissions', prototype[name] as object) as string[] | undefined) ??
        [];
      for (const permission of required)
        expect(MACHINE_FORBIDDEN_PERMISSIONS).not.toContain(permission);
    }
  });
});

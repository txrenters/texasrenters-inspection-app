import { randomUUID } from 'node:crypto';

import { UserRole } from '@prisma/client';
import { hashSync } from 'bcryptjs';

import {
  PortalStore,
  PortalStoreUnavailableError,
  type PortalFlow,
  type PortalSessionRecord,
} from '../../src/auth/portal/portal.store';

/**
 * Test doubles for "Sign in with TR Staff Portal".
 *
 * The portal itself is mocked over HTTP with nock in each spec; these stand in
 * for Redis and Postgres, which the backend tests never reach.
 */

export const ISSUER = 'https://login.texasrenters.com';
export const CLIENT_ID = '0b8c2a54-1d1e-4c3f-9a7e-portal-client';
export const CLIENT_SECRET = 'test-client-secret-never-real';
export const APP_SLUG = 'inspection';

/** The environment the portal specs run under. Set before, restored after. */
export const PORTAL_ENV: Record<string, string> = {
  PORTAL_ENABLED: 'true',
  PORTAL_ISSUER: ISSUER,
  PORTAL_CLIENT_ID: CLIENT_ID,
  PORTAL_CLIENT_SECRET: CLIENT_SECRET,
  PORTAL_APP_SLUG: APP_SLUG,
  PORTAL_ALLOWED_DOMAINS: 'texasrenters.com,texra.net',
  PORTAL_RECHECK_MINUTES: '5',
  PORTAL_ALLOW_PASSWORD_LOGIN: 'true',
  WEB_APP_ORIGIN: 'https://inspection.texasrenters.com',
  AUTH_JWT_SECRET: 'portal-spec-signing-secret',
  AUTH_JWT_ISSUER: 'https://inspection-api.texasrenters.com',
  AUTH_JWT_AUDIENCE: 'authenticated',
};

export function usePortalEnvironment(overrides: Record<string, string | undefined> = {}) {
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const [name, value] of Object.entries({ ...PORTAL_ENV, ...overrides })) {
      saved.set(name, process.env[name]);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
  });
}

/** Redis, in memory, with the same once-only and locking behaviour. */
export class MemoryPortalStore extends PortalStore {
  readonly flows = new Map<string, PortalFlow>();
  readonly sessions = new Map<string, PortalSessionRecord>();
  readonly locks = new Map<string, string>();
  readonly counts = new Map<string, number>();
  /** Set to make every call fail as an unreachable Redis does. */
  unavailable = false;

  private check() {
    if (this.unavailable) throw new PortalStoreUnavailableError();
  }

  async saveFlow(id: string, flow: PortalFlow) {
    this.check();
    this.flows.set(id, { ...flow });
  }

  async takeFlow(id: string) {
    this.check();
    const flow = this.flows.get(id) ?? null;
    this.flows.delete(id);
    return flow;
  }

  async saveSession(id: string, record: PortalSessionRecord) {
    this.check();
    this.sessions.set(id, { ...record });
  }

  async updateSession(id: string, record: PortalSessionRecord) {
    this.check();
    if (!this.sessions.has(id)) return false;
    this.sessions.set(id, { ...record });
    return true;
  }

  async readSession(id: string) {
    this.check();
    const record = this.sessions.get(id);
    return record ? { ...record } : null;
  }

  async endSession(id: string) {
    this.check();
    this.sessions.delete(id);
  }

  async endSessionsOf(authUserId: string) {
    this.check();
    let ended = 0;
    for (const [id, record] of this.sessions)
      if (record.authUserId === authUserId) {
        this.sessions.delete(id);
        ended += 1;
      }
    return ended;
  }

  async acquireLock(id: string) {
    this.check();
    if (this.locks.has(id)) return null;
    const token = randomUUID();
    this.locks.set(id, token);
    return token;
  }

  async releaseLock(id: string, token: string) {
    if (this.locks.get(id) === token) this.locks.delete(id);
  }

  async countRequest(key: string) {
    this.check();
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count;
  }
}

export interface AccountRow {
  id: string;
  authUserId: string;
  email: string;
  isActive: boolean;
  portalSubject: string | null;
  memberships: { organizationId: string; role: UserRole }[];
  roleAssignments: { organizationId: string; role?: { permissions: string[] } }[];
}

export const ORG = '11111111-1111-4111-8111-111111111111';

export const PASSWORD = 'Correct-Horse-9!';
/** Cost 4: these tests are not measuring bcrypt. */
const PASSWORD_HASH = hashSync(PASSWORD, 4);

export function staffAccount(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: randomUUID(),
    authUserId: `auth-${randomUUID()}`,
    email: 'avery.office@texasrenters.com',
    isActive: true,
    portalSubject: null,
    memberships: [{ organizationId: ORG, role: UserRole.PROPERTY_ADMIN }],
    roleAssignments: [{ organizationId: ORG, role: { permissions: [] } }],
    ...overrides,
  };
}

interface RefreshRow {
  id: string;
  authUserId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedById: string | null;
  deviceId: string | null;
  fromConsole: boolean;
}

/**
 * Postgres, as far as sign-in, renewal and sign-out use it: accounts, their
 * refresh tokens and audit rows. Writes the portal makes are recorded so a
 * test can say nothing else was touched.
 */
export function fakeDatabase(accounts: AccountRow[]) {
  const refreshTokens: RefreshRow[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const profileWrites: { where: unknown; data: unknown }[] = [];
  let next = 0;

  const byAuthUser = (authUserId: string) => accounts.find((account) => account.authUserId === authUserId);
  const credentialOf = (authUserId: string) => {
    const account = byAuthUser(authUserId);
    return {
      mustChangePassword: false,
      profile: { isActive: account?.isActive ?? false },
    };
  };

  const prisma = {
    userProfile: {
      findUnique: jest.fn(async ({ where }: { where: { portalSubject?: string; authUserId?: string } }) => {
        if (where.portalSubject !== undefined)
          return accounts.find((account) => account.portalSubject === where.portalSubject) ?? null;
        if (where.authUserId !== undefined) return byAuthUser(where.authUserId) ?? null;
        return null;
      }),
      // Case-insensitive, as Postgres answers `mode: 'insensitive'`.
      findMany: jest.fn(async ({ where }: { where: { email: { equals: string } } }) =>
        accounts.filter((account) => account.email.toLowerCase() === where.email.equals.toLowerCase()),
      ),
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string; portalSubject: null }; data: { portalSubject: string } }) => {
          profileWrites.push({ where, data });
          const account = accounts.find((row) => row.id === where.id && row.portalSubject === null);
          if (!account) return { count: 0 };
          account.portalSubject = data.portalSubject;
          return { count: 1 };
        },
      ),
    },
    authCredential: {
      // Every account's password is PASSWORD.
      findUnique: jest.fn(async ({ where }: { where: { email: string } }) => {
        const account = accounts.find((row) => row.email.toLowerCase() === where.email);
        return account
          ? {
              authUserId: account.authUserId,
              passwordHash: PASSWORD_HASH,
              mustChangePassword: false,
              profile: { isActive: account.isActive, memberships: account.memberships },
            }
          : null;
      }),
      findUniqueOrThrow: jest.fn(async () => ({ mustChangePassword: false })),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    authRefreshToken: {
      create: jest.fn(async ({ data }: { data: Omit<RefreshRow, 'id' | 'revokedAt' | 'replacedById'> }) => {
        const row: RefreshRow = { id: `rt-${(next += 1)}`, revokedAt: null, replacedById: null, ...data };
        refreshTokens.push(row);
        return { id: row.id };
      }),
      findUnique: jest.fn(async ({ where }: { where: { tokenHash: string } }) => {
        const row = refreshTokens.find((token) => token.tokenHash === where.tokenHash);
        return row ? { ...row, credential: credentialOf(row.authUserId) } : null;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<RefreshRow> }) => {
        const row = refreshTokens.find((token) => token.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Partial<RefreshRow>; data: Partial<RefreshRow> }) => {
        const rows = refreshTokens.filter((row) =>
          Object.entries(where).every(([field, value]) => row[field as keyof RefreshRow] === value),
        );
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      }),
    },
    auditLog: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        auditRows.push(data);
        return data;
      }),
    },
  };
  const withTransaction = Object.assign(prisma, {
    $transaction: jest.fn(async (run: (tx: unknown) => Promise<unknown>): Promise<unknown> => run(prisma)),
  });

  return { prisma: withTransaction, refreshTokens, auditRows, profileWrites };
}

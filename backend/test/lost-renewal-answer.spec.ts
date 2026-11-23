import { LOST_ROTATION_GRACE_MS, SessionService } from '../src/auth/session.service';
import { TokenService } from '../src/auth/token.service';

/**
 * A renewal whose answer never arrived (2026-11-24: "when remember me is
 * ticked, it should not expire for 12 hrs").
 *
 * The console renews a remembered sign-in every hour. When the answer is lost
 * after the API has rotated the token -- a reload mid-renewal, Wi-Fi dropping
 * as a laptop wakes -- the browser still holds the token the rotation retired,
 * and offers it at its next try. That used to read as a stolen token and end
 * every session on the account, the phone's included.
 */

const AUTH_USER_ID = 'auth-user-1';
const CREDENTIAL = { mustChangePassword: false, profile: { isActive: true } };

describe('a renewal whose answer was lost', () => {
  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'lost-renewal-secret';
  });
  afterEach(() => delete process.env.AUTH_JWT_SECRET);

  /** `presented` is what the hash lookup finds; `replacement` what the lookup by id finds. */
  function prismaWith(presented: Record<string, unknown>, replacement: Record<string, unknown> | null) {
    const tx = {
      authRefreshToken: {
        create: jest.fn().mockResolvedValue({ id: 'refresh-3' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      authRefreshToken: {
        findUnique: jest.fn(async ({ where }: { where: { tokenHash?: string; id?: string } }) =>
          where.id ? replacement : presented,
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
    };
    return { prisma, tx };
  }

  const rotatedToken = (rotatedMsAgo: number) => ({
    id: 'refresh-1',
    authUserId: AUTH_USER_ID,
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    revokedAt: new Date(Date.now() - rotatedMsAgo),
    replacedById: 'refresh-2',
    deviceId: null,
    fromConsole: true,
    credential: CREDENTIAL,
  });

  it('renews again, rather than ending every session, while the replacement is unused', async () => {
    const presented = rotatedToken(5_000);
    const { prisma, tx } = prismaWith(presented, { id: 'refresh-2', revokedAt: null });
    const service = new SessionService(prisma as never, new TokenService());

    const session = await service.refresh('token-the-browser-still-has', { client: 'console' });

    expect(session.refreshToken).toBeTruthy();
    expect(session.accessToken).toBeTruthy();
    // No account-wide revocation.
    expect(prisma.authRefreshToken.updateMany).not.toHaveBeenCalled();
    // The replacement nobody received is retired in the presented token's
    // place, only if still unused, and pointed at the new token so whoever
    // offers it later is caught as a replay. Retired as of the rotation that
    // made it, so no exchange extends the grace.
    expect(tx.authRefreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: 'refresh-2', revokedAt: null },
      data: { revokedAt: presented.revokedAt, replacedById: 'refresh-3' },
    });
    // The presented token is pointed at the new one; when it was retired stays
    // as it was, so a second lost answer does not extend the grace.
    expect(tx.authRefreshToken.update).toHaveBeenCalledWith({
      where: { id: 'refresh-1' },
      data: { replacedById: 'refresh-3' },
    });
  });

  it('still ends every session when the replacement has been used', async () => {
    // Its holder renewed with it, so whoever offers the old token kept a copy.
    const { prisma, tx } = prismaWith(rotatedToken(5_000), { id: 'refresh-2', revokedAt: new Date() });
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('stolen-token')).rejects.toMatchObject({ status: 401 });
    expect(prisma.authRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authUserId: AUTH_USER_ID, revokedAt: null } }),
    );
    expect(tx.authRefreshToken.create).not.toHaveBeenCalled();
  });

  it('still ends every session when the token was rotated longer ago than the grace', async () => {
    const { prisma, tx } = prismaWith(rotatedToken(LOST_ROTATION_GRACE_MS + 1_000), {
      id: 'refresh-2',
      revokedAt: null,
    });
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('old-copy')).rejects.toMatchObject({ status: 401 });
    expect(prisma.authRefreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { authUserId: AUTH_USER_ID, revokedAt: null } }),
    );
    expect(tx.authRefreshToken.create).not.toHaveBeenCalled();
  });

  it('still ends every session when the replacement is gone', async () => {
    const { prisma } = prismaWith(rotatedToken(5_000), null);
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('token')).rejects.toMatchObject({ status: 401 });
    expect(prisma.authRefreshToken.updateMany).toHaveBeenCalled();
  });

  it('refuses when another renewal retired the replacement first, so the two cannot both succeed', async () => {
    const { prisma, tx } = prismaWith(rotatedToken(5_000), { id: 'refresh-2', revokedAt: null });
    tx.authRefreshToken.updateMany.mockResolvedValue({ count: 0 });
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('token')).rejects.toMatchObject({ status: 401 });
    // Refused inside the transaction, which takes the new token back with it.
    expect(tx.authRefreshToken.update).not.toHaveBeenCalled();
  });

  it('does not touch a token revoked by a sign-out', async () => {
    const { prisma } = prismaWith({ ...rotatedToken(5_000), replacedById: null }, null);
    const service = new SessionService(prisma as never, new TokenService());

    await expect(service.refresh('signed-out-token')).rejects.toMatchObject({ status: 401 });
    expect(prisma.authRefreshToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.authRefreshToken.findUnique).toHaveBeenCalledTimes(1);
  });
});

/**
 * The refresh-token table, in memory, closely enough for a whole day of
 * rotations: rows are found, created and updated by the same `where` shapes
 * SessionService uses.
 */
function memoryTokens() {
  type Row = Record<string, unknown> & { id: string; revokedAt: Date | null; replacedById: string | null };
  const rows: Row[] = [];
  let next = 0;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) => row[field] === value);
  const table = {
    findUnique: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? { ...row, credential: CREDENTIAL } : null;
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: Row = { id: `token-${(next += 1)}`, revokedAt: null, replacedById: null, ...data };
      rows.push(row);
      return { id: row.id };
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows.find((candidate) => candidate.id === where.id);
      if (!row) throw new Error(`No token ${where.id}`);
      Object.assign(row, data);
      return row;
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((candidate) => matches(candidate, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    }),
  };
  const prisma = {
    authRefreshToken: table,
    $transaction: async (run: (tx: { authRefreshToken: typeof table }) => Promise<unknown>) =>
      run({ authRefreshToken: table }),
  };
  return { rows, prisma, live: () => rows.filter((row) => row.revokedAt === null) };
}

describe('a remembered console sign-in through a twelve-hour day', () => {
  const HOUR = 60 * 60 * 1000;

  beforeEach(() => {
    process.env.AUTH_JWT_SECRET = 'twelve-hour-secret';
    // Date and timers only: the service awaits real promises throughout.
    jest.useFakeTimers({ now: new Date('2026-11-24T07:00:00.000Z'), doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.AUTH_JWT_SECRET;
  });

  /** A console session as `signIn` stores one, then renewed as the console renews it. */
  async function signedIn() {
    const tokens = new TokenService();
    const memory = memoryTokens();
    const first = tokens.createRefreshToken();
    await memory.prisma.authRefreshToken.create({
      data: {
        authUserId: AUTH_USER_ID,
        tokenHash: first.tokenHash,
        expiresAt: first.expiresAt,
        deviceId: null,
        fromConsole: true,
      },
    });
    const service = new SessionService(memory.prisma as never, tokens);
    return { service, memory, token: first.token };
  }

  it('renews every hour for twelve hours, through a renewal whose answer was lost, and stays signed in', async () => {
    const { service, memory, token: first } = await signedIn();
    const revokeAll = jest.spyOn(service, 'revokeAllFor');
    let held = first;

    for (let hour = 1; hour <= 12; hour += 1) {
      // The access token runs out on the hour, and the console renews it.
      jest.setSystemTime(Date.now() + HOUR);
      const answer = await service.refresh(held, { client: 'console' });
      if (hour === 5) {
        // The tab was reloaded while this answer was on its way: the browser
        // never stored it and still holds the token just retired. It tries
        // again at its next request, seconds later.
        jest.setSystemTime(Date.now() + 20_000);
        const again = await service.refresh(held, { client: 'console' });
        expect(again.refreshToken).not.toBe(answer.refreshToken);
        held = again.refreshToken;
        continue;
      }
      held = answer.refreshToken;
    }

    expect(revokeAll).not.toHaveBeenCalled();
    // Still signed in at the end of the day, with exactly one live token: the
    // one the browser holds.
    expect(memory.live()).toHaveLength(1);
    await expect(service.refresh(held, { client: 'console' })).resolves.toMatchObject({ tokenType: 'Bearer' });
  });

  it('still ends every session if the answer that was "lost" turns up after the grace', async () => {
    const { service, memory, token: first } = await signedIn();

    jest.setSystemTime(Date.now() + HOUR);
    const lost = await service.refresh(first, { client: 'console' });
    jest.setSystemTime(Date.now() + 20_000);
    const kept = await service.refresh(first, { client: 'console' });
    expect(memory.live()).toHaveLength(1);

    // Someone offers the replacement the second exchange retired, after the
    // grace: a replay, and every session goes, the one kept included.
    jest.setSystemTime(Date.now() + LOST_ROTATION_GRACE_MS);
    await expect(service.refresh(lost.refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(memory.live()).toHaveLength(0);
    await expect(service.refresh(kept.refreshToken)).rejects.toMatchObject({ status: 401 });
  });

  it('runs the grace from the rotation: no exchange inside it extends it', async () => {
    const { service, memory, token: first } = await signedIn();
    const revokeAll = jest.spyOn(service, 'revokeAllFor');

    jest.setSystemTime(Date.now() + HOUR);
    const lost = await service.refresh(first, { client: 'console' });
    // Lost twice, each exchanged again inside the grace.
    jest.setSystemTime(Date.now() + 30_000);
    await service.refresh(first, { client: 'console' });
    jest.setSystemTime(Date.now() + 60_000);
    await service.refresh(lost.refreshToken, { client: 'console' });
    expect(revokeAll).not.toHaveBeenCalled();
    expect(memory.live()).toHaveLength(1);

    // Two minutes after the rotation, the old token is a replay, however
    // recently its family was exchanged.
    jest.setSystemTime(Date.now() + 31_000);
    await expect(service.refresh(first)).rejects.toMatchObject({ status: 401 });
    expect(memory.live()).toHaveLength(0);
  });

  it('still ends every session for a copy offered after the grace', async () => {
    const { service, memory, token: first } = await signedIn();

    jest.setSystemTime(Date.now() + HOUR);
    await service.refresh(first, { client: 'console' });
    jest.setSystemTime(Date.now() + LOST_ROTATION_GRACE_MS + 1_000);

    await expect(service.refresh(first)).rejects.toMatchObject({ status: 401 });
    expect(memory.live()).toHaveLength(0);
  });
});

import { TechnicianService } from '../src/technician/technician.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * "Can the properties assigned for the day be at the very top of the list?"
 *
 * Asked by a technician in the field, and the answer was no, for a reason worth
 * writing down: the list is ordered by schedule, oldest first, and the default
 * chip shows every status except cancelled. So an outstanding inspection from
 * weeks ago — or a completed one from months ago — sorts above this morning's
 * round, and the work somebody is actually driving to is pages down.
 *
 * A date filter rather than a re-ordering: re-ordering the loaded page would
 * have moved nothing, because the list is paged on the server and today's work
 * may not be on the page the handset is holding.
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

function build() {
  const prisma = {
    inspection: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  // Four doubles, as every other unit test here does: the realtime gateway and
  // the rest are `@Optional()` precisely so this stays possible.
  const service = new TechnicianService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma };
}

/** The `where` the list actually asked the database for. */
const askedFor = (prisma: { inspection: { findMany: jest.Mock } }) =>
  prisma.inspection.findMany.mock.calls[0][0].where as {
    scheduledAt?: { gte: Date; lt: Date };
  };

describe('a technician asking for today', () => {
  it('narrows to a single day', async () => {
    const { service, prisma } = build();

    await service.inspections(user, { page: 1, pageSize: 20, dueToday: true });

    const range = askedFor(prisma).scheduledAt;
    expect(range).toBeDefined();
    expect(range!.lt.getTime() - range!.gte.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('starts the day in Texas, not in UTC', async () => {
    /**
     * The distinction that makes this worth a test. UTC midnight is 6 or 7 p.m.
     * Texas the *previous* evening, so a UTC-bounded "today" already held
     * tomorrow's work from dinner time onwards — and filed a genuine evening
     * inspection under the following day.
     */
    const { service, prisma } = build();

    await service.inspections(user, { page: 1, pageSize: 20, dueToday: true });

    const start = askedFor(prisma).scheduledAt!.gte;
    // Texas is UTC−5 or −6, so a day boundary always lands on 05:00 or 06:00.
    expect([5, 6]).toContain(start.getUTCHours());
    expect(start.getUTCMinutes()).toBe(0);
  });

  it('leaves the schedule alone when nobody asked', async () => {
    // Every other chip must keep showing work from any day; a date filter
    // leaking into them would hide a technician's history without explanation.
    const { service, prisma } = build();

    await service.inspections(user, { page: 1, pageSize: 20 });

    expect(askedFor(prisma).scheduledAt).toBeUndefined();
  });

  it('still shows every status within the day', async () => {
    // Today's round includes what has already been finished this morning.
    // Narrowing to SCHEDULED would make a technician's own completed work
    // disappear as they did it, which reads as the list losing things.
    const { service, prisma } = build();

    await service.inspections(user, { page: 1, pageSize: 20, dueToday: true });

    const where = prisma.inspection.findMany.mock.calls[0][0].where as {
      status: unknown;
    };
    expect(where.status).toEqual({ not: 'CANCELLED' });
  });
});

import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianInspectionListQueryDto } from '../src/technician/technician.dto';
import { jobDayCounts, technicianJobSearchWhere } from '../src/technician/technician-job-list';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * The phone's Jobs list, a day at a time (the office, 2026-10-07: "a calendar
 * filter... we will only show the day's schedule, not all the schedules"), a
 * History of finished work, and one search across every job.
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
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never, {} as never);
  const list = async (query: Record<string, unknown>) => {
    await service.inspections(user, { page: 1, pageSize: 25, ...query } as never);
    return prisma.inspection.findMany.mock.calls.at(-1)![0] as {
      where: Record<string, unknown> & { AND: unknown[] };
      orderBy: unknown;
    };
  };
  return { service, prisma, list };
}

describe('a day on the calendar', () => {
  it('is the day itself, matched on the date column', async () => {
    // Never a pair of instants: the column is a date, and an instant pair once
    // pulled the next day's visits into the console's list.
    const { list } = build();
    const { where } = await list({ scheduledOn: '2026-10-07' });
    expect(where.scheduledAt).toEqual(new Date('2026-10-07T00:00:00.000Z'));
  });

  it('reads as the round is driven: by booked window, day-booked work after', async () => {
    const { list } = build();
    const { orderBy } = await list({ scheduledOn: '2026-10-07' });
    expect(orderBy).toEqual([
      { scheduledAt: 'asc' },
      { scheduledStartAt: { sort: 'asc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });

  it('finds the jobs still open from earlier days', async () => {
    const { list } = build();
    const { where } = await list({ scheduledBefore: '2026-10-07', status: ['SCHEDULED', 'IN_PROGRESS'] });
    expect(where.scheduledAt).toEqual({ lt: new Date('2026-10-07T00:00:00.000Z') });
    expect(where.status).toEqual({ in: ['SCHEDULED', 'IN_PROGRESS'] });
  });

  it('refuses a day that does not exist, rather than querying an Invalid Date', async () => {
    const dto = plainToInstance(TechnicianInspectionListQueryDto, { scheduledOn: '2026-02-31' });
    expect((await validate(dto)).map((error) => error.property)).toContain('scheduledOn');
  });
});

describe('History', () => {
  it('reads newest first', async () => {
    const { list } = build();
    const { orderBy } = await list({ order: 'recent' });
    expect(orderBy).toEqual([
      { scheduledAt: 'desc' },
      { submittedAt: { sort: 'desc', nulls: 'last' } },
      { id: 'asc' },
    ]);
  });
});

describe('the search', () => {
  it('needs every word somewhere, as an AND beside the narrowing, never a widening OR', async () => {
    const { list } = build();
    const { where } = await list({ search: 'Flower Gate 5819', scheduledOn: '2026-10-07' });
    expect(where.OR).toBeUndefined();
    expect(where.AND).toHaveLength(3);
    // The day still narrows: the search is inside it, not beside it.
    expect(where.scheduledAt).toEqual(new Date('2026-10-07T00:00:00.000Z'));
  });

  it('looks in the city and ZIP the placeholder always promised, and the Jobber title', () => {
    const [clause] = technicianJobSearchWhere('Cypress') as { OR: unknown[] }[];
    expect(clause!.OR).toEqual(
      expect.arrayContaining([
        { propertywareBuilding: { city: { contains: 'cypress', mode: 'insensitive' } } },
        { propertywareBuilding: { postalCode: { contains: 'cypress', mode: 'insensitive' } } },
        { jobberVisitTitle: { contains: 'cypress', mode: 'insensitive' } },
      ]),
    );
  });

  it('finds a kind of job by the words a technician uses', () => {
    const [move, out] = technicianJobSearchWhere('move out') as { OR: unknown[] }[];
    expect(move!.OR).toContainEqual({ inspectionType: { in: ['MOVE_IN', 'MOVE_OUT'] } });
    expect(out!.OR).toContainEqual({ inspectionType: { in: ['MOVE_OUT'] } });
    const [hyphenated] = technicianJobSearchWhere('move-out') as { OR: unknown[] }[];
    expect(hyphenated!.OR).toContainEqual({ inspectionType: { in: ['MOVE_OUT'] } });
    const [btm] = technicianJobSearchWhere('BTM') as { OR: unknown[] }[];
    expect(btm!.OR).toContainEqual({ inspectionType: { in: ['BACK_TO_MARKET'] } });
  });

  it('finds where a job stands by the phone’s own labels', () => {
    const [assigned] = technicianJobSearchWhere('assigned') as { OR: unknown[] }[];
    expect(assigned!.OR).toContainEqual({ status: { in: ['SCHEDULED'] } });
  });

  it('takes a two-letter keyword as the keyword alone, not as text in every address', () => {
    // "in" is inside "Main", "Springs", "Lindsey" -- as text it matches nearly everything.
    const [, inWord] = technicianJobSearchWhere('move in') as { OR: unknown[] }[];
    expect(inWord!.OR).toEqual([{ inspectionType: { in: ['MOVE_IN'] } }]);
  });

  it('adds nothing when nothing was typed', () => {
    expect(technicianJobSearchWhere('  ')).toEqual([]);
  });
});

describe('the day strip’s dots', () => {
  it('counts each day’s jobs, and how many are still to do', () => {
    const at = (day: string) => new Date(`${day}T00:00:00.000Z`);
    expect(
      jobDayCounts([
        { scheduledAt: at('2026-10-08'), status: 'SCHEDULED', _count: { _all: 2 } },
        { scheduledAt: at('2026-10-07'), status: 'COMPLETED', _count: { _all: 3 } },
        { scheduledAt: at('2026-10-07'), status: 'IN_PROGRESS', _count: { _all: 1 } },
      ] as never),
    ).toEqual([
      { day: '2026-10-07', total: 4, open: 1 },
      { day: '2026-10-08', total: 2, open: 2 },
    ]);
  });

  it('asks once for the whole range, for this technician only', async () => {
    const { service, prisma } = build();
    await service.jobDays(user, { from: '2026-10-01', to: '2026-10-31' });
    const call = prisma.inspection.groupBy.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).toMatchObject({
      organizationId: user.organizationId,
      assignments: { some: { technicianId: user.id, isCurrent: true } },
      scheduledAt: {
        gte: new Date('2026-10-01T00:00:00.000Z'),
        lte: new Date('2026-10-31T00:00:00.000Z'),
      },
    });
  });

  it('refuses a range backwards or longer than the strip ever shows', async () => {
    const { service } = build();
    await expect(service.jobDays(user, { from: '2026-10-31', to: '2026-10-01' })).rejects.toThrow();
    await expect(service.jobDays(user, { from: '2026-01-01', to: '2026-12-31' })).rejects.toThrow();
  });
});

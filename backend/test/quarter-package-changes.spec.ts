import type { PrismaService } from '../src/common/prisma.service';
import { QuarterPackageChangesService } from '../src/planning/quarter-package-changes.service';

/**
 * The benefit package's changes as a quarter sees them (the office,
 * 2026-10-15): who left since last quarter and the day and group they were
 * visited in, who is new and where this quarter put them. Places invented.
 */

const ORG = 'org-1';
const Q4 = { id: 'plan-q4', quarterYear: 2026, quarterNumber: 4, quarterStartsOn: new Date('2026-10-01T00:00:00Z') };
const Q3 = { id: 'plan-q3', quarterYear: 2026, quarterNumber: 3, quarterStartsOn: new Date('2026-07-01T00:00:00Z') };

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

const stop = (buildingId: string, status: string, scheduledOn: string | null) => ({
  propertywareBuildingId: buildingId,
  status,
  scheduledOn: scheduledOn ? day(scheduledOn) : null,
  assignedTechnicianId: scheduledOn ? 'tech-1' : null,
  assignedTechnician: scheduledOn ? { displayName: 'Sam Tech' } : null,
});

const STOPS: Record<string, unknown[]> = {
  'plan-q3': [
    stop('A', 'PUBLISHED', '2026-08-04'),
    // L was visited last quarter, in the North group's day.
    stop('L', 'PUBLISHED', '2026-08-05'),
    // X was taken out of last quarter: not visited, so new if it is in now.
    stop('X', 'EXCLUDED', null),
  ],
  'plan-q4': [
    stop('A', 'PLANNED', '2026-11-03'),
    // L's visit left the plan when it left the package.
    stop('L', 'EXCLUDED', null),
    // N has two units: one taken out, one going ahead -- the one going ahead says where it is.
    stop('N', 'EXCLUDED', null),
    stop('N', 'PLANNED', '2026-11-04'),
  ],
};

const DAYS: Record<string, unknown[]> = {
  'plan-q3': [
    { technicianId: 'tech-1', date: day('2026-08-04'), templateGroupPosition: 2, templateGroupName: 'Heights', templateGroupColor: '#3cb44b' },
    { technicianId: 'tech-1', date: day('2026-08-05'), templateGroupPosition: 3, templateGroupName: 'North', templateGroupColor: '#4363d8' },
  ],
  'plan-q4': [
    { technicianId: 'tech-1', date: day('2026-11-04'), templateGroupPosition: 1, templateGroupName: 'East', templateGroupColor: '#e6194b' },
  ],
};

const tenancy = (buildingId: string, tbpEnrollment: string, firstSyncedAt = '2026-01-05T08:00:00Z') => ({
  propertywareBuildingId: buildingId,
  isActive: true,
  tbpEnrollment,
  zone: 'Zone 1',
  deactivatedAt: null,
  firstSyncedAt: new Date(firstSyncedAt),
});

const TENANCIES = [
  tenancy('A', 'Yes'),
  tenancy('L', 'No'),
  tenancy('N', 'Yes', '2026-10-09T08:00:00Z'),
  // M joined after the quarter was built: in no plan at all.
  tenancy('M', 'Yes', '2026-10-13T08:00:00Z'),
  tenancy('X', 'Yes'),
];

const HISTORY = [
  {
    id: 'change-2',
    buildingId: 'L',
    kind: 'LEFT',
    source: 'TENANT_REPORT',
    reason: 'NOT_ENROLLED',
    detail: 'No',
    actorName: null,
    occurredAt: new Date('2026-10-14T08:00:00Z'),
  },
  {
    id: 'change-1',
    buildingId: 'N',
    kind: 'JOINED',
    source: 'TENANT_REPORT',
    reason: null,
    detail: null,
    actorName: null,
    occurredAt: new Date('2026-10-10T08:00:00Z'),
  },
];

type Where = { organizationId: string; id?: string; quarterYear?: number; quarterNumber?: number; planId?: string };
type In = { in?: string[]; not?: null };

function build(options: { previous?: boolean; plan?: typeof Q4 | null } = {}) {
  const plans = [options.plan === undefined ? Q4 : options.plan, options.previous === false ? null : Q3].filter(Boolean) as (typeof Q4)[];
  const findPlan = jest.fn().mockImplementation(({ where }: { where: Where }) =>
    Promise.resolve(
      plans.find(
        (plan) =>
          where.organizationId === ORG &&
          (where.id ? plan.id === where.id : plan.quarterYear === where.quarterYear && plan.quarterNumber === where.quarterNumber),
      ) ?? null,
    ),
  );
  const only = (ids: In | undefined, buildingId: string) => !ids?.in || ids.in.includes(buildingId);
  const prisma = {
    tbpQuarterPlan: { findFirst: findPlan },
    tbpQuarterPlanStop: { findMany: jest.fn(({ where }: { where: Where }) => Promise.resolve(STOPS[where.planId!] ?? [])) },
    tbpQuarterPlanDay: { findMany: jest.fn(({ where }: { where: Where }) => Promise.resolve(DAYS[where.planId!] ?? [])) },
    propertywareTenant: {
      findMany: jest.fn(({ where }: { where: { propertywareBuildingId: In } }) =>
        Promise.resolve(TENANCIES.filter((row) => only(where.propertywareBuildingId, row.propertywareBuildingId))),
      ),
    },
    propertyServiceStatus: { findMany: jest.fn().mockResolvedValue([]) },
    tbpPackageChange: {
      findMany: jest.fn(({ where }: { where: { kind?: string; buildingId?: In } }) =>
        Promise.resolve(
          HISTORY.filter((change) => (!where.kind || change.kind === where.kind) && only(where.buildingId, change.buildingId)),
        ),
      ),
      count: jest.fn().mockResolvedValue(HISTORY.length),
    },
    propertywareBuilding: {
      findMany: jest.fn(({ where }: { where: { id: In } }) =>
        Promise.resolve(
          ['A', 'L', 'M', 'N', 'X']
            .filter((id) => only(where.id, id))
            .map((id) => ({ id, addressLine1: `${id} Oak St`, name: id })),
        ),
      ),
    },
  };
  return { service: new QuarterPackageChangesService(prisma as unknown as PrismaService), prisma, findPlan };
}

describe('a quarter’s package changes', () => {
  it('lists a property visited last quarter that has left, with that day’s group, and what became of this quarter’s visit', async () => {
    const { service } = build();

    const changes = await service.changes(ORG, Q4.id);

    expect(changes.previous).toEqual({ planId: 'plan-q3', quarterYear: 2026, quarterNumber: 3 });
    expect(changes.left).toEqual([
      {
        buildingId: 'L',
        address: 'L Oak St',
        // The report's No carries no date; the history saw it go.
        reasons: [{ code: 'NOT_ENROLLED', since: '2026-10-14T08:00:00.000Z', by: null, detail: 'No' }],
        lastQuarter: {
          status: 'PUBLISHED',
          scheduledOn: '2026-08-05',
          technician: 'Sam Tech',
          group: { position: 3, name: 'North', color: '#4363d8' },
        },
        thisQuarter: { status: 'EXCLUDED', scheduledOn: null, technician: null, group: null },
      },
    ]);
  });

  it('lists the properties new since last quarter, the ones this quarter has not placed first', async () => {
    const { service } = build();

    const { joined } = await service.changes(ORG, Q4.id);

    expect(joined.map((joiner) => joiner.buildingId)).toEqual(['M', 'X', 'N']);
    expect(joined[0]).toEqual({
      buildingId: 'M',
      address: 'M Oak St',
      joinedAt: null,
      firstOnReport: '2026-10-13T08:00:00.000Z',
      thisQuarter: null,
    });
    expect(joined[2]).toEqual({
      buildingId: 'N',
      address: 'N Oak St',
      joinedAt: '2026-10-10T08:00:00.000Z',
      firstOnReport: '2026-10-09T08:00:00.000Z',
      thisQuarter: {
        status: 'PLANNED',
        scheduledOn: '2026-11-04',
        technician: 'Sam Tech',
        group: { position: 1, name: 'East', color: '#e6194b' },
      },
    });
  });

  it('gives the dated history since last quarter began, newest first, with addresses', async () => {
    const { service, prisma } = build();

    const changes = await service.changes(ORG, Q4.id);

    expect(prisma.tbpPackageChange.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, occurredAt: { gte: Q3.quarterStartsOn } }, take: 200 }),
    );
    expect(changes.history[0]).toEqual({
      id: 'change-2',
      buildingId: 'L',
      address: 'L Oak St',
      kind: 'LEFT',
      source: 'TENANT_REPORT',
      reason: 'NOT_ENROLLED',
      detail: 'No',
      by: null,
      occurredAt: '2026-10-14T08:00:00.000Z',
    });
    expect(changes.historyMore).toBe(0);
  });

  it('calls nothing new when there is no last quarter to compare with, and still names who left this one', async () => {
    const { service } = build({ previous: false });

    const changes = await service.changes(ORG, Q4.id);

    expect(changes.previous).toBeNull();
    expect(changes.joined).toEqual([]);
    expect(changes.left.map((leaver) => [leaver.buildingId, leaver.lastQuarter])).toEqual([['L', null]]);
  });

  it('reads the quarter in the asker’s organization only', async () => {
    const { service, findPlan } = build({ plan: null });

    await expect(service.changes(ORG, Q4.id)).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    expect(findPlan).toHaveBeenCalledWith(expect.objectContaining({ where: { id: Q4.id, organizationId: ORG } }));
  });
});

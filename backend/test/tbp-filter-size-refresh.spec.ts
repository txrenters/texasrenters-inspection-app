import { TbpStopStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TbpPlanService } from '../src/planning/tbp-plan.service';

/**
 * Thawing a quarter's frozen filter sizes.
 *
 * A stop copies its filter sizes off the tenancy when the quarter is generated
 * and keeps them, so the console shows and Jobber receives exactly what a
 * coordinator reviewed. On 2026-09-22 the office asked why 131 of Q4's visits
 * still said "Update filter sizes" when the sizes were in Propertyware: the
 * nightly sync had stored them on the tenancy, and nothing in this system could
 * carry them the last step onto a stop that was already frozen. Not a button,
 * not an endpoint, not a script.
 *
 * These pin the thaw: it reaches a published visit, it never rewrites words a
 * coordinator typed, and it names the tenancies no refresh can help.
 */

const USER = {
  id: 'user-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: [],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const tenant = (sizes: string[], overrides: Record<string, unknown> = {}) => ({
  id: 't1',
  externalId: 'ext-t1',
  leaseName: 'Lease t1',
  startDate: null,
  zone: '2',
  addressLine1: '6341 Del Monte Dr',
  postalCode: '77057-3403',
  hvacFilterSizes: sizes,
  hvacFilterLocation: null,
  managementPlan: 'Standard',
  hvacPlan: 'On our AC Plan',
  propertywareBuildingId: null,
  unitExternalId: null,
  unitName: null,
  ...overrides,
});

const stop = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  status: TbpStopStatus.PLANNED,
  inspectionId: null,
  inspectionType: 'OCCUPIED',
  hvacFilterSizes: [],
  visitDetails: 'Filter Change: Update filter sizes + Pest Control + Occupied Inspection',
  visitDetailsOverriddenAt: null,
  officeDetails: null,
  propertywareUnitId: null,
  tenant: tenant(['16x25x1']),
  ...overrides,
});

const harness = (stops: Record<string, unknown>[]) => {
  const stopUpdate = jest.fn().mockResolvedValue({});
  const inspectionUpdate = jest.fn().mockResolvedValue({});
  const outboundUpsert = jest.fn().mockResolvedValue({ id: 'task-1' });
  const auditCreate = jest.fn().mockResolvedValue({});
  const tx = {
    tbpQuarterPlanStop: { update: stopUpdate },
    inspection: {
      update: inspectionUpdate,
      findFirst: jest.fn().mockResolvedValue({ jobberVisitId: 'visit-1', jobberJobId: 'job-1' }),
    },
    jobberOutboundTask: { upsert: outboundUpsert },
  };
  const prisma = {
    tbpQuarterPlan: { findFirst: jest.fn().mockResolvedValue({ id: 'plan-1' }) },
    tbpQuarterPlanStop: { findMany: jest.fn().mockResolvedValue(stops) },
    propertywareUnit: { findMany: jest.fn().mockResolvedValue([]) },
    auditLog: { create: auditCreate },
    $transaction: jest.fn((run: (client: unknown) => Promise<unknown>) => run(tx)),
  } as unknown as PrismaService;
  return { service: new TbpPlanService(prisma), stopUpdate, inspectionUpdate, outboundUpsert, auditCreate };
};

describe('re-reading a quarter’s filter sizes from the tenant report', () => {
  const pushEdits = process.env.JOBBER_PUSH_EDITS_ENABLED;
  beforeEach(() => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'true';
  });
  afterAll(() => {
    if (pushEdits === undefined) delete process.env.JOBBER_PUSH_EDITS_ENABLED;
    else process.env.JOBBER_PUSH_EDITS_ENABLED = pushEdits;
  });

  it('carries a size the office has since added onto the stop, and into the Details', async () => {
    const { service, stopUpdate } = harness([stop()]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.updated).toBe(1);
    expect(result.detailsRewritten).toBe(1);
    expect(stopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 's1' },
        data: expect.objectContaining({ hvacFilterSizes: ['16x25x1'] }),
      }),
    );
    expect(stopUpdate.mock.calls[0]![0].data.visitDetails).toContain('Filter Change: 16x25x1');
  });

  /**
   * The case the office actually reported. A published stop is a real
   * appointment a technician is holding, which is exactly why it has to be
   * included -- leaving it out would fix only the visits nobody has been sent
   * to yet.
   */
  it('reaches a published visit and queues Jobber the corrected text', async () => {
    const { service, inspectionUpdate, outboundUpsert } = harness([
      stop({ status: TbpStopStatus.PUBLISHED, inspectionId: 'insp-1' }),
    ]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.jobberQueued).toBe(1);
    expect(inspectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'insp-1' } }),
    );
    expect(outboundUpsert).toHaveBeenCalled();
  });

  it('updates the sizes under Details a coordinator wrote, but not the words', async () => {
    const written = 'Filter Change: ask the tenant + Occupied Inspection';
    const { service, stopUpdate } = harness([
      stop({ visitDetails: written, visitDetailsOverriddenAt: new Date() }),
    ]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.keptOverridden).toBe(1);
    expect(result.detailsRewritten).toBe(0);
    expect(stopUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { hvacFilterSizes: ['16x25x1'] },
    });
  });

  /**
   * A refresh cannot invent a size Propertyware does not hold, and 126
   * tenancies hold nothing but "Not Completed", "UPDATE" or ".". Naming them is
   * the only part of the answer that is any use to the office.
   */
  it('names the tenancies the report still holds no size for', async () => {
    const { service, stopUpdate } = harness([stop({ tenant: tenant([]) })]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.stillMissing).toEqual([
      { stopId: 's1', tenancyId: 't1', address: '6341 Del Monte Dr' },
    ]);
    // Nothing to change: the stop's frozen sizes were already empty.
    expect(result.updated).toBe(0);
    expect(stopUpdate).not.toHaveBeenCalled();
  });

  /**
   * A cell with no size in it is kept on the tenancy -- `unitFilterSizes` needs
   * "reusable window AC unit (…)" to know that unit is spoken for -- but the
   * writer prints nothing it cannot find a size in. Counting the array would
   * report this tenancy as covered; it is not.
   */
  it('counts a tenancy whose only entry carries no size as still missing', async () => {
    const note = 'reusable window AC unit (no need to change - 1/4 N Main)';
    const { service } = harness([stop({ tenant: tenant([note]) })]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.stillMissing).toHaveLength(1);
  });

  it('leaves a stop whose sizes already match alone', async () => {
    const { service, stopUpdate } = harness([stop({ hvacFilterSizes: ['16x25x1'] })]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.updated).toBe(0);
    expect(stopUpdate).not.toHaveBeenCalled();
  });
});

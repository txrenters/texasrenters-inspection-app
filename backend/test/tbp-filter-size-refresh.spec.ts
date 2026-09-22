import { InspectionStatus, TbpStopStatus } from '@prisma/client';
import { withInspectionLink } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import type { PrismaService } from '../src/common/prisma.service';
import { TbpPlanService, planVisitDetails } from '../src/planning/tbp-plan.service';

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
 * Most of what is pinned here is what the thaw must NOT touch. A quarter plan
 * holds real appointments, and the first draft of this reached every one of
 * them -- including the finished ones.
 */

const USER = {
  id: 'user-1',
  organizationId: 'org-1',
  displayName: 'Coordinator',
  roles: [],
  permissions: [],
  principalType: 'USER',
} as unknown as AuthenticatedUser;

const DETAILS = 'Filter Change: Update filter sizes + Pest Control + Occupied Inspection';
const linked = (text: string) => withInspectionLink(text, 'http://localhost:5454/inspections/insp-1');

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
  visitDetails: DETAILS,
  visitDetailsOverriddenAt: null,
  officeDetails: null,
  propertywareUnitId: null,
  tenant: tenant(['16x25x1']),
  inspection: null,
  ...overrides,
});

/** A published stop, with the inspection carrying exactly what publish wrote. */
const published = (overrides: Record<string, unknown> = {}) =>
  stop({
    status: TbpStopStatus.PUBLISHED,
    inspectionId: 'insp-1',
    inspection: { id: 'insp-1', status: InspectionStatus.SCHEDULED, jobberVisitDetails: linked(DETAILS) },
    ...overrides,
  });

const harness = (stops: Record<string, unknown>[], options: { units?: Record<string, unknown>[] } = {}) => {
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
    propertywareUnit: { findMany: jest.fn().mockResolvedValue(options.units ?? []) },
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
    const { service, inspectionUpdate, outboundUpsert } = harness([published()]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.jobberQueued).toBe(1);
    expect(inspectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'insp-1', organizationId: 'org-1' } }),
    );
    expect(outboundUpsert).toHaveBeenCalled();
  });

  /**
   * The link is how a technician gets from the Jobber visit into the
   * inspection. Publish adds it; the first draft of this wrote the bare
   * rendered text and would have stripped it out of all 131 visits, then
   * pushed the stripped version to Jobber.
   */
  it('puts the inspection link back, rather than writing the bare Details', async () => {
    const { service, inspectionUpdate } = harness([published()]);

    await service.refreshFilterSizes(USER, 'plan-1');

    const written = inspectionUpdate.mock.calls[0]![0].data.jobberVisitDetails as string;
    expect(written).toContain('Filter Change: 16x25x1');
    expect(written).toContain('Texas Renters inspection: http://localhost:5454/inspections/insp-1');
  });

  /**
   * `jobberVisitDetails` is the record of what the technician was told, and the
   * old text is kept nowhere. `AdminService.updateJobberVisit` refuses these two
   * statuses before writing the same column; so does this. The endpoint takes
   * any plan id, including a quarter that ended months ago, so a completed
   * visit is the ordinary case rather than a corner.
   */
  it.each([InspectionStatus.COMPLETED, InspectionStatus.CANCELLED])(
    'leaves a %s inspection alone entirely',
    async (status) => {
      const { service, stopUpdate, inspectionUpdate, outboundUpsert } = harness([
        published({ inspection: { id: 'insp-1', status, jobberVisitDetails: linked(DETAILS) } }),
      ]);

      const result = await service.refreshFilterSizes(USER, 'plan-1');

      expect(result.keptFinished).toBe(1);
      expect(result.updated).toBe(0);
      expect(stopUpdate).not.toHaveBeenCalled();
      expect(inspectionUpdate).not.toHaveBeenCalled();
      expect(outboundUpsert).not.toHaveBeenCalled();
    },
  );

  /**
   * Editing a published visit's text from the console writes the inspection and
   * never touches the stop, so `visitDetailsOverriddenAt` is null and there is
   * no flag to read -- only the text itself, which no longer matches what this
   * plan last wrote.
   */
  it('does not overwrite a visit somebody edited in the console', async () => {
    const { service, stopUpdate, inspectionUpdate, outboundUpsert } = harness([
      published({
        inspection: {
          id: 'insp-1',
          status: InspectionStatus.SCHEDULED,
          jobberVisitDetails: 'Gate code 4412. Dog in the yard — call first.',
        },
      }),
    ]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.keptEditedInConsole).toBe(1);
    expect(inspectionUpdate).not.toHaveBeenCalled();
    expect(outboundUpsert).not.toHaveBeenCalled();
    // The stop still takes the new sizes: only the words somebody wrote are theirs.
    expect(stopUpdate).toHaveBeenCalled();
    expect(result.updated).toBe(1);
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
   * A size can move without the line moving -- the office reorders the cells,
   * or corrects a size the writer never printed. Nothing should reach an
   * appointment for that.
   */
  it('does not touch Jobber when the sizes changed but the Details read the same', async () => {
    // Rendered rather than written out, so this pins the comparison the service
    // makes and not one spelling of the Details.
    const sized = planVisitDetails(tenant(['16x25x1']), 'OCCUPIED', null);
    const { service, stopUpdate, inspectionUpdate, outboundUpsert } = harness([
      published({
        // The junk cell was dropped; the one real size, and so the line, is unchanged.
        hvacFilterSizes: ['16x25x1', 'Not Completed'],
        visitDetails: sized,
        inspection: { id: 'insp-1', status: InspectionStatus.SCHEDULED, jobberVisitDetails: linked(sized) },
      }),
    ]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.updated).toBe(1);
    expect(result.detailsRewritten).toBe(0);
    expect(result.jobberQueued).toBe(0);
    expect(inspectionUpdate).not.toHaveBeenCalled();
    expect(outboundUpsert).not.toHaveBeenCalled();
    expect(stopUpdate).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { hvacFilterSizes: ['16x25x1'] },
    });
  });

  /**
   * A unit deactivated since the quarter was built no longer comes back, and
   * the narrowing would silently widen to the whole building's sizes -- which
   * in a house of several units is next door's filter.
   */
  it('leaves a stop whose unit is no longer active rather than widening it to the building', async () => {
    const { service, stopUpdate } = harness(
      [stop({ propertywareUnitId: 'unit-gone', tenant: tenant(['20x20x1 (N Main)'], { propertywareBuildingId: 'b1' }) })],
      { units: [{ id: 'unit-other', name: '1/2 N Main', addressLine1: '5009 1/2 N Main St' }] },
    );

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.keptUnresolvedUnit).toBe(1);
    expect(result.updated).toBe(0);
    expect(stopUpdate).not.toHaveBeenCalled();
  });

  /**
   * The other half of that rule, and the one nothing pinned.
   *
   * Narrowing happens only when the tenancy has a building *and* the stop has a
   * unit. A tenancy whose building link has since gone -- the nightly sync
   * re-upserts the row and the address no longer matches -- keeps its stop's
   * unit id, but there are no sibling units to narrow against, so the stop is
   * refreshed from the tenancy's whole list rather than left alone. The
   * maintenance script read this as "unit unresolved" and skipped it, which is
   * how an estimate that overstated by three could turn round and understate.
   */
  it('still refreshes a stop whose tenancy has lost its building link', async () => {
    const { service, stopUpdate } = harness([
      stop({ propertywareUnitId: 'unit-1', tenant: tenant(['20x20x1'], { propertywareBuildingId: null }) }),
    ]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.keptUnresolvedUnit).toBe(0);
    expect(result.updated).toBe(1);
    expect(stopUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hvacFilterSizes: ['20x20x1'] }) }),
    );
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

  /**
   * Several hundred short transactions, not one long one. A stop that throws
   * must not take the quarter's other four hundred with it, and the audit has
   * to be written either way or a half-finished run leaves no record of what
   * moved.
   */
  it('carries on past a stop that fails, and still audits', async () => {
    const { service, stopUpdate, auditCreate } = harness([stop(), stop({ id: 's2' })]);
    stopUpdate.mockRejectedValueOnce(new Error('deadlock detected'));

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.failed).toBe(1);
    expect(result.updated).toBe(1);
    expect(auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'TBP_PLAN_FILTER_SIZES_REFRESHED' }),
      }),
    );
  });

  /**
   * With edits switched off the database still moves and Jobber never hears,
   * so the visit in front of the technician keeps the old size. Said in the
   * result rather than left to be discovered.
   */
  it('says so when this server does not send edits to Jobber', async () => {
    process.env.JOBBER_PUSH_EDITS_ENABLED = 'false';
    const { service, outboundUpsert } = harness([published()]);

    const result = await service.refreshFilterSizes(USER, 'plan-1');

    expect(result.jobberPushDisabled).toBe(true);
    expect(result.notSentToJobber).toBe(1);
    expect(result.jobberQueued).toBe(0);
    expect(outboundUpsert).not.toHaveBeenCalled();
  });
});

import { JobberOutboundKind } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import { QuarterPlannerService, routingSettings } from '../src/planning/quarter-planner.service';

/**
 * Publishing a quarter into Jobber's Unassigned list.
 *
 * The office's ask (2026-09-29): a checkbox on the rebuild dialog so a published
 * quarter arrives in Jobber with nobody on the visits, to be handed round there.
 * The reason it is wanted is in [[tbp-quarterly-planner]] — Q4 is still grouped
 * for one technician, so every visit Jobber receives lands on Moses, and the
 * office would rather distribute them itself.
 *
 * Two things this must not become:
 *
 * - **It is not "unassign the inspections".** The plan is still routed into
 *   somebody's days, the inspection still carries its assignment, and the phone
 *   and the console's calendar both read it. Only the `teamMemberIds` sent to
 *   Jobber are dropped. `tbp-visit-shape.spec.ts` pins the booking half.
 * - **It must survive a rebuild.** A rebuild that moved a visit to a different
 *   technician used to push that change to Jobber, which would write a name back
 *   onto a visit the office deliberately left blank — silently undoing the
 *   choice they made in the dialog. That guard is the second half of this file.
 */

const Q4 = { year: 2026, quarter: 4 as const };

/** The plan's settings as routing takes them, with the default answer. */
const SETTINGS = {
  occupiedVisitMinutes: 20,
  hvacVisitMinutes: 20,
  maxOnSiteMinutes: 360,
  maxDriveMinutes: 90,
  minStopsPerDay: 9,
  maxStopsPerDay: 10,
  maxLegMinutes: 20,
  holidays: [] as string[],
  startsOn: null as string | null,
  technicianIds: [] as string[],
  jobberUnassigned: false,
};

describe('the setting the dialog writes onto the plan', () => {
  it('defaults to assigning, so every plan that exists behaves as it did', () => {
    expect(routingSettings(SETTINGS, {}, Q4).jobberUnassigned).toBe(false);
  });

  it('takes the answer the dialog gives', () => {
    expect(routingSettings(SETTINGS, { jobberUnassigned: true }, Q4).jobberUnassigned).toBe(true);
  });

  it('keeps the plan’s own answer when a rebuild does not mention it', () => {
    // The quarter planner's cron re-routes without opening the dialog. Falling
    // back to `false` there would quietly start assigning a quarter the office
    // had chosen to leave unassigned.
    const unassigned = { ...SETTINGS, jobberUnassigned: true };
    expect(routingSettings(unassigned, { maxLegMinutes: 25 }, Q4).jobberUnassigned).toBe(true);
  });

  it('lets it be turned back off', () => {
    // `??` rather than a truthiness check: `false` is an answer, not an absence,
    // and a coordinator who unticks the box must not have it ignored.
    const unassigned = { ...SETTINGS, jobberUnassigned: true };
    expect(routingSettings(unassigned, { jobberUnassigned: false }, Q4).jobberUnassigned).toBe(
      false,
    );
  });

  it('refuses anything that is not a yes or a no', () => {
    expect(() =>
      routingSettings(SETTINGS, { jobberUnassigned: 'yes' as unknown as boolean }, Q4),
    ).toThrow('true or false');
  });

  it('assigns when neither side has an answer, rather than refusing', () => {
    // What the *caller* asked for is checked; what the plan holds is trusted.
    // The column is `NOT NULL DEFAULT false`, so validating the stored value too
    // would turn a caller's mistake and a plan row into the same refusal — and
    // would have every settings fixture in the suite throw.
    const bare = { ...SETTINGS } as Record<string, unknown>;
    delete bare.jobberUnassigned;
    expect(routingSettings(bare as typeof SETTINGS, {}, Q4).jobberUnassigned).toBe(false);
  });

  it('does not disturb the other settings', () => {
    // It shares `routingSettings` with the numeric limits, and a boolean added
    // to a validator full of ranges is exactly where a copy-paste goes wrong.
    const settings = routingSettings(SETTINGS, { jobberUnassigned: true }, Q4);
    expect(settings).toMatchObject({
      minStopsPerDay: 9,
      maxStopsPerDay: 10,
      maxLegMinutes: 20,
      technicianIds: [],
    });
  });
});

/**
 * A rebuild must not put a name back on a Jobber visit.
 *
 * `rebookMovedVisits` sends two separate pushes when a rebuild moves a booked
 * visit: the day, and the technician. The day is always Jobber's to know. The
 * technician is not, on a plan published unassigned.
 */
describe('rebuilding a plan published unassigned', () => {
  const INSPECTION = 'inspection-1';
  const STOP = 'stop-1';

  function build(jobberUnassigned: boolean) {
    const upsert = jest.fn().mockResolvedValue({});
    const tx = {
      inspection: {
        update: jest.fn().mockResolvedValue({}),
        // What `requestVisitPush` reads to decide the visit reached Jobber.
        findFirst: jest.fn().mockResolvedValue({ jobberVisitId: 'visit-9', jobberJobId: 'job-9' }),
      },
      inspectionAssignment: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({}),
      },
      jobberOutboundTask: { upsert },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      tbpQuarterPlan: { findUnique: jest.fn().mockResolvedValue({ jobberUnassigned }) },
      tbpQuarterPlanStop: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: STOP,
            // Both changed, so the day push and the technician push are both
            // in play and only one of them can be suppressed.
            scheduledOn: new Date('2026-10-09T00:00:00.000Z'),
            assignedTechnicianId: 'tech-2',
          },
        ]),
      },
      $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
    } as unknown as PrismaService;

    // Only the prisma client is exercised here: the routers are never reached,
    // because `rebookMovedVisits` reads what a layout already decided.
    const service = new QuarterPlannerService(
      prisma,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    /** The stops as they were before the rebuild laid the quarter out again. */
    const before: Map<string, { inspectionId: string; date: string; technicianId: string }> =
      new Map([[STOP, { inspectionId: INSPECTION, date: '2026-10-06', technicianId: 'tech-1' }]]);
    const rebook = (
      service as unknown as {
        rebookMovedVisits: (
          organizationId: string,
          planId: string,
          was: typeof before,
          actorId: string | null,
        ) => Promise<number>;
      }
    ).rebookMovedVisits.bind(service);
    return { rebook: () => rebook('org-1', 'plan-1', before, 'user-1'), tx, upsert };
  }

  /** The kinds pushed to Jobber, in the order they were queued. */
  const pushed = (upsert: jest.Mock) =>
    upsert.mock.calls.map((call) => call[0].create.kind as JobberOutboundKind);

  it('still tells Jobber the day moved', async () => {
    // Unassigned is about who, not when. A visit stranded on the old day would
    // be a worse outcome than one assigned to the wrong person.
    const { rebook, upsert } = build(true);
    await rebook();

    expect(pushed(upsert)).toContain(JobberOutboundKind.VISIT_RESCHEDULE);
  });

  it('does not push the technician change', async () => {
    const { rebook, upsert } = build(true);
    await rebook();

    expect(pushed(upsert)).not.toContain(JobberOutboundKind.VISIT_ASSIGN);
  });

  it('still moves the assignment here, because the phone reads it', async () => {
    // The part that would be wrong to skip: the visit belongs to somebody's day
    // in this app whatever Jobber has been told.
    const { rebook, tx } = build(true);
    await rebook();

    expect(tx.inspectionAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ technicianId: 'tech-2' }) }),
    );
  });

  it('pushes both halves on an ordinary plan', async () => {
    // The behaviour every existing plan has, unchanged.
    const { rebook, upsert } = build(false);
    await rebook();

    expect(pushed(upsert)).toEqual(
      expect.arrayContaining([
        JobberOutboundKind.VISIT_RESCHEDULE,
        JobberOutboundKind.VISIT_ASSIGN,
      ]),
    );
  });
});

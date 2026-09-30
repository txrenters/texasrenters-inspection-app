import { JobberOutboundKind } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import {
  QuarterPlannerService,
  dayGroupNames,
  forUnassigned,
  routingSettings,
} from '../src/planning/quarter-planner.service';

/**
 * Publishing a quarter into Jobber's Unassigned list.
 *
 * The office's ask (2026-09-29): a checkbox on the rebuild dialog so a published
 * quarter arrives in Jobber with nobody on the visits, to be handed round there.
 * The reason it is wanted is in [[tbp-quarterly-planner]] — Q4 is still grouped
 * for one technician, so every visit Jobber receives lands on Moses, and the
 * office would rather distribute them itself.
 *
 * **It means nobody has the visits** (the office, 2026-09-29, replacing the
 * first version, where the phone still showed the plan's technicians their
 * days): not in Jobber and not on a phone, until the office hands them out in
 * Jobber and the sync gives them to whoever it named. So nobody needs choosing:
 * the days are sized for the benefit-package crew and are groups, not people.
 * `tbp-visit-shape.spec.ts` pins the booking half, `tbp-publish.spec.ts` the
 * inspections.
 *
 * **It must survive a rebuild.** A rebuild that moved a visit to a different
 * group must not put a name on it -- here or in Jobber. That guard is the
 * second half of this file.
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
  excludedZones: [] as string[],
  startsOn: null as string | null,
  technicianIds: [] as string[],
  jobberUnassigned: false,
  groupTemplateId: null as string | null,
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

  it('gives it to nobody here either: moving between groups changes nobody’s work', async () => {
    // Whoever the office handed it to in Jobber keeps it.
    const { rebook, tx } = build(true);
    await rebook();

    expect(tx.inspectionAssignment.updateMany).not.toHaveBeenCalled();
    expect(tx.inspectionAssignment.create).not.toHaveBeenCalled();
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

/**
 * Nobody to choose (the office, 2026-09-29: "I already checked that send the
 * visit out unassigned but I still can't rebuild it cause it still requires me
 * to pick one technician").
 */
describe('a quarter sent out to nobody needs nobody chosen', () => {
  it('takes an empty crew when the visits go out unassigned', () => {
    const settings = routingSettings(SETTINGS, { technicianIds: [], jobberUnassigned: true }, Q4);
    expect(settings.technicianIds).toEqual([]);
    expect(settings.jobberUnassigned).toBe(true);
  });

  it('takes it on a plan already sent out unassigned, too', () => {
    const unassigned = { ...SETTINGS, jobberUnassigned: true, technicianIds: ['tech-1'] };
    expect(routingSettings(unassigned, { technicianIds: [] }, Q4).technicianIds).toEqual([]);
  });

  it('still refuses an empty crew for visits that go to people', () => {
    expect(() => routingSettings(SETTINGS, { technicianIds: [] }, Q4)).toThrow(
      'Choose the technicians to send out on the plan, or send its visits out unassigned.',
    );
  });

  it('starts nobody’s day at somebody’s front door', () => {
    const roster = {
      technicianIds: ['tech-1', 'tech-2'],
      homes: new Map([['tech-1', { latitude: 29.7, longitude: -95.4 }]]),
    };
    expect(forUnassigned(roster, true)).toEqual({ technicianIds: ['tech-1', 'tech-2'], homes: new Map() });
    expect(forUnassigned(roster, false)).toBe(roster);
  });

  it('names the days by group, in the crew’s order, and anyone else after them', () => {
    expect([...dayGroupNames(['tech-2', 'tech-1'], ['tech-9', 'tech-1'])]).toEqual([
      ['tech-2', 'Day group 1'],
      ['tech-1', 'Day group 2'],
      ['tech-9', 'Day group 3'],
    ]);
  });
});

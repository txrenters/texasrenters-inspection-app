import { JobberOutboundKind, JobberOutboundStatus } from '@prisma/client';

import type { PrismaService } from '../src/common/prisma.service';
import { pickJobberProperty } from '../src/integrations/jobber/jobber.booking';
import type { JobberClient } from '../src/integrations/jobber/jobber.client';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';

/**
 * Booking in Jobber the visit a coordinator asked for when creating an occupied
 * inspection in the console. People, addresses and ids invented.
 */

const jobberEnvironment = {
  JOBBER_CLIENT_ID: 'client-id',
  JOBBER_CLIENT_SECRET: 'client-secret',
  JOBBER_API_VERSION: '2025-01-20',
  JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
};

const withEnvironment = <T>(overrides: Record<string, string | undefined>, build: () => T): T => {
  const previous = { ...process.env };
  Object.assign(process.env, jobberEnvironment, overrides);
  try {
    return build();
  } finally {
    process.env = previous;
  }
};

const TITLE = '100 Main St - Zone 3 - Q4 2026 Tenant Benefit Package';
const DETAILS = 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection';

const bookingTask = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  inspectionId: 'inspection-1',
  kind: JobberOutboundKind.VISIT_CREATE,
  jobberVisitId: null,
  jobberJobId: null,
  createdById: 'coordinator-1',
  servicesNoteSentAt: null,
  jobTitle: 'Zone 3 - Q4 2026 Tenant Benefit Package',
  attempts: 0,
  ...overrides,
});

function build({
  environment = { JOBBER_BOOKING_ENABLED: 'true' },
  task = bookingTask(),
  inspection = {},
  links = [{ jobberPropertyId: 'property-9', jobberAddress: '100 Main St', propertywareUnitId: null }],
  jobberUsers = [{ id: 'jobber-user-7' }],
}: {
  environment?: Record<string, string | undefined>;
  task?: ReturnType<typeof bookingTask>;
  inspection?: Record<string, unknown>;
  links?: {
    jobberPropertyId: string;
    jobberAddress: string | null;
    propertywareUnitId: string | null;
    lastUsedAt?: string | null;
  }[];
  jobberUsers?: { id: string }[];
} = {}) {
  const tx = {
    jobberOutboundTask: { update: jest.fn().mockResolvedValue({}) },
    inspection: { update: jest.fn().mockResolvedValue({}) },
    jobberVisitImport: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = {
    jobberOutboundTask: {
      findMany: jest.fn().mockResolvedValue([task]),
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue({ jobberJobId: task.jobberJobId }),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        status: 'SCHEDULED',
        scheduledAt: new Date('2026-10-06T00:00:00.000Z'),
        jobberVisitId: null,
        jobberVisitTitle: TITLE,
        jobberVisitDetails: DETAILS,
        propertywareBuildingId: 'building-1',
        propertywareUnitId: null,
        assignments: [{ technician: { email: 'Tech@Example.com' } }],
        ...inspection,
      }),
    },
    /**
     * Two raw queries now, told apart by their SQL.
     *
     * The property links are read raw because the day a Jobber record was last
     * used lives in `JobberVisitImport.payload->>'startAt'`, which Prisma
     * cannot aggregate through a relation. The Jobber user lookup was already
     * raw. A single mock answering both returned the users as links.
     */
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join(' ').includes('JobberPropertyLink')
          ? links.map((link) => ({ lastUsedAt: null, ...link }))
          : jobberUsers,
      ),
    ),
    $transaction: jest.fn((work: (client: typeof tx) => unknown) => work(tx)),
  };
  const request = jest
    .fn()
    .mockResolvedValueOnce({ jobCreate: { userErrors: [], job: { id: 'job-9' } } })
    .mockResolvedValueOnce({ visitCreate: { userErrors: [], createdVisits: [{ id: 'visit-9' }] } });
  const worker = withEnvironment(
    environment,
    () => new JobberOutboundWorker(prisma as unknown as PrismaService, { request } as unknown as JobberClient),
  );
  return { worker, prisma, tx, request };
}

describe('booking a console-created occupied inspection in Jobber', () => {
  it('creates the job and a whole-day visit with the text the console previewed, on the technician', async () => {
    const { worker, prisma, tx, request } = build();

    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1, failed: 0 });

    expect(request.mock.calls[0][2]).toEqual({
      input: {
        propertyId: 'property-9',
        title: 'Zone 3 - Q4 2026 Tenant Benefit Package',
        invoicing: { invoicingType: 'FIXED_PRICE', invoicingSchedule: 'ON_COMPLETION' },
      },
    });
    expect(request.mock.calls[1][2]).toEqual({
      jobId: 'job-9',
      input: {
        visits: [
          {
            title: TITLE,
            instructions: DETAILS,
            schedule: {
              startAt: { date: '2026-10-06', timezone: 'America/Chicago' },
              endAt: { date: '2026-10-06', timezone: 'America/Chicago' },
              notifyTeam: false,
              teamMemberIdsToAssign: ['jobber-user-7'],
            },
          },
        ],
      },
    });
    // The technician's Jobber id is looked up by their email, lower-cased.
    // Across the calls rather than at a fixed one: the property links are read
    // raw too now, and which runs first is not what this is about.
    expect(prisma.$queryRaw.mock.calls.flat()).toContain('tech@example.com');
    // Claimed as ours, so the next sync applies changes instead of importing it again.
    expect(tx.inspection.update).toHaveBeenCalledWith({
      where: { id: 'inspection-1' },
      data: { jobberVisitId: 'visit-9', jobberJobId: 'job-9', source: 'JOBBER' },
    });
    expect(tx.jobberVisitImport.upsert).toHaveBeenCalled();
  });

  it('books the visit unassigned when the technician is not a Jobber user it can name', async () => {
    const { worker, request } = build({ jobberUsers: [] });
    await worker.run('org-1');
    expect(request.mock.calls[1][2].input.visits[0].schedule).not.toHaveProperty('teamMemberIdsToAssign');
  });

  it('abandons at once a booking for an inspection cancelled before it went', async () => {
    const { worker, prisma, request } = build({ inspection: { status: 'CANCELLED' } });

    await expect(worker.run('org-1')).resolves.toMatchObject({ abandoned: 1 });
    expect(request).not.toHaveBeenCalled();
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: JobberOutboundStatus.ABANDONED }) }),
    );
  });

  it('sends nothing twice for an inspection already holding its visit', async () => {
    const { worker, request } = build({ inspection: { jobberVisitId: 'visit-9' } });
    await expect(worker.run('org-1')).resolves.toMatchObject({ sent: 1 });
    expect(request).not.toHaveBeenCalled();
  });

  it('retries rather than guesses when two Jobber properties could be the one', async () => {
    const { worker, prisma, request } = build({
      links: [
        { jobberPropertyId: 'property-9', jobberAddress: '101 N Main St', propertywareUnitId: null },
        { jobberPropertyId: 'property-10', jobberAddress: '101 1/2 N Main St', propertywareUnitId: null },
      ],
    });

    await expect(worker.run('org-1')).resolves.toMatchObject({ failed: 1 });
    expect(request).not.toHaveBeenCalled();
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: 'This property is linked to more than one Jobber property.' }),
      }),
    );
  });

  it('leaves bookings waiting while their switch is off, instead of failing them into abandonment', async () => {
    const { worker, prisma } = build({ environment: { JOBBER_BOOKING_ENABLED: undefined, JOBBER_TBP_WRITE_ENABLED: undefined } });
    prisma.jobberOutboundTask.findMany.mockResolvedValue([]);

    await worker.run('org-1');
    expect(prisma.jobberOutboundTask.findMany.mock.calls[0][0].where.kind).toEqual({
      notIn: [
        JobberOutboundKind.TBP_VISIT_CREATE,
        // A benefit-package visit with no day waits on the same switch.
        JobberOutboundKind.TBP_JOB_UNSCHEDULED,
        JobberOutboundKind.VISIT_CREATE,
        // Console edits follow booking when their own switch is unset.
        JobberOutboundKind.VISIT_RESCHEDULE,
        JobberOutboundKind.VISIT_ASSIGN,
        JobberOutboundKind.VISIT_EDIT,
        JobberOutboundKind.VISIT_CANCEL,
      ],
    });
  });

  it('asks for every kind when both switches are on', async () => {
    const { worker, prisma } = build({
      environment: { JOBBER_BOOKING_ENABLED: 'true', JOBBER_TBP_WRITE_ENABLED: 'true' },
    });
    prisma.jobberOutboundTask.findMany.mockResolvedValue([]);

    await worker.run('org-1');
    expect(prisma.jobberOutboundTask.findMany.mock.calls[0][0].where.kind).toEqual({ notIn: [] });
  });
});

describe('which Jobber property a visit is booked against', () => {
  const link = (
    jobberPropertyId: string,
    propertywareUnitId: string | null = null,
    lastUsedAt: string | null = null,
  ) => ({
    jobberPropertyId,
    jobberAddress: `${jobberPropertyId} address`,
    propertywareUnitId,
    lastUsedAt,
  });

  it("takes the unit's own link first", () => {
    expect(pickJobberProperty([link('whole-house'), link('unit-b', 'unit-b')], 'unit-b')).toMatchObject({
      status: 'LINKED',
      jobberPropertyId: 'unit-b',
    });
  });

  it("falls back to the building's link, as the office books a duplex under one address", () => {
    expect(pickJobberProperty([link('whole-house'), link('unit-a', 'unit-a')], 'unit-b')).toMatchObject({
      status: 'LINKED',
      jobberPropertyId: 'whole-house',
    });
  });

  it('refuses two properties it cannot tell apart', () => {
    expect(pickJobberProperty([link('front'), link('back')], 'unit-b')).toEqual({ status: 'AMBIGUOUS' });
  });

  /**
   * Sixty-two addresses exist twice in this office's Jobber — the same house
   * spelled "1103 East Hampton Drive" and "1103 E Hampton Dr". Refusing them
   * abandoned 61 outbound visits. The office's own rule (2026-09-22): the
   * record they used most recently is the live one.
   */
  it('takes the Jobber record the office used most recently', () => {
    expect(
      pickJobberProperty(
        [link('spelled-out', null, '2026-01-29T14:00:00Z'), link('abbreviated', null, '2026-09-21T14:00:00Z')],
        null,
      ),
    ).toMatchObject({ status: 'LINKED', jobberPropertyId: 'abbreviated' });
  });

  /** No visit against either is no evidence, and a guess sends somebody to the wrong door. */
  it('still refuses when neither record has ever been used', () => {
    expect(pickJobberProperty([link('front'), link('back')], null)).toEqual({ status: 'AMBIGUOUS' });
  });

  /** Both in use this week is the office's problem to settle, not ours to guess. */
  it('still refuses when both were last used on the same day', () => {
    expect(
      pickJobberProperty(
        [link('front', null, '2026-09-21T09:00:00Z'), link('back', null, '2026-09-21T09:00:00Z')],
        null,
      ),
    ).toEqual({ status: 'AMBIGUOUS' });
  });

  /**
   * One Jobber property can hold two link rows — a building link and a unit
   * link both pointing at it. Comparing rows rather than properties would read
   * that as a tie and refuse a house with only one record in use.
   */
  it('is not confused by one property holding two links', () => {
    expect(
      pickJobberProperty(
        [
          link('house', null, '2026-09-21T09:00:00Z'),
          link('house', 'unit-a', '2026-09-21T09:00:00Z'),
          link('old-record', null, '2025-03-02T09:00:00Z'),
        ],
        null,
      ),
    ).toMatchObject({ status: 'LINKED', jobberPropertyId: 'house' });
  });

  it('does not borrow another unit’s property', () => {
    expect(pickJobberProperty([link('unit-a', 'unit-a')], 'unit-b')).toEqual({ status: 'NOT_LINKED' });
  });

  it('books a building with no units against its one link', () => {
    expect(pickJobberProperty([link('house', 'unit-1')], null)).toMatchObject({ status: 'LINKED', jobberPropertyId: 'house' });
    expect(pickJobberProperty([], null)).toEqual({ status: 'NOT_LINKED' });
  });
});

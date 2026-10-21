import { JobberOutboundKind, UserRole } from '@prisma/client';

import type { AuthenticatedUser } from '../src/common/auth';
import {
  answerByMove,
  openRescheduleRequest,
  queueRescheduleNote,
  REBOOKED_IN_JOBBER_WINDOW_DAYS,
  settleRebookedInJobber,
  settleRescheduleRequests,
} from '../src/common/reschedule-requests';
import { RescheduleRequestsService } from '../src/admin/reschedule-requests.service';
import { rescheduleDismissedNote, rescheduleRequestedNote } from '../src/integrations/jobber/jobber.reschedule-note';
import { JobberOutboundWorker } from '../src/workers/jobber-sync/jobber-outbound.worker';
import { TechnicianService } from '../src/technician/technician.service';
import { rescheduleRequestDelegate } from './support/reschedule-request-mock';

/**
 * Visits to book again, as requests the office answers (2026-10-21): opened by
 * the technician's report, answered from the console's queue, and settled when
 * Jobber takes -- or refuses -- the answer. People, addresses and ids invented.
 */

const ORG = '10000000-0000-4000-8000-000000000001';

const person = (permissions: string[], roles: UserRole[] = [UserRole.INSPECTION_SUPERVISOR]): AuthenticatedUser =>
  ({
    id: '10000000-0000-4000-8000-000000000009',
    authUserId: 'auth-office',
    organizationId: ORG,
    displayName: 'Office Coordinator',
    roles,
    permissions,
    mustChangePassword: false,
    principalType: 'USER',
  }) as AuthenticatedUser;

const manager = person(['inspections:manage', 'planning:publish']);
const planner = person(['planning:publish']);
const reader = person(['inspections:read']);

/** A day far enough ahead that "today or later" holds whenever this runs. */
const AHEAD = '2099-11-02';

describe('opening a reschedule request', () => {
  const tx = () => ({ rescheduleRequest: rescheduleRequestDelegate(), auditLog: { create: jest.fn() } });
  const input = {
    organizationId: ORG,
    inspectionId: 'inspection-1',
    kind: 'NO_ACCESS' as const,
    services: ['pestControl'],
    reason: 'Locked gate',
    requestedById: 'technician-1',
  };

  it("opens one when the visit has none, and puts it on the visit's history", async () => {
    const db = tx();

    await expect(openRescheduleRequest(db as never, input)).resolves.toMatchObject({ created: true });

    expect(db.rescheduleRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ inspectionId: 'inspection-1', kind: 'NO_ACCESS', reason: 'Locked gate' }),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'RESCHEDULE_REQUESTED',
        entityId: 'inspection-1',
        actorUserId: 'technician-1',
      }),
    });
  });

  it('replaces the open one with the newest account rather than queueing a second', async () => {
    const db = tx();
    db.rescheduleRequest.findFirst.mockResolvedValue({ id: 'request-1', status: 'OPEN' });
    db.rescheduleRequest.update.mockResolvedValue({ id: 'request-1' });

    await expect(openRescheduleRequest(db as never, input)).resolves.toMatchObject({ id: 'request-1', updated: true });

    expect(db.rescheduleRequest.create).not.toHaveBeenCalled();
    // Whatever the office tried before is no longer what is asked.
    expect(db.rescheduleRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ outcome: null, jobberError: null, kind: 'NO_ACCESS' }) }),
    );
  });

  it('leaves a request the office has answered, and Jobber is taking, alone', async () => {
    const db = tx();
    db.rescheduleRequest.findFirst.mockResolvedValue({ id: 'request-1', status: 'SENDING' });

    await openRescheduleRequest(db as never, input);

    expect(db.rescheduleRequest.update).not.toHaveBeenCalled();
    expect(db.rescheduleRequest.create).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('a move answering a request', () => {
  it('waits for Jobber when Jobber has to take the new day', async () => {
    const db = { rescheduleRequest: rescheduleRequestDelegate() };
    db.rescheduleRequest.findMany.mockResolvedValue([{ id: 'request-1' }]);

    await answerByMove(db as never, { organizationId: ORG, inspectionId: 'i-1', resolvedById: 'u-1', waitsForJobber: true });

    expect(db.rescheduleRequest.findMany.mock.calls[0][0].where).toMatchObject({ kind: 'BEFORE_VISIT', status: 'OPEN' });
    expect(db.rescheduleRequest.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'SENDING', outcome: 'MOVED' });
  });

  it('is done at once when nothing goes to Jobber', async () => {
    const db = { rescheduleRequest: rescheduleRequestDelegate() };
    db.rescheduleRequest.findMany.mockResolvedValue([{ id: 'request-1' }]);

    await answerByMove(db as never, { organizationId: ORG, inspectionId: 'i-1', resolvedById: 'u-1', waitsForJobber: false });

    expect(db.rescheduleRequest.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'DONE' });
  });
});

describe("settling a request on Jobber's answer", () => {
  it('is done once Jobber takes the new day', async () => {
    const db = { rescheduleRequest: rescheduleRequestDelegate() };

    await settleRescheduleRequests(db as never, { organizationId: ORG, inspectionId: 'i-1', kind: JobberOutboundKind.VISIT_RESCHEDULE }, { sent: true });

    expect(db.rescheduleRequest.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: { in: ['OPEN', 'SENDING'] }, inspectionId: 'i-1', outcome: 'MOVED' },
      data: { status: 'DONE', jobberError: null },
    });
  });

  it("goes back to the office with Jobber's reason when the booking is refused for good", async () => {
    const db = { rescheduleRequest: rescheduleRequestDelegate() };

    await settleRescheduleRequests(
      db as never,
      { organizationId: ORG, inspectionId: 'new-1', kind: JobberOutboundKind.VISIT_CREATE },
      { sent: false, error: 'This property is not linked to a Jobber property.' },
    );

    expect(db.rescheduleRequest.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, status: 'SENDING', rebookInspectionId: 'new-1', outcome: 'REBOOKED' },
      data: { status: 'OPEN', jobberError: 'This property is not linked to a Jobber property.' },
    });
  });

  it('touches nothing for a push no request waits on', async () => {
    const db = { rescheduleRequest: rescheduleRequestDelegate() };

    await settleRescheduleRequests(db as never, { organizationId: ORG, inspectionId: 'i-1', kind: JobberOutboundKind.VISIT_ASSIGN }, { sent: true });

    expect(db.rescheduleRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe('a visit booked again by hand in Jobber', () => {
  const imported = {
    id: 'new-1',
    propertywareBuildingId: 'building-1',
    propertywareUnitId: null,
    inspectionType: 'OCCUPIED' as const,
    scheduledAt: new Date('2026-10-27T00:00:00.000Z'),
  };

  it('answers the oldest open request of the same kind at the same property, asked recently', async () => {
    const db = { rescheduleRequest: rescheduleRequestDelegate() };
    db.rescheduleRequest.findFirst.mockResolvedValue({ id: 'request-1' });

    await expect(settleRebookedInJobber(db as never, { organizationId: ORG, inspection: imported })).resolves.toBe('request-1');

    const where = db.rescheduleRequest.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      status: 'OPEN',
      outcome: null,
      inspection: { propertywareBuildingId: 'building-1', propertywareUnitId: null, inspectionType: 'OCCUPIED' },
    });
    // Never next quarter's routine visit.
    const window = Date.now() - where.createdAt.gte.getTime();
    expect(window).toBeGreaterThanOrEqual(REBOOKED_IN_JOBBER_WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1000);
    expect(db.rescheduleRequest.update).toHaveBeenCalledWith({
      where: { id: 'request-1' },
      data: expect.objectContaining({ status: 'DONE', outcome: 'REBOOKED', resolvedInJobber: true, rebookInspectionId: 'new-1' }),
    });
  });

  it('answers nothing when nothing is waiting', async () => {
    const db = { rescheduleRequest: rescheduleRequestDelegate() };

    await expect(settleRebookedInJobber(db as never, { organizationId: ORG, inspection: imported })).resolves.toBeNull();
    expect(db.rescheduleRequest.update).not.toHaveBeenCalled();
  });
});

describe("a request's note on the Jobber job", () => {
  it('is queued only for a visit Jobber has a job for', async () => {
    const db = { jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({ id: 'task-1' }) } };

    await expect(
      queueRescheduleNote(db as never, {
        organizationId: ORG,
        rescheduleRequestId: 'request-1',
        kind: JobberOutboundKind.RESCHEDULE_DISMISSED_NOTE,
        jobberJobId: null,
        createdById: 'u-1',
      }),
    ).resolves.toBeNull();
    expect(db.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });

  it('is armed again when asked again, rather than posted twice', async () => {
    const db = { jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({ id: 'task-1' }) } };

    await queueRescheduleNote(db as never, {
      organizationId: ORG,
      rescheduleRequestId: 'request-1',
      kind: JobberOutboundKind.RESCHEDULE_REQUESTED_NOTE,
      jobberJobId: 'job-9',
      createdById: 'u-1',
    });

    const call = db.jobberOutboundTask.upsert.mock.calls[0][0];
    expect(call.where).toEqual({
      organizationId_rescheduleRequestId_kind: { organizationId: ORG, rescheduleRequestId: 'request-1', kind: 'RESCHEDULE_REQUESTED_NOTE' },
    });
    expect(call.update).toMatchObject({ status: 'PENDING', attempts: 0, sentAt: null, jobberJobId: 'job-9' });
  });

  it('says what was asked, by whom, and that nothing has moved', () => {
    const note = rescheduleRequestedNote({
      reason: 'Tenant asked for Thursday',
      preferredOn: new Date('2026-10-29T00:00:00.000Z'),
      scheduledAt: new Date('2026-10-27T00:00:00.000Z'),
      technicianName: 'Moses',
      requestedAt: new Date('2026-10-21T15:00:00.000Z'),
    });

    expect(note).toContain('Reschedule requested by Moses in the Texas Renters inspection app');
    expect(note).toContain(': Tenant asked for Thursday');
    expect(note).toContain('Suggested day: Thu, Oct 29, 2026.');
    expect(note).toContain('The visit stays on Tue, Oct 27, 2026 until the office moves it.');
  });

  it('says a dismissed request is not booked, and why', () => {
    expect(
      rescheduleDismissedNote({
        beforeVisit: false,
        dismissReason: 'Tenant moved out',
        scheduledAt: new Date('2026-10-14T00:00:00.000Z'),
        dismissedBy: 'Office Coordinator',
      }),
    ).toBe('Not booked again, decided by Office Coordinator in the Texas Renters inspection app: Tenant moved out');
    expect(
      rescheduleDismissedNote({
        beforeVisit: true,
        dismissReason: 'Tenant will be home after all',
        scheduledAt: new Date('2026-10-27T00:00:00.000Z'),
        dismissedBy: 'Office Coordinator',
      }),
    ).toBe('Reschedule request dismissed by Office Coordinator: Tenant will be home after all\nThe visit stays on Tue, Oct 27, 2026.');
  });
});

/** A request as the queue reads it. */
const request = (over: Record<string, unknown> = {}) => ({
  id: 'request-1',
  inspectionId: 'inspection-1',
  kind: 'SERVICES_NOT_DONE',
  status: 'OPEN',
  outcome: null,
  resolvedInJobber: false,
  services: ['pestControl'],
  reason: 'Pest control: Tenant refused',
  preferredOn: null,
  createdAt: new Date('2026-10-20T15:00:00.000Z'),
  dismissReason: null,
  jobberError: null,
  resolvedAt: null,
  rebookInspectionId: null,
  requestedBy: { id: 'technician-1', displayName: 'Moses' },
  resolvedBy: null,
  inspection: {
    id: 'inspection-1',
    inspectionType: 'OCCUPIED',
    scheduledAt: new Date('2026-10-20T00:00:00.000Z'),
    status: 'TECHNICIAN_SUBMITTED',
    jobberVisitId: 'visit-1',
    jobberJobId: 'job-1',
    jobberCompanionOfId: null,
    propertywareBuilding: { name: '1 Example St', addressLine1: '1 Example St', city: 'Houston' },
    assignments: [{ technician: { id: 'technician-1', displayName: 'Moses' } }],
    jobberOutboundTasks: [],
  },
  rebookInspection: null,
  ...over,
});

function queue(row = request()) {
  const prisma = {
    rescheduleRequest: {
      ...rescheduleRequestDelegate(),
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue([row]),
      groupBy: jest.fn().mockResolvedValue([{ status: 'OPEN', _count: { _all: 1 } }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    inspection: {
      findFirstOrThrow: jest.fn().mockResolvedValue({
        inspectionType: 'OCCUPIED',
        scheduledAt: new Date('2026-10-20T00:00:00.000Z'),
        propertywareBuildingId: 'building-1',
        propertywareUnitId: null,
        propertywareLeaseId: 'lease-1',
        allowTechnicianAreaCapture: false,
        jobberVisitTitle: '1 Example St - Zone 3 - Q4 2026 Tenant Benefit Package',
        jobberVisitDetails: 'Filter Change: 20x25x1 + Pest Control + Occupied Inspection',
      }),
    },
    jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({ id: 'task-1' }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(async (run: (tx: unknown) => unknown): Promise<unknown> => run(prisma)),
  };
  const admin = {
    updateInspection: jest.fn().mockResolvedValue({}),
    // Runs the caller's part of the transaction, as the real one does.
    createInspection: jest.fn(async (_user, _input, options?: { within?: (tx: unknown, created: unknown) => Promise<void> }) => {
      await options?.within?.(prisma, { id: 'new-1', bookedInJobber: true });
      return {};
    }),
  };
  const service = new RescheduleRequestsService(prisma as never, admin as never);
  return { service, prisma, admin };
}

describe("the office's queue", () => {
  it('opens to whoever manages inspections or publishes the plan, and nobody else', async () => {
    await expect(queue().service.list(reader)).rejects.toMatchObject({ status: 403 });
    await expect(queue().service.list(planner)).resolves.toMatchObject({ counts: { open: 1, sending: 0 } });

    const list = await queue().service.list(manager);
    expect(list.items[0]).toMatchObject({
      action: 'BOOK_AGAIN',
      services: ['pestControl'],
      inspection: { scheduledOn: '2026-10-20', address: '1 Example St', inJobber: true },
    });
  });

  it('moves a visit still to happen through the console reschedule, which answers it', async () => {
    const { service, admin } = queue(
      request({ kind: 'BEFORE_VISIT', services: [], inspection: { ...request().inspection, status: 'SCHEDULED' } }),
    );

    await service.move(manager, 'request-1', { scheduledOn: AHEAD });

    expect(admin.updateInspection).toHaveBeenCalledWith(manager, 'inspection-1', { scheduledAt: `${AHEAD}T00:00:00.000Z` });
  });

  it('refuses to move a visit that was closed, or to let a planner without the inspections grant move one', async () => {
    await expect(queue().service.move(manager, 'request-1', { scheduledOn: AHEAD })).rejects.toMatchObject({
      code: 'RESCHEDULE_NOT_MOVABLE',
    });
    await expect(
      queue(request({ kind: 'BEFORE_VISIT' })).service.move(planner, 'request-1', { scheduledOn: AHEAD }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('books only what was not done again, in Jobber, with the same technician, and waits for Jobber', async () => {
    const { service, admin, prisma } = queue();

    await service.bookAgain(manager, 'request-1', { scheduledOn: AHEAD });

    const [, dto] = admin.createInspection.mock.calls[0];
    expect(dto).toMatchObject({
      propertyId: 'building-1',
      inspectionType: 'OCCUPIED',
      technicianId: 'technician-1',
      scheduledAt: `${AHEAD}T00:00:00.000Z`,
      jobberBooking: {
        zone: 'Zone 3',
        benefitPackage: true,
        services: { filterChange: false, pestControl: true, fleaTreatment: false },
      },
    });
    expect(prisma.rescheduleRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', organizationId: ORG, status: 'OPEN', rebookInspectionId: null },
      data: expect.objectContaining({ status: 'SENDING', outcome: 'REBOOKED', rebookInspectionId: 'new-1' }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'RESCHEDULE_REQUEST_REBOOKED', entityId: 'inspection-1' }),
    });
  });

  it('books it once: a request answered in the meantime takes the new inspection back with it', async () => {
    const { service, prisma } = queue();
    prisma.rescheduleRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.bookAgain(manager, 'request-1', { scheduledOn: AHEAD })).rejects.toMatchObject({
      code: 'RESCHEDULE_ALREADY_ANSWERED',
    });
  });

  it('does not book a second visit while the first booking is refused in Jobber', async () => {
    const { service, admin } = queue(request({ rebookInspectionId: 'new-1', jobberError: 'Refused' }));

    await expect(service.bookAgain(manager, 'request-1', { scheduledOn: AHEAD })).rejects.toMatchObject({
      code: 'RESCHEDULE_ALREADY_BOOKED',
    });
    expect(admin.createInspection).not.toHaveBeenCalled();
  });

  it('dismisses with a reason, and leaves a note on the Jobber job saying so', async () => {
    const { service, prisma } = queue();

    await service.dismiss(planner, 'request-1', { reason: 'Tenant moved out' });

    expect(prisma.rescheduleRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'request-1', organizationId: ORG, status: 'OPEN' },
      data: expect.objectContaining({ status: 'DISMISSED', dismissReason: 'Tenant moved out', resolvedById: planner.id }),
    });
    expect(prisma.jobberOutboundTask.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ kind: 'RESCHEDULE_DISMISSED_NOTE', jobberJobId: 'job-1', rescheduleRequestId: 'request-1' }),
      }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'RESCHEDULE_REQUEST_DISMISSED' }),
    });
  });

  it('refuses to dismiss what was answered already', async () => {
    const { service, prisma } = queue();
    prisma.rescheduleRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.dismiss(manager, 'request-1', { reason: 'Done' })).rejects.toMatchObject({
      code: 'RESCHEDULE_ALREADY_ANSWERED',
    });
    expect(prisma.jobberOutboundTask.upsert).not.toHaveBeenCalled();
  });
});

describe('a technician asking for another day, before going', () => {
  const technician = person([], [UserRole.INSPECTION_TECHNICIAN]);
  const job = (status = 'SCHEDULED') => ({
    id: 'job-1',
    status,
    propertywareBuilding: { name: '1 Example St' },
    propertywareUnit: null,
  });

  function build(record = job()) {
    const stored = {
      id: 'request-1',
      inspectionId: 'job-1',
      requestedById: technician.id,
      kind: 'BEFORE_VISIT',
      status: 'OPEN',
      reason: 'Tenant asked for Thursday',
      preferredOn: new Date(`${AHEAD}T00:00:00.000Z`),
      createdAt: new Date('2026-10-21T15:00:00.000Z'),
    };
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue(record),
        findUnique: jest.fn().mockResolvedValue({ jobberJobId: 'job-9' }),
      },
      rescheduleRequest: {
        ...rescheduleRequestDelegate(),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue(stored),
      },
      jobberOutboundTask: { upsert: jest.fn().mockResolvedValue({ id: 'task-1' }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (run: (tx: unknown) => unknown): Promise<unknown> => run(prisma)),
    };
    const service = new TechnicianService(prisma as never, {} as never, {} as never, {} as never);
    return { service, prisma, stored };
  }

  it('asks the office, moves nothing, and leaves a note on the Jobber job', async () => {
    const { service, prisma } = build();

    const answer = await service.requestReschedule(technician, 'job-1', {
      reason: ' Tenant asked for Thursday ',
      preferredOn: AHEAD,
    });

    expect(answer).toMatchObject({ kind: 'BEFORE_VISIT', status: 'OPEN', preferredOn: AHEAD });
    expect(prisma.rescheduleRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'BEFORE_VISIT', reason: 'Tenant asked for Thursday', services: [] }),
      }),
    );
    expect(prisma.jobberOutboundTask.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ create: expect.objectContaining({ kind: 'RESCHEDULE_REQUESTED_NOTE', jobberJobId: 'job-9' }) }),
    );
  });

  it('answers a retried send with the request it already made', async () => {
    const { service, prisma, stored } = build();
    prisma.rescheduleRequest.findUnique.mockResolvedValue(stored);

    await service.requestReschedule(technician, 'job-1', { reason: 'Tenant asked', clientRequestId: 'phone-key-0001' });

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("never answers with somebody else's request", async () => {
    const { service, prisma, stored } = build();
    prisma.rescheduleRequest.findUnique.mockResolvedValue({ ...stored, requestedById: 'another-technician' });

    await expect(
      service.requestReschedule(technician, 'job-1', { reason: 'Tenant asked', clientRequestId: 'phone-key-0001' }),
    ).rejects.toMatchObject({ code: 'CLIENT_REQUEST_ID_REUSED' });
  });

  it('refuses a job already started, and a suggested day not ahead', async () => {
    await expect(
      build(job('IN_PROGRESS')).service.requestReschedule(technician, 'job-1', { reason: 'Ran out of time' }),
    ).rejects.toMatchObject({ code: 'JOB_ALREADY_STARTED' });
    await expect(
      build().service.requestReschedule(technician, 'job-1', { reason: 'Tenant asked', preferredOn: '2000-01-03' }),
    ).rejects.toMatchObject({ code: 'PREFERRED_DAY_NOT_AHEAD' });
  });
});

describe("the outbound worker and a reschedule request's note", () => {
  const environment = {
    JOBBER_CLIENT_ID: 'client-id',
    JOBBER_CLIENT_SECRET: 'client-secret',
    JOBBER_API_VERSION: '2025-01-20',
    JOBBER_OAUTH_REDIRECT_URI: 'https://backend.example.com/api/v1/integrations/jobber/oauth/callback',
    JOBBER_PUSH_EDITS_ENABLED: 'true',
  };

  it('posts the note on the job and marks it sent', async () => {
    const previous = { ...process.env };
    Object.assign(process.env, environment);
    const task = {
      id: 'task-1',
      organizationId: ORG,
      inspectionId: null,
      tbpStopId: null,
      rescheduleRequestId: 'request-1',
      kind: JobberOutboundKind.RESCHEDULE_DISMISSED_NOTE,
      jobberVisitId: null,
      jobberJobId: 'job-9',
      createdById: 'u-1',
      servicesNoteSentAt: null,
      jobTitle: null,
      attempts: 0,
      nextAttemptAt: new Date(),
    };
    const prisma = {
      jobberOutboundTask: {
        findMany: jest.fn().mockResolvedValueOnce([task]).mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
      },
      rescheduleRequest: {
        ...rescheduleRequestDelegate(),
        findFirst: jest.fn().mockResolvedValue({
          kind: 'NO_ACCESS',
          reason: 'Locked gate',
          preferredOn: null,
          dismissReason: 'Tenant moved out',
          createdAt: new Date(),
          requestedBy: { displayName: 'Moses' },
          resolvedBy: { displayName: 'Office Coordinator' },
          inspection: { scheduledAt: new Date('2026-10-14T00:00:00.000Z'), jobberJobId: 'job-9' },
        }),
      },
    };
    const client = { request: jest.fn().mockResolvedValue({ jobCreateNote: { userErrors: [] } }) };
    try {
      const worker = new JobberOutboundWorker(prisma as never, client as never);
      await expect(worker.run(ORG)).resolves.toMatchObject({ sent: 1 });
    } finally {
      process.env = previous;
    }

    expect(client.request).toHaveBeenCalledWith(ORG, expect.stringContaining('jobCreateNote'), {
      jobId: 'job-9',
      input: { message: 'Not booked again, decided by Office Coordinator in the Texas Renters inspection app: Tenant moved out' },
    });
    expect(prisma.jobberOutboundTask.update).toHaveBeenCalledWith({
      where: { id: 'task-1' },
      data: expect.objectContaining({ status: 'SENT' }),
    });
  });
});

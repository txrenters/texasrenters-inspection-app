import { InspectionStatus, JobberVisitImportStatus, LeaseInspectionOutcome, TbpStopStatus } from '@prisma/client';

import { businessDate } from '../src/common/business-day';
import {
  cancelledByJobberSync,
  JOBBER_VISIT_DELETED,
  legacyRemovalReason,
  removeWithdrawnInspection,
} from '../src/workers/jobber-sync/jobber-visit-removal';
import { JobberSyncWorker } from '../src/workers/jobber-sync/jobber-sync.worker';

/**
 * A visit cancelled or deleted in Jobber is removed from the console (the
 * office, 2026-10-07: "if those are canceled or deleted from the Jobber, then
 * it should reflect also on our console ... so that the mobile app will be
 * freed on that schedules"). It used to be cancelled and kept with its
 * technician, and kept turning up on the map, the dashboard and the phone.
 * Ids and addresses invented.
 */

const ORG = '00000000-0000-4000-8000-000000000001';

/** A day well ahead of today, so the technician is told. */
const AHEAD = new Date(`${Number(businessDate().slice(0, 4)) + 1}-11-27T00:00:00Z`);

/** A transaction that answers every call, recording it; the ones a test reads are overridden. */
function transaction(overrides: Record<string, Record<string, jest.Mock>> = {}) {
  const models: Record<string, Record<string, jest.Mock>> = {};
  const tx = new Proxy(
    {},
    {
      get: (_, model: string) =>
        (models[model] ??= new Proxy(overrides[model] ?? {}, {
          get: (target: Record<string, jest.Mock>, method: string) =>
            (target[method] ??= jest.fn().mockResolvedValue({ count: 0 })),
        })),
    },
  );
  return { tx, models };
}

function harness(
  inspection: Record<string, unknown> | null,
  opts: { recordings?: number; photos?: number; answered?: number; claimed?: number } = {},
) {
  const { tx, models } = transaction({
    inspection: {
      updateMany: jest.fn().mockResolvedValue({ count: opts.claimed ?? 1 }),
      delete: jest.fn().mockResolvedValue({}),
    },
  });
  const prisma = {
    inspection: {
      findFirst: jest.fn().mockResolvedValue(
        inspection && {
          id: 'inspection-1',
          status: InspectionStatus.SCHEDULED,
          startedAt: null,
          scheduledAt: AHEAD,
          jobberVisitId: 'visit-1',
          cancellationReason: null,
          propertywareBuilding: { name: '605 Sorrento Dr', addressLine1: '605 Sorrento Dr' },
          assignments: [{ technicianId: 'tech-moses' }],
          ...inspection,
        },
      ),
    },
    inspectionMedia: { count: jest.fn().mockResolvedValue(opts.recordings ?? 0) },
    inspectionPhoto: { count: jest.fn().mockResolvedValue(opts.photos ?? 0) },
    inspectionAreaChecklistResponse: { count: jest.fn().mockResolvedValue(opts.answered ?? 0) },
    $transaction: jest.fn(async (work: (client: unknown) => Promise<unknown>) => work(tx)),
  };
  return { prisma, models };
}

const remove = (prisma: unknown, why: 'DELETED' | 'MISSING' | 'UNSCHEDULED' = 'DELETED') =>
  removeWithdrawnInspection(prisma as never, {
    organizationId: ORG,
    inspectionId: 'inspection-1',
    jobberVisitId: 'visit-1',
    why,
  });

describe('a visit deleted in Jobber', () => {
  it('deletes its inspection, and names the technician to tell and the job', async () => {
    const { prisma, models } = harness({});

    const removal = await remove(prisma);

    expect(removal).toEqual({
      outcome: 'REMOVED',
      notify: { technicianId: 'tech-moses', detail: '605 Sorrento Dr · Nov 27' },
    });
    expect(models.inspection.delete).toHaveBeenCalledWith({ where: { id: 'inspection-1' } });
    // The assignment goes with it: nothing left to put it on the phone.
    expect(models.inspectionAssignment.deleteMany).toHaveBeenCalledWith({ where: { inspectionId: 'inspection-1' } });
    expect(models.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'INSPECTION_DELETED',
        actorUserId: null,
        entityId: 'inspection-1',
        metadata: expect.objectContaining({
          source: 'JOBBER',
          reason: 'JOBBER_VISIT_DELETED',
          jobberVisitId: 'visit-1',
          technicianId: 'tech-moses',
        }),
      }),
    });
  });

  it('claims the inspection under its lock before anything goes, so a technician starting it wins', async () => {
    const { prisma, models } = harness({}, { claimed: 0 });

    await expect(remove(prisma)).resolves.toEqual({ outcome: 'IN_USE' });

    expect(models.inspection.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'inspection-1',
        organizationId: ORG,
        startedAt: null,
        status: { in: [InspectionStatus.SCHEDULED, InspectionStatus.CANCELLED] },
      },
      data: { updatedAt: expect.any(Date) },
    });
    expect(models.inspection.delete).not.toHaveBeenCalled();
  });

  it('rules the visit out for good, so the sync never imports it again', async () => {
    const { prisma, models } = harness({});

    await remove(prisma);

    expect(models.jobberVisitImport.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1' },
      data: expect.objectContaining({
        status: JobberVisitImportStatus.IGNORED,
        inspectionId: null,
        failureCode: JOBBER_VISIT_DELETED,
      }),
    });
  });

  it('records the lease schedule’s booking as cancelled, so it is not booked back into Jobber', async () => {
    // The schedule books a move-out again when its booking is gone -- which
    // would re-create in Jobber the visit the office deleted there.
    const { prisma, models } = harness({});

    await remove(prisma);

    expect(models.leaseScheduledInspection.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, inspectionId: 'inspection-1' },
      data: expect.objectContaining({ outcome: LeaseInspectionOutcome.CANCELLED }),
    });
  });

  it('takes the plan’s stop out of the quarter, with the reason', async () => {
    const { prisma, models } = harness({});

    await remove(prisma);

    expect(models.tbpQuarterPlanStop.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, inspectionId: 'inspection-1' },
      data: expect.objectContaining({
        status: TbpStopStatus.EXCLUDED,
        inspectionId: null,
        jobberVisitId: null,
        blockedMessage: expect.stringContaining('Its Jobber visit was deleted'),
      }),
    });
  });

  it('keeps the technician’s tracked hours, losing only the inspection', async () => {
    const { prisma, models } = harness({});

    await remove(prisma);

    expect(models.timeSegment.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, inspectionId: 'inspection-1' },
      data: { inspectionId: null },
    });
  });

  it.each([
    ['started', { startedAt: new Date() }, {}],
    ['in progress', { status: InspectionStatus.IN_PROGRESS }, {}],
    ['recorded', {}, { recordings: 1 }],
    ['photographed', {}, { photos: 2 }],
    ['answered', {}, { answered: 3 }],
  ])('leaves an inspection already %s for a person', async (_, inspection, opts) => {
    const { prisma } = harness(inspection, opts);

    await expect(remove(prisma)).resolves.toEqual({ outcome: 'IN_USE' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps one a person cancelled, with their reason', async () => {
    const { prisma } = harness({ status: InspectionStatus.CANCELLED, cancellationReason: 'Tenant extended the lease.' });

    await expect(remove(prisma)).resolves.toEqual({ outcome: 'KEPT_BY_OFFICE' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('removes one the sync cancelled before it deleted, without telling anyone again', async () => {
    const { prisma } = harness({
      status: InspectionStatus.CANCELLED,
      cancellationReason: 'The Jobber visit this inspection came from was deleted.',
    });

    await expect(remove(prisma)).resolves.toEqual({ outcome: 'REMOVED', notify: null });
  });

  it('does not tell a technician about a day already gone', async () => {
    const { prisma } = harness({ scheduledAt: new Date('2020-01-02T00:00:00Z') });

    await expect(remove(prisma)).resolves.toEqual({ outcome: 'REMOVED', notify: null });
  });

  it('touches nothing that is not this visit’s', async () => {
    const { prisma } = harness({ jobberVisitId: 'visit-2' });

    await expect(remove(prisma)).resolves.toEqual({ outcome: 'GONE' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('a visit moved to Unscheduled in Jobber', () => {
  it('removes its inspection, and leaves the visit and its stop waiting for a day', async () => {
    const { prisma, models } = harness({});

    await remove(prisma, 'UNSCHEDULED');

    // Pending: when Jobber gives it a day, the sync imports it as a new one.
    expect(models.jobberVisitImport.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1' },
      data: expect.objectContaining({ status: JobberVisitImportStatus.PENDING, inspectionId: null }),
    });
    // The stop keeps its visit, and the import puts the new inspection on it.
    expect(models.tbpQuarterPlanStop.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, inspectionId: 'inspection-1' },
      data: { status: TbpStopStatus.UNSCHEDULED, inspectionId: null, blockedCode: null, blockedMessage: null },
    });
  });
});

describe('which cancellations were the sync’s', () => {
  it('knows its own reasons from a person’s', () => {
    expect(cancelledByJobberSync('Moved to Unscheduled in Jobber. It comes back on the day Jobber gives it.')).toBe(true);
    expect(cancelledByJobberSync('No longer on Jobber’s schedule: deleted there, or moved to Unscheduled.')).toBe(true);
    expect(cancelledByJobberSync('The Jobber visit this inspection came from was deleted.')).toBe(true);
    expect(cancelledByJobberSync('Tenant extended the lease.')).toBe(false);
    expect(cancelledByJobberSync(null)).toBe(false);
  });

  it('reads what each stood for', () => {
    expect(legacyRemovalReason('Moved to Unscheduled in Jobber. It comes back on the day Jobber gives it.')).toBe(
      'UNSCHEDULED',
    );
    expect(legacyRemovalReason('The Jobber visit this inspection came from was deleted.')).toBe('DELETED');
    expect(legacyRemovalReason('No longer on Jobber’s schedule: deleted there.')).toBe('MISSING');
  });
});

describe('the sync, after a removal', () => {
  function worker(prisma: Record<string, unknown>) {
    const events = { publish: jest.fn() };
    const cache = { publish: jest.fn().mockResolvedValue(undefined) };
    const sync = new JobberSyncWorker(prisma as never, {} as never, {} as never, events as never, cache as never);
    return { sync, events, cache };
  }

  it('tells the technician which job went, and refreshes the console', async () => {
    const { prisma } = harness({});
    const { sync, events, cache } = worker(prisma);

    await sync.withdrawDeletedVisit(ORG, 'visit-1');

    expect(events.publish).toHaveBeenCalledWith('tech-moses', 'inspection-1', 'CANCELLED', '605 Sorrento Dr · Nov 27');
    expect(cache.publish).toHaveBeenCalledWith({ type: 'inspection.changed', organizationId: ORG });
  });

  it('says on the visit’s row that a person has to decide about work under way', async () => {
    const { prisma } = harness({ startedAt: new Date() });
    const importRows = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const { sync, events } = worker({ ...prisma, jobberVisitImport: importRows });

    await sync.withdrawDeletedVisit(ORG, 'visit-1');

    expect(importRows.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1' },
      data: expect.objectContaining({ failureCode: 'JOBBER_VISIT_DELETED_NEEDS_REVIEW' }),
    });
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('clears a deleted visit that never had an inspection: its queue row, and a stop waiting on it', async () => {
    const importRows = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const stops = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    const { sync } = worker({
      inspection: { findFirst: jest.fn().mockResolvedValue(null) },
      jobberVisitImport: importRows,
      tbpQuarterPlanStop: stops,
    });

    await sync.withdrawDeletedVisit(ORG, 'visit-1');

    expect(importRows.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1', status: { not: JobberVisitImportStatus.IGNORED } },
      data: expect.objectContaining({ status: JobberVisitImportStatus.IGNORED, failureCode: JOBBER_VISIT_DELETED }),
    });
    expect(stops.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, jobberVisitId: 'visit-1', inspectionId: null, status: TbpStopStatus.UNSCHEDULED },
      data: expect.objectContaining({ status: TbpStopStatus.EXCLUDED, jobberVisitId: null }),
    });
  });
});

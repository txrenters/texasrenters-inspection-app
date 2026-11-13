import { InspectionStatus } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { InspectionVideoService } from '../src/media/inspection-video.service';
import { MediaProcessingService } from '../src/technician/media-processing.service';
import { TechnicianService } from '../src/technician/technician.service';
import { rescheduleRequestDelegate } from './support/reschedule-request-mock';

/**
 * Submitting a move-in or move-out while its room videos are still sending
 * (2026-11-14).
 *
 * Everything on those visits runs on the videos, so a technician used to wait
 * out every upload, with the app open, before End job would go through; and a
 * video still sending when the job was submitted was refused and stranded on
 * the phone. Now End job names the videos still on their way, the room counts
 * as done, and the inspection waits a day for them -- then goes to review with
 * those that never arrived flagged, and the office is told once. Everything
 * invented.
 */

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: '10000000-0000-4000-8000-000000000001',
  displayName: 'Field Tech',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};
const ORG = technician.organizationId;
const DAY_MS = 24 * 60 * 60_000;

describe('End job with videos still sending', () => {
  const sendingRow = (over: Record<string, unknown> = {}) => ({
    providerMediaId: 'key-kitchen',
    inspectionAreaId: 'area-kitchen',
    recordingType: 'PRIMARY_AREA',
    uploadStatus: 'SESSION_CREATED',
    readyAt: null,
    processingStatus: 'PENDING',
    inspectionArea: { propertyArea: { name: 'Kitchen' } },
    ...over,
  });

  function submission(videos: Record<string, unknown>[], claimed = 1) {
    const record = {
      id: 'insp-1',
      inspectionType: 'MOVE_OUT',
      baselineInspectionId: null,
      baselineInspection: null,
      scheduledAt: new Date('2026-11-14T00:00:00.000Z'),
      status: InspectionStatus.IN_PROGRESS,
      priority: 'STANDARD',
      internalNotes: null,
      propertywareUnit: null,
      propertywareBuilding: { id: 'b1', name: '12 Example Lane', addressLine1: '12 Example Lane', city: 'Sampletown', state: 'TX', postalCode: '75964' },
      areas: [],
    };
    // The transaction runs on the same double; declared apart so its type is not circular.
    const transaction: { db?: unknown } = {};
    const prisma = {
      inspection: {
        findFirst: jest.fn().mockResolvedValue(record),
        update: jest.fn().mockResolvedValue({ ...record, status: InspectionStatus.TECHNICIAN_SUBMITTED }),
        updateMany: jest.fn().mockResolvedValue({ count: claimed }),
      },
      inspectionArea: { count: jest.fn().mockResolvedValue(0), findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      inspectionMedia: { findMany: jest.fn().mockResolvedValue(videos) },
      jobberOutboundTask: { create: jest.fn(), updateMany: jest.fn() },
      rescheduleRequest: rescheduleRequestDelegate(),
      auditLog: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(transaction.db)),
    };
    transaction.db = prisma;
    const events = { publish: jest.fn(), publishOrganizationNotification: jest.fn().mockResolvedValue(undefined) };
    const service = new TechnicianService(
      prisma as never,
      {} as never,
      {} as never,
      { queue: jest.fn(), advanceInspection: jest.fn().mockResolvedValue(undefined) } as never,
      events as never,
    );
    return { service, prisma, events };
  }

  it('counts a room whose video is still sending as done, and waits a day for it', async () => {
    const { service, prisma, events } = submission([sendingRow()]);
    const before = Date.now();

    await service.completeInspection(technician, 'insp-1', { videosStillSending: ['key-kitchen'] });

    // The gate leaves the room out; the room reads as recorded, only forward.
    expect(prisma.inspectionArea.count.mock.calls[0][0].where.id).toEqual({ notIn: ['area-kitchen'] });
    expect(prisma.inspectionArea.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['area-kitchen'] }, completionStatus: { in: ['PENDING', 'RECORDING'] } },
      data: { completionStatus: 'RECORDED' },
    });
    const until = prisma.inspection.update.mock.calls[0][0].data.lateVideosUntil as Date;
    expect(until.getTime()).toBeGreaterThanOrEqual(before + DAY_MS);
    expect(until.getTime()).toBeLessThanOrEqual(Date.now() + DAY_MS);
    expect(events.publishOrganizationNotification).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ kind: 'INSPECTION_SUBMITTED', body: expect.stringContaining('1 video still sending') }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'INSPECTION_SUBMITTED_WITH_VIDEOS_SENDING', metadata: { rooms: ['Kitchen'], videos: 1 } }),
    });
  });

  it('waits for nothing that already arrived', async () => {
    const { service, prisma } = submission([sendingRow({ uploadStatus: 'UPLOADED', processingStatus: 'PROCESSING' })]);

    await service.completeInspection(technician, 'insp-1', { videosStillSending: ['key-kitchen'] });

    expect(prisma.inspectionArea.count.mock.calls[0][0].where.id).toBeUndefined();
    expect(prisma.inspection.update.mock.calls[0][0].data.lateVideosUntil).toBeUndefined();
  });

  it('waits for an extra clip still sending, but it never stands in for its room’s own video', async () => {
    const { service, prisma } = submission([sendingRow({ recordingType: 'ADDITIONAL_ISSUE' })]);

    await service.completeInspection(technician, 'insp-1', { videosStillSending: ['key-kitchen'] });

    expect(prisma.inspectionArea.count.mock.calls[0][0].where.id).toBeUndefined();
    expect(prisma.inspection.update.mock.calls[0][0].data.lateVideosUntil).toBeInstanceOf(Date);
  });

  it('refuses a video the server never heard of, rather than waiting a day for nothing', async () => {
    const { service, prisma } = submission([]);

    await expect(service.completeInspection(technician, 'insp-1', { videosStillSending: ['key-unknown'] })).rejects.toMatchObject({
      code: 'VIDEOS_NOT_STARTED',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('submits once: a second press finds the job submitted already', async () => {
    const { service, prisma } = submission([], 0);

    await expect(service.completeInspection(technician, 'insp-1')).rejects.toMatchObject({ code: 'INSPECTION_NOT_COMPLETABLE' });
    expect(prisma.inspection.update).not.toHaveBeenCalled();
  });
});

describe('the wait for late videos ends once', () => {
  function processing(options: { claim?: number; status?: InspectionStatus; missing?: string[]; unfinished?: number; lateVideosUntil?: Date | null } = {}) {
    const record = {
      status: options.status ?? InspectionStatus.TECHNICIAN_SUBMITTED,
      inspectionType: 'MOVE_OUT',
      organizationId: ORG,
      lateVideosUntil: options.lateVideosUntil === undefined ? new Date() : options.lateVideosUntil,
      propertywareBuilding: { name: '12 Example Lane' },
      propertywareUnit: null,
    };
    const prisma = {
      inspection: {
        findUnique: jest.fn().mockResolvedValue(record),
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) =>
          'lateVideosUntil' in data ? { count: options.claim ?? 1 } : { count: 1 },
        ),
      },
      inspectionMedia: {
        count: jest.fn().mockResolvedValue(options.unfinished ?? 0),
        findMany: jest.fn().mockResolvedValue(
          (options.missing ?? []).map((name) => ({ inspectionArea: { propertyArea: { name } } })),
        ),
      },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
    const checklistPrefill = { afterSubmission: jest.fn().mockResolvedValue(undefined), afterLateVideo: jest.fn().mockResolvedValue(undefined) };
    const recordingSummary = { afterSubmission: jest.fn().mockResolvedValue(undefined), afterLateVideo: jest.fn().mockResolvedValue(undefined) };
    const comparison = { generate: jest.fn().mockResolvedValue(undefined) };
    const events = { publishOrganizationNotification: jest.fn().mockResolvedValue(undefined) };
    const service = new MediaProcessingService(
      prisma as never,
      {} as never,
      {} as never,
      comparison as never,
      undefined,
      undefined,
      undefined,
      checklistPrefill as never,
      recordingSummary as never,
      events as never,
    );
    return { service, prisma, checklistPrefill, recordingSummary, comparison, events };
  }

  it('settles once: a second call finds nothing to settle and tells nobody', async () => {
    const { service, events, prisma } = processing({ claim: 0 });

    await expect(service.settleLateVideos(ORG, 'insp-1')).resolves.toBe(false);
    expect(events.publishOrganizationNotification).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('sends the job to review and tells the office every video arrived', async () => {
    const { service, prisma, events, checklistPrefill } = processing();

    await expect(service.settleLateVideos(ORG, 'insp-1')).resolves.toBe(true);
    expect(prisma.inspection.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'REVIEW_REQUIRED' } }));
    expect(checklistPrefill.afterSubmission).toHaveBeenCalledWith(ORG, 'insp-1');
    expect(events.publishOrganizationNotification).toHaveBeenCalledWith(ORG, {
      kind: 'LATE_VIDEOS_ARRIVED',
      title: 'Late videos arrived',
      body: '12 Example Lane · Every video from the phone is in',
      inspectionId: 'insp-1',
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: 'LATE_VIDEOS_ARRIVED' }) });
  });

  it('names the rooms whose video never arrived', async () => {
    const { service, events } = processing({ missing: ['Kitchen', 'Garage', 'Kitchen'] });

    await service.settleLateVideos(ORG, 'insp-1');
    expect(events.publishOrganizationNotification).toHaveBeenCalledWith(ORG, {
      kind: 'LATE_VIDEOS_MISSING',
      title: '2 videos never arrived',
      body: '12 Example Lane · Not sent from the phone: Kitchen, Garage',
      inspectionId: 'insp-1',
    });
  });

  it('gives a job the office took on by hand meanwhile what review would have', async () => {
    const { service, checklistPrefill, recordingSummary, comparison } = processing({ status: InspectionStatus.UNDER_REVIEW });

    await service.settleLateVideos(ORG, 'insp-1');
    expect(checklistPrefill.afterSubmission).toHaveBeenCalledWith(ORG, 'insp-1');
    expect(recordingSummary.afterSubmission).toHaveBeenCalledWith(ORG, 'insp-1');
    expect(comparison.generate).toHaveBeenCalledWith('insp-1');
  });

  it('settles when the last awaited video is given up on, and not while another is still coming', async () => {
    const waiting = processing({ unfinished: 1 });
    await waiting.service.afterVideoGivenUp(ORG, 'insp-1');
    expect(waiting.events.publishOrganizationNotification).not.toHaveBeenCalled();

    const last = processing({ unfinished: 0 });
    await last.service.afterVideoGivenUp(ORG, 'insp-1');
    expect(last.events.publishOrganizationNotification).toHaveBeenCalledTimes(1);

    const nothingAwaited = processing({ lateVideosUntil: null });
    await nothingAwaited.service.afterVideoGivenUp(ORG, 'insp-1');
    expect(nothingAwaited.events.publishOrganizationNotification).not.toHaveBeenCalled();
  });

  it('catches up the room of a video that lands after review started, and leaves the rest to review', async () => {
    const late = processing({ status: InspectionStatus.REVIEW_REQUIRED, lateVideosUntil: null });
    await late.service['afterVideoProcessed'](ORG, 'insp-1', 'area-kitchen');
    expect(late.recordingSummary.afterLateVideo).toHaveBeenCalledWith(ORG, 'insp-1', 'area-kitchen');
    expect(late.checklistPrefill.afterLateVideo).toHaveBeenCalledWith(ORG, 'insp-1', 'area-kitchen');

    const onTime = processing({ status: InspectionStatus.TECHNICIAN_SUBMITTED, lateVideosUntil: null });
    await onTime.service['afterVideoProcessed'](ORG, 'insp-1', 'area-kitchen');
    expect(onTime.recordingSummary.afterLateVideo).not.toHaveBeenCalled();
    // Reaching review gives every room its summary at once.
    expect(onTime.recordingSummary.afterSubmission).toHaveBeenCalledWith(ORG, 'insp-1');
  });
});

describe('the wait that ran out', () => {
  function sweep(options: { missing?: { id: string; streamUid: string | null }[]; video?: unknown } = {}) {
    const prisma = {
      inspection: { findMany: jest.fn().mockResolvedValue([{ id: 'insp-1', organizationId: ORG }]) },
      inspectionMedia: {
        findMany: jest.fn().mockResolvedValue(options.missing ?? []),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const stream = { getVideo: jest.fn().mockResolvedValue(options.video ?? null) };
    const mediaProcessing = { queue: jest.fn(), settleLateVideos: jest.fn().mockResolvedValue(true) };
    const service = new InspectionVideoService(prisma as never, stream as never, mediaProcessing as never);
    return { service, prisma, stream, mediaProcessing };
  }

  it('asks Cloudflare about each missing video first, flags what is still missing, and settles', async () => {
    const { service, prisma, stream, mediaProcessing } = sweep({
      missing: [
        { id: 'media-1', streamUid: 'uid-1' },
        { id: 'media-2', streamUid: null },
      ],
    });

    await expect(service.settleOverdueLateVideos()).resolves.toEqual({ checked: 1, settled: 1 });
    expect(prisma.inspection.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { lateVideosUntil: { lt: expect.any(Date) } } }));
    expect(stream.getVideo).toHaveBeenCalledTimes(1);
    expect(stream.getVideo).toHaveBeenCalledWith('uid-1');
    expect(prisma.inspectionMedia.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['media-1', 'media-2'] },
        uploadStatus: { not: 'UPLOADED' },
        readyAt: null,
        processingStatus: 'PENDING',
      },
      data: expect.objectContaining({ processingStatus: 'FAILED', failureCode: 'VIDEO_NEVER_ARRIVED' }),
    });
    expect(mediaProcessing.settleLateVideos).toHaveBeenCalledWith(ORG, 'insp-1');
  });
});

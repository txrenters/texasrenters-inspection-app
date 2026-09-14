import { InspectionStatus, InspectionType } from '@prisma/client';

import type { ImportedReport } from '../src/admin/inspection-import/inspect-cloud-report';
import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Which inspection a report is written into.
 *
 * The one it was started from, unless the report's own date says otherwise.
 * 10118 Mariposa Green Ct is why: its August 2023 move-in report was imported
 * into the next tenant's October 2026 visit. The photographs were right and the
 * move-out beside it still said "No move-in to compare against", because the
 * comparison only looks for a move-in dated *before* the move-out. An
 * administrator re-dated the visit and the Jobber sync put its date back two
 * minutes later, and re-importing was refused as a duplicate.
 */

// The photographs come out of a real PDF; these tests are about where the rows
// land, so the reader is mocked and the source file can be empty.
jest.mock('../src/admin/inspection-import/inspect-cloud-pdf', () => ({
  readPages: jest.fn().mockResolvedValue([]),
  extractPhotos: jest.fn().mockReturnValue([]),
  countPhotosPerPage: jest.fn().mockResolvedValue([]),
}));

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const OCTOBER_VISIT = '00000000-0000-4000-8000-000000000003';
const BUILDING = '00000000-0000-4000-8000-000000000004';

const building = {
  id: BUILDING,
  name: '10118 Mariposa Green Ct,',
  addressLine1: '10118 Mariposa Green Ct',
  city: 'Houston',
  state: 'TX',
  postalCode: '77044',
};

/** The next tenant's move-in, as Jobber scheduled it: no unit, no lease. */
const octoberVisit = {
  id: OCTOBER_VISIT,
  inspectionType: InspectionType.MOVE_IN,
  scheduledAt: new Date('2026-10-02T00:00:00.000Z'),
  propertywareBuildingId: BUILDING,
  propertywareUnitId: null,
  propertywareLeaseId: null,
  propertywareBuilding: building,
};

const reportDated = (reportDate: string | null): ImportedReport => ({
  inspector: 'A. Inspector',
  template: 'Turnover Inspection',
  reportDate,
  pages: 1,
  areas: [
    {
      name: 'Kitchen',
      startedOnPage: 1,
      items: [
        {
          sourceLabel: 'Walls',
          matchedLabel: 'Walls',
          matchScore: 1,
          isClean: true,
          isUndamaged: true,
          isWorking: null,
          comment: null,
          assessed: true,
          page: 1,
        },
      ],
      photos: [],
    },
  ],
  unrecognised: [],
});

function build(report: ImportedReport, walkthroughAlreadyHere: { id: string } | null = null) {
  let settle: (data: Record<string, unknown>) => void = () => undefined;
  const settled = new Promise<Record<string, unknown>>((resolve) => {
    settle = resolve;
  });

  const tx = {
    property: { upsert: jest.fn().mockResolvedValue({}) },
    inspection: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'created-for-the-report' }),
      // Other inspections at the property with no rooms; none in these cases.
      findMany: jest.fn().mockResolvedValue([]),
    },
    propertyArea: {
      findMany: jest.fn().mockResolvedValue([{ id: 'area-kitchen', name: 'Kitchen', aliases: [] }]),
    },
    areaChecklistItem: { findFirst: jest.fn().mockResolvedValue({ id: 'item-walls' }) },
    inspectionArea: {
      upsert: jest.fn().mockResolvedValue({ id: 'attached-kitchen' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    inspectionAreaChecklistResponse: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    inspectionPhoto: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    inspectionImportJob: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'job-1',
        organizationId: user.organizationId,
        inspectionId: OCTOBER_VISIT,
        requestedInspectionId: OCTOBER_VISIT,
        fingerprint: 'f'.repeat(64),
        status: 'COMPLETED',
        committedAt: null,
        output: report,
      }),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        settle(data);
        return Promise.resolve({});
      }),
    },
    inspection: {
      findFirst: jest
        .fn()
        // The inspection the import was started from...
        .mockResolvedValueOnce(octoberVisit)
        // ...and, when the report is from another walkthrough, that one's.
        .mockResolvedValueOnce(walkthroughAlreadyHere),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    inspectionPhoto: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const storage = {
    get: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    putBytes: jest.fn().mockResolvedValue(undefined),
    providerName: jest.fn().mockReturnValue('local'),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const service = new InspectionImportService(prisma as never, storage as never, {
    read: jest.fn(),
  } as never);
  return { service, prisma, tx, settled };
}

const auditOf = (tx: ReturnType<typeof build>['tx']) =>
  tx.auditLog.create.mock.calls[0][0].data as { entityId: string; metadata: Record<string, unknown> };

describe('a report dated near the inspection it was started from', () => {
  it('is written into that inspection, as it always was', async () => {
    const { service, tx, prisma, settled } = build(reportDated('OCT-01-2026'));

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null, inspectionId: OCTOBER_VISIT });

    expect(tx.inspection.create).not.toHaveBeenCalled();
    expect(tx.inspection.update.mock.calls[0][0].where).toEqual({ id: OCTOBER_VISIT });
    expect(tx.inspectionArea.upsert.mock.calls[0][0].where.inspectionId_propertyAreaId.inspectionId).toBe(
      OCTOBER_VISIT,
    );
    // No second lookup: the chosen inspection is the walkthrough.
    expect(prisma.inspection.findFirst).toHaveBeenCalledTimes(1);
    expect(auditOf(tx)).toMatchObject({
      entityId: OCTOBER_VISIT,
      metadata: { placement: 'REQUESTED', requestedInspectionId: OCTOBER_VISIT },
    });
  });

  it('stays there when the report carries no date to measure', async () => {
    // A model-read report has no header date. Moving it would be a guess.
    const { service, tx, settled } = build(reportDated(null));

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null, inspectionId: OCTOBER_VISIT });
    expect(tx.inspection.create).not.toHaveBeenCalled();
  });
});

describe('a report from a different walkthrough', () => {
  it('gets its own inspection, dated by the report', async () => {
    const { service, tx, settled } = build(reportDated('AUG-21-2023'));

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({
      errorCode: null,
      inspectionId: 'created-for-the-report',
    });

    const created = tx.inspection.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      organizationId: user.organizationId,
      propertywareBuildingId: BUILDING,
      // The scope of the inspection it was started from, nulls included, so
      // the comparison's own rule finds it for the move-out beside it.
      propertywareUnitId: null,
      propertywareLeaseId: null,
      inspectionType: InspectionType.MOVE_IN,
      scheduledAt: new Date('2023-08-21T00:00:00.000Z'),
      completedAt: new Date('2023-08-21T00:00:00.000Z'),
      // The walk happened; nobody here has signed it off.
      status: InspectionStatus.COMPLETED,
      source: 'IMPORTED_REPORT',
    });
    expect(created).not.toHaveProperty('finalizedAt');
    // Not a Jobber visit, so the sync has no date to put back.
    expect(created).not.toHaveProperty('jobberVisitId');

    // The evidence is on the new inspection.
    expect(tx.inspectionArea.upsert.mock.calls[0][0].where.inspectionId_propertyAreaId.inspectionId).toBe(
      'created-for-the-report',
    );
    expect(auditOf(tx)).toMatchObject({
      entityId: 'created-for-the-report',
      metadata: {
        placement: 'CREATED',
        requestedInspectionId: OCTOBER_VISIT,
        reportDate: 'AUG-21-2023',
      },
    });
  });

  it('leaves the inspection it was started from exactly as it was', async () => {
    // The next tenant's visit still has to be walked in October.
    const { service, tx, prisma, settled } = build(reportDated('AUG-21-2023'));

    await service.commit(user, 'job-1');
    await settled;

    expect(tx.inspection.update).not.toHaveBeenCalled();
    // Nothing of its is read for superseding, let alone deleted.
    expect(prisma.inspectionPhoto.findMany).not.toHaveBeenCalled();
    expect(tx.inspectionPhoto.deleteMany.mock.calls.every(([arg]) => arg.where.inspectionId !== OCTOBER_VISIT)).toBe(
      true,
    );
  });

  it('uses the inspection that walkthrough already has', async () => {
    // Created by the backfill, or by an earlier import: a second one beside it
    // would be a duplicate baseline.
    const { service, tx, prisma, settled } = build(reportDated('AUG-21-2023'), { id: 'walked-2023' });

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null, inspectionId: 'walked-2023' });

    expect(tx.inspection.create).not.toHaveBeenCalled();
    expect(tx.inspection.update.mock.calls[0][0].where).toEqual({ id: 'walked-2023' });
    expect(prisma.inspectionPhoto.findMany.mock.calls[0][0].where).toEqual({ inspectionId: 'walked-2023' });
    expect(auditOf(tx).metadata).toMatchObject({ placement: 'MATCHED', requestedInspectionId: OCTOBER_VISIT });

    // Looked for in the same scope and a fortnight either side of the report.
    const lookup = prisma.inspection.findFirst.mock.calls[1][0].where;
    expect(lookup).toMatchObject({
      organizationId: user.organizationId,
      id: { not: OCTOBER_VISIT },
      propertywareBuildingId: BUILDING,
      propertywareUnitId: null,
      propertywareLeaseId: null,
      inspectionType: InspectionType.MOVE_IN,
      status: { not: InspectionStatus.CANCELLED },
      scheduledAt: {
        gte: new Date('2023-08-07T00:00:00.000Z'),
        lte: new Date('2023-09-04T00:00:00.000Z'),
      },
    });
  });
});

describe('a report that has already been imported', () => {
  const pdf = () => ({
    originalname: 'report.pdf',
    mimetype: 'application/pdf',
    size: 8,
    buffer: Buffer.from('%PDF-1.4'),
  });

  function starting(previous: Record<string, unknown>) {
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(octoberVisit) },
      inspectionImportJob: { findFirst: jest.fn(), create: jest.fn() },
      auditLog: { findFirst: jest.fn().mockResolvedValue(previous) },
    };
    const service = new InspectionImportService(prisma as never, {} as never, { read: jest.fn() } as never);
    return { service, prisma };
  }

  it('says which inspection it is on', async () => {
    const at = new Date('2026-09-14T18:30:40.000Z');
    const { service } = starting({
      action: 'INSPECTION_REPORT_IMPORTED',
      entityId: OCTOBER_VISIT,
      metadata: { fingerprint: 'f'.repeat(64) },
      createdAt: at,
    });

    await expect(service.start(user, OCTOBER_VISIT, pdf())).rejects.toMatchObject({
      code: 'REPORT_ALREADY_IMPORTED',
      details: [{ inspectionId: OCTOBER_VISIT, importedAt: at }],
    });
  });

  it('follows a report that was moved to the inspection it went to', async () => {
    // The row that imported it still names the inspection it left.
    const { service, prisma } = starting({
      action: 'INSPECTION_REPORT_MOVED',
      entityId: OCTOBER_VISIT,
      metadata: { fingerprint: 'f'.repeat(64), fromInspectionId: OCTOBER_VISIT, toInspectionId: 'walked-2023' },
      createdAt: new Date(),
    });

    await expect(service.start(user, OCTOBER_VISIT, pdf())).rejects.toMatchObject({
      details: [{ inspectionId: 'walked-2023' }],
    });
    expect(prisma.auditLog.findFirst.mock.calls[0][0].where.action).toEqual({
      in: ['INSPECTION_REPORT_IMPORTED', 'INSPECTION_REPORT_MOVED'],
    });
  });
});

describe('where an import began', () => {
  it('is remembered on the job, before anything decides where the report goes', async () => {
    const prisma = {
      inspection: { findFirst: jest.fn().mockResolvedValue(octoberVisit) },
      inspectionImportJob: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'job-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const storage = { putBytes: jest.fn().mockResolvedValue(undefined) };
    const service = new InspectionImportService(prisma as never, storage as never, { read: jest.fn() } as never);

    await service.start(user, OCTOBER_VISIT, {
      originalname: 'report.pdf',
      mimetype: 'application/pdf',
      size: 8,
      buffer: Buffer.from('%PDF-1.4'),
    });

    expect(prisma.inspectionImportJob.create.mock.calls[0][0].data).toMatchObject({
      inspectionId: OCTOBER_VISIT,
      requestedInspectionId: OCTOBER_VISIT,
    });
  });
});

import { InspectionType } from '@prisma/client';

import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Which inspection a report may be read into.
 *
 * The record already exists. Jobber closes a move-in when the visit completes,
 * so a walkthrough done in Inspect & Cloud arrives here as a finished
 * inspection with nothing in it. The import puts the evidence back into *that*
 * record — creating a second one would leave two move-ins for one walkthrough,
 * and the comparison takes the latest, so the duplicate would quietly become
 * the baseline every future move-out is judged against.
 */

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const INSPECTION_ID = '00000000-0000-4000-8000-000000000003';

const building = {
  id: '00000000-0000-4000-8000-000000000004',
  name: '17307 Nordway',
  addressLine1: '17307 Nordway Dr',
  city: 'Houston',
  state: 'TX',
  postalCode: '77070',
};

const inspection = (overrides: Record<string, unknown> = {}) => ({
  id: INSPECTION_ID,
  inspectionType: InspectionType.MOVE_IN,
  propertywareBuildingId: building.id,
  propertywareBuilding: building,
  _count: { areas: 0 },
  ...overrides,
});

function build(found: unknown) {
  const prisma = {
    inspection: { findFirst: jest.fn().mockResolvedValue(found) },
    inspectionImportJob: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      // The reading runs after `start` returns, so its bookkeeping has to be
      // mocked even though these tests are about what happens before it.
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const storage = { putBytes: jest.fn().mockResolvedValue(undefined) };
  const service = new InspectionImportService(
    prisma as never,
    storage as never,
    { read: jest.fn() } as never,
  );
  return { service, prisma, storage };
}

/** Smallest thing that passes the "is this a PDF" check. */
const report = () => ({
  originalname: 'report.pdf',
  mimetype: 'application/pdf',
  size: 5,
  buffer: Buffer.from('%PDF-1.4'),
});

describe('reading a report into an inspection that already exists', () => {
  it('refuses an inspection that already has evidence', async () => {
    // The one rule that matters. Seeding a record with areas would overwrite
    // somebody's walkthrough with a document — that is not an import.
    const { service, storage } = build(inspection({ _count: { areas: 12 } }));

    await expect(service.start(user, INSPECTION_ID, report())).rejects.toMatchObject({
      status: 409,
      code: 'INSPECTION_NOT_EMPTY',
    });
    // Nothing uploaded either: refusing after storing 73 MB would leave the
    // object behind for a job that never existed.
    expect(storage.putBytes).not.toHaveBeenCalled();
  });

  it('refuses anything that is not a move-in', async () => {
    // The point is a baseline for a later move-out. Seeding a move-out with a
    // move-in report would compare the property against itself.
    const { service } = build(inspection({ inspectionType: InspectionType.MOVE_OUT }));

    await expect(service.start(user, INSPECTION_ID, report())).rejects.toMatchObject({
      code: 'INSPECTION_NOT_A_MOVE_IN',
    });
  });

  it('refuses an inspection with no property to hang areas from', async () => {
    const { service } = build(inspection({ propertywareBuilding: null }));

    await expect(service.start(user, INSPECTION_ID, report())).rejects.toMatchObject({
      code: 'INSPECTION_HAS_NO_PROPERTY',
    });
  });

  it('does not care that the inspection is finalized', async () => {
    // Finalizing freezes evidence, and there is none: the record was closed in
    // Jobber because the walk happened, not because anything was recorded here.
    // Refusing a finalized shell would refuse every record this exists for.
    const { service, prisma } = build(inspection({ finalizedAt: new Date() }));
    prisma.inspectionImportJob.create.mockResolvedValue({ id: 'job-1' });

    await expect(service.start(user, INSPECTION_ID, report())).resolves.toMatchObject({
      status: 'RUNNING',
    });
  });

  it('scopes the lookup to the caller organization', async () => {
    // Another tenant's inspection is indistinguishable from one that does not
    // exist, which is the only answer that does not describe their roster.
    const { service, prisma } = build(null);

    await expect(service.start(user, INSPECTION_ID, report())).rejects.toMatchObject({
      status: 404,
      code: 'INSPECTION_NOT_FOUND',
    });
    expect(prisma.inspection.findFirst.mock.calls[0][0].where).toMatchObject({
      id: INSPECTION_ID,
      organizationId: user.organizationId,
    });
  });

  it('records which inspection the job is filling in', async () => {
    // The commit re-reads this rather than trusting a property id, so a job
    // with no inspection has nowhere to write.
    const { service, prisma } = build(inspection());
    prisma.inspectionImportJob.create.mockResolvedValue({ id: 'job-1' });

    await service.start(user, INSPECTION_ID, report());

    expect(prisma.inspectionImportJob.create.mock.calls[0][0].data).toMatchObject({
      inspectionId: INSPECTION_ID,
      organizationId: user.organizationId,
    });
  });

  it('refuses a file that is not a PDF before touching the database', async () => {
    const { service, prisma } = build(inspection());

    await expect(
      service.start(user, INSPECTION_ID, { ...report(), buffer: Buffer.from('not a pdf') }),
    ).rejects.toMatchObject({ code: 'REPORT_NOT_A_PDF' });
    expect(prisma.inspection.findFirst).not.toHaveBeenCalled();
  });
});

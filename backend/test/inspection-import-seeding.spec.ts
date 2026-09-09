import { InspectionType } from '@prisma/client';

import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Which inspection a report may be read into.
 *
 * Nearly all of them, now. The record already exists — Jobber closes a visit
 * when the work is done, so a walkthrough done in Inspect & Cloud arrives here
 * as a finished inspection with nothing in it — and the import puts the
 * evidence into *that* record rather than creating a second one, because the
 * comparison takes the latest move-in and a duplicate would quietly become the
 * baseline every future move-out is judged against.
 *
 * Two refusals used to guard this and both are gone. Neither was safety:
 *
 * - The **type** check only ever expressed scope. Move-ins were the reason this
 *   was built, but any type walked in another system is just as importable.
 * - The **emptiness** check counted areas, on the reasoning that a photograph
 *   needs an area so one cannot exist without the other — true, and backwards.
 *   Areas are snapshotted onto an inspection at creation, so half the
 *   inspections in the system were permanently un-importable while holding no
 *   evidence at all. Counting real evidence would have fixed that and still had
 *   it wrong: an import is what the office reaches for when the record here is
 *   *wrong*, so refusing to overwrite refused the only case that mattered.
 *
 * What replaced them is in `inspection-import-replaces-evidence.spec.ts`: the
 * import supersedes what it finds, in one transaction, counted into the audit.
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
  it('accepts an inspection that has areas but nothing recorded in them', async () => {
    /**
     * The regression this file used to enshrine.
     *
     * Every inspection at a property with an approved plan is *born* with
     * areas, so counting them as evidence hid the import on seventeen of
     * thirty-four inspections — each an empty shell nobody could fill.
     */
    const { service, prisma } = build(inspection());
    prisma.inspectionImportJob.create.mockResolvedValue({ id: 'job-1' });

    await expect(service.start(user, INSPECTION_ID, report())).resolves.toMatchObject({
      status: 'RUNNING',
    });
  });

  it('accepts an inspection that already holds evidence', async () => {
    // What the office asked for, and the reversal worth stating plainly: an
    // import is the tool for a record that is wrong, so it replaces rather than
    // refuses. 10051 Spotted Horse Dr is the case — two test rooms nobody could
    // delete, on an inspection nobody could import over.
    const { service, prisma } = build(inspection());
    prisma.inspectionImportJob.create.mockResolvedValue({ id: 'job-1' });

    await expect(service.start(user, INSPECTION_ID, report())).resolves.toMatchObject({
      status: 'RUNNING',
    });
    // And it does not go looking for a reason to refuse: no evidence is counted
    // at this point, because none of it decides anything any more.
    expect(prisma.inspection.findFirst.mock.calls[0][0].select).not.toHaveProperty('_count');
  });

  it.each([InspectionType.MOVE_OUT, InspectionType.OCCUPIED])(
    'accepts a %s inspection as readily as a move-in',
    async (inspectionType) => {
      // Move-ins were the reason this was built — a missing baseline is what
      // breaks a later comparison — but the office walks occupied inspections
      // in Inspect & Cloud routinely, and 122 of them can never be backfilled
      // from Jobber. Refusing left them holding a PDF with no way in.
      const { service, prisma } = build(inspection({ inspectionType }));
      prisma.inspectionImportJob.create.mockResolvedValue({ id: 'job-1' });

      await expect(service.start(user, INSPECTION_ID, report())).resolves.toMatchObject({
        status: 'RUNNING',
      });
    },
  );

  it('does not care that the inspection is finalized', async () => {
    // Finalizing freezes evidence, and this is the one place that now writes
    // through it — asked for outright, because a record closed with the wrong
    // walkthrough in it is exactly the record somebody needs to fix. The audit
    // row is what makes that answerable afterwards.
    const { service, prisma } = build(inspection({ finalizedAt: new Date() }));
    prisma.inspectionImportJob.create.mockResolvedValue({ id: 'job-1' });

    await expect(service.start(user, INSPECTION_ID, report())).resolves.toMatchObject({
      status: 'RUNNING',
    });
  });

  it('refuses an inspection with no property to hang areas from', async () => {
    // The only refusal left, and the only one that was ever about the import
    // being impossible rather than unwise: areas are created against a
    // property, so without one there is nowhere to write.
    const { service } = build(inspection({ propertywareBuilding: null }));

    await expect(service.start(user, INSPECTION_ID, report())).rejects.toMatchObject({
      code: 'INSPECTION_HAS_NO_PROPERTY',
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

  it('still refuses the same file twice', async () => {
    // Not emptiness, and worth keeping for a different reason: the same report
    // imported twice is somebody clicking again. Nothing is gained by redoing
    // it, and a second run would spend minutes replacing evidence with an
    // identical copy of itself.
    const { service, prisma } = build(inspection());
    prisma.auditLog.findFirst.mockResolvedValue({ entityId: INSPECTION_ID });

    await expect(service.start(user, INSPECTION_ID, report())).rejects.toMatchObject({
      status: 409,
      code: 'REPORT_ALREADY_IMPORTED',
    });
  });
});

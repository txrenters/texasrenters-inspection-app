import { InspectionType } from '@prisma/client';

import { PropertywareInspectionDocsService } from '../src/integrations/propertyware/propertyware.inspection-docs.service';
import { ApplicationError } from '../src/common/errors';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Which inspection a Propertyware document describes.
 *
 * This is the whole risk in the backfill. A document is filed against a
 * *building*, and one building holds thirteen inspections spanning 2019 to
 * 2026 — move-ins, move-outs and occupied visits, several of them with the same
 * filename. Attaching a report to the wrong record is not cosmetic: a move-in
 * is the baseline every later move-out is compared against, so a misfiled one
 * decides what a departing tenant is charged for.
 */

jest.mock('../src/admin/inspection-import/inspect-cloud-pdf', () => ({
  readPages: jest.fn().mockResolvedValue([]),
  extractPhotos: jest.fn().mockReturnValue([]),
  countPhotosPerPage: jest.fn().mockResolvedValue([]),
}));

const parsed = {
  template: 'Ingo ing Inspect io n',
  inspector: 'Moses Rodriguez',
  reportDate: 'AUG-28-2026',
  pages: 53,
  areas: [{ name: 'ENTRANCE', startedOnPage: 1, items: [], photos: [] }],
  unrecognised: [],
};
jest.mock('../src/admin/inspection-import/inspect-cloud-report', () => ({
  parseReport: jest.fn(() => parsed),
  reportFingerprint: jest.fn(() => 'f'.repeat(64)),
  CONFIDENT_MATCH: 0.8,
}));

const ORG = '00000000-0000-4000-8000-000000000001';
const BUILDING = '00000000-0000-4000-8000-000000000002';
const actor = { id: '00000000-0000-4000-8000-000000000003', organizationId: ORG } as AuthenticatedUser;

const pdf = Buffer.from('%PDF-1.4 pretend');

function build(row: Record<string, unknown> = {}) {
  const prisma = {
    propertywareBuilding: { findMany: jest.fn().mockResolvedValue([]) },
    propertywareInspectionDocument: {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'doc-row-1',
          externalDocumentId: '8738505231',
          fileName: '7306 Cypress Prairie Dr_Move In Inspection.pdf',
          guessedKind: InspectionType.MOVE_IN,
          buildingId: BUILDING,
          building: { id: BUILDING, name: '7306 Cypress Prairie', addressLine1: '7306 Cypress Prairie Dr' },
          ...row,
        },
      ]),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({ createdAt: new Date(), updatedAt: new Date() }),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: 'created-inspection' }),
    },
  };
  const client = {
    listDocuments: jest.fn().mockResolvedValue([]),
    downloadDocument: jest.fn().mockResolvedValue({ bytes: pdf, contentType: 'application/octet-stream' }),
  };
  const imports = {
    importPreparsed: jest.fn().mockResolvedValue({
      jobId: 'job-1',
      inspectionId: 'created-inspection',
      fingerprint: 'f'.repeat(64),
      committed: true,
      errorCode: null,
    }),
  };
  const service = new PropertywareInspectionDocsService(
    prisma as never,
    client as never,
    imports as never,
  );
  return { service, prisma, client, imports };
}

describe('importing a catalogued document', () => {
  it('reads the report before choosing an inspection', async () => {
    /**
     * Order, and the reason for the whole two-stage classification.
     *
     * The filename got this document downloaded; the report's own template line
     * is what it actually is. Choosing the inspection from the filename and
     * then importing would put a move-out's evidence into a move-in whenever
     * the office mistyped a name — and there is no undoing that once several
     * hundred photographs are attached.
     */
    const { service, client, imports, prisma } = build();

    await service.importPending({ organizationId: ORG, actor });

    expect(client.downloadDocument).toHaveBeenCalledWith('8738505231', expect.any(String));
    // Created as a move-in because the *template* said "Ingoing", not because
    // the filename did.
    expect(prisma.inspection.create.mock.calls[0][0].data).toMatchObject({
      inspectionType: InspectionType.MOVE_IN,
    });
    expect(imports.importPreparsed).toHaveBeenCalled();
  });

  it('fills in the inspection that already exists rather than making a second', async () => {
    // A completed Jobber visit leaves a finished, empty inspection here — the
    // exact case the importer was built for. Creating a second beside it would
    // leave two records for one walkthrough, and the comparison takes the
    // latest move-in, so the duplicate silently becomes the baseline.
    const { service, prisma, imports } = build();
    prisma.inspection.findFirst.mockResolvedValue({ id: 'existing-inspection' });

    await service.importPending({ organizationId: ORG, actor });

    expect(prisma.inspection.create).not.toHaveBeenCalled();
    expect(imports.importPreparsed.mock.calls[0][1]).toBe('existing-inspection');
  });

  it('matches on the report date, not on the day Propertyware received the file', async () => {
    // Reports are uploaded whenever somebody gets to it; one at 7306 Cypress
    // Prairie was filed eight months after the walk. Matching on the upload
    // date would miss the inspection it belongs to and create a duplicate.
    const { service, prisma } = build();

    await service.importPending({ organizationId: ORG, actor });

    const where = prisma.inspection.findFirst.mock.calls[0][0].where;
    // AUG-28-2026 from the report, plus and minus the matching window.
    expect(where.scheduledAt.gte.toISOString()).toContain('2026-08-14');
    expect(where.scheduledAt.lte.toISOString()).toContain('2026-09-11');
  });

  it('creates a completed inspection that is not finalized', async () => {
    /**
     * Two decisions, both deliberate.
     *
     * COMPLETED because the walk happened — years ago for most of these — and a
     * SCHEDULED record would appear in a technician's work list as something to
     * go and do. Not finalized because `finalizedAt` freezes evidence
     * permanently and stands for a person having signed the report off, and
     * nobody has.
     */
    const { service, prisma } = build();

    await service.importPending({ organizationId: ORG, actor });

    const data = prisma.inspection.create.mock.calls[0][0].data;
    expect(data.status).toBe('COMPLETED');
    expect(data.source).toBe('IMPORTED_REPORT');
    expect(data).not.toHaveProperty('finalizedAt');
  });

  it('skips a comparison summary without downloading it', async () => {
    // "MOVE IN VS MOVE OUT" is a summary written for an owner, not a
    // walkthrough. 51 of them, each a download worth avoiding.
    const { service, client, prisma } = build({ guessedKind: 'COMPARISON' });

    const outcome = await service.importPending({ organizationId: ORG, actor });

    expect(client.downloadDocument).not.toHaveBeenCalled();
    expect(outcome.skipped).toBe(1);
    expect(prisma.propertywareInspectionDocument.update.mock.calls[0][0].data).toMatchObject({
      status: 'SKIPPED',
      errorCode: 'NOT_AN_INSPECTION_TYPE',
    });
  });

  it('records a re-uploaded report as skipped, not as a failure', async () => {
    // The office re-uploads the same file, so two catalogue rows carry one
    // report. The importer refuses the second by content hash, which is
    // correct; treating it as a failure would have a re-run retry it forever.
    const { service, imports } = build();
    // The real error type, because that is what the service narrows on: a
    // plain Error carrying a `code` property is not an ApplicationError and
    // falls through to the generic failure path.
    imports.importPreparsed.mockRejectedValue(
      new ApplicationError(409, 'REPORT_ALREADY_IMPORTED', 'This report has already been imported.'),
    );

    const outcome = await service.importPending({ organizationId: ORG, actor });

    expect(outcome.skipped).toBe(1);
    expect(outcome.failed).toBe(0);
  });

  it('writes nothing on a dry run', async () => {
    const { service, prisma, imports } = build();

    await service.importPending({ organizationId: ORG, actor, dryRun: true });

    expect(imports.importPreparsed).not.toHaveBeenCalled();
    expect(prisma.inspection.create).not.toHaveBeenCalled();
  });
});

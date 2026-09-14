import type { ImportedPhoto, ImportedReport } from '../src/admin/inspection-import/inspect-cloud-report';
import { parseReport } from '../src/admin/inspection-import/inspect-cloud-report';
import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';

/**
 * Imported photographs' times, re-read from their reports.
 *
 * The importer handed each stamp to `new Date()`, reading it in the importing
 * machine's zone: UTC in production (five or six hours early), elsewhere for
 * some of the backfill. The correction re-reads the kept PDF and stores the
 * stamp as Texas time -- but only when every photograph still lines up with the
 * report as it reads today, because the pairing is by position.
 */

jest.mock('../src/admin/inspection-import/inspect-cloud-pdf', () => ({
  readPages: jest.fn().mockResolvedValue([]),
  extractPhotos: jest.fn().mockReturnValue([]),
  countPhotosPerPage: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/admin/inspection-import/inspect-cloud-report', () => ({
  ...jest.requireActual('../src/admin/inspection-import/inspect-cloud-report'),
  parseReport: jest.fn(),
}));

const ORG = '00000000-0000-4000-8000-000000000001';
const FINGERPRINT = 'a2f724e108c84a72'.padEnd(64, '0');

const photo = (caption: string, page: number, takenAt: string | null): ImportedPhoto => ({
  caption,
  matchedLabel: null,
  takenAt,
  page,
  index: 0,
});

const report = (photos: ImportedPhoto[]): ImportedReport => ({
  inspector: 'Amy Wilson',
  template: 'Turnover Inspection',
  reportDate: 'AUG-21-2023',
  pages: 3,
  areas: [{ name: 'Kitchen', startedOnPage: 1, items: [], photos }],
  unrecognised: [],
});

/** A stored row, as the import wrote it: the n-th photograph in the n-th object. */
const row = (index: number, label: string, page: number) => ({
  id: `photo-${index}`,
  storageKey: `${ORG}/imported/${FINGERPRINT.slice(0, 16)}/${String(index).padStart(4, '0')}-${'f'.repeat(32)}.jpg`,
  label,
  metadata: { importedFrom: FINGERPRINT, page },
  // Read as if UTC by the old importer.
  capturedAt: new Date('2023-08-21T13:15:39.000Z'),
});

function build(rows: ReturnType<typeof row>[], source: Buffer | null = Buffer.from('%PDF-1.4')) {
  const update = jest.fn((args: unknown) => args);
  const prisma = {
    inspectionPhoto: { findMany: jest.fn().mockResolvedValue(rows), update },
    $transaction: jest.fn().mockResolvedValue([]),
  };
  const storage = {
    get: source ? jest.fn().mockResolvedValue(source) : jest.fn().mockRejectedValue(new Error('NoSuchKey')),
  };
  const service = new InspectionImportService(prisma as never, storage as never, { read: jest.fn() } as never);
  return { service, prisma, update };
}

const parsed = parseReport as jest.MockedFunction<typeof parseReport>;

describe('correcting imported photographs from their report', () => {
  it('stores each stamp as Texas time, with the words the report printed', async () => {
    parsed.mockReturnValue(
      report([photo('SINK', 2, 'Aug 21 2023 01:15:39 PM'), photo('OVEN', 2, 'Aug 21 2023 01:16:02 PM')]),
    );
    const { service, prisma, update } = build([row(0, 'SINK', 2), row(1, 'OVEN', 2)]);

    const result = await service.correctImportedPhotoTimes(ORG, FINGERPRINT, { apply: true });

    expect(result).toMatchObject({ status: 'CORRECTED', photos: 2, corrected: 2, mismatched: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![0]).toEqual({
      where: { id: 'photo-0' },
      data: {
        // 1:15:39 PM in Houston in August is 18:15:39 UTC -- not 13:15:39.
        capturedAt: new Date('2023-08-21T18:15:39.000Z'),
        captureTimeSource: 'REPORT_STAMP',
        captureTimeZone: 'America/Chicago',
        captureUtcOffsetMinutes: -300,
        metadata: { importedFrom: FINGERPRINT, page: 2, reportStamp: 'Aug 21 2023 01:15:39 PM' },
      },
    });
  });

  it('writes nothing on a dry run, and says what it would do', async () => {
    parsed.mockReturnValue(report([photo('SINK', 2, 'Aug 21 2023 01:15:39 PM')]));
    const { service, prisma } = build([row(0, 'SINK', 2)]);

    await expect(service.correctImportedPhotoTimes(ORG, FINGERPRINT, { apply: false })).resolves.toMatchObject({
      status: 'WOULD_CORRECT',
      corrected: 1,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('leaves a whole report alone when one photograph no longer lines up', async () => {
    // The parser reads this report differently today, so the second object
    // may not be the second stamp. Better no stamp than the neighbour's.
    parsed.mockReturnValue(
      report([photo('SINK', 2, 'Aug 21 2023 01:15:39 PM'), photo('RANGE HOOD', 3, 'Aug 21 2023 01:17:00 PM')]),
    );
    const { service, prisma } = build([row(0, 'SINK', 2), row(1, 'OVEN', 2)]);

    await expect(service.correctImportedPhotoTimes(ORG, FINGERPRINT, { apply: true })).resolves.toMatchObject({
      status: 'MISMATCHED',
      mismatched: 1,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('says when the kept report is gone, rather than guessing', async () => {
    const { service, prisma } = build([row(0, 'SINK', 2)], null);

    await expect(service.correctImportedPhotoTimes(ORG, FINGERPRINT, { apply: true })).resolves.toMatchObject({
      status: 'SOURCE_MISSING',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips a stamp that will not read, and corrects the rest', async () => {
    parsed.mockReturnValue(
      report([photo('SINK', 2, 'Aug 21 2023 13:15:39 PM'), photo('OVEN', 2, 'Aug 21 2023 01:16:02 PM')]),
    );
    const { service, update } = build([row(0, 'SINK', 2), row(1, 'OVEN', 2)]);

    await expect(service.correctImportedPhotoTimes(ORG, FINGERPRINT, { apply: true })).resolves.toMatchObject({
      status: 'CORRECTED',
      corrected: 1,
      unreadable: 1,
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});

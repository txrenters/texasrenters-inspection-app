import type { RoomSnapshot } from '../src/domain/models';
import {
  GALLERY_IMPORT_LIMIT,
  importFromGallery,
  inspectionAllowsGalleryImport,
  type GalleryImportOutcome,
} from '../src/media/gallery-import';
import { captureTimeToSend } from '../src/media/snapshot-upload';

/**
 * Photographs a technician already has, attached to the area they are in.
 *
 * Moses Rodriguez, 2026-09-18: "The upload button for the pictures would help
 * so much right now. It does take me a little longer to complete the occupied
 * inspections."
 *
 * The picker is native, so it is injected here. What these pin is everything
 * around it: that an import joins the ordinary upload queue, that it numbers
 * after the photographs already in the area, and — most of all — that it
 * claims no capture time it does not have.
 */

jest.mock('expo-image-picker', () => ({}));

const persist = (uri: string) => ({ uri: `file:///stored/${uri.split('/').pop()}`, sizeBytes: 10 });

const picker = (
  result: { canceled: true } | { canceled: false; assets: unknown[] },
  granted = true,
) =>
  ({
    requestMediaLibraryPermissionsAsync: async () => ({ granted }),
    launchImageLibraryAsync: async () => result,
  }) as never;

const asset = (name: string) => ({
  uri: `file:///cache/${name}`,
  width: 3024,
  height: 4032,
  fileSize: 2_000_000,
});

/** Narrows the outcome and hands back a tuple, so a test reads one photograph safely. */
function expectImported(outcome: GalleryImportOutcome): [RoomSnapshot, ...RoomSnapshot[]] {
  if (outcome.status !== 'IMPORTED') throw new Error(`expected an import, got ${outcome.status}`);
  const [first, ...rest] = outcome.snapshots;
  if (!first) throw new Error('expected at least one photograph');
  return [first, ...rest];
}

const input = {
  inspectionId: 'inspection-1',
  roomId: 'room-1',
  ownerUserId: 'user-1',
  existingPhotoCount: 0,
  persist,
};

describe('attaching photographs from the gallery', () => {
  it('builds a queued snapshot for each one picked', async () => {
    const outcome = await importFromGallery({
      ...input,
      picker: picker({ canceled: false, assets: [asset('a.jpg'), asset('b.jpg')] }),
    });

    expect(outcome.status).toBe('IMPORTED');
    if (outcome.status !== 'IMPORTED') return;
    expect(outcome.snapshots).toHaveLength(2);
    expect(outcome.snapshots[0]).toMatchObject({
      roomId: 'room-1',
      inspectionId: 'inspection-1',
      ownerUserId: 'user-1',
      uri: 'file:///stored/a.jpg',
      captureType: 'AREA_OVERVIEW',
      captureSource: 'GALLERY_IMPORT',
      uploadStatus: 'PENDING',
    });
  });

  /**
   * The whole reason `captureSource` gained a fourth value. A photograph taken
   * on the walk and one chosen out of a camera roll are different kinds of
   * evidence, and a report that cannot tell them apart invites the reader to
   * assume the second is the first.
   */
  it('records that they came from the library, not the walk', async () => {
    const outcome = await importFromGallery({
      ...input,
      picker: picker({ canceled: false, assets: [asset('a.jpg')] }),
    });

    const [imported] = expectImported(outcome);
    expect(imported.captureSource).toBe('GALLERY_IMPORT');
  });

  /**
   * A library asset's real moment lives in EXIF with no zone attached, and
   * guessing is how 651 imported reports ended up stamped wrong. No claim means
   * the server stamps its own receipt and labels it as such.
   */
  it('claims no capture time, so nothing invents one', async () => {
    const outcome = await importFromGallery({
      ...input,
      picker: picker({ canceled: false, assets: [asset('a.jpg')] }),
    });

    const [imported] = expectImported(outcome);
    expect(imported.captureUtcOffsetMinutes).toBeUndefined();
    expect(captureTimeToSend(imported)).toEqual({});
  });

  /**
   * The sequence is what orders photographs on the office's report, so an
   * import following a walk has to continue it rather than restart.
   */
  it('numbers them after the photographs the area already has', async () => {
    const outcome = await importFromGallery({
      ...input,
      existingPhotoCount: 4,
      picker: picker({ canceled: false, assets: [asset('a.jpg'), asset('b.jpg')] }),
    });

    expect(expectImported(outcome).map((snapshot) => snapshot.sequenceNumber)).toEqual([5, 6]);
  });

  /** Due now: the review window exists to catch a test frame, and nobody picks one. */
  it('is due to upload immediately', async () => {
    const outcome = await importFromGallery({
      ...input,
      picker: picker({ canceled: false, assets: [asset('a.jpg')] }),
    });

    const [imported] = expectImported(outcome);
    expect(imported.nextAttemptAt).toBeUndefined();
  });

  it('takes no more than the limit, however many were selected', async () => {
    const outcome = await importFromGallery({
      ...input,
      picker: picker({
        canceled: false,
        assets: Array.from({ length: GALLERY_IMPORT_LIMIT + 5 }, (_, index) =>
          asset(`${index}.jpg`),
        ),
      }),
    });

    expect(expectImported(outcome)).toHaveLength(GALLERY_IMPORT_LIMIT);
  });

  /**
   * The job's filters, stacked, are one photograph (the office, 2026-09-29),
   * and it shows the sizes printed on them.
   */
  it('asks for one photograph of labels when the filter change picks from the gallery', async () => {
    let asked: Record<string, unknown> = {};
    const outcome = await importFromGallery({
      ...input,
      single: true,
      captureType: 'SERIAL_OR_LABEL',
      picker: {
        requestMediaLibraryPermissionsAsync: async () => ({ granted: true }),
        launchImageLibraryAsync: async (options: Record<string, unknown>) => {
          asked = options;
          return { canceled: false, assets: [asset('stack.jpg'), asset('extra.jpg')] };
        },
      } as never,
    });

    expect(asked).toMatchObject({ allowsMultipleSelection: false, selectionLimit: 1 });
    const photographs = expectImported(outcome);
    expect(photographs).toHaveLength(1);
    expect(photographs[0]).toMatchObject({ captureType: 'SERIAL_OR_LABEL', captureSource: 'GALLERY_IMPORT' });
  });

  /** Closing the picker is a decision, not a problem: nothing is said about it. */
  it('says nothing when the technician closes the picker', async () => {
    const outcome = await importFromGallery({ ...input, picker: picker({ canceled: true }) });

    expect(outcome).toEqual({ status: 'CANCELLED' });
  });

  /** The one outcome with something for the technician to do. */
  it('reports a refused library separately', async () => {
    const outcome = await importFromGallery({
      ...input,
      picker: picker({ canceled: true }, false),
    });

    expect(outcome).toEqual({ status: 'DENIED' });
  });
});

/**
 * The office, 2026-09-22: "this request is only applicable for occupied and
 * HVAC inspection for now". Those are the two the request came from.
 *
 * Move-in and move-out being off is a decision, not an oversight: they are the
 * two a comparison is built from area by area, and a photograph whose moment
 * and place nobody can vouch for is a different kind of evidence there. This
 * test is what makes widening it deliberate.
 */
describe('which visits offer the gallery', () => {
  it('offers it on an occupied and an HVAC visit', () => {
    expect(inspectionAllowsGalleryImport('OCCUPIED')).toBe(true);
    expect(inspectionAllowsGalleryImport('HVAC')).toBe(true);
  });

  it('does not offer it anywhere else', () => {
    for (const type of ['MOVE_IN', 'MOVE_OUT', 'BACK_TO_MARKET', 'ROOF', 'AC_FILTER_DELIVERY'])
      expect(inspectionAllowsGalleryImport(type)).toBe(false);
    expect(inspectionAllowsGalleryImport(null)).toBe(false);
    expect(inspectionAllowsGalleryImport(undefined)).toBe(false);
  });
});

import { InspectionType } from '@prisma/client';

import { extractPhotos } from '../src/admin/inspection-import/inspect-cloud-pdf';
import type { ImportedArea, ImportedReport } from '../src/admin/inspection-import/inspect-cloud-report';
import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';
import type { AuthenticatedUser } from '../src/common/auth';
import { ZERO_EVIDENCE } from './support/prisma-evidence';

/**
 * Attaching the report's areas to the inspection.
 *
 * `InspectionArea` is unique on (inspectionId, propertyAreaId) and
 * `resolveArea` deliberately reuses a room whose *normalised* name matches, so
 * the room a pass is about is not guaranteed to be one the inspection does not
 * already hold. Attaching it has to be idempotent, because the cost of a
 * unique violation is not one lost area: the write runs inside a transaction,
 * so a single clash rolls back every area, response and photograph the import
 * had written, and the console reports a failure with nothing to show for it.
 */

// The photographs come out of a real PDF and these tests are about the rows
// written beside them, so the reader is mocked and a source file can be empty.
jest.mock('../src/admin/inspection-import/inspect-cloud-pdf', () => ({
  readPages: jest.fn().mockResolvedValue([]),
  extractPhotos: jest.fn().mockReturnValue([]),
  countPhotosPerPage: jest.fn().mockResolvedValue([]),
}));

const photosInFile = extractPhotos as jest.MockedFunction<typeof extractPhotos>;

const user = {
  id: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
} as AuthenticatedUser;

const INSPECTION_ID = '00000000-0000-4000-8000-000000000003';
const PROPERTY_ID = '00000000-0000-4000-8000-000000000004';
const KITCHEN_ID = '00000000-0000-4000-8000-000000000005';

const building = {
  id: PROPERTY_ID,
  name: '17307 Nordway',
  addressLine1: '17307 Nordway Dr',
  city: 'Houston',
  state: 'TX',
  postalCode: '77070',
};

interface AreaRow {
  id: string;
  propertyId: string;
  name: string;
  archivedAt: Date | null;
}
interface AttachedRow {
  id: string;
  inspectionId: string;
  propertyAreaId: string;
  completionStatus: string;
  completedAt: Date | null;
}
interface ItemRow {
  id: string;
  propertyAreaId: string;
  label: string;
  archivedAt: Date | null;
}
interface ResponseRow {
  inspectionAreaId: string;
  checklistItemId: string;
}
interface PhotoRow {
  inspectionId: string;
  inspectionAreaId: string;
  label: string | null;
}

/**
 * Enough of Prisma to run the commit, including the constraint under test.
 *
 * The unique pair is enforced rather than assumed, and `$transaction` restores
 * what it started with when the work throws. Without both, "the import
 * survives" would be a claim about a mock rather than about the code.
 */
function database(seed: { areas?: AreaRow[] } = {}) {
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

  let rows = {
    areas: [...(seed.areas ?? [])],
    attached: [] as AttachedRow[],
    items: [] as ItemRow[],
    responses: [] as ResponseRow[],
    photos: [] as PhotoRow[],
    siblings: [] as string[],
    audit: [] as Array<Record<string, unknown>>,
  };
  const snapshot = () => ({
    areas: rows.areas.map((row) => ({ ...row })),
    attached: rows.attached.map((row) => ({ ...row })),
    items: rows.items.map((row) => ({ ...row })),
    responses: rows.responses.map((row) => ({ ...row })),
    photos: rows.photos.map((row) => ({ ...row })),
    siblings: [...rows.siblings],
    audit: rows.audit.map((row) => ({ ...row })),
  });

  const attachedPair = (inspectionId: string, propertyAreaId: string) =>
    rows.attached.find(
      (row) => row.inspectionId === inspectionId && row.propertyAreaId === propertyAreaId,
    );

  /** What Postgres raises on the unique index, in the shape Prisma reports it. */
  const uniqueViolation = () =>
    Object.assign(
      new Error('Unique constraint failed on the fields: (`inspectionId`,`propertyAreaId`)'),
      { code: 'P2002' },
    );

  const tx = {
    property: { upsert: jest.fn().mockResolvedValue({}) },
    inspection: {
      update: jest.fn().mockResolvedValue({}),
      /**
       * The property's other inspections that hold no rooms.
       *
       * `areas: { none: {} }` is the condition that matters and the one modelled
       * here: a sibling stops being eligible the moment it has a row, so an
       * inspection with a snapshot of its own is never extended.
       */
      findMany: jest.fn(() =>
        Promise.resolve(
          rows.siblings
            .filter((id) => !rows.attached.some((row) => row.inspectionId === id))
            .map((id) => ({ id })),
        ),
      ),
    },
    propertyArea: {
      findMany: jest.fn(({ where }: { where: { propertyId: string } }) =>
        Promise.resolve(
          rows.areas
            .filter((row) => row.propertyId === where.propertyId && row.archivedAt === null)
            .map((row) => ({ id: row.id, name: row.name })),
        ),
      ),
      create: jest.fn(({ data }: { data: { propertyId: string; name: string } }) => {
        const row = {
          id: nextId('area'),
          propertyId: data.propertyId,
          name: data.name,
          archivedAt: null,
        };
        rows.areas.push(row);
        return Promise.resolve({ id: row.id, name: row.name });
      }),
    },
    inspectionArea: {
      // Kept, and kept strict. The import no longer calls it, and a change back
      // to an unconditional create has to fail here rather than pass quietly.
      create: jest.fn(({ data }: { data: AttachedRow }) => {
        if (attachedPair(data.inspectionId, data.propertyAreaId)) throw uniqueViolation();
        const row = { ...data, id: nextId('attached') };
        rows.attached.push(row);
        return Promise.resolve({ id: row.id });
      }),
      /**
       * Rooms the report did not mention, which the import drops.
       *
       * `media: { none: {} }` is modelled by there being no recordings in this
       * fixture at all -- these tests are about rows, and an area holding a
       * video is covered where that rule is written.
       */
      findMany: jest.fn(
        ({ where }: { where: { inspectionId: string; id: { notIn: string[] } } }) =>
          Promise.resolve(
            rows.attached
              .filter(
                (row) =>
                  row.inspectionId === where.inspectionId && !where.id.notIn.includes(row.id),
              )
              .map((row) => ({ id: row.id })),
          ),
      ),
      createMany: jest.fn(
        ({ data }: { data: Array<{ inspectionId: string; propertyAreaId: string }> }) => {
          let created = 0;
          for (const row of data) {
            // skipDuplicates, which is the unique pair doing the real work.
            if (attachedPair(row.inspectionId, row.propertyAreaId)) continue;
            rows.attached.push({
              ...row,
              id: nextId('attached'),
              completionStatus: 'PENDING',
              completedAt: null,
            });
            created += 1;
          }
          return Promise.resolve({ count: created });
        },
      ),
      deleteMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) => {
        const before = rows.attached.length;
        rows.attached = rows.attached.filter((row) => !where.id.in.includes(row.id));
        // Cascades, as the schema does: a room's photographs and grades go
        // with it. Modelled, because an import that left them behind would
        // orphan evidence and this fixture would not notice.
        rows.photos = rows.photos.filter(
          (photo) => !where.id.in.includes(photo.inspectionAreaId),
        );
        rows.responses = rows.responses.filter(
          (response) => !where.id.in.includes(response.inspectionAreaId),
        );
        return Promise.resolve({ count: before - rows.attached.length });
      }),
      upsert: jest.fn(
        ({
          where,
          update,
          create,
        }: {
          where: {
            inspectionId_propertyAreaId: { inspectionId: string; propertyAreaId: string };
          };
          update: { completionStatus: string; completedAt: Date };
          create: AttachedRow;
        }) => {
          const key = where.inspectionId_propertyAreaId;
          const existing = attachedPair(key.inspectionId, key.propertyAreaId);
          if (existing) {
            Object.assign(existing, update);
            return Promise.resolve({ id: existing.id });
          }
          const row = { ...create, id: nextId('attached') };
          rows.attached.push(row);
          return Promise.resolve({ id: row.id });
        },
      ),
    },
    areaChecklistItem: {
      findFirst: jest.fn(({ where }: { where: { propertyAreaId: string; label: string } }) =>
        Promise.resolve(
          rows.items.find(
            (row) =>
              row.propertyAreaId === where.propertyAreaId &&
              row.label === where.label &&
              row.archivedAt === null,
          ) ?? null,
        ),
      ),
      count: jest.fn(({ where }: { where: { propertyAreaId: string } }) =>
        Promise.resolve(
          rows.items.filter((row) => row.propertyAreaId === where.propertyAreaId).length,
        ),
      ),
      create: jest.fn(({ data }: { data: { propertyAreaId: string; label: string } }) => {
        const row = {
          id: nextId('item'),
          propertyAreaId: data.propertyAreaId,
          label: data.label,
          archivedAt: null,
        };
        rows.items.push(row);
        return Promise.resolve({ id: row.id });
      }),
    },
    inspectionAreaChecklistResponse: {
      // Two report rows can resolve to one checklist item, so the importer
      // looks before it writes. Nothing is present in these fixtures, which is
      // the ordinary path.
      findUnique: jest.fn(() => Promise.resolve(null)),
      update: jest.fn(() => Promise.resolve({})),
      create: jest.fn(({ data }: { data: ResponseRow }) => {
        rows.responses.push(data);
        return Promise.resolve({});
      }),
      deleteMany: jest.fn(
        ({ where }: { where: { inspectionArea: { inspectionId: string } } }) => {
          const of = new Set(
            rows.attached
              .filter((row) => row.inspectionId === where.inspectionArea.inspectionId)
              .map((row) => row.id),
          );
          const before = rows.responses.length;
          rows.responses = rows.responses.filter((row) => !of.has(row.inspectionAreaId));
          return Promise.resolve({ count: before - rows.responses.length });
        },
      ),
    },
    inspectionPhoto: {
      create: jest.fn(({ data }: { data: PhotoRow }) => {
        rows.photos.push(data);
        return Promise.resolve({});
      }),
      deleteMany: jest.fn(({ where }: { where: { inspectionId: string } }) => {
        const before = rows.photos.length;
        rows.photos = rows.photos.filter((row) => row.inspectionId !== where.inspectionId);
        return Promise.resolve({ count: before - rows.photos.length });
      }),
    },
    // Both restrict deletion of an area in the real schema, so the import
    // clears them itself. Empty here, and present so a missing delegate fails
    // loudly rather than at the first fixture that happens to have one.
    inspectionAreaStatusHistory: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    mediaUploadSession: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    auditLog: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        rows.audit.push(data);
        return Promise.resolve({});
      }),
    },
  };

  return {
    rows: () => rows,
    tx,
    /** A room already on some other inspection, which makes it ineligible. */
    attachTo: (inspectionId: string, propertyAreaId: string) => {
      rows.attached.push({
        id: nextId('attached'),
        inspectionId,
        propertyAreaId,
        completionStatus: 'PENDING',
        completedAt: null,
      });
    },
    /** Another inspection at the same property, holding no rooms of its own. */
    sibling: (id: string) => {
      rows.siblings.push(id);
    },
    /** A photograph already on the inspection, from whatever wrote it first. */
    record: (photo: { inspectionAreaId: string; label: string | null }) => {
      rows.photos.push({ ...photo, inspectionId: INSPECTION_ID });
    },
    /** A room attached to the inspection by somebody else, after this point. */
    attach: (propertyAreaId: string) => {
      rows.attached.push({
        id: nextId('attached'),
        inspectionId: INSPECTION_ID,
        propertyAreaId,
        completionStatus: 'PENDING',
        completedAt: null,
      });
    },
    transaction: jest.fn(async (run: (client: typeof tx) => Promise<unknown>) => {
      const before = snapshot();
      try {
        return await run(tx);
      } catch (error) {
        rows = before;
        throw error;
      }
    }),
  };
}

const item = (sourceLabel: string) => ({
  sourceLabel,
  matchedLabel: sourceLabel,
  matchScore: 1,
  isClean: true,
  isUndamaged: true,
  isWorking: null,
  comment: null,
  assessed: true,
  page: 1,
});

const area = (name: string, labels: string[], captions: string[] = []): ImportedArea => ({
  name,
  startedOnPage: 1,
  items: labels.map(item),
  photos: captions.map((caption, index) => ({
    caption,
    matchedLabel: null,
    takenAt: null,
    page: 1,
    index,
  })),
});

const reportOf = (areas: ImportedArea[]): ImportedReport => ({
  inspector: 'A. Inspector',
  template: 'Move In',
  reportDate: 'JAN-02-2026',
  pages: 1,
  areas,
  unrecognised: [],
});

/**
 * The commit runs after the response is sent, so the job row is the only place
 * it reports to — which is what these tests wait on and read the outcome from.
 */
function build(db: ReturnType<typeof database>, areas: ImportedArea[]) {
  let settle: (data: Record<string, unknown>) => void = () => undefined;
  const settled = new Promise<Record<string, unknown>>((resolve) => {
    settle = resolve;
  });

  const prisma = {
    ...ZERO_EVIDENCE,
    inspectionImportJob: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'job-1',
        organizationId: user.organizationId,
        inspectionId: INSPECTION_ID,
        fingerprint: 'f'.repeat(64),
        status: 'COMPLETED',
        committedAt: null,
        output: reportOf(areas),
      }),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        settle(data);
        return Promise.resolve({});
      }),
    },
    inspection: {
      findFirst: jest.fn().mockResolvedValue({
        id: INSPECTION_ID,
        inspectionType: InspectionType.MOVE_IN,
        propertywareBuildingId: building.id,
        propertywareBuilding: building,
        // What the check sees. A room attached after this answer is the case
        // the upsert exists for, and `db.attach` is when that happens.
        _count: { areas: 0 },
      }),
    },
    auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
    // Read outside the transaction, so the objects behind these rows can be
    // dropped after it commits rather than before it might roll back.
    inspectionPhoto: {
      findMany: jest.fn(() =>
        Promise.resolve(db.rows().photos.map((photo, index) => ({ storageKey: `old-${index}` }))),
      ),
    },
    $transaction: db.transaction,
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
  return { service, prisma, storage, settled };
}

const jpeg = (width: number) => ({
  bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  width,
  height: 100,
});

beforeEach(() => {
  photosInFile.mockReturnValue([]);
});

describe('an import over an inspection that already holds rooms', () => {
  /**
   * The property whose layout carried two rooms that were never real.
   *
   * 10051 Spotted Horse Dr had test areas invented on its layout, snapshotted
   * onto every inspection there. They could not be deleted from the property
   * while an inspection referenced them, and the inspection could not be
   * imported over because it was "not empty" -- so they were permanent. A
   * report that does not mention a room is now the office saying that room is
   * not part of this walkthrough.
   */
  const GARAGE_ID = '00000000-0000-4000-8000-000000000006';
  const seeded = () => {
    const db = database({
      areas: [
        { id: KITCHEN_ID, propertyId: PROPERTY_ID, name: 'Kitchen', archivedAt: null },
        { id: GARAGE_ID, propertyId: PROPERTY_ID, name: 'Test Area', archivedAt: null },
      ],
    });
    db.attach(KITCHEN_ID);
    db.attach(GARAGE_ID);
    return db;
  };

  it('drops a room the new report does not mention', async () => {
    const db = seeded();
    const { service, settled } = build(db, [area('Kitchen', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().attached).toHaveLength(1);
    expect(db.rows().attached[0]).toMatchObject({ propertyAreaId: KITCHEN_ID });
  });

  it('clears the photographs and grades it is replacing', async () => {
    // Not merged. A second import stacking its photographs on top of the first
    // is what "replace" has to rule out, and a stale defect surviving into a
    // clean report is the one that would reach a tenant: a move-out is argued
    // against these grades.
    const db = seeded();
    db.record({ inspectionAreaId: 'attached-1', label: 'from the old report' });
    const { service, settled } = build(db, [area('Kitchen', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().photos).toHaveLength(0);
    expect(db.rows().responses.every((row) => row.inspectionAreaId === 'attached-1')).toBe(true);
  });

  it('counts what it replaced into the audit row', async () => {
    // The import writes through `finalizedAt`, which freezes evidence
    // everywhere else. What makes that acceptable is that the replacement is
    // answerable afterwards rather than silent.
    const db = seeded();
    db.record({ inspectionAreaId: 'attached-1', label: 'from the old report' });
    const { service, settled } = build(db, [area('Kitchen', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().audit[0]).toMatchObject({
      action: 'INSPECTION_REPORT_IMPORTED',
      metadata: expect.objectContaining({ replaced: expect.objectContaining({ areas: 1 }) }),
    });
  });

  it('deletes the superseded objects only after the commit succeeds', async () => {
    const db = seeded();
    db.record({ inspectionAreaId: 'attached-1', label: 'from the old report' });
    const { service, storage, settled } = build(db, [area('Kitchen', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(storage.delete).toHaveBeenCalledWith('old-0');
  });
});

describe('the rooms an import establishes for the rest of the property', () => {
  /**
   * 21223 Harbor Shore Dr, reported from the console.
   *
   * A move-in was imported and filled in properly. The occupied inspection at
   * the same address still read "0 areas — No areas match this filter", with an
   * Add area button and nothing to add, because `InspectionArea` is a snapshot
   * taken at creation and that inspection was created before the property had
   * an approved layout to snapshot.
   *
   * Move-in, occupied and move-out walk the same rooms — the office's rule —
   * so the layout one of them establishes is the layout for all of them.
   */
  const OCCUPIED_ID = '00000000-0000-4000-8000-000000000007';

  it('hands them to an inspection at the same property that has none', async () => {
    const db = database();
    db.sibling(OCCUPIED_ID);
    const { service, settled } = build(db, [area('Kitchen', ['Walls']), area('Garage', ['Floor'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    const shared = db.rows().attached.filter((row) => row.inspectionId === OCCUPIED_ID);
    expect(shared).toHaveLength(2);
    // The same property areas, not copies: a comparison matches a move-out to
    // its baseline through these ids, so a parallel set of rooms with the same
    // names would compare against nothing.
    expect(new Set(shared.map((row) => row.propertyAreaId))).toEqual(
      new Set(
        db
          .rows()
          .attached.filter((row) => row.inspectionId === INSPECTION_ID)
          .map((row) => row.propertyAreaId),
      ),
    );
  });

  it('leaves an inspection that already holds rooms alone', async () => {
    // It has a snapshot, and a snapshot is not ours to extend. This fills in
    // one that was never taken; it does not keep a record in sync with a floor
    // plan, which is exactly what an inspection is not.
    const db = database();
    db.sibling(OCCUPIED_ID);
    db.attachTo(OCCUPIED_ID, 'its-own-room');
    const { service, settled } = build(db, [area('Kitchen', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().attached.filter((row) => row.inspectionId === OCCUPIED_ID)).toHaveLength(1);
  });

  it('does not hand on a room the report dropped', async () => {
    // The sweep removes rooms the new report does not mention. Sharing the
    // property's whole approved layout instead of the report's rooms would put
    // those straight back onto a sibling — the Spotted Horse test areas
    // reappearing one inspection over.
    const db = database({
      areas: [
        { id: KITCHEN_ID, propertyId: PROPERTY_ID, name: 'Kitchen', archivedAt: null },
        { id: '00000000-0000-4000-8000-000000000008', propertyId: PROPERTY_ID, name: 'Test Area', archivedAt: null },
      ],
    });
    db.attach(KITCHEN_ID);
    db.attach('00000000-0000-4000-8000-000000000008');
    db.sibling(OCCUPIED_ID);
    const { service, settled } = build(db, [area('Kitchen', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    const shared = db.rows().attached.filter((row) => row.inspectionId === OCCUPIED_ID);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({ propertyAreaId: KITCHEN_ID });
  });

  it('says so in the audit row', async () => {
    // It writes to records nobody named in the request, so the audit has to be
    // able to answer how far the import reached.
    const db = database();
    db.sibling(OCCUPIED_ID);
    const { service, settled } = build(db, [area('Kitchen', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().audit[0]).toMatchObject({
      metadata: expect.objectContaining({ sharedLayoutWith: 1 }),
    });
  });
});

describe('attaching a report area to the inspection', () => {
  it('creates the area when the inspection is not already holding it', async () => {
    // The ordinary case, and the one that must not change: an empty inspection
    // ends up with the room attached and marked walked.
    const db = database();
    const { service, settled } = build(db, [area('Living Room', ['Walls'])]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().attached).toHaveLength(1);
    expect(db.rows().attached[0]).toMatchObject({
      inspectionId: INSPECTION_ID,
      completionStatus: 'COMPLETED',
    });
    expect(db.rows().attached[0]!.completedAt).toBeInstanceOf(Date);
  });

  it('fills in a room the inspection already holds instead of losing the import', async () => {
    // The property has a Kitchen from an approved layout, and the inspection
    // was born holding it. `resolveArea` matches "KITCHEN" to that same room,
    // so the report's pass over it lands on a pair that already exists.
    const db = database({
      areas: [{ id: KITCHEN_ID, propertyId: PROPERTY_ID, name: 'Kitchen', archivedAt: null }],
    });
    const { service, storage, settled } = build(db, [area('KITCHEN', ['Cabinets', 'Countertops'])]);
    // Attached between the check and the write. `requireSeedableInspection`
    // has already answered "empty", and `storePhotos` is about to spend
    // minutes writing objects — the window the emptiness check cannot cover.
    storage.get.mockImplementation(() => {
      db.attach(KITCHEN_ID);
      return Promise.resolve(Buffer.alloc(0));
    });

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    // Filled in, not duplicated, and not rolled back.
    expect(db.rows().attached).toHaveLength(1);
    expect(db.rows().attached[0]).toMatchObject({
      propertyAreaId: KITCHEN_ID,
      completionStatus: 'COMPLETED',
    });
    expect(db.rows().attached[0]!.completedAt).toBeInstanceOf(Date);
    // And the report's grades hang from the room that was already there,
    // rather than from a second copy of it.
    expect(db.rows().responses).toHaveLength(2);
    expect(new Set(db.rows().responses.map((row) => row.inspectionAreaId))).toEqual(
      new Set([db.rows().attached[0]!.id]),
    );
  });

  it('merges two report areas that name the same room', async () => {
    // No race needed for this one: the report itself names the room twice — a
    // table continued under a repeated title, or a model that split one room
    // in two — and `resolveArea` hands back the same room for both.
    const db = database();
    photosInFile.mockReturnValue([jpeg(101), jpeg(102)]);
    const { service, settled } = build(db, [
      area('Kitchen', ['Cabinets'], ['Cabinet door']),
      area('KITCHEN ', ['Countertops'], ['Counter chip']),
    ]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().areas).toHaveLength(1);
    expect(db.rows().attached).toHaveLength(1);
    // Both passes' evidence on the one room, so nothing the second pass
    // recorded is dropped for having arrived under a name already seen.
    const attachedId = db.rows().attached[0]!.id;
    expect(db.rows().responses.map((row) => row.inspectionAreaId)).toEqual([attachedId, attachedId]);
    expect(db.rows().photos.map((row) => row.label)).toEqual(['Cabinet door', 'Counter chip']);
    expect(db.rows().photos.map((row) => row.inspectionAreaId)).toEqual([attachedId, attachedId]);
  });

  it('still writes every other area when one room is repeated', async () => {
    // What the unique violation used to cost. The clash is in the middle, so a
    // rollback would take the area before it as well as the one after.
    const db = database();
    const { service, settled } = build(db, [
      area('Living Room', ['Walls']),
      area('Kitchen', ['Cabinets']),
      area('Kitchen', ['Countertops']),
      area('Garage', ['Door']),
    ]);

    await service.commit(user, 'job-1');
    await expect(settled).resolves.toMatchObject({ errorCode: null });

    expect(db.rows().areas.map((row) => row.name)).toEqual(['Living Room', 'Kitchen', 'Garage']);
    expect(db.rows().attached).toHaveLength(3);
    expect(db.rows().responses).toHaveLength(4);
  });
});

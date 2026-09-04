import { InspectionType } from '@prisma/client';

import { extractPhotos } from '../src/admin/inspection-import/inspect-cloud-pdf';
import type { ImportedArea, ImportedReport } from '../src/admin/inspection-import/inspect-cloud-report';
import { InspectionImportService } from '../src/admin/inspection-import/inspection-import.service';
import type { AuthenticatedUser } from '../src/common/auth';

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
    audit: [] as Array<Record<string, unknown>>,
  };
  const snapshot = () => ({
    areas: rows.areas.map((row) => ({ ...row })),
    attached: rows.attached.map((row) => ({ ...row })),
    items: rows.items.map((row) => ({ ...row })),
    responses: rows.responses.map((row) => ({ ...row })),
    photos: rows.photos.map((row) => ({ ...row })),
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
    inspection: { update: jest.fn().mockResolvedValue({}) },
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
      create: jest.fn(({ data }: { data: ResponseRow }) => {
        rows.responses.push(data);
        return Promise.resolve({});
      }),
    },
    inspectionPhoto: {
      create: jest.fn(({ data }: { data: PhotoRow }) => {
        rows.photos.push(data);
        return Promise.resolve({});
      }),
    },
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
    $transaction: db.transaction,
  };
  const storage = {
    get: jest.fn().mockResolvedValue(Buffer.alloc(0)),
    putBytes: jest.fn().mockResolvedValue(undefined),
    providerName: jest.fn().mockReturnValue('local'),
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

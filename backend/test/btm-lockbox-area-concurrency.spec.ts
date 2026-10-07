import 'reflect-metadata';

import { InspectionType } from '@prisma/client';
import { UserRole } from '@texasrenters/shared';

import {
  type InspectionCreationClient,
  type InspectionPlan,
  insertInspection,
} from '../src/admin/inspection-creation';
import type { AuthenticatedUser } from '../src/common/auth';
import { TechnicianService } from '../src/technician/technician.service';

/**
 * Two requests at once must find-or-create an area on no floor once, not twice.
 *
 * `PropertyArea`'s unique index cannot stop the second: these areas have no
 * floor, and Postgres counts NULLs as distinct. Two opens of the same old
 * back-to-market job -- two phones, a retry, a prefetch racing the screen --
 * both looked, both found nothing, and the job had two required "Sign, supra
 * and lockbox" areas. An advisory lock now serializes the find-or-create.
 *
 * The database below is just real enough for that race. A transaction's writes
 * are seen by others only once it commits, as under READ COMMITTED;
 * `pg_advisory_xact_lock` waits until its holder's transaction ends, and is
 * free to take again inside the same one; the unique index rejects a
 * duplicate only when no column is NULL. Every call yields first, as a round
 * trip would, so two requests interleave. Run against the code before the
 * lock, the first case here made two areas.
 */

const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const LOCKBOX = 'Sign, supra and lockbox';

type PropertyAreaRow = {
  id: string;
  propertyId: string;
  unitId: string | null;
  floorId: string | null;
  name: string;
};
type InspectionAreaRow = { id: string; inspectionId: string; propertyAreaId: string };
type Pending = {
  propertyAreas: PropertyAreaRow[];
  inspectionAreas: InspectionAreaRow[];
  locks: Map<string, () => void>;
};

function database(rooms: { inspectionId: string; name: string }[] = []) {
  const propertyAreas: PropertyAreaRow[] = [];
  const inspectionAreas: InspectionAreaRow[] = [];
  /** Per lock key, settled when the last transaction to ask for it has ended. */
  const lockQueues = new Map<string, Promise<void>>();
  let ids = 0;
  const roundTrip = () => new Promise<void>((resolve) => setImmediate(resolve));

  for (const room of rooms) {
    const id = `area-${room.name.toLowerCase()}`;
    if (!propertyAreas.some((area) => area.id === id))
      propertyAreas.push({ id, propertyId: 'building-1', unitId: null, floorId: 'floor-1', name: room.name });
    inspectionAreas.push({ id: `room-${++ids}`, inspectionId: room.inspectionId, propertyAreaId: id });
  }

  /** What one connection sees: everything committed, and its own transaction's writes. */
  function client(own: Pending | null) {
    const areas = () => [...propertyAreas, ...(own?.propertyAreas ?? [])];
    const rows = () => [...inspectionAreas, ...(own?.inspectionAreas ?? [])];
    const write = () => {
      if (!own) throw new Error('This double only writes inside a transaction.');
      return own;
    };
    return {
      $executeRaw: async (sql: TemplateStringsArray, ...values: unknown[]) => {
        await roundTrip();
        if (!sql.join('?').includes('pg_advisory_xact_lock')) throw new Error(`Unexpected SQL: ${sql.join('?')}`);
        // Outside a transaction the lock would be released at once, and protect nothing.
        const mine = write();
        const key = String(values[0]);
        if (mine.locks.has(key)) return 1;
        const before = lockQueues.get(key) ?? Promise.resolve();
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        lockQueues.set(key, before.then(() => held));
        mine.locks.set(key, release);
        await before;
        return 1;
      },
      areaChecklistItem: { createMany: async () => (await roundTrip(), { count: 0 }) },
      property: { upsert: async () => (await roundTrip(), {}) },
      propertyArea: {
        findFirst: async ({ where }: { where: Omit<PropertyAreaRow, 'id'> }) => {
          await roundTrip();
          const found = areas().find(
            (area) =>
              area.propertyId === where.propertyId &&
              area.unitId === where.unitId &&
              area.floorId === where.floorId &&
              area.name === where.name,
          );
          return found ? { id: found.id } : null;
        },
        findMany: async ({ where }: { where: { id: { in: string[] } } }) => {
          await roundTrip();
          return areas()
            .filter((area) => where.id.in.includes(area.id))
            .map((area) => ({ name: area.name }));
        },
        create: async ({ data }: { data: Omit<PropertyAreaRow, 'id'> }) => {
          await roundTrip();
          const key = [data.propertyId, data.unitId, data.floorId, data.name];
          const clash = areas().some(
            (area) =>
              area.propertyId === data.propertyId &&
              area.unitId === data.unitId &&
              area.floorId === data.floorId &&
              area.name === data.name,
          );
          // @@unique([propertyId, unitId, floorId, name]): a NULL anywhere never clashes.
          if (clash && key.every((value) => value !== null)) throw new Error('P2002');
          const row = {
            id: `area-${++ids}`,
            propertyId: data.propertyId,
            unitId: data.unitId,
            floorId: data.floorId,
            name: data.name,
          };
          write().propertyAreas.push(row);
          return { id: row.id };
        },
      },
      inspectionArea: {
        findMany: async ({ where, orderBy }: { where: { inspectionId: string }; orderBy?: unknown }) => {
          await roundTrip();
          // The ordered query is the list the phone is sent, not what is under test.
          if (orderBy) return [];
          return rows()
            .filter((row) => row.inspectionId === where.inspectionId)
            .map((row) => ({ propertyArea: { name: areas().find((area) => area.id === row.propertyAreaId)!.name } }));
        },
        upsert: async ({
          where: { inspectionId_propertyAreaId: key },
        }: {
          where: { inspectionId_propertyAreaId: { inspectionId: string; propertyAreaId: string } };
        }) => {
          await roundTrip();
          const found = rows().find(
            (row) => row.inspectionId === key.inspectionId && row.propertyAreaId === key.propertyAreaId,
          );
          if (found) return { id: found.id };
          const row = { id: `room-${++ids}`, ...key };
          write().inspectionAreas.push(row);
          return { id: row.id };
        },
      },
      inspection: {
        create: async ({ data }: { data: { areas: { create: { propertyAreaId: string }[] } } }) => {
          await roundTrip();
          const inspectionId = `inspection-${++ids}`;
          for (const { propertyAreaId } of data.areas.create)
            write().inspectionAreas.push({ id: `room-${++ids}`, inspectionId, propertyAreaId });
          return { id: inspectionId };
        },
      },
    };
  }

  async function $transaction<T>(work: (tx: ReturnType<typeof client>) => Promise<T>): Promise<T> {
    const own: Pending = { propertyAreas: [], inspectionAreas: [], locks: new Map() };
    try {
      const result = await work(client(own));
      // Commit, and only then let the next holder of a lock in.
      propertyAreas.push(...own.propertyAreas);
      inspectionAreas.push(...own.inspectionAreas);
      return result;
    } finally {
      for (const release of own.locks.values()) release();
    }
  }

  return {
    prisma: { ...client(null), $transaction },
    lockboxAreas: () => propertyAreas.filter((area) => area.name === LOCKBOX),
    roomsOf: (inspectionId: string) =>
      inspectionAreas
        .filter((row) => row.inspectionId === inspectionId)
        .map((row) => propertyAreas.find((area) => area.id === row.propertyAreaId)!),
  };
}

const technician: AuthenticatedUser = {
  id: '10000000-0000-4000-8000-000000000004',
  authUserId: 'auth-technician',
  organizationId: ORGANIZATION,
  displayName: 'Field Technician',
  roles: [UserRole.INSPECTION_TECHNICIAN],
  permissions: [],
  mustChangePassword: false,
  principalType: 'USER',
};

function technicianService(db: ReturnType<typeof database>, { inspectionType = 'BACK_TO_MARKET', status = 'IN_PROGRESS' } = {}) {
  const service = new TechnicianService(db.prisma as never, {} as never, {} as never, {} as never);
  jest.spyOn(service as never, 'assignedInspection').mockImplementation((async (_user: unknown, id: string) => ({
    id,
    inspectionType,
    status,
    propertywareBuilding: {
      id: 'building-1',
      name: 'Building 1',
      addressLine1: '1 Test St',
      city: 'Houston',
      state: 'TX',
      postalCode: '77001',
    },
    propertywareUnit: null,
  })) as never);
  return service;
}

describe('a back-to-market job booked before the area was built in, opened twice at once', () => {
  it('is given one sign, supra and lockbox, not two', async () => {
    const db = database([{ inspectionId: 'inspection-1', name: 'Kitchen' }]);
    const service = technicianService(db);

    await Promise.all([service.rooms(technician, 'inspection-1'), service.rooms(technician, 'inspection-1')]);

    expect(db.lockboxAreas()).toHaveLength(1);
    expect(db.roomsOf('inspection-1').map((area) => area.name)).toEqual(['Kitchen', LOCKBOX]);
  });

  it('shares the one area with another job at the same house opened at the same moment', async () => {
    const db = database([
      { inspectionId: 'inspection-1', name: 'Kitchen' },
      { inspectionId: 'inspection-2', name: 'Kitchen' },
    ]);
    const service = technicianService(db);

    await Promise.all([service.rooms(technician, 'inspection-1'), service.rooms(technician, 'inspection-2')]);

    const [area] = db.lockboxAreas();
    expect(db.lockboxAreas()).toHaveLength(1);
    expect(db.roomsOf('inspection-1')).toContain(area);
    expect(db.roomsOf('inspection-2')).toContain(area);
  });
});

describe('two back-to-market visits at the same house booked at once', () => {
  it('share one sign, supra and lockbox', async () => {
    const db = database([{ inspectionId: 'earlier', name: 'Kitchen' }]);
    const plan = {
      organizationId: ORGANIZATION,
      inspectionType: InspectionType.BACK_TO_MARKET,
      property: { id: 'building-1', name: 'Building 1' },
      unit: null,
      lease: null,
      baselineInspectionId: null,
      scheduledAt: new Date('2026-10-08'),
      scheduledStartAt: null,
      scheduledEndAt: null,
      technicianWillCapture: false,
      scopedAreas: [{ id: 'area-kitchen' }],
    } as unknown as InspectionPlan;
    const book = () =>
      db.prisma.$transaction((tx) =>
        insertInspection(tx as unknown as InspectionCreationClient, plan, { createdById: 'user-1' } as never),
      );

    const [first, second] = await Promise.all([book(), book()]);

    expect(db.lockboxAreas()).toHaveLength(1);
    expect(db.roomsOf(first.id).map((area) => area.name)).toEqual(['Kitchen', LOCKBOX]);
    expect(db.roomsOf(second.id).map((area) => area.name)).toEqual(['Kitchen', LOCKBOX]);
  });
});

describe('a job’s first two service photographs, taken at once', () => {
  it('are filed under one area', async () => {
    const db = database();
    const service = technicianService(db, { inspectionType: 'OCCUPIED' });

    const [first, second] = await Promise.all([
      service.serviceArea(technician, 'job-1', 'pestControl'),
      service.serviceArea(technician, 'job-1', 'pestControl'),
    ]);

    expect(first).toEqual(second);
    expect(db.roomsOf('job-1')).toHaveLength(1);
  });
});

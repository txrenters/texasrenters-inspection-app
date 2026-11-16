import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { SaveRevenueLogEntryInput } from '@texasrenters/shared';

import { SaveRevenueLogEntryDto } from '../src/admin/actual-vs-budget.controller';
import { ActualVsBudgetService } from '../src/admin/actual-vs-budget.service';
import type { AuthenticatedUser } from '../src/common/auth';

/**
 * Actual vs Budget's technician log (2026-11-17). The office: "for the cells
 * that the console already know, automate them but those that not yet, the
 * office may add them". Ids, names and addresses invented; the money is the
 * shape of one real day in the office's workbook.
 */

const ORG = '50000000-0000-4000-8000-000000000001';
const TECH = '50000000-0000-4000-8000-000000000002';
const BUILDING_A = '50000000-0000-4000-8000-0000000000a1';
const BUILDING_B = '50000000-0000-4000-8000-0000000000b1';
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);
const id = (n: number) => `50000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`;

const office: AuthenticatedUser = {
  id: '50000000-0000-4000-8000-000000000009',
  authUserId: 'auth-office',
  organizationId: ORG,
  displayName: 'Office Coordinator',
  roles: [UserRole.INSPECTION_SUPERVISOR],
  permissions: ['invoices:read', 'invoices:manage'],
  mustChangePassword: false,
  principalType: 'USER',
} as AuthenticatedUser;

const line = (name: string, totalCents: number) => ({ name, productName: name, totalCents });
const visit = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  status: 'TECHNICIAN_SUBMITTED',
  scheduledAt: day('2026-11-11'),
  scheduledStartAt: null,
  jobberJobNumber: String(20900 + n),
  jobberVisitTitle: 'Zone 2 - Q4 TBP Filter Change',
  propertywareBuildingId: BUILDING_A,
  propertywareBuilding: { addressLine1: '100 Example Way' },
  property: null,
  invoices: [] as unknown[],
  ...over,
});
/** 16:49 to 17:33 in Texas on 2026-11-11 (CST, UTC-6). */
const segment = (over: Record<string, unknown> = {}) => ({
  inspectionId: null,
  buildingId: BUILDING_B,
  startedAt: new Date('2026-11-11T22:49:00.000Z'),
  endedAt: new Date('2026-11-11T23:33:00.000Z'),
  ...over,
});

const emptyEntry = {
  address: null, workOrder: null, jobNumber: null, driveTime: null, timeBudgeted: null, estimatedBudgetCents: null,
  arrival: null, leaving: null, workComplete: null, rescheduleRequired: null, rescheduleOn: null, laborCents: null,
  serviceCallFeeCents: null, materialsCents: null, invoiceNumber: null, postedInPw: null, notes: null,
};

function database(state: { visits?: unknown[]; entries?: Record<string, unknown>[]; segments?: unknown[]; products?: unknown[] } = {}) {
  const audits: Record<string, unknown>[] = [];
  const entries = state.entries ?? [];
  const db: Record<string, unknown> = {
    organizationMember: {
      findFirst: jest.fn(async ({ where }: { where: { userProfileId: string } }) =>
        where.userProfileId === TECH ? { userProfile: { id: TECH, displayName: 'Sample Technician' } } : null),
      findMany: jest.fn(async () => [{ userProfile: { id: TECH, displayName: 'Sample Technician', isActive: true } }]),
    },
    xeroSettings: { findMany: jest.fn(async () => []) },
    inspection: {
      findMany: jest.fn(async () => state.visits ?? []),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => {
        const found = (state.visits as { id: string; scheduledAt: Date }[] | undefined)?.find((row) => row.id === where.id);
        return found ? { id: found.id, scheduledAt: found.scheduledAt, assignments: [{ technicianId: TECH }] } : null;
      }),
    },
    revenueLogEntry: {
      findMany: jest.fn(async () => entries),
      findUnique: jest.fn(async ({ where }: { where: { inspectionId: string } }) => { const found = entries.find((entry) => entry.inspectionId === where.inspectionId); return found ? { ...found } : null; }),
      findFirst: jest.fn(async ({ where }: { where: { id: string } }) => { const found = entries.find((entry) => entry.id === where.id); return found ? { ...found } : null; }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `entry-${entries.length + 1}`, createdAt: new Date(), ...emptyEntry, inspectionId: null, ...data };
        entries.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = entries.find((entry) => entry.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
      delete: jest.fn(async () => ({})),
    },
    timeSegment: { findMany: jest.fn(async () => state.segments ?? []) },
    invoiceProduct: {
      findMany: jest.fn(async () => state.products ?? []),
      findFirst: jest.fn(async () => null),
      update: jest.fn(),
    },
    auditLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => audits.push(data)) },
    $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(db)),
  };
  return { db, audits, entries };
}

const service = (db: unknown) => new ActualVsBudgetService(db as never);
const read = (db: unknown, from = '2026-11-11', to = '2026-11-11') => service(db).log(office, { technicianId: TECH, from, to });

describe('the technician log', () => {
  it('fills what the console knows: the visit, the timesheet and the invoice', async () => {
    const { db } = database({
      visits: [
        visit(1, {
          propertywareBuildingId: BUILDING_B,
          invoices: [
            { number: '8737', lines: [line('Filter Change', 7899)] },
            { number: 'INV-2993', lines: [line('Service Call', 5000), line('Capacitor', 2150)] },
          ],
        }),
      ],
      segments: [segment()],
      products: [
        { nameKey: 'service call', revenueColumn: 'SERVICE_CALL_FEE' },
        { nameKey: 'capacitor', revenueColumn: 'MATERIALS' },
      ],
    });
    const log = await read(db);
    const [row] = log.days[0]!.rows;
    expect(row).toMatchObject({
      date: '2026-11-11',
      address: '100 Example Way - Zone 2 - Q4 TBP Filter Change',
      jobNumber: '20901',
      arrival: '16:49',
      leaving: '17:33',
      actualSeconds: 44 * 60,
      workComplete: true,
      invoiceNumber: '8737/INV-2993',
      laborCents: 7899,
      serviceCallFeeCents: 5000,
      materialsCents: 2150,
      workOrder: null,
      driveTime: null,
    });
    expect(row!.filled).toMatchObject({ arrival: 'TIMESHEET', laborCents: 'INVOICE', jobNumber: 'VISIT' });
    expect(row!.corrected).toEqual([]);
  });

  it('leaves the money empty until the visit is invoiced, and a past visit not done is "No"', async () => {
    const { db } = database({ visits: [visit(1, { status: 'SCHEDULED' })] });
    const [row] = (await read(db)).days[0]!.rows;
    expect(row).toMatchObject({ laborCents: null, invoiceNumber: null, workComplete: false });
  });

  it('never gives one stay at an address to two visits there', async () => {
    const { db } = database({
      visits: [visit(1, { propertywareBuildingId: BUILDING_B }), visit(2, { propertywareBuildingId: BUILDING_B })],
      segments: [segment()],
    });
    const rows = (await read(db)).days[0]!.rows;
    expect(rows.map((row) => row.arrival)).toEqual([null, null]);

    // The timesheet filed the stay under one of them: it is that one's.
    const filed = database({
      visits: [visit(1, { propertywareBuildingId: BUILDING_B }), visit(2, { propertywareBuildingId: BUILDING_B })],
      segments: [segment({ inspectionId: id(2) })],
    });
    expect((await read(filed.db)).days[0]!.rows.map((row) => row.arrival)).toEqual([null, '16:49']);
  });

  it("lays the office's cells over the console's, and keeps the office's own rows", async () => {
    const { db } = database({
      visits: [visit(1, { invoices: [{ number: 'INV-5396', lines: [line('Cleaning', 9500)] }] })],
      entries: [
        { id: 'entry-1', technicianId: TECH, inspectionId: id(1), day: day('2026-11-11'), createdAt: new Date(), ...emptyEntry, driveTime: '10–20 min', timeBudgeted: '2 hrs', estimatedBudgetCents: 9500, laborCents: 8000 },
        { id: 'entry-2', technicianId: TECH, inspectionId: null, day: day('2026-11-11'), createdAt: new Date(), ...emptyEntry, address: '200 Sample Rd - Zone 4 - Turnover', driveTime: '35–50 min', timeBudgeted: '30 mins', estimatedBudgetCents: 7899 },
      ],
    });
    const [today] = (await read(db)).days;
    expect(today!.rows).toHaveLength(2);
    expect(today!.rows[0]).toMatchObject({ laborCents: 8000, invoiceNumber: 'INV-5396', corrected: ['laborCents'] });
    expect(today!.rows[1]).toMatchObject({ key: 'entry-2', inspectionId: null, address: '200 Sample Rd - Zone 4 - Turnover' });
    expect(today!.totals).toMatchObject({ driveTime: '45–70 min', timeBudgeted: '2h 30m', estimatedBudgetCents: 17399, laborCents: 8000 });
  });

  it('refuses a stretch it should not read, and a technician of another office', async () => {
    const { db } = database();
    await expect(read(db, '2026-11-12', '2026-11-11')).rejects.toMatchObject({ code: 'BAD_DATES' });
    await expect(service(db).log(office, { technicianId: id(99), from: '2026-11-11', to: '2026-11-11' })).rejects.toMatchObject({ code: 'TECHNICIAN_NOT_FOUND' });
  });
});

describe("the office's cells", () => {
  it('are saved on the visit, and the change is on the record', async () => {
    const { db, audits, entries } = database({ visits: [visit(1)] });
    await service(db).saveVisit(office, id(1), { driveTime: ' 10–20 min ', laborCents: 7899 });
    expect(entries[0]).toMatchObject({ inspectionId: id(1), technicianId: TECH, driveTime: '10–20 min', laborCents: 7899 });
    expect(audits[0]).toMatchObject({ action: 'REVENUE_LOG_ROW_ADDED', actorUserId: office.id });

    // A null clears the office's cell; a field left out stays.
    await service(db).saveVisit(office, id(1), { laborCents: null });
    expect(entries[0]).toMatchObject({ driveTime: '10–20 min', laborCents: null });
    expect(audits[1]).toMatchObject({ action: 'REVENUE_LOG_EDITED', metadata: { changes: [{ field: 'laborCents', from: '7899', to: '' }] } });
  });

  it("a visit's row cannot be removed, only the office's own", async () => {
    const { db } = database({
      entries: [
        { id: 'entry-1', technicianId: TECH, inspectionId: id(1), day: day('2026-11-11'), createdAt: new Date(), ...emptyEntry },
        { id: 'entry-2', technicianId: TECH, inspectionId: null, day: day('2026-11-11'), createdAt: new Date(), ...emptyEntry },
      ],
    });
    await expect(service(db).removeRow(office, 'entry-1')).rejects.toMatchObject({ code: 'ROW_IS_A_VISIT' });
    await expect(service(db).removeRow(office, 'entry-2')).resolves.toEqual({ removed: true });
  });
});

describe('the request the page sends', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SaveRevenueLogEntryDto });

  it('names every field of the contract', async () => {
    const every: Required<Omit<SaveRevenueLogEntryInput, 'inspectionId'>> = {
      technicianId: TECH,
      date: '2026-11-11',
      address: '100 Example Way',
      workOrder: '37826',
      jobNumber: '20988',
      driveTime: '10–20 min',
      timeBudgeted: '2 hrs',
      estimatedBudgetCents: 7899,
      arrival: '16:49',
      leaving: '17:33',
      workComplete: true,
      rescheduleRequired: false,
      rescheduleOn: '2026-11-17',
      laborCents: 7899,
      serviceCallFeeCents: 5000,
      materialsCents: 0,
      invoiceNumber: '8737/INV-2993',
      postedInPw: 'N/A',
      notes: 'reservice',
    };
    await expect(check(every)).resolves.toBeDefined();
  });

  it('takes a null to clear a cell, and refuses what is malformed', async () => {
    await expect(check({ laborCents: null, arrival: null })).resolves.toBeDefined();
    await expect(check({ arrival: '4:49 PM' })).rejects.toBeDefined();
    await expect(check({ laborCents: -100 })).rejects.toBeDefined();
    await expect(check({ somethingElse: 1 })).rejects.toBeDefined();
  });
});

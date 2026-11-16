import { ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { SaveRevenueBudgetsInput, SaveRevenueDayInput, SaveRevenueLogEntryInput } from '@texasrenters/shared';

import { SaveRevenueBudgetsDto, SaveRevenueDayDto, SaveRevenueLogEntryDto, SaveRevenueWeekDto } from '../src/admin/actual-vs-budget.controller';
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

function database(state: { visits?: unknown[]; entries?: Record<string, unknown>[]; segments?: unknown[]; products?: unknown[]; budgets?: unknown[]; days?: Record<string, unknown>[]; weeks?: Record<string, unknown>[]; months?: Record<string, unknown>[] } = {}) {
  const weeks = state.weeks ?? [];
  const days = state.days ?? [];
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
    revenueTechnicianSetting: { findMany: jest.fn(async () => state.budgets ?? []), upsert: jest.fn(), deleteMany: jest.fn(async () => ({ count: 0 })) },
    revenueSettings: { findUnique: jest.fn(async () => null), upsert: jest.fn() },
    revenueDayEntry: {
      findMany: jest.fn(async () => days),
      findUnique: jest.fn(async () => (days[0] ? { ...days[0] } : null)),
      upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (days[0]) Object.assign(days[0], update);
        else days.push({ ...create });
        return days[0];
      }),
    },
    revenueWeekEntry: {
      findMany: jest.fn(async () => weeks),
      findUnique: jest.fn(async () => (weeks[0] ? { ...weeks[0] } : null)),
      upsert: jest.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (weeks[0]) Object.assign(weeks[0], update);
        else weeks.push({ ...create });
        return weeks[0];
      }),
    },
    revenueMonthEntry: { findMany: jest.fn(async () => state.months ?? []), findUnique: jest.fn(async () => null), upsert: jest.fn() },
    auditLog: { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => audits.push(data)) },
    $transaction: jest.fn(async (work: (tx: unknown) => unknown): Promise<unknown> => work(db)),
  };
  return { db, audits, entries, days, weeks };
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

describe('the daily sheets', () => {
  // Amy's 11/11 in the workbook's tracker: $400 a day, overtime at $56, 8h 25m worked, $347.98 earned.
  const budgets = [{ technicianId: TECH, dailyBudgetCents: 40000, otRateCents: 5600, technician: { displayName: 'Sample Technician' } }];
  const worked = [
    { technicianId: TECH, inspectionId: id(1), buildingId: null, category: 'ONSITE', startedAt: new Date('2026-11-11T14:00:00.000Z'), endedAt: new Date('2026-11-11T18:00:00.000Z'), durationSeconds: 4 * 3600 },
    { technicianId: TECH, inspectionId: id(2), buildingId: null, category: 'ONSITE', startedAt: new Date('2026-11-11T18:30:00.000Z'), endedAt: new Date('2026-11-11T22:55:00.000Z'), durationSeconds: 4 * 3600 + 25 * 60 },
  ];
  const visits = [
    visit(1, { invoices: [{ number: 'INV-1', lines: [line('Cleaning', 19899)] }] }),
    visit(2, { invoices: [{ number: 'INV-2', lines: [line('Cleaning', 14899)] }] }),
  ];
  const planned = [
    { id: 'entry-1', technicianId: TECH, inspectionId: id(1), day: day('2026-11-11'), createdAt: new Date(), ...emptyEntry, driveTime: '10–20 min', timeBudgeted: '2 hrs', estimatedBudgetCents: 25000 },
    { id: 'entry-2', technicianId: TECH, inspectionId: id(2), day: day('2026-11-11'), createdAt: new Date(), ...emptyEntry, driveTime: '15–25 min', timeBudgeted: '3 hrs', estimatedBudgetCents: 25596 },
  ];

  it("read each technician's day from their log and the timesheet, with the payroll period so far", async () => {
    const { db } = database({ budgets, visits, segments: worked, entries: planned });
    const result = await service(db).day(office, '2026-11-11');
    expect(result.payrollPeriod).toEqual({ from: '2026-11-02', to: '2026-11-15' });
    expect(result.technicians).toHaveLength(1);
    expect(result.technicians[0]).toMatchObject({
      budgetCents: 40000,
      driveTime: '25–45 min',
      billableTime: '5h 00m',
      projectedCents: 50596,
      actualCents: 34798,
      workSeconds: 8 * 3600 + 25 * 60,
      typed: { budget: false, work: false },
      period: { regularSeconds: 8 * 3600, overtimeSeconds: 25 * 60, budgetedCents: 42333, actualCents: 34798 },
    });
  });

  it("take the office's budget and hours for the day over the usual and the timesheet's", async () => {
    const { db } = database({ budgets, visits, segments: worked, entries: planned, days: [{ technicianId: TECH, day: day('2026-11-11'), budgetCents: 20000, workSeconds: 4 * 3600, projectionRemarks: null, dailyRemarks: 'Half day', trackerRemarks: null }] });
    const [amy] = (await service(db).day(office, '2026-11-11')).technicians;
    expect(amy).toMatchObject({ budgetCents: 20000, workSeconds: 4 * 3600, typed: { budget: true, work: true }, dailyRemarks: 'Half day' });
    expect(amy!.period).toMatchObject({ overtimeSeconds: 0, budgetedCents: 20000 });
  });

  it('show nobody without a budget', async () => {
    const { db } = database({ visits });
    expect((await service(db).day(office, '2026-11-11')).technicians).toEqual([]);
  });

  it("keep what the office typed for the day, and put it on the record", async () => {
    const { db, audits, days } = database({ budgets });
    await service(db).saveDay(office, TECH, '2026-11-11', { dailyRemarks: '  Completed 3 visits ', workSeconds: 30300 });
    expect(days[0]).toMatchObject({ technicianId: TECH, dailyRemarks: 'Completed 3 visits', workSeconds: 30300 });
    expect(audits[0]).toMatchObject({ action: 'REVENUE_DAY_EDITED' });
  });

  it('take every field of their requests', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const dayBody: Required<SaveRevenueDayInput> = { budgetCents: 61000, workSeconds: 30300, projectionRemarks: 'a', dailyRemarks: 'b', trackerRemarks: 'c' };
    await expect(pipe.transform(dayBody, { type: 'body', metatype: SaveRevenueDayDto })).resolves.toBeDefined();
    await expect(pipe.transform({ workSeconds: 90000 }, { type: 'body', metatype: SaveRevenueDayDto })).rejects.toBeDefined();
    const budgetsBody: Required<SaveRevenueBudgetsInput> = {
      payrollPeriodStart: '2026-11-02',
      payrollPeriodDays: 14,
      technicians: [{ technicianId: TECH, dailyBudgetCents: 40000, otRateCents: 5600 }],
    };
    await expect(pipe.transform(budgetsBody, { type: 'body', metatype: SaveRevenueBudgetsDto })).resolves.toBeDefined();
    await expect(pipe.transform({ technicians: [{ technicianId: TECH, dailyBudgetCents: -1, otRateCents: 0 }] }, { type: 'body', metatype: SaveRevenueBudgetsDto })).rejects.toBeDefined();
  });
});

describe('the weekly and monthly reports', () => {
  // A technician on $610 a day who worked one day, Wednesday 11/11, in the week of November 9-15.
  const budgets = [{ technicianId: TECH, dailyBudgetCents: 61000, otRateCents: 8500, technician: { displayName: 'Sample Technician' } }];
  const visits = [
    visit(1, { invoices: [{ number: 'INV-1', lines: [line('Repair', 42500), line('Service Call', 5000)] }] }),
    visit(2, { invoices: [{ number: 'INV-2', lines: [line('Repair', 17000)] }] }),
  ];
  const products = [{ nameKey: 'service call', revenueColumn: 'SERVICE_CALL_FEE' }];
  const worked = [
    { technicianId: TECH, inspectionId: id(1), buildingId: null, category: 'ONSITE', startedAt: new Date('2026-11-11T14:00:00.000Z'), endedAt: new Date('2026-11-11T20:00:00.000Z'), durationSeconds: 6 * 3600 },
  ];

  it("divide the month into its weeks, each worked day's budget the target and its revenue the actual", async () => {
    const { db } = database({ budgets, visits, products, segments: worked });
    const report = await service(db).month(office, '2026-11');
    expect(report.weeks.map((week) => week.from)).toEqual(['2026-11-01', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30']);
    expect(report.weeks[0]!.technicians[0]).toMatchObject({ targetCents: 0, actualCents: 0, daysWorked: 0 });
    expect(report.weeks[1]!.technicians[0]).toMatchObject({ targetCents: 61000, actualCents: 64500, daysWorked: 1, typed: { target: false, actual: false } });
    expect(report.technicians[0]).toMatchObject({ targetCents: 61000, actualCents: 64500 });
  });

  it("take the office's target and actual for a week, and add them into the month", async () => {
    const { db } = database({
      budgets,
      visits,
      products,
      segments: worked,
      weeks: [{ technicianId: TECH, weekStart: day('2026-11-09'), targetCents: 122000, actualCents: 274500, remarks: 'Job at Aurora Creek billed apart' }],
      months: [{ technicianId: TECH, remarks: 'Strong month' }],
    });
    const report = await service(db).month(office, '2026-11');
    expect(report.weeks[1]!.technicians[0]).toMatchObject({ targetCents: 122000, actualCents: 274500, typed: { target: true, actual: true }, remarks: 'Job at Aurora Creek billed apart' });
    expect(report.technicians[0]).toMatchObject({ targetCents: 122000, actualCents: 274500, remarks: 'Strong month' });
  });

  it("save a week's cells only on the first day of one of the month's weeks", async () => {
    const { db, audits, weeks } = database({ budgets });
    await service(db).saveWeek(office, TECH, '2026-11-09', { targetCents: 244000, remarks: ' Day off Friday ' });
    expect(weeks[0]).toMatchObject({ targetCents: 244000, remarks: 'Day off Friday' });
    expect(audits[0]).toMatchObject({ action: 'REVENUE_WEEK_EDITED' });
    await expect(service(db).saveWeek(office, TECH, '2026-11-10', { remarks: 'x' })).rejects.toMatchObject({ code: 'BAD_DATES' });
  });

  it('refuse a month that is not one', async () => {
    const { db } = database({ budgets });
    await expect(service(db).month(office, '2026-13')).rejects.toMatchObject({ code: 'BAD_DATES' });
  });

  it("take every field of a week's request", async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(pipe.transform({ targetCents: 244000, actualCents: 346500, remarks: 'a' }, { type: 'body', metatype: SaveRevenueWeekDto })).resolves.toBeDefined();
    await expect(pipe.transform({ targetCents: -1 }, { type: 'body', metatype: SaveRevenueWeekDto })).rejects.toBeDefined();
  });
});

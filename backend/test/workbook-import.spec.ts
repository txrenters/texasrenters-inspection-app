import { randomUUID } from 'node:crypto';

import { importWorkingTechnicians, mergeImported } from '../src/admin/actual-vs-budget-import';
import { centsFrom, clockFrom, dayFrom, importWorkbook, secondsFrom, technicianMatcher, yesNo } from '../src/admin/workbook-import';
import type { WorkbookSheet } from '../src/admin/workbook-reader';

/**
 * Everything the office's workbook holds for its working technicians, imported
 * (2026-11-17, the office: "I want all the data imported too"; for the days
 * before the import, the workbook's values win). The tabs are built here as
 * the reader hands them over, with invented names, addresses and figures.
 */

const sheet = (name: string, rows: Record<number, Record<string, string>>, hidden = false): WorkbookSheet => ({
  name,
  hidden,
  rows: new Map(Object.entries(rows).map(([row, cells]) => [Number(row), new Map(Object.entries(cells))])),
});

const LOG_HEADERS = {
  A: 'Date', B: 'Address', C: 'WO#', D: 'Job#', E: 'Drive Time', F: 'Time Budgeted ', G: 'Estimated Labor Revenue Budget', H: 'Arrival Time',
  I: 'Time Leaving', J: 'Actual Time', K: 'Is the Work Complete?', L: 'Re-Schedule Required?', M: 'Date For Re-schedule', N: 'Labor Hours Income',
  O: 'Service Call Fee', P: 'Materials', Q: 'Invoice #', R: 'Date Posted in PW', S: 'Issues/Notes',
};

const TODAY = '2026-11-17';

const workbook = [
  sheet('Amy', {
    1: LOG_HEADERS,
    2: { A: '11/12/2026', B: '100 Example Way - Zone 3 - Move in inspection', D: '20951', E: '10–15 min', F: '2 hrs', G: '250', H: '8:44 AM', I: '10:15 AM', J: '1h 31m', K: 'Yes', L: 'No', N: '210.00', O: '$ -', Q: '6980', R: '11/13/2026', S: 'Tenant home' },
    3: { A: '11/12/2026', B: '100 Example Way - again', D: '20951', N: '50' },
    4: { A: '11/12/2026', B: '7 Sample Ct - Zone 2 - Turnover', D: '#21001', M: '11/20/2026', L: 'Yes', N: '(10.00)' },
    5: { E: '10–15 min', G: '300', J: '1h 31m' },
    6: { A: '11/12/2026' },
    7: { A: '11/18/2026', B: '9 Later Ln', D: '21100' },
  }),
  // Moses's tab names neither its days nor its WO# column, but keeps them in the same places.
  sheet('Moses', {
    2: { ...LOG_HEADERS, A: '', C: '' },
    3: { A: '3/12/2026', B: '5 Spring Rd - Zone 4 - Move-out Inspection', D: '17927', H: '7:57', I: '8:27', K: 'No', N: '0', Q: 'N/A' },
  }),
  sheet('Nathan', { 1: LOG_HEADERS, 2: { A: '1/5/2026', B: '1 Old Rd', N: '10' } }, true),
  sheet('New 1116', {
    1: { B: 'ACTUAL VS. BUDGET REVENUE' },
    2: { A: 'DATE:11/16/2026' },
    4: { A: 'Technician', B: 'Budgeted Daily Revenue (Regular 8 hour-work)', G: "Tech's Work Time", O: 'Remarks' },
    5: { A: 'Amy Wilson', B: '400', G: '8h 00m', O: 'Short day' },
    6: { A: 'Moses Rodriguez', B: '650' },
  }),
  sheet('New 1111', { 2: { A: 'DATE:11/11/2026' }, 4: { A: 'Technician', B: 'Budgeted Daily Revenue (Regular 8 hour-work)' }, 5: { A: 'Amy Wilson', B: '380' } }),
  sheet('1111', {
    1: { A: 'ACTUAL VS PROJECTED REVENUE' },
    2: { A: 'Date: 11/11/2026' },
    3: { A: 'TECHNICIAN', H: 'REMARKS' },
    4: { A: 'AMY WILSON', H: 'Completed 1 move-in.' },
    5: { A: 'THOMAS ALLEN KIVI', H: 'Two repairs.' },
  }),
  sheet('Projected Productivity_1117', {
    2: { B: 'Date: ', C: '11/17/2026' },
    3: { A: 'Technician', E: 'Remarks' },
    4: { A: 'Amy', E: 'Not yet' },
  }),
  sheet('Projected Productivity_1112', {
    2: { B: 'Date: ', C: '46338' },
    3: { A: 'Technician', E: 'Remarks' },
    4: { A: 'Amy', E: '1 move-in, 2 TBPs' },
    5: { A: 'Allen', E: 'Few service requests.' },
    6: { A: 'Total ', E: 'ignored' },
  }),
  sheet('Oct 5-9', {
    1: { A: 'PERIOD COVERED: OCTOBER 5-9, 2026' },
    2: { A: 'TECHNICIAN', B: 'TARGET REVENUE', C: 'ACTUAL REVENUE', F: 'REMARKS' },
    3: { A: 'AMY WILSON', B: '2,000.00', C: '2,363.70', F: 'Good week' },
    4: { A: 'ANTONIO VERDIN', B: '610' },
    5: { A: 'TOTAL', B: '2,610.00' },
  }),
  sheet('Nov. 16-20', { 1: { A: 'PERIOD COVERED: NOVEMBER 16-20, 2026' }, 2: { A: 'TECHNICIAN', B: 'TARGET REVENUE', C: 'ACTUAL REVENUE', F: 'REMARKS' }, 3: { A: 'AMY WILSON', B: '2000', F: 'Midweek' } }),
  sheet('Month of October', { 1: { A: 'PERIOD COVERED: Month of October' }, 2: { A: 'TECHNICIAN', F: 'REMARKS' }, 3: { A: 'MOSES RODRIGUEZ', F: 'Strong month' } }),
];

describe("reading the workbook's cells", () => {
  it('reads days, money, clock times, hours and yes or no as the workbook shows them', () => {
    expect([dayFrom('11/16/2026'), dayFrom('16-Nov-26'), dayFrom('16-Nov', 2026), dayFrom('46342'), dayFrom('2/30/2026'), dayFrom('soon')]).toEqual([
      '2026-11-16', '2026-11-16', '2026-11-16', '2026-11-16', null, null,
    ]);
    expect([centsFrom('250'), centsFrom('$1,234.50'), centsFrom('$ -'), centsFrom('-'), centsFrom('(10.00)'), centsFrom('N/A'), centsFrom('')]).toEqual([
      25000, 123450, 0, 0, null, null, null,
    ]);
    expect([clockFrom('8:44 AM'), clockFrom('12:05 pm'), clockFrom('12:05 AM'), clockFrom('16:49'), clockFrom('7:57'), clockFrom('25:00'), clockFrom('noon')]).toEqual([
      '08:44', '12:05', '00:05', '16:49', '07:57', null, null,
    ]);
    expect([secondsFrom('8h 25m'), secondsFrom('11h 3m'), secondsFrom('8:00'), secondsFrom('8h'), secondsFrom('-')]).toEqual([30300, 39780, 28800, 28800, null]);
    expect([yesNo('Yes'), yesNo('no'), yesNo('Maybe')]).toEqual([true, false, null]);
  });
});

describe('what the workbook holds for the working technicians', () => {
  const found = importWorkbook(workbook, TODAY);

  it("reads each working technician's tab -- every visit row before today, in the console's names -- and leaves the past technicians' tabs to the history", () => {
    expect(found.logs.map((log) => log.tab)).toEqual(['Amy', 'Moses']);
    const amy = found.logs[0]!;
    expect(amy).toMatchObject({ undated: 0, notPast: 1 });
    expect(amy.rows).toHaveLength(3);
    expect(amy.rows[0]).toEqual({
      date: '2026-11-12',
      cells: {
        address: '100 Example Way - Zone 3 - Move in inspection', workOrder: null, jobNumber: '20951', driveTime: '10–15 min', timeBudgeted: '2 hrs',
        estimatedBudgetCents: 25000, arrival: '08:44', leaving: '10:15', workComplete: true, rescheduleRequired: false, rescheduleOn: null,
        laborCents: 21000, serviceCallFeeCents: 0, materialsCents: null, invoiceNumber: '6980', postedInPw: '11/13/2026', notes: 'Tenant home',
      },
    });
    // "#21001" is the job; a negative sum is not money the console keeps.
    expect(amy.rows[2]!.cells).toMatchObject({ jobNumber: '21001', rescheduleOn: '2026-11-20', rescheduleRequired: true, laborCents: null });
    expect(found.logs[1]!.rows[0]).toMatchObject({ date: '2026-03-12', cells: { arrival: '07:57', leaving: '08:27', laborCents: 0, invoiceNumber: 'N/A' } });
  });

  it('takes the budgets from the newest tracker, and the days before today from every tracker, daily report and projection', () => {
    expect(found.budgets).toEqual([
      { name: 'Amy Wilson', dailyBudgetCents: 40000 },
      { name: 'Moses Rodriguez', dailyBudgetCents: 65000 },
    ]);
    expect(found.days).toEqual(
      expect.arrayContaining([
        { name: 'Amy Wilson', date: '2026-11-16', field: 'workSeconds', value: 28800 },
        { name: 'Amy Wilson', date: '2026-11-16', field: 'trackerRemarks', value: 'Short day' },
        { name: 'Amy Wilson', date: '2026-11-11', field: 'budgetCents', value: 38000 },
        { name: 'AMY WILSON', date: '2026-11-11', field: 'dailyRemarks', value: 'Completed 1 move-in.' },
        { name: 'Amy', date: '2026-11-12', field: 'projectionRemarks', value: '1 move-in, 2 TBPs' },
      ]),
    );
    expect(found.days.some((cell) => cell.date === TODAY)).toBe(false);
    expect(found.days.some((cell) => cell.value === 'ignored')).toBe(false);
  });

  it("reads a week into the console's week its first day is in, with figures only once it is over, and a month's remarks", () => {
    expect(found.weeks).toEqual([
      { name: 'AMY WILSON', weekStart: '2026-10-05', targetCents: 200000, actualCents: 236370, remarks: 'Good week' },
      { name: 'ANTONIO VERDIN', weekStart: '2026-10-05', targetCents: 61000, actualCents: null, remarks: null },
      { name: 'AMY WILSON', weekStart: '2026-11-16', targetCents: null, actualCents: null, remarks: 'Midweek' },
    ]);
    expect(found.months).toEqual([{ name: 'MOSES RODRIGUEZ', month: '2026-10', remarks: 'Strong month' }]);
  });

  it('knows each technician by every name the workbook gives them, and no one else', () => {
    const match = technicianMatcher(
      [
        { id: 'a', name: 'Amy Wilson' },
        { id: 't', name: 'Thomas Allen' },
        { id: 'm', name: 'Allen M' },
        { id: 'k', name: 'Kevin Granados' },
        { id: 'k2', name: 'Kevin Other' },
      ],
      ['Amy', 'Thomas', 'Kevin'],
    );
    expect(['Amy', 'AMY WILSON', 'Thomas', 'THOMAS ALLEN KIVI', 'Thomas Allen Kivi'].map((name) => match(name)?.id)).toEqual(['a', 'a', 't', 't', 't']);
    // "Allen" on a projection is not Allen M, who has no tab; two Kevins cannot be told apart by a first name.
    expect(['Allen', 'Kevin', 'ANTONIO VERDIN', ''].map((name) => match(name))).toEqual([null, null, null, null]);
  });
});

describe('the workbook wins for the days before the import, and the office keeps what it changes after', () => {
  it('fills an empty entry, wins over what the console had, keeps a cell changed since the last import, and clears one the workbook emptied', () => {
    expect(mergeImported(null, null, { laborCents: 100, notes: null })).toEqual({ data: { laborCents: 100 }, imported: { laborCents: 100 }, kept: 0 });
    expect(mergeImported({ laborCents: 5, notes: 'mine' }, null, { laborCents: 100, notes: null })).toEqual({ data: { laborCents: 100 }, imported: { laborCents: 100 }, kept: 0 });
    expect(mergeImported({ laborCents: 7, notes: 'old' }, { laborCents: 100, notes: 'old' }, { laborCents: 200, notes: null })).toEqual({
      data: { notes: null },
      imported: { laborCents: 100 },
      kept: 1,
    });
    expect(mergeImported({ rescheduleOn: new Date('2026-11-20T00:00:00.000Z') }, { rescheduleOn: '2026-11-20' }, { rescheduleOn: '2026-11-21' })).toEqual({
      data: { rescheduleOn: '2026-11-21' },
      imported: { rescheduleOn: '2026-11-21' },
      kept: 0,
    });
  });
});

// ── Writing it, with the database faked ─────────────────────────────────────

const ORG = '70000000-0000-4000-8000-000000000001';
const AMY = { id: '70000000-0000-4000-8000-0000000000a1', name: 'Amy Wilson' };
const MOSES = { id: '70000000-0000-4000-8000-0000000000a2', name: 'Moses Rodriguez' };
const VISIT = '70000000-0000-4000-8000-0000000000b1';
const MOVED = '70000000-0000-4000-8000-0000000000b2';

type Row = Record<string, unknown> & { id: string };

function database(budgets: { technicianId: string; dailyBudgetCents: number }[] = []) {
  const tables = { log: [] as Row[], day: [] as Row[], week: [] as Row[], month: [] as Row[], budget: budgets.map((row) => ({ id: randomUUID(), ...row })) as Row[] };
  const same = (left: unknown, right: unknown) => (left instanceof Date && right instanceof Date ? left.getTime() === right.getTime() : left === right);
  const matches = (row: Row, where: Record<string, unknown>) => Object.entries(where).every(([field, value]) => same(row[field], value));
  const keyed = (table: Row[], unique: string) => ({
    findMany: jest.fn(async ({ where }: { where: { OR: Record<string, unknown>[] } }) => table.filter((row) => where.OR.some((key) => matches(row, key))).map((row) => ({ ...row }))),
    upsert: jest.fn(async ({ where, create, update }: { where: Record<string, Record<string, unknown>>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const found = table.find((row) => matches(row, where[unique]!));
      if (found) Object.assign(found, update);
      else table.push({ id: randomUUID(), ...create });
    }),
  });
  const tx = {
    revenueTechnicianSetting: {
      findMany: jest.fn(async () => tables.budget.map((row) => ({ ...row }))),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => tables.budget.push({ id: randomUUID(), ...data })),
    },
    inspection: {
      findMany: jest.fn(async () => [
        { id: VISIT, scheduledAt: new Date('2026-11-12T00:00:00.000Z'), jobberJobNumber: '20951', assignments: [{ technicianId: AMY.id }] },
        // Moved from 3/12 to 3/14 in Jobber: still the workbook's row.
        { id: MOVED, scheduledAt: new Date('2026-03-14T00:00:00.000Z'), jobberJobNumber: '17927', assignments: [{ technicianId: MOSES.id }] },
      ]),
    },
    revenueLogEntry: {
      findMany: jest.fn(async () => tables.log.map((row) => ({ ...row }))),
      createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const row of data) tables.log.push({ id: randomUUID(), inspectionId: null, ...row });
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(tables.log.find((row) => row.id === where.id)!, data)),
      deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        tables.log = tables.log.filter((row) => !where.id.in.includes(row.id));
      }),
    },
    revenueDayEntry: keyed(tables.day, 'technicianId_day'),
    revenueWeekEntry: keyed(tables.week, 'technicianId_weekStart'),
    revenueMonthEntry: keyed(tables.month, 'technicianId_month'),
  };
  return { tx, tables };
}

describe('importing it', () => {
  const found = importWorkbook(workbook, TODAY);

  it("puts each row on its visit -- the technician's visit that day with the row's job -- and the rest as the office's own rows", async () => {
    const { tx, tables } = database([{ technicianId: MOSES.id, dailyBudgetCents: 71000 }]);
    const summary = await importWorkingTechnicians(tx as never, ORG, 'office', [AMY, MOSES], found);
    expect(summary.logs).toEqual([
      { tab: 'Amy', technician: 'Amy Wilson', visits: 1, officeRows: 2, keptEdits: 0, skipped: 1 },
      { tab: 'Moses', technician: 'Moses Rodriguez', visits: 1, officeRows: 0, keptEdits: 0, skipped: 0 },
    ]);
    const visitRow = tables.log.find((row) => row.inspectionId === VISIT)!;
    expect(visitRow).toMatchObject({ technicianId: AMY.id, laborCents: 21000, arrival: '08:44', importedFields: expect.objectContaining({ laborCents: 21000 }) });
    // Two rows with one job on one day: the second has no visit left, so it is the office's own.
    expect(tables.log.filter((row) => !row.inspectionId).map((row) => row.address)).toEqual(['100 Example Way - again', '7 Sample Ct - Zone 2 - Turnover']);
    expect(tables.log.find((row) => row.inspectionId === MOVED)).toMatchObject({ technicianId: MOSES.id, day: new Date('2026-03-14T00:00:00.000Z'), laborCents: 0 });
    // Amy had no budget: she gets the workbook's, with its overtime key; Moses keeps his.
    expect(summary.budgets).toEqual(['Amy Wilson']);
    expect(tables.budget.find((row) => row.technicianId === AMY.id)).toMatchObject({ dailyBudgetCents: 40000, otRateCents: 5600 });
    expect(tables.budget.find((row) => row.technicianId === MOSES.id)).toMatchObject({ dailyBudgetCents: 71000 });
    // A day's budget is typed only where it is not the technician's own: Amy's 11/16 is, her 11/11 is not.
    const amyDays = tables.day.filter((row) => row.technicianId === AMY.id);
    expect(amyDays.find((row) => (row.day as Date).toISOString().startsWith('2026-11-11'))).toMatchObject({ budgetCents: 38000, dailyRemarks: 'Completed 1 move-in.' });
    expect(amyDays.find((row) => (row.day as Date).toISOString().startsWith('2026-11-16'))).not.toHaveProperty('budgetCents');
    expect(tables.week).toEqual(
      expect.arrayContaining([expect.objectContaining({ technicianId: AMY.id, targetCents: 200000, actualCents: 236370, remarks: 'Good week' })]),
    );
    expect(tables.month).toEqual([expect.objectContaining({ technicianId: MOSES.id, remarks: 'Strong month' })]);
    expect(summary.unmatched).toEqual(['ANTONIO VERDIN', 'Allen', 'THOMAS ALLEN KIVI']);
  });

  it('importing again keeps what the office changed in the console since, and replaces only what it had not', async () => {
    const { tx, tables } = database();
    await importWorkingTechnicians(tx as never, ORG, 'office', [AMY, MOSES], found);
    const visitRow = tables.log.find((row) => row.inspectionId === VISIT)!;
    visitRow.notes = 'Fixed the note in the console';
    const edited = tables.log.find((row) => row.address === '7 Sample Ct - Zone 2 - Turnover')!;
    edited.notes = 'Typed later';
    const before = tables.log.length;

    const again = await importWorkingTechnicians(tx as never, ORG, 'office', [AMY, MOSES], found);
    expect(tables.log).toHaveLength(before);
    expect(tables.log.find((row) => row.inspectionId === VISIT)).toMatchObject({ notes: 'Fixed the note in the console', laborCents: 21000 });
    expect(tables.log.filter((row) => row.address === '7 Sample Ct - Zone 2 - Turnover')).toEqual([expect.objectContaining({ id: edited.id, notes: 'Typed later' })]);
    expect(again.logs[0]).toMatchObject({ keptEdits: 2 });
    expect(again.budgets).toEqual([]);
  });
});

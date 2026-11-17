import { findClearedCells, restoreClearedCells, storedValue } from '../src/admin/actual-vs-budget-restore';

/**
 * The cells a save cleared by mistake, found in the audit record and put back
 * (2026-11-17, the office: "fix it from the history"). Modelled on Moses's
 * 11/17 row for 17518 Autumn Hills; the names and figures are invented.
 */

const ORG = '91000000-0000-4000-8000-000000000001';
const MOSES = '91000000-0000-4000-8000-0000000000a1';
const OFFICE = '91000000-0000-4000-8000-0000000000c1';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 17, 18, minute));

function database() {
  const audits: { id: string; action: string; entityId: string; actorUserId: string | null; createdAt: Date; metadata: unknown }[] = [
    // The budget typed on the 17518 row: the save also emptied its drive time and time budgeted.
    {
      id: 'audit-1',
      action: 'REVENUE_LOG_EDITED',
      entityId: 'entry-17518',
      actorUserId: OFFICE,
      createdAt: at(1),
      metadata: {
        changes: [
          { field: 'driveTime', from: '10–20 min', to: '' },
          { field: 'timeBudgeted', from: '30 mins', to: '' },
          { field: 'estimatedBudgetCents', from: '', to: '7899' },
        ],
      },
    },
    // The time budgeted was typed again since: nothing to put back.
    { id: 'audit-2', action: 'REVENUE_LOG_EDITED', entityId: 'entry-17518', actorUserId: OFFICE, createdAt: at(5), metadata: { changes: [{ field: 'timeBudgeted', from: '', to: '30 mins' }] } },
    // A cell the office cleared on purpose, alone: not the fault's.
    { id: 'audit-3', action: 'REVENUE_LOG_EDITED', entityId: 'entry-other', actorUserId: OFFICE, createdAt: at(6), metadata: { changes: [{ field: 'notes', from: 'Gate code', to: '' }] } },
    // A day's remarks emptied from Excel: listed, for the office to choose.
    {
      id: 'audit-4',
      action: 'REVENUE_EXCEL_EDITS_TAKEN',
      entityId: ORG,
      actorUserId: null,
      createdAt: at(7),
      metadata: { edits: [{ tab: '1117', key: `day|${MOSES}|2026-11-17`, field: 'dailyRemarks', from: 'Completed 8 TBPs', to: '' }] },
    },
    // A week's target cleared by a remark's save.
    {
      id: 'audit-5',
      action: 'REVENUE_WEEK_EDITED',
      entityId: `${MOSES}:2026-11-16`,
      actorUserId: OFFICE,
      createdAt: at(8),
      metadata: { changes: [{ field: 'targetCents', from: '355000', to: '' }, { field: 'remarks', from: '', to: 'Short week' }] },
    },
  ];
  const entries = [
    { id: 'entry-17518', organizationId: ORG, inspectionId: 'visit-17518', technicianId: MOSES, day: new Date('2026-11-17T00:00:00.000Z'), address: null, driveTime: null, timeBudgeted: '30 mins', estimatedBudgetCents: 7899, technician: { displayName: 'Moses Rodriguez' }, inspection: { jobberJobNumber: '20373', propertywareBuilding: { addressLine1: '17518 Autumn Hills Dr' }, property: null } },
    { id: 'entry-other', organizationId: ORG, inspectionId: null, technicianId: MOSES, day: new Date('2026-11-17T00:00:00.000Z'), address: '9 Office Row', notes: null, technician: { displayName: 'Moses Rodriguez' }, inspection: null },
  ] as Record<string, unknown>[];
  const days = [{ organizationId: ORG, technicianId: MOSES, day: new Date('2026-11-17T00:00:00.000Z'), dailyRemarks: null }] as Record<string, unknown>[];
  const weeks = [{ organizationId: ORG, technicianId: MOSES, weekStart: new Date('2026-11-16T00:00:00.000Z'), targetCents: null, remarks: 'Short week' }] as Record<string, unknown>[];
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) =>
      field === 'organizationId' ? true : value instanceof Date ? (row[field] as Date)?.getTime() === value.getTime() : row[field] === value,
    );
  const updateMany = (rows: Record<string, unknown>[]) =>
    jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    });
  const db = {
    auditLog: {
      findMany: jest.fn(async ({ where }: { where: { action: { in: string[] } } }) => audits.filter((audit) => where.action.in.includes(audit.action))),
      create: jest.fn(async ({ data }: { data: (typeof audits)[number] }) => audits.push({ ...data, id: `audit-${audits.length + 1}`, createdAt: at(30) })),
    },
    revenueLogEntry: {
      findMany: jest.fn(async ({ where }: { where: { OR: { id?: { in: string[] }; inspectionId?: { in: string[] } }[] } }) =>
        entries.filter((entry) => where.OR.some((or) => (or.id && or.id.in.includes(entry.id as string)) || (or.inspectionId && or.inspectionId.in.includes(entry.inspectionId as string)))),
      ),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => entries.find((entry) => matches(entry, where)) ?? null),
      updateMany: updateMany(entries),
    },
    revenueDayEntry: { findMany: jest.fn(async () => days), updateMany: updateMany(days) },
    revenueWeekEntry: { findMany: jest.fn(async () => weeks), updateMany: updateMany(weeks) },
    userProfile: { findMany: jest.fn(async () => [{ id: OFFICE, displayName: 'Office Coordinator' }, { id: MOSES, displayName: 'Moses Rodriguez' }]) },
  };
  return { db, entries, days, weeks, audits };
}

describe('cells cleared by mistake', () => {
  it('lists each cell a save cleared and still empty, with the value it held -- not one typed again since, nor one cleared on purpose', async () => {
    const { db } = database();
    const { cells } = await findClearedCells(db as never, ORG);
    expect(cells.map((cell) => [cell.field, cell.lost, cell.certain, cell.by])).toEqual([
      ['targetCents', '355000', true, 'Office Coordinator'],
      ['dailyRemarks', 'Completed 8 TBPs', false, 'Excel'],
      ['driveTime', '10–20 min', true, 'Office Coordinator'],
    ]);
    expect(cells[2]).toMatchObject({ where: 'Moses Rodriguez · 2026-11-17 · 17518 Autumn Hills Dr · job 20373', saved: 'estimatedBudgetCents = 7899' });
    expect(cells[0]).toMatchObject({ where: 'Moses Rodriguez · week of 2026-11-16' });
  });

  it('puts back the chosen cells, each only while still empty, as the column stores it', async () => {
    const { db, entries, weeks, days } = database();
    const { cells } = await findClearedCells(db as never, ORG);
    const drive = cells.find((cell) => cell.field === 'driveTime')!;
    const target = cells.find((cell) => cell.field === 'targetCents')!;
    const restored = await restoreClearedCells(db as never, ORG, new Set([drive.id, target.id]));
    expect(restored.map((cell) => [cell.place, cell.field, cell.to])).toEqual([
      [`week:${MOSES}:2026-11-16`, 'targetCents', '355000'],
      ['log:entry-17518', 'driveTime', '10–20 min'],
    ]);
    expect(entries[0]).toMatchObject({ driveTime: '10–20 min', timeBudgeted: '30 mins', estimatedBudgetCents: 7899 });
    expect(weeks[0]).toMatchObject({ targetCents: 355000, remarks: 'Short week' });
    // Not chosen: left as it is.
    expect(days[0]).toMatchObject({ dailyRemarks: null });
  });

  it('never writes over a cell that holds a value by the time it is put back', async () => {
    const { db, entries } = database();
    const { cells } = await findClearedCells(db as never, ORG);
    entries[0]!.driveTime = '5–15 min';
    const restored = await restoreClearedCells(db as never, ORG, new Set(cells.map((cell) => cell.id)));
    expect(restored.map((cell) => cell.field)).not.toContain('driveTime');
    expect(entries[0]).toMatchObject({ driveTime: '5–15 min' });
  });

  it('reads the record’s text back as each column stores it', () => {
    expect(storedValue('estimatedBudgetCents', '7899')).toBe(7899);
    expect(storedValue('workSeconds', '28800')).toBe(28800);
    expect(storedValue('workComplete', 'true')).toBe(true);
    expect(storedValue('rescheduleOn', '2026-11-20')).toEqual(new Date('2026-11-20T00:00:00.000Z'));
    expect(storedValue('driveTime', 'Start')).toBe('Start');
  });
});

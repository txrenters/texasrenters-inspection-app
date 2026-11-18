import { fireEvent, render, screen, within } from '@testing-library/react';
import type { RevenueDay, RevenueDayTechnician, RevenueLog, RevenueLogRow, RevenueMonthReport } from '@texasrenters/shared';
import { weekOf } from '@texasrenters/shared';
import { revenueLogTotals } from '@texasrenters/shared';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { businessToday } from '@/lib/clock';

import { TechnicianLog } from '@/components/actual-vs-budget/technician-log';

import ActualVsBudgetPage from './page';

/**
 * Actual vs Budget's technician log (2026-11-17): the workbook's 19 columns,
 * its formats, and a Total row per day. Everything invented.
 */

const permissions = vi.hoisted(() => ({ allowed: true }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => permissions.allowed }) }));
const queries = vi.hoisted(() => ({
  useRevenueTechnicians: vi.fn(),
  useRevenueLog: vi.fn(),
  useRevenueProducts: vi.fn(),
  useRevenueDay: vi.fn(),
  useRevenueBudgets: vi.fn(),
  useRevenueMonth: vi.fn(),
  useRevenueHistoryList: vi.fn(),
  useRevenueHistorySheet: vi.fn(),
  importHistory: vi.fn(),
  saveWeek: vi.fn(),
  save: vi.fn(),
  saveDay: vi.fn(),
}));
vi.mock('@/lib/actual-vs-budget-queries', () => ({
  useRevenueTechnicians: queries.useRevenueTechnicians,
  useRevenueLog: queries.useRevenueLog,
  useRevenueProducts: queries.useRevenueProducts,
  useRevenueDay: queries.useRevenueDay,
  useRevenueBudgets: queries.useRevenueBudgets,
  useRevenueMonth: queries.useRevenueMonth,
  useRevenueHistoryList: queries.useRevenueHistoryList,
  useRevenueHistorySheet: queries.useRevenueHistorySheet,
  useRevenueHistoryImport: () => ({ mutate: queries.importHistory, isPending: false }),
  useRevenuePeriodEdits: () => ({ saveWeek: { mutateAsync: queries.saveWeek }, saveMonth: { mutateAsync: vi.fn() } }),
  useRevenueDayEdits: () => ({
    saveDay: { mutateAsync: queries.saveDay, isPending: false },
    saveBudgets: { mutate: vi.fn(), isPending: false },
  }),
  useRevenueLogEdits: () => ({
    save: { mutate: queries.save, mutateAsync: queries.save, isPending: false },
    remove: { mutate: vi.fn(), isPending: false },
    saveProductColumn: { mutate: vi.fn(), isPending: false },
  }),
}));
// The live channel is tested on its own (lib/actual-vs-budget-live.test.tsx); here nobody else is on the page.
vi.mock('@/lib/actual-vs-budget-live', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ActualVsBudgetLive: ({ children }: { children: unknown }) => children,
  useActualVsBudgetLive: () => ({ connected: false, others: [], cellOwners: new Map(), focusCell: () => undefined }),
}));
vi.mock('@/lib/url-state', () => ({
  useUrlState: <T extends object>(defaults: T) => {
    const [state, setState] = useState(defaults);
    return [state, (patch: Partial<T>) => setState((current) => ({ ...current, ...patch })), vi.fn()];
  },
}));

const ready = (data: unknown) => ({ isPending: false, isError: false, error: null, data, refetch: vi.fn() });

const row = (over: Partial<RevenueLogRow>): RevenueLogRow => ({
  key: 'visit-1',
  inspectionId: 'visit-1',
  entryId: null,
  date: '2026-11-11',
  address: '100 Example Way - Zone 2 - Q4 TBP Filter Change',
  workOrder: null,
  jobNumber: '20988',
  driveTime: 'Start',
  timeBudgeted: '20 mins',
  estimatedBudgetCents: 7899,
  arrival: '17:36',
  leaving: '17:52',
  actualSeconds: 16 * 60,
  workComplete: true,
  rescheduleRequired: false,
  rescheduleOn: null,
  laborCents: 7899,
  serviceCallFeeCents: null,
  materialsCents: null,
  invoiceNumber: '8737/INV-2993',
  postedInPw: '2026-11-12',
  notes: null,
  filled: { date: 'VISIT', jobNumber: 'VISIT', arrival: 'TIMESHEET', leaving: 'TIMESHEET', laborCents: 'INVOICE', invoiceNumber: 'INVOICE' },
  corrected: [],
  ...over,
});
const ROWS = [
  row({}),
  row({ key: 'visit-2', inspectionId: 'visit-2', address: '200 Sample Rd - Zone 2 - Cleaning', driveTime: '10–20 min', timeBudgeted: '2 hrs', estimatedBudgetCents: 9500, arrival: '16:49', leaving: '17:33', actualSeconds: 44 * 60, laborCents: 8000, corrected: ['laborCents'], invoiceNumber: 'INV-5396' }),
];
const LOG: RevenueLog = {
  technician: { id: 'tech-1', name: 'Sample Technician' },
  from: '2026-11-11',
  to: '2026-11-11',
  days: [{ date: '2026-11-11', rows: ROWS, totals: revenueLogTotals(ROWS) }],
};

// The workbook's tracker for 11/11/2026 ("New 1111"), three of its five technicians.
const tech = (id: string, name: string, over: Partial<RevenueDayTechnician>): RevenueDayTechnician => ({
  technician: { id, name },
  dailyBudgetCents: 61000,
  otRateCents: 8500,
  budgetCents: 61000,
  driveTime: '0–0 min',
  billableTime: '-',
  projectedCents: 0,
  actualCents: 0,
  workSeconds: null,
  typed: { budget: false, work: false },
  projectionRemarks: null,
  dailyRemarks: null,
  trackerRemarks: null,
  period: { regularSeconds: 0, overtimeSeconds: 0, budgetedCents: 0, actualCents: 0 },
  ...over,
});
const DAY: RevenueDay = {
  date: '2026-11-11',
  payrollPeriod: { from: '2026-11-02', to: '2026-11-15' },
  technicians: [
    tech('amy', 'Amy Wilson', { dailyBudgetCents: 40000, otRateCents: 5600, budgetCents: 40000, driveTime: '60–95 min', billableTime: '5h 40m', projectedCents: 50596, actualCents: 34798, workSeconds: 30300, dailyRemarks: '75% Completed' }),
    tech('emanuel', 'Emanuel Hall', { driveTime: '65–110 min', billableTime: '6h 00m', projectedCents: 88500, actualCents: 89381, workSeconds: 39780 }),
    tech('thomas', 'Thomas Allen Kivi', { driveTime: '35–50 min', billableTime: '7h 00m', projectedCents: 72000, actualCents: 59500, workSeconds: 40740 }),
  ],
};
// The workbook's "Nov. 2-6" figures, shown as whatever week today falls in.
const thisWeek = weekOf(businessToday());
const person = (id: string, name: string, targetCents: number, actualCents: number) => ({
  technician: { id, name },
  targetCents,
  actualCents,
  daysWorked: 5,
  typed: { target: false, actual: false },
  remarks: null,
});
const WEEK_ROWS = [
  person('amy', 'Amy Wilson', 200000, 80814),
  person('emanuel', 'Emanuel Hall', 305000, 379941),
  person('kevin', 'Kevin Granados', 244000, 257096),
  person('moses', 'Moses Rodriguez', 355000, 540930),
  person('thomas', 'Thomas Allen Kivi', 244000, 348500),
];
const MONTH: RevenueMonthReport = {
  month: thisWeek.from.slice(0, 7),
  weeks: [{ ...thisWeek, technicians: WEEK_ROWS }],
  // The workbook's "Month of October".
  technicians: [
    { technician: { id: 'amy', name: 'Amy Wilson' }, targetCents: 880000, actualCents: 705753, remarks: null },
    { technician: { id: 'moses', name: 'Moses Rodriguez' }, targetCents: 1562000, actualCents: 1867736, remarks: null },
  ],
};
const open = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });
const rowOf = (name: string) => screen.getByDisplayValue(name).closest('tr')!;
const values = (row: HTMLElement) => within(row).getAllByRole('textbox').map((cell) => (cell as HTMLTextAreaElement).value);

beforeEach(() => {
  permissions.allowed = true;
  queries.useRevenueTechnicians.mockReturnValue(ready({ technicians: [{ id: 'tech-1', name: 'Sample Technician' }] }));
  queries.useRevenueLog.mockReturnValue(ready(LOG));
  queries.useRevenueProducts.mockReturnValue(ready({ products: [] }));
  queries.save.mockReset();
  queries.saveDay.mockReset();
  queries.useRevenueDay.mockReturnValue(ready(DAY));
  queries.useRevenueMonth.mockReturnValue(ready(MONTH));
  queries.saveWeek.mockReset();
  queries.importHistory.mockReset();
  queries.useRevenueHistoryList.mockReturnValue(ready({ sheets: [{ id: 'h1', name: 'Nathan', rowCount: 2, importedAt: '2026-11-17T09:00:00.000Z' }] }));
  queries.useRevenueHistorySheet.mockReturnValue(
    ready({
      id: 'h1',
      name: 'Nathan',
      rowCount: 2,
      importedAt: '2026-11-17T09:00:00.000Z',
      fileName: 'THMP Scheduling Actual Vs Budget 2026.xlsx',
      headers: ['', 'Address', '', 'Job#', 'Labor Revenue Budget', 'Trip Charge'],
      rows: [
        ['2-Jan-26', '100 Example Way - Zone 4 - Q4 Tenant Benefit Package', '', '16207', '103.50', '-'],
        ['Total', '', '', '', '103.50', '-'],
      ],
    }),
  );
  queries.useRevenueBudgets.mockReturnValue(ready({ payrollPeriodStart: '2026-11-02', payrollPeriodDays: 14, technicians: [] }));
});

describe('the technician log', () => {
  it("shows the workbook's 19 headers in its order", () => {
    render(<ActualVsBudgetPage />);
    const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    expect(headers.slice(0, 19)).toEqual([
      'Date', 'Address', 'WO#', 'Job#', 'Drive Time', 'Time Budgeted', 'Estimated Labor Revenue Budget', 'Arrival Time',
      'Time Leaving', 'Actual Time', 'Is the Work Complete?', 'Re-Schedule Required?', 'Date For Re-schedule',
      'Labor Hours Income', 'Service Call Fee', 'Materials', 'Invoice #', 'Date Posted in PW', 'Issues/Notes',
    ]);
  });

  it("fills the cells the console knows, in the workbook's formats, and leaves the rest blank to type into", () => {
    render(<ActualVsBudgetPage />);
    const first = screen.getByDisplayValue('100 Example Way - Zone 2 - Q4 TBP Filter Change').closest('tr')!;
    const cells = within(first).getAllByRole('textbox').map((cell) => (cell as HTMLTextAreaElement).value);
    expect(cells).toEqual([
      '11/11/2026', '100 Example Way - Zone 2 - Q4 TBP Filter Change', '', '20988', 'Start', '20 mins', '78.99', '5:36 PM',
      '5:52 PM', '0h 16m', 'Yes', 'No', '', '78.99', '', '', '8737/INV-2993', '11/12/2026', '',
    ]);
    // A visit's day and its Actual Time are not typed. (Every cell is read-only until it is edited, as in Excel.)
    expect(within(first).getAllByRole('textbox')[0]).toHaveAttribute('data-locked');
    expect(within(first).getAllByRole('textbox')[9]).toHaveAttribute('data-locked');
    expect(within(first).getAllByRole('textbox')[2]).not.toHaveAttribute('data-locked');
  });

  it("closes the day with the workbook's Total row", () => {
    render(<ActualVsBudgetPage />);
    const total = screen.getByText('Total').closest('tr')!;
    expect(within(total).getByText('10–20 min')).toBeInTheDocument();
    expect(within(total).getByText('2h 20m')).toBeInTheDocument();
    expect(within(total).getByText('$174')).toBeInTheDocument();
    expect(within(total).getByText('1h 00m')).toBeInTheDocument();
    expect(within(total).getByText('158.99')).toBeInTheDocument();
  });

  it('saves a cell when it is left, as the workbook writes it', async () => {
    queries.save.mockResolvedValue({ entryId: 'entry-1' });
    render(<ActualVsBudgetPage />);
    const first = screen.getByDisplayValue('100 Example Way - Zone 2 - Q4 TBP Filter Change').closest('tr')!;
    const [, , workOrder, , , , , arrival] = within(first).getAllByRole('textbox');
    fireEvent.focus(workOrder!);
    fireEvent.change(workOrder!, { target: { value: '37826' } });
    fireEvent.blur(workOrder!);
    expect(queries.save).toHaveBeenCalledWith({ target: { inspectionId: 'visit-1' }, input: { workOrder: '37826' } });
    fireEvent.focus(arrival!);
    fireEvent.change(arrival!, { target: { value: '5:40 pm' } });
    fireEvent.blur(arrival!);
    expect(queries.save).toHaveBeenLastCalledWith({ target: { inspectionId: 'visit-1' }, input: { arrival: '17:40' } });
  });

  it('saves nothing when a cell is left as it was, or typed wrong', () => {
    render(<ActualVsBudgetPage />);
    const first = screen.getByDisplayValue('100 Example Way - Zone 2 - Q4 TBP Filter Change').closest('tr')!;
    const labor = within(first).getAllByRole('textbox')[13]!;
    fireEvent.focus(labor);
    fireEvent.change(labor, { target: { value: '78.99' } });
    fireEvent.blur(labor);
    fireEvent.focus(labor);
    fireEvent.change(labor, { target: { value: 'lots' } });
    fireEvent.blur(labor);
    expect(queries.save).not.toHaveBeenCalled();
  });

  it("adds a row of the office's own from the blank row at the foot", () => {
    render(<ActualVsBudgetPage />);
    const address = screen.getByLabelText('New row, Address');
    const row = address.closest('tr')!;
    fireEvent.focus(address);
    fireEvent.change(address, { target: { value: '200 Sample Rd - Zone 4 - Turnover' } });
    const labor = screen.getByLabelText('New row, Labor Hours Income');
    fireEvent.change(labor, { target: { value: '470' } });
    fireEvent.blur(row, { relatedTarget: document.body });
    expect(queries.save).toHaveBeenCalledWith(
      { target: { add: true }, input: expect.objectContaining({ address: '200 Sample Rd - Zone 4 - Turnover', laborCents: 47000, technicianId: 'tech-1' }) },
      expect.anything(),
    );
  });

  it('is read-only without the right to change invoices', () => {
    permissions.allowed = false;
    render(<ActualVsBudgetPage />);
    expect(screen.queryByLabelText('New row, Address')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Money columns' })).not.toBeInTheDocument();
    for (const cell of document.querySelectorAll('[data-slot=sheet] textarea')) expect(cell).toHaveAttribute('data-locked');
  });
});

describe('the daily sheets', () => {
  it("work out the revenue tracker as the workbook does", () => {
    render(<ActualVsBudgetPage />);
    open('Revenue tracker');
    expect(screen.getByText(/Payroll Period to Date \(November 2-15\)/)).toBeInTheDocument();
    expect(values(rowOf('Amy Wilson')).slice(0, 12)).toEqual([
      'Amy Wilson', '$400.00', '60–95 min', '5h 40m', '$505.96', '$347.98', '8h 25m', '0h 25m', '$23.33', '$423.33', '($75.35)', '82.20%',
    ]);
    expect(values(rowOf('Emanuel Hall')).slice(7, 12)).toEqual(['3h 03m', '$259.25', '$869.25', '$24.56', '102.83%']);
    expect(values(rowOf('Thomas Allen Kivi')).slice(7, 12)).toEqual(['3h 19m', '$281.92', '$891.92', '($296.92)', '66.71%']);
  });

  it('write the daily report with the difference against the projection', () => {
    render(<ActualVsBudgetPage />);
    open('Actual vs projected');
    expect(screen.getByText('DIFFERENCE (ACTUAL REVENUE - PROJECTED REVENUE)')).toBeInTheDocument();
    expect(values(rowOf('AMY WILSON'))).toEqual(['AMY WILSON', '$400', '$506', '$347.98', '-$157.98', '87.00%', '8h 25m', '75% Completed']);
    const total = screen.getByText('TOTAL').closest('tr')!;
    expect(within(total).getByText('$1,620')).toBeInTheDocument();
    expect(within(total).getByText('$1,836.79')).toBeInTheDocument();
  });

  it('total the projection, and save a remark typed into its cell', async () => {
    queries.saveDay.mockResolvedValue({ saved: true });
    render(<ActualVsBudgetPage />);
    open("Next day's projection");
    expect(values(rowOf('Amy')).slice(0, 4)).toEqual(['Amy', '60–95 min', '5h 40m', '$505.96']);
    const total = screen.getByText('Total').closest('tr')!;
    expect(within(total).getByText('160–255 min')).toBeInTheDocument();
    expect(within(total).getByText('18h 40m')).toBeInTheDocument();
    expect(within(total).getByText('$2,111')).toBeInTheDocument();
    const remark = within(rowOf('Amy')).getAllByRole('textbox')[4]!;
    fireEvent.focus(remark);
    fireEvent.change(remark, { target: { value: '1 deep cleaning, 2 TBPs' } });
    fireEvent.blur(remark);
    expect(queries.saveDay).toHaveBeenCalledWith({ technicianId: 'amy', date: expect.any(String), input: { projectionRemarks: '1 deep cleaning, 2 TBPs' } });
  });

  it("take hours worked typed over the timesheet's", () => {
    queries.saveDay.mockResolvedValue({ saved: true });
    render(<ActualVsBudgetPage />);
    open('Revenue tracker');
    const work = within(rowOf('Amy Wilson')).getAllByRole('textbox')[6]!;
    fireEvent.focus(work);
    fireEvent.change(work, { target: { value: '9h 10m' } });
    fireEvent.blur(work);
    expect(queries.saveDay).toHaveBeenCalledWith({ technicianId: 'amy', date: expect.any(String), input: { workSeconds: 33000 } });
  });
});

describe('the weekly and monthly reports', () => {
  it("total the week as the workbook's Nov. 2-6 does", () => {
    render(<ActualVsBudgetPage />);
    open('Weekly');
    expect(screen.getByText(/^PERIOD COVERED: [A-Z]+ \d/)).toBeInTheDocument();
    expect(values(rowOf('AMY WILSON'))).toEqual(['AMY WILSON', '2,000.00', '808.14', '(1,191.86)', '40.41%', '']);
    expect(values(rowOf('MOSES RODRIGUEZ')).slice(1, 5)).toEqual(['3,550.00', '5,409.30', '1,859.30', '152.37%']);
    const total = screen.getByText('TOTAL').closest('tr')!;
    expect(within(total).getByText('13,480.00')).toBeInTheDocument();
    expect(within(total).getByText('16,072.81')).toBeInTheDocument();
    expect(within(total).getByText('2,592.81')).toBeInTheDocument();
    expect(within(total).getByText('119.23%')).toBeInTheDocument();
  });

  it("take a week's target typed over the console's, as the workbook's =610*4", () => {
    queries.saveWeek.mockResolvedValue({ saved: true });
    render(<ActualVsBudgetPage />);
    open('Weekly');
    const target = within(rowOf('KEVIN GRANADOS')).getAllByRole('textbox')[1]!;
    fireEvent.focus(target);
    fireEvent.change(target, { target: { value: '2,440.00' } });
    fireEvent.blur(target);
    expect(queries.saveWeek).not.toHaveBeenCalled();
    fireEvent.focus(target);
    fireEvent.change(target, { target: { value: '1830' } });
    fireEvent.blur(target);
    expect(queries.saveWeek).toHaveBeenCalledWith({ technicianId: 'kevin', weekStart: thisWeek.from, input: { targetCents: 183000 } });
  });

  it("add up the month as the workbook's Month of October, with only the remarks typed", () => {
    render(<ActualVsBudgetPage />);
    open('Monthly');
    expect(screen.getByText(/PERIOD COVERED: Month of/)).toBeInTheDocument();
    const moses = within(rowOf('MOSES RODRIGUEZ')).getAllByRole('textbox');
    expect(moses.map((cell) => (cell as HTMLTextAreaElement).value)).toEqual(['MOSES RODRIGUEZ', '15,620.00', '18,677.36', '3,057.36', '119.57%', '']);
    expect(moses[1]).toHaveAttribute('data-locked');
    expect(moses[5]).not.toHaveAttribute('data-locked');
  });
});

describe("past technicians' logs", () => {
  it("show a past technician's log as the workbook kept it, with its own headings, to read", () => {
    render(<TechnicianLog canEdit from="2026-11-11" onChange={vi.fn()} technicianId="history:h1" technicians={[{ id: 'tech-1', name: 'Sample Technician' }]} to="2026-11-11" />);
    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['', 'Address', '', 'Job#', 'Labor Revenue Budget', 'Trip Charge']);
    expect(screen.getByText('100 Example Way - Zone 4 - Q4 Tenant Benefit Package')).toBeInTheDocument();
    expect(screen.getByText('Total').closest('tr')).toHaveClass('font-semibold');
    expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    expect(screen.queryByLabelText('First day')).not.toBeInTheDocument();
  });

  it('import the workbook the office chooses', () => {
    render(<ActualVsBudgetPage />);
    const file = new File(['xlsx'], 'THMP Scheduling Actual Vs Budget 2026.xlsx');
    fireEvent.change(screen.getByLabelText('The Actual vs Budget workbook'), { target: { files: [file] } });
    expect(queries.importHistory).toHaveBeenCalledWith(file, expect.anything());
  });

  it('cannot be imported without the right to change invoices', () => {
    permissions.allowed = false;
    render(<ActualVsBudgetPage />);
    expect(screen.queryByRole('button', { name: 'Import workbook' })).not.toBeInTheDocument();
  });
});

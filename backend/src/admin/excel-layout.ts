import {
  driveTimeTotal,
  firstName,
  hoursAndMinutes,
  hoursAndMinutesValue,
  monthWords,
  payrollPeriodWords,
  trackerFigures,
  weekWords,
  type RevenueDay,
  type RevenueDayTechnician,
  type RevenueLogDay,
  type RevenueMonthReport,
  type RevenueWeek,
} from '@texasrenters/shared';

import { formatNumber } from './workbook-reader';

/**
 * Actual vs Budget's sheets as tabs of the office's own workbook (2026-11-17,
 * the office: "everything should sync on this spreadsheet also"). Each tab is
 * named and laid out as the office named and laid out its own -- "Projected
 * Productivity_1117", "1111", "New 1111", "Nov. 2-6", "Month of October" --
 * and every cell shows what the console shows, so the page and the workbook
 * always say the same. A figure goes as a number with the workbook's own
 * format -- "$505.96", "(1,691.86)", "87.00%", "8h 25m" -- so Excel neither
 * guesses one nor turns a total into text (2026-11-17: written as text, Excel
 * showed "$0" beside "$0.00" and "-690" beside "-3,376.36").
 *
 * Pure: the figures go in, the cells come out. Writing them is the sync's.
 */

/** A cell: text, kept as text; or a number and the format Excel shows it in. */
export type ExcelCell = string | { value: number; format: string };

export interface ExcelTab {
  /** The tab's name, as the workbook names it. At most 31 characters, as Excel allows. */
  name: string;
  /** Every row, left to right. */
  rows: ExcelCell[][];
  /** Rows set in bold: titles, headings, Totals (0-based). */
  bold: number[];
  /** Each row's console record ("day|<technician>|<date>", "week|…", "month|…"), or null for a heading or a total. */
  keys: (string | null)[];
  /** The columns the office types in on this tab, by index: an edit made there in Excel comes back to the console. */
  editable: Record<number, ExcelEditableField>;
  /**
   * A technician's log tab is the office's own, with months of its rows: the
   * console's rows go below them, from this sheet row (0-based) down, and the
   * tab is never made, sized or headed by the console. Set when it is first
   * written; absent for a tab the console lays out from its first cell.
   */
  below?: { origin?: number };
  /** The bold rows are filled too: the log's Total rows, light blue as the office's are. */
  fill?: string;
}

/** What the office may type into a tab's cell, as the console stores it. */
export type ExcelEditableField =
  | 'budgetCents'
  | 'workSeconds'
  | 'projectionRemarks'
  | 'dailyRemarks'
  | 'trackerRemarks'
  | 'targetCents'
  | 'actualCents'
  | 'remarks'
  | LogEditableField;

/** The technician log's typed cells (the console's `SaveRevenueLogEntryInput`), by the workbook's columns. */
export const LOG_EDITABLE = {
  1: 'address',
  2: 'workOrder',
  3: 'jobNumber',
  4: 'driveTime',
  5: 'timeBudgeted',
  6: 'estimatedBudgetCents',
  7: 'arrival',
  8: 'leaving',
  10: 'workComplete',
  11: 'rescheduleRequired',
  12: 'rescheduleOn',
  13: 'laborCents',
  14: 'serviceCallFeeCents',
  15: 'materialsCents',
  16: 'invoiceNumber',
  17: 'postedInPw',
  18: 'notes',
} as const;
export type LogEditableField = (typeof LOG_EDITABLE)[keyof typeof LOG_EDITABLE];

export const dayKey = (technicianId: string, date: string) => `day|${technicianId}|${date}`;
export const weekKey = (technicianId: string, weekStart: string) => `week|${technicianId}|${weekStart}`;
export const monthKey = (technicianId: string, month: string) => `month|${technicianId}|${month}`;
/** A log row: a visit's ("log|visit|<visit>|<technician>|<day>"), or a row of the office's own ("log|entry|<entry>"). */
export const logKey = (row: { inspectionId: string | null; entryId: string | null; date: string }, technicianId: string) =>
  row.inspectionId ? `log|visit|${row.inspectionId}|${technicianId}|${row.date}` : row.entryId ? `log|entry|${row.entryId}` : null;
/** Headings above the rows, and a Total under them: none is anyone's record. */
const keysOf = (above: number, keys: string[], below = 1): (string | null)[] => [...Array<null>(above).fill(null), ...keys, ...Array<null>(below).fill(null)];

// The workbook's formats, as the office's own tabs have them.
const FORMAT = {
  dollars: '"$"#,##0.00;-"$"#,##0.00',
  wholeDollars: '"$"#,##0;-"$"#,##0',
  bracketDollars: '"$"#,##0.00;("$"#,##0.00)',
  bracketWholeDollars: '"$"#,##0;("$"#,##0)',
  accounting: '#,##0.00;(#,##0.00);"-"',
  percent: '0.00%',
  hours: '[h]"h "mm"m"',
  date: 'm/d/yyyy',
  // The log's own: "78.99", "-" for nothing billed, "5:36 PM".
  logMoney: '#,##0.00;-#,##0.00;"-"',
  clock: 'h:mm AM/PM',
} as const;

const money = (cents: number, format: string): ExcelCell => ({ value: Math.round(cents) / 100, format });
const dollars = (cents: number, options: { decimals?: 0 | 2; negative?: 'minus' | 'brackets' } = {}) =>
  money(cents, options.negative === 'brackets' ? (options.decimals === 0 ? FORMAT.bracketWholeDollars : FORMAT.bracketDollars) : options.decimals === 0 ? FORMAT.wholeDollars : FORMAT.dollars);
const accounting = (cents: number) => money(cents, FORMAT.accounting);
const percentText = (share: number | null): ExcelCell => (share === null || !Number.isFinite(share) ? '' : { value: share, format: FORMAT.percent });
/** Whole minutes, as the page shows them, in Excel's days. */
const secondsAsHours = (seconds: number): ExcelCell => ({ value: Math.round(seconds / 60) / 1440, format: FORMAT.hours });
const sheetDate = (day: string): ExcelCell => ({ value: (Date.parse(`${day}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000, format: FORMAT.date });
const dateWords = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}/${day.slice(0, 4)}`;

const clock = (time: string | null): ExcelCell => {
  const match = time ? /^(\d{2}):(\d{2})$/.exec(time) : null;
  return match ? { value: (Number(match[1]) * 60 + Number(match[2])) / 1440, format: FORMAT.clock } : '';
};
const logMoney = (cents: number | null): ExcelCell => (cents === null ? '' : money(cents, FORMAT.logMoney));
const yesNo = (value: boolean | null) => (value === null ? '' : value ? 'Yes' : 'No');
/** A day the office typed as one ("2026-11-12") is a date; anything else it typed stays as typed. */
const dayOrText = (value: string | null): ExcelCell => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? sheetDate(value) : asText(value));

/** What a cell shows in Excel: its text, or its number in its format. */
export const cellText = (cell: ExcelCell | undefined) => (cell === undefined ? '' : typeof cell === 'string' ? cell.replace(/^'/, '') : formatNumber(cell.value, cell.format));

const MMDD = (date: string) => `${date.slice(5, 7)}${date.slice(8, 10)}`;
const MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
const sum = <T>(rows: readonly T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);

/**
 * A cell's text as it may go into Excel: something a person typed that begins
 * as a formula would -- "=", "+", "-", "@" -- is kept as text with Excel's
 * leading apostrophe, so a remark can never run as a formula in the workbook.
 * Figures the console worked out ("-$157.98", "-") are numbers and go as they are.
 */
export const asText = (typed: string | null | undefined) => {
  const text = typed ?? '';
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};

// ── Next Day's Projected Productivity ───────────────────────────────────────

export function projectionTab(day: RevenueDay): ExcelTab {
  const rows: ExcelCell[][] = [
    ["Next Day's Projected Productivity"],
    ['', 'Date:', sheetDate(day.date)],
    ['Technician', 'Drive time', 'Billable hours', 'Projected revenue', 'Remarks'],
  ];
  for (const row of day.technicians)
    rows.push([firstName(row.technician.name), row.driveTime, row.billableTime, dollars(row.projectedCents), asText(row.projectionRemarks)]);
  rows.push([
    'Total',
    driveTimeTotal(day.technicians.map((row) => row.driveTime)),
    hoursAndMinutes(sum(day.technicians, (row) => hoursAndMinutesValue(row.billableTime))),
    dollars(sum(day.technicians, (row) => row.projectedCents), { decimals: 0, negative: 'brackets' }),
    '',
  ]);
  return {
    name: `Projected Productivity_${MMDD(day.date)}`,
    rows,
    bold: [0, 1, 2, rows.length - 1],
    keys: keysOf(3, day.technicians.map((row) => dayKey(row.technician.id, day.date))),
    editable: { 4: 'projectionRemarks' },
  };
}

// ── ACTUAL VS PROJECTED REVENUE ─────────────────────────────────────────────

export function dailyTab(day: RevenueDay): ExcelTab {
  const rows: ExcelCell[][] = [
    ['ACTUAL VS PROJECTED REVENUE'],
    [`Date: ${dateWords(day.date)}`],
    [
      'TECHNICIAN',
      'BUDGETED REVENUE',
      'PROJECTED REVENUE',
      'ACTUAL REVENUE',
      'DIFFERENCE (ACTUAL REVENUE - PROJECTED REVENUE)',
      '% (ACTUAL REVENUE / BUDGETED REVENUE)',
      'NO. OF WORK HOURS',
      'REMARKS',
    ],
  ];
  for (const row of day.technicians)
    rows.push([
      row.technician.name.toUpperCase(),
      dollars(row.budgetCents, { decimals: 0 }),
      dollars(row.projectedCents, { decimals: 0 }),
      dollars(row.actualCents),
      dollars(row.actualCents - row.projectedCents),
      percentText(row.budgetCents ? row.actualCents / row.budgetCents : null),
      row.workSeconds === null ? '' : secondsAsHours(row.workSeconds),
      asText(row.dailyRemarks),
    ]);
  const budget = sum(day.technicians, (row) => row.budgetCents);
  const actual = sum(day.technicians, (row) => row.actualCents);
  rows.push([
    'TOTAL',
    dollars(budget, { decimals: 0, negative: 'brackets' }),
    dollars(sum(day.technicians, (row) => row.projectedCents), { decimals: 0, negative: 'brackets' }),
    dollars(actual, { negative: 'brackets' }),
    dollars(sum(day.technicians, (row) => row.actualCents - row.projectedCents), { negative: 'brackets' }),
    percentText(budget ? actual / budget : null),
    secondsAsHours(sum(day.technicians, (row) => row.workSeconds ?? 0)),
    '',
  ]);
  return {
    name: MMDD(day.date),
    rows,
    bold: [0, 1, 2, rows.length - 1],
    keys: keysOf(3, day.technicians.map((row) => dayKey(row.technician.id, day.date))),
    editable: { 1: 'budgetCents', 6: 'workSeconds', 7: 'dailyRemarks' },
  };
}

// ── REVENUE TRACKER ─────────────────────────────────────────────────────────

export function trackerTab(day: RevenueDay): ExcelTab {
  const money = (cents: number) => dollars(cents, { negative: 'brackets' });
  const date = dateWords(day.date);
  const blank = (count: number) => Array.from({ length: count }, () => '');
  const rows: ExcelCell[][] = [
    [`DATE:${date}`, '', 'REVENUE TRACKER'],
    ['', '', `DAILY PROJECTED REVENUE`, '', '', `DAILY ACTUAL REVENUE: ${date}`, ...blank(6), `As of ${date} for Payroll Period to Date (${payrollPeriodWords(day.payrollPeriod)})`],
    [
      'Technician',
      'Budgeted Daily Revenue (Regular 8 hour-work)',
      'Drive Time',
      'Billable Hours',
      'Projected Revenue',
      'Actual Revenue',
      "Tech's Work Time",
      "Tech's OT Hour",
      'OT Budget Add-On',
      "Adjusted Budget due to Tech's OT (Final Budget)",
      'Actual − Final Budget',
      '% of Budget',
      'UP-TO-DATE NO. OF REGULAR WORK HOURS',
      'UP-TO-DATE NO. OF OT HOURS',
      'UP-TO DATE BUDGETED REVENUE',
      'UP-TO DATE ACTUAL REVENUE',
      '% of Budget',
      'Remarks',
    ],
  ];
  const figures = day.technicians.map((row) => trackerFigures(row));
  day.technicians.forEach((row: RevenueDayTechnician, index) => {
    const figure = figures[index]!;
    rows.push([
      row.technician.name,
      money(row.budgetCents),
      row.driveTime,
      row.billableTime,
      money(row.projectedCents),
      money(row.actualCents),
      row.workSeconds === null ? '' : secondsAsHours(row.workSeconds),
      secondsAsHours(figure.overtimeSeconds),
      money(figure.addOnCents),
      money(figure.finalBudgetCents),
      money(figure.overCents),
      percentText(figure.share),
      secondsAsHours(row.period.regularSeconds),
      secondsAsHours(row.period.overtimeSeconds),
      money(row.period.budgetedCents),
      money(row.period.actualCents),
      percentText(row.period.budgetedCents ? row.period.actualCents / row.period.budgetedCents : null),
      asText(row.trackerRemarks),
    ]);
  });
  const total = (pick: (row: RevenueDayTechnician, index: number) => number) => day.technicians.reduce((all, row, index) => all + pick(row, index), 0);
  const actual = total((row) => row.actualCents);
  const final = total((_, index) => figures[index]!.finalBudgetCents);
  const periodBudget = total((row) => row.period.budgetedCents);
  const periodActual = total((row) => row.period.actualCents);
  rows.push([
    'Total',
    money(total((row) => row.budgetCents)),
    driveTimeTotal(day.technicians.map((row) => row.driveTime)),
    hoursAndMinutes(total((row) => hoursAndMinutesValue(row.billableTime))),
    money(total((row) => row.projectedCents)),
    money(actual),
    secondsAsHours(total((row) => row.workSeconds ?? 0)),
    secondsAsHours(total((_, index) => figures[index]!.overtimeSeconds)),
    money(total((_, index) => figures[index]!.addOnCents)),
    money(final),
    money(total((_, index) => figures[index]!.overCents)),
    percentText(final ? actual / final : null),
    secondsAsHours(total((row) => row.period.regularSeconds)),
    secondsAsHours(total((row) => row.period.overtimeSeconds)),
    money(periodBudget),
    money(periodActual),
    percentText(periodBudget ? periodActual / periodBudget : null),
    '',
  ]);
  return {
    name: `New ${MMDD(day.date)}`,
    rows,
    bold: [0, 1, 2, rows.length - 1],
    keys: keysOf(3, day.technicians.map((row) => dayKey(row.technician.id, day.date))),
    editable: { 1: 'budgetCents', 6: 'workSeconds', 17: 'trackerRemarks' },
  };
}

// ── The weekly and monthly reports ──────────────────────────────────────────

const PERIOD_HEADERS = ['TECHNICIAN', 'TARGET REVENUE', 'ACTUAL REVENUE', 'DIFFERENCE (ACTUAL REVENUE - TARGET)', '% (ACTUAL REVENUE / TARGET REVENUE)', 'REMARKS'];

function periodRows(title: string, technicians: { technician: { name: string }; targetCents: number; actualCents: number; remarks: string | null }[]): ExcelTab['rows'] {
  const rows: ExcelCell[][] = [[`PERIOD COVERED: ${title}`], PERIOD_HEADERS];
  for (const row of technicians)
    rows.push([
      row.technician.name.toUpperCase(),
      accounting(row.targetCents),
      accounting(row.actualCents),
      accounting(row.actualCents - row.targetCents),
      percentText(row.targetCents ? row.actualCents / row.targetCents : null),
      asText(row.remarks),
    ]);
  const target = sum(technicians, (row) => row.targetCents);
  const actual = sum(technicians, (row) => row.actualCents);
  rows.push(['TOTAL', accounting(target), accounting(actual), accounting(actual - target), percentText(target ? actual / target : null), '']);
  return rows;
}

/** A week's tab: "Nov. 2-6", as the workbook names its weekly tabs. */
export function weekTabName(week: { from: string; to: string }): string {
  // "NOVEMBER 2-6, 2026": its working days. A week never leaves its month.
  const days = /\s([\d-]+),/.exec(weekWords(week))?.[1] ?? '';
  return `${MONTHS[Number(week.from.slice(5, 7)) - 1]} ${days}`;
}

export function weekTab(week: RevenueWeek): ExcelTab {
  const rows = periodRows(weekWords(week), week.technicians);
  return {
    name: weekTabName(week),
    rows,
    bold: [0, 1, rows.length - 1],
    keys: keysOf(2, week.technicians.map((row) => weekKey(row.technician.id, week.from))),
    editable: { 1: 'targetCents', 2: 'actualCents', 5: 'remarks' },
  };
}

/** A month's figures add up its weeks: only its remarks are typed. */
export function monthTab(report: RevenueMonthReport): ExcelTab {
  const rows = periodRows(monthWords(report.month), report.technicians);
  return {
    name: monthWords(report.month),
    rows,
    bold: [0, 1, rows.length - 1],
    keys: keysOf(2, report.technicians.map((row) => monthKey(row.technician.id, report.month))),
    editable: { 5: 'remarks' },
  };
}

/** The workbook's column letter for a 0-based column. */
export function columnLetter(index: number): string {
  let letters = '';
  for (let left = index + 1; left > 0; left = Math.floor((left - 1) / 26)) letters = String.fromCharCode(65 + ((left - 1) % 26)) + letters;
  return letters;
}

// ── A technician's log ──────────────────────────────────────────────────────

/**
 * A technician's own tab -- "Amy", "Kevin" -- as the office keeps it: a row
 * a visit in the workbook's 19 columns, and a Total row closing each day. The
 * console's rows go under the office's (see `below`), from the sync's first
 * day; the tab's headings and its rows before that day are the office's.
 */
export function logTab(name: string, technicianId: string, days: readonly RevenueLogDay[]): ExcelTab {
  const rows: ExcelCell[][] = [];
  const keys: (string | null)[] = [];
  const bold: number[] = [];
  for (const day of days) {
    for (const row of day.rows) {
      rows.push([
        sheetDate(row.date),
        asText(row.address),
        asText(row.workOrder),
        asText(row.jobNumber),
        asText(row.driveTime),
        asText(row.timeBudgeted),
        logMoney(row.estimatedBudgetCents),
        clock(row.arrival),
        clock(row.leaving),
        row.arrival && row.leaving ? secondsAsHours(row.actualSeconds ?? 0) : '',
        yesNo(row.workComplete),
        yesNo(row.rescheduleRequired),
        row.rescheduleOn ? sheetDate(row.rescheduleOn) : '',
        logMoney(row.laborCents),
        logMoney(row.serviceCallFeeCents),
        logMoney(row.materialsCents),
        asText(row.invoiceNumber),
        dayOrText(row.postedInPw),
        asText(row.notes),
      ]);
      keys.push(logKey(row, technicianId));
    }
    const total = day.totals;
    bold.push(rows.length);
    rows.push([
      'Total', '', '', '', total.driveTime, total.timeBudgeted, logMoney(total.estimatedBudgetCents), '', '', secondsAsHours(total.actualSeconds),
      '', '', '', logMoney(total.laborCents), logMoney(total.serviceCallFeeCents), logMoney(total.materialsCents), '', '', '',
    ]);
    keys.push(null);
  }
  return { name, rows, bold, keys, editable: { ...LOG_EDITABLE }, below: {}, fill: '#DDEBF7' };
}

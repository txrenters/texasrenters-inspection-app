/**
 * Checking the console against Xero (2026-11-10, phase 5 of the multi-company
 * plan): one month of a company's invoices, as the console has them, against
 * what that organisation's books in Xero hold. Run only when somebody asks --
 * a read of Xero's invoices, one call per 100 -- and kept, so the page shows
 * the latest check of the month without asking Xero again.
 */

/**
 * What can differ, invoice by invoice:
 * - NOT_SENT: the console's, not in Xero yet (held back, refused, or waiting).
 * - MISSING_IN_XERO: sent, but Xero has no invoice of that id this month --
 *   deleted there, or dated another month.
 * - ONLY_IN_XERO: in Xero, not from the console -- made there by hand, or by
 *   another app.
 * - STATUS: voided in one and not the other.
 * - TOTAL: the amounts differ.
 * - PAID: what has been paid differs -- a payment recorded in only one of them.
 */
export const XERO_DIFFERENCE_KINDS = ['NOT_SENT', 'MISSING_IN_XERO', 'ONLY_IN_XERO', 'STATUS', 'TOTAL', 'PAID'] as const;
export type XeroDifferenceKind = (typeof XERO_DIFFERENCE_KINDS)[number];

export const XERO_DIFFERENCE_LABEL: Record<XeroDifferenceKind, string> = {
  NOT_SENT: 'Not sent yet',
  MISSING_IN_XERO: 'Not in Xero',
  ONLY_IN_XERO: 'Only in Xero',
  STATUS: 'Status differs',
  TOTAL: 'Total differs',
  PAID: 'Paid differs',
};

export interface XeroDifference {
  kind: XeroDifferenceKind;
  /** The console's invoice; null for one only in Xero. */
  invoiceId: string | null;
  number: string | null;
  clientName: string;
  /** What the console has, in words. */
  here: string;
  /** What Xero has, in words. */
  xero: string;
}

export interface XeroCheckCounts {
  /** The console's invoices this month that belong to this company and are meant for Xero. */
  console: number;
  /** Xero's sales invoices this month, approved, paid or voided. */
  xero: number;
  /** In both, and the same. */
  matching: number;
  /** In both, and not the same. */
  different: number;
  notSent: number;
  missingInXero: number;
  onlyInXero: number;
}

export interface XeroCheckView {
  tenantId: string;
  /** `YYYY-MM` */
  month: string;
  /** Null until this month was checked. */
  ranAt: string | null;
  ranBy: string | null;
  counts: XeroCheckCounts | null;
  differences: XeroDifference[];
  /** More differed than are kept, or Xero held more invoices than one check reads. */
  truncated: boolean;
  /** The calls to Xero the check took. */
  calls: number;
  /** The organisation's start date: before it, the console sends nothing. */
  sendFrom: string | null;
}

export interface RunXeroCheckInput {
  /** `YYYY-MM` */
  month: string;
}

/** The most differences one check keeps. */
export const MAX_XERO_CHECK_DIFFERENCES = 200;
/** The most invoices one check reads from Xero: ten calls of 100. */
export const MAX_XERO_CHECK_INVOICES = 1000;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The months that can be checked: this one and the eleven before, newest first. `today` is `YYYY-MM-DD`. */
export function checkMonths(today: string, count = 12): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return Array.from({ length: count }, (_, back) => {
    const index = year * 12 + (month - 1) - back;
    return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
  });
}

/** Why a month cannot be checked, in words; null when it can. */
export function checkMonthProblem(month: string, today: string): string | null {
  if (!MONTH.test(month)) return 'Choose a month.';
  if (month > today.slice(0, 7)) return 'A month still to come has nothing to check.';
  return null;
}

/** "November 2026". */
export function checkMonthLabel(month: string): string {
  const match = MONTH.exec(month);
  if (!match) return month;
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

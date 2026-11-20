/**
 * Purchasing Setup (2026-11-20, part 5a of the NAV-style requisition plan),
 * as the approved PurchasingSetup board draws it: the office's approval steps
 * by amount, its document numbers, and the rules for files on a requisition.
 * Kept by a system admin or a Purchasing admin (`purchasing:setup`); every
 * change is audited with what it was and what it became.
 *
 * Roles and companies (5b) and the code lists and requisition page (5c) come
 * after. Nothing here calls anything billed.
 *
 * This file imports nothing from purchasing.ts, which imports it.
 */
import { formatMoney } from './invoices.js';

// ── Approval steps ───────────────────────────────────────────────────────────

/**
 * Who approves a step: anybody who may approve requisitions, or only somebody
 * who may approve any amount. "An approver whose own limit covers it" comes
 * with each person's limit, in part 5b.
 */
export const APPROVAL_STEP_APPROVERS = ['ANY_APPROVER', 'ANY_AMOUNT'] as const;
export type ApprovalStepApprover = (typeof APPROVAL_STEP_APPROVERS)[number];
export const APPROVAL_STEP_APPROVER_LABEL: Record<ApprovalStepApprover, string> = {
  ANY_APPROVER: 'Any Approver',
  ANY_AMOUNT: 'Approver, any amount',
};

/** One step: requisitions and orders up to `upToCents` (the last has none) need this approver and this many quotes. */
export interface ApprovalStep {
  /** The step's top, inclusive; null on the last step, which has no limit. */
  upToCents: number | null;
  approver: ApprovalStepApprover;
  quotesNeeded: number;
  /** Days a requisition waits before its approvers are reminded, once; null for no reminder. */
  reminderDays: number | null;
}

export const MOST_APPROVAL_STEPS = 6;
export const MOST_REMINDER_DAYS = 14;
/** The board's Reminder choices. */
export const REMINDER_DAY_CHOICES: readonly (number | null)[] = [null, 1, 2, 3, 5, 7, 14];
export const reminderSaying = (days: number | null) => (days === null ? 'No reminder' : `After ${days} day${days === 1 ? '' : 's'}`);

/**
 * What the office had before steps: one limit, and quotes above it. Its
 * approvers approve up to the limit, somebody who may approve any amount above
 * it, and nobody is reminded.
 */
export function stepsFromLimit(approvalLimitCents: number, quotesAboveLimit: number): ApprovalStep[] {
  return [
    { upToCents: approvalLimitCents, approver: 'ANY_APPROVER', quotesNeeded: 0, reminderDays: null },
    { upToCents: null, approver: 'ANY_AMOUNT', quotesNeeded: quotesAboveLimit, reminderDays: null },
  ];
}

/** The step an amount falls in. Steps are checked, so the last always takes what the others do not. */
export function approvalStepFor(totalCents: number, steps: readonly ApprovalStep[]): ApprovalStep {
  return steps.find((step) => step.upToCents === null || totalCents <= step.upToCents) ?? steps.at(-1)!;
}

/** Where a step starts: a cent above the one before. */
export const approvalStepFromCents = (steps: readonly ApprovalStep[], index: number) => (index === 0 ? 0 : (steps[index - 1]!.upToCents ?? 0) + 1);

/** "$500.01 to $5,000.00", "$5,000.01 and up". */
export function approvalStepRange(steps: readonly ApprovalStep[], index: number): string {
  const from = formatMoney(approvalStepFromCents(steps, index));
  const upTo = steps[index]!.upToCents;
  return upTo === null ? `${from} and up` : `${from} to ${formatMoney(upTo)}`;
}

/** Who approves an amount, as the lists say it. */
export const approverSaying = (step: ApprovalStep) => (step.approver === 'ANY_AMOUNT' ? 'Somebody who may approve any amount' : 'An approver');

/** Why these steps cannot be kept, in the office's words; null when they can. */
export function approvalStepsProblem(steps: readonly ApprovalStep[], mostQuotes: number): string | null {
  if (!steps.length) return 'Keep at least one step.';
  if (steps.length > MOST_APPROVAL_STEPS) return `At most ${MOST_APPROVAL_STEPS} steps.`;
  let below = 0;
  let anyAmount = false;
  for (const [index, step] of steps.entries()) {
    const last = index === steps.length - 1;
    if (last ? step.upToCents !== null : step.upToCents === null) return last ? 'The last step has no top: it takes every larger amount.' : 'Only the last step can be without a top.';
    if (step.upToCents !== null && (!Number.isSafeInteger(step.upToCents) || step.upToCents <= below)) return `Each step goes higher than the one before it: ${approvalStepRange(steps, index)} does not.`;
    if (!APPROVAL_STEP_APPROVERS.includes(step.approver)) return 'Choose who approves each step.';
    // A larger amount is never approved by more people than a smaller one.
    if (anyAmount && step.approver !== 'ANY_AMOUNT') return 'Once a step needs somebody who may approve any amount, every higher step does too.';
    anyAmount ||= step.approver === 'ANY_AMOUNT';
    if (!Number.isInteger(step.quotesNeeded) || step.quotesNeeded < 0 || step.quotesNeeded > mostQuotes) return `Quotes needed is a whole number from 0 to ${mostQuotes}.`;
    if (step.reminderDays !== null && (!Number.isInteger(step.reminderDays) || step.reminderDays < 1 || step.reminderDays > MOST_REMINDER_DAYS))
      return `A reminder is after 1 to ${MOST_REMINDER_DAYS} days, or none.`;
    below = step.upToCents ?? below;
  }
  return null;
}

// ── Numbers ──────────────────────────────────────────────────────────────────

/** Each kind of document the office numbers, with the prefix and digits it starts with (what the console wrote before Setup). */
export const DOCUMENT_SERIES = [
  { kind: 'PR', label: 'Purchase requisition', prefix: 'PR-', digits: 5 },
  { kind: 'PO', label: 'Purchase order', prefix: 'PO-', digits: 4 },
  { kind: 'RCV', label: 'Receipt', prefix: 'RCV-', digits: 4 },
  { kind: 'WD', label: 'Withdrawal', prefix: 'WD-', digits: 4 },
  { kind: 'RT', label: 'Return', prefix: 'RT-', digits: 4 },
  { kind: 'TR', label: 'Transfer', prefix: 'TR-', digits: 4 },
  { kind: 'CNT', label: 'Count', prefix: 'CNT-', digits: 4 },
  { kind: 'V', label: 'Vendor', prefix: 'V-', digits: 5 },
] as const;
export type DocumentSeriesKind = (typeof DOCUMENT_SERIES)[number]['kind'];
export const DOCUMENT_SERIES_KINDS = DOCUMENT_SERIES.map((series) => series.kind) as readonly DocumentSeriesKind[];
export const isDocumentSeriesKind = (value: string): value is DocumentSeriesKind => (DOCUMENT_SERIES_KINDS as readonly string[]).includes(value);
export const defaultSeries = (kind: DocumentSeriesKind) => DOCUMENT_SERIES.find((series) => series.kind === kind)!;

export const LEAST_SERIES_DIGITS = 3;
export const MOST_SERIES_DIGITS = 8;
export const MOST_PREFIX_LENGTH = 8;

/** "PR-00043". */
export const formatDocumentNumber = (prefix: string, digits: number, sequence: number) => `${prefix}${String(sequence).padStart(digits, '0')}`;

export interface DocumentSeriesSetting {
  kind: DocumentSeriesKind;
  label: string;
  prefix: string;
  digits: number;
  /** The number the next one takes. */
  next: number;
}

export interface SaveDocumentSeriesInput {
  prefix: string;
  digits: number;
  next: number;
}

/**
 * Why a series cannot be saved; null when it can. A next number only goes up,
 * so no number is ever given twice, and it must fit the digits.
 */
export function documentSeriesProblem(input: SaveDocumentSeriesInput, currentNext: number): string | null {
  if (!new RegExp(`^[A-Z0-9][A-Z0-9-]{0,${MOST_PREFIX_LENGTH - 1}}$`).test(input.prefix))
    return `A prefix is 1 to ${MOST_PREFIX_LENGTH} capital letters, digits or dashes, starting with a letter or digit.`;
  if (!Number.isInteger(input.digits) || input.digits < LEAST_SERIES_DIGITS || input.digits > MOST_SERIES_DIGITS) return `Digits is ${LEAST_SERIES_DIGITS} to ${MOST_SERIES_DIGITS}.`;
  if (!Number.isSafeInteger(input.next) || input.next < 1) return 'The next number is a whole number from 1.';
  if (input.next < currentNext) return `A next number can only go up: it is ${currentNext} now.`;
  if (input.next >= 10 ** input.digits) return `${input.digits} digits end at ${10 ** input.digits - 1}.`;
  return null;
}

// ── Files on a requisition ───────────────────────────────────────────────────

/** The kinds of file the office may allow, and what each covers, by what a file's first bytes say it is. */
export const FILE_GROUPS = {
  PDF: { label: 'PDF', types: ['application/pdf'], accept: '.pdf' },
  PICTURES: { label: 'pictures (JPG, PNG, HEIC)', types: ['image/jpeg', 'image/png', 'image/heic'], accept: '.jpg,.jpeg,.png,.heic' },
  WORD: { label: 'Word', types: ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'], accept: '.doc,.docx' },
  EXCEL: { label: 'Excel', types: ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], accept: '.xls,.xlsx' },
} as const;
export type FileGroup = keyof typeof FILE_GROUPS;
export const FILE_GROUP_KEYS = Object.keys(FILE_GROUPS) as FileGroup[];

/** The board's Largest file choices. 20 MB is the most the server takes in one upload. */
export const FILE_SIZE_CHOICES = [5_000_000, 10_000_000, 20_000_000] as const;
export const MOST_FILES_A_REQUISITION = 50;

export const FILE_REMOVALS = ['UNTIL_SENT', 'UNTIL_ORDERED'] as const;
export type FileRemoval = (typeof FILE_REMOVALS)[number];
export const FILE_REMOVAL_LABEL: Record<FileRemoval, string> = {
  UNTIL_SENT: 'Who attached it, until it is sent',
  UNTIL_ORDERED: 'Who attached it, until it is ordered',
};

export interface RequisitionFileRules {
  groups: FileGroup[];
  maxBytes: number;
  maxFiles: number;
  /** Above this a requisition is not sent for approval until a file -- the quote -- is attached; null never. */
  quoteFileAboveCents: number | null;
  removal: FileRemoval;
}

/** What the office had before Setup: every kind, 20 MB, 20 files, no quote asked for, removed by who attached it until it is sent. */
export const DEFAULT_FILE_RULES: RequisitionFileRules = { groups: [...FILE_GROUP_KEYS], maxBytes: 20_000_000, maxFiles: 20, quoteFileAboveCents: null, removal: 'UNTIL_SENT' };

/** The group a file's sniffed type is in; null for one no group takes. */
export const fileGroupOf = (contentType: string): FileGroup | null => FILE_GROUP_KEYS.find((group) => (FILE_GROUPS[group].types as readonly string[]).includes(contentType)) ?? null;
/** "PDF, pictures (JPG, PNG, HEIC), Word, Excel". */
export const fileGroupsSaying = (groups: readonly FileGroup[]) => FILE_GROUP_KEYS.filter((group) => groups.includes(group)).map((group) => FILE_GROUPS[group].label).join(', ');
/** For a file picker. */
export const fileGroupsAccept = (groups: readonly FileGroup[]) => FILE_GROUP_KEYS.filter((group) => groups.includes(group)).map((group) => FILE_GROUPS[group].accept).join(',');

export function fileRulesProblem(rules: RequisitionFileRules): string | null {
  if (!rules.groups.length || rules.groups.some((group) => !FILE_GROUP_KEYS.includes(group))) return 'Allow at least one kind of file.';
  if (!(FILE_SIZE_CHOICES as readonly number[]).includes(rules.maxBytes)) return 'Choose the largest file from the list.';
  if (!Number.isInteger(rules.maxFiles) || rules.maxFiles < 1 || rules.maxFiles > MOST_FILES_A_REQUISITION) return `Most files is a whole number from 1 to ${MOST_FILES_A_REQUISITION}.`;
  if (rules.quoteFileAboveCents !== null && (!Number.isSafeInteger(rules.quoteFileAboveCents) || rules.quoteFileAboveCents < 0)) return 'The amount for a quote is a dollar amount, or blank for never.';
  if (!FILE_REMOVALS.includes(rules.removal)) return 'Choose who may remove a file.';
  return null;
}

// ── The page ─────────────────────────────────────────────────────────────────

export interface PurchasingApprovals {
  steps: ApprovalStep[];
  /** Email the approvers who may approve it when a requisition is sent for approval. */
  emailApprovers: boolean;
  /** Every change to an approved purchase order goes back for approval; off, only a change that raises it or adds a line does. */
  reapproveChangedOrders: boolean;
}

export type SavePurchasingApprovalsInput = PurchasingApprovals;
export type SaveRequisitionFileRulesInput = RequisitionFileRules;

export interface PurchasingSetup {
  approvals: PurchasingApprovals;
  numbers: DocumentSeriesSetting[];
  files: RequisitionFileRules;
}

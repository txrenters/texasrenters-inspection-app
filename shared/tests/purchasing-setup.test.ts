import { describe, expect, it } from 'vitest';

import { orderChangeNeedsApproval } from '../src/contracts/purchase-orders';
import {
  DEFAULT_FILE_RULES,
  approvalStepFor,
  approvalStepRange,
  approvalStepsProblem,
  documentSeriesProblem,
  fileGroupOf,
  fileGroupsAccept,
  fileGroupsSaying,
  fileRulesProblem,
  formatDocumentNumber,
  reminderSaying,
  stepsFromLimit,
  type ApprovalStep,
} from '../src/contracts/purchasing-setup';

// Purchasing Setup, part 5a (2026-11-20). The board's steps; every figure invented.
const STEPS: ApprovalStep[] = [
  { upToCents: 50000, approver: 'ANY_APPROVER', quotesNeeded: 0, reminderDays: 1 },
  { upToCents: 500000, approver: 'ANY_APPROVER', quotesNeeded: 1, reminderDays: 1 },
  { upToCents: null, approver: 'ANY_AMOUNT', quotesNeeded: 2, reminderDays: 2 },
];

describe('approval steps', () => {
  it('put an amount in the step whose top it does not pass, the last taking the rest', () => {
    expect(approvalStepFor(0, STEPS)).toBe(STEPS[0]);
    expect(approvalStepFor(50000, STEPS)).toBe(STEPS[0]);
    expect(approvalStepFor(50001, STEPS)).toBe(STEPS[1]);
    expect(approvalStepFor(500000, STEPS)).toBe(STEPS[1]);
    expect(approvalStepFor(99_999_999, STEPS)).toBe(STEPS[2]);
  });

  it('say their range from a cent above the step before', () => {
    expect(STEPS.map((_, index) => approvalStepRange(STEPS, index))).toEqual(['$0.00 to $500.00', '$500.01 to $5,000.00', '$5,000.01 and up']);
    expect([null, 1, 2].map(reminderSaying)).toEqual(['No reminder', 'After 1 day', 'After 2 days']);
  });

  it('read the office from before Setup as two steps: approvers to the limit, any amount above it with its quotes', () => {
    expect(stepsFromLimit(50000, 2)).toEqual([
      { upToCents: 50000, approver: 'ANY_APPROVER', quotesNeeded: 0, reminderDays: null },
      { upToCents: null, approver: 'ANY_AMOUNT', quotesNeeded: 2, reminderDays: null },
    ]);
  });

  it('are kept only when they climb, end without a top, and never ask fewer people to approve more', () => {
    expect(approvalStepsProblem(STEPS, 10)).toBeNull();
    expect(approvalStepsProblem([], 10)).toBe('Keep at least one step.');
    expect(approvalStepsProblem([{ ...STEPS[2]!, approver: 'ANY_APPROVER' }], 10)).toBeNull();
    expect(approvalStepsProblem(STEPS.slice(0, 2), 10)).toBe('The last step has no top: it takes every larger amount.');
    expect(approvalStepsProblem([{ ...STEPS[0]!, upToCents: null }, STEPS[2]!], 10)).toBe('Only the last step can be without a top.');
    expect(approvalStepsProblem([STEPS[1]!, STEPS[0]!, STEPS[2]!], 10)).toBe('Each step goes higher than the one before it: $5,000.01 to $500.00 does not.');
    expect(approvalStepsProblem([{ ...STEPS[0]!, approver: 'ANY_AMOUNT' }, STEPS[1]!, STEPS[2]!], 10)).toBe(
      'Once a step needs somebody who may approve any amount, every higher step does too.',
    );
    expect(approvalStepsProblem([{ ...STEPS[0]!, quotesNeeded: 11 }, STEPS[2]!], 10)).toBe('Quotes needed is a whole number from 0 to 10.');
    expect(approvalStepsProblem([{ ...STEPS[0]!, reminderDays: 0 }, STEPS[2]!], 10)).toBe('A reminder is after 1 to 14 days, or none.');
    expect(approvalStepsProblem(Array.from({ length: 7 }, (_, index) => ({ ...STEPS[0]!, upToCents: index === 6 ? null : (index + 1) * 100 })), 10)).toBe('At most 6 steps.');
  });
});

describe('document numbers', () => {
  it('are the prefix and the number to its digits', () => {
    expect(formatDocumentNumber('PR-', 5, 43)).toBe('PR-00043');
    expect(formatDocumentNumber('REQ', 3, 1234)).toBe('REQ1234');
  });

  it('only go up, and fit their digits', () => {
    const ok = { prefix: 'PR-', digits: 5, next: 43 };
    expect(documentSeriesProblem(ok, 43)).toBeNull();
    expect(documentSeriesProblem({ ...ok, next: 42 }, 43)).toBe('A next number can only go up: it is 43 now.');
    expect(documentSeriesProblem({ ...ok, next: 100000 }, 43)).toBe('5 digits end at 99999.');
    expect(documentSeriesProblem({ ...ok, prefix: 'pr-' }, 43)).toBe('A prefix is 1 to 8 capital letters, digits or dashes, starting with a letter or digit.');
    expect(documentSeriesProblem({ ...ok, prefix: '-PR' }, 43)).not.toBeNull();
    expect(documentSeriesProblem({ ...ok, prefix: 'PURCHASE-' }, 43)).not.toBeNull();
    expect(documentSeriesProblem({ ...ok, digits: 2 }, 43)).toBe('Digits is 3 to 8.');
  });
});

describe('files on a requisition', () => {
  it('are allowed by kind, said and picked as the office allows them', () => {
    expect(fileGroupOf('image/heic')).toBe('PICTURES');
    expect(fileGroupOf('application/zip')).toBeNull();
    expect(fileGroupsSaying(DEFAULT_FILE_RULES.groups)).toBe('PDF, pictures (JPG, PNG, HEIC), Word, Excel');
    expect(fileGroupsSaying(['EXCEL', 'PDF'])).toBe('PDF, Excel');
    expect(fileGroupsAccept(['PDF', 'WORD'])).toBe('.pdf,.doc,.docx');
  });

  it('are kept only as the board offers them', () => {
    expect(fileRulesProblem(DEFAULT_FILE_RULES)).toBeNull();
    expect(fileRulesProblem({ ...DEFAULT_FILE_RULES, groups: [] })).toBe('Allow at least one kind of file.');
    expect(fileRulesProblem({ ...DEFAULT_FILE_RULES, maxBytes: 25_000_000 })).toBe('Choose the largest file from the list.');
    expect(fileRulesProblem({ ...DEFAULT_FILE_RULES, maxFiles: 51 })).toBe('Most files is a whole number from 1 to 50.');
    expect(fileRulesProblem({ ...DEFAULT_FILE_RULES, quoteFileAboveCents: -1 })).not.toBeNull();
  });
});

describe('a change to an approved order (2026-11-20)', () => {
  const before = { totalCents: 20005, itemIds: ['filter', 'battery'], vendorId: 'hill' };
  it('goes back for approval when it raises the total, adds an item or changes vendor, or always when the office says so', () => {
    expect(orderChangeNeedsApproval(before, { ...before, totalCents: 18000, itemIds: ['filter'] }, false)).toBe(false);
    expect(orderChangeNeedsApproval(before, before, false)).toBe(false);
    expect(orderChangeNeedsApproval(before, { ...before, totalCents: 20006 }, false)).toBe(true);
    expect(orderChangeNeedsApproval(before, { ...before, totalCents: 15000, itemIds: ['filter', 'glue'] }, false)).toBe(true);
    expect(orderChangeNeedsApproval(before, { ...before, totalCents: 15000, vendorId: 'alamo' }, false)).toBe(true);
    expect(orderChangeNeedsApproval(before, { ...before, totalCents: 18000, itemIds: ['filter'] }, true)).toBe(true);
  });
});

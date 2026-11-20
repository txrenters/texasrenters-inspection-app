import { describe, expect, it } from 'vitest';

import {
  PURCHASING_ROLES,
  actsForCompany,
  approvalRefusal,
  approverLimitSaying,
  companiesSaying,
  companyRefusal,
  isSetupGrantablePermission,
  type PurchasingStanding,
} from '../src/contracts/purchasing-roles';
import { approvalStepsProblem, approverLabel, approverSaying, stepsFromLimit, type ApprovalStep } from '../src/contracts/purchasing-setup';

// Purchasing Setup, part 5b (2026-11-21). Every figure invented.
const STEPS: ApprovalStep[] = [
  { upToCents: 50000, approver: 'ANY_APPROVER', quotesNeeded: 0, reminderDays: null },
  { upToCents: 500000, approver: 'APPROVER_LIMIT', quotesNeeded: 1, reminderDays: null },
  { upToCents: null, approver: 'ANY_AMOUNT', quotesNeeded: 2, reminderDays: null },
];
const approver = (over: Partial<PurchasingStanding> = {}): PurchasingStanding => ({ permissions: ['purchasing:request', 'purchasing:approve'], companies: null, anyAmount: false, limitCents: null, ...over });

describe('the purchasing roles', () => {
  it('are made of purchasing and inventory permissions only, which is all Setup hands out', () => {
    expect(PURCHASING_ROLES.map((role) => role.label)).toEqual(['Requisitioner', 'Purchaser', 'Approver', 'Purchasing manager', 'Stock keeper', 'Receiver', 'Code admin', 'Bill payer', 'Purchasing admin']);
    expect(PURCHASING_ROLES.every((role) => role.permissions.every(isSetupGrantablePermission))).toBe(true);
    expect(isSetupGrantablePermission('users:manage')).toBe(false);
  });

  it('say a person as the board does', () => {
    const companies = [
      { tenantId: 'thmp', name: 'Texas Home Maintenance Pros', purchaserCode: 'THMP' },
      { tenantId: 'ccp', name: 'Crystal Creek Pest', purchaserCode: null },
    ];
    expect(companiesSaying([], companies)).toBe('All');
    expect(companiesSaying(['thmp', 'ccp'], companies)).toBe('THMP, Crystal Creek Pest');
    expect(approverLimitSaying({ approvesAnyAmount: true, approvalLimitCents: null })).toBe('any amount');
    expect(approverLimitSaying({ approvesAnyAmount: false, approvalLimitCents: 500000 })).toBe('to $5,000.00');
    expect(approverLimitSaying({ approvesAnyAmount: false, approvalLimitCents: null })).toBe('');
  });
});

describe('acting for a company', () => {
  it('is every company with no limit, and only theirs with one -- never a document of no company', () => {
    expect(actsForCompany({ companies: null }, null)).toBe(true);
    expect(actsForCompany({ companies: ['thmp'] }, 'thmp')).toBe(true);
    expect(actsForCompany({ companies: ['thmp'] }, 'ccp')).toBe(false);
    expect(actsForCompany({ companies: ['thmp'] }, null)).toBe(false);
    expect(companyRefusal({ companies: ['thmp'] }, 'ccp', 'order')).toBe("You order only for your own companies, and this is another company's.");
    expect(companyRefusal({ companies: ['thmp'] }, null, 'order')).toBe('You order only for your own companies: choose one of them.');
  });
});

describe('approving an amount', () => {
  it('follows the step: any approver, an approver whose own limit reaches its top, or only somebody who may approve any amount', () => {
    expect(approvalRefusal(approver(), STEPS, 18480, null, true)).toBeNull();
    expect(approvalRefusal(approver(), STEPS, 61200, null, true)).toBe('At $612.00 it needs an approver whose own limit is $5,000.00 or more.');
    expect(approvalRefusal(approver({ limitCents: 500000 }), STEPS, 61200, null, true)).toBeNull();
    expect(approvalRefusal(approver({ limitCents: 500000 }), STEPS, 600000, null, true)).toBe('At $6,000.00 it is above your approval limit of $5,000.00.');
    expect(approvalRefusal(approver({ limitCents: 1_000_000 }), STEPS, 600000, null, true)).toBe('At $6,000.00 it needs somebody who may approve any amount.');
    expect(approvalRefusal(approver({ anyAmount: true }), STEPS, 99_999_999, null, true)).toBeNull();
  });

  it('never goes above their own limit, even in a step any approver takes', () => {
    expect(approvalRefusal(approver({ limitCents: 10000 }), STEPS, 18480, null, true)).toBe('At $184.80 it is above your approval limit of $100.00.');
  });

  it('is only for their own companies while the office says so', () => {
    const thmpOnly = approver({ companies: ['thmp'] });
    expect(approvalRefusal(thmpOnly, STEPS, 18480, 'ccp', true)).toBe("You approve only for your own companies, and this is another company's.");
    expect(approvalRefusal(thmpOnly, STEPS, 18480, 'ccp', false)).toBeNull();
    expect(approvalRefusal(thmpOnly, STEPS, 18480, 'thmp', true)).toBeNull();
  });

  it('reads an office without steps as before: approvers to the limit, any amount above it', () => {
    expect(approvalRefusal(approver(), stepsFromLimit(50000, 2), 61200, null, true)).toBe('At $612.00 it needs somebody who may approve any amount.');
  });
});

describe('a step asking for an approver whose own limit reaches it', () => {
  it('is said with its top, and never takes in more people than the step below it', () => {
    expect(approverLabel('APPROVER_LIMIT', 500000)).toBe('Approver, to $5,000.00 or more');
    expect(approverSaying(STEPS[1]!)).toBe('An approver whose own limit is $5,000.00 or more');
    expect(approvalStepsProblem(STEPS, 10)).toBeNull();
    expect(approvalStepsProblem([{ ...STEPS[0]!, approver: 'APPROVER_LIMIT' }, { ...STEPS[1]!, approver: 'ANY_APPROVER' }, STEPS[2]!], 10)).toBe(
      'Once a step needs an approver whose own limit reaches it, no higher step takes in any approver.',
    );
    expect(approvalStepsProblem([STEPS[0]!, { ...STEPS[2]!, approver: 'APPROVER_LIMIT' }], 10)).toBe('The last step has no top, so it cannot ask for an approver whose limit reaches it.');
  });
});

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CODE_KEEPERS,
  DEFAULT_PAGE_LAYOUT,
  audienceSaying,
  codeKeepersProblem,
  completePageLayout,
  factBoxesFor,
  keepsList,
  listsKept,
  missingFieldProblem,
  pageLayoutProblem,
  type RequisitionPageLayout,
} from '../src/contracts/purchasing-page';
import { requisitionSubmitProblem } from '../src/contracts/purchasing';
import { DEFAULT_FILE_RULES, stepsFromLimit } from '../src/contracts/purchasing-setup';

// Purchasing Setup, part 5c (2026-11-21). Every figure invented.
const required = (...keys: (keyof RequisitionPageLayout['fields'])[]): RequisitionPageLayout => ({
  ...DEFAULT_PAGE_LAYOUT,
  fields: Object.fromEntries(Object.entries(DEFAULT_PAGE_LAYOUT.fields).map(([key, field]) => [key, { ...field, required: keys.includes(key as never) }])) as RequisitionPageLayout['fields'],
});

describe('who keeps each code list', () => {
  it('starts as it was before Setup: stock lists by the stock keeper, purchasing codes by the code admin', () => {
    expect(DEFAULT_CODE_KEEPERS).toEqual({
      ITEMS: 'STOCK_KEEPER',
      CATEGORIES: 'STOCK_KEEPER',
      LINE_TYPES: 'CODE_ADMIN',
      UNITS: 'CODE_ADMIN',
      REQUEST: 'CODE_ADMIN',
      DEPARTMENT: 'CODE_ADMIN',
      COST_CENTER: 'CODE_ADMIN',
      PLACES: 'STOCK_KEEPER',
      VENDORS: 'STOCK_KEEPER',
      PURCHASER_CODES: 'CODE_ADMIN',
    });
  });

  it('is decided by the permission the role is known by', () => {
    expect(keepsList(['inventory:manage'], DEFAULT_CODE_KEEPERS, 'VENDORS')).toBe(true);
    expect(keepsList(['purchasing:order'], DEFAULT_CODE_KEEPERS, 'VENDORS')).toBe(false);
    expect(keepsList(['purchasing:order'], { ...DEFAULT_CODE_KEEPERS, VENDORS: 'PURCHASER' }, 'VENDORS')).toBe(true);
    expect(listsKept(['purchasing:codes'], DEFAULT_CODE_KEEPERS)).toMatchObject({ REQUEST: true, ITEMS: false, PURCHASER_CODES: true });
  });

  it('is kept only with a role the board offers for every list', () => {
    expect(codeKeepersProblem(DEFAULT_CODE_KEEPERS)).toBeNull();
    expect(codeKeepersProblem({ ...DEFAULT_CODE_KEEPERS, VENDORS: 'BILL_PAYER' })).toBe('Choose who keeps vendor numbers.');
    expect(codeKeepersProblem({ ...DEFAULT_CODE_KEEPERS, SECRETS: 'CODE_ADMIN' })).toBe('A code list Setup does not know.');
  });
});

describe('the requisition page', () => {
  it('starts as it was: every field shown, none required, Vendor Statistics off', () => {
    expect(Object.values(DEFAULT_PAGE_LAYOUT.fields).every((field) => field.shown && !field.required)).toBe(true);
    expect(factBoxesFor(DEFAULT_PAGE_LAYOUT, ['purchasing:request'])).toEqual(['STATISTICS', 'ATTACHMENTS', 'LINE_DETAILS', 'ITEM_AVAILABILITY']);
  });

  it('shows each FactBox in its order to the roles that see it', () => {
    const layout: RequisitionPageLayout = {
      ...DEFAULT_PAGE_LAYOUT,
      factBoxes: [
        { key: 'VENDOR_STATISTICS', shown: true, audience: ['PURCHASER', 'APPROVER'] },
        { key: 'STATISTICS', shown: true, audience: [] },
        { key: 'ITEM_AVAILABILITY', shown: true, audience: ['STOCK_KEEPER', 'PURCHASER'] },
        { key: 'ATTACHMENTS', shown: false, audience: [] },
        { key: 'LINE_DETAILS', shown: true, audience: [] },
      ],
    };
    expect(factBoxesFor(layout, ['purchasing:request'])).toEqual(['STATISTICS', 'LINE_DETAILS']);
    expect(factBoxesFor(layout, ['purchasing:request', 'purchasing:order'])).toEqual(['VENDOR_STATISTICS', 'STATISTICS', 'ITEM_AVAILABILITY', 'LINE_DETAILS']);
    expect(audienceSaying(['STOCK_KEEPER', 'PURCHASER'], { STOCK_KEEPER: 'Stock keeper', PURCHASER: 'Purchaser' } as never)).toBe('Stock keeper, Purchaser');
    expect(audienceSaying([], {} as never)).toBe('Everybody');
  });

  it('fills a saved layout from the defaults, and never requires a hidden field', () => {
    const saved = completePageLayout({ fields: { ...DEFAULT_PAGE_LAYOUT.fields, COST_CENTER: { shown: false, required: true } }, factBoxes: [{ key: 'LINE_DETAILS', shown: true, audience: [] }] });
    expect(saved.fields.COST_CENTER).toEqual({ shown: false, required: false });
    expect(saved.factBoxes.map((box) => box.key)).toEqual(['LINE_DETAILS', 'STATISTICS', 'ATTACHMENTS', 'ITEM_AVAILABILITY', 'VENDOR_STATISTICS']);
    expect(pageLayoutProblem(saved)).toBeNull();
    expect(pageLayoutProblem({ ...DEFAULT_PAGE_LAYOUT, fields: { ...DEFAULT_PAGE_LAYOUT.fields, COST_CENTER: { shown: false, required: true } } })).toBe('Cost Center Code is required, so it is shown.');
    expect(pageLayoutProblem({ ...DEFAULT_PAGE_LAYOUT, factBoxes: DEFAULT_PAGE_LAYOUT.factBoxes.slice(1) })).toBe('Every FactBox is listed once.');
  });

  it('refuses to send a requisition missing a field the office requires', () => {
    const lines = [{ quantity: 1, estimatedUnitCostCents: 390, departmentId: null, notes: null }];
    expect(missingFieldProblem({ lines }, DEFAULT_PAGE_LAYOUT)).toBeNull();
    expect(missingFieldProblem({ lines }, required('REQUEST_CODE', 'LINE_DEPARTMENT'))).toBe('Choose the request code.');
    expect(missingFieldProblem({ requestCodeId: 'restock', lines }, required('REQUEST_CODE', 'LINE_DEPARTMENT'))).toBe('Choose a department code on every line.');
    expect(missingFieldProblem({ requestCodeId: 'restock', lines: [{ departmentId: 'maint' }] }, required('REQUEST_CODE', 'LINE_DEPARTMENT'))).toBeNull();
    const settings = { steps: stepsFromLimit(50000, 2), files: DEFAULT_FILE_RULES, page: required('EXPECTED_RECEIPT') };
    expect(requisitionSubmitProblem({ reason: '', lines, quotes: [], neededBy: null }, settings)).toBe('Give the expected receipt date.');
  });
});

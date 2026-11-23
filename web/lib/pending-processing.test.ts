import type { PendingOrderLine } from '@texasrenters/shared';
import { describe, expect, it } from 'vitest';

import { andList, makeOrdersInput, pendingGroups, tickedSummary } from './pending-processing';

/** Pending Processing (2026-11-23). Every requisition, item, vendor and price invented. */

const THMP = { tenantId: 'tenant-thmp', name: 'Example Homes', purchaserCode: 'THMP' };
const CCP = { tenantId: 'tenant-ccp', name: 'Example Pest', purchaserCode: 'CCP' };
const HILL = { id: 'vendor-hill', number: 'V-00003', name: 'Hill Country Supply' };
const ALAMO = { id: 'vendor-alamo', number: 'V-00005', name: 'Alamo Trade Parts' };
const STORE = { id: 'place-store', name: 'Office Storeroom', code: 'OFFICE-STOREROOM' };
const TRUCK = { id: 'place-truck', name: 'Truck 1', code: 'TRK-01' };
const FILTER = { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1, MERV 8', unit: 'each' };
const BATTERY = { id: 'item-battery', code: 'BAT-9V', name: 'Battery, 9 V', unit: 'each' };

let n = 0;
const line = (requisition: string, over: Partial<PendingOrderLine> = {}): PendingOrderLine => ({
  requisitionLineId: `line-${(n += 1)}`,
  requisition: { id: `req-${requisition}`, number: requisition, createdAt: '2026-11-20T15:00:00.000Z', requestedBy: 'Sample Requester' },
  company: THMP,
  item: FILTER,
  place: STORE,
  quantity: 12,
  estimatedUnitCostCents: 390,
  vendor: HILL,
  expectedOn: null,
  department: 'MAINT',
  notes: null,
  ...over,
});

describe('the lines Pending Processing', () => {
  const lines = [
    line('PR-00012'),
    line('PR-00015', { quantity: 24 }),
    line('PR-00015', { item: BATTERY, quantity: 24, estimatedUnitCostCents: 185 }),
    line('PR-00016', { place: TRUCK, quantity: 6 }),
    line('PR-00014', { vendor: ALAMO }),
    line('PR-00017', { company: CCP }),
    line('PR-00018', { vendor: null }),
  ];
  const ids = (picked: PendingOrderLine[]) => new Set(picked.map((one) => one.requisitionLineId));

  it('go by company and vendor, the ones with no vendor last, and say when a vendor is another company too', () => {
    const groups = pendingGroups(lines, new Map());
    expect(groups.map((group) => [group.company?.purchaserCode, group.vendor?.name ?? null, group.lines.length, group.requisitionCount, group.amountCents, group.otherCompany])).toEqual([
      ['THMP', 'Hill Country Supply', 4, 3, 4680 + 9360 + 4440 + 2340, true],
      ['THMP', 'Alamo Trade Parts', 1, 1, 4680, false],
      ['CCP', 'Hill Country Supply', 1, 1, 4680, true],
      ['THMP', null, 1, 1, 4680, false],
    ]);
  });

  it('move a line to its vendor once one is chosen for it', () => {
    const chosen = new Map([[lines[6]!.requisitionLineId, ALAMO]]);
    expect(pendingGroups(lines, chosen).map((group) => [group.vendor?.name, group.lines.length])).toEqual([
      ['Hill Country Supply', 4],
      ['Alamo Trade Parts', 2],
      ['Hill Country Supply', 1],
    ]);
  });

  it('say what Make Purchase Orders will make: one order a vendor and company, the same item to the same place one line', () => {
    const ticked = ids(lines.slice(0, 5));
    const summary = tickedSummary(lines, new Map(), ticked);
    expect(summary).toMatchObject({ lineCount: 5, requisitionCount: 4, amountCents: 4680 + 9360 + 4440 + 2340 + 4680 });
    // The filters to the storeroom from PR-00012 and PR-00015 are one line; the truck's are their own.
    expect(summary.orders.map((order) => [order.vendor.name, order.company?.purchaserCode, order.lineCount])).toEqual([
      ['Hill Country Supply', 'THMP', 3],
      ['Alamo Trade Parts', 'THMP', 1],
    ]);
    expect(summary.merges).toEqual([expect.objectContaining({ item: FILTER, place: STORE, requisitions: ['PR-00012', 'PR-00015'], quantity: 36 })]);
  });

  it('never makes an order of a line with no vendor, and sends each line with the vendor it goes to', () => {
    const all = ids(lines);
    expect(tickedSummary(lines, new Map(), all).lineCount).toBe(6);
    expect(makeOrdersInput(lines, new Map(), all).lines.map((one) => one.vendorId)).toEqual(['vendor-hill', 'vendor-hill', 'vendor-hill', 'vendor-hill', 'vendor-alamo', 'vendor-hill']);
    const chosen = new Map([[lines[6]!.requisitionLineId, ALAMO]]);
    expect(makeOrdersInput(lines, chosen, all).lines.at(-1)).toEqual({ requisitionLineId: lines[6]!.requisitionLineId, vendorId: 'vendor-alamo' });
  });

  it('names requisitions as a sentence does', () => {
    expect(andList(['PR-00012'])).toBe('PR-00012');
    expect(andList(['PR-00012', 'PR-00015'])).toBe('PR-00012 and PR-00015');
    expect(andList(['PR-00012', 'PR-00015', 'PR-00016'])).toBe('PR-00012, PR-00015 and PR-00016');
  });
});

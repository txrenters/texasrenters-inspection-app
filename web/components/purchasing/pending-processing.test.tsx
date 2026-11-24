import type { PendingOrderLine, PendingOrderLines } from '@texasrenters/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PendingProcessing } from './pending-processing';

/** Pending Processing (2026-11-23). Every requisition, item, vendor and price invented. */

const hooks = vi.hoisted(() => ({ usePendingOrderLines: vi.fn(), usePurchaseOrderEdits: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

const THMP = { tenantId: 'tenant-thmp', name: 'Example Homes', purchaserCode: 'THMP' };
const HILL = { id: 'vendor-hill', number: 'V-00003', name: 'Hill Country Supply' };
const ALAMO = { id: 'vendor-alamo', number: 'V-00005', name: 'Alamo Trade Parts' };
const STORE = { id: 'place-store', name: 'Office Storeroom', code: 'OFFICE-STOREROOM' };
const FILTER = { id: 'item-filter', code: 'FLT-20251', name: 'Filter 20x25x1, MERV 8', unit: 'each' };

const line = (id: string, requisition: string, over: Partial<PendingOrderLine> = {}): PendingOrderLine => ({
  requisitionLineId: id,
  requisition: { id: `req-${requisition}`, number: requisition, createdAt: '2026-11-20T15:00:00.000Z', requestedBy: 'Sample Requester' },
  company: THMP,
  item: FILTER,
  place: STORE,
  quantity: 12,
  estimatedUnitCostCents: 390,
  vendor: HILL,
  expectedOn: '2026-11-27',
  department: 'MAINT',
  notes: null,
  ...over,
});
const DATA: PendingOrderLines = {
  lines: [
    line('line-1', 'PR-00012'),
    line('line-2', 'PR-00015', { quantity: 24 }),
    line('line-3', 'PR-00018', { vendor: null, item: { id: 'item-paint', code: 'PNT-0012', name: 'Paint, flat white, 1 gal', unit: 'each' }, quantity: 4, estimatedUnitCostCents: 2800 }),
  ],
  vendors: [HILL, ALAMO],
};

let makeFromLines: { mutateAsync: ReturnType<typeof vi.fn>; isPending: boolean; error: Error | null };
const mount = (data: PendingOrderLines = DATA) => {
  hooks.usePendingOrderLines.mockReturnValue({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });
  return render(<PendingProcessing onMade={vi.fn()} />);
};
const status = () => screen.getByRole('status');

beforeEach(() => {
  router.push.mockReset();
  makeFromLines = { mutateAsync: vi.fn(async () => ({ orders: [{ id: 'order-31', vendor: HILL }] })), isPending: false, error: null };
  hooks.usePurchaseOrderEdits.mockReturnValue({ makeFromLines });
});

describe('Pending Processing', () => {
  it('lists the lines by company and vendor, with what each costs, and nothing ticked', () => {
    mount();
    const table = screen.getByRole('table', { name: 'Lines Pending Processing' });
    expect(within(table).getByRole('row', { name: /V-00003 Hill Country Supply/ }).textContent).toContain('2 lines from 2 requisitions · $140.40');
    expect(within(table).getByRole('row', { name: /PR-00015/ }).textContent).toContain('93.60');
    expect(within(table).getByRole('link', { name: 'PR-00012' }).getAttribute('href')).toBe('/purchasing/requisitions/req-PR-00012');
    expect(within(table).getByText('No vendor yet')).toBeTruthy();
    expect(status().textContent).toContain('Tick the lines to order');
    expect((screen.getByRole('button', { name: 'Make Purchase Orders' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows a line whose item code was deleted, marked, and never ticks it', () => {
    mount({ ...DATA, lines: [line('line-1', 'PR-00012'), line('line-9', 'PR-00001', { item: { ...FILTER, id: 'item-gone', code: 'FLT-0001', name: 'Filter 25x16x1 (deleted)', deleted: true } })] });
    const gone = screen.getByRole('checkbox', { name: 'Order FLT-0001 of PR-00001' }) as HTMLButtonElement;
    expect(gone.disabled).toBe(true);
    expect(screen.getByRole('row', { name: /PR-00001/ }).textContent).toContain('Deleted');

    // The whole vendor ticks only what can be ordered.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Order every line for Hill Country Supply, THMP' }));
    expect(screen.getByRole('checkbox', { name: 'Order FLT-20251 of PR-00012' }).getAttribute('aria-checked')).toBe('true');
    expect(gone.getAttribute('aria-checked')).toBe('false');
  });

  it('ticks a whole vendor, says the same item to the same place becomes one line, and makes the orders', async () => {
    mount();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Order every line for Hill Country Supply, THMP' }));
    expect(status().textContent).toContain('Ticked: 2 lines from 2 requisitions → 1 purchase order, $140.40 before tax');
    expect(status().textContent).toContain('FLT-20251 to Office Storeroom, asked for on PR-00012 and PR-00015, becomes one line of 36.');

    fireEvent.click(screen.getByRole('button', { name: 'Make Purchase Orders' }));
    await waitFor(() =>
      expect(makeFromLines.mutateAsync).toHaveBeenCalledWith({
        lines: [
          { requisitionLineId: 'line-1', vendorId: 'vendor-hill' },
          { requisitionLineId: 'line-2', vendorId: 'vendor-hill' },
        ],
      }),
    );
    // One order made opens it.
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/purchasing/orders/order-31'));
  });

  it('lets a line with no vendor be ticked only once one is chosen, and it joins that vendor', async () => {
    mount();
    expect((screen.getByRole('checkbox', { name: 'Order PNT-0012 of PR-00018' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.keyDown(screen.getByLabelText('Vendor No. for PNT-0012'), { key: 'ArrowDown' });
    fireEvent.click(screen.getByRole('option', { name: 'V-00005 · Alamo Trade Parts' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Order PNT-0012 of PR-00018' }));
    expect(screen.getByRole('row', { name: /V-00005 Alamo Trade Parts/ }).textContent).toContain('1 line from 1 requisition');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Order FLT-20251 of PR-00012' }));
    expect(status().textContent).toContain('→ 2 purchase orders');
    makeFromLines.mutateAsync.mockResolvedValueOnce({ orders: [{ id: 'order-31', vendor: HILL }, { id: 'order-32', vendor: ALAMO }] });
    fireEvent.click(screen.getByRole('button', { name: 'Make Purchase Orders' }));
    await waitFor(() => expect(makeFromLines.mutateAsync).toHaveBeenCalledWith({ lines: [{ requisitionLineId: 'line-1', vendorId: 'vendor-hill' }, { requisitionLineId: 'line-3', vendorId: 'vendor-alamo' }] }));
    // Several are listed, each to open.
    expect((await screen.findByRole('link', { name: 'V-00005 · Alamo Trade Parts' })).getAttribute('href')).toBe('/purchasing/orders/order-32');
    expect(router.push).not.toHaveBeenCalled();
  });

  it('says so when nothing waits, and shows why an order was refused', () => {
    const { unmount } = mount({ lines: [], vendors: [] });
    expect(screen.getByText('Nothing to order')).toBeTruthy();
    unmount();

    makeFromLines.error = new Error('A line of PR-00012 is on an order already. Open Pending Processing again.');
    mount();
    expect(screen.getByText(/is on an order already/)).toBeTruthy();
  });
});

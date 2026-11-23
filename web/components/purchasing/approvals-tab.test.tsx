import type { PurchaseOrderRow, RequisitionRow } from '@texasrenters/shared';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApprovalsTab } from './approvals-tab';

const hooks = vi.hoisted(() => ({ useRequisitionsToApprove: vi.fn(), useOrdersToApprove: vi.fn() }));
vi.mock('@/lib/purchasing-queries', () => hooks);

const read = <T,>(data: T) => ({ data, isLoading: false, isError: false, error: null, refetch: vi.fn() });

const requisition = (over: Partial<RequisitionRow> = {}): RequisitionRow => ({
  id: 'req-1',
  number: 'PR-00001',
  status: 'SUBMITTED',
  requestedBy: { id: 'user-ernie', name: 'Sample Requester', code: 'SREQUESTER' },
  submittedAt: '2026-11-20T15:00:00.000Z',
  createdAt: '2026-11-20T14:58:00.000Z',
  company: { tenantId: 'tenant-thmp', name: 'THMP', purchaserCode: 'THMP' },
  neededBy: '2026-11-27',
  summary: 'Filter 25x16x1 × 5',
  lineCount: 1,
  quoteCount: 0,
  estimatedTotalCents: 250000,
  decisionNote: null,
  stage: 'PENDING_APPROVAL',
  department: { id: 'code-maint', code: 'MAINT', name: 'Maintenance' },
  ...over,
});
const order = (over: Partial<PurchaseOrderRow> = {}): PurchaseOrderRow => ({
  id: 'order-3',
  number: 'PO-00003',
  status: 'AWAITING_APPROVAL',
  vendor: { id: 'vendor-alamo', name: 'Alamo Trade Parts' },
  requisition: { id: 'req-1', number: 'PR-00001' },
  requisitions: [{ id: 'req-1', number: 'PR-00001' }],
  company: { tenantId: 'tenant-thmp', name: 'THMP' },
  expectedOn: null,
  lineCount: 2,
  totalCents: 41220,
  madeBy: { id: 'user-buyer', name: 'Sample Purchaser' },
  createdAt: '2026-11-20T16:00:00.000Z',
  sentAt: null,
  ...over,
});

// 2026-11-21, the office: Requests to Approve, as NAV's -- what waits for the caller's approval now.
describe('Requests to Approve', () => {
  beforeEach(() => {
    hooks.useRequisitionsToApprove.mockReturnValue(read([requisition()]));
    hooks.useOrdersToApprove.mockReturnValue(read([order()]));
  });

  it("lists the requisitions of the approver's departments and the purchasing manager's orders, each opening where it is decided", () => {
    render(<ApprovalsTab orders requisitions />);
    const requisitions = screen.getByRole('table', { name: 'Requisitions to approve' });
    expect(within(requisitions).getByRole('row', { name: /PR-00001/ }).textContent).toContain('MAINT');
    expect(within(requisitions).getByRole('row', { name: /PR-00001/ }).textContent).toContain('Pending Approval');
    expect(within(requisitions).getByRole('link', { name: /Filter 25x16x1 × 5/ }).getAttribute('href')).toBe('/purchasing/requisitions/req-1');
    const orders = screen.getByRole('table', { name: 'Purchase orders to approve' });
    expect(within(orders).getByRole('link', { name: /Alamo Trade Parts/ }).getAttribute('href')).toBe('/purchasing/orders/order-3');
    expect(within(orders).getByRole('row', { name: /PO-00003/ }).textContent).toContain('Pending Approval');
  });

  it('reads only what the person approves: requisitions for an approver, orders for a purchasing manager', () => {
    render(<ApprovalsTab orders={false} requisitions />);
    expect(hooks.useOrdersToApprove).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('heading', { name: /Purchase orders/ })).toBeNull();
    expect(screen.getByRole('heading', { name: /Purchase requisitions/ })).toBeTruthy();
  });

  it('says when nothing waits', () => {
    hooks.useRequisitionsToApprove.mockReturnValue(read([]));
    hooks.useOrdersToApprove.mockReturnValue(read([]));
    render(<ApprovalsTab orders requisitions />);
    expect(screen.getByText('Nothing waits for your approval')).toBeTruthy();
  });
});

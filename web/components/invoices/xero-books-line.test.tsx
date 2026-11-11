import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { XeroBooksLine } from './xero-books-line';

/**
 * Under the invoice list (2026-11-12): whose invoices are as Xero has them,
 * when they were read, and "Read invoices from Xero now" for whoever manages
 * invoices. Everything invented.
 */

const read = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
vi.mock('@/lib/xero-queries', () => ({ useReadAllXeroBooks: () => read }));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const HOMES = { tenantId: 'b1000000-0000-4000-8000-000000000001', name: 'Example Home Services', readAt: '2026-11-12T22:05:00.000Z' };
const PEST = { tenantId: 'b1000000-0000-4000-8000-000000000002', name: 'Example Pest Co', readAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage']);
});

describe('the books read from Xero, under the invoice list', () => {
  it('names each company shown as Xero has it, and reads them again only when told to', () => {
    render(<XeroBooksLine books={[HOMES, PEST]} />);
    expect(screen.getByText(/Example Home Services and Example Pest Co’s invoices are as Xero has them, read .*\. Change them in Xero\./)).toBeInTheDocument();
    expect(read.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read invoices from Xero now' }));
    expect(read.mutate).toHaveBeenCalledTimes(1);
  });

  it('offers no read to whoever only looks, and says nothing while no company is read', () => {
    permissions.granted = new Set(['invoices:read']);
    const { container, rerender } = render(<XeroBooksLine books={[HOMES]} />);
    expect(screen.queryByRole('button', { name: 'Read invoices from Xero now' })).not.toBeInTheDocument();
    rerender(<XeroBooksLine books={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvoicesCard } from './invoice-parts';

/** A visit's invoices card (2026-11-13): a second invoice is offered as one, never as a first. Everything invented. */

const hooks = vi.hoisted(() => ({ useInvoices: vi.fn() }));
vi.mock('@/lib/invoice-queries', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...hooks }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: () => true }) }));

const invoice = {
  id: 'inv-1',
  number: '8440',
  status: 'AWAITING_PAYMENT',
  totalCents: 3999,
  balanceCents: 3999,
};
const listed = (items: unknown[]) => ({ isLoading: false, isError: false, data: { items } });

beforeEach(() => vi.clearAllMocks());

describe("a visit's invoices card", () => {
  it('offers a new invoice for a visit with none', () => {
    hooks.useInvoices.mockReturnValue(listed([]));
    render(<InvoicesCard createHref="/invoices/new?inspection=v1" inspectionId="v1" />);
    expect(screen.getByRole('link', { name: 'New invoice' })).toHaveAttribute('href', '/invoices/new?inspection=v1');
    expect(screen.getByText('This visit has not been invoiced.')).toBeInTheDocument();
  });

  it('offers another, by that name, for a visit invoiced already', () => {
    hooks.useInvoices.mockReturnValue(listed([invoice]));
    render(<InvoicesCard createHref="/invoices/new?inspection=v1" inspectionId="v1" />);
    expect(screen.getByRole('link', { name: 'Add another invoice' })).toHaveAttribute('href', '/invoices/new?inspection=v1');
    expect(screen.queryByRole('link', { name: 'New invoice' })).not.toBeInTheDocument();
  });
});

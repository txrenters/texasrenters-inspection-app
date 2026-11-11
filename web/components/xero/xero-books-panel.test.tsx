import { fireEvent, render, screen, within } from '@testing-library/react';
import type { XeroBooksView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { XeroBooksPanel } from './xero-books-panel';

/**
 * A company's books read back from Xero (2026-11-12): counted on the Xero
 * page, to set beside Xero's own, with "Read invoices from Xero now" for
 * whoever runs the integrations. Everything invented.
 */

const TENANT = 'a2000000-0000-4000-8000-000000000002';
const hooks = vi.hoisted(() => ({
  books: { current: undefined as unknown },
  read: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/xero-queries', () => ({
  useXeroBooks: () => ({ isLoading: false, isError: false, data: hooks.books.current, refetch: vi.fn() }),
  useReadXeroBooks: () => hooks.read,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() } }));

const NEVER: XeroBooksView = {
  tenantId: TENANT,
  readAt: null,
  lastRunAt: null,
  lastRunProblem: null,
  counts: { invoices: 0, placed: 0, unplaced: 0, owedCents: 0, payments: 0, consoleInvoices: 0 },
  unplaced: [],
};

const READING: XeroBooksView = {
  ...NEVER,
  lastRunAt: '2026-11-20T17:00:00.000Z',
  counts: { invoices: 6000, placed: 5990, unplaced: 10, owedCents: 1234500, payments: 4800, consoleInvoices: 0 },
  unplaced: [{ number: 'INV-2963', clientName: 'Walk-in client', issuedOn: '2026-11-09', totalCents: 3900, xeroStatus: 'AUTHORISED' }],
};

const mount = (canManage = true) => render(<XeroBooksPanel canManage={canManage} name="Example Pest Co" tenantId={TENANT} />);

beforeEach(() => {
  vi.clearAllMocks();
  hooks.books.current = NEVER;
});

describe('the books read from Xero', () => {
  it('says nothing has been read yet, and reads only when told to', () => {
    mount();
    expect(screen.getByText(/Nothing has been read yet/)).toBeInTheDocument();
    expect(hooks.read.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Read invoices from Xero now' }));
    expect(hooks.read.mutate).toHaveBeenCalledTimes(1);
  });

  it('counts what was read and where it went, and lists those on no property', () => {
    hooks.books.current = READING;
    mount();
    expect(screen.getByText(/The first read is still going/)).toBeInTheDocument();
    const counts = screen.getByLabelText('What was read from Xero');
    expect(within(counts).getByText('Invoices').nextSibling).toHaveTextContent('6,000');
    expect(within(counts).getByText('On no property').nextSibling).toHaveTextContent('10');
    expect(within(counts).getByText('Still owed').nextSibling).toHaveTextContent('$12,345.00');
    const table = screen.getByRole('table', { name: 'Read from Xero, on no property' });
    const row = within(table).getByText('INV-2963').closest('tr')!;
    expect(within(row).getByText('Walk-in client')).toBeInTheDocument();
    expect(within(row).getByText('Awaiting payment')).toBeInTheDocument();
    expect(within(row).getByText('$39.00')).toBeInTheDocument();
  });

  it('says once every invoice has been read, and what stopped the last read', () => {
    hooks.books.current = { ...READING, readAt: '2026-11-13T15:00:00.000Z', lastRunProblem: 'Xero asked the console to slow down.' };
    mount();
    expect(screen.getByText(/Every invoice was read by/)).toBeInTheDocument();
    expect(screen.getByText('Xero asked the console to slow down.')).toBeInTheDocument();
  });

  it('offers no read to whoever only looks', () => {
    mount(false);
    expect(screen.queryByRole('button', { name: 'Read invoices from Xero now' })).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from '@testing-library/react';
import type { InvoiceAutoDraftsView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvoiceAutoDraftsSection } from './invoice-auto-drafts-section';

/**
 * "Draft invoices automatically" (2026-11-13): turned on or off by whoever
 * makes invoices, against the switch as it was read. Everything invented.
 */

const hooks = vi.hoisted(() => ({
  view: { current: null as InvoiceAutoDraftsView | null },
  save: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/invoice-auto-drafts-queries', () => ({
  useInvoiceAutoDrafts: () => ({ isLoading: false, data: hooks.view.current }),
  useSaveInvoiceAutoDrafts: () => hooks.save,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const OFF: InvoiceAutoDraftsView = { on: false, since: null, updatedAt: null, takenOver: true };

beforeEach(() => {
  vi.clearAllMocks();
  hooks.view.current = OFF;
});

describe('drafting invoices automatically', () => {
  it('turns on, against the switch as it was read, and warns against making them by hand too', () => {
    render(<InvoiceAutoDraftsSection mayChange />);
    expect(screen.getByText('Off: the office makes them on Create invoices.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: "Draft each finished visit's invoices automatically" }));
    expect(screen.getAllByRole('note')[0]).toHaveTextContent('Stop making these invoices by hand in Xero once this is on, or each visit is billed twice.');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(hooks.save.mutate).toHaveBeenCalledWith({ on: true, expectedUpdatedAt: null }, expect.anything());
  });

  it('says since when it is on, in Texas time', () => {
    hooks.view.current = { on: true, since: '2026-11-13T21:00:00.000Z', updatedAt: '2026-11-13T21:00:00.000Z', takenOver: true };
    render(<InvoiceAutoDraftsSection mayChange />);
    expect(screen.getByText('On since Nov 13, 2026, 3:00 PM Texas time.')).toBeInTheDocument();
  });

  it('cannot be turned on before the console makes the invoices, nor by whoever does not make them', () => {
    hooks.view.current = { ...OFF, takenOver: false };
    const { unmount } = render(<InvoiceAutoDraftsSection mayChange />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByText('Nothing is drafted until the console takes over invoicing.')).toBeInTheDocument();
    unmount();

    hooks.view.current = OFF;
    render(<InvoiceAutoDraftsSection mayChange={false} />);
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AccountEntry, PropertyAccount } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingCard } from './billing-card';
import { StatementSettingsSection } from './statement-settings-section';

/**
 * A property's billing history and its statement (2026-11-10, phase 3 of the
 * invoice gap review), as Jobber's Billing card on a client. A statement is
 * downloaded for nothing, or emailed -- billed -- on the press, once the
 * console owns invoicing. Everything invented.
 */

const queries = vi.hoisted(() => ({
  usePropertyAccount: vi.fn(),
  useSendStatement: vi.fn(),
  fetchStatement: vi.fn(),
  useStatementSettings: vi.fn(),
  useSaveStatementSettings: vi.fn(),
}));
vi.mock('@/lib/property-account-queries', () => queries);
const pdf = vi.hoisted(() => ({ downloadStatement: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/statement-pdf/download-statement', () => pdf);
vi.mock('@/lib/invoice-delivery-queries', () => ({ useSendInvoice: () => ({ mutate: vi.fn(), isPending: false }) }));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ready = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });
const send = { mutate: vi.fn(), isPending: false };
const save = { mutate: vi.fn(), isPending: false };

const entry = (over: Partial<AccountEntry>): AccountEntry => ({
  key: 'invoice:inv-1',
  kind: 'INVOICE',
  on: '2026-11-02',
  invoiceId: 'inv-1',
  invoiceNumber: '8441',
  paymentId: null,
  amountCents: 2500,
  balanceCents: 2500,
  status: 'AWAITING_PAYMENT',
  method: null,
  reference: null,
  ...over,
});

const ACCOUNT: PropertyAccount = {
  propertyId: 'b1',
  clientName: '100 Example Way',
  address: '100 Example Way, Sampletown',
  entries: [
    entry({ key: 'payment:pay-1', kind: 'PAYMENT', on: '2026-11-05', paymentId: 'pay-1', amountCents: -1000, balanceCents: 1500, status: null }),
    entry({}),
  ],
  balanceCents: 1500,
  invoicedCents: 2500,
  paidCents: 1000,
  truncated: false,
  writesEnabled: true,
  statementTo: ['owner@example.com', 'manager@example.com'],
  statements: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage']);
  queries.usePropertyAccount.mockReturnValue(ready(ACCOUNT));
  queries.useSendStatement.mockReturnValue(send);
  queries.useSaveStatementSettings.mockReturnValue(save);
  queries.fetchStatement.mockResolvedValue({ on: '2026-11-20' });
});

describe('the billing history', () => {
  it('lists invoices and payments newest first, each opening its page, with the current balance', () => {
    render(<BillingCard propertyId="b1" />);
    const rows = within(screen.getByRole('list', { name: 'Billing history' })).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('PaymentNov 5, 2026 · Invoice #8441-$10.00');
    expect(within(rows[0]!).getByRole('link', { name: 'Payment' })).toHaveAttribute('href', '/payments/pay-1');
    expect(within(rows[1]!).getByRole('link', { name: 'Invoice #8441' })).toHaveAttribute('href', '/invoices/inv-1');
    expect(screen.getByText('Current balance').parentElement).toHaveTextContent('$15.00');
  });

  it('shows ten at a time', () => {
    const many = Array.from({ length: 12 }, (_, index) => entry({ key: `invoice:${index}`, invoiceNumber: String(9000 + index) }));
    queries.usePropertyAccount.mockReturnValue(ready({ ...ACCOUNT, entries: many }));
    render(<BillingCard propertyId="b1" />);
    expect(within(screen.getByRole('list', { name: 'Billing history' })).getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    expect(within(screen.getByRole('list', { name: 'Billing history' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('11–12 of 12')).toBeInTheDocument();
  });

  it('is for whoever reads invoices', () => {
    permissions.granted = new Set();
    const { container } = render(<BillingCard propertyId="b1" />);
    expect(container).toBeEmptyDOMElement();
    expect(queries.usePropertyAccount).toHaveBeenCalledWith('b1', false);
  });
});

describe('a statement', () => {
  let unmount = () => {};
  const open = () => {
    ({ unmount } = render(<BillingCard propertyId="b1" />));
    fireEvent.click(screen.getByRole('button', { name: 'Statement' }));
    return screen.getByRole('dialog');
  };

  it('downloads for the lifetime of the account to start with', async () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download PDF' }));
    await waitFor(() => expect(pdf.downloadStatement).toHaveBeenCalledWith({ on: '2026-11-20' }));
    expect(queries.fetchStatement).toHaveBeenCalledWith('b1', { period: 'LIFETIME', from: null });
  });

  it('from a day needs the day', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('Pick a start date'));
    expect(within(dialog).getByRole('button', { name: 'Download PDF' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Starts on'), { target: { value: '2026-10-01' } });
    expect(within(dialog).getByRole('button', { name: 'Download PDF' })).toBeEnabled();
  });

  it('is emailed on the press, to the client’s addresses, under one key', () => {
    const dialog = open();
    fireEvent.click(within(dialog).getByLabelText('Since last zero balance'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email to client' }));
    fireEvent.click(within(dialog).getByLabelText('manager@example.com'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send statement' }));
    const [input] = send.mutate.mock.calls[0]!;
    expect(input).toMatchObject({ period: 'SINCE_ZERO', from: null, to: ['owner@example.com'] });
    expect(input.clientRequestId).toMatch(/^web-/);
  });

  it('is emailed from Jobber until the console takes over, and only by whoever makes invoices', () => {
    queries.usePropertyAccount.mockReturnValue(ready({ ...ACCOUNT, writesEnabled: false }));
    let dialog = open();
    expect(within(dialog).queryByRole('button', { name: 'Email to client' })).not.toBeInTheDocument();
    expect(dialog).toHaveTextContent('Statements are emailed from Jobber until the console takes over invoicing.');
    unmount();

    permissions.granted = new Set(['invoices:read']);
    queries.usePropertyAccount.mockReturnValue(ready(ACCOUNT));
    dialog = open();
    expect(within(dialog).queryByRole('button', { name: 'Email to client' })).not.toBeInTheDocument();
  });
});

describe('the statement settings', () => {
  it("start as Jobber's, newest first with no text, and save against what was read", () => {
    queries.useStatementSettings.mockReturnValue(ready({ newestFirst: true, disclaimer: null, updatedAt: '2026-11-09T15:00:00.000Z' }));
    render(<StatementSettingsSection mayChange />);
    expect(screen.getByLabelText('Newest first')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save statement settings' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Oldest first'));
    fireEvent.change(screen.getByLabelText('Contract / disclaimer'), { target: { value: ' Payment is due on receipt. ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save statement settings' }));
    expect(save.mutate).toHaveBeenCalledWith(
      { newestFirst: false, disclaimer: 'Payment is due on receipt.', expectedUpdatedAt: '2026-11-09T15:00:00.000Z' },
      expect.anything(),
    );
  });
});

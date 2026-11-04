import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { InvoiceDetail, InvoiceDraft, InvoiceList, PaymentList } from '@texasrenters/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewInvoicePage from './new/page';
import InvoicePage from './[invoiceId]/page';
import InvoicesPage from './page';
import PaymentsPage from '../payments/page';

/**
 * Invoices and payments in the console, built from Jobber's (the office,
 * 2026-11-05): see what is owed, make the invoice for a finished visit, and
 * record a payment once it has posted in Propertyware. A person does each;
 * no card is charged.
 */

const hooks = vi.hoisted(() => ({
  useInvoices: vi.fn(),
  useInvoice: vi.fn(),
  useInvoiceDraft: vi.fn(),
  usePayments: vi.fn(),
  useInvoiceActions: vi.fn(),
}));
vi.mock('@/lib/invoice-queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...hooks };
});
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const params = vi.hoisted(() => ({ search: new URLSearchParams('inspection=insp-1') }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ invoiceId: 'inv-1' }),
  useRouter: () => router,
  useSearchParams: () => params.search,
}));
vi.mock('@/lib/url-state', () => ({ useUrlState: (defaults: object) => [defaults, vi.fn(), vi.fn()] }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const create = { mutate: vi.fn(), isPending: false };
const recordPayment = { mutate: vi.fn(), isPending: false };

const NOW = new Date('2026-11-05T18:00:00.000Z');
const TODAY = '2026-11-05';

const SUMMARY = {
  id: 'inv-1',
  number: '8439',
  subject: 'For Services Rendered',
  status: 'PAST_DUE' as const,
  clientName: '1902 Mockup Dr',
  property: { id: 'b1', address: '1902 Mockup Dr', city: 'Houston' },
  inspectionId: 'insp-1',
  jobNumber: '20625',
  issuedOn: '2026-09-30',
  dueOn: '2026-10-30',
  totalCents: 3999,
  balanceCents: 3999,
  jobberUrl: 'https://secure.getjobber.com/invoices/1',
};

const DETAIL: InvoiceDetail = {
  ...SUMMARY,
  paymentTerms: 'Net 30',
  billingAddress: '1902 Mockup Dr, Houston, TX 77041',
  lineItems: [{ name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999, totalCents: 3999 }],
  subtotalCents: 3999,
  taxCents: 0,
  payments: [],
  clientMessage: 'Thank you for your business.',
  accountBalanceCents: 11499,
  createdAt: '2026-09-30T15:00:00.000Z',
};

const bucket = (count: number, amountCents: number) => ({ count, amountCents });
const LIST: InvoiceList = {
  items: [SUMMARY, { ...SUMMARY, id: 'inv-2', number: '8237', status: 'PAID', balanceCents: 0 }],
  page: 1,
  pageSize: 25,
  total: 2,
  totalPages: 1,
  overview: { pastDue: bucket(206, 957600), notYetDue: bucket(240, 1_360_000), draft: bucket(100, 398000) },
  issued: { last30: bucket(198, 1_110_000), previous30: bucket(160, 900_000) },
  filterCounts: { all: 8674, past_due: 206, not_yet_due: 240, awaiting_payment: 446, draft: 100, paid: 8128, bad_debt: 0, voided: 0 },
  syncedAt: '2026-11-05T17:58:00.000Z',
  jobberRead: { problem: null, checkedAt: '2026-11-05T17:58:00.000Z', firstReadDone: true },
};

const DRAFT: InvoiceDraft = {
  inspection: { id: 'insp-1', inspectionType: 'OCCUPIED', scheduledOn: '2026-11-03', status: 'TECHNICIAN_SUBMITTED' },
  property: { id: 'b1', address: '1902 Mockup Dr', city: 'Houston' },
  clientName: '1902 Mockup Dr',
  subject: 'For Services Rendered',
  issuedOn: TODAY,
  paymentTermsDays: 30,
  lineItems: [
    { name: 'Filter Change', quantity: 1, unitPriceCents: 3999 },
    { name: 'Pest Control', quantity: 1, unitPriceCents: 2500 },
  ],
  clientMessage: 'Thank you for your business.',
  existing: null,
  products: [{ name: 'Flea Treatment', unitPriceCents: 3500 }],
};

const ready = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  permissions.granted = new Set(['invoices:read', 'invoices:manage', 'payments:record']);
  hooks.useInvoiceActions.mockReturnValue({ create, recordPayment });
  hooks.useInvoices.mockReturnValue(ready(LIST));
  hooks.useInvoice.mockReturnValue(ready(DETAIL));
  hooks.useInvoiceDraft.mockReturnValue(ready(DRAFT));
});
afterEach(() => vi.useRealTimers());

describe('the invoices list', () => {
  it('leads with what is owed and what is not sent, with how much', () => {
    render(<InvoicesPage />);

    const glance = screen.getByRole('region', { name: 'Invoices at a glance' });
    expect(within(glance).getByRole('link', { name: /Past due \(206\)\s*\$9,576/ })).toHaveAttribute(
      'href',
      '/invoices?filter=past_due',
    );
    expect(within(glance).getByText(/Sent but not due/).closest('a')).toHaveTextContent('$13.6k');
    // 198 issued against 160 the 30 days before: up 24%.
    expect(within(glance).getByText('198').parentElement).toHaveTextContent('24%');
  });

  it('lists each invoice with its client, number, status, total and balance, opening the invoice', () => {
    render(<InvoicesPage />);

    const table = screen.getByRole('table', { name: 'Invoices' });
    const first = within(table).getAllByRole('row')[1]!;
    expect(first).toHaveTextContent('1902 Mockup Dr');
    expect(first).toHaveTextContent('#8439');
    expect(first).toHaveTextContent('Past due');
    expect(first).toHaveTextContent('$39.99');
  });

  it('says how to get invoices when there are none yet', () => {
    hooks.useInvoices.mockReturnValue(ready({ ...LIST, items: [], total: 0, totalPages: 0 }));
    render(<InvoicesPage />);

    expect(screen.getByText('No invoices')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Jobber connection' })).toHaveAttribute('href', '/integrations/jobber');
  });

  it('names the missing Jobber scope when Jobber hides invoices from the app', () => {
    hooks.useInvoices.mockReturnValue(
      ready({
        ...LIST,
        items: [],
        total: 0,
        totalPages: 0,
        jobberRead: { problem: 'NOT_PERMITTED', checkedAt: '2026-11-05T17:58:00.000Z', firstReadDone: false },
      }),
    );
    render(<InvoicesPage />);

    expect(screen.getByText(/Add the Invoices read scope to the app in Jobber's Developer Center, then reconnect Jobber/)).toBeInTheDocument();
  });

  it('says the first read is under way, with or without invoices yet', () => {
    const reading = { problem: null, checkedAt: '2026-11-05T17:58:00.000Z', firstReadDone: false };
    hooks.useInvoices.mockReturnValue(ready({ ...LIST, items: [], total: 0, totalPages: 0, jobberRead: reading }));
    const { unmount } = render(<InvoicesPage />);
    expect(screen.getByText(/being read for the first time/)).toBeInTheDocument();
    unmount();

    hooks.useInvoices.mockReturnValue(ready({ ...LIST, jobberRead: reading }));
    render(<InvoicesPage />);
    expect(screen.getByText(/Still reading Jobber's invoices for the first time/)).toBeInTheDocument();
    expect(screen.queryByText(/Up to date with Jobber/)).not.toBeInTheDocument();
  });
});

describe('an invoice', () => {
  it('shows its details, its lines and what it still owes', () => {
    render(<InvoicePage />);

    expect(screen.getByRole('heading', { name: 'For Services Rendered' })).toBeInTheDocument();
    const details = screen.getByLabelText('Invoice details');
    expect(details).toHaveTextContent('8439');
    expect(within(details).getByRole('link', { name: 'Job #20625' })).toHaveAttribute('href', '/inspections/insp-1');
    expect(details).toHaveTextContent('Net 30');
    expect(details).toHaveTextContent('Oct 30, 2026');
    expect(screen.getByRole('table', { name: 'Products and services' })).toHaveTextContent('Filter Change');
    expect(screen.getByText('No payment recorded yet.')).toBeInTheDocument();
  });

  it('offers Record payment only to somebody who may, on an invoice that still owes', () => {
    const { unmount } = render(<InvoicePage />);
    expect(screen.getByRole('button', { name: 'Record payment' })).toBeInTheDocument();
    unmount();

    permissions.granted.delete('payments:record');
    const again = render(<InvoicePage />);
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
    again.unmount();

    permissions.granted.add('payments:record');
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, status: 'PAID', balanceCents: 0 }));
    render(<InvoicePage />);
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });

  it('records the balance by default, from the Propertyware ledger, in cents, with its own key', () => {
    render(<InvoicePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('39.99');
    expect(within(dialog).getByLabelText('Paid on')).toHaveValue(TODAY);
    expect(dialog).toHaveTextContent('Propertyware ledger');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Record payment' }));

    expect(recordPayment.mutate).toHaveBeenCalledWith(
      {
        invoiceId: 'inv-1',
        input: { amountCents: 3999, paidOn: TODAY, method: 'PROPERTYWARE_LEDGER', clientRequestId: expect.stringMatching(/^web-/) },
      },
      expect.anything(),
    );
  });

  it('refuses more than is owed, and a day still to come', () => {
    render(<InvoicePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));
    const dialog = screen.getByRole('dialog');
    const save = within(dialog).getByRole('button', { name: 'Record payment' });

    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '40.00' } });
    expect(dialog).toHaveTextContent('That is more than the $39.99 this invoice still owes.');
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '20' } });
    fireEvent.change(within(dialog).getByLabelText('Paid on'), { target: { value: '2026-11-06' } });
    expect(dialog).toHaveTextContent('A payment cannot be recorded for a day still to come.');
    expect(save).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '20.5.0' } });
    expect(dialog).toHaveTextContent('Give the amount in dollars and cents.');
  });
});

describe('a new invoice for a finished visit', () => {
  it('starts from the services done, at their prices, and adds them up', () => {
    render(<NewInvoicePage />);

    expect(screen.getByLabelText('Line 1: name')).toHaveValue('Filter Change');
    expect(screen.getByLabelText('Line 2: unit price')).toHaveValue('25.00');
    expect(screen.getByRole('button', { name: 'Create invoice · $64.99' })).toBeEnabled();

    fireEvent.change(screen.getByLabelText('Line 2: quantity'), { target: { value: '2' } });
    expect(screen.getByRole('button', { name: 'Create invoice · $89.99' })).toBeInTheDocument();
  });

  it('says what is wrong with a line instead of sending it', () => {
    render(<NewInvoicePage />);

    fireEvent.change(screen.getByLabelText('Line 1: unit price'), { target: { value: '39.999' } });

    expect(screen.getByText(/Filter Change: give the quantity as a number and the price in dollars and cents/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Create invoice/ })).toBeDisabled();
  });

  it('sends the lines in cents, with one key for the form', () => {
    render(<NewInvoicePage />);
    fireEvent.click(screen.getByRole('button', { name: /Create invoice/ }));
    fireEvent.click(screen.getByRole('button', { name: /Create invoice/ }));

    const sent = create.mutate.mock.calls.map((call) => call[0]);
    expect(sent[0]).toEqual({
      inspectionId: 'insp-1',
      subject: 'For Services Rendered',
      issuedOn: TODAY,
      paymentTermsDays: 30,
      lineItems: [
        { name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999 },
        { name: 'Pest Control', description: null, quantity: 1, unitPriceCents: 2500 },
      ],
      clientMessage: 'Thank you for your business.',
      clientRequestId: expect.stringMatching(/^web-/),
    });
    // A double click is the same invoice, by its key.
    expect(sent[1].clientRequestId).toBe(sent[0].clientRequestId);
  });

  it('warns when the visit is already invoiced', () => {
    hooks.useInvoiceDraft.mockReturnValue(ready({ ...DRAFT, existing: { id: 'inv-1', number: '8439', status: 'PAST_DUE' } }));
    render(<NewInvoicePage />);

    expect(screen.getByRole('status')).toHaveTextContent('This visit already has an invoice:');
    expect(screen.getByRole('link', { name: '#8439' })).toHaveAttribute('href', '/invoices/inv-1');
  });

  it('is a permission of its own', () => {
    permissions.granted.delete('invoices:manage');
    render(<NewInvoicePage />);

    expect(screen.getByText('You may not create invoices')).toBeInTheDocument();
    expect(create.mutate).not.toHaveBeenCalled();
  });
});

describe('the payments list', () => {
  const PAYMENTS: PaymentList = {
    items: [
      {
        id: 'pay-1',
        paidOn: '2026-08-31',
        amountCents: 3999,
        method: 'PROPERTYWARE_LEDGER',
        reference: 'PW-55231',
        note: null,
        recordedBy: { id: 'u1', displayName: 'Office' },
        recordedAt: '2026-08-31T15:00:00.000Z',
        invoice: { id: 'inv-2', number: '8237', subject: 'For Services Rendered', clientName: '2808 Example Ln' },
        property: { id: 'b2', address: '2808 Example Ln', city: 'Pearland' },
      },
    ],
    page: 1,
    pageSize: 25,
    total: 1,
    totalPages: 1,
    received: { last30: bucket(1, 3999), previous30: bucket(0, 0) },
  };

  it('lists each payment with its invoice, method and amount', async () => {
    hooks.usePayments.mockReturnValue(ready(PAYMENTS));
    render(<PaymentsPage />);
    await act(async () => undefined);

    const row = within(screen.getByRole('table', { name: 'Payments' })).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('2808 Example Ln');
    expect(row).toHaveTextContent('Aug 31, 2026');
    expect(within(row).getByRole('link', { name: '#8237' })).toHaveAttribute('href', '/invoices/inv-2');
    expect(row).toHaveTextContent('Propertyware ledger');
    expect(row).toHaveTextContent('$39.99');
    expect(screen.getByRole('region', { name: 'Payments at a glance' })).toHaveTextContent('$39.99');
  });
});

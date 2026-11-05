import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { InvoiceDetail, InvoiceDraft, InvoiceList, PaymentDetail, PaymentList } from '@texasrenters/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NewInvoicePage from './new/page';
import InvoicePage from './[invoiceId]/page';
import InvoicesPage from './page';
import PaymentsPage from '../payments/page';
import PaymentPage from '../payments/[paymentId]/page';

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
  usePayment: vi.fn(),
  useInvoiceActions: vi.fn(),
}));
vi.mock('@/lib/invoice-queries', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...hooks };
});
// Editing has its own tests (invoice-edits.test.tsx); here the invoice page only needs its history to read as empty.
vi.mock('@/lib/invoice-edit-queries', () => ({
  useInvoiceHistory: () => ({ isLoading: false, isError: false, data: { items: [], truncated: false } }),
  useInvoiceEdits: () => ({ edit: { mutate: vi.fn() }, changeStatus: { mutate: vi.fn() }, remove: { mutate: vi.fn() } }),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const params = vi.hoisted(() => ({ search: new URLSearchParams('inspection=insp-1') }));
vi.mock('next/navigation', () => ({
  useParams: () => ({ invoiceId: 'inv-1', paymentId: 'pay-1' }),
  useRouter: () => router,
  useSearchParams: () => params.search,
}));
vi.mock('@/lib/url-state', () => ({ useUrlState: (defaults: object) => [defaults, vi.fn(), vi.fn()] }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The PDF itself is rendered in its own test (lib/receipt-pdf); here, only that the page asks for it.
const receipts = vi.hoisted(() => ({ downloadReceipt: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/receipt-pdf/download-receipt', () => receipts);

const create = { mutate: vi.fn(), isPending: false };
const recordPayment = { mutate: vi.fn(), isPending: false };
const changePayment = { mutate: vi.fn(), isPending: false };
const removePayment = { mutate: vi.fn(), isPending: false };

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
  hooks.useInvoiceActions.mockReturnValue({ create, recordPayment, changePayment, removePayment });
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

  it('shows every other detail Jobber keeps: contacts, discount, tax, deposit, custom fields, notes and files', () => {
    hooks.useInvoice.mockReturnValue(
      ready({
        ...DETAIL,
        subtotalCents: 6000,
        taxCents: 446,
        totalCents: 5846,
        lineItems: [{ ...DETAIL.lineItems[0]!, serviceOn: '2026-09-29', taxable: false }],
        details: {
          contractDisclaimer: 'Payment is due within 30 days.',
          billingName: 'Example Owner',
          propertyAddress: null,
          billingSameAsProperty: false,
          clientEmails: ['owner@example.com', 'second@example.com'],
          clientPhones: ['(555) 010-0100'],
          paidOn: null,
          viewedAt: '2026-10-02T20:30:00.000Z',
          salespersonName: null,
          jobTitle: 'Quarterly service',
          discountCents: 600,
          discountPercent: 10,
          depositCents: 1000,
          tipsCents: 0,
          taxRateName: 'Texas',
          taxRatePercent: 8.25,
          taxInclusive: false,
          customFields: [{ label: 'Gate code', value: '1234' }],
          notes: [{ id: 'n1', kind: 'JOB', message: 'Gate sticks', pinned: true, writtenAt: '2026-09-29T15:00:00.000Z' }],
          files: [
            {
              id: 'f1',
              fileName: 'receipt.pdf',
              contentType: 'application/pdf',
              sizeBytes: 2_400_000,
              url: 'https://files.example.com/receipt.pdf',
              uploadedAt: '2026-09-29T15:00:00.000Z',
            },
          ],
        },
      }),
    );
    render(<InvoicePage />);

    const place = screen.getByRole('region', { name: 'Property 1902 Mockup Dr' });
    expect(place).toHaveTextContent('Example Owner · 1902 Mockup Dr, Houston, TX 77041');
    expect(within(place).getByRole('link', { name: 'owner@example.com' })).toHaveAttribute('href', 'mailto:owner@example.com');
    expect(within(place).getByRole('link', { name: '(555) 010-0100' })).toHaveAttribute('href', 'tel:5550100100');

    const details = screen.getByLabelText('Invoice details');
    expect(details).toHaveTextContent('Quarterly service');
    // 20:30 UTC is 3:30 PM in Texas.
    expect(details).toHaveTextContent('Viewed by the clientOct 2, 2026, 3:30 PM');
    expect(details).toHaveTextContent('Gate code1234');

    const table = screen.getByRole('table', { name: 'Products and services' });
    expect(table).toHaveTextContent('Done Sep 29, 2026 · Not taxed');
    expect(table).toHaveTextContent('Discount (10%)-$6.00');
    expect(table).toHaveTextContent('Texas (8.25%)$4.46');
    expect(table).toHaveTextContent('Deposit$10.00');
    expect(table).not.toHaveTextContent('Tips');

    expect(screen.getByLabelText('Notes')).toHaveTextContent(/Pinned.*On the job.*Gate sticks/);
    // Opened through the console's own link (phase 7), never Jobber's address straight from the page.
    expect(screen.getByRole('button', { name: /receipt\.pdf\s*2\.4 MB/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /receipt\.pdf/ })).not.toBeInTheDocument();
    expect(screen.getByText('Payment is due within 30 days.')).toBeInTheDocument();
  });

  it('opens each payment on its own page', () => {
    hooks.useInvoice.mockReturnValue(
      ready({
        ...DETAIL,
        payments: [
          {
            id: 'pay-1',
            paidOn: '2026-10-20',
            amountCents: 1000,
            method: 'BANK_TRANSFER',
            reference: 'ACH-77',
            note: null,
            recordedBy: null,
            recordedAt: '2026-10-20T16:00:00.000Z',
            origin: 'JOBBER',
          },
        ],
      }),
    );
    render(<InvoicePage />);

    expect(screen.getByRole('link', { name: 'Payment of $10.00 on Oct 20, 2026' })).toHaveAttribute('href', '/payments/pay-1');
  });
});

describe('a payment', () => {
  const PAYMENT: PaymentDetail = {
    id: 'pay-1',
    paidOn: '2026-10-20',
    amountCents: 3999,
    method: 'BANK_TRANSFER',
    reference: 'ACH-77',
    note: 'From the owner ledger',
    recordedBy: null,
    recordedAt: '2026-10-20T16:00:00.000Z',
    origin: 'JOBBER',
    jobberPaymentType: 'ACH_BANK_PAYMENT',
    invoice: { id: 'inv-1', number: '8439', subject: 'For Services Rendered', clientName: '1902 Mockup Dr' },
    property: { id: 'b1', address: '1902 Mockup Dr', city: 'Houston' },
    invoiceTotalCents: 3999,
    invoiceBalanceCents: 0,
    invoiceStatus: 'PAID',
    updatedAt: '2026-10-20T16:00:00.000Z',
    writesEnabled: false,
    brand: { name: 'Example Company', addressLine1: null, addressLine2: null, phone: null, email: null },
  };

  it('shows how much, when and how it was paid, and the invoice it went to', () => {
    hooks.usePayment.mockReturnValue(ready(PAYMENT));
    render(<PaymentPage />);

    expect(screen.getByRole('heading', { name: 'Payment for Invoice #8439' })).toBeInTheDocument();
    const facts = screen.getByLabelText('Payment details');
    expect(facts).toHaveTextContent('$39.99');
    expect(facts).toHaveTextContent('Oct 20, 2026');
    expect(facts).toHaveTextContent('Bank payment');
    expect(facts).toHaveTextContent('In Jobber: ACH bank payment');
    expect(facts).toHaveTextContent('ACH-77');
    expect(facts).toHaveTextContent('RecordedIn Jobber');
    expect(screen.getByText('From the owner ledger')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#8439' })).toHaveAttribute('href', '/invoices/inv-1');
    expect(screen.getByRole('link', { name: 'Open the invoice' })).toHaveAttribute('href', '/invoices/inv-1');
    expect(screen.getByText(/Paid in full/)).toBeInTheDocument();
  });

  it('says who recorded one made in the console, and when', () => {
    hooks.usePayment.mockReturnValue(
      ready({ ...PAYMENT, origin: 'CONSOLE', jobberPaymentType: null, recordedBy: { id: 'u1', displayName: 'Office' }, invoiceBalanceCents: 1000 }),
    );
    render(<PaymentPage />);

    const facts = screen.getByLabelText('Payment details');
    expect(facts).toHaveTextContent('By Office');
    expect(facts).toHaveTextContent('Oct 20, 2026, 11:00 AM');
    expect(facts).not.toHaveTextContent('In Jobber:');
    expect(screen.queryByText(/Paid in full/)).not.toBeInTheDocument();
  });

  it('downloads its receipt, for anybody who may see it', async () => {
    permissions.granted = new Set(['invoices:read']);
    hooks.usePayment.mockReturnValue(ready(PAYMENT));
    render(<PaymentPage />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download receipt' }));
    });
    expect(receipts.downloadReceipt).toHaveBeenCalledWith(PAYMENT);
  });

  it('is changed in Jobber until the console takes over, and says so to whoever records payments', () => {
    hooks.usePayment.mockReturnValue(ready(PAYMENT));
    const { unmount } = render(<PaymentPage />);
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Payments are changed in Jobber until the console takes over invoicing.');
    unmount();

    // Nothing to say to somebody who could not change it anyway.
    permissions.granted = new Set(['invoices:read']);
    hooks.usePayment.mockReturnValue(ready({ ...PAYMENT, writesEnabled: true }));
    render(<PaymentPage />);
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });

  it('corrects a payment in cents, sending the payment as it was read', () => {
    // $39.99 paid, $10.00 still owed: up to $49.99 with this payment taken back.
    hooks.usePayment.mockReturnValue(ready({ ...PAYMENT, writesEnabled: true, invoiceStatus: 'AWAITING_PAYMENT', invoiceBalanceCents: 1000 }));
    render(<PaymentPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Up to $49.99');
    expect(within(dialog).getByLabelText('Amount')).toHaveValue('39.99');
    expect(within(dialog).getByLabelText('Reference (optional)')).toHaveValue('ACH-77');

    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '50.00' } });
    expect(dialog).toHaveTextContent('That is more than the $49.99 this invoice still owes.');
    expect(within(dialog).getByRole('button', { name: 'Save the change' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Amount'), { target: { value: '45' } });
    fireEvent.change(within(dialog).getByLabelText('Reference (optional)'), { target: { value: '  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the change' }));

    expect(changePayment.mutate).toHaveBeenCalledWith(
      {
        paymentId: 'pay-1',
        input: {
          amountCents: 4500,
          paidOn: '2026-10-20',
          method: 'BANK_TRANSFER',
          reference: null,
          note: 'From the owner ledger',
          expectedUpdatedAt: '2026-10-20T16:00:00.000Z',
        },
      },
      expect.anything(),
    );
  });

  it('removes a payment only once asked, then goes back to its invoice', () => {
    hooks.usePayment.mockReturnValue(ready({ ...PAYMENT, writesEnabled: true }));
    removePayment.mutate.mockImplementation((_input, { onSuccess }) => onSuccess());
    render(<PaymentPage />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    const confirm = screen.getByRole('alertdialog');
    expect(confirm).toHaveTextContent('$39.99 comes off invoice #8439, which then owes it again.');
    expect(removePayment.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Remove payment' }));

    expect(removePayment.mutate).toHaveBeenCalledWith(
      { paymentId: 'pay-1', expectedUpdatedAt: '2026-10-20T16:00:00.000Z' },
      expect.anything(),
    );
    expect(router.push).toHaveBeenCalledWith('/invoices/inv-1');
  });

  it('says why a refund, or a payment on a closed invoice, is not changed', () => {
    hooks.usePayment.mockReturnValue(ready({ ...PAYMENT, writesEnabled: true, invoiceStatus: 'VOIDED' }));
    render(<PaymentPage />);
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('The invoice is voided, so its payments are not changed.');
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
    // The row opens the payment; the invoice number still opens the invoice.
    expect(within(row).getAllByRole('link').map((link) => link.getAttribute('href'))).toContain('/payments/pay-1');
  });
});

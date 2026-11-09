import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { DeliverableInvoice, InvoiceEmailSettingsView, PaymentDetail } from '@texasrenters/shared';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvoiceEmailsSection } from '@/components/invoices/invoice-emails-section';

import PaymentPage from '../payments/[paymentId]/page';
import DeliverInvoicesPage from './deliver/page';

/**
 * What Jobber emailed by itself and stops emailing at Take over (2026-11-09,
 * phase 1 of the invoice gap review): follow-ups about unpaid invoices,
 * receipts, and many invoices at once. Every email is billed, so nothing is
 * sent but on a press, and nothing before Take over. Everything invented.
 */

const emails = vi.hoisted(() => ({
  settings: null as unknown,
  save: { mutate: vi.fn(), isPending: false },
  receipt: { mutate: vi.fn(), isPending: false },
  deliverable: null as unknown,
  deliver: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/invoice-delivery-queries', () => ({
  useInvoiceEmailSettings: () => emails.settings,
  useSaveInvoiceEmailSettings: () => emails.save,
  useSendReceipt: () => emails.receipt,
  useSendInvoice: () => ({ mutate: vi.fn(), isPending: false }),
  useDeliverableInvoices: () => emails.deliverable,
  useDeliverInvoices: () => emails.deliver,
}));
const hooks = vi.hoisted(() => ({ usePayment: vi.fn() }));
vi.mock('@/lib/invoice-queries', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...hooks }));
const pdfs = vi.hoisted(() => ({ downloadInvoices: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/invoice-pdf/download-invoice', () => pdfs);
const calls = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/lib/api', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), api: calls.api }));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('next/navigation', () => ({ useParams: () => ({ paymentId: 'pay-1' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const page = (children: ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>);

const ready = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });

const SETTINGS: InvoiceEmailSettingsView = {
  followUpsEnabled: true,
  followUpDays: [0, 4],
  receiptsAutomatic: false,
  takenOver: true,
  updatedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage', 'payments:record']);
  emails.settings = ready(SETTINGS);
});

describe('reminders and receipts in the settings', () => {
  /** The days listed, without their Remove buttons. */
  const days = () =>
    within(screen.getByRole('list', { name: 'When they go' }))
      .getAllByRole('listitem')
      .map((item) => item.firstElementChild?.textContent);

  it("start as Jobber's: on the due date and four days after, and say they wait for Take over", () => {
    emails.settings = ready({ ...SETTINGS, takenOver: false });
    render(<InvoiceEmailsSection mayChange />);
    const section = screen.getByRole('region', { name: 'Reminders and receipts' });
    expect(within(section).getByLabelText('Email clients about unpaid invoices')).toBeChecked();
    expect(days()).toEqual(['On the due date', '4 days after it is due']);
    expect(section).toHaveTextContent('Nothing here is sent until the console takes over invoicing');
    expect(within(section).getByRole('button', { name: 'Save reminders and receipts' })).toBeDisabled();
  });

  it("once taken over, says to turn Jobber's own off, or the client gets both", () => {
    render(<InvoiceEmailsSection mayChange />);
    expect(screen.getByRole('note')).toHaveTextContent("Turn off Jobber's two invoice follow-up automations in Jobber.");
  });

  it('adds and removes a day, and saves against the settings as they were read', () => {
    emails.settings = ready({ ...SETTINGS, updatedAt: '2026-11-09T15:00:00.000Z' });
    render(<InvoiceEmailsSection mayChange />);

    fireEvent.change(screen.getByLabelText('Days after the due date'), { target: { value: '4' } });
    expect(screen.getByText('There is a follow-up on that day already.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Days after the due date'), { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add a follow-up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove the follow-up on the due date' }));
    fireEvent.click(screen.getByLabelText('Email a receipt when a payment is recorded here'));
    expect(days()).toEqual(['4 days after it is due', '14 days after it is due']);

    fireEvent.click(screen.getByRole('button', { name: 'Save reminders and receipts' }));
    expect(emails.save.mutate).toHaveBeenCalledWith(
      { followUpsEnabled: true, followUpDays: [4, 14], receiptsAutomatic: true, expectedUpdatedAt: '2026-11-09T15:00:00.000Z' },
      expect.anything(),
    );
  });

  it('is read-only for anybody who does not make invoices', () => {
    render(<InvoiceEmailsSection mayChange={false} />);
    expect(screen.getByLabelText('Email clients about unpaid invoices')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
  });
});

describe("a payment's receipt", () => {
  const PAYMENT: PaymentDetail = {
    id: 'pay-1',
    paidOn: '2026-11-09',
    amountCents: 3999,
    method: 'BANK_TRANSFER',
    reference: null,
    note: null,
    recordedBy: { id: 'u1', displayName: 'Office' },
    recordedAt: '2026-11-09T16:00:00.000Z',
    origin: 'CONSOLE',
    jobberPaymentType: null,
    invoice: { id: 'inv-1', number: '8439', subject: 'For Services Rendered', clientName: '100 Example Way' },
    property: null,
    invoiceTotalCents: 3999,
    invoiceBalanceCents: 0,
    invoiceStatus: 'PAID',
    updatedAt: '2026-11-09T16:00:00.000Z',
    writesEnabled: true,
    brand: { name: 'Example Company', addressLine1: null, addressLine2: null, phone: null, email: null },
    receipts: [
      {
        id: 'd1',
        channel: 'EMAIL',
        kind: 'RECEIPT',
        followUpDay: null,
        recipients: ['owner@example.com'],
        status: 'SENT',
        failure: null,
        sentBy: null,
        createdAt: '2026-11-09T16:00:01.000Z',
        sentAt: '2026-11-09T16:00:02.000Z',
      },
    ],
    receiptTo: ['owner@example.com', 'manager@example.com'],
  };

  it('is emailed on the press, to the usual addresses, under one key', () => {
    hooks.usePayment.mockReturnValue(ready(PAYMENT));
    page(<PaymentPage />);
    // The one sent by itself after the payment was recorded.
    const sent = screen.getByRole('heading', { name: 'Receipts emailed' }).closest('section')!;
    expect(sent).toHaveTextContent('Receipt emailed');
    expect(sent).toHaveTextContent('sent by itself');

    fireEvent.click(screen.getByRole('button', { name: 'Email receipt' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('owner@example.com')).toBeChecked();
    expect(within(dialog).getByLabelText('manager@example.com')).toBeChecked();
    fireEvent.click(within(dialog).getByLabelText('manager@example.com'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send receipt' }));

    const [{ paymentId, input }] = emails.receipt.mutate.mock.calls[0]!;
    expect(paymentId).toBe('pay-1');
    expect(input.to).toEqual(['owner@example.com']);
    expect(input.clientRequestId).toMatch(/^web-/);
  });

  it('is emailed from Jobber until the console takes over, and only by whoever records payments', () => {
    hooks.usePayment.mockReturnValue(ready({ ...PAYMENT, writesEnabled: false }));
    const { unmount } = page(<PaymentPage />);
    expect(screen.queryByRole('button', { name: 'Email receipt' })).not.toBeInTheDocument();
    unmount();

    permissions.granted = new Set(['invoices:read']);
    hooks.usePayment.mockReturnValue(ready(PAYMENT));
    page(<PaymentPage />);
    expect(screen.queryByRole('button', { name: 'Email receipt' })).not.toBeInTheDocument();
  });
});

describe('Batch Deliver', () => {
  const owed = (id: string, number: string, to: string[]): DeliverableInvoice => ({
    id,
    number,
    clientName: `${number} Example Way`,
    status: 'AWAITING_PAYMENT',
    issuedOn: '2026-11-02',
    dueOn: '2026-12-02',
    totalCents: 6499,
    balanceCents: 6499,
    to,
  });
  const LIST = [owed('inv-1', '8439', ['owner@example.com']), owed('inv-2', '8440', ['a@example.com', 'b@example.com']), owed('inv-3', '8441', [])];

  beforeEach(() => {
    emails.deliverable = ready(LIST);
  });

  it('emails the chosen ones to their clients after asking, leaving out any with no address', () => {
    page(<DeliverInvoicesPage />);
    expect(screen.getByText('No email address for this client')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Choose every invoice'));
    fireEvent.click(screen.getByRole('button', { name: 'Email 2 invoices' }));
    const asking = screen.getByRole('alertdialog');
    expect(asking).toHaveTextContent("3 emails in all, counted toward the console's 200 a day.");
    expect(asking).toHaveTextContent('1 chosen has no address and is left out.');
    fireEvent.click(within(asking).getByRole('button', { name: 'Email them' }));

    const [input] = emails.deliver.mutate.mock.calls[0]!;
    expect(input.invoices).toEqual([
      { invoiceId: 'inv-1', to: ['owner@example.com'] },
      { invoiceId: 'inv-2', to: ['a@example.com', 'b@example.com'] },
    ]);
    expect(input.batchKey).toMatch(/^web-/);
    expect(input.message).toBeNull();
  });

  it('lists what did not go, and why', () => {
    emails.deliver.mutate.mockImplementationOnce((_input, { onSuccess }) =>
      onSuccess({
        results: [
          { invoiceId: 'inv-1', status: 'SENT', problem: null },
          { invoiceId: 'inv-2', status: 'FAILED', problem: 'The console has sent its 200 invoice emails today.' },
        ],
      }),
    );
    page(<DeliverInvoicesPage />);
    fireEvent.click(screen.getByLabelText('Choose invoice #8439, 8439 Example Way'));
    fireEvent.click(screen.getByLabelText('Choose invoice #8440, 8440 Example Way'));
    fireEvent.click(screen.getByRole('button', { name: 'Email 2 invoices' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Email them' }));

    const done = screen.getByRole('status', { name: 'What was sent' });
    expect(done).toHaveTextContent('1 invoice emailed');
    expect(done).toHaveTextContent('invoice #8440, 8440 Example Way: The console has sent its 200 invoice emails today.');
  });

  it('prints the chosen ones as one PDF, any with no address too, and offers only that before Take over', async () => {
    emails.settings = ready({ ...SETTINGS, takenOver: false });
    calls.api.mockImplementation(async (path: string) => ({ id: path.split('/').at(-1) }));
    page(<DeliverInvoicesPage />);
    expect(screen.queryByRole('button', { name: /^Email/ })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('Invoices are emailed from Jobber until the console takes over invoicing.');

    fireEvent.click(screen.getByLabelText('Choose invoice #8439, 8439 Example Way'));
    fireEvent.click(screen.getByLabelText('Choose invoice #8441, 8441 Example Way'));
    fireEvent.click(screen.getByRole('button', { name: 'Download 2 as one PDF' }));

    await waitFor(() => expect(pdfs.downloadInvoices).toHaveBeenCalledTimes(1));
    const [invoices, name] = pdfs.downloadInvoices.mock.calls[0]!;
    expect(invoices.map((invoice: { id: string }) => invoice.id)).toEqual(['inv-1', 'inv-3']);
    expect(name).toMatch(/^Invoices \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\.pdf$/);
    expect(emails.deliver.mutate).not.toHaveBeenCalled();
  });

  it('is for whoever makes invoices', () => {
    permissions.granted = new Set(['invoices:read']);
    page(<DeliverInvoicesPage />);
    expect(screen.getByText('You may not send invoices')).toBeInTheDocument();
  });
});

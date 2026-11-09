import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { InvoiceDetail, InvoiceExtraDetails } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import InvoicePage from './[invoiceId]/page';

/**
 * Sending an invoice and its PDF (2026-11-06, phase 5): Download PDF on every
 * invoice, Send once the console owns invoicing, the dialog's addresses, note
 * and key, a draft marked sent first, and the sends listed on the page. Each
 * email is billed, so nothing is sent but on the press. Everything invented.
 */

const hooks = vi.hoisted(() => ({
  useInvoice: vi.fn(),
  useInvoiceActions: vi.fn(() => ({ recordPayment: { mutate: vi.fn(), isPending: false } })),
}));
vi.mock('@/lib/invoice-queries', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...hooks }));
const edits = vi.hoisted(() => ({
  edit: { mutate: vi.fn(), isPending: false },
  changeStatus: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/invoice-edit-queries', () => ({
  useInvoiceEdits: () => edits,
  useInvoiceHistory: () => ({ isLoading: false, isError: false, data: { items: [], truncated: false } }),
}));
const sending = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
vi.mock('@/lib/invoice-delivery-queries', () => ({ useSendInvoice: () => sending }));
const pdfs = vi.hoisted(() => ({
  downloadInvoice: vi.fn().mockResolvedValue(undefined),
  previewInvoice: vi.fn().mockResolvedValue(undefined),
  // A PDF's first bytes, as the browser would make them.
  invoicePdf: vi.fn().mockResolvedValue({ size: 8, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4').buffer }),
  invoiceFileName: vi.fn(() => '100 Example Way_Invoice 8439.pdf'),
}));
vi.mock('@/lib/invoice-pdf/download-invoice', () => pdfs);
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('next/navigation', () => ({ useParams: () => ({ invoiceId: 'inv-1' }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Notes, files and the office's email words have their own tests (invoice-records.test.tsx).
vi.mock('@/lib/invoice-record-queries', () => ({
  useInvoiceRecords: () => ({
    addNote: { mutate: vi.fn(), isPending: false },
    removeNote: { mutate: vi.fn(), isPending: false },
    addFile: { mutate: vi.fn(), isPending: false },
    removeFile: { mutate: vi.fn(), isPending: false },
  }),
  useEmailTemplates: () => ({ isLoading: false, data: undefined }),
  useSaveEmailTemplates: () => ({ mutate: vi.fn(), isPending: false }),
}));

const READ_AT = '2026-11-01T15:00:00.000Z';

const DETAIL: InvoiceDetail = {
  id: 'inv-1',
  number: '8439',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '100 Example Way',
  property: { id: 'b1', address: '100 Example Way', city: 'Sampletown' },
  inspectionId: null,
  jobNumber: null,
  issuedOn: '2026-11-01',
  dueOn: '2026-12-01',
  totalCents: 6499,
  balanceCents: 6499,
  jobberUrl: null,
  paymentTerms: 'Net 30',
  billingAddress: null,
  lineItems: [{ name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 6499, totalCents: 6499 }],
  subtotalCents: 6499,
  taxCents: 0,
  payments: [],
  clientMessage: null,
  accountBalanceCents: null,
  createdAt: '2026-11-01T14:00:00.000Z',
  updatedAt: READ_AT,
  paidCents: 0,
  writesEnabled: true,
  details: { clientEmails: ['owner@example.com', 'manager@example.com'], clientPhones: [], notes: [], files: [], customFields: [] } as unknown as InvoiceExtraDetails,
  deliveries: [],
};

const ready = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage']);
  hooks.useInvoice.mockReturnValue(ready(DETAIL));
});

const openSend = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  return screen.getByRole('dialog');
};
/** Sent without the PDF: these tests are about the addresses, the note and the key. */
const withoutPdf = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByLabelText('Attach the invoice as a PDF'));

describe('the PDF', () => {
  it('downloads for anybody who reads invoices, Jobber holding them or not', async () => {
    permissions.granted = new Set(['invoices:read']);
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, writesEnabled: false }));
    render(<InvoicePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(pdfs.downloadInvoice).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }));
    // Nobody here sends it: Jobber holds the invoices, and this person does not make them.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });
});

describe('sending an invoice', () => {
  it('is offered once the console owns invoicing, and never for a voided invoice', () => {
    const { unmount } = render(<InvoicePage />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    unmount();
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, status: 'VOIDED' }));
    render(<InvoicePage />);
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('goes to the primary address and any typed in, with the note, on the press only', () => {
    render(<InvoicePage />);
    const dialog = openSend();
    withoutPdf(dialog);
    expect(sending.mutate).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('checkbox', { name: /owner@example\.com/ })).toBeChecked();
    expect(within(dialog).getByRole('checkbox', { name: /manager@example\.com/ })).not.toBeChecked();
    expect(within(dialog).getByLabelText('Message')).toHaveValue(
      'Hello,\n\nHere is invoice #8439 for 100 Example Way: $64.99 is due by Dec 1, 2026.\n\nThank you.',
    );

    fireEvent.change(within(dialog).getByLabelText('Also send to (optional)'), { target: { value: 'tenant@example.com' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Email 2 people' }));

    expect(sending.mutate).toHaveBeenCalledTimes(1);
    const [{ id, input }] = sending.mutate.mock.calls[0]!;
    expect(id).toBe('inv-1');
    expect(input).toMatchObject({ to: ['owner@example.com', 'tenant@example.com'], message: expect.stringContaining('invoice #8439') });
    expect(input.clientRequestId).toEqual(expect.any(String));
  });

  it('attaches the invoice as a PDF, made from it on the press (2026-11-10)', async () => {
    render(<InvoicePage />);
    const dialog = openSend();
    expect(within(dialog).getByLabelText('Attach the invoice as a PDF')).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send email' }));

    await waitFor(() => expect(sending.mutate).toHaveBeenCalledTimes(1));
    expect(pdfs.invoicePdf).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1' }));
    const [{ input }] = sending.mutate.mock.calls[0]!;
    expect(input.attachment).toEqual({ fileName: '100 Example Way_Invoice 8439.pdf', contentBase64: btoa('%PDF-1.4') });
  });

  it('sends nothing when the PDF cannot be made', async () => {
    pdfs.invoicePdf.mockRejectedValueOnce(new Error('The PDF is too large to attach. Send it without.'));
    render(<InvoicePage />);
    fireEvent.click(within(openSend()).getByRole('button', { name: 'Send email' }));
    await waitFor(() => expect(pdfs.invoicePdf).toHaveBeenCalled());
    expect(sending.mutate).not.toHaveBeenCalled();
  });

  it('says what is wrong with the addresses, and sends nothing until it is right', () => {
    render(<InvoicePage />);
    const dialog = openSend();
    fireEvent.change(within(dialog).getByLabelText('Also send to (optional)'), { target: { value: 'not-an-address' } });
    expect(dialog).toHaveTextContent('not-an-address is not an email address.');
    expect(within(dialog).getByRole('button', { name: 'Email 2 people' })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Also send to (optional)'), {
      target: { value: 'a@example.com b@example.com c@example.com d@example.com e@example.com' },
    });
    expect(dialog).toHaveTextContent('Send it to at most 5 people at a time.');
    expect(sending.mutate).not.toHaveBeenCalled();
  });

  it('asks for an address when Jobber has none for the client', () => {
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, details: { ...DETAIL.details!, clientEmails: [] } }));
    render(<InvoicePage />);
    const dialog = openSend();
    expect(dialog).toHaveTextContent('Jobber has no email address for this client.');
    expect(within(dialog).getByRole('button', { name: 'Send email' })).toBeDisabled();
  });

  it('marks a draft sent first, then emails the invoice as it now is', () => {
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, status: 'DRAFT', number: null }));
    const marked = { ...DETAIL, number: '8440', updatedAt: '2026-11-06T15:00:00.000Z' };
    edits.changeStatus.mutate.mockImplementation((_input, { onSuccess }) => onSuccess(marked));
    render(<InvoicePage />);
    const dialog = openSend();
    withoutPdf(dialog);
    expect(dialog).toHaveTextContent('The draft is marked sent first.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark sent and email' }));

    expect(edits.changeStatus.mutate).toHaveBeenCalledWith(
      { id: 'inv-1', input: { action: 'MARK_SENT', expectedUpdatedAt: READ_AT } },
      expect.anything(),
    );
    expect(sending.mutate).toHaveBeenCalledWith(
      { id: 'inv-1', input: expect.objectContaining({ to: ['owner@example.com'] }) },
      expect.anything(),
    );
  });

  it('keeps its key when the request got no answer, and takes a new one once the server has answered', () => {
    render(<InvoicePage />);
    const dialog = openSend();
    withoutPdf(dialog);
    const press = () => fireEvent.click(within(dialog).getByRole('button', { name: 'Send email' }));

    sending.mutate.mockImplementationOnce((_input, { onError }) => onError(new ApiError(0, 'NETWORK_ERROR', 'The API could not be reached.')));
    press();
    sending.mutate.mockImplementationOnce((_input, { onError }) => onError(new ApiError(502, 'INVOICE_EMAIL_FAILED', 'Email is not set up.')));
    press();
    press();

    const keys = sending.mutate.mock.calls.map(([{ input }]) => input.clientRequestId);
    // The same press retried after no answer; a new send after the server said no.
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('lists the sends on the page: to whom, when, by whom, and why one did not go', () => {
    hooks.useInvoice.mockReturnValue(
      ready({
        ...DETAIL,
        deliveries: [
          {
            id: 'd4',
            channel: 'EMAIL',
            kind: 'RECEIPT',
            followUpDay: null,
            recipients: ['owner@example.com'],
            status: 'SENT',
            failure: null,
            sentBy: { id: 'u1', displayName: 'Office' },
            createdAt: '2026-11-12T16:00:00.000Z',
            sentAt: '2026-11-12T16:00:01.000Z',
          },
          {
            id: 'd3',
            channel: 'EMAIL',
            kind: 'FOLLOW_UP',
            followUpDay: 4,
            recipients: ['owner@example.com'],
            status: 'SENT',
            failure: null,
            sentBy: null,
            createdAt: '2026-11-10T19:30:00.000Z',
            sentAt: '2026-11-10T19:30:01.000Z',
          },
          {
            id: 'd2',
            channel: 'EMAIL',
            kind: 'INVOICE',
            followUpDay: null,
            recipients: ['owner@example.com'],
            status: 'FAILED',
            failure: 'Email is not set up for the console yet. Not sent to owner@example.com.',
            sentBy: { id: 'u1', displayName: 'Office' },
            createdAt: '2026-11-06T16:00:00.000Z',
            sentAt: null,
          },
          {
            id: 'd1',
            channel: 'EMAIL',
            kind: 'INVOICE',
            followUpDay: null,
            recipients: ['owner@example.com', 'manager@example.com'],
            status: 'SENT',
            failure: null,
            sentBy: { id: 'u1', displayName: 'Office' },
            createdAt: '2026-11-05T20:30:00.000Z',
            sentAt: '2026-11-05T20:30:02.000Z',
          },
        ],
      }),
    );
    render(<InvoicePage />);
    const sends = screen.getByRole('heading', { name: 'Emailed to the client' }).closest('section')!;
    expect(sends).toHaveTextContent('Not sent');
    expect(sends).toHaveTextContent('Email is not set up for the console yet.');
    // 20:30 UTC is 2:30 PM in Texas.
    expect(sends).toHaveTextContent('Nov 5, 2026, 2:30 PM · Office');
    expect(sends).toHaveTextContent('owner@example.com, manager@example.com');
    // A follow-up the console sent by itself, and a receipt (2026-11-09).
    expect(sends).toHaveTextContent('Follow-up emailedNov 10, 2026, 1:30 PM · 4 days overdue · sent by itself');
    expect(sends).toHaveTextContent('Receipt emailedNov 12, 2026, 10:00 AM · Office');
  });
});

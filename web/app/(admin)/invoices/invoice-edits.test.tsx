import { fireEvent, render, screen, within } from '@testing-library/react';
import type { InvoiceDetail, InvoiceHistory } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EditInvoicePage from './[invoiceId]/edit/page';
import InvoicePage from './[invoiceId]/page';

/**
 * Editing an invoice in the console (2026-11-06, phase 3): Edit and the More
 * menu on its page, its History, and the edit page with the totals worked out
 * as it is typed. Off until the console owns invoicing. Everything invented.
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
  history: { current: { items: [], truncated: false } as InvoiceHistory },
}));
vi.mock('@/lib/invoice-edit-queries', () => ({
  useInvoiceEdits: () => edits,
  useInvoiceHistory: () => ({ isLoading: false, isError: false, data: edits.history.current }),
}));
// Sending is phase 5's, tested in invoice-sending.test.tsx.
vi.mock('@/lib/invoice-delivery-queries', () => ({ useSendInvoice: () => ({ mutate: vi.fn(), isPending: false }) }));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useParams: () => ({ invoiceId: 'inv-1' }), useRouter: () => router }));
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
  lineItems: [
    { name: 'Filter Change', description: null, quantity: 1, unitPriceCents: 3999, totalCents: 3999, taxable: null, serviceOn: null },
    { name: 'Pest Control', description: null, quantity: 1, unitPriceCents: 2500, totalCents: 2500, taxable: null, serviceOn: null },
  ],
  subtotalCents: 6499,
  taxCents: 0,
  payments: [],
  clientMessage: 'Thank you.',
  accountBalanceCents: null,
  createdAt: '2026-11-01T14:00:00.000Z',
  updatedAt: READ_AT,
  paidCents: 0,
  writesEnabled: true,
};

const ready = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage']);
  hooks.useInvoice.mockReturnValue(ready(DETAIL));
  edits.history.current = { items: [], truncated: false };
});

describe("an invoice's page", () => {
  it('offers Edit and the More menu only to whoever makes invoices, once the console owns invoicing', () => {
    const { unmount } = render(<InvoicePage />);
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/invoices/inv-1/edit');
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    unmount();

    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, writesEnabled: false }));
    const off = render(<InvoicePage />);
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    off.unmount();

    permissions.granted = new Set(['invoices:read']);
    hooks.useInvoice.mockReturnValue(ready(DETAIL));
    render(<InvoicePage />);
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('keeps one in Xero as Xero has it (2026-11-12): opened there, and nothing to change, send or pay here', () => {
    permissions.granted = new Set(['invoices:read', 'invoices:manage', 'payments:record']);
    hooks.useInvoice.mockReturnValue(
      ready({
        ...DETAIL,
        status: 'AWAITING_PAYMENT',
        balanceCents: 7500,
        jobberUrl: 'https://secure.getjobber.com/invoices/1',
        xero: { status: 'DRAFT', url: 'https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=x-1', kept: true },
      }),
    );
    render(<InvoicePage />);
    expect(screen.getByRole('link', { name: 'Open in Xero' })).toHaveAttribute('href', 'https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=x-1');
    expect(screen.queryByRole('link', { name: 'Open in Jobber' })).not.toBeInTheDocument();
    expect(screen.getByText('Draft in Xero')).toBeInTheDocument();
    expect(screen.getByText(/Change it, record its payments and send it in Xero/)).toBeInTheDocument();
    for (const name of ['More', 'Send', 'Record payment']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('voids an invoice only once asked, against the invoice as it was read', async () => {
    render(<InvoicePage />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false });
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Create similar', 'Void invoice', 'Close as bad debt']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Void invoice' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('It owes nothing, and stays on the record as voided.');
    expect(edits.changeStatus.mutate).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Void invoice' }));
    expect(edits.changeStatus.mutate).toHaveBeenCalledWith(
      { id: 'inv-1', input: { action: 'VOID', expectedUpdatedAt: READ_AT } },
      expect.anything(),
    );
  });

  it('deletes a draft and goes back to the list', async () => {
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, status: 'DRAFT' }));
    edits.remove.mutate.mockImplementation((_input, { onSuccess }) => onSuccess());
    render(<InvoicePage />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More' }), { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Delete draft' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete draft' }));

    expect(edits.remove.mutate).toHaveBeenCalledWith({ id: 'inv-1', expectedUpdatedAt: READ_AT }, expect.anything());
    expect(router.push).toHaveBeenCalledWith('/invoices');
  });

  it('shows what happened to it, newest first, and who did it', () => {
    edits.history.current = {
      items: [
        { id: 'a1', at: '2026-11-03T20:30:00.000Z', actor: { id: 'u1', displayName: 'Office' }, title: 'Invoice edited', lines: ['Subject: A → B'] },
      ],
      truncated: false,
    };
    render(<InvoicePage />);
    const history = screen.getByRole('region', { name: 'History' });
    expect(history).toHaveTextContent('Invoice edited');
    // 20:30 UTC is 2:30 PM in Texas.
    expect(history).toHaveTextContent('Nov 3, 2026, 2:30 PM · Office');
    expect(history).toHaveTextContent('Subject: A → B');
  });

  it('says plainly when nothing has been changed here yet', () => {
    render(<InvoicePage />);
    expect(screen.getByRole('region', { name: 'History' })).toHaveTextContent('Nothing has been changed here yet.');
  });
});

describe('the edit page', () => {
  it('is for whoever makes invoices, once the console owns invoicing, on an invoice still open', () => {
    permissions.granted = new Set(['invoices:read']);
    const { unmount } = render(<EditInvoicePage />);
    expect(screen.getByText('You may not edit invoices')).toBeInTheDocument();
    unmount();

    permissions.granted = new Set(['invoices:read', 'invoices:manage']);
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, writesEnabled: false }));
    const off = render(<EditInvoicePage />);
    expect(screen.getByText('Invoices are edited in Jobber until the console takes over invoicing.')).toBeInTheDocument();
    off.unmount();

    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, status: 'VOIDED' }));
    render(<EditInvoicePage />);
    expect(screen.getByText('A voided invoice is reopened before it is edited.')).toBeInTheDocument();
  });

  it('opens with the invoice as it is, and works the totals out as it is typed', () => {
    render(<EditInvoicePage />);
    expect(screen.getByLabelText('Subject')).toHaveValue('For Services Rendered');
    expect(screen.getByLabelText('Invoice #')).toHaveValue('8439');
    expect(screen.getByLabelText('Line 1: name')).toHaveValue('Filter Change');
    expect(screen.getByRole('button', { name: 'Save · $64.99' })).toBeEnabled();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Add a tax' }));
    fireEvent.change(screen.getByLabelText('Tax name'), { target: { value: 'Texas' } });
    fireEvent.change(screen.getByLabelText('Tax percent'), { target: { value: '8.25' } });
    // Pest control is not taxed.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Line 2: taxed' }));

    // $39.99 × 8.25% = $3.30.
    expect(screen.getByLabelText('Totals')).toHaveTextContent('Texas$3.30');
    expect(screen.getByRole('button', { name: 'Save · $68.29' })).toBeInTheDocument();
  });

  it('refuses a total below what has been paid, before anything is sent', () => {
    hooks.useInvoice.mockReturnValue(ready({ ...DETAIL, paidCents: 6000, balanceCents: 499 }));
    render(<EditInvoicePage />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 1' }));

    expect(screen.getByText('It would come to $25.00, less than the $60.00 already paid. Change or remove a payment first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Save/ })).toBeDisabled();
  });

  it('sends the edit in cents, with the invoice as it was read, and goes back to it', () => {
    edits.edit.mutate.mockImplementation((_input, { onSuccess }) => onSuccess({ ...DETAIL, totalCents: 7998, balanceCents: 7998 }));
    render(<EditInvoicePage />);
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: ' Quarterly service ' } });
    fireEvent.change(screen.getByLabelText('Line 1: quantity'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save · $79.98' }));

    expect(edits.edit.mutate).toHaveBeenCalledWith(
      {
        id: 'inv-1',
        input: {
          subject: 'Quarterly service',
          number: '8439',
          issuedOn: '2026-11-01',
          dueOn: '2026-12-01',
          lineItems: [{ name: 'Filter Change', description: null, quantity: 2, unitPriceCents: 3999, serviceOn: null, taxable: true }],
          discount: null,
          tax: null,
          clientMessage: 'Thank you.',
          contractDisclaimer: null,
          // Jobber's "Client view", as the invoice had it: all of it shown (2026-11-10).
          clientView: { showQuantities: true, showUnitPrices: true, showLineTotals: true, showAccountBalance: true, showLateStamp: true },
          expectedUpdatedAt: READ_AT,
        },
      },
      expect.anything(),
    );
    expect(router.push).toHaveBeenCalledWith('/invoices/inv-1');
  });
});

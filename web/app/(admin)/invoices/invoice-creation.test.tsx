import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { InvoiceDraft, InvoiceList, UninvoicedVisitList } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { businessToday, shiftDay } from '@/lib/clock';

import BatchInvoicesPage from './batch/page';
import NewInvoicePage from './new/page';
import InvoicesPage from './page';

/**
 * Making invoices (2026-11-06, phase 4): for a property no visit covers, as a
 * draft, and many at once from the finished visits nobody has invoiced.
 * Everything invented.
 */

const hooks = vi.hoisted(() => ({
  useInvoiceDraft: vi.fn(),
  useInvoices: vi.fn(),
  useInvoiceActions: vi.fn(),
  // The invoice a new one is like (Create similar, 2026-11-10); none unless asked.
  useInvoice: vi.fn((): { isLoading: boolean; isError: boolean; data: unknown } => ({ isLoading: false, isError: false, data: undefined })),
}));
vi.mock('@/lib/invoice-queries', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...hooks }));
const batches = vi.hoisted(() => ({ useUninvoicedVisits: vi.fn(), useBatchInvoices: vi.fn() }));
vi.mock('@/lib/invoice-batch-queries', () => batches);
vi.mock('@/lib/queries', () => ({
  usePropertyOptions: () => ({ data: { pages: [{ items: [] }] }, isLoading: false, hasNextPage: false, fetchNextPage: vi.fn() }),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
const router = vi.hoisted(() => ({ push: vi.fn() }));
const params = vi.hoisted(() => ({ search: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useRouter: () => router, useSearchParams: () => params.search }));
vi.mock('@/lib/url-state', () => ({ useUrlState: (defaults: object) => [defaults, vi.fn(), vi.fn()] }));
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

const NOW = new Date('2026-11-06T18:00:00.000Z');
const TODAY = '2026-11-06';
const ready = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });
const create = { mutate: vi.fn(), isPending: false };
const createPerCompany = { mutate: vi.fn(), isPending: false };
const batch = { mutate: vi.fn(), isPending: false };

const PROPERTY_DRAFT: InvoiceDraft = {
  inspection: null,
  property: { id: 'b1', address: '100 Example Way', city: 'Sampletown' },
  clientName: '100 Example Way',
  subject: 'For Services Rendered',
  issuedOn: TODAY,
  paymentTermsDays: 30,
  invoices: [{ xeroTenantId: null, lineItems: [] }],
  clientMessage: '',
  existing: [],
  products: [{ name: 'Filter Change', unitPriceCents: 3999 }],
  organisations: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
  permissions.granted = new Set(['invoices:read', 'invoices:manage']);
  params.search = new URLSearchParams();
  hooks.useInvoiceActions.mockReturnValue({ create, createPerCompany });
  hooks.useInvoiceDraft.mockReturnValue(ready(PROPERTY_DRAFT));
  batches.useBatchInvoices.mockReturnValue(batch);
});

describe('a new invoice', () => {
  it('asks for the property first when it is not for a visit', () => {
    render(<NewInvoicePage />);
    expect(screen.getByText('Property')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Invoice finished visits in a batch' })).toHaveAttribute('href', '/invoices/batch');
    expect(hooks.useInvoiceDraft).toHaveBeenLastCalledWith({});
  });

  it("makes one out to the property, with the lines typed, kept as a draft when asked", () => {
    params.search = new URLSearchParams('property=b1');
    render(<NewInvoicePage />);
    expect(hooks.useInvoiceDraft).toHaveBeenLastCalledWith({ propertyId: 'b1' });
    expect(screen.getByText(/for work no visit covers/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add a line' }));
    fireEvent.change(screen.getByLabelText('Line 1: name'), { target: { value: 'Gate repair' } });
    fireEvent.change(screen.getByLabelText('Line 1: unit price'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));

    expect(create.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        propertyId: 'b1',
        asDraft: true,
        lineItems: [{ name: 'Gate repair', description: null, quantity: 1, unitPriceCents: 12000 }],
      }),
      expect.anything(),
    );
    expect(create.mutate.mock.calls[0][0]).not.toHaveProperty('inspectionId');
  });

  it("starts like another invoice when asked to (Jobber's Create similar): its property, subject, lines and message", () => {
    params.search = new URLSearchParams('similar=inv-9');
    hooks.useInvoice.mockReturnValue({
      isLoading: false,
      isError: false,
      data: {
        id: 'inv-9',
        subject: 'Quarterly service',
        property: { id: 'b1', address: '100 Example Way', city: 'Sampletown' },
        lineItems: [{ name: 'Filter Change', description: '2 filters', quantity: 2, unitPriceCents: 3999, totalCents: 7998 }],
        clientMessage: 'Thank you, as always.',
      },
    });
    render(<NewInvoicePage />);

    expect(hooks.useInvoice).toHaveBeenCalledWith('inv-9');
    expect(hooks.useInvoiceDraft).toHaveBeenLastCalledWith({ propertyId: 'b1' });
    expect(screen.getByDisplayValue('Quarterly service')).toBeInTheDocument();
    expect(screen.getByLabelText('Line 1: name')).toHaveValue('Filter Change');
    expect(screen.getByDisplayValue('Thank you, as always.')).toBeInTheDocument();
  });
});

describe('the invoices list', () => {
  const LIST = {
    items: [],
    page: 1,
    pageSize: 25,
    total: 0,
    totalPages: 1,
    overview: { pastDue: { count: 0, amountCents: 0 }, notYetDue: { count: 0, amountCents: 0 }, draft: { count: 0, amountCents: 0 } },
    issued: { last30: { count: 0, amountCents: 0 }, previous30: { count: 0, amountCents: 0 } },
    filterCounts: { all: 0, past_due: 0, not_yet_due: 0, awaiting_payment: 0, draft: 0, paid: 0, bad_debt: 0, voided: 0 },
    syncedAt: null,
    jobberRead: { problem: null, checkedAt: null, firstReadDone: true },
  } satisfies InvoiceList;

  it('offers a new invoice and a batch to whoever makes invoices, once the console owns invoicing', () => {
    batches.useUninvoicedVisits.mockReturnValue(ready({ items: [], truncated: false }));
    hooks.useInvoices.mockReturnValue(ready({ ...LIST, writesEnabled: true }));
    const { unmount } = render(<InvoicesPage />);
    expect(screen.getByRole('link', { name: 'New invoice' })).toHaveAttribute('href', '/invoices/new');
    expect(screen.getByRole('link', { name: 'Batch create' })).toHaveAttribute('href', '/invoices/batch');
    // Jobber's reports, and its date filter on the list (2026-11-09).
    expect(screen.getByRole('link', { name: 'Reports' })).toHaveAttribute('href', '/invoices/reports');
    expect(screen.getByRole('group', { name: 'Issued' })).toBeInTheDocument();
    expect(hooks.useInvoices).toHaveBeenLastCalledWith(expect.objectContaining({ issuedFrom: undefined, issuedTo: undefined }));
    expect(screen.getByRole('link', { name: 'Batch deliver' })).toHaveAttribute('href', '/invoices/deliver');
    // With none yet (2026-11-13): made from finished visits, with no word of Jobber's connection.
    expect(screen.getByText('No invoices yet. Make them from the finished visits with Batch create.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Jobber connection' })).not.toBeInTheDocument();
    unmount();

    hooks.useInvoices.mockReturnValue(ready({ ...LIST, writesEnabled: false }));
    render(<InvoicesPage />);
    expect(screen.queryByRole('link', { name: 'New invoice' })).not.toBeInTheDocument();
    // Printing many at once needs no Take over.
    expect(screen.getByRole('link', { name: 'Batch deliver' })).toBeInTheDocument();
  });

  it("says how many finished visits have no invoice, as Jobber's \"requires invoicing\"", () => {
    hooks.useInvoices.mockReturnValue(ready({ ...LIST, writesEnabled: true }));
    batches.useUninvoicedVisits.mockReturnValue(ready({ items: [{ inspectionId: 'v1' }, { inspectionId: 'v2' }], truncated: false }));
    const { unmount } = render(<InvoicesPage />);
    const nudge = screen.getByRole('status');
    expect(nudge).toHaveTextContent('2 finished visits have no invoice yet, in the last 30 days.');
    expect(within(nudge).getByRole('link', { name: 'Invoice them' })).toHaveAttribute('href', '/invoices/batch');
    // The last month, ending today.
    expect(batches.useUninvoicedVisits).toHaveBeenLastCalledWith({ from: shiftDay(businessToday(), -30), to: businessToday() });
    unmount();

    batches.useUninvoicedVisits.mockReturnValue(ready({ items: [], truncated: false }));
    render(<InvoicesPage />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('a batch', () => {
  const VISITS: UninvoicedVisitList = {
    items: [
      {
        inspectionId: 'v1',
        inspectionType: 'OCCUPIED',
        scheduledOn: '2026-11-02',
        status: 'COMPLETED',
        property: { id: 'b1', address: '100 Example Way', city: 'Sampletown' },
        clientName: '100 Example Way',
        lineItems: [{ name: 'Filter Change', quantity: 1, unitPriceCents: 3999 }],
        totalCents: 3999,
        problem: null,
        invoices: [{ xeroTenantId: null, company: null, lineItems: [{ name: 'Filter Change', quantity: 1, unitPriceCents: 3999 }], totalCents: 3999 }],
      },
      {
        inspectionId: 'v2',
        inspectionType: 'OCCUPIED',
        scheduledOn: '2026-11-03',
        status: 'COMPLETED',
        property: { id: 'b2', address: '200 Example Way', city: 'Sampletown' },
        clientName: '200 Example Way',
        lineItems: [{ name: 'Pest Control', quantity: 1, unitPriceCents: 2500 }],
        totalCents: 2500,
        problem: null,
        invoices: [{ xeroTenantId: null, company: null, lineItems: [{ name: 'Pest Control', quantity: 1, unitPriceCents: 2500 }], totalCents: 2500 }],
      },
      {
        inspectionId: 'v3',
        inspectionType: 'OCCUPIED',
        scheduledOn: '2026-11-04',
        status: 'COMPLETED',
        property: { id: 'b3', address: '300 Example Way', city: 'Sampletown' },
        clientName: '300 Example Way',
        lineItems: [],
        totalCents: 0,
        problem: 'No rule says what this visit bills (Roof inspection). Add one under Invoices → Settings.',
        invoices: [],
      },
    ],
    truncated: false,
  };

  it('asks no terms and offers no drafts once the console makes the invoices (2026-11-13): each is a draft in Xero, dated by Xero', () => {
    batches.useUninvoicedVisits.mockReturnValue(ready({ ...VISITS, startsOn: '2026-11-01' }));
    render(<BatchInvoicesPage />);
    expect(screen.queryByLabelText('Payment terms')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Make them drafts, to look over first' })).not.toBeInTheDocument();
    expect(screen.getByText(/Xero dates it on its visit's day and makes it due on the last day of that month/)).toBeInTheDocument();
  });

  it('reads the past week to start with, and ticks every visit that can be billed', () => {
    batches.useUninvoicedVisits.mockReturnValue(ready(VISITS));
    render(<BatchInvoicesPage />);
    expect(batches.useUninvoicedVisits).toHaveBeenLastCalledWith({ from: '2026-10-30', to: TODAY });
    expect(screen.getByText('2 of 2 chosen')).toBeInTheDocument();
    expect(screen.getByText('No rule says what this visit bills (Roof inspection). Add one under Invoices → Settings.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /300 Example Way/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create 2 invoices · $64.99' })).toBeEnabled();
  });

  it('makes only the ones chosen, once asked, and lists what was made and skipped', async () => {
    batches.useUninvoicedVisits.mockReturnValue(ready(VISITS));
    batch.mutate.mockImplementation((_input, { onSuccess }) =>
      onSuccess({ created: [{ inspectionId: 'v1', invoiceId: 'inv-9', number: '8440', totalCents: 3999 }], skipped: [] }),
    );
    render(<BatchInvoicesPage />);
    fireEvent.click(screen.getByRole('checkbox', { name: /200 Example Way/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create 1 invoice · $39.99' }));

    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('$39.99 in all');
    expect(batch.mutate).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Create them' }));
    });

    expect(batch.mutate).toHaveBeenCalledWith(
      { inspectionIds: ['v1'], issuedOn: TODAY, paymentTermsDays: 30, clientRequestId: expect.stringMatching(/^web-/) },
      expect.anything(),
    );
    // Announced as it appears.
    const made = screen.getByRole('status', { name: 'What was made' });
    expect(within(made).getByRole('link', { name: '#8440' })).toHaveAttribute('href', '/invoices/inv-9');
  });

  it('makes a visit whose services go to two companies’ books one invoice for each (2026-11-10)', async () => {
    const filter = { name: 'Filter Change', quantity: 1, unitPriceCents: 3999 };
    const pest = { name: 'Pest Control', quantity: 1, unitPriceCents: 2500 };
    const split = {
      ...VISITS.items[0]!,
      lineItems: [filter, pest],
      totalCents: 6499,
      invoices: [
        { xeroTenantId: 'a1000000-0000-4000-8000-000000000001', company: 'Example Home Services', lineItems: [filter], totalCents: 3999 },
        { xeroTenantId: 'a2000000-0000-4000-8000-000000000002', company: 'Example Pest Co', lineItems: [pest], totalCents: 2500 },
      ],
    };
    batches.useUninvoicedVisits.mockReturnValue(ready({ items: [split], truncated: false }));
    batch.mutate.mockImplementation((_input, { onSuccess }) =>
      onSuccess({
        created: [
          { inspectionId: 'v1', invoiceId: 'inv-9', number: '8440', totalCents: 3999, company: 'Example Home Services' },
          { inspectionId: 'v1', invoiceId: 'inv-10', number: '8441', totalCents: 2500, company: 'Example Pest Co' },
        ],
        skipped: [],
      }),
    );
    render(<BatchInvoicesPage />);

    const invoices = screen.getByRole('list', { name: 'Invoices for 100 Example Way' });
    expect(within(invoices).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Example Home Services: Filter Change · $39.99',
      'Example Pest Co: Pest Control · $25.00',
    ]);
    expect(screen.getByText('1 of 1 chosen')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create 2 invoices · $64.99' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent('for 1 visit: one for each company’s books');
    await act(async () => {
      fireEvent.click(within(confirm).getByRole('button', { name: 'Create them' }));
    });
    const made = screen.getByRole('status', { name: 'What was made' });
    expect(made).toHaveTextContent('Example Pest Co · $25.00');
  });

  it('says plainly when there is nothing to invoice', () => {
    batches.useUninvoicedVisits.mockReturnValue(ready({ items: [], truncated: false }));
    render(<BatchInvoicesPage />);
    expect(screen.getByText('Nothing to invoice')).toBeInTheDocument();
  });

  it('is for whoever makes invoices', () => {
    permissions.granted = new Set(['invoices:read']);
    batches.useUninvoicedVisits.mockReturnValue(ready(VISITS));
    render(<BatchInvoicesPage />);
    expect(screen.getByText('You may not create invoices')).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EMPTY_INVOICE_SETTINGS, type InvoiceDetail, type InvoiceExtraDetails, type InvoiceSettingsView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import InvoicePage from './[invoiceId]/page';
import InvoiceSettingsPage from './settings/page';

/**
 * The files on Jobber's invoices (2026-11-06, phase 7): each opened through a
 * short-lived link, saying whether the console keeps its own copy; and the
 * settings page counting the copies before the cutover, with the failed ones
 * tried again only when asked. Everything invented.
 */

const files = vi.hoisted(() => ({
  openInvoiceFile: vi.fn().mockResolvedValue('opened'),
  retry: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/invoice-files', () => ({ openInvoiceFile: files.openInvoiceFile, useRetryFileCopies: () => files.retry }));
const hooks = vi.hoisted(() => ({
  useInvoice: vi.fn(),
  useInvoiceActions: vi.fn(() => ({ recordPayment: { mutate: vi.fn(), isPending: false } })),
}));
vi.mock('@/lib/invoice-queries', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), ...hooks }));
vi.mock('@/lib/invoice-edit-queries', () => ({
  useInvoiceEdits: () => ({ edit: {}, changeStatus: {}, remove: {} }),
  useInvoiceHistory: () => ({ isLoading: false, isError: false, data: { items: [], truncated: false } }),
}));
vi.mock('@/lib/invoice-delivery-queries', () => ({ useSendInvoice: () => ({ mutate: vi.fn(), isPending: false }) }));
const settings = vi.hoisted(() => ({ view: null as unknown }));
vi.mock('@/lib/invoice-settings-queries', () => ({
  useInvoiceSettings: () => ({ isLoading: false, isError: false, data: settings.view, refetch: vi.fn() }),
  useInvoiceSettingsEdits: () => ({ save: {}, addProducts: {}, changeProduct: {}, addBillingRules: {}, removeBillingRule: {} }),
}));
const permissions = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@/lib/auth', () => ({ usePermissions: () => ({ has: (key: string) => permissions.granted.has(key) }) }));
vi.mock('next/navigation', () => ({ useParams: () => ({ invoiceId: 'inv-1' }), useRouter: () => ({ push: vi.fn() }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
// The cutover is tested in invoice-takeover.test.tsx.
vi.mock('@/components/invoices/invoice-takeover-section', () => ({ InvoiceTakeoverSection: () => null }));
vi.mock('@/components/invoices/invoice-emails-section', () => ({ InvoiceEmailsSection: () => null }));
vi.mock('@/components/invoices/statement-settings-section', () => ({ StatementSettingsSection: () => null }));
vi.mock('@/components/invoices/email-templates-section', () => ({ EmailTemplatesSection: () => null }));
vi.mock('sonner', () => ({ toast }));
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

const file = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  fileName: `${id}.jpg`,
  contentType: 'image/jpeg',
  sizeBytes: 2048,
  url: `https://files.example.com/${id}`,
  uploadedAt: '2026-10-01T15:00:00.000Z',
  kept: false,
  copyProblem: null,
  ...over,
});

const DETAIL = {
  id: 'inv-1',
  number: '8439',
  subject: 'For Services Rendered',
  status: 'AWAITING_PAYMENT',
  clientName: '100 Example Way',
  property: null,
  inspectionId: null,
  jobNumber: null,
  issuedOn: '2026-11-01',
  dueOn: '2026-12-01',
  totalCents: 6499,
  balanceCents: 6499,
  jobberUrl: null,
  paymentTerms: 'Net 30',
  billingAddress: null,
  lineItems: [],
  subtotalCents: 6499,
  taxCents: 0,
  payments: [],
  clientMessage: null,
  accountBalanceCents: null,
  createdAt: '2026-11-01T14:00:00.000Z',
  writesEnabled: false,
  details: {
    clientEmails: [],
    clientPhones: [],
    notes: [],
    customFields: [],
    files: [file('kept', { kept: true }), file('waiting'), file('gone', { copyProblem: 'Jobber no longer has this file.' })],
  } as unknown as InvoiceExtraDetails,
} as unknown as InvoiceDetail;

beforeEach(() => {
  vi.clearAllMocks();
  permissions.granted = new Set(['invoices:read', 'invoices:manage']);
  hooks.useInvoice.mockReturnValue({ isLoading: false, isError: false, data: DETAIL, refetch: vi.fn() });
});

describe("an invoice's files", () => {
  it('say whether the console keeps its own copy, and open through a link of their own', async () => {
    render(<InvoicePage />);
    const list = screen.getByRole('list', { name: 'Files' });
    expect(list).toHaveTextContent('Kept in the console');
    expect(list).toHaveTextContent('Not copied from Jobber yet');
    expect(list).toHaveTextContent('Not copied from Jobber: Jobber no longer has this file.');
    // Never Jobber's address straight from the page.
    expect(within(list).queryAllByRole('link')).toHaveLength(0);

    fireEvent.click(within(list).getByRole('button', { name: /kept\.jpg/ }));
    expect(files.openInvoiceFile).toHaveBeenCalledWith('inv-1', 'kept');
  });

  it('says when the browser blocked the tab', async () => {
    files.openInvoiceFile.mockResolvedValueOnce('blocked');
    render(<InvoicePage />);
    fireEvent.click(screen.getByRole('button', { name: /waiting\.jpg/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('The browser blocked the new tab', expect.anything()));
  });
});

describe('the copies before the cutover', () => {
  const view = (status: InvoiceSettingsView['files']): InvoiceSettingsView => ({
    values: EMPTY_INVOICE_SETTINGS,
    fallback: { brand: { name: 'Server Co', addressLine1: null, addressLine2: null, phone: null, email: null }, subject: 'S', termsDays: 30, clientMessage: null, contractDisclaimer: null },
    brand: { name: 'Server Co', addressLine1: null, addressLine2: null, phone: null, email: null },
    defaults: { subject: 'S', termsDays: 30, clientMessage: null, contractDisclaimer: null },
    updatedAt: null,
    products: [],
    billed: [],
    billingRules: [],
    suggestedRules: [],
    organisations: [],
    files: status,
    madeInConsole: false,
  });

  it('are counted on the settings page, with why the failed ones failed, and tried again when asked', () => {
    settings.view = view({ total: 1240, kept: 1200, waiting: 36, failed: 4, problems: [{ problem: "Jobber's storage answered 403.", files: 4 }] });
    render(<InvoiceSettingsPage />);
    const section = screen.getByRole('region', { name: 'Files from Jobber' });
    expect(section).toHaveTextContent('1,200 of 1,240 kept');
    expect(section).toHaveTextContent('36 still to copy');
    expect(section).toHaveTextContent('4 could not be copied');
    expect(section).toHaveTextContent("Jobber's storage answered 403. (4)");
    fireEvent.click(within(section).getByRole('button', { name: 'Try the 4 again' }));
    expect(files.retry.mutate).toHaveBeenCalled();
  });

  it('offer no retry to anybody who does not make invoices, nor when nothing failed', () => {
    permissions.granted = new Set(['invoices:read']);
    settings.view = view({ total: 10, kept: 6, waiting: 0, failed: 4, problems: [] });
    const { unmount } = render(<InvoiceSettingsPage />);
    expect(screen.queryByRole('button', { name: /Try the/ })).not.toBeInTheDocument();
    unmount();

    permissions.granted = new Set(['invoices:read', 'invoices:manage']);
    settings.view = view({ total: 10, kept: 10, waiting: 0, failed: 0, problems: [] });
    render(<InvoiceSettingsPage />);
    expect(screen.getByRole('region', { name: 'Files from Jobber' })).toHaveTextContent('10 of 10 kept');
    expect(screen.queryByRole('button', { name: /Try the/ })).not.toBeInTheDocument();
  });
});

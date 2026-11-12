import { fireEvent, render, screen, within } from '@testing-library/react';
import type { InvoiceDraft, XeroInvoiceFormCompany, XeroVisitProjects } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { XeroInvoiceEditor, monthEndOf } from './xero-invoice-editor';

/**
 * The New invoice laid out as Xero's (2026-11-13, PR B): picking an item fills
 * its line from the company's choices, every field stays the office's, and
 * Xero is sent what is shown. Everything invented.
 */

const actions = vi.hoisted(() => ({ create: { mutate: vi.fn(), isPending: false }, createPerCompany: { mutate: vi.fn(), isPending: false } }));
vi.mock('@/lib/invoice-queries', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), useInvoiceActions: () => actions }));
const xero = vi.hoisted(() => ({ useXeroInvoiceForm: vi.fn(), useXeroProjects: vi.fn(), useXeroProjectActions: vi.fn() }));
vi.mock('@/lib/xero-queries', () => xero);
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/clock', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), businessToday: () => '2026-11-13' }));

const HOMES = 'a1000000-0000-4000-8000-000000000001';
const HVAC = 'HVAC Inspection & Filter Change';
const COMPANY: XeroInvoiceFormCompany = {
  tenantId: HOMES,
  name: 'Example Home Services',
  currency: 'USD',
  accounts: [
    { accountId: 'a-400', code: '400', name: 'Sales' },
    { accountId: 'a-4305', code: '4305', name: 'Service: HVAC Inspection & Filter Change' },
    { accountId: 'a-4307', code: '4307', name: 'Service: Filter Change' },
  ],
  taxRates: [
    { taxType: 'NONE', name: 'Tax Exempt', rate: 0 },
    { taxType: 'TAX001', name: 'Tax on Sales', rate: 8.25 },
  ],
  tracking: [{ trackingCategoryId: 'cat-1', name: 'Income by Employee', options: ['HVAC Inspection Income: Moses', 'Air Filter Income: Moses'] }],
  items: [
    { code: 'HVAC', name: 'HVAC' },
    { code: 'Filter Change', name: 'Filter Change' },
  ],
  salesAccountId: 'a-400',
  salesTaxType: 'NONE',
  taxMode: 'EXCLUSIVE',
  trackingCategoryId: 'cat-1',
  products: {
    'hvac inspection & filter change': { accountId: 'a-4305', itemCode: 'HVAC', trackingGroup: 'HVAC Inspection Income' },
    'filter change': { accountId: 'a-4307', itemCode: 'Filter Change', trackingGroup: 'Air Filter Income' },
  },
};
const VISIT_PROJECT = { xeroProjectId: 'b1000000-0000-4000-8000-000000000001', name: 'Moses: HVAC Inspection - 4th Qtr - 2026 - 11.10.2026', deadlineOn: '2026-11-10', status: 'INPROGRESS' as const, madeHere: true };
const PROJECTS: XeroVisitProjects = {
  inspectionId: 'insp-1',
  propertyId: 'b1',
  contactName: '6510 Example Brk',
  suggestedName: VISIT_PROJECT.name,
  deadlineOn: '2026-11-10',
  companies: [{ tenantId: HOMES, name: 'Example Home Services', chosen: VISIT_PROJECT, projects: [VISIT_PROJECT], problem: null, readAt: null }],
};
const DRAFT: InvoiceDraft = {
  inspection: { id: 'insp-1', inspectionType: 'HVAC', scheduledOn: '2026-11-10', status: 'COMPLETED', technicianName: 'Moses Example' },
  property: { id: 'b1', address: '6510 Example Brk', city: 'Sampletown' },
  clientName: '6510 Example Brk',
  subject: 'For Services Rendered',
  issuedOn: '2026-11-13',
  paymentTermsDays: 30,
  invoices: [{ xeroTenantId: HOMES, lineItems: [{ name: HVAC, quantity: 1, unitPriceCents: 6450 }] }],
  clientMessage: '',
  existing: [],
  alreadyInvoiced: false,
  products: [
    { name: HVAC, unitPriceCents: 6450, xeroTenantId: HOMES },
    { name: 'Filter Change', unitPriceCents: 3999, xeroTenantId: HOMES },
  ],
  organisations: [{ tenantId: HOMES, name: 'Example Home Services', connected: true }],
  madeInConsole: true,
};
const ready = (data: unknown) => ({ isLoading: false, isError: false, data, refetch: vi.fn() });
const make = { mutate: vi.fn(), isPending: false };

// The search lists (cmdk) measure and scroll themselves: jsdom has neither.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as never;
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const combobox = (name: string) => screen.getByRole('combobox', { name });
/** A list opened and an option picked: the tax select opens on a press, the search lists on a click. */
const pick = (name: string, option: string) => {
  const trigger = combobox(name);
  if (trigger.dataset.slot === 'select-trigger') fireEvent.pointerDown(trigger, { button: 0, pointerId: 1, pointerType: 'mouse' });
  else fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('option', { name: option }));
};

beforeEach(() => {
  vi.clearAllMocks();
  xero.useXeroInvoiceForm.mockReturnValue(ready([COMPANY]));
  xero.useXeroProjects.mockReturnValue(ready(PROJECTS));
  xero.useXeroProjectActions.mockReturnValue({ make, choose: { mutate: vi.fn(), isPending: false } });
});

describe('the New invoice, laid out as Xero’s', () => {
  it('has Xero’s fields: the property as contact, dated on the visit’s day and due at its month’s end, numbered by Xero, the property as reference', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    expect(screen.getByLabelText('Contact')).toHaveValue('6510 Example Brk');
    expect(screen.getByText('6EB')).toBeInTheDocument();
    expect(screen.getByLabelText('Issue date')).toHaveValue('2026-11-10');
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-11-30');
    expect(screen.getByLabelText('Invoice number')).toHaveValue('Given by Xero');
    expect(screen.getByLabelText('Reference')).toHaveValue('6510 Example Brk');
    expect(screen.getByLabelText('Online payments')).toHaveValue('As set in Xero');
    expect(screen.getByLabelText('Currency')).toHaveValue('USD');
    expect(combobox('Tax on the invoice for Example Home Services')).toHaveTextContent('Tax exclusive');
    const headers = within(screen.getByRole('region', { name: 'Invoice for Example Home Services' }))
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers).toEqual(['Item', 'Description', 'Qty.', 'Price', 'Disc.', 'Account', 'Tax rate', 'Tax amount', 'Income by Employee', 'Project', 'Amount USD', 'Remove']);
  });

  it('fills each line from its item, as Xero does: the product’s account and Xero item, the company’s rate, the technician’s option, the visit’s project', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    expect(combobox('Line 1: item')).toHaveTextContent(HVAC);
    expect(combobox('Line 1: account')).toHaveTextContent('4305 · Service: HVAC Inspection & Filter Change');
    expect(combobox('Line 1: tax rate')).toHaveTextContent('Tax Exempt (0%)');
    expect(combobox('Line 1: Income by Employee')).toHaveTextContent('HVAC Inspection Income: Moses');
    expect(combobox('Line 1: project')).toHaveTextContent(VISIT_PROJECT.name);
  });

  it('sends Xero what it shows: the days, reference and tax, and each line’s account, item, rate, tracking and project', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft in Xero · $64.50' }));
    expect(actions.create.mutate).toHaveBeenCalledWith(
      {
        inspectionId: 'insp-1',
        subject: 'For Services Rendered',
        issuedOn: '2026-11-10',
        paymentTermsDays: 20,
        dueOn: '2026-11-30',
        reference: '6510 Example Brk',
        clientRequestId: expect.stringMatching(/^web-/),
        xeroTenantId: HOMES,
        taxMode: 'EXCLUSIVE',
        lineItems: [
          {
            name: HVAC,
            description: null,
            quantity: 1,
            unitPriceCents: 6450,
            xeroAccountId: 'a-4305',
            xeroItemCode: 'HVAC',
            xeroTaxType: 'NONE',
            xeroTracking: [{ trackingCategoryId: 'cat-1', option: 'HVAC Inspection Income: Moses' }],
            xeroProjectId: VISIT_PROJECT.xeroProjectId,
          },
        ],
      },
      expect.anything(),
    );
  });

  it('fills a line again from a new item, and keeps what the office changed by hand otherwise', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    pick('Line 1: account', '400 · Sales');
    expect(combobox('Line 1: account')).toHaveTextContent('400 · Sales');
    pick('Line 1: item', 'Filter Change');
    expect(screen.getByLabelText('Line 1: price')).toHaveValue('39.99');
    expect(combobox('Line 1: account')).toHaveTextContent('4307 · Service: Filter Change');
    expect(combobox('Line 1: Income by Employee')).toHaveTextContent('Air Filter Income: Moses');
  });

  it('takes a discount off the line, as Xero does, and says what it comes to', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    fireEvent.change(screen.getByLabelText('Line 1: discount'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft in Xero · $58.05' }));
    expect(actions.create.mutate.mock.calls[0]![0].lineItems[0]).toMatchObject({ discountRate: 10, unitPriceCents: 6450 });
  });

  it('moves the due day with the issue day until the office sets it, and refuses one before it', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    fireEvent.change(screen.getByLabelText('Issue date'), { target: { value: '2026-10-28' } });
    expect(screen.getByLabelText('Due date')).toHaveValue('2026-10-31');
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-10-01' } });
    expect(screen.getByText('Make it due on or after the day it is issued.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Save draft in Xero/ })).toBeDisabled();
  });

  it('refuses a rate that puts tax on top of prices that leave it out, and takes it inside them', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    pick('Line 1: tax rate', 'Tax on Sales (8.25%)');
    expect(screen.getByText(/8\.25% would go on top of the price/)).toBeInTheDocument();
    pick('Tax on the invoice for Example Home Services', 'Tax inclusive');
    // $64.50 with 8.25% inside it: $4.92 of it is tax.
    expect(within(screen.getByRole('region', { name: 'Invoice for Example Home Services' })).getAllByText('$4.92')).not.toHaveLength(0);
    expect(screen.getByText('Includes sales tax')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft in Xero · $64.50' })).toBeEnabled();
  });

  it('makes a new project from a line, as Xero’s dialog does, and puts the line on it', () => {
    const made = { ...VISIT_PROJECT, xeroProjectId: 'b1000000-0000-4000-8000-000000000002', name: 'Moses: made just now' };
    make.mutate.mockImplementation((_input, options: { onSuccess: (answer: unknown) => void }) => options.onSuccess({ project: made, found: false }));
    render(<XeroInvoiceEditor draft={DRAFT} />);
    pick('Line 1: project', '+ New project…');
    const dialog = screen.getByRole('dialog', { name: 'New in progress project' });
    expect(within(dialog).getByLabelText('Project name')).toHaveValue(VISIT_PROJECT.name);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(make.mutate).toHaveBeenCalledWith(expect.objectContaining({ tenantId: HOMES, input: expect.objectContaining({ inspectionId: 'insp-1' }) }), expect.anything());
    fireEvent.click(screen.getByRole('button', { name: /^Save draft in Xero/ }));
    expect(actions.create.mutate.mock.calls[0]![0].lineItems[0]).toMatchObject({ xeroProjectId: made.xeroProjectId });
  });

  it('finds an option by typing, not by scrolling: a technician among a category’s many', () => {
    render(<XeroInvoiceEditor draft={DRAFT} />);
    fireEvent.click(combobox('Line 1: Income by Employee'));
    // Every word typed, in any order: the technician and the kind of work.
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'moses air' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['Air Filter Income: Moses']);
    fireEvent.click(screen.getByRole('option', { name: 'Air Filter Income: Moses' }));
    expect(combobox('Line 1: Income by Employee')).toHaveTextContent('Air Filter Income: Moses');
    // An account by its code.
    fireEvent.click(combobox('Line 1: account'));
    fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: '4307' } });
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['4307 · Service: Filter Change']);
  });

  it('puts the company’s own tracking category first, as Xero does, and lets a line be tracked in none', () => {
    const expenses = { trackingCategoryId: 'cat-0', name: 'Expenses', options: ['Truck'] };
    xero.useXeroInvoiceForm.mockReturnValue(ready([{ ...COMPANY, tracking: [expenses, ...COMPANY.tracking] }]));
    render(<XeroInvoiceEditor draft={DRAFT} />);
    const headers = within(screen.getByRole('region', { name: 'Invoice for Example Home Services' }))
      .getAllByRole('columnheader')
      .map((header) => header.textContent);
    expect(headers.slice(8, 10)).toEqual(['Income by Employee', 'Expenses']);
    expect(combobox('Line 1: Expenses')).toHaveTextContent('No tracking');
    pick('Line 1: Income by Employee', 'No tracking');
    fireEvent.click(screen.getByRole('button', { name: /^Save draft in Xero/ }));
    expect(actions.create.mutate.mock.calls[0]![0].lineItems[0]).toMatchObject({ xeroTracking: [] });
  });

  it('asks for a property’s projects for an invoice no visit covers', () => {
    render(<XeroInvoiceEditor draft={{ ...DRAFT, inspection: null, invoices: [{ xeroTenantId: HOMES, lineItems: [] }] }} />);
    expect(xero.useXeroProjects).toHaveBeenCalledWith({ propertyId: 'b1' });
    expect(screen.getByLabelText('Issue date')).toHaveValue('2026-11-13');
  });

  it('works out the end of a month', () => {
    expect(monthEndOf('2026-02-10')).toBe('2026-02-28');
    expect(monthEndOf('2028-02-10')).toBe('2028-02-29');
    expect(monthEndOf('2026-12-31')).toBe('2026-12-31');
  });
});

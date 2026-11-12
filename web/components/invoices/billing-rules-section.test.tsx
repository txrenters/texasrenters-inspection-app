import { fireEvent, render, screen, within } from '@testing-library/react';
import { EMPTY_INVOICE_SETTINGS, type InvoiceSettingsView } from '@texasrenters/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingRulesSection } from './billing-rules-section';

/**
 * What a finished visit bills (2026-11-12): the rules the office's past
 * invoices suggest, confirmed at once; the rules kept, each with its product's
 * price and company; and one added or removed. Everything invented.
 */

const hooks = vi.hoisted(() => ({
  addBillingRules: { mutate: vi.fn(), isPending: false },
  removeBillingRule: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/invoice-settings-queries', () => ({ useInvoiceSettingsEdits: () => hooks }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const SAVED_AT = '2026-11-12T15:00:00.000Z';
const HOMES = 'a1000000-0000-4000-8000-000000000001';
const PEST = 'a2000000-0000-4000-8000-000000000002';
const product = (id: string, name: string, unitPriceCents: number, xeroTenantId: string | null, active = true) => ({
  id,
  name,
  description: null,
  unitPriceCents,
  active,
  xeroTenantId,
  updatedAt: SAVED_AT,
});

const VIEW: InvoiceSettingsView = {
  values: EMPTY_INVOICE_SETTINGS,
  fallback: { brand: { name: 'Example Co', addressLine1: null, addressLine2: null, phone: null, email: null }, subject: 'For Services Rendered', termsDays: 30, clientMessage: null, contractDisclaimer: null },
  brand: { name: 'Example Co', addressLine1: null, addressLine2: null, phone: null, email: null },
  defaults: { subject: 'For Services Rendered', termsDays: 30, clientMessage: null, contractDisclaimer: null },
  updatedAt: SAVED_AT,
  products: [
    product('p1', 'Filter Change', 3999, HOMES),
    product('p2', 'HVAC Inspection & Filter Change', 6450, HOMES),
    product('p3', 'Pest Control', 3900, PEST),
    product('p4', 'Occupied Inspection', 2500, HOMES, false),
  ],
  billed: [],
  billingRules: [
    { id: 'rule-1', inspectionType: null, service: 'pestControl', productId: 'p3' },
    { id: 'rule-2', inspectionType: 'ROOF', service: null, productId: 'p4' },
  ],
  suggestedRules: [
    { inspectionType: 'OCCUPIED', productId: 'p1', seen: 468, of: 470 },
    { inspectionType: 'HVAC', productId: 'p2', seen: 173, of: 179 },
  ],
  organisations: [
    { tenantId: HOMES, name: 'Example Home Services', connected: true },
    { tenantId: PEST, name: 'Example Pest Co', connected: true },
  ],
  madeInConsole: false,
};

const mount = (view: InvoiceSettingsView = VIEW, mayChange = true) => render(<BillingRulesSection mayChange={mayChange} view={view} />);
const pick = (combobox: string, option: string) => {
  // Radix opens a select on pointer-down, as it does a menu.
  fireEvent.pointerDown(screen.getByRole('combobox', { name: combobox }), { button: 0, pointerId: 1, pointerType: 'mouse' });
  fireEvent.click(screen.getByRole('option', { name: option }));
};

beforeEach(() => vi.clearAllMocks());

describe('what a visit bills', () => {
  it('shows the rules the past invoices suggest, with how often each was billed, and confirms them all at once', () => {
    mount();
    const suggested = screen.getByRole('group', { name: 'Suggested rules' });
    const occupied = within(suggested).getByText(/^Occupied inspection visits/).closest('li')!;
    expect(occupied).toHaveTextContent('Occupied inspection visits → Filter Change $39.99');
    expect(occupied).toHaveTextContent('Billed on 468 of 470 visits');
    fireEvent.click(within(suggested).getByRole('button', { name: 'Confirm 2 rules' }));
    expect(hooks.addBillingRules.mutate).toHaveBeenCalledWith(
      {
        rules: [
          { inspectionType: 'OCCUPIED', service: null, productId: 'p1' },
          { inspectionType: 'HVAC', service: null, productId: 'p2' },
        ],
      },
      expect.anything(),
    );
  });

  it('lists each rule with what it bills, at what price, to which company, and removes one', () => {
    mount();
    const rules = screen.getByRole('table', { name: 'Rules' });
    const pest = within(rules).getByRole('row', { name: /Visits with pest control done/ });
    expect(pest).toHaveTextContent('Pest Control');
    expect(pest).toHaveTextContent('$39.00');
    expect(pest).toHaveTextContent('Example Pest Co');
    // One whose product was set aside bills nothing, and says so.
    expect(within(rules).getByRole('row', { name: /Roof inspection visits/ })).toHaveTextContent('Set aside: it bills nothing until offered again.');
    fireEvent.click(screen.getByRole('button', { name: 'Remove the rule: Visits with pest control done bill Pest Control' }));
    expect(hooks.removeBillingRule.mutate).toHaveBeenCalledWith('rule-1', expect.anything());
  });

  it('adds a rule for a type, a service done, or both, billing a product on offer', () => {
    mount();
    pick('Visit type', 'HVAC inspection');
    pick('Service done', 'AC filter change');
    fireEvent.pointerDown(screen.getByRole('combobox', { name: 'Bills' }), { button: 0, pointerId: 1, pointerType: 'mouse' });
    // A product set aside is not offered.
    expect(screen.queryByRole('option', { name: /Occupied Inspection/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Filter Change · $39.99' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    expect(hooks.addBillingRules.mutate).toHaveBeenCalledWith({ rules: [{ inspectionType: 'HVAC', service: 'filterChange', productId: 'p1' }] }, expect.anything());
  });

  it('will not add a rule for every visit at once', () => {
    mount();
    pick('Bills', 'Pest Control · $39.00');
    expect(screen.getByText('Say which visits it is for: their type, a service done, or both.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add rule' })).toBeDisabled();
  });

  it('says a visit bills nothing until a rule covers it, when there are none', () => {
    mount({ ...VIEW, billingRules: [], suggestedRules: [] });
    expect(screen.getByText('No rules yet: a finished visit bills nothing until one covers it.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Suggested rules' })).not.toBeInTheDocument();
  });

  it('is read, not changed, by whoever does not make invoices', () => {
    mount(VIEW, false);
    expect(screen.getByRole('table', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Confirm/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument();
  });
});

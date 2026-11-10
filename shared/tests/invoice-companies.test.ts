import { describe, expect, it } from 'vitest';

import { invoiceCompany, lineCompany, splitByCompany } from '../src/contracts/invoice-companies';

const HOMES = 'a1000000-0000-4000-8000-000000000001';
const PEST = 'a2000000-0000-4000-8000-000000000002';
const NAMES: Record<string, string> = { [HOMES]: 'Example Home Services', [PEST]: 'Example Pest Co' };
const nameOf = (tenantId: string) => NAMES[tenantId] ?? tenantId;

/** The office's list: each product the company the office chose for it, or none yet. */
const PRODUCTS = [
  { name: 'Filter Change', xeroTenantId: HOMES },
  { name: 'Occupied Inspection', xeroTenantId: HOMES },
  { name: 'Pest Control', xeroTenantId: PEST },
  { name: 'Flea Treatment', xeroTenantId: PEST },
  { name: 'Lockbox Install', xeroTenantId: null },
];

const line = (name: string) => ({ name, quantity: 1, unitPriceCents: 1000 });

describe('the company a line goes to', () => {
  it('is its product’s, however the name is typed', () => {
    expect(lineCompany('Filter Change', PRODUCTS)).toBe(HOMES);
    expect(lineCompany('  pest control ', PRODUCTS)).toBe(PEST);
  });

  it('is none for a product that goes to none yet, or a line typed by hand', () => {
    expect(lineCompany('Lockbox Install', PRODUCTS)).toBeNull();
    expect(lineCompany('Trip charge', PRODUCTS)).toBeNull();
  });
});

describe('an invoice’s company', () => {
  it('is the one company its lines go to; the lines that say nothing follow it', () => {
    expect(invoiceCompany([line('Filter Change'), line('Trip charge')], PRODUCTS, undefined, nameOf)).toEqual({ xeroTenantId: HOMES, problem: null });
  });

  it('is the one chosen when no line says, else none', () => {
    expect(invoiceCompany([line('Trip charge')], PRODUCTS, PEST, nameOf)).toEqual({ xeroTenantId: PEST, problem: null });
    expect(invoiceCompany([line('Trip charge')], PRODUCTS, undefined, nameOf)).toEqual({ xeroTenantId: null, problem: null });
    expect(invoiceCompany([line('Trip charge')], PRODUCTS, null, nameOf)).toEqual({ xeroTenantId: null, problem: null });
  });

  it('agrees with the one chosen', () => {
    expect(invoiceCompany([line('Pest Control')], PRODUCTS, PEST, nameOf).problem).toBeNull();
  });

  it('never holds two companies’ lines', () => {
    expect(invoiceCompany([line('Filter Change'), line('Pest Control')], PRODUCTS, undefined, nameOf)).toEqual({
      xeroTenantId: null,
      problem: 'Filter Change goes to Example Home Services and Pest Control to Example Pest Co: make one invoice for each company.',
    });
  });

  it('refuses a line of another company than the one chosen, or of a company when none was', () => {
    expect(invoiceCompany([line('Pest Control')], PRODUCTS, HOMES, nameOf).problem).toBe(
      'Pest Control goes to Example Pest Co, not to Example Home Services: it belongs on the invoice for Example Pest Co.',
    );
    expect(invoiceCompany([line('Pest Control')], PRODUCTS, null, nameOf).problem).toBe(
      'Pest Control goes to Example Pest Co, not to no company: it belongs on the invoice for Example Pest Co.',
    );
  });
});

describe('a visit’s lines, one invoice per company', () => {
  it('puts each company’s lines on its own invoice, in the order they come', () => {
    const lines = [line('Pest Control'), line('Filter Change'), line('Flea Treatment')];
    expect(splitByCompany(lines, PRODUCTS)).toEqual([
      { xeroTenantId: PEST, lineItems: [lines[0], lines[2]] },
      { xeroTenantId: HOMES, lineItems: [lines[1]] },
    ]);
  });

  it('keeps the lines that go to no company on one of their own', () => {
    const lines = [line('Filter Change'), line('Lockbox Install'), line('Trip charge')];
    expect(splitByCompany(lines, PRODUCTS)).toEqual([
      { xeroTenantId: HOMES, lineItems: [lines[0]] },
      { xeroTenantId: null, lineItems: [lines[1], lines[2]] },
    ]);
  });

  it('is one invoice when nothing goes to a company, and none without lines', () => {
    const lines = [line('Filter Change'), line('Pest Control')];
    expect(splitByCompany(lines, [])).toEqual([{ xeroTenantId: null, lineItems: lines }]);
    expect(splitByCompany([], PRODUCTS)).toEqual([]);
  });
});

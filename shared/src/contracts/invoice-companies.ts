/**
 * Which company's books an invoice goes to (2026-11-10, phase 3 of the
 * multi-company plan): one invoice per company. Each product or service goes
 * to the Xero organisation the office chose for it on its products and
 * services list -- filter change to one company, pest control to another -- and
 * an invoice goes to its lines' one company. One invoice never carries two
 * companies' lines.
 *
 * A line that says nothing -- typed by hand, billed only in Jobber, or a
 * product that goes to no company yet -- follows the invoice: the company its
 * other lines go to, else the one chosen for it, else none. An invoice that
 * belongs to no company is never sent to Xero.
 */
import { productNameKey } from './invoice-settings.js';

/** A product or service and the company it goes to; null or left out for none. */
export interface ProductCompany {
  name: string;
  xeroTenantId?: string | null;
}

/** The company a line's product goes to; null when the line says nothing. */
export function lineCompany(name: string, products: readonly ProductCompany[]): string | null {
  const key = productNameKey(name);
  return products.find((product) => productNameKey(product.name) === key)?.xeroTenantId ?? null;
}

/** The companies the lines go to, each with the names of the lines that say so, in the order they come. */
function companiesOf(lines: readonly { name: string }[], products: readonly ProductCompany[]) {
  const companies = new Map<string, string[]>();
  for (const line of lines) {
    const company = lineCompany(line.name, products);
    if (company) companies.set(company, [...(companies.get(company) ?? []), line.name.trim()]);
  }
  return companies;
}

export interface InvoiceCompany {
  /** The organisation it goes to; null for none. */
  xeroTenantId: string | null;
  /** Why these lines cannot be one invoice for that company, in words; null when they can. */
  problem: string | null;
}

/**
 * An invoice's company: the one company its lines go to, else the one chosen
 * for it (`undefined` when nobody chose), else none. Lines that go to two
 * companies, or to another company than the one chosen, cannot be one invoice.
 */
export function invoiceCompany(
  lines: readonly { name: string }[],
  products: readonly ProductCompany[],
  chosen: string | null | undefined,
  nameOf: (tenantId: string) => string,
): InvoiceCompany {
  const companies = [...companiesOf(lines, products)];
  if (companies.length > 1) {
    const [[first, firstLines], [second, secondLines]] = companies as [[string, string[]], [string, string[]]];
    return {
      xeroTenantId: null,
      problem: `${firstLines[0]} goes to ${nameOf(first)} and ${secondLines[0]} to ${nameOf(second)}: make one invoice for each company.`,
    };
  }
  const only = companies[0];
  if (!only) return { xeroTenantId: chosen ?? null, problem: null };
  const [company, names] = only;
  if (chosen !== undefined && chosen !== company)
    return {
      xeroTenantId: company,
      problem: `${names[0]} goes to ${nameOf(company)}, not to ${chosen ? nameOf(chosen) : 'no company'}: it belongs on the invoice for ${nameOf(company)}.`,
    };
  return { xeroTenantId: company, problem: null };
}

/** One company's share of a visit's lines: the invoice it makes. */
export interface CompanyLines<T> {
  /** The organisation; null for the lines that go to no company. */
  xeroTenantId: string | null;
  lineItems: T[];
}

/**
 * A visit's lines split one invoice per company: each company's lines, in the
 * order its first line comes, and the lines that go to no company on one of
 * their own. A single part when nothing goes to a company; none when there are
 * no lines.
 */
export function splitByCompany<T extends { name: string }>(lines: readonly T[], products: readonly ProductCompany[]): CompanyLines<T>[] {
  const parts = new Map<string | null, T[]>();
  for (const line of lines) {
    const company = lineCompany(line.name, products);
    parts.set(company, [...(parts.get(company) ?? []), line]);
  }
  return [...parts].map(([xeroTenantId, lineItems]) => ({ xeroTenantId, lineItems }));
}

/** At most this many invoices from one visit or one form: one per company, and one for none. */
export const MAX_INVOICES_PER_VISIT = 10;

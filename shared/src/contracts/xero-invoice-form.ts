import { productNameKey } from './invoice-settings.js';
import { lineTotalCents, type InvoiceLineInput, type XeroLineTracking, type XeroTaxMode } from './invoices.js';
import { trackingOptionFor } from './xero.js';

/**
 * The New invoice laid out as Xero's (2026-11-13, PR B of the office's ask to
 * make invoices as they do in Xero): the property as the contact, the issue and
 * due days, the reference and how amounts carry tax; and on each line its item,
 * description, quantity, price, discount, account, tax rate and tax, tracking
 * and project. Picking an item fills the rest of the line from the company's
 * choices, as Xero does; every field stays the office's to change, and Xero is
 * sent what the form shows.
 */

/** A company's lists and choices for the form, from the console's last read of its books: no call to Xero. */
export interface XeroInvoiceFormCompany {
  tenantId: string;
  name: string;
  /** "USD". */
  currency: string;
  /** The revenue accounts a sale can be posted to, with their codes. */
  accounts: { accountId: string; code: string; name: string }[];
  /** The tax rates a sale can carry, as a percent. */
  taxRates: { taxType: string; name: string; rate: number }[];
  /** Its active tracking categories, at most two -- THMP's "Income by Employee" -- with their active options. */
  tracking: { trackingCategoryId: string; name: string; options: string[] }[];
  /** The items it sells: what a line's Item names in Xero. */
  items: { code: string; name: string | null }[];
  /** The account a line goes to when its product has none of its own. */
  salesAccountId: string | null;
  /** The tax rate on every line. */
  salesTaxType: string | null;
  /** How its prices carry tax: inclusive once its prices include its sales tax. */
  taxMode: XeroTaxMode;
  /** The category each line is tagged in for the visit's technician; null for none. */
  trackingCategoryId: string | null;
  /** Each product's own choices, by its name key. */
  products: Record<string, { accountId: string | null; itemCode: string | null; trackingGroup: string | null }>;
}

/** The Xero side of a line: what the form fills in when an item is picked. */
export type XeroLineChoices = Required<Pick<InvoiceLineInput, 'xeroAccountId' | 'xeroItemCode' | 'xeroTaxType' | 'xeroTracking'>>;

/**
 * A product's line, filled in as Xero fills one from its item: the product's
 * account, item and tracking -- the technician's option in its group -- or the
 * company's default account, and the company's tax rate. What the console has
 * always sent for that product.
 */
export function xeroLineDefaults(company: XeroInvoiceFormCompany, productName: string, technicianName: string | null): XeroLineChoices {
  const own = company.products[productNameKey(productName)];
  const category = company.tracking.find((each) => each.trackingCategoryId === company.trackingCategoryId);
  const group = own?.trackingGroup ?? null;
  const option =
    category && group && technicianName
      ? trackingOptionFor(
          { trackingCategoryId: category.trackingCategoryId, name: category.name, status: 'ACTIVE', options: category.options.map((name) => ({ optionId: name, name, status: 'ACTIVE' })) },
          group,
          technicianName,
        )
      : null;
  return {
    xeroAccountId: own?.accountId ?? company.salesAccountId,
    xeroItemCode: own?.itemCode ?? null,
    xeroTaxType: company.salesTaxType,
    xeroTracking: category && option ? [{ trackingCategoryId: category.trackingCategoryId, option: option.name }] : [],
  };
}

/** A tax rate's percent, by its type; 0 for one not known. */
export const taxRateOf = (company: Pick<XeroInvoiceFormCompany, 'taxRates'>, taxType: string | null | undefined) =>
  company.taxRates.find((rate) => rate.taxType === taxType)?.rate ?? 0;

/**
 * A line's sales tax, in cents, as Xero works it out: taken out of the line's
 * amount when it includes the tax, put on top when it does not, none with no
 * tax.
 */
export function lineTaxCents(amountCents: number, ratePercent: number, mode: XeroTaxMode): number {
  if (mode === 'NO_TAX' || ratePercent <= 0) return 0;
  return mode === 'INCLUSIVE' ? Math.round((amountCents * ratePercent) / (100 + ratePercent)) : Math.round((amountCents * ratePercent) / 100);
}

/** The invoice's sales tax: what Xero's "Total sales tax" says. */
export const invoiceTaxCents = (company: Pick<XeroInvoiceFormCompany, 'taxRates'>, lines: readonly InvoiceLineInput[], mode: XeroTaxMode) =>
  lines.reduce((sum, line) => sum + lineTaxCents(lineTotalCents(line), taxRateOf(company, line.xeroTaxType), mode), 0);

/**
 * Why a line cannot go to this company's books as it stands, in words, or null
 * when it can: an account, item, tax rate or tracking option Xero does not
 * have; or a tax rate that would put tax on top of prices that leave it out,
 * so Xero's total would be more than the console's.
 */
export function xeroLineProblem(line: InvoiceLineInput, company: XeroInvoiceFormCompany, mode: XeroTaxMode): string | null {
  const name = line.name.trim() || 'A line';
  if (line.xeroAccountId && !company.accounts.some((account) => account.accountId === line.xeroAccountId))
    return `${name}: that account is not one of ${company.name}’s sales accounts in Xero.`;
  if (!line.xeroAccountId && !company.salesAccountId) return `${name}: choose the account it goes to.`;
  if (line.xeroItemCode && !company.items.some((item) => item.code === line.xeroItemCode)) return `${name}: Xero does not sell the item “${line.xeroItemCode}”.`;
  if (line.xeroTaxType && !company.taxRates.some((rate) => rate.taxType === line.xeroTaxType)) return `${name}: that tax rate is not one of ${company.name}’s in Xero.`;
  if (!line.xeroTaxType && !company.salesTaxType) return `${name}: choose its tax rate.`;
  const rate = taxRateOf(company, line.xeroTaxType ?? company.salesTaxType);
  if (mode === 'EXCLUSIVE' && rate > 0)
    return `${name}: ${rate}% would go on top of the price, and the console sends no tax on top. Choose a rate with no tax, or Tax inclusive.`;
  const seen = new Set<string>();
  for (const tracking of line.xeroTracking ?? []) {
    const category = company.tracking.find((each) => each.trackingCategoryId === tracking.trackingCategoryId);
    if (!category) return `${name}: that tracking category is not an active one in Xero.`;
    if (seen.has(category.trackingCategoryId)) return `${name}: one option in ${category.name}, not two.`;
    seen.add(category.trackingCategoryId);
    if (!category.options.includes(tracking.option)) return `${name}: ${category.name} has no option “${tracking.option}”.`;
  }
  return null;
}

/** The first line of these that cannot go to the company's books, in words; null when all can. */
export function xeroLinesProblem(lines: readonly InvoiceLineInput[], company: XeroInvoiceFormCompany, mode: XeroTaxMode): string | null {
  for (const line of lines) {
    const problem = xeroLineProblem(line, company, mode);
    if (problem) return problem;
  }
  return null;
}

/** Tracking that names a category and option, only: blank picks are left out. */
export const trackingPicked = (tracking: readonly XeroLineTracking[] | null | undefined): XeroLineTracking[] =>
  (tracking ?? []).filter((each) => each.trackingCategoryId && each.option.trim()).map((each) => ({ trackingCategoryId: each.trackingCategoryId, option: each.option.trim() }));

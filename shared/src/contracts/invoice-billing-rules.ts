/**
 * What a finished visit bills (2026-11-12, PR 1 of making invoices in the
 * console, with Xero the books). Each rule says that a visit of one type -- or
 * any visit -- on which the technician reported one service done -- or
 * whatever was done -- bills one product: at the product's price, to the
 * company's books the product goes to. A visit bills each product its rules
 * name, once; one that no rule covers is listed with the reason, never billed
 * at $0.
 *
 * Learned from the office's own invoices: for each visit type, the product
 * billed on most of its visits in the past six months is offered, with how
 * often, for the office to confirm. THMP's, read 2026-11-12: an occupied
 * visit billed Filter Change on 468 of 470, an HVAC visit HVAC Inspection &
 * Filter Change on 173 of 179, a move-in and a move-out their inspections, a
 * back-to-market visit BTM Inspection. Pest control was never billed through
 * Jobber -- Crystal Creek Pest's invoices are made in Xero -- so its rule is
 * the office's to add.
 */

import type { InspectionType } from '../enums/index.js';
import { invoiceLinesProblem, type InvoiceLineInput } from './invoices.js';
import { inspectionWords } from './job-summary.js';
import { REPORTABLE_VISIT_SERVICES, VISIT_SERVICE_LABEL, type ReportableVisitService } from './visit-services.js';

/** The most rules one office keeps. */
export const MAX_BILLING_RULES = 100;

/** Who did the work, as a row names them: the technician on the visit, and their pest control license number if known. */
export interface ServiceTechnician {
  name: string;
  pestLicenseNumber: string | null;
}

/** The certified applicator every Crystal Creek Pest invoice names first. */
const CERTIFIED_APPLICATOR = 'Clinton Bass (0557779)';
const FLEX_10 = 'Flex 10 - 10 Insecticide';
const VALLAR_PLUS = 'Valar Plus 25#';
const LICENSED: InvoiceLineInput = {
  name: 'Licensed and regulated by:',
  description: 'Texas Department of Agriculture\nPO Box 12847\nAustin, TX 78711-2847\nPhone: 866-918-4481\nFax: 888-232-2567',
  quantity: 1,
  unitPriceCents: 0,
};
const row = (name: string, xeroItemCode?: string): InvoiceLineInput => ({ name, description: null, quantity: 1, unitPriceCents: 0, ...(xeroItemCode ? { xeroItemCode } : {}) });

/**
 * The rows a pest control or flea treatment line is followed by (2026-11-16),
 * word for word as Crystal Creek Pest's own invoices carry them: the products
 * used, at no price, under their items in Xero; who did the work, with their
 * Texas Department of Agriculture license numbers; and who licenses them. The
 * words alone go to Xero with no quantity or price.
 */
export function serviceRows(service: ReportableVisitService, technician: ServiceTechnician | null | undefined): InvoiceLineInput[] {
  if (service !== 'pestControl' && service !== 'fleaTreatment') return [];
  const name = technician?.name.trim();
  const servicedBy = row(
    `Serviced by: ${CERTIFIED_APPLICATOR}${name ? ` and ${name}${technician?.pestLicenseNumber ? ` (${technician.pestLicenseNumber})` : ''}` : ''}`,
  );
  return service === 'pestControl'
    ? [row('Flex 10 - 10 Insecticide - 1%; Quantity Used: 1 Galloon EPA#88746-1', FLEX_10), servicedBy, LICENSED]
    : [
        row('Flex 10 - 10 Insecticide - 1%; Quantity Used:1 Galloon EPA#88746-1', FLEX_10),
        row('SOLU97: Vallar Plus 25#; Quantity Used:2.5 Pounds EPA#88746-5', VALLAR_PLUS),
        servicedBy,
        LICENSED,
      ];
}

export interface InvoiceBillingRuleView {
  id: string;
  /** The visit's type; null for any visit. */
  inspectionType: InspectionType | null;
  /** A service the technician reported done; null for whatever was done. One of the two is always given. */
  service: ReportableVisitService | null;
  /** The product it bills, on the office's list. */
  productId: string;
  /**
   * From this much of the property's floor area on, in square feet
   * (2026-11-13), it bills `largeProductId` instead: pest control on a house of
   * 2,000 sq ft or more. Null with it: the same product, whatever the size.
   */
  largeFromSqFt: number | null;
  largeProductId: string | null;
}

/** The largest property a rule's size can name, in square feet. */
export const MAX_RULE_SQFT = 100_000;

/** A rule the office's past invoices suggest, not saved yet. */
export interface SuggestedBillingRule {
  inspectionType: InspectionType;
  productId: string;
  /** The visits of this type invoiced in the past six months that billed it. */
  seen: number;
  /** All the visits of this type invoiced in that time. */
  of: number;
}

export interface NewBillingRule {
  inspectionType: InspectionType | null;
  service: ReportableVisitService | null;
  productId: string;
  /** From this size of property on, the other product (2026-11-13). Both or neither. */
  largeFromSqFt?: number | null;
  largeProductId?: string | null;
}

export interface AddBillingRulesInput {
  rules: NewBillingRule[];
}

/** A product as a rule bills it. */
export interface BillingProduct {
  id: string;
  name: string;
  unitPriceCents: number;
  /** Set aside: a rule that bills it bills nothing until it is offered again. */
  active: boolean;
  /** What the line says under its name (2026-11-13), as the New invoice fills it from the product. */
  description?: string | null;
}

/** Who a rule is for, in words: "Move-out inspection visits", "Visits with pest control done". */
export function billingRuleWhen(rule: Pick<NewBillingRule, 'inspectionType' | 'service'>): string {
  const service = rule.service ? VISIT_SERVICE_LABEL[rule.service].replace(/^Pest|^Flea/, (word) => word.toLowerCase()) : null;
  if (rule.inspectionType && service) return `${inspectionWords(rule.inspectionType)} visits with ${service} done`;
  if (rule.inspectionType) return `${inspectionWords(rule.inspectionType)} visits`;
  return `Visits with ${service ?? 'anything'} done`;
}

/** What is wrong with a rule, in words; null when it can be kept. */
export function billingRuleProblem(rule: Pick<NewBillingRule, 'inspectionType' | 'service'> & Partial<Pick<NewBillingRule, 'productId' | 'largeFromSqFt' | 'largeProductId'>>): string | null {
  if (!rule.inspectionType && !rule.service) return 'Say which visits it is for: their type, a service done, or both.';
  const size = rule.largeFromSqFt ?? null;
  const large = rule.largeProductId ?? null;
  if ((size === null) !== (large === null)) return 'Give both the size and the product billed from it, or neither.';
  if (size !== null && (!Number.isInteger(size) || size < 1 || size > MAX_RULE_SQFT))
    return `Give the size in whole square feet, from 1 to ${MAX_RULE_SQFT.toLocaleString('en-US')}.`;
  if (large !== null && large === rule.productId) return 'Choose another product for the larger properties, or leave the size out.';
  return null;
}

/** The size part of a rule, in words: "from 2,000 sq ft: Pest Control: House over 2,000 sq ft". Null when it has none. */
export function billingRuleSize(rule: Pick<InvoiceBillingRuleView, 'largeFromSqFt' | 'largeProductId'>, products: readonly Pick<BillingProduct, 'id' | 'name'>[]): string | null {
  if (rule.largeFromSqFt === null || rule.largeProductId === null) return null;
  const name = products.find((product) => product.id === rule.largeProductId)?.name ?? 'a product no longer listed';
  return `from ${rule.largeFromSqFt.toLocaleString('en-US')} sq ft: ${name}`;
}

/** The product a rule bills on a property this size: its larger one from its size on; its own when the size is not known. */
export function ruleProductFor(rule: Pick<NewBillingRule, 'productId' | 'largeFromSqFt' | 'largeProductId'>, areaSqFt: number | null | undefined): string {
  return rule.largeProductId && rule.largeFromSqFt && areaSqFt && areaSqFt >= rule.largeFromSqFt ? rule.largeProductId : rule.productId;
}

/** Whether a rule covers a visit. */
const covers = (rule: Pick<NewBillingRule, 'inspectionType' | 'service'>, visit: { inspectionType: string; services: readonly string[] }) =>
  (rule.inspectionType === null || rule.inspectionType === visit.inspectionType) && (rule.service === null || visit.services.includes(rule.service));

/** Rules for a visit's type come first, then those for a service done, in the report's order. */
const order = (rule: Pick<NewBillingRule, 'service'>) => (rule.service === null ? -1 : REPORTABLE_VISIT_SERVICES.indexOf(rule.service));

/**
 * A finished visit's lines by the office's rules: one per product its rules
 * bill, at quantity one and the product's price. With the reason it cannot
 * be invoiced as it stands, if any: no rule covers it, a product it bills is
 * set aside, or one has no price yet -- a line at $0 is kept, for the editor
 * to ask the price, but never invoiced in a batch.
 */
export function billedLines(
  /**
   * `areaSqFt`: the property's floor area, for a rule that bills another product from a size on; unknown is the
   * smaller. `technician`: who did the work, named on the rows after pest control and flea treatment (2026-11-16).
   */
  visit: { inspectionType: string; services: readonly ReportableVisitService[]; areaSqFt?: number | null; technician?: ServiceTechnician | null },
  rules: readonly (Pick<NewBillingRule, 'inspectionType' | 'service' | 'productId'> & Partial<Pick<NewBillingRule, 'largeFromSqFt' | 'largeProductId'>>)[],
  products: readonly BillingProduct[],
): { lineItems: InvoiceLineInput[]; problem: string | null } {
  const matched = rules.filter((rule) => covers(rule, visit)).sort((a, b) => order(a) - order(b));
  if (!matched.length)
    return { lineItems: [], problem: `No rule says what this visit bills (${inspectionWords(visit.inspectionType)}). Add one under Invoices → Settings.` };
  const lineItems: InvoiceLineInput[] = [];
  const billed = new Set<string>();
  let problem: string | null = null;
  for (const rule of matched) {
    const productId = ruleProductFor(rule, visit.areaSqFt);
    if (billed.has(productId)) continue;
    billed.add(productId);
    const product = products.find((each) => each.id === productId);
    if (!product?.active) {
      problem ??= `${product?.name ?? 'A product a rule bills'} is set aside. Offer it again, or change the rule, under Invoices → Settings.`;
      continue;
    }
    if (product.unitPriceCents <= 0) problem ??= `No price yet for ${product.name}. Set one under Invoices → Settings.`;
    lineItems.push({ name: product.name, description: product.description?.trim() || null, quantity: 1, unitPriceCents: product.unitPriceCents });
    // Pest control and flea treatment are followed by the rows Crystal Creek Pest's invoices carry (2026-11-16).
    if (rule.service) lineItems.push(...serviceRows(rule.service, visit.technician));
  }
  return { lineItems, problem: problem ?? invoiceLinesProblem(lineItems) };
}

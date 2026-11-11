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

export interface InvoiceBillingRuleView {
  id: string;
  /** The visit's type; null for any visit. */
  inspectionType: InspectionType | null;
  /** A service the technician reported done; null for whatever was done. One of the two is always given. */
  service: ReportableVisitService | null;
  /** The product it bills, on the office's list. */
  productId: string;
}

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
}

/** Who a rule is for, in words: "Move-out inspection visits", "Visits with pest control done". */
export function billingRuleWhen(rule: Pick<NewBillingRule, 'inspectionType' | 'service'>): string {
  const service = rule.service ? VISIT_SERVICE_LABEL[rule.service].replace(/^Pest|^Flea/, (word) => word.toLowerCase()) : null;
  if (rule.inspectionType && service) return `${inspectionWords(rule.inspectionType)} visits with ${service} done`;
  if (rule.inspectionType) return `${inspectionWords(rule.inspectionType)} visits`;
  return `Visits with ${service ?? 'anything'} done`;
}

/** What is wrong with a rule, in words; null when it can be kept. */
export function billingRuleProblem(rule: Pick<NewBillingRule, 'inspectionType' | 'service'>): string | null {
  if (!rule.inspectionType && !rule.service) return 'Say which visits it is for: their type, a service done, or both.';
  return null;
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
  visit: { inspectionType: string; services: readonly ReportableVisitService[] },
  rules: readonly Pick<NewBillingRule, 'inspectionType' | 'service' | 'productId'>[],
  products: readonly BillingProduct[],
): { lineItems: InvoiceLineInput[]; problem: string | null } {
  const matched = rules.filter((rule) => covers(rule, visit)).sort((a, b) => order(a) - order(b));
  if (!matched.length)
    return { lineItems: [], problem: `No rule says what this visit bills (${inspectionWords(visit.inspectionType)}). Add one under Invoices → Settings.` };
  const lineItems: InvoiceLineInput[] = [];
  const billed = new Set<string>();
  let problem: string | null = null;
  for (const rule of matched) {
    if (billed.has(rule.productId)) continue;
    billed.add(rule.productId);
    const product = products.find((each) => each.id === rule.productId);
    if (!product?.active) {
      problem ??= `${product?.name ?? 'A product a rule bills'} is set aside. Offer it again, or change the rule, under Invoices → Settings.`;
      continue;
    }
    if (product.unitPriceCents <= 0) problem ??= `No price yet for ${product.name}. Set one under Invoices → Settings.`;
    lineItems.push({ name: product.name, description: null, quantity: 1, unitPriceCents: product.unitPriceCents });
  }
  return { lineItems, problem: problem ?? invoiceLinesProblem(lineItems) };
}

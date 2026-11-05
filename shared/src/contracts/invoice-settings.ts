/**
 * The office's invoice settings (2026-11-06, phase 6 of taking invoicing over
 * from Jobber), as Jobber's settings keep them:
 *
 * - the company its invoices, receipts and emails are from;
 * - what a new invoice starts with -- subject, payment terms, the message to
 *   the client and the contract / disclaimer at its foot;
 * - its products and services at its own prices, which price a new invoice's
 *   lines before anything billed in the past does.
 *
 * Until now the console guessed each of these: the company from the server's
 * settings, the wording from the latest invoice, the prices from six months of
 * billing. A blank setting still falls back to that guess, so nothing changes
 * until the office fills one in. None of it reaches Jobber, and none of it is
 * billed.
 */

import { isEmailAddress } from './invoice-delivery.js';
import { PAYMENT_TERMS, type ReceiptBrand } from './invoices.js';

/** The most products and services one office keeps. */
export const MAX_INVOICE_PRODUCTS = 200;
/** $1,000,000: no price the office charges comes near it. */
export const MAX_PRODUCT_PRICE_CENTS = 100_000_000;
/** The most added in one go, as "Add all" from what was billed. */
export const MAX_PRODUCTS_PER_ADD = 50;

export interface InvoiceSettingsValues {
  companyName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  phone: string | null;
  email: string | null;
  defaultSubject: string | null;
  /** One of `PAYMENT_TERMS`. */
  defaultTermsDays: number | null;
  defaultClientMessage: string | null;
  defaultContractDisclaimer: string | null;
}

export const EMPTY_INVOICE_SETTINGS: InvoiceSettingsValues = {
  companyName: null,
  addressLine1: null,
  addressLine2: null,
  phone: null,
  email: null,
  defaultSubject: null,
  defaultTermsDays: null,
  defaultClientMessage: null,
  defaultContractDisclaimer: null,
};

/** What a new invoice starts with, once the settings and their fallbacks are worked out. */
export interface NewInvoiceDefaults {
  subject: string;
  termsDays: number;
  clientMessage: string | null;
  contractDisclaimer: string | null;
}

export interface InvoiceProductView {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  /** Set aside: no longer offered, kept so what it priced stays readable. */
  active: boolean;
  /** ISO; sent back with a change. */
  updatedAt: string;
}

/** A product or service billed in the past six months that is not on the list, at the price billed most often. */
export interface BilledPrice {
  name: string;
  unitPriceCents: number;
}

/**
 * The files on Jobber's invoices, and how many the console keeps its own copy
 * of (2026-11-06, phase 7): every one must be kept before the office leaves
 * Jobber, whose links stop working then.
 */
export interface InvoiceFileCopyStatus {
  total: number;
  kept: number;
  /** Still to copy: the next runs take them, a couple of dozen at a time. */
  waiting: number;
  /** Tried too often; copied again only when asked. */
  failed: number;
  /** What went wrong with the failed ones, the most common first. */
  problems: { problem: string; files: number }[];
}

export interface InvoiceSettingsView {
  values: InvoiceSettingsValues;
  /** What a blank field falls back to, so the page can say so. */
  fallback: { brand: ReceiptBrand } & NewInvoiceDefaults;
  /** The company as invoices, receipts and emails print it now. */
  brand: ReceiptBrand;
  /** What a new invoice starts with now. */
  defaults: NewInvoiceDefaults;
  /** ISO; null until the settings are first saved. Sent back with a save. */
  updatedAt: string | null;
  products: InvoiceProductView[];
  billed: BilledPrice[];
  /** The console's copies of the files on Jobber's invoices (phase 7). */
  files?: InvoiceFileCopyStatus;
}

export interface SaveInvoiceSettingsInput extends InvoiceSettingsValues {
  /** The `updatedAt` it was read at; null when it had never been saved. */
  expectedUpdatedAt: string | null;
}

export interface NewInvoiceProduct {
  name: string;
  description?: string | null;
  unitPriceCents: number;
}

export interface AddInvoiceProductsInput {
  products: NewInvoiceProduct[];
}

export interface ChangeInvoiceProductInput {
  name?: string;
  description?: string | null;
  unitPriceCents?: number;
  active?: boolean;
  expectedUpdatedAt: string;
}

/** "Filter change" and "Filter Change " are one product. */
export const productNameKey = (name: string) => name.trim().toLowerCase();

/** Trimmed, and null when nothing is left. */
export const settingText = (value: string | null | undefined) => value?.trim() || null;

/** What is wrong with the settings, in words; null when they can be saved. */
export function invoiceSettingsProblem(values: InvoiceSettingsValues): string | null {
  const email = settingText(values.email);
  if (email && !isEmailAddress(email)) return `${email} is not an email address.`;
  if (values.defaultTermsDays !== null && !PAYMENT_TERMS.some((option) => option.days === values.defaultTermsDays))
    return 'Choose the payment terms from the list.';
  return null;
}

/** What is wrong with a product, in words; null when it can be kept. */
export function invoiceProductProblem(product: { name: string; unitPriceCents: number }): string | null {
  if (!product.name.trim()) return 'Give the product or service a name.';
  if (!Number.isInteger(product.unitPriceCents) || product.unitPriceCents < 0) return 'Give a price of $0.00 or more.';
  if (product.unitPriceCents > MAX_PRODUCT_PRICE_CENTS) return 'Give a price of $1,000,000.00 or less.';
  return null;
}

/**
 * The office's Xero organisation (2026-11-10, phase 1 of the Xero plan):
 * connected once by somebody who runs the integrations, then read -- its
 * details, its chart of accounts and its tax rates -- so the next phases can
 * map the console's products and payment methods onto it. Nothing is written
 * to Xero yet.
 */

export type XeroConnectionStatus = 'DISCONNECTED' | 'CONNECTED' | 'REAUTHORIZATION_REQUIRED';

export interface XeroOrganisation {
  name: string;
  legalName: string | null;
  /** "USD". */
  baseCurrency: string | null;
  /** "US". */
  countryCode: string | null;
  organisationType: string | null;
  /** How Xero works out sales tax for the organisation, e.g. "NONE". */
  salesTaxBasis: string | null;
  /** Xero's short code, part of its own links ("!abC1d"). */
  shortCode: string | null;
}

export interface XeroAccount {
  accountId: string;
  /** Null for a bank account, which Xero lets go without one. */
  code: string | null;
  name: string;
  /** REVENUE, SALES, BANK, CURRLIAB, ... */
  type: string;
  /** ASSET, EQUITY, EXPENSE, LIABILITY, REVENUE. */
  class: string | null;
  status: string;
  /** Payments can be recorded to it: a bank account, or one marked so. */
  takesPayments: boolean;
}

export interface XeroTaxRate {
  name: string;
  /** What a line names: "NONE", "OUTPUT", "TAX001". */
  taxType: string;
  status: string;
  /** Percent. */
  effectiveRate: number | null;
  appliesToRevenue: boolean;
}

export interface XeroConnectionView {
  /** Whether this server has a Xero app's credentials at all. */
  configured: boolean;
  status: XeroConnectionStatus;
  tenantName: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  /** Why it needs connecting again, in words. */
  problem: string | null;
  scopes: string[];
  organisation: XeroOrganisation | null;
  accounts: XeroAccount[];
  taxRates: XeroTaxRate[];
  readAt: string | null;
  readProblem: string | null;
  /** Calls to Xero today (Texas), and the console's own ceiling on them. */
  callsToday: number;
  dailyCeiling: number;
}

/** The accounts a sale is posted to: active revenue accounts with a code. */
export const revenueAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter((account) => account.status === 'ACTIVE' && account.code && (account.class === 'REVENUE' || account.type === 'REVENUE' || account.type === 'SALES'));

/** The accounts a payment can be recorded to: active, and taking payments. */
export const paymentAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter((account) => account.status === 'ACTIVE' && account.takesPayments);

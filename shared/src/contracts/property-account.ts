/**
 * A property's account (2026-11-10, phase 3 of the invoice gap review), as
 * Jobber's client page keeps it: the billing history -- every invoice and
 * every payment, newest first, with the balance after each -- and the
 * statement made from it, downloaded as a PDF or emailed to the client.
 *
 * For the office, Jobber's client is the property, so the account is the
 * property's: its invoices, and the payments on them. Drafts and voided
 * invoices were never owed and are not in it.
 */

import type { InvoiceDeliveryView } from './invoice-delivery.js';
import type { InvoiceStatus, PaymentMethod, ReceiptBrand } from './invoices.js';

export type AccountEntryKind = 'INVOICE' | 'PAYMENT' | 'REFUND' | 'ADJUSTMENT' | 'WRITE_OFF';

export const ACCOUNT_ENTRY_LABEL: Record<AccountEntryKind, string> = {
  INVOICE: 'Invoice',
  PAYMENT: 'Payment',
  REFUND: 'Refund',
  ADJUSTMENT: 'Deposit or credit in Jobber',
  WRITE_OFF: 'Written off as bad debt',
};

export interface AccountEntry {
  /** The invoice's or the payment's id, with the kind: unique in the account. */
  key: string;
  kind: AccountEntryKind;
  /** The invoice's issue day, or the day the money came in. */
  on: string;
  invoiceId: string;
  invoiceNumber: string | null;
  paymentId: string | null;
  /** What it does to the balance: an invoice adds, a payment takes away, a refund adds back. */
  amountCents: number;
  /** The balance once it was entered. */
  balanceCents: number;
  /** An invoice's status as it stands today. */
  status: InvoiceStatus | null;
  method: PaymentMethod | null;
  reference: string | null;
}

/** Jobber's three: everything, since the account last stood at nothing, or from a day. */
export type StatementPeriod = 'LIFETIME' | 'SINCE_ZERO' | 'FROM';

export const STATEMENT_PERIOD_LABEL: Record<StatementPeriod, string> = {
  LIFETIME: 'Client lifetime',
  SINCE_ZERO: 'Since last zero balance',
  FROM: 'Pick a start date',
};

export interface StatementQuery {
  period: StatementPeriod;
  /** `YYYY-MM-DD`, with FROM. */
  from?: string | null;
}

export interface PropertyAccount {
  propertyId: string;
  clientName: string;
  address: string | null;
  /** Newest first, as Jobber's Billing card lists them. */
  entries: AccountEntry[];
  balanceCents: number;
  invoicedCents: number;
  paidCents: number;
  /** More entries than are listed. */
  truncated: boolean;
  /** Whether statements can be emailed from here: once the console owns invoicing. */
  writesEnabled: boolean;
  /** Who a statement goes to by default: the client's addresses from its latest invoice. */
  statementTo: string[];
  /** The statements emailed for this property, newest first. */
  statements: InvoiceDeliveryView[];
}

/** A statement: the account over its period, in the office's order, with its foot text. */
export interface StatementView {
  propertyId: string;
  clientName: string;
  address: string | null;
  /** What the period was asked as, and the first day it covers (null: from the start). */
  period: StatementPeriod;
  from: string | null;
  /** The Texas day it was made. */
  on: string;
  /** Owed before the first entry, and after the last. */
  openingBalanceCents: number;
  closingBalanceCents: number;
  entries: AccountEntry[];
  newestFirst: boolean;
  disclaimer: string | null;
  brand: ReceiptBrand;
}

export interface SendStatementInput extends StatementQuery {
  to: string[];
  clientRequestId: string;
}

/** Jobber's statement settings: the order of the billing history, and the text at the foot. */
export interface StatementSettings {
  newestFirst: boolean;
  disclaimer: string | null;
}

export interface StatementSettingsView extends StatementSettings {
  updatedAt: string | null;
}

export interface SaveStatementSettingsInput extends StatementSettings {
  expectedUpdatedAt: string | null;
}

export const MAX_STATEMENT_DISCLAIMER = 4000;
export const MAX_ACCOUNT_ENTRIES = 2000;

/** What is wrong with a statement's period, in words; null when it can be made. */
export function statementQueryProblem(query: StatementQuery, today: string): string | null {
  if (query.period !== 'FROM') return null;
  if (!query.from || !/^\d{4}-\d{2}-\d{2}$/.test(query.from)) return 'Pick the day the statement starts.';
  if (query.from > today) return 'A statement cannot start after today.';
  return null;
}

interface Ledger {
  kind: AccountEntryKind;
  on: string;
  /** Orders entries made on the same day: invoices before what pays them. */
  order: number;
}

/**
 * The account's entries with the balance after each, oldest first: an
 * invoice before a payment on the same day, as a payment cannot come before
 * what it pays.
 */
export function runningBalance<T extends Ledger & { amountCents: number }>(entries: readonly T[]): (T & { balanceCents: number })[] {
  let balance = 0;
  return [...entries]
    .sort((a, b) => a.on.localeCompare(b.on) || a.order - b.order)
    .map((entry) => {
      balance += entry.amountCents;
      return { ...entry, balanceCents: balance };
    });
}

/**
 * The entries a statement covers, oldest first, and what was owed before
 * them. Since the last zero balance starts after the last entry that left
 * nothing owed (or credit); a lifetime statement starts at the beginning.
 */
export function statementSlice<T extends { on: string; balanceCents: number }>(
  oldestFirst: readonly T[],
  query: StatementQuery,
): { entries: T[]; openingBalanceCents: number; from: string | null } {
  if (query.period === 'LIFETIME' || !oldestFirst.length) return { entries: [...oldestFirst], openingBalanceCents: 0, from: oldestFirst[0]?.on ?? null };
  if (query.period === 'SINCE_ZERO') {
    let start = 0;
    oldestFirst.forEach((entry, index) => {
      if (entry.balanceCents <= 0) start = index + 1;
    });
    const entries = oldestFirst.slice(start);
    return { entries, openingBalanceCents: start ? oldestFirst[start - 1]!.balanceCents : 0, from: entries[0]?.on ?? null };
  }
  const from = query.from ?? '';
  const start = oldestFirst.findIndex((entry) => entry.on >= from);
  const entries = start < 0 ? [] : oldestFirst.slice(start);
  const before = start < 0 ? oldestFirst.at(-1) : start > 0 ? oldestFirst[start - 1] : undefined;
  return { entries, openingBalanceCents: before?.balanceCents ?? 0, from };
}

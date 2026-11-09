/**
 * What Jobber did for the office on its own, and stops doing at Take over
 * (2026-11-09, phase 1 of the invoice gap review):
 *
 * - **Follow-ups:** an email to the client on the day an unpaid invoice is due,
 *   and again four days later. Jobber's two automations, both on.
 * - **Receipts:** an email when a payment is recorded, by hand or automatically.
 * - **Batch Deliver:** many invoices emailed at once, or printed in one file.
 *
 * Every email is a billed call to the mail provider, so each of these counts
 * against the office's daily invoice email ceiling, and none sends anything
 * twice.
 */

import type { InvoiceStatus } from './invoices.js';

/** Jobber's: on the due date, then four days after it. */
export const DEFAULT_FOLLOW_UP_DAYS: readonly number[] = [0, 4];
export const MAX_FOLLOW_UP_STEPS = 4;
export const MAX_FOLLOW_UP_DAY = 60;

export interface InvoiceEmailSettings {
  /** Emails clients about unpaid invoices, on the days below. */
  followUpsEnabled: boolean;
  /** Days after the due date: 0 is the due date itself. */
  followUpDays: number[];
  /** Emails a receipt when a payment is recorded here. */
  receiptsAutomatic: boolean;
}

export const DEFAULT_INVOICE_EMAIL_SETTINGS: InvoiceEmailSettings = {
  followUpsEnabled: true,
  followUpDays: [...DEFAULT_FOLLOW_UP_DAYS],
  receiptsAutomatic: false,
};

export interface InvoiceEmailSettingsView extends InvoiceEmailSettings {
  /**
   * Whether the console owns invoicing yet. Until it does these do nothing:
   * Jobber sends its own follow-ups, and two would reach the client.
   */
  takenOver: boolean;
  /** ISO; null until first saved. Sent back with a save. */
  updatedAt: string | null;
}

export interface SaveInvoiceEmailSettingsInput extends InvoiceEmailSettings {
  expectedUpdatedAt: string | null;
}

/** What is wrong with the follow-up days, in words; null when they can be kept. */
export function followUpDaysProblem(days: readonly number[]): string | null {
  if (days.length > MAX_FOLLOW_UP_STEPS) return `Choose at most ${MAX_FOLLOW_UP_STEPS} follow-ups.`;
  if (days.some((day) => !Number.isInteger(day) || day < 0 || day > MAX_FOLLOW_UP_DAY))
    return `A follow-up goes on the due date or up to ${MAX_FOLLOW_UP_DAY} days after it.`;
  if (new Set(days).size !== days.length) return 'Each follow-up needs its own day.';
  return null;
}

/** The days in order, each once. */
export const sortedFollowUpDays = (days: readonly number[]) => [...new Set(days)].sort((a, b) => a - b);

/** "On the due date", "4 days after it is due". */
export const followUpWhen = (day: number) =>
  day === 0 ? 'On the due date' : `${day} day${day === 1 ? '' : 's'} after it is due`;

/** As Jobber's email says it: "due today", "4 days overdue". */
export const overdueWords = (days: number) =>
  days <= 0 ? 'due today' : `${days} day${days === 1 ? '' : 's'} overdue`;

/** Whole days from one Texas day to another, both `YYYY-MM-DD`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The follow-up an invoice is owed today, if any: the day after its due date
 * that today is, when that is one of the office's. Only an invoice still
 * awaiting payment and still owing anything: Jobber's condition was "Status is
 * awaiting".
 */
export function followUpDueToday(
  invoice: { status: InvoiceStatus | string; balanceCents: number; dueOn: string | null },
  today: string,
  days: readonly number[],
): number | null {
  if (invoice.status !== 'AWAITING_PAYMENT' && invoice.status !== 'PAST_DUE') return null;
  if (invoice.balanceCents <= 0 || !invoice.dueOn) return null;
  const late = daysBetween(invoice.dueOn, today);
  return days.includes(late) ? late : null;
}

/** What an email from the console was for. */
export type InvoiceDeliveryKind = 'INVOICE' | 'FOLLOW_UP' | 'RECEIPT';

export interface SendReceiptInput {
  /** Email addresses, at most `MAX_INVOICE_RECIPIENTS`. */
  to: string[];
  /** The browser's key: a resend or a double click sends one email. */
  clientRequestId: string;
}

/** The most invoices one Batch Deliver sends. */
export const MAX_BATCH_DELIVERY = 50;

/** An invoice Batch Deliver offers: sent to nobody yet, with who it would go to. */
export interface DeliverableInvoice {
  id: string;
  number: string | null;
  clientName: string;
  status: InvoiceStatus;
  issuedOn: string | null;
  dueOn: string | null;
  totalCents: number;
  balanceCents: number;
  /** Who it would go to: the client's addresses, primary first. Empty when the client has none. */
  to: string[];
}

export interface DeliverableQuery {
  /** Issued on or after, `YYYY-MM-DD`. */
  from: string;
  /** Issued on or before, `YYYY-MM-DD`. */
  to: string;
}

export interface DeliverInvoicesInput {
  /** The page's key for this press: each invoice's email is keyed under it. */
  batchKey: string;
  invoices: { invoiceId: string; to: string[] }[];
  /** A note above each invoice. */
  message?: string | null;
}

export interface DeliverInvoicesResult {
  results: { invoiceId: string; status: 'SENT' | 'FAILED'; problem: string | null }[];
}

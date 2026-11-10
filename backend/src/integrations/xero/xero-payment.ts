import { createHash } from 'node:crypto';

import { PAYMENT_METHOD_LABEL, paymentAccounts, type PaymentMethod, type XeroAccount, type XeroSettingsValues } from '@texasrenters/shared';

/**
 * A payment as Xero is sent it (2026-11-10, phase 4 of the multi-company plan):
 * against its invoice in the company's books the invoice went to, into the
 * account the office chose for how it was paid.
 *
 * Pure: what to send, or why not. Xero keeps a payment as it was made -- it
 * is never edited there -- so a payment changed here is deleted in Xero and
 * sent again, and the fingerprint says when it changed.
 */

export interface PaymentForXero {
  id: string;
  paidOn: Date;
  amountCents: number;
  /** InvoicePaymentMethod. */
  method: string;
  reference: string | null;
}

export interface XeroPaymentBody {
  Invoice: { InvoiceID: string };
  Account: { AccountID: string };
  Date: string;
  Amount: number;
  Reference: string;
}

export type XeroPaymentPlan = { kind: 'send'; body: XeroPaymentBody } | { kind: 'problem'; problem: string };

const day = (value: Date) => value.toISOString().slice(0, 10);
const label = (method: string) => PAYMENT_METHOD_LABEL[method as PaymentMethod] ?? method;

/**
 * What the payment says, as a hash: sent again only when this changes. The
 * account is not in it -- choosing another account for a method applies to
 * payments from then on, and never moves one already in Xero's books.
 */
export function paymentFingerprint(payment: PaymentForXero): string {
  const content = { amountCents: payment.amountCents, paidOn: day(payment.paidOn), method: payment.method, reference: payment.reference?.trim() || null };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** The payment's body for Xero, or why the console holds it back, in words. */
export function xeroPaymentFrom(
  payment: PaymentForXero,
  context: { settings: XeroSettingsValues; accounts: readonly XeroAccount[]; xeroInvoiceId: string },
): XeroPaymentPlan {
  if (!Number.isInteger(payment.amountCents) || payment.amountCents <= 0) return { kind: 'problem', problem: 'A payment of nothing is not sent.' };
  const accountId = context.settings.paymentAccounts[payment.method as PaymentMethod];
  if (!accountId)
    return { kind: 'problem', problem: `Choose the Xero account ${label(payment.method)} payments land in, under “Before anything is sent”.` };
  if (!paymentAccounts(context.accounts).some((account) => account.accountId === accountId))
    return {
      kind: 'problem',
      problem: `The account chosen for ${label(payment.method)} payments is no longer in Xero, or no longer takes payments: choose another.`,
    };
  return {
    kind: 'send',
    body: {
      Invoice: { InvoiceID: context.xeroInvoiceId },
      Account: { AccountID: accountId },
      Date: day(payment.paidOn),
      Amount: Number((payment.amountCents / 100).toFixed(2)),
      Reference: (payment.reference?.trim() || label(payment.method)).slice(0, 255),
    },
  };
}

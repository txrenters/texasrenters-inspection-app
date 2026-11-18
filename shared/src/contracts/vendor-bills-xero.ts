import type { VendorPaymentMethod } from './receiving.js';
import type { XeroAccount } from './xero.js';

/**
 * Vendor bills to Xero (2026-11-19, phase 7 of the inventory and purchasing
 * plan). An approved bill goes to its company's books once, as a draft bill
 * (accounts payable), when somebody presses "Send to Xero". Once the office
 * has approved it in Xero, the payment the console recorded can be sent
 * against it, also by a press.
 *
 * Nothing goes by itself, nothing already in Xero is ever changed or voided
 * from here, and each press makes a counted handful of calls to Xero under
 * the organisation's daily ceiling.
 */

/** Where a bill, or its payment, stands with Xero. PENDING is "asked, and Xero's answer was lost": the next press looks for it first. */
export const XERO_BILL_SEND_STATUSES = ['NOT_SENT', 'PENDING', 'SENT', 'FAILED'] as const;
export type XeroBillSendStatus = (typeof XERO_BILL_SEND_STATUSES)[number];

/** A company's choices for its bills, kept apart from its invoice settings. */
export interface XeroBillSettings {
  /** The account a bill's lines are booked to: purchases, or inventory. */
  purchasesAccountId: string | null;
  /** The bank or card account each way of paying comes out of. */
  paymentAccounts: Partial<Record<VendorPaymentMethod, string>>;
}

export type SaveXeroBillSettingsInput = XeroBillSettings;

export interface XeroBillAccountOption {
  accountId: string;
  code: string | null;
  name: string;
}

export interface XeroBillSettingsView {
  tenantId: string;
  settings: XeroBillSettings;
  /** The accounts a bill can be booked to, and paid from, as last read from Xero. */
  purchaseAccounts: XeroBillAccountOption[];
  bankAccounts: XeroBillAccountOption[];
}

/** The accounts a purchase can be booked to: active, with a code, an expense or an asset (inventory), and not a bank account. */
export const billPurchaseAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter(
    (account) =>
      account.status === 'ACTIVE' &&
      Boolean(account.code) &&
      account.type !== 'BANK' &&
      (account.class === 'EXPENSE' || account.class === 'ASSET' || ['EXPENSE', 'OVERHEADS', 'DIRECTCOSTS', 'INVENTORY', 'CURRENT'].includes(account.type ?? '')),
  );

/** The bill's page in Xero: its draft opens for editing, anything later for viewing. */
export function xeroBillUrl(xeroInvoiceId: string, shortCode: string | null): string {
  const page = `/AccountsPayable/Edit.aspx?InvoiceID=${encodeURIComponent(xeroInvoiceId)}`;
  return shortCode ? `https://go.xero.com/organisationlogin/default.aspx?shortcode=${encodeURIComponent(shortCode)}&redirecturl=${encodeURIComponent(page)}` : `https://go.xero.com${page}`;
}

/** A bill's standing with Xero, as the order's page shows it. */
export interface VendorBillInXero {
  /** The company whose books it goes to; null when the order names none. */
  company: { tenantId: string; name: string } | null;
  status: XeroBillSendStatus;
  /** Its page in Xero, once it is there. */
  url: string | null;
  /** Why the last try did not end with the bill in Xero. */
  problem: string | null;
  sentBy: string | null;
  sentAt: string | null;
  payment: { status: XeroBillSendStatus; problem: string | null; sentBy: string | null; sentAt: string | null };
  /** Why "Send to Xero" cannot be pressed yet, in the office's words; null when it can, or when it has gone. */
  waitsOn: string | null;
  /** Why the payment cannot be sent yet; null when it can, or when it has gone. */
  paymentWaitsOn: string | null;
  can: { send: boolean; sendPayment: boolean };
}

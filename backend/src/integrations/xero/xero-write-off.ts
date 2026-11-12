import { badDebtAccounts, type XeroAccount, type XeroSettingsValues } from '@texasrenters/shared';

/**
 * A bad debt as Xero is sent it (2026-11-10): what an invoice closed as bad
 * debt still owed, written off with a credit note to the organisation's
 * bad-debt account, then allocated to the invoice, so Xero stops counting it
 * as owed. Pure: what to send, or why not.
 */

export interface XeroCreditNoteBody {
  Type: 'ACCRECCREDIT';
  Contact: { ContactID: string };
  Date: string;
  Status: 'AUTHORISED';
  LineAmountTypes: 'Exclusive' | 'Inclusive';
  Reference: string;
  LineItems: { Description: string; Quantity: 1; UnitAmount: number; LineAmount: number; AccountCode: string; TaxType: string }[];
}

export interface XeroAllocationBody {
  Invoice: { InvoiceID: string };
  Amount: number;
  Date: string;
}

export type XeroWriteOffPlan = { kind: 'send'; creditNote: XeroCreditNoteBody; allocation: XeroAllocationBody } | { kind: 'problem'; problem: string };

const dollars = (cents: number) => Number((cents / 100).toFixed(2));

/** The credit note and its allocation for what an invoice still owed, or why the console holds it back, in words. */
export function xeroWriteOffFrom(
  invoice: { number: string | null; balanceCents: number },
  context: { settings: XeroSettingsValues; accounts: readonly XeroAccount[]; contactId: string; xeroInvoiceId: string; day: string },
): XeroWriteOffPlan {
  if (!Number.isInteger(invoice.balanceCents) || invoice.balanceCents <= 0) return { kind: 'problem', problem: 'Nothing was owed on it to write off.' };
  const accountId = context.settings.badDebtAccountId;
  if (!accountId) return { kind: 'problem', problem: 'Choose the account bad debts are written off to, under “Before anything is sent”.' };
  const account = badDebtAccounts(context.accounts).find((candidate) => candidate.accountId === accountId);
  if (!account?.code) return { kind: 'problem', problem: 'The account chosen for bad debts is no longer an active expense account in Xero: choose another.' };
  const amount = dollars(invoice.balanceCents);
  const label = invoice.number ? `invoice #${invoice.number}` : 'the invoice';
  return {
    kind: 'send',
    creditNote: {
      Type: 'ACCRECCREDIT',
      Contact: { ContactID: context.contactId },
      Date: context.day,
      Status: 'AUTHORISED',
      // As the invoice's lines are (2026-11-12): what it still owes, tax and all when prices include it.
      LineAmountTypes: context.settings.pricesIncludeTax === true ? 'Inclusive' : 'Exclusive',
      Reference: `Bad debt: ${label}`.slice(0, 255),
      LineItems: [
        {
          Description: `Written off as bad debt: ${label}`,
          Quantity: 1,
          UnitAmount: amount,
          LineAmount: amount,
          AccountCode: account.code,
          // As the invoice's lines are: the console sends no sales tax.
          TaxType: context.settings.salesTaxType ?? 'NONE',
        },
      ],
    },
    allocation: { Invoice: { InvoiceID: context.xeroInvoiceId }, Amount: amount, Date: context.day },
  };
}

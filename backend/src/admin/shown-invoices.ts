import { InvoiceOrigin, type Prisma } from '@prisma/client';

/**
 * The invoices the office's pages show (2026-11-12). Each company's books
 * read back from Xero arrive as rows of their own (origin XERO), beside
 * Jobber's copies of the same invoices. They stay out of sight -- lists,
 * totals, reports, ledgers, statements, follow-ups -- until the pages show
 * Xero's books in place of Jobber's (PR 3 of the plan to make invoices in the
 * console with Xero as the record), which changes this one rule.
 *
 * Not for asking whether a visit has been invoiced: there every invoice
 * counts, whatever its origin, so nothing is billed twice.
 */
export const SHOWN_INVOICE = { origin: { not: InvoiceOrigin.XERO } } satisfies Prisma.InvoiceWhereInput;

/** A payment is shown when its invoice is. */
export const SHOWN_PAYMENT = { invoice: { is: SHOWN_INVOICE } } satisfies Prisma.InvoicePaymentWhereInput;

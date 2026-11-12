import { invoiceTotals, splitByCompany, type InvoiceLineInput, type ProductCompany, type UninvoicedPart, type XeroTaxMode } from '@texasrenters/shared';
import { InvoiceStatus, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { insertConsoleInvoice } from './invoice-insert';
import { lockInvoiceNumbers } from './invoice-numbers';
import { goesToXero, invoiceProblem, type InvoicingState } from './invoicing-state';

/**
 * Making a visit's or a property's invoices (2026-11-13, PR 3 of the
 * invoicing audit): one function, so the visit's form and the batch ask the
 * same things before anything is written, and write the same way.
 *
 * - Each invoice goes to a company that sends it to Xero, once the console
 *   makes the invoices, and is not issued before that company's start date.
 * - A visit invoiced already -- by the console, in Jobber, or read back from
 *   Xero -- is invoiced again only when asked to on purpose, under the
 *   office's invoice lock so two makers never both make one.
 * - An invoice of a company that sends to Xero is a draft with no number of
 *   the console's: Xero numbers it, and the office approves it there.
 *
 * Run in the caller's transaction: every invoice of the visit, or none.
 */

type Db = Prisma.TransactionClient;

export interface InvoiceToMake {
  xeroTenantId: string | null;
  lines: InvoiceLineInput[];
  /** Its key: a resend of the same request makes it once. */
  clientRequestId: string;
  /** How its amounts carry tax in Xero, from the Xero-style form (2026-11-13); left out, its company's way. */
  taxMode?: XeroTaxMode | null;
}

export interface MakeRequest {
  inspectionId: string | null;
  propertywareBuildingId: string;
  clientName: string;
  jobberJobId: string | null;
  subject: string;
  /** `YYYY-MM-DD` */
  issuedOn: string;
  paymentTermsDays: number;
  /** The due day the Xero-style form chose (2026-11-13), `YYYY-MM-DD`: Xero is sent it and the issue day as they are. */
  dueOn?: string;
  /** Xero's "Reference", from the Xero-style form; null or left out, the property's name. */
  xeroReference?: string | null;
  clientMessage: string | null;
  contractDisclaimer: string | null;
  /** Kept as drafts though their companies do not send to Xero (before the switch only). */
  asDraft: boolean;
  /** Another invoice for a visit invoiced already, said on purpose. */
  additional: boolean;
  /** The batch it is made in, for its record. */
  batchKey?: string;
  invoices: InvoiceToMake[];
}

export interface MadeInvoice {
  id: string;
  number: string | null;
  totalCents: number;
  xeroTenantId: string | null;
}

export type MakeOutcome = { made: MadeInvoice[] } | { refused: 'VISIT_INVOICED' } | { refused: 'PROBLEM'; problem: string };

/**
 * Whether a visit has an invoice that is not voided, of any origin: the
 * console's, Jobber's -- shown or kept out of sight behind Xero's -- or one read
 * from Xero.
 */
export async function visitInvoiced(db: Pick<Db, 'invoice'>, organizationId: string, inspectionId: string): Promise<boolean> {
  const found = await db.invoice.findFirst({
    where: { organizationId, inspectionId, status: { not: InvoiceStatus.VOIDED } },
    select: { id: true },
  });
  return Boolean(found);
}

export async function makeInvoices(tx: Db, user: AuthenticatedUser, state: InvoicingState, request: MakeRequest): Promise<MakeOutcome> {
  for (const invoice of request.invoices) {
    // Made today (2026-11-13): the day it is dated may come before its company's start date.
    const problem = invoiceProblem(state, invoice.xeroTenantId);
    if (problem) return { refused: 'PROBLEM', problem };
  }
  if (request.inspectionId && !request.additional) {
    await lockInvoiceNumbers(tx, user.organizationId);
    if (await visitInvoiced(tx, user.organizationId, request.inspectionId)) return { refused: 'VISIT_INVOICED' };
  }
  const made: MadeInvoice[] = [];
  for (const invoice of request.invoices) {
    const row = await insertConsoleInvoice(tx, user, {
      subject: request.subject,
      clientName: request.clientName,
      inspectionId: request.inspectionId,
      propertywareBuildingId: request.propertywareBuildingId,
      jobberJobId: request.jobberJobId,
      issuedOn: request.issuedOn,
      paymentTermsDays: request.paymentTermsDays,
      ...(request.dueOn ? { dueOn: request.dueOn } : {}),
      ...(request.xeroReference ? { xeroReference: request.xeroReference } : {}),
      ...(invoice.taxMode ? { xeroTaxMode: invoice.taxMode } : {}),
      lines: invoice.lines,
      clientMessage: request.clientMessage,
      contractDisclaimer: request.contractDisclaimer,
      clientRequestId: invoice.clientRequestId,
      asDraft: request.asDraft || goesToXero(state, invoice.xeroTenantId),
      ...(request.batchKey ? { batchKey: request.batchKey } : {}),
      xeroTenantId: invoice.xeroTenantId,
    });
    made.push({ id: row.id, number: row.number, totalCents: row.totalCents, xeroTenantId: invoice.xeroTenantId });
  }
  return { made };
}

/**
 * A visit's lines, one invoice per company, as they would be made (the batch
 * lists them; the visit's form starts from them), and what keeps the visit
 * from being invoiced as it stands, in words: no rule, no price, or -- once the
 * console makes the invoices -- an invoice that would reach no books.
 */
export function visitParts(
  lineItems: readonly InvoiceLineInput[],
  companies: readonly ProductCompany[],
  state: Pick<InvoicingState, 'takenOverAt' | 'sending' | 'startDays' | 'nameOf'>,
  /** The Texas day they would be made: a company's start date is about that day, not the one each is dated. */
  today: string = businessDate(),
): { parts: UninvoicedPart[]; problem: string | null } {
  const parts = splitByCompany(lineItems, companies).map((part) => ({
    xeroTenantId: part.xeroTenantId,
    company: part.xeroTenantId ? state.nameOf(part.xeroTenantId) : null,
    lineItems: part.lineItems,
    totalCents: invoiceTotals(part.lineItems).totalCents,
    toXero: goesToXero(state, part.xeroTenantId),
  }));
  return { parts, problem: parts.map((part) => invoiceProblem(state, part.xeroTenantId, today)).find(Boolean) ?? null };
}

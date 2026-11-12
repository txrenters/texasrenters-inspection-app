import type { InvoiceProductOrganisation } from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';

import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { officeOrganisations, organisationName } from './invoice-settings';

type Db = Prisma.TransactionClient;

/**
 * Where the office's invoicing stands (2026-11-13, PR 3 of the invoicing
 * audit), worked out in one place for every path that makes an invoice -- the
 * visit's form and the draft it starts from, the batch and its list: whether
 * the console makes the invoices, the office's Xero companies, which of them
 * send to Xero now, and from which day. Three reads; nothing calls Xero.
 */
export interface InvoicingState {
  /** When the console took invoicing over; null while Jobber holds it. */
  takenOverAt: Date | null;
  /** The console makes and changes invoices: since the switch, or when the server is told to for trying them out. */
  writesOn: boolean;
  /** The office's Xero companies, connected ones first. */
  organisations: InvoiceProductOrganisation[];
  /** The connected companies whose sending is on: their invoices made here go to their books in Xero, as drafts Xero numbers. */
  sending: ReadonlySet<string>;
  /** Each sending company's start date, `YYYY-MM-DD`: Xero is sent only the invoices issued from it. */
  startDays: ReadonlyMap<string, string>;
  /** A company's name for a message. */
  nameOf: (tenantId: string) => string;
}

export async function invoicingState(db: Db, organizationId: string): Promise<InvoicingState> {
  const [settings, organisations, sending] = await Promise.all([
    db.invoiceSettings.findUnique({ where: { organizationId }, select: { invoicingTakenOverAt: true } }),
    officeOrganisations(db, organizationId),
    db.xeroSettings.findMany({
      where: { organizationId, sendingEnabled: true, xeroOrganisation: { status: 'CONNECTED' } },
      select: { xeroTenantId: true, sendFrom: true },
    }),
  ]);
  const takenOverAt = settings?.invoicingTakenOverAt ?? null;
  return {
    takenOverAt,
    writesOn: getJobberConfig().invoiceWritesEnabled || takenOverAt !== null,
    organisations,
    sending: new Set(sending.map((row) => row.xeroTenantId)),
    startDays: new Map(sending.filter((row) => row.sendFrom).map((row) => [row.xeroTenantId, row.sendFrom!.toISOString().slice(0, 10)])),
    nameOf: organisationName(organisations),
  };
}

/** An invoice of this company goes to its books in Xero, as a draft Xero numbers and the office approves there. */
export const goesToXero = (state: Pick<InvoicingState, 'sending'>, tenantId: string | null) => tenantId !== null && state.sending.has(tenantId);

const longDay = (day: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00.000Z`));

/**
 * What keeps one invoice from being made, in words, wherever it is made
 * (2026-11-13); null when nothing does. Each names its company.
 *
 * - Once the console makes the invoices, one of no company, or of one that
 *   does not send to Xero, would get the console's own number and reach no
 *   books -- and, its company's books read, be emailed by nobody.
 * - One issued before its sending company's start date is never sent, while
 *   its visit would count as invoiced.
 */
export function invoiceProblem(state: Pick<InvoicingState, 'takenOverAt' | 'sending' | 'startDays' | 'nameOf'>, tenantId: string | null, issuedOn: string): string | null {
  if (state.takenOverAt && !goesToXero(state, tenantId))
    return tenantId
      ? `${state.nameOf(tenantId)} does not send its invoices to Xero, so this one would reach no books. Turn its sending on, on the Xero page, first.`
      : 'An invoice that goes to no company would reach no books. Choose the company whose books it goes to.';
  const start = tenantId ? state.startDays.get(tenantId) : undefined;
  if (tenantId && start && issuedOn < start)
    return `${state.nameOf(tenantId)} sends Xero only invoices issued from ${longDay(start)}: issue it that day or later.`;
  return null;
}

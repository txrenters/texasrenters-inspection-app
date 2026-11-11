import { InvoiceOrigin, type Prisma } from '@prisma/client';

type Db = Pick<Prisma.TransactionClient, 'xeroSettings'>;

/**
 * Never a row read from Xero: what the office itself billed, in Jobber or here.
 * For its billing history -- prices, suggested rules, wording, numbering --
 * which Xero's copy of the same invoice would only count twice.
 */
export const NOT_FROM_XERO = { origin: { not: InvoiceOrigin.XERO } } satisfies Prisma.InvoiceWhereInput;

/** The companies whose books have been read from Xero in full (2026-11-12): their organisations' tenant ids. */
export async function readCompanies(db: Db, organizationId: string): Promise<string[]> {
  const rows = await db.xeroSettings.findMany({ where: { organizationId, booksReadAt: { not: null } }, select: { xeroTenantId: true } });
  return rows.map((row) => row.xeroTenantId);
}

/** The office's books in Xero, as the invoice pages need them: which are read, when last, and how to link into each. */
export interface OfficeXeroBooks {
  read: string[];
  /** Each organisation's short code, which opens an invoice in the right company's books. */
  shortCodes: Map<string, string | null>;
  companies: { tenantId: string; name: string; readAt: string | null }[];
}

export async function officeXeroBooks(db: Pick<Prisma.TransactionClient, 'xeroSettings' | 'xeroOrganisation'>, organizationId: string): Promise<OfficeXeroBooks> {
  const [settings, organisations] = await Promise.all([
    db.xeroSettings.findMany({ where: { organizationId, booksReadAt: { not: null } }, select: { xeroTenantId: true, booksLastRunAt: true } }),
    db.xeroOrganisation.findMany({ where: { organizationId }, select: { xeroTenantId: true, name: true, organisation: true } }),
  ]);
  const shortCodes = new Map(
    organisations.map((row) => [row.xeroTenantId, ((row.organisation as { shortCode?: string | null } | null)?.shortCode ?? null) || null]),
  );
  return {
    read: settings.map((row) => row.xeroTenantId),
    shortCodes,
    companies: settings.map((row) => ({
      tenantId: row.xeroTenantId,
      name: organisations.find((organisation) => organisation.xeroTenantId === row.xeroTenantId)?.name ?? 'A company',
      readAt: row.booksLastRunAt?.toISOString() ?? null,
    })),
  };
}

/**
 * The invoices the office's pages show (2026-11-12, PR 3 of the plan to make
 * invoices in the console with Xero as the record). A company whose books have
 * been read from Xero in full shows them as Xero has them -- its rows read from
 * Xero, and the console's own -- in place of Jobber's copies. Any other
 * company, and invoices of none, show as before. A Jobber invoice of no
 * company that Xero's row stands for in a read company's books is not shown
 * twice. `outsideXeroBooks`: none of a read company's at all, for what the
 * console must not do for them -- follow-ups, Batch Deliver.
 *
 * Not for asking whether a visit has been invoiced: there every invoice counts,
 * whatever its origin, so nothing is billed twice.
 *
 * A NOT, so it spreads into any where clause beside its own AND and OR. Each
 * condition in it is false, never unknown, for a row it leaves: NOT of an
 * unknown would hide the row.
 */
export function shownInvoices(read: readonly string[], options: { outsideXeroBooks?: boolean } = {}): Prisma.InvoiceWhereInput {
  const companies = [...read];
  return {
    NOT: [
      // Xero's rows of a company not read in full yet. They always carry their company (checked).
      { origin: InvoiceOrigin.XERO, xeroTenantId: { notIn: companies } },
      // Jobber's copies of a company read in full.
      { origin: InvoiceOrigin.JOBBER, xeroTenantId: { not: null, in: companies } },
      // Jobber's copy that Xero's row stands for, in a company read in full.
      { origin: InvoiceOrigin.JOBBER, xeroTwins: { some: { xeroTenantId: { in: companies } } } },
      ...(options.outsideXeroBooks ? [{ xeroTenantId: { not: null, in: companies } }] : []),
    ],
  };
}

/** A payment is shown when its invoice is. */
export const shownPayments = (read: readonly string[]): Prisma.InvoicePaymentWhereInput => ({ invoice: { is: shownInvoices(read) } });

/**
 * Kept in its company's books in Xero, and changed only there: one read from
 * Xero, or the console's own once Xero has it and its company's books are
 * read. Its edits, payments and emails are Xero's.
 */
export function keptInXero(invoice: { origin: string; xeroTenantId: string | null; xeroInvoiceId: string | null }, read: readonly string[]): boolean {
  return invoice.origin === InvoiceOrigin.XERO || Boolean(invoice.xeroInvoiceId && invoice.xeroTenantId && read.includes(invoice.xeroTenantId));
}

/** Refused for an invoice kept in Xero, in the console's words. */
export const KEPT_IN_XERO = 'This invoice is kept in Xero. Change it there; the console reads it back within the hour.';

import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The office's next invoice number (2026-11-06, phase 4): one above the
 * highest it has, Jobber's included, so the console carries on Jobber's
 * sequence ("8439", "8440") rather than starting another.
 *
 * Inside the caller's transaction, behind a lock held until it commits, so
 * two invoices made at once -- two people, or a batch beside a single one --
 * cannot both take the same number. Only the office's own invoices are
 * counted, and only numbers that are plain digits: a number somebody typed
 * as "8439-A" is kept as it is but is not where the sequence goes on from.
 */
export async function nextInvoiceNumber(tx: Prisma.TransactionClient, organizationId: string): Promise<string> {
  await lockInvoiceNumbers(tx, organizationId);
  const [row] = await tx.$queryRaw<{ highest: string | null }[]>`
    SELECT max("number"::bigint)::text AS highest
      FROM "Invoice"
     WHERE "organizationId" = ${organizationId}::uuid
       -- Xero numbers its own (2026-11-12): what was read back from it is not where this sequence goes on from.
       AND "origin" <> 'XERO'
       AND "number" ~ '^[0-9]{1,15}$'`;
  return String(BigInt(row?.highest ?? '0') + 1n);
}

/** A company's highest invoice number in its own sequence: "INV-" and "5405". */
interface XeroNumberRow {
  tenant: string;
  prefix: string;
  digits: string;
}

/**
 * Each company's highest number in the sequence its books in Xero keep
 * (2026-11-16): among its invoices whose numbers are letters and then digits
 * -- "INV-5405" -- the ones with the prefix of the latest issued, highest
 * first. Jobber's plain numbers ("8745") are not that sequence. Every one the
 * console knows counts, voided or not, read from Xero or made here: Xero
 * refuses a number any of them holds.
 */
function xeroNumberRows(db: Pick<Prisma.TransactionClient, '$queryRaw'>, organizationId: string, tenantIds: readonly string[]) {
  return db.$queryRaw<XeroNumberRow[]>`
    WITH numbered AS (
      SELECT i."xeroTenantId" AS tenant,
             substring(i."number" from '^([^0-9]+)[0-9]{1,15}$') AS prefix,
             substring(i."number" from '([0-9]{1,15})$') AS digits,
             i."issuedOn",
             i."createdAt"
        FROM "Invoice" i
       WHERE i."organizationId" = ${organizationId}::uuid
         AND i."xeroTenantId" = ANY(${[...tenantIds]}::text[])
         AND i."number" ~ '^[^0-9]*[A-Za-z][^0-9]*[0-9]{1,15}$'
    ), latest AS (
      SELECT DISTINCT ON (tenant) tenant, prefix
        FROM numbered
       ORDER BY tenant, "issuedOn" DESC, "createdAt" DESC
    )
    SELECT DISTINCT ON (n.tenant) n.tenant, n.prefix, n.digits
      FROM numbered n
      JOIN latest l ON l.tenant = n.tenant AND l.prefix = n.prefix
     ORDER BY n.tenant, n.digits::numeric DESC, length(n.digits) DESC`;
}

/** The number after it, as wide: "INV-0038" → "INV-0039", "INV-9999" → "INV-10000". */
const numberAfter = (row: Pick<XeroNumberRow, 'prefix' | 'digits'>) => `${row.prefix}${(BigInt(row.digits) + 1n).toString().padStart(row.digits.length, '0')}`;

/**
 * A company's next invoice number, as its books in Xero number them
 * (2026-11-16): one above the highest the console knows -- "INV-5406" after
 * "INV-5405" -- so the office sees it when the invoice is made, not once Xero
 * has it. Null when the console knows none of the company's numbers yet:
 * Xero then numbers the invoice, as before.
 *
 * Taken behind the office's invoice lock, so two invoices made at once never
 * share one. One made in Xero by hand since the books were last read may hold
 * it already: Xero refuses the number then, and the sender takes the next.
 */
export async function nextXeroInvoiceNumber(tx: Prisma.TransactionClient, organizationId: string, xeroTenantId: string): Promise<string | null> {
  await lockInvoiceNumbers(tx, organizationId);
  const [row] = await xeroNumberRows(tx, organizationId, [xeroTenantId]);
  return row?.digits ? numberAfter(row) : null;
}

/**
 * The next number of each company, for the New invoice to show before it is
 * saved (2026-11-16): one query, no lock and no call to Xero. The invoice
 * takes its own when it is saved, which is this one unless another was made
 * in between.
 */
export async function nextXeroInvoiceNumbers(
  prisma: Pick<PrismaClient, '$transaction' | '$executeRaw' | '$queryRaw'>,
  organizationId: string,
  tenantIds: readonly string[],
): Promise<Map<string, string>> {
  if (!tenantIds.length) return new Map();
  const [, rows] = await prisma.$transaction([
    // Raw SQL does not pass through the client's tenant scope: set it here, as it does.
    prisma.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`,
    xeroNumberRows(prisma, organizationId, tenantIds),
  ]);
  return new Map((rows as XeroNumberRow[]).flatMap((row) => (row.digits ? [[row.tenant, numberAfter(row)] as const] : [])));
}

/**
 * The office's invoice-making lock, until the caller's transaction commits.
 * Taken again by the same transaction it is a no-op, so a caller that checks
 * before it makes an invoice -- has this visit been invoiced? -- holds it
 * across both.
 */
export async function lockInvoiceNumbers(tx: Prisma.TransactionClient, organizationId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-number:${organizationId}`}, 0))::text AS locked`;
}

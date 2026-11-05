import type { Prisma } from '@prisma/client';

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
       AND "number" ~ '^[0-9]{1,15}$'`;
  return String(BigInt(row?.highest ?? '0') + 1n);
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

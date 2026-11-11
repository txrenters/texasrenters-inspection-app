import {
  productNameKey,
  type BillingProduct,
  type InspectionType,
  type InvoiceBillingRuleView,
  type ReportableVisitService,
  type SuggestedBillingRule,
} from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../common/prisma.service';

/**
 * What a finished visit bills (2026-11-12, PR 1 of making invoices in the
 * console): the office's rules, the products they name, and the rules its
 * past invoices suggest. Database reads only: nothing here calls Xero, Jobber
 * or anything billed.
 */

type Db = Prisma.TransactionClient;

/** How far back the office's invoices suggest rules. */
const SUGGEST_WINDOW_DAYS = 183;
/** A product is suggested for a type when it was billed on at least half the type's invoiced visits... */
const SUGGEST_SHARE = 0.5;
/** ...and the type had this many invoiced visits at least: one or two are no pattern. */
const SUGGEST_MIN_VISITS = 3;

const DAY_MS = 86_400_000;

/** The office's rules, oldest first. */
export async function billingRules(db: Db, organizationId: string): Promise<InvoiceBillingRuleView[]> {
  const rows = await db.invoiceBillingRule.findMany({
    where: { organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, inspectionType: true, service: true, productId: true },
  });
  return rows.map((row) => ({ ...row, service: row.service as ReportableVisitService | null }));
}

/** What a visit is billed from: the rules, and every product on the list -- set aside or not, so a rule's can be named. */
export interface BillingBasis {
  rules: InvoiceBillingRuleView[];
  products: BillingProduct[];
}

export async function billingBasis(db: Db, organizationId: string): Promise<BillingBasis> {
  const [rules, products] = await Promise.all([
    billingRules(db, organizationId),
    db.invoiceProduct.findMany({ where: { organizationId }, select: { id: true, name: true, unitPriceCents: true, active: true } }),
  ]);
  return { rules, products };
}

/**
 * The rules the office's own invoices suggest: for each visit type no rule
 * covers by its type yet, each product on the list -- offered now -- billed
 * on at least half its visits invoiced in the past six months. Two grouped
 * reads; the most invoiced types first.
 */
export async function suggestedBillingRules(
  prisma: PrismaService,
  organizationId: string,
  today: string,
  basis: BillingBasis,
): Promise<SuggestedBillingRule[]> {
  const from = new Date(new Date(`${today}T00:00:00.000Z`).getTime() - SUGGEST_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const [, totals, billed] = await prisma.$transaction([
    // Raw SQL does not pass through the client's tenant scope: set it here, as it does.
    prisma.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`,
    prisma.$queryRaw<{ type: InspectionType; visits: bigint }[]>`
      SELECT n."inspectionType" AS "type", count(DISTINCT n."id") AS "visits"
        FROM "Invoice" i
        JOIN "Inspection" n ON n."id" = i."inspectionId"
       WHERE i."organizationId" = ${organizationId}::uuid
         AND i."origin" <> 'XERO'
         AND i."issuedOn" >= ${from}::date
         AND i."status" NOT IN ('DRAFT', 'VOIDED')
       GROUP BY 1`,
    prisma.$queryRaw<{ type: InspectionType; nameKey: string; visits: bigint }[]>`
      SELECT n."inspectionType" AS "type", lower(btrim(l."name")) AS "nameKey", count(DISTINCT n."id") AS "visits"
        FROM "Invoice" i
        JOIN "Inspection" n ON n."id" = i."inspectionId"
        JOIN "InvoiceLine" l ON l."invoiceId" = i."id"
       WHERE i."organizationId" = ${organizationId}::uuid
         -- The office's own billing, as Jobber and the console made it; not yet Xero's copies of it (2026-11-12).
         AND i."origin" <> 'XERO'
         AND i."issuedOn" >= ${from}::date
         AND i."status" NOT IN ('DRAFT', 'VOIDED')
       GROUP BY 1, 2`,
  ]);
  const of = new Map((totals as { type: InspectionType; visits: bigint }[]).map((row) => [row.type, Number(row.visits)]));
  const offered = new Map(basis.products.filter((product) => product.active).map((product) => [productNameKey(product.name), product]));
  // A type the office has a rule for already is the office's decision: nothing more is suggested for it.
  const decided = new Set(basis.rules.filter((rule) => rule.inspectionType && !rule.service).map((rule) => rule.inspectionType));
  return (billed as { type: InspectionType; nameKey: string; visits: bigint }[])
    .flatMap((row): SuggestedBillingRule[] => {
      const visits = of.get(row.type) ?? 0;
      const product = offered.get(row.nameKey);
      const seen = Number(row.visits);
      if (!product || decided.has(row.type) || visits < SUGGEST_MIN_VISITS || seen < visits * SUGGEST_SHARE) return [];
      return [{ inspectionType: row.type, productId: product.id, seen, of: visits }];
    })
    .sort((a, b) => b.of - a.of || b.seen - a.seen || a.inspectionType.localeCompare(b.inspectionType));
}

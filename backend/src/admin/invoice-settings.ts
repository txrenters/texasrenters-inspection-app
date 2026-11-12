import {
  EMPTY_INVOICE_SETTINGS,
  invoiceCompany,
  PAYMENT_TERMS,
  settingText,
  type BilledPrice,
  type InvoiceProductOrganisation,
  type InvoiceSettingsValues,
  type NewInvoiceDefaults,
  type ReceiptBrand,
} from '@texasrenters/shared';
import { InvoiceStatus, type Prisma } from '@prisma/client';

import { ApplicationError } from '../common/errors';
import type { PrismaService } from '../common/prisma.service';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { NOT_FROM_XERO } from './shown-invoices';

/**
 * What the office's invoice settings come to (2026-11-06, phase 6): the
 * company an invoice is from, what a new one starts with, and the prices its
 * lines are priced at. Each setting the office has filled in wins; a blank one
 * falls back to what the console used before it had settings -- the server's
 * REPORT_BRAND_* values, the latest invoice the office issued, Net 30, six
 * months of billing -- so nothing changes until somebody fills one in.
 *
 * Plain functions over the caller's database client, as the invoice number
 * and insert are, so the invoice services read them without depending on one
 * another. Database reads only: nothing here calls Jobber or anything billed.
 */

type Db = Prisma.TransactionClient;

/** Jobber's own subject for an invoice, until the office says otherwise. */
export const DEFAULT_SUBJECT = 'For Services Rendered';
export const DEFAULT_TERMS_DAYS = 30;

/** How far back the office's prices are read from its own invoices. */
const PRICE_WINDOW_DAYS = 180;
/** The most prices read from billing. */
const MAX_BILLED_PRICES = 50;

const DAY_MS = 86_400_000;

/** Who the company is when the office has said nothing: the same values that name it on an inspection report. */
export function receiptBrand(env: NodeJS.ProcessEnv = process.env): ReceiptBrand {
  return {
    name: env.REPORT_BRAND_NAME ?? 'TexasRenters.com',
    addressLine1: env.REPORT_BRAND_ADDRESS_LINE1 ?? null,
    addressLine2: env.REPORT_BRAND_ADDRESS_LINE2 ?? null,
    phone: env.REPORT_BRAND_PHONE ?? null,
    email: env.REPORT_BRAND_EMAIL ?? null,
  };
}

/** The company as it prints: each detail the office filled in, else the server's. */
export function brandFrom(values: InvoiceSettingsValues | null, fallback: ReceiptBrand = receiptBrand()): ReceiptBrand {
  if (!values) return fallback;
  return {
    name: settingText(values.companyName) ?? fallback.name,
    addressLine1: settingText(values.addressLine1) ?? fallback.addressLine1,
    addressLine2: settingText(values.addressLine2) ?? fallback.addressLine2,
    phone: settingText(values.phone) ?? fallback.phone,
    email: settingText(values.email) ?? fallback.email,
  };
}

const SETTINGS_SELECT = {
  companyName: true,
  addressLine1: true,
  addressLine2: true,
  phone: true,
  email: true,
  defaultSubject: true,
  defaultTermsDays: true,
  defaultClientMessage: true,
  defaultContractDisclaimer: true,
  updatedAt: true,
} as const;

/** The office's settings as saved, and when; null fields when it has saved none. */
export async function readInvoiceSettings(db: Db, organizationId: string) {
  const row = await db.invoiceSettings.findUnique({ where: { organizationId }, select: SETTINGS_SELECT });
  if (!row) return { values: EMPTY_INVOICE_SETTINGS, updatedAt: null };
  const { updatedAt, ...values } = row;
  return { values: values as InvoiceSettingsValues, updatedAt };
}

/** Who the office's invoices, receipts and emails are from. */
export async function officeBrand(db: Db, organizationId: string): Promise<ReceiptBrand> {
  return brandFrom((await readInvoiceSettings(db, organizationId)).values);
}

/** What a new invoice starts with when the office has set nothing: the wording and terms of the latest invoice it issued. */
export async function fallbackDefaults(db: Db, organizationId: string): Promise<NewInvoiceDefaults> {
  const latest = await db.invoice.findFirst({
    where: { organizationId, ...NOT_FROM_XERO, issuedOn: { not: null } },
    orderBy: [{ issuedOn: 'desc' }, { createdAt: 'desc' }],
    select: { subject: true, clientMessage: true, paymentTermsDays: true, contractDisclaimer: true },
  });
  const terms = latest?.paymentTermsDays;
  return {
    subject: latest?.subject?.trim() || DEFAULT_SUBJECT,
    termsDays: PAYMENT_TERMS.some((option) => option.days === terms) ? terms! : DEFAULT_TERMS_DAYS,
    clientMessage: latest?.clientMessage ?? null,
    // Jobber puts its contract text on every invoice; a new one carries the same.
    contractDisclaimer: latest?.contractDisclaimer ?? null,
  };
}

/** Each setting the office filled in, else its fallback. */
export function defaultsFrom(values: InvoiceSettingsValues, fallback: NewInvoiceDefaults): NewInvoiceDefaults {
  return {
    subject: settingText(values.defaultSubject) ?? fallback.subject,
    termsDays: values.defaultTermsDays ?? fallback.termsDays,
    clientMessage: settingText(values.defaultClientMessage) ?? fallback.clientMessage,
    contractDisclaimer: settingText(values.defaultContractDisclaimer) ?? fallback.contractDisclaimer,
  };
}

/** What a new invoice starts with. */
export async function newInvoiceDefaults(db: Db, organizationId: string): Promise<NewInvoiceDefaults> {
  const [settings, fallback] = await Promise.all([readInvoiceSettings(db, organizationId), fallbackDefaults(db, organizationId)]);
  return defaultsFrom(settings.values, fallback);
}

/**
 * The office's price list, read from its own invoices: each product or service
 * billed in the past six months, at the price it was billed at most often, the
 * most billed first. Jobber's products list needs a scope of its own; what the
 * office actually charges is already in the copy.
 */
export function priceList(
  rows: readonly { name: string; unitPriceCents: number; _count: { _all: number } }[],
): { name: string; unitPriceCents: number }[] {
  const byName = new Map<string, { name: string; unitPriceCents: number; best: number; uses: number }>();
  for (const row of rows) {
    if (row.unitPriceCents <= 0 || !row.name.trim()) continue;
    const key = row.name.trim().toLowerCase();
    const count = row._count._all;
    const known = byName.get(key);
    if (!known) byName.set(key, { name: row.name.trim(), unitPriceCents: row.unitPriceCents, best: count, uses: count });
    else {
      known.uses += count;
      if (count > known.best) Object.assign(known, { unitPriceCents: row.unitPriceCents, best: count });
    }
  }
  return [...byName.values()]
    .sort((a, b) => b.uses - a.uses || a.name.localeCompare(b.name))
    .slice(0, MAX_BILLED_PRICES)
    .map(({ name, unitPriceCents }) => ({ name, unitPriceCents }));
}

/** What the office billed in the past six months, at the price billed most often. */
export async function billedPrices(db: Db, organizationId: string, today: string): Promise<BilledPrice[]> {
  const rows = await db.invoiceLine.groupBy({
    by: ['name', 'unitPriceCents'],
    where: {
      organizationId,
      invoice: {
        ...NOT_FROM_XERO,
        status: { notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOIDED] },
        issuedOn: { gte: new Date(new Date(`${today}T00:00:00.000Z`).getTime() - PRICE_WINDOW_DAYS * DAY_MS) },
      },
    },
    _count: { _all: true },
  });
  return priceList(rows);
}

/** The office's products and services, as saved; the active ones first, then by name. */
export function listedProducts(db: Db, organizationId: string) {
  return db.invoiceProduct.findMany({
    where: { organizationId },
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    select: { id: true, name: true, nameKey: true, description: true, unitPriceCents: true, active: true, xeroTenantId: true, updatedAt: true },
  });
}

/**
 * The prices a new invoice's lines are priced at: the office's own list, and
 * nothing else (2026-11-12) -- what was billed in Jobber no longer prices a
 * line. A product the office set aside is not offered.
 */
export async function officePrices(
  db: Db,
  organizationId: string,
): Promise<{ name: string; unitPriceCents: number; description?: string | null; xeroTenantId?: string | null }[]> {
  const listed = await listedProducts(db, organizationId);
  return listed
    .filter((product) => product.active)
    .map((product) => ({
      name: product.name,
      unitPriceCents: product.unitPriceCents,
      description: product.description,
      // The company's books it goes to (2026-11-10).
      xeroTenantId: product.xeroTenantId,
    }));
}

/**
 * Each product or service on the office's list and the company it goes to,
 * set aside or not (2026-11-10): what decides an invoice's company. A name
 * billed only in Jobber goes to none.
 */
export function productCompanies(db: Db, organizationId: string) {
  return db.invoiceProduct.findMany({ where: { organizationId }, select: { name: true, xeroTenantId: true } });
}

/**
 * A Jobber invoice's company (2026-11-11): the one its lines go to, as the
 * console's own -- none when they go to two, or to none. Once it is in a
 * company's books in Xero it stays that company's, whatever its lines say now.
 */
export async function jobberInvoiceCompany(
  db: Db,
  organizationId: string,
  invoiceId: string | null,
  lines: readonly { name: string }[],
): Promise<string | null> {
  if (invoiceId) {
    const sync = await db.xeroInvoiceSync.findUnique({ where: { invoiceId }, select: { xeroTenantId: true, xeroInvoiceId: true } });
    if (sync?.xeroInvoiceId) return sync.xeroTenantId;
  }
  return invoiceCompany(lines, await productCompanies(db, organizationId), undefined, () => '').xeroTenantId;
}

/**
 * Every Jobber invoice's company worked out again from its lines, after the
 * office changes which company a product goes to, or its name (2026-11-11).
 * One statement, as `jobberInvoiceCompany` decides it -- a line names a
 * product by `productNameKey` -- leaving alone the ones in Xero already.
 * Returns how many changed.
 */
export async function reassignJobberInvoiceCompanies(prisma: PrismaService, organizationId: string): Promise<number> {
  const [, changed] = await prisma.$transaction([
    // Raw SQL does not pass through the client's tenant scope: set it here, as it does.
    prisma.$executeRaw`select set_config('app.organization_id', ${organizationId}, true)`,
    prisma.$executeRaw`
      WITH wanted AS (
        SELECT i."id",
               CASE WHEN count(DISTINCT p."xeroTenantId") = 1 THEN min(p."xeroTenantId") END AS "xeroTenantId"
          FROM "Invoice" i
          LEFT JOIN "InvoiceLine" l ON l."invoiceId" = i."id"
          LEFT JOIN "InvoiceProduct" p
            ON p."organizationId" = i."organizationId"
           AND p."nameKey" = lower(btrim(l."name"))
           AND p."xeroTenantId" IS NOT NULL
         WHERE i."organizationId" = ${organizationId}::uuid
           AND i."origin" = 'JOBBER'
           AND NOT EXISTS (SELECT 1 FROM "XeroInvoiceSync" s WHERE s."invoiceId" = i."id" AND s."xeroInvoiceId" IS NOT NULL)
         GROUP BY i."id"
      )
      UPDATE "Invoice" i
         SET "xeroTenantId" = wanted."xeroTenantId"
        FROM wanted
       WHERE i."id" = wanted."id"
         AND i."xeroTenantId" IS DISTINCT FROM wanted."xeroTenantId"`,
  ]);
  return changed as number;
}

/** The office's Xero organisations, connected ones first, then by name: the companies' books its invoices go to (2026-11-10). */
export async function officeOrganisations(db: Db, organizationId: string): Promise<InvoiceProductOrganisation[]> {
  const rows = await db.xeroOrganisation.findMany({
    where: { organizationId },
    // CONNECTED sorts before REMOVED.
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
    select: { xeroTenantId: true, name: true, status: true },
  });
  return rows.map((row) => ({ tenantId: row.xeroTenantId, name: row.name, connected: row.status === 'CONNECTED' }));
}

/** An organisation's name for a message; one the office no longer has is said so. */
export const organisationName = (organisations: readonly InvoiceProductOrganisation[]) => (tenantId: string) =>
  organisations.find((organisation) => organisation.tenantId === tenantId)?.name ?? 'an organisation no longer known';

/**
 * The companies whose invoices go to their books in Xero now (2026-11-12): sending
 * is on and the organisation is connected. Their invoices made here are drafts
 * with no number of the console's -- Xero numbers them, and the office approves
 * them there.
 */
export async function xeroSendingCompanies(db: Pick<Db, 'xeroSettings'>, organizationId: string): Promise<Set<string>> {
  const rows = await db.xeroSettings.findMany({
    where: { organizationId, sendingEnabled: true, xeroOrganisation: { status: 'CONNECTED' } },
    select: { xeroTenantId: true },
  });
  return new Set(rows.map((row) => row.xeroTenantId));
}

/** When the console took invoicing over from Jobber (2026-11-06, phase 8); null while Jobber holds it. */
export async function invoicingTakenOverAt(db: Db, organizationId: string): Promise<Date | null> {
  const row = await db.invoiceSettings.findUnique({ where: { organizationId }, select: { invoicingTakenOverAt: true } });
  return row?.invoicingTakenOverAt ?? null;
}

/**
 * Whether the console makes and changes invoices and payments: once it took
 * invoicing over, or when the server is told so (`JOBBER_INVOICE_WRITES_ENABLED`,
 * for trying the writes out before the cutover). Until then Jobber holds them,
 * and a change here would be undone by the next read of Jobber's copy.
 */
export async function invoiceWritesOn(db: Db, organizationId: string): Promise<boolean> {
  return getJobberConfig().invoiceWritesEnabled || (await invoicingTakenOverAt(db, organizationId)) !== null;
}

/** The refusal while Jobber holds the invoices. */
export const invoiceWritesOff = () =>
  new ApplicationError(409, 'INVOICE_WRITES_OFF', 'Invoices and payments are made and changed in Jobber until the console takes over invoicing.');

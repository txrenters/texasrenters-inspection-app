import {
  templatesFrom,
  DEFAULT_INVOICE_EMAIL_SETTINGS,
  isEmailAddress,
  MAX_INVOICE_RECIPIENTS,
  sortedFollowUpDays,
  type InvoiceEmailSettings,
} from '@texasrenters/shared';
import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../common/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * The office's follow-up and receipt choices (2026-11-09). An office that has
 * saved nothing gets Jobber's: follow-ups on the due date and four days after,
 * receipts by hand.
 */
export async function readEmailSettings(db: Db, organizationId: string) {
  const row = await db.invoiceSettings.findUnique({
    where: { organizationId },
    select: { followUpsEnabled: true, followUpDays: true, receiptsAutomatic: true, emailSettingsUpdatedAt: true },
  });
  if (!row) return { values: { ...DEFAULT_INVOICE_EMAIL_SETTINGS }, updatedAt: null };
  const { emailSettingsUpdatedAt, ...values } = row;
  return {
    values: { ...values, followUpDays: sortedFollowUpDays(values.followUpDays) } as InvoiceEmailSettings,
    updatedAt: emailSettingsUpdatedAt,
  };
}

/**
 * The office's words for the invoice, receipt and statement emails over the
 * console's own (2026-11-10), and where a client's reply goes: the address it
 * chose, else the company email on the invoices, else nowhere in particular.
 */
export async function readEmailTemplates(db: Db, organizationId: string) {
  const row = await db.invoiceSettings.findUnique({
    where: { organizationId },
    select: { emailTemplates: true, replyToEmail: true, templatesUpdatedAt: true, email: true },
  });
  return {
    templates: templatesFrom(row?.emailTemplates ?? null),
    replyTo: row?.replyToEmail?.trim() || null,
    companyEmail: row?.email?.trim() || null,
    updatedAt: row?.templatesUpdatedAt ?? null,
  };
}

/** Where a reply to an invoice email goes. */
export async function replyToFor(db: Db, organizationId: string, brandEmail: string | null) {
  const { replyTo } = await readEmailTemplates(db, organizationId);
  return replyTo ?? brandEmail ?? null;
}

/**
 * Who an email about an invoice goes to by default: whoever the office last
 * sent the invoice to, else the client's own addresses from Jobber, primary
 * first. A few, and only real addresses.
 */
export function defaultRecipients(lastSent: readonly string[] | null | undefined, clientEmails: readonly string[]) {
  const source = lastSent?.length ? lastSent : clientEmails;
  const seen = new Set<string>();
  return source
    .map((address) => address.trim())
    .filter((address) => {
      const key = address.toLowerCase();
      if (!isEmailAddress(address) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_INVOICE_RECIPIENTS);
}

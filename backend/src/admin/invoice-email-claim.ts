import type { InvoiceDeliveryKind } from '@texasrenters/shared';
import { Prisma } from '@prisma/client';

import { businessDayBounds } from '../common/business-day';
import { ceilingFrom } from '../common/daily-allowance';
import { ApplicationError } from '../common/errors';
import type { PrismaService } from '../common/prisma.service';
import type { MailService } from '../mail/mail.service';

/**
 * Every email the console sends about an invoice -- the invoice itself, a
 * follow-up, a receipt -- goes through here, because each is a billed call to
 * the mail provider:
 *
 * - it is written down before it is sent, under a key, so the same press, the
 *   same day's run or a retry never sends it twice;
 * - the office sends at most `INVOICE_EMAIL_DAILY_CEILING` (200) a Texas day,
 *   counted from what it sent rather than held in memory, so a restart does
 *   not reset it;
 * - one email reaches one address.
 */

/** Emails one office sends a Texas day, at most. */
export const DEFAULT_INVOICE_EMAIL_CEILING = 200;

export interface InvoiceEmailClaim {
  organizationId: string;
  invoiceId: string;
  recipients: string[];
  message: string | null;
  kind: InvoiceDeliveryKind;
  followUpDay?: number | null;
  paymentId?: string | null;
  /** Null for one the console sent on its own. */
  sentById: string | null;
  clientRequestId: string;
}

/** The refusal once the day's emails are spent. */
export const isEmailCeiling = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'INVOICE_EMAIL_CEILING';

/**
 * Writes the email down, if the day has room for it, and answers its id; null
 * when the key was already used, by the same press or the same run.
 */
export async function claimInvoiceEmail(prisma: PrismaService, claim: InvoiceEmailClaim): Promise<string | null> {
  const ceiling = ceilingFrom('INVOICE_EMAIL_DAILY_CEILING', DEFAULT_INVOICE_EMAIL_CEILING);
  try {
    return await prisma.$transaction(async (tx) => {
      // Counted and claimed under one lock, so two sends at once cannot both fit under the ceiling.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-email:${claim.organizationId}`}, 0))::text AS locked`;
      const sent = await tx.invoiceDelivery.findMany({
        where: {
          organizationId: claim.organizationId,
          createdAt: { gte: businessDayBounds().start },
          status: { in: ['PENDING', 'SENT'] },
        },
        select: { recipients: true },
      });
      const used = sent.reduce((sum, delivery) => sum + delivery.recipients.length, 0);
      if (used + claim.recipients.length > ceiling)
        throw new ApplicationError(
          429,
          'INVOICE_EMAIL_CEILING',
          `The office has sent ${used} of its ${ceiling} invoice emails today. More can go tomorrow.`,
        );
      const delivery = await tx.invoiceDelivery.create({
        data: {
          organizationId: claim.organizationId,
          invoiceId: claim.invoiceId,
          channel: 'EMAIL',
          kind: claim.kind,
          followUpDay: claim.followUpDay ?? null,
          paymentId: claim.paymentId ?? null,
          recipients: claim.recipients,
          message: claim.message,
          status: 'PENDING',
          sentById: claim.sentById,
          clientRequestId: claim.clientRequestId,
        },
        select: { id: true },
      });
      return delivery.id;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return null;
    throw error;
  }
}

/**
 * Sends a claimed email, one to each address, outside any transaction so
 * nothing waits on a lock while the provider answers, and records how it went.
 */
export async function sendClaimedEmail(
  prisma: PrismaService,
  mail: MailService,
  deliveryId: string,
  to: readonly string[],
  email: { subject: string; title: string; html: string },
): Promise<{ status: 'SENT' | 'FAILED'; failure: string | null; failed: number }> {
  const failed: string[] = [];
  let reason: string | null = null;
  for (const address of to) {
    const result = await mail.sendInvoice({ to: address, ...email });
    if (result.status !== 'SENT') {
      failed.push(address);
      reason = result.status === 'NOT_CONFIGURED' ? 'Email is not set up for the console yet.' : 'The mail provider did not take it.';
    }
  }
  const status = failed.length === to.length ? 'FAILED' : 'SENT';
  const failure = failed.length ? `${reason} Not sent to ${failed.join(', ')}.` : null;
  await prisma.invoiceDelivery.update({
    where: { id: deliveryId },
    data: { status, failure, sentAt: status === 'SENT' ? new Date() : null },
  });
  return { status, failure, failed: failed.length };
}

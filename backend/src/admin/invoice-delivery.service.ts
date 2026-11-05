import { Inject, Injectable, Logger } from '@nestjs/common';
import { recipientsProblem, type InvoiceDetail, type SendInvoiceInput } from '@texasrenters/shared';
import { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDayBounds } from '../common/business-day';
import { ceilingFrom } from '../common/daily-allowance';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { getJobberConfig } from '../integrations/jobber/jobber.config';
import { MailService } from '../mail/mail.service';
import { invoiceEmail } from './invoice-email';
import { InvoicesService, receiptBrand } from './invoices.service';

/**
 * Sending an invoice to the client by email (2026-11-06, phase 5 of taking
 * invoicing over from Jobber).
 *
 * Every email is a billed call to the mail provider, so:
 * - one happens only when somebody presses Send, never from a page load, a
 *   poll or a loop;
 * - one send reaches at most five people, one email each;
 * - the office sends at most `INVOICE_EMAIL_DAILY_CEILING` (200) a Texas
 *   day, counted from what it sent rather than held in memory, so a restart
 *   does not reset it;
 * - the delivery is written before anything is sent, keyed by the browser, so
 *   a double click or a resend sends nothing twice.
 *
 * Off until the cutover, as every invoice write is: until then the office
 * sends from Jobber. A draft is marked sent first; a voided invoice is not sent.
 */

/** Emails one office sends a Texas day, at most. */
export const DEFAULT_INVOICE_EMAIL_CEILING = 200;

@Injectable()
export class InvoiceDeliveryService {
  private readonly logger = new Logger(InvoiceDeliveryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async send(user: AuthenticatedUser, invoiceId: string, input: SendInvoiceInput): Promise<InvoiceDetail> {
    if (!getJobberConfig().invoiceWritesEnabled)
      throw new ApplicationError(
        409,
        'INVOICE_WRITES_OFF',
        'Invoices and payments are made and changed in Jobber until the console takes over invoicing.',
      );
    const problem = recipientsProblem(input.to);
    if (problem) throw new ApplicationError(422, 'INVOICE_SEND_INVALID', problem);
    const to = input.to.map((address) => address.trim()).filter(Boolean);
    const message = input.message?.trim() || null;

    const prior = await this.byKey(user, input.clientRequestId);
    if (prior) return this.answerResend(user, prior, invoiceId);

    const invoice = await this.invoices.one(user, invoiceId);
    if (invoice.status === 'DRAFT') throw new ApplicationError(409, 'INVOICE_NOT_SENDABLE', 'Mark the draft sent before it is emailed.');
    if (invoice.status === 'VOIDED') throw new ApplicationError(409, 'INVOICE_NOT_SENDABLE', 'A voided invoice is not sent.');

    const ceiling = ceilingFrom('INVOICE_EMAIL_DAILY_CEILING', DEFAULT_INVOICE_EMAIL_CEILING);
    let deliveryId: string;
    try {
      deliveryId = await this.prisma.$transaction(async (tx) => {
        // Counted and claimed under one lock, so two sends at once cannot both fit under the ceiling.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-email:${user.organizationId}`}, 0))::text AS locked`;
        const sent = await tx.invoiceDelivery.findMany({
          where: {
            organizationId: user.organizationId,
            createdAt: { gte: businessDayBounds().start },
            status: { in: ['PENDING', 'SENT'] },
          },
          select: { recipients: true },
        });
        const used = sent.reduce((sum, delivery) => sum + delivery.recipients.length, 0);
        if (used + to.length > ceiling)
          throw new ApplicationError(
            429,
            'INVOICE_EMAIL_CEILING',
            `The office has sent ${used} of its ${ceiling} invoice emails today. More can go tomorrow.`,
          );
        const delivery = await tx.invoiceDelivery.create({
          data: {
            organizationId: user.organizationId,
            invoiceId,
            channel: 'EMAIL',
            recipients: to,
            message,
            status: 'PENDING',
            sentById: user.id,
            clientRequestId: input.clientRequestId,
          },
          select: { id: true },
        });
        return delivery.id;
      });
    } catch (error) {
      // The same press, sent twice at once: the other request is sending it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const other = await this.byKey(user, input.clientRequestId);
        if (other) return this.answerResend(user, other, invoiceId);
      }
      throw error;
    }

    // Outside the transaction: nothing waits on a lock while the provider answers.
    const email = invoiceEmail(invoice, invoice.brand ?? receiptBrand(), message);
    const failed: string[] = [];
    let reason: string | null = null;
    for (const address of to) {
      const result = await this.mail.sendInvoice({ to: address, ...email });
      if (result.status !== 'SENT') {
        failed.push(address);
        reason = result.status === 'NOT_CONFIGURED' ? 'Email is not set up for the console yet.' : 'The mail provider did not take it.';
      }
    }
    const status = failed.length === to.length ? 'FAILED' : 'SENT';
    const failure = failed.length ? `${reason} Not sent to ${failed.join(', ')}.` : null;
    await this.prisma.invoiceDelivery.update({
      where: { id: deliveryId },
      data: { status, failure, sentAt: status === 'SENT' ? new Date() : null },
    });
    await this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'INVOICE_SENT',
        entityType: 'Invoice',
        entityId: invoiceId,
        metadata: { deliveryId, channel: 'EMAIL', to, status, ...(failure ? { failure } : {}) },
      },
    });
    if (failed.length) this.logger.warn({ event: 'invoice_email_not_sent', invoiceId, failed: failed.length, of: to.length });
    if (status === 'FAILED') throw new ApplicationError(502, 'INVOICE_EMAIL_FAILED', failure ?? 'The invoice was not sent.');
    return this.invoices.one(user, invoiceId);
  }

  private byKey(user: AuthenticatedUser, clientRequestId: string) {
    return this.prisma.invoiceDelivery.findFirst({
      where: { organizationId: user.organizationId, clientRequestId },
      select: { invoiceId: true, status: true, failure: true },
    });
  }

  /**
   * A resend of the same press gets the answer the press got: the invoice when
   * it went or is going, the same failure when it did not -- never a second
   * email. The same key for another invoice is a mistake.
   */
  private answerResend(user: AuthenticatedUser, prior: { invoiceId: string; status: string; failure: string | null }, invoiceId: string) {
    if (prior.invoiceId !== invoiceId)
      throw new ApplicationError(409, 'IDEMPOTENCY_KEY_REUSED', 'That request key was already used for something else.');
    if (prior.status === 'FAILED') throw new ApplicationError(502, 'INVOICE_EMAIL_FAILED', prior.failure ?? 'The invoice was not sent.');
    return this.invoices.one(user, invoiceId);
  }
}

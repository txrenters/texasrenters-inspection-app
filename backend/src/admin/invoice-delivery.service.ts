import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  daysBetween,
  invoiceStatusOn,
  MAX_BATCH_DELIVERY,
  recipientsProblem,
  type DeliverableInvoice,
  type DeliverableQuery,
  type DeliverInvoicesInput,
  type DeliverInvoicesResult,
  type InvoiceDetail,
  type PaymentDetail,
  type SendInvoiceInput,
  type SendReceiptInput,
  MAX_ATTACHED_PDF_BYTES,
  fillTemplate,
  invoiceTemplateValues,
  type InvoiceEmailAttachment,
} from '@texasrenters/shared';
import { InvoiceStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
import { claimInvoiceEmail, isEmailCeiling, sendClaimedEmail } from './invoice-email-claim';
import { defaultRecipients, readEmailSettings, readEmailTemplates } from './invoice-email-settings';
import { invoiceEmail } from './invoice-email';
import { receiptEmail } from './invoice-reminder-email';
import { InvoicesService, receiptBrand } from './invoices.service';
import { invoiceWritesOff, invoiceWritesOn } from './invoice-settings';

export { DEFAULT_INVOICE_EMAIL_CEILING } from './invoice-email-claim';

/**
 * Emailing the client about an invoice: the invoice itself (2026-11-06, phase 5
 * of taking invoicing over from Jobber), its receipt, and many invoices at once
 * (2026-11-09, phase 1 of the invoice gap review).
 *
 * Every email is a billed call to the mail provider, so one happens only when
 * somebody presses a button -- or, for a receipt, records a payment with
 * automatic receipts on -- never from a page load, a poll or a loop. Each is
 * claimed under a key and the office's daily ceiling (`invoice-email-claim`).
 *
 * Off until the cutover, as every invoice write is: until then the office
 * sends from Jobber. A draft is marked sent first; a voided invoice is not sent.
 */

/** The longest stretch Batch Deliver lists at once, as Batch create does. */
const MAX_DELIVERABLE_DAYS = 92;
const MAX_DELIVERABLE_ROWS = 200;

const isoDay = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

/**
 * The invoice's PDF as the browser made it (2026-11-10): checked to be a PDF,
 * and small -- an invoice has no images -- before it rides on the email.
 */
export function attachedPdf(input: InvoiceEmailAttachment) {
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length > MAX_ATTACHED_PDF_BYTES)
    throw new ApplicationError(422, 'INVOICE_SEND_INVALID', 'The PDF is too large to attach. Send it without.');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ApplicationError(422, 'INVOICE_SEND_INVALID', 'The attachment is not a PDF.');
  const stem =
    input.fileName
      .replace(/\.pdf$/i, '')
      .replace(/[^\w .,()#&'-]+/g, ' ')
      .replace(/\.{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+/, '')
      .trim()
      .slice(0, 100) || 'Invoice';
  return { name: `${stem}.pdf`, contentType: 'application/pdf', contentBase64: bytes.toString('base64') };
}

@Injectable()
export class InvoiceDeliveryService {
  private readonly logger = new Logger(InvoiceDeliveryService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async send(user: AuthenticatedUser, invoiceId: string, input: SendInvoiceInput): Promise<InvoiceDetail> {
    if (!(await invoiceWritesOn(this.prisma, user.organizationId))) throw invoiceWritesOff();
    const problem = recipientsProblem(input.to);
    if (problem) throw new ApplicationError(422, 'INVOICE_SEND_INVALID', problem);
    const to = input.to.map((address) => address.trim()).filter(Boolean);
    const attachment = input.attachment ? attachedPdf(input.attachment) : null;

    const prior = await this.byKey(user, input.clientRequestId);
    if (prior) return this.answerResend(user, prior, invoiceId);

    const invoice = await this.invoices.one(user, invoiceId);
    if (invoice.status === 'DRAFT') throw new ApplicationError(409, 'INVOICE_NOT_SENDABLE', 'Mark the draft sent before it is emailed.');
    if (invoice.status === 'VOIDED') throw new ApplicationError(409, 'INVOICE_NOT_SENDABLE', 'A voided invoice is not sent.');
    // The office's words (2026-11-10): the note somebody wrote on the press, else the template's -- a
    // Batch Deliver writes none. An empty note is somebody choosing none.
    const brand = invoice.brand ?? receiptBrand();
    const words = await readEmailTemplates(this.prisma, user.organizationId);
    const values = invoiceTemplateValues(invoice, brand.name);
    const message =
      input.message === undefined || input.message === null
        ? fillTemplate(words.templates.invoice.message, values).trim() || null
        : input.message.trim() || null;
    const replyTo = words.replyTo ?? brand.email ?? null;

    const deliveryId = await claimInvoiceEmail(this.prisma, {
      organizationId: user.organizationId,
      invoiceId,
      recipients: to,
      message,
      kind: 'INVOICE',
      sentById: user.id,
      clientRequestId: input.clientRequestId,
    });
    // The same press, sent twice at once: the other request is sending it.
    if (!deliveryId) return this.answerResend(user, await this.byKey(user, input.clientRequestId), invoiceId);

    const result = await sendClaimedEmail(
      this.prisma,
      this.mail,
      deliveryId,
      to,
      {
        ...invoiceEmail(invoice, brand, message, fillTemplate(words.templates.invoice.subject, values)),
        replyTo,
        ...(attachment ? { attachments: [attachment] } : {}),
      },
    );
    await this.audit(user, 'INVOICE_SENT', invoiceId, { deliveryId, channel: 'EMAIL', to, status: result.status, ...(result.failure ? { failure: result.failure } : {}) });
    if (result.failed) this.logger.warn({ event: 'invoice_email_not_sent', invoiceId, failed: result.failed, of: to.length });
    if (result.status === 'FAILED') throw new ApplicationError(502, 'INVOICE_EMAIL_FAILED', result.failure ?? 'The invoice was not sent.');
    return this.invoices.one(user, invoiceId);
  }

  /** A payment's receipt, emailed by somebody pressing Send receipt. */
  async sendReceipt(user: AuthenticatedUser, paymentId: string, input: SendReceiptInput): Promise<PaymentDetail> {
    if (!(await invoiceWritesOn(this.prisma, user.organizationId))) throw invoiceWritesOff();
    const problem = recipientsProblem(input.to);
    if (problem) throw new ApplicationError(422, 'RECEIPT_SEND_INVALID', problem);
    const to = input.to.map((address) => address.trim()).filter(Boolean);

    const prior = await this.byKey(user, input.clientRequestId);
    if (prior) return this.answerReceiptResend(user, prior, paymentId);

    const payment = await this.invoices.onePayment(user, paymentId);
    const deliveryId = await claimInvoiceEmail(this.prisma, {
      organizationId: user.organizationId,
      invoiceId: payment.invoice.id,
      recipients: to,
      message: null,
      kind: 'RECEIPT',
      paymentId,
      sentById: user.id,
      clientRequestId: input.clientRequestId,
    });
    if (!deliveryId) return this.answerReceiptResend(user, await this.byKey(user, input.clientRequestId), paymentId);

    const result = await sendClaimedEmail(this.prisma, this.mail, deliveryId, to, await this.receipt(user, payment));
    await this.audit(user, 'PAYMENT_RECEIPT_SENT', payment.invoice.id, { deliveryId, paymentId, to, status: result.status, ...(result.failure ? { failure: result.failure } : {}) });
    if (result.status === 'FAILED') throw new ApplicationError(502, 'RECEIPT_EMAIL_FAILED', result.failure ?? 'The receipt was not sent.');
    return this.invoices.onePayment(user, paymentId);
  }

  /**
   * The receipt for a payment just recorded here, when the office emails them
   * by themselves (Jobber's "automatic receipts"). Never throws: the payment
   * stands whatever the email does, and a receipt can still be sent by hand.
   */
  async receiptAfterPayment(user: AuthenticatedUser, invoiceId: string, clientRequestId: string): Promise<void> {
    try {
      if (!(await readEmailSettings(this.prisma, user.organizationId)).values.receiptsAutomatic) return;
      const recorded = await this.prisma.invoicePayment.findFirst({
        where: { organizationId: user.organizationId, invoiceId, clientRequestId },
        select: { id: true },
      });
      if (!recorded) return;
      const payment = await this.invoices.onePayment(user, recorded.id);
      const to = payment.receiptTo ?? [];
      if (!to.length) return;
      // One automatic receipt a payment, however often the press is repeated.
      const deliveryId = await claimInvoiceEmail(this.prisma, {
        organizationId: user.organizationId,
        invoiceId,
        recipients: to,
        message: null,
        kind: 'RECEIPT',
        paymentId: recorded.id,
        sentById: user.id,
        clientRequestId: `receipt:${recorded.id}`,
      });
      if (!deliveryId) return;
      const result = await sendClaimedEmail(this.prisma, this.mail, deliveryId, to, await this.receipt(user, payment));
      await this.audit(user, 'PAYMENT_RECEIPT_SENT', invoiceId, { deliveryId, paymentId: recorded.id, to, status: result.status, automatic: true, ...(result.failure ? { failure: result.failure } : {}) });
    } catch (error) {
      this.logger.warn({ event: 'automatic_receipt_not_sent', invoiceId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * What Batch Deliver offers: invoices awaiting payment, issued in the days
   * asked for, that nobody has emailed yet, with who each would go to.
   */
  async deliverable(user: AuthenticatedUser, query: DeliverableQuery): Promise<DeliverableInvoice[]> {
    const span = daysBetween(query.from, query.to);
    if (span < 0) throw new ApplicationError(422, 'DELIVERABLE_RANGE_INVALID', 'The first day comes after the last.');
    if (span > MAX_DELIVERABLE_DAYS)
      throw new ApplicationError(422, 'DELIVERABLE_RANGE_INVALID', `Choose at most ${MAX_DELIVERABLE_DAYS} days at a time.`);
    const rows = await this.prisma.invoice.findMany({
      where: {
        organizationId: user.organizationId,
        status: InvoiceStatus.AWAITING_PAYMENT,
        balanceCents: { gt: 0 },
        issuedOn: { gte: new Date(`${query.from}T00:00:00.000Z`), lte: new Date(`${query.to}T00:00:00.000Z`) },
        deliveries: { none: { kind: 'INVOICE', status: 'SENT' } },
      },
      orderBy: [{ issuedOn: 'asc' }, { number: 'asc' }],
      take: MAX_DELIVERABLE_ROWS,
      select: {
        id: true,
        number: true,
        clientName: true,
        status: true,
        issuedOn: true,
        dueOn: true,
        totalCents: true,
        balanceCents: true,
        clientEmails: true,
      },
    });
    const today = businessDate();
    return rows.map((row) => ({
      id: row.id,
      number: row.number,
      clientName: row.clientName,
      status: invoiceStatusOn(row.status, isoDay(row.dueOn), today),
      issuedOn: isoDay(row.issuedOn),
      dueOn: isoDay(row.dueOn),
      totalCents: row.totalCents,
      balanceCents: row.balanceCents,
      to: defaultRecipients(null, row.clientEmails),
    }));
  }

  /**
   * Batch Deliver: each invoice emailed as Send emails it, one after another,
   * each under its own key within the press's, so pressing again sends nothing
   * twice. Stops at the day's ceiling, saying so for the rest.
   */
  async deliverMany(user: AuthenticatedUser, input: DeliverInvoicesInput): Promise<DeliverInvoicesResult> {
    if (!(await invoiceWritesOn(this.prisma, user.organizationId))) throw invoiceWritesOff();
    if (!input.invoices.length) throw new ApplicationError(422, 'DELIVERY_EMPTY', 'Choose the invoices to send.');
    if (input.invoices.length > MAX_BATCH_DELIVERY)
      throw new ApplicationError(422, 'DELIVERY_TOO_MANY', `Send at most ${MAX_BATCH_DELIVERY} invoices at a time.`);
    if (new Set(input.invoices.map((item) => item.invoiceId)).size !== input.invoices.length)
      throw new ApplicationError(422, 'DELIVERY_REPEATED', 'An invoice is listed twice.');

    const results: DeliverInvoicesResult['results'] = [];
    for (const [index, item] of input.invoices.entries()) {
      try {
        await this.send(user, item.invoiceId, {
          to: item.to,
          message: input.message ?? null,
          clientRequestId: `${input.batchKey}:${item.invoiceId}`,
        });
        results.push({ invoiceId: item.invoiceId, status: 'SENT', problem: null });
      } catch (error) {
        const problem = error instanceof ApplicationError ? error.message : 'It was not sent.';
        results.push({ invoiceId: item.invoiceId, status: 'FAILED', problem });
        if (isEmailCeiling(error)) {
          for (const rest of input.invoices.slice(index + 1)) results.push({ invoiceId: rest.invoiceId, status: 'FAILED', problem });
          break;
        }
      }
    }
    return { results };
  }

  private byKey(user: AuthenticatedUser, clientRequestId: string) {
    return this.prisma.invoiceDelivery.findFirst({
      where: { organizationId: user.organizationId, clientRequestId },
      select: { invoiceId: true, paymentId: true, status: true, failure: true },
    });
  }

  /**
   * A resend of the same press gets the answer the press got: the invoice when
   * it went or is going, the same failure when it did not -- never a second
   * email. The same key for another invoice is a mistake.
   */
  /** A receipt in the office's words, replies going where it said. */
  private async receipt(user: AuthenticatedUser, payment: PaymentDetail) {
    const words = await readEmailTemplates(this.prisma, user.organizationId);
    return { ...receiptEmail(payment, payment.brand, words.templates.receipt), replyTo: words.replyTo ?? payment.brand.email ?? null };
  }

  private answerResend(user: AuthenticatedUser, prior: { invoiceId: string | null; status: string; failure: string | null } | null, invoiceId: string) {
    if (!prior || prior.invoiceId !== invoiceId)
      throw new ApplicationError(409, 'IDEMPOTENCY_KEY_REUSED', 'That request key was already used for something else.');
    if (prior.status === 'FAILED') throw new ApplicationError(502, 'INVOICE_EMAIL_FAILED', prior.failure ?? 'The invoice was not sent.');
    return this.invoices.one(user, invoiceId);
  }

  private answerReceiptResend(
    user: AuthenticatedUser,
    prior: { paymentId: string | null; status: string; failure: string | null } | null,
    paymentId: string,
  ) {
    if (!prior || prior.paymentId !== paymentId)
      throw new ApplicationError(409, 'IDEMPOTENCY_KEY_REUSED', 'That request key was already used for something else.');
    if (prior.status === 'FAILED') throw new ApplicationError(502, 'RECEIPT_EMAIL_FAILED', prior.failure ?? 'The receipt was not sent.');
    return this.invoices.onePayment(user, paymentId);
  }

  private audit(user: AuthenticatedUser, action: string, invoiceId: string, metadata: Record<string, unknown>) {
    return this.prisma.auditLog.create({
      data: {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action,
        entityType: 'Invoice',
        entityId: invoiceId,
        metadata: metadata as object,
      },
    });
  }
}

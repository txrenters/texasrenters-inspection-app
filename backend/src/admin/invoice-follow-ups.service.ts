import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  followUpDaysProblem,
  followUpDueToday,
  sortedFollowUpDays,
  type InvoiceEmailSettingsView,
  type SaveInvoiceEmailSettingsInput,
} from '@texasrenters/shared';
import { InvoiceStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { MailService } from '../mail/mail.service';
import { claimInvoiceEmail, isEmailCeiling, sendClaimedEmail } from './invoice-email-claim';
import { defaultRecipients, readEmailSettings, readEmailTemplates } from './invoice-email-settings';
import { followUpEmail } from './invoice-reminder-email';
import { InvoicesService, receiptBrand } from './invoices.service';
import { invoiceWritesOn } from './invoice-settings';
import { readCompanies, shownInvoices } from './shown-invoices';

/** The most follow-ups one run sends, whatever the ceiling allows: a bad day's data must not empty it. */
const MAX_FOLLOW_UPS_A_RUN = 150;

export interface FollowUpRun {
  skipped: 'NOT_TAKEN_OVER' | 'OFF' | null;
  sent: number;
  failed: number;
  /** Already sent today, by an earlier run. */
  already: number;
  /** Owed one, but with no address to send it to. */
  noAddress: number;
  /** Owed one, but the day's emails were spent. */
  overCeiling: number;
}

const toDate = (day: string) => new Date(`${day}T00:00:00.000Z`);
const isoDay = (value: Date) => value.toISOString().slice(0, 10);
const daysBefore = (day: string, days: number) => isoDay(new Date(toDate(day).getTime() - days * 86_400_000));

/**
 * Jobber's invoice follow-ups, sent by the console once it owns invoicing
 * (2026-11-09): "Follow-up with clients on the day invoices are due" and "4
 * days after", both at 1:30 PM, both only while the invoice is awaiting
 * payment.
 *
 * Nothing is sent before Take over: until then Jobber sends its own, and the
 * client would get two. After it, Jobber's own automations still run on the
 * copies left in Jobber -- which nobody marks paid any more -- so they must be
 * switched off in Jobber; the settings page says so.
 *
 * Each follow-up is one email to each address, claimed under a key naming the
 * invoice, its due date and the day, so a second run the same day, a restart
 * or a second server sends nothing twice, and a new due date is a new
 * follow-up. All of it within the office's daily invoice email ceiling.
 */
@Injectable()
export class InvoiceFollowUpsService {
  private readonly logger = new Logger(InvoiceFollowUpsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
    @Inject(MailService) private readonly mail: MailService,
  ) {}

  async settings(user: AuthenticatedUser): Promise<InvoiceEmailSettingsView> {
    const [settings, takenOver] = await Promise.all([
      readEmailSettings(this.prisma, user.organizationId),
      invoiceWritesOn(this.prisma, user.organizationId),
    ]);
    return { ...settings.values, takenOver, updatedAt: settings.updatedAt?.toISOString() ?? null };
  }

  async saveSettings(user: AuthenticatedUser, input: SaveInvoiceEmailSettingsInput): Promise<InvoiceEmailSettingsView> {
    const problem = followUpDaysProblem(input.followUpDays);
    if (problem) throw new ApplicationError(422, 'INVOICE_EMAIL_SETTINGS_INVALID', problem);
    const values = {
      followUpsEnabled: input.followUpsEnabled,
      followUpDays: sortedFollowUpDays(input.followUpDays),
      receiptsAutomatic: input.receiptsAutomatic,
    };
    const org = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const before = await readEmailSettings(tx, org);
      const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt).toISOString() : null;
      if ((before.updatedAt?.toISOString() ?? null) !== expected)
        throw new ApplicationError(409, 'INVOICE_SETTINGS_CHANGED', 'Somebody else changed these first. Look again before saving.');
      const changes = [
        before.values.followUpsEnabled !== values.followUpsEnabled
          ? `Follow-ups: ${before.values.followUpsEnabled ? 'on' : 'off'} → ${values.followUpsEnabled ? 'on' : 'off'}`
          : null,
        before.values.followUpDays.join(',') !== values.followUpDays.join(',')
          ? `Follow-up days: ${before.values.followUpDays.join(', ') || 'none'} → ${values.followUpDays.join(', ') || 'none'}`
          : null,
        before.values.receiptsAutomatic !== values.receiptsAutomatic
          ? `Receipts: ${before.values.receiptsAutomatic ? 'automatic' : 'by hand'} → ${values.receiptsAutomatic ? 'automatic' : 'by hand'}`
          : null,
      ].filter((change): change is string => change !== null);
      if (!changes.length) return;
      const now = new Date();
      await tx.invoiceSettings.upsert({
        where: { organizationId: org },
        create: { organizationId: org, ...values, emailSettingsUpdatedAt: now },
        update: { ...values, emailSettingsUpdatedAt: now },
      });
      await tx.auditLog.create({
        data: {
          organizationId: org,
          actorUserId: user.id,
          action: 'INVOICE_EMAIL_SETTINGS_CHANGED',
          entityType: 'InvoiceSettings',
          entityId: org,
          metadata: { changes },
        },
      });
    });
    return this.settings(user);
  }

  /** Today's follow-ups for one office. Called inside its tenant by the scheduler. */
  async run(organizationId: string, today = businessDate()): Promise<FollowUpRun> {
    const run: FollowUpRun = { skipped: null, sent: 0, failed: 0, already: 0, noAddress: 0, overCeiling: 0 };
    if (!(await invoiceWritesOn(this.prisma, organizationId))) return { ...run, skipped: 'NOT_TAKEN_OVER' };
    const settings = (await readEmailSettings(this.prisma, organizationId)).values;
    if (!settings.followUpsEnabled || !settings.followUpDays.length) return { ...run, skipped: 'OFF' };
    // Where a client's reply goes (2026-11-10). Follow-ups keep Jobber's own words.
    const { replyTo } = await readEmailTemplates(this.prisma, organizationId);

    const due = settings.followUpDays.map((days) => toDate(daysBefore(today, days)));
    // A company whose books are read from Xero (2026-11-12) has Xero send its reminders: none of its invoices here.
    const read = await readCompanies(this.prisma, organizationId);
    const owed = await this.prisma.invoice.findMany({
      where: {
        organizationId,
        ...shownInvoices(read, { outsideXeroBooks: true }),
        status: InvoiceStatus.AWAITING_PAYMENT,
        balanceCents: { gt: 0 },
        dueOn: { in: due },
      },
      orderBy: [{ dueOn: 'asc' }, { number: 'asc' }],
      take: MAX_FOLLOW_UPS_A_RUN,
      select: {
        id: true,
        status: true,
        balanceCents: true,
        dueOn: true,
        clientEmails: true,
        deliveries: {
          where: { kind: 'INVOICE', status: 'SENT' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { recipients: true },
        },
      },
    });

    // As the office, for reading each invoice: only its organization is used.
    const office = { organizationId } as AuthenticatedUser;
    for (const row of owed) {
      const dueOn = row.dueOn ? isoDay(row.dueOn) : null;
      const day = followUpDueToday({ status: row.status, balanceCents: row.balanceCents, dueOn }, today, settings.followUpDays);
      if (day === null) continue;
      const to = defaultRecipients(row.deliveries[0]?.recipients, row.clientEmails);
      if (!to.length) {
        run.noAddress += 1;
        continue;
      }
      let deliveryId: string | null;
      try {
        deliveryId = await claimInvoiceEmail(this.prisma, {
          organizationId,
          invoiceId: row.id,
          recipients: to,
          message: null,
          kind: 'FOLLOW_UP',
          followUpDay: day,
          sentById: null,
          clientRequestId: `follow-up:${row.id}:${dueOn}:${day}`,
        });
      } catch (error) {
        if (!isEmailCeiling(error)) throw error;
        run.overCeiling = owed.length - run.sent - run.failed - run.already - run.noAddress;
        break;
      }
      if (!deliveryId) {
        run.already += 1;
        continue;
      }
      const invoice = await this.invoices.one(office, row.id);
      const brand = invoice.brand ?? receiptBrand();
      const result = await sendClaimedEmail(this.prisma, this.mail, deliveryId, to, { ...followUpEmail(invoice, brand, day), replyTo: replyTo ?? brand.email ?? null });
      await this.prisma.auditLog.create({
        data: {
          organizationId,
          actorUserId: null,
          action: 'INVOICE_FOLLOW_UP_SENT',
          entityType: 'Invoice',
          entityId: row.id,
          metadata: { deliveryId, day, to, status: result.status, ...(result.failure ? { failure: result.failure } : {}) },
        },
      });
      if (result.status === 'SENT') run.sent += 1;
      else run.failed += 1;
    }
    this.logger.log({ event: 'invoice_follow_ups_run', organizationId, today, ...run });
    return run;
  }
}

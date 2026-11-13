import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  COULD_NOT_GET_IN_PREFIX,
  FINISHED_INSPECTION_STATUSES,
  MAX_INVOICES_PER_VISIT,
  daysBetween,
  type InvoiceAutoDraftsView,
  type SaveInvoiceAutoDraftsInput,
} from '@texasrenters/shared';
import { Prisma, type InspectionStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { batchLines, visitSelect } from './invoice-batch.service';
import { billingBasis } from './invoice-billing-rules';
import { makeInvoices, visitParts } from './invoice-maker';
import { newInvoiceDefaults, productCompanies } from './invoice-settings';
import { invoicingState } from './invoicing-state';

/** Visits drafted in one run at most; the rest wait ten minutes for the next. */
export const MAX_AUTO_DRAFTS_PER_RUN = 50;
/** Visits looked at in one run: a visit no rule covers stays a candidate, so more are read than drafted. */
const CANDIDATES_PER_RUN = 200;
/** How far back a visit's booked day may be: one finished long after its day is still drafted, within reason. */
const LOOKBACK_DAYS = 45;
/** What each automatic invoice's audit entry says made it. */
export const AUTO_DRAFT_BATCH = 'automatic';

const DAY_MS = 86_400_000;
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const day = (date: Date) => date.toISOString().slice(0, 10);
/** The last day of the month a day falls in, `YYYY-MM-DD`: when the New invoice makes one due. */
const monthEndOf = (value: string) => {
  const [year, month] = value.split('-').map(Number) as [number, number];
  return day(new Date(Date.UTC(year, month, 0)));
};

export interface AutoDraftRun {
  drafted: number;
  /** Visits left for the office: no rule covers them, or their invoice could not be made as it stands. */
  left: number;
}

/**
 * Draft invoices automatically (2026-11-13; the office: "as long as the jobs
 * are done ... we should automatically draft that too so accounting will only
 * double check them"). Once the office turns it on, each visit finished from
 * then -- ended by its technician, or completed by the office or in Jobber --
 * is invoiced by itself, as Create invoices would invoice it: by the office's
 * rules, one invoice per company, dated on the visit's day and due at the end
 * of that month, as the New invoice dates them. Each goes to its company's
 * books in Xero as a draft at the next sending run, for accounting to check
 * and approve there.
 *
 * Left for the office, with the reason on Create invoices: a visit no rule
 * covers, one whose company does not send to Xero, and one the technician
 * could not get into. Never a visit with an invoice of any origin, nor one
 * finished before the switch was turned on. Database work only: drafting calls
 * nothing billed, and what each draft then costs in Xero is what Create
 * invoices costs, under the sender's daily ceiling.
 */
@Injectable()
export class InvoiceAutoDraftsService {
  private readonly logger = new Logger(InvoiceAutoDraftsService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async view(user: AuthenticatedUser): Promise<InvoiceAutoDraftsView> {
    const row = await this.prisma.invoiceSettings.findUnique({
      where: { organizationId: user.organizationId },
      select: { autoDraftsFrom: true, autoDraftsUpdatedAt: true, invoicingTakenOverAt: true },
    });
    return {
      on: Boolean(row?.autoDraftsFrom),
      since: row?.autoDraftsFrom?.toISOString() ?? null,
      updatedAt: row?.autoDraftsUpdatedAt?.toISOString() ?? null,
      takenOver: Boolean(row?.invoicingTakenOverAt),
    };
  }

  /** On from this moment, or off; against the switch as it was read, so two people cannot both win. */
  async save(user: AuthenticatedUser, input: SaveInvoiceAutoDraftsInput): Promise<InvoiceAutoDraftsView> {
    const org = user.organizationId;
    const before = await this.view(user);
    if (before.updatedAt !== (input.expectedUpdatedAt ?? null))
      throw new ApplicationError(409, 'INVOICE_SETTINGS_CHANGED', 'Somebody changed this a moment ago. It shows their change now; make yours again.');
    if (before.on === input.on) return before;
    if (input.on && !before.takenOver)
      throw new ApplicationError(409, 'INVOICE_AUTO_DRAFTS_TOO_EARLY', 'The console does not make the invoices yet: take invoicing over first.');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      // Only as it was read: the row's stamp moves with every save.
      const stamp = before.updatedAt ? new Date(before.updatedAt) : null;
      const data = { autoDraftsFrom: input.on ? now : null, autoDraftsUpdatedAt: now };
      const changed = await tx.invoiceSettings.updateMany({ where: { organizationId: org, autoDraftsUpdatedAt: stamp }, data });
      if (!changed.count) {
        // No row yet: the office never saved its invoice settings.
        if (stamp) throw new ApplicationError(409, 'INVOICE_SETTINGS_CHANGED', 'Somebody changed this a moment ago. It shows their change now; make yours again.');
        await tx.invoiceSettings.create({ data: { organizationId: org, ...data } });
      }
      await tx.auditLog.create({
        data: {
          organizationId: org,
          actorUserId: user.id,
          action: 'INVOICE_AUTO_DRAFTS_CHANGED',
          entityType: 'InvoiceSettings',
          entityId: org,
          metadata: { changes: [`Draft invoices automatically: ${before.on ? 'on' : 'off'} → ${input.on ? 'on' : 'off'}`] },
        },
      });
    });
    return this.view(user);
  }

  /**
   * One run for one office: the visits finished since the switch went on that
   * have no invoice, oldest booked first, each drafted as one write. Nothing
   * when the switch is off or the console does not make the invoices.
   */
  async run(organizationId: string): Promise<AutoDraftRun> {
    const result: AutoDraftRun = { drafted: 0, left: 0 };
    const settings = await this.prisma.invoiceSettings.findUnique({ where: { organizationId }, select: { autoDraftsFrom: true } });
    const from = settings?.autoDraftsFrom;
    if (!from) return result;
    const state = await invoicingState(this.prisma, organizationId);
    if (!state.writesOn) return result;
    const today = businessDate();
    const earliest = new Date(dateOf(businessDate(from)).getTime() - LOOKBACK_DAYS * DAY_MS);

    const candidates = await this.prisma.inspection.findMany({
      where: {
        organizationId,
        status: { in: [...FINISHED_INSPECTION_STATUSES] as InspectionStatus[] },
        propertywareBuildingId: { not: null },
        scheduledAt: { gte: earliest },
        // Finished since the switch went on: ended by the technician, or completed by the office or in Jobber. A visit
        // brought in from an old report or Propertyware's documents carries its own old day, and is not.
        AND: [
          { OR: [{ submittedAt: { gte: from } }, { completedAt: { gte: from } }] },
          // Nothing to bill where the technician could not get in.
          { OR: [{ completionBlockedReason: null }, { NOT: { completionBlockedReason: { startsWith: COULD_NOT_GET_IN_PREFIX } } }] },
        ],
        // Never a visit that has, or had, an invoice of any origin: nothing is billed twice, and one voided is the
        // office's to bill again, by hand.
        invoices: { none: {} },
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      take: CANDIDATES_PER_RUN,
      select: visitSelect,
    });
    if (!candidates.length) return result;

    const [defaults, basis, companies] = await Promise.all([
      newInvoiceDefaults(this.prisma, organizationId),
      billingBasis(this.prisma, organizationId),
      productCompanies(this.prisma, organizationId),
    ]);
    // Nobody made these: the office's audit trail and the invoice's history say so, by naming no one.
    const office = { organizationId } as AuthenticatedUser;

    for (const visit of candidates) {
      if (result.drafted >= MAX_AUTO_DRAFTS_PER_RUN) break;
      const building = visit.propertywareBuilding!;
      const lines = batchLines(visit, basis);
      const { parts, problem } = visitParts(lines.lineItems, companies, state, today);
      if (lines.problem || problem || !parts.length) {
        result.left += 1;
        continue;
      }
      // Dated as the New invoice dates them: on the visit's day, due at the end of that month.
      const visitDay = day(visit.scheduledAt);
      const issuedOn = visitDay <= today ? visitDay : today;
      const dueOn = monthEndOf(issuedOn);
      const keys = Array.from({ length: MAX_INVOICES_PER_VISIT }, (_, index) => `auto:${visit.id}:${index + 1}`);
      try {
        const outcome = await this.prisma.$transaction(
          (tx) =>
            makeInvoices(tx, office, state, {
              inspectionId: visit.id,
              propertywareBuildingId: building.id,
              clientName: building.addressLine1 ?? building.name,
              jobberJobId: visit.jobberJobId,
              subject: defaults.subject,
              issuedOn,
              paymentTermsDays: daysBetween(issuedOn, dueOn),
              dueOn,
              xeroReference: building.addressLine1 ?? building.name,
              clientMessage: defaults.clientMessage,
              contractDisclaimer: defaults.contractDisclaimer,
              asDraft: false,
              additional: false,
              batchKey: AUTO_DRAFT_BATCH,
              invoices: parts.map((part, index) => ({ xeroTenantId: part.xeroTenantId, lines: part.lineItems, clientRequestId: keys[index]! })),
            }),
          { maxWait: 5_000, timeout: 20_000 },
        );
        if ('made' in outcome) result.drafted += 1;
        else result.left += 1;
      } catch (error) {
        // Drafted a moment ago by another server's run: its keys are taken.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') continue;
        throw error;
      }
    }
    if (result.drafted) this.logger.log({ event: 'invoice_auto_drafts_made', organizationId, drafted: result.drafted, left: result.left });
    return result;
  }
}

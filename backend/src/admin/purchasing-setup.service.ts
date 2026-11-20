import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  FILE_GROUP_KEYS,
  MOST_REQUISITION_QUOTES,
  approvalStepsProblem,
  defaultSeries,
  documentSeriesProblem,
  fileRulesProblem,
  type DocumentSeriesKind,
  type DocumentSeriesSetting,
  type PurchasingApprovals,
  type PurchasingSetup,
  type RequisitionFileRules,
  type SaveDocumentSeriesInput,
  type SavePurchasingApprovalsInput,
  type SaveRequisitionFileRulesInput,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { readDocumentSeries, readPurchasingSetup } from './purchasing-settings';

type Db = Prisma.TransactionClient;

/**
 * Purchasing Setup (2026-11-20, part 5a): read and changed by a system admin
 * or a Purchasing admin (`purchasing:setup`, which no API key may hold). Each
 * section is saved on its own, as the page saves as it goes; a save that
 * changes nothing writes nothing, and every change is audited with what it was
 * and what it became.
 */
@Injectable()
export class PurchasingSetupService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async read(user: AuthenticatedUser): Promise<PurchasingSetup> {
    const organizationId = user.organizationId;
    const [setup, numbers] = await Promise.all([readPurchasingSetup(this.prisma, organizationId), readDocumentSeries(this.prisma, organizationId)]);
    return { approvals: setup.approvals, numbers, files: setup.settings.files };
  }

  /** The steps, replaced whole, and the two switches beside them. */
  async saveApprovals(user: AuthenticatedUser, input: SavePurchasingApprovalsInput): Promise<PurchasingSetup> {
    const problem = approvalStepsProblem(input.steps, MOST_REQUISITION_QUOTES);
    if (problem) throw new ApplicationError(400, 'PURCHASING_STEPS_INVALID', problem);
    const organizationId = user.organizationId;
    const to: PurchasingApprovals = {
      steps: input.steps.map((step) => ({ upToCents: step.upToCents, approver: step.approver, quotesNeeded: step.quotesNeeded, reminderDays: step.reminderDays })),
      approverOwnCompaniesOnly: input.approverOwnCompaniesOnly,
      emailApprovers: input.emailApprovers,
      reapproveChangedOrders: input.reapproveChangedOrders,
    };
    await this.prisma.$transaction(async (tx) => {
      const before = (await readPurchasingSetup(tx, organizationId)).approvals;
      if (JSON.stringify(before) === JSON.stringify(to)) return;
      const switches = { approverOwnCompaniesOnly: to.approverOwnCompaniesOnly, emailApprovers: to.emailApprovers, reapproveChangedOrders: to.reapproveChangedOrders };
      await tx.purchasingSettings.upsert({ where: { organizationId }, create: { organizationId, ...switches }, update: switches });
      if (JSON.stringify(before.steps) !== JSON.stringify(to.steps)) {
        // Replaced whole: the tops are unique, so the old steps go first.
        await tx.purchasingApprovalStep.deleteMany({ where: { organizationId } });
        await tx.purchasingApprovalStep.createMany({ data: to.steps.map((step, position) => ({ organizationId, position, ...step })) });
      }
      await this.audit(tx, user, 'approvals', { ...before }, { ...to });
    });
    return this.read(user);
  }

  async saveFiles(user: AuthenticatedUser, input: SaveRequisitionFileRulesInput): Promise<PurchasingSetup> {
    const problem = fileRulesProblem(input);
    if (problem) throw new ApplicationError(400, 'PURCHASING_FILE_RULES_INVALID', problem);
    const organizationId = user.organizationId;
    // In the board's order, as they are read back, so an unchanged save compares equal.
    const to: RequisitionFileRules = { groups: FILE_GROUP_KEYS.filter((group) => input.groups.includes(group)), maxBytes: input.maxBytes, maxFiles: input.maxFiles, quoteFileAboveCents: input.quoteFileAboveCents, removal: input.removal };
    await this.prisma.$transaction(async (tx) => {
      const before = (await readPurchasingSetup(tx, organizationId)).settings.files;
      if (JSON.stringify(before) === JSON.stringify(to)) return;
      const data = { fileGroups: to.groups, fileMaxBytes: to.maxBytes, filesMax: to.maxFiles, quoteFileAboveCents: to.quoteFileAboveCents, fileRemoval: to.removal };
      await tx.purchasingSettings.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
      await this.audit(tx, user, 'files', { ...before }, { ...to });
    });
    return this.read(user);
  }

  /**
   * A series' prefix, digits and next number. The next number only goes up --
   * checked again under the row's lock, so a number given while the page was
   * open is never given twice.
   */
  async saveSeries(user: AuthenticatedUser, kind: DocumentSeriesKind, input: SaveDocumentSeriesInput): Promise<PurchasingSetup> {
    const organizationId = user.organizationId;
    const series = defaultSeries(kind);
    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<{ next: number; prefix: string | null; digits: number | null }[]>`
        SELECT "next", "prefix", "digits" FROM "DocumentSeries" WHERE "organizationId" = ${organizationId}::uuid AND "kind" = ${kind} FOR UPDATE`;
      const before: DocumentSeriesSetting = { kind, label: series.label, prefix: locked?.prefix ?? series.prefix, digits: locked?.digits ?? series.digits, next: locked ? Number(locked.next) : 1 };
      const problem = documentSeriesProblem(input, before.next);
      if (problem) throw new ApplicationError(409, 'PURCHASING_SERIES_INVALID', problem);
      if (before.prefix === input.prefix && before.digits === input.digits && before.next === input.next) return;
      await tx.documentSeries.upsert({
        where: { organizationId_kind: { organizationId, kind } },
        create: { organizationId, kind, next: input.next, prefix: input.prefix, digits: input.digits },
        update: { next: input.next, prefix: input.prefix, digits: input.digits },
      });
      await this.audit(tx, user, `numbers:${kind}`, { prefix: before.prefix, digits: before.digits, next: before.next }, { prefix: input.prefix, digits: input.digits, next: input.next });
    });
    return this.read(user);
  }

  /** What it was and what it became, whole. */
  private async audit(db: Db, user: AuthenticatedUser, section: string, from: object, to: object) {
    const metadata = JSON.parse(JSON.stringify({ section, from, to })) as Prisma.InputJsonObject;
    await db.auditLog.create({
      data: { organizationId: user.organizationId, ...auditActor(user), action: 'PURCHASING_SETUP_CHANGED', entityType: 'PurchasingSettings', entityId: user.organizationId, metadata },
    });
  }
}

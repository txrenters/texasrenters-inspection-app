import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  CODE_LISTS,
  FILE_GROUP_KEYS,
  MOST_REQUISITION_QUOTES,
  approvalStepsProblem,
  codeKeepersProblem,
  completePageLayout,
  defaultSeries,
  documentSeriesProblem,
  fileRulesProblem,
  pageLayoutProblem,
  type CodeKeepers,
  type CodeListKey,
  type DocumentSeriesKind,
  type DocumentSeriesSetting,
  type PurchasingApprovals,
  type PurchasingSetup,
  type RequisitionFileRules,
  type SaveCodeKeepersInput,
  type SaveDocumentSeriesInput,
  type SavePurchasingApprovalsInput,
  type SaveRequisitionFileRulesInput,
  type SaveRequisitionPageInput,
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
    const [setup, numbers, inUse] = await Promise.all([readPurchasingSetup(this.prisma, organizationId), readDocumentSeries(this.prisma, organizationId), this.inUse(organizationId)]);
    return {
      approvals: setup.approvals,
      numbers,
      files: setup.settings.files,
      codes: CODE_LISTS.map((list) => ({ list: list.key, keeper: setup.keepers[list.key], inUse: inUse[list.key] })),
      page: setup.settings.page,
    };
  }

  /** How many of each list are in use, for the Codes section. */
  private async inUse(organizationId: string): Promise<Record<CodeListKey, number>> {
    const [items, categories, codes, places, vendors, purchasers] = await Promise.all([
      this.prisma.stockItem.count({ where: { organizationId, active: true } }),
      this.prisma.stockCategory.count({ where: { organizationId, active: true } }),
      this.prisma.purchasingCode.groupBy({ by: ['kind'], where: { organizationId, active: true }, _count: { _all: true } }),
      this.prisma.stockPlace.count({ where: { organizationId, active: true } }),
      this.prisma.vendor.count({ where: { organizationId, active: true } }),
      this.prisma.xeroOrganisation.count({ where: { organizationId, status: 'CONNECTED', purchaserCode: { not: null } } }),
    ]);
    const of = (kind: string) => codes.find((row) => row.kind === kind)?._count._all ?? 0;
    return {
      ITEMS: items,
      CATEGORIES: categories,
      LINE_TYPES: of('LINE_TYPE'),
      UNITS: of('UNIT'),
      REQUEST: of('REQUEST'),
      DEPARTMENT: of('DEPARTMENT'),
      COST_CENTER: of('COST_CENTER'),
      PLACES: places,
      VENDORS: vendors,
      PURCHASER_CODES: purchasers,
    };
  }

  /** Who keeps each code list: enforced everywhere in the console (part 5c, 2026-11-21). */
  async saveCodeKeepers(user: AuthenticatedUser, input: SaveCodeKeepersInput): Promise<PurchasingSetup> {
    const problem = codeKeepersProblem(input.keepers);
    if (problem) throw new ApplicationError(400, 'PURCHASING_KEEPERS_INVALID', problem);
    const organizationId = user.organizationId;
    const to = Object.fromEntries(CODE_LISTS.map((list) => [list.key, input.keepers[list.key]])) as CodeKeepers;
    await this.prisma.$transaction(async (tx) => {
      const before = (await readPurchasingSetup(tx, organizationId)).keepers;
      const changed = CODE_LISTS.filter((list) => before[list.key] !== to[list.key]).map((list) => list.key);
      if (!changed.length) return;
      await tx.purchasingSettings.upsert({ where: { organizationId }, create: { organizationId, codeKeepers: to }, update: { codeKeepers: to } });
      await this.audit(tx, user, 'codes', Object.fromEntries(changed.map((list) => [list, before[list]])), Object.fromEntries(changed.map((list) => [list, to[list]])));
    });
    return this.read(user);
  }

  /** The requisition page's fields -- shown, required -- and its FactBoxes, in order, and who sees each. */
  async saveRequisitionPage(user: AuthenticatedUser, input: SaveRequisitionPageInput): Promise<PurchasingSetup> {
    const problem = pageLayoutProblem(input);
    if (problem) throw new ApplicationError(400, 'PURCHASING_PAGE_INVALID', problem);
    const organizationId = user.organizationId;
    const to = completePageLayout(input);
    await this.prisma.$transaction(async (tx) => {
      const before = (await readPurchasingSetup(tx, organizationId)).settings.page;
      if (JSON.stringify(before) === JSON.stringify(to)) return;
      const page = JSON.parse(JSON.stringify(to)) as Prisma.InputJsonObject;
      await tx.purchasingSettings.upsert({ where: { organizationId }, create: { organizationId, requisitionPage: page }, update: { requisitionPage: page } });
      await this.audit(tx, user, 'page', before, to);
    });
    return this.read(user);
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

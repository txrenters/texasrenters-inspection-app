import { Inject, Injectable } from '@nestjs/common';
import { PurchaseRequisitionStatus as Status, type Prisma } from '@prisma/client';
import {
  EDITABLE_REQUISITION_STATUSES,
  OPEN_REQUISITION_STATUSES,
  actsForCompany,
  approvalRefusal,
  companyRefusal,
  departmentRefusal,
  averageCostCents,
  orderGroups,
  requisitionerCode,
  requisitionStage,
  requisitionSubmitProblem,
  orderTotals,
  requisitionTotalCents,
  type PurchasingSettings,
  type PurchasingStanding,
  type RequisitionActions,
  type RequisitionChoices,
  type RequisitionDecisionInput,
  type RequisitionDetail,
  type RequisitionHistoryEntry,
  type RequisitionList,
  type RequisitionRow,
  type VendorStats,
  type SaveRequisitionInput,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { nextDocumentCode, readPurchasingSettings, readPurchasingSetup, readStanding } from './purchasing-settings';
import { RequisitionApproversService } from './requisition-approvers';
import { ATTACHABLE, requisitionFiles } from './requisition-files';
import { requisitionNotesAndLinks } from './requisition-notes';

/**
 * Purchase requisitions (2026-11-19, phase 2 of the inventory and purchasing
 * plan): asking for stock to be bought, and deciding what is.
 *
 * Who may do what is decided here, not by the page:
 * - whoever asked changes, submits and cancels their own, and nobody else's;
 * - a holder of `purchasing:approve` sees everyone's once submitted (a draft
 *   is its author's alone) and approves, sends back or rejects, within their
 *   limit and the office's approval steps. An approver may approve their own
 *   (the office, 2026-11-21), and it is audited as their own; they send back
 *   or reject only somebody else's, and take their own back instead.
 * The database refuses the requester sending back or rejecting their own too (a check).
 *
 * Every step is one guarded status change, so two people deciding at once
 * cannot both succeed, and every step is audited: the audit log is the
 * requisition's history. A requisition moves no stock and spends nothing,
 * and nothing here calls anything billed.
 */

const APPROVE = 'purchasing:approve';
const ORDER = 'purchasing:order';
const MAKE_ITEM_CODES = 'inventory:manage';
const ENTITY = 'PurchaseRequisition';
/** The requisitions that are finished with, newest first: enough to look back, and no more. */
const CLOSED_SHOWN = 200;
const CANCELLABLE: Status[] = [Status.DRAFT, Status.SUBMITTED, Status.SENT_BACK];
const EDITABLE = EDITABLE_REQUISITION_STATUSES as readonly Status[];

type Db = Prisma.TransactionClient;
/** What a decision is held to: the steps, whether approvers decide only for their own companies, and the caller's standing. */
type Rules = { settings: PurchasingSettings; ownCompaniesOnly: boolean; standing: PurchasingStanding };
const may = (user: AuthenticatedUser, permission: string) => (user.permissions as readonly string[]).includes(permission);
const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

const ROW = {
  id: true,
  number: true,
  status: true,
  xeroTenantId: true,
  neededBy: true,
  reason: true,
  requestedById: true,
  submittedAt: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  documentDate: true,
  requestedBy: { select: { displayName: true } },
  decidedBy: { select: { displayName: true } },
  deliverTo: { select: { id: true, name: true, code: true } },
  requestCode: { select: { id: true, code: true, name: true } },
  costCenter: { select: { id: true, code: true, name: true } },
  departmentId: true,
  department: { select: { id: true, code: true, name: true } },
  // Its orders' statuses, for where it is (2026-11-21): a cancelled one counts for nothing.
  orders: { where: { status: { not: 'CANCELLED' } }, select: { status: true } },
  lines: {
    orderBy: { position: 'asc' },
    select: {
      id: true,
      description: true,
      quantity: true,
      estimatedUnitCostCents: true,
      expectedOn: true,
      notes: true,
      item: { select: { id: true, code: true, name: true, unit: true, reorderLevel: true, lineType: { select: { code: true, name: true, keepsStock: true } } } },
      place: { select: { id: true, code: true, name: true } },
      vendor: { select: { id: true, number: true, name: true } },
      department: { select: { id: true, code: true, name: true } },
    },
  },
  quotes: { orderBy: { totalCents: 'asc' }, select: { id: true, totalCents: true, delivery: true, chosen: true, vendor: { select: { id: true, name: true } } } },
} satisfies Prisma.PurchaseRequisitionSelect;
type Requisition = Prisma.PurchaseRequisitionGetPayload<{ select: typeof ROW }>;

/** A company's name and purchaser code, by its Xero tenant. */
type Companies = ReadonlyMap<string, { name: string; purchaserCode: string | null }>;

function row(requisition: Requisition, companies: Companies): RequisitionRow {
  const company = requisition.xeroTenantId ? companies.get(requisition.xeroTenantId) : undefined;
  return {
    id: requisition.id,
    number: requisition.number,
    status: requisition.status,
    requestedBy: { id: requisition.requestedById, name: requisition.requestedBy.displayName, code: requisitionerCode(requisition.requestedBy.displayName) },
    submittedAt: requisition.submittedAt?.toISOString() ?? null,
    createdAt: requisition.createdAt.toISOString(),
    company: requisition.xeroTenantId ? { tenantId: requisition.xeroTenantId, name: company?.name ?? 'A company', purchaserCode: company?.purchaserCode ?? null } : null,
    neededBy: dayOf(requisition.neededBy),
    summary: requisition.lines.map((line) => `${line.description ?? line.item?.name ?? ''} × ${line.quantity}`).join(', '),
    lineCount: requisition.lines.length,
    quoteCount: requisition.quotes.length,
    estimatedTotalCents: requisitionTotalCents(requisition.lines),
    decisionNote: requisition.decisionNote,
    stage: requisitionStage(requisition.status, requisition.orders.map((order) => order.status)),
    department: requisition.department,
  };
}

/** Who may approve how much: the office's own, or what it starts with. Orders share it (phase 3). */

/**
 * The office's next number of a kind of document -- "PR" requisitions, "PO"
 * orders, "RCV" receipts, "JOB" jobs -- taken under the series row's lock: two submitted at once never
 * share one.
 */
export async function nextDocumentNumber(db: Pick<Db, '$queryRaw'>, organizationId: string, kind: 'PR' | 'PO' | 'RCV' | 'WD' | 'RT' | 'TR' | 'CNT' | 'V' | 'JOB'): Promise<number> {
  const [taken] = await db.$queryRaw<{ taken: number }[]>`
    INSERT INTO "DocumentSeries" ("organizationId", "kind", "next")
    VALUES (${organizationId}::uuid, ${kind}, 2)
    ON CONFLICT ("organizationId", "kind") DO UPDATE SET "next" = "DocumentSeries"."next" + 1
    RETURNING "next" - 1 AS taken`;
  return Number(taken!.taken);
}

/** Orders still to arrive, for Vendor Statistics. */
const OPEN_ORDER = ['AWAITING_APPROVAL', 'APPROVED', 'SENT', 'PARTLY_RECEIVED'] as const;

/** Each vendor's open orders, this year's spend and last order, from its orders newest first. */
function vendorStatsOf(orders: { vendorId: string | null; number: string | null; status: string; createdAt: Date; taxBasisPoints: number; lines: { quantity: number; unitPriceCents: number }[] }[]): Record<string, VendorStats> {
  const year = businessDate().slice(0, 4);
  const stats: Record<string, VendorStats> = {};
  for (const order of orders) {
    if (!order.vendorId) continue;
    const one = (stats[order.vendorId] ??= { openOrders: 0, openCents: 0, orderedThisYearCents: 0, lastOrder: null });
    const totalCents = orderTotals(order.lines, order.taxBasisPoints).totalCents;
    if ((OPEN_ORDER as readonly string[]).includes(order.status)) {
      one.openOrders += 1;
      one.openCents += totalCents;
    }
    if (businessDate(order.createdAt).startsWith(year)) one.orderedThisYearCents += totalCents;
    if (!one.lastOrder && order.number) one.lastOrder = { number: order.number, on: businessDate(order.createdAt) };
  }
  return stats;
}

/** The history's words for each audited step. */
const STEP: Record<string, string> = {
  PURCHASE_REQUISITION_ORDERED: 'made purchase orders from it',
  PURCHASE_REQUISITION_ORDER_CANCELLED: 'cancelled its purchase order',
  PURCHASE_REQUISITION_CREATED: 'started it',
  PURCHASE_REQUISITION_CHANGED: 'changed it',
  PURCHASE_REQUISITION_SUBMITTED: 'submitted it',
  PURCHASE_REQUISITION_APPROVED: 'approved it',
  PURCHASE_REQUISITION_SENT_BACK: 'sent it back',
  PURCHASE_REQUISITION_REJECTED: 'rejected it',
  PURCHASE_REQUISITION_CANCELLED: 'cancelled it',
  PURCHASE_REQUISITION_RECALLED: 'took back its approval request',
  PURCHASE_REQUISITION_REOPENED: 'reopened it',
  PURCHASE_REQUISITION_NOTE_ADDED: 'wrote a note',
  PURCHASE_REQUISITION_NOTE_REMOVED: 'took a note off',
  PURCHASE_REQUISITION_COMMENTED: 'commented',
  PURCHASE_REQUISITION_LINK_ADDED: 'added a link',
  PURCHASE_REQUISITION_LINK_REMOVED: 'took a link off',
  PURCHASE_REQUISITION_FILE_ATTACHED: 'attached a file',
  PURCHASE_REQUISITION_FILE_REMOVED: 'took a file off',
  PURCHASE_REQUISITION_FILE_FOR_VENDOR: 'ticked a file to go to the vendor',
  PURCHASE_REQUISITION_FILE_NOT_FOR_VENDOR: 'unticked a file for the vendor',
};

/** Whether a vendor the requisition's lines go to has no live order yet: the orders the ribbon may still make. */
function vendorsUnordered(requisition: Pick<Requisition, 'lines' | 'quotes'>, orders: readonly { vendorId: string | null }[]) {
  const chosen = requisition.quotes.find((quote) => quote.chosen)?.vendor.id ?? null;
  const groups = orderGroups(
    requisition.lines.map((line) => ({ itemId: line.item?.id ?? null, vendorId: line.vendor?.id ?? null })),
    chosen,
  );
  const ordered = new Set(orders.map((order) => order.vendorId));
  return groups.some((group) => !ordered.has(group.vendorId));
}

/** The caller's own, and -- for somebody who decides them or makes orders from them -- everyone's that has been submitted. A draft is its author's alone. */
export function visibleRequisitions(user: AuthenticatedUser): Prisma.PurchaseRequisitionWhereInput {
  return may(user, APPROVE) || may(user, ORDER) ? { OR: [{ requestedById: user.id }, { status: { not: Status.DRAFT } }] } : { requestedById: user.id };
}

@Injectable()
export class PurchasingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(RequisitionApproversService) private readonly approvers: RequisitionApproversService,
  ) {}

  private settings(db: Pick<Db, 'purchasingSettings' | 'purchasingApprovalStep'>, organizationId: string): Promise<PurchasingSettings> {
    return readPurchasingSettings(db, organizationId);
  }

  /** Everything a decision is held to (Purchasing Setup): the steps, whether approvers approve only for their own companies, and the caller's standing. */
  private async rules(db: Pick<Db, 'purchasingSettings' | 'purchasingApprovalStep' | 'purchasingPerson'>, user: AuthenticatedUser): Promise<Rules> {
    const [setup, standing] = await Promise.all([readPurchasingSetup(db, user.organizationId), readStanding(db, user)]);
    return { settings: setup.settings, ownCompaniesOnly: setup.approvals.approverOwnCompaniesOnly, standing };
  }

  private async companies(organizationId: string) {
    const rows = await this.prisma.xeroOrganisation.findMany({ where: { organizationId }, select: { xeroTenantId: true, name: true, status: true, purchaserCode: true }, orderBy: { name: 'asc' } });
    return {
      names: new Map(rows.map((entry) => [entry.xeroTenantId, { name: entry.name, purchaserCode: entry.purchaserCode }])) as Companies,
      connected: rows.filter((entry) => entry.status === 'CONNECTED').map((entry) => ({ tenantId: entry.xeroTenantId, name: entry.name, purchaserCode: entry.purchaserCode })),
    };
  }

  private visible(user: AuthenticatedUser): Prisma.PurchaseRequisitionWhereInput {
    return visibleRequisitions(user);
  }

  /** What the caller may do with it now. The page draws its buttons from this, and each action checks the same again. */
  private actions(
    user: AuthenticatedUser,
    requisition: Pick<Requisition, 'status' | 'requestedById' | 'xeroTenantId' | 'departmentId'>,
    totalCents: number,
    rules: Rules,
    unordered = false,
  ): RequisitionActions {
    const mine = requisition.requestedById === user.id;
    const waiting = requisition.status === Status.SUBMITTED && may(user, APPROVE);
    // It goes to its department's approvers (the office, 2026-11-21): one of other departments decides nothing of it.
    const otherDepartment = departmentRefusal(rules.standing, requisition.departmentId);
    // An approver limited to some companies decides only theirs, when the office says so (Purchasing Setup, 2026-11-21).
    const decides = (!rules.ownCompaniesOnly || actsForCompany(rules.standing, requisition.xeroTenantId)) && !otherDepartment;
    // An approver approves their own as anybody else's (the office, 2026-11-21): within their limit, the step, their companies and departments.
    const approveBlocked = !waiting ? null : (otherDepartment ?? approvalRefusal(rules.standing, rules.settings.steps, totalCents, requisition.xeroTenantId, rules.ownCompaniesOnly));
    return {
      edit: mine && EDITABLE.includes(requisition.status),
      submit: mine && EDITABLE.includes(requisition.status),
      cancel: mine && CANCELLABLE.includes(requisition.status),
      approve: waiting && !approveBlocked,
      sendBack: waiting && !mine && decides,
      reject: waiting && !mine && decides,
      // Approved, or Ordered with a vendor still to order from: one whose order was cancelled. Only for the purchaser's own companies.
      order: (requisition.status === Status.APPROVED || (requisition.status === Status.ORDERED && unordered)) && may(user, ORDER) && actsForCompany(rules.standing, requisition.xeroTenantId),
      approveBlocked,
      // Whoever sees it: their own, or one they decide or order from.
      attach: ATTACHABLE.includes(requisition.status),
      recall: mine && requisition.status === Status.SUBMITTED,
      reopen: requisition.status === Status.APPROVED && (mine || may(user, APPROVE)),
    };
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  async list(user: AuthenticatedUser, show: 'open' | 'closed' = 'open'): Promise<RequisitionList> {
    const organizationId = user.organizationId;
    const open = OPEN_REQUISITION_STATUSES as readonly Status[];
    const [requisitions, companies, settings] = await Promise.all([
      this.prisma.purchaseRequisition.findMany({
        where: { organizationId, status: show === 'open' ? { in: [...open] } : { notIn: [...open] }, AND: [this.visible(user)] },
        select: ROW,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(show === 'closed' ? { take: CLOSED_SHOWN } : {}),
      }),
      this.companies(organizationId),
      this.settings(this.prisma, organizationId),
    ]);
    return { requisitions: requisitions.map((requisition) => row(requisition, companies.names)), settings, seesAll: may(user, APPROVE) || may(user, ORDER) };
  }

  /** Requests to Approve (the office, 2026-11-21): the requisitions waiting that the caller may approve now, the longest waiting first. */
  async toApprove(user: AuthenticatedUser): Promise<RequisitionRow[]> {
    if (!may(user, APPROVE)) return [];
    const organizationId = user.organizationId;
    const [requisitions, companies, rules] = await Promise.all([
      this.prisma.purchaseRequisition.findMany({ where: { organizationId, status: Status.SUBMITTED }, select: ROW, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }], take: CLOSED_SHOWN }),
      this.companies(organizationId),
      this.rules(this.prisma, user),
    ]);
    return requisitions.filter((requisition) => this.actions(user, requisition, requisitionTotalCents(requisition.lines), rules).approve).map((requisition) => row(requisition, companies.names));
  }

  async detail(user: AuthenticatedUser, requisitionId: string): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    const requisition = await this.prisma.purchaseRequisition.findFirst({ where: { id: requisitionId, organizationId, AND: [this.visible(user)] }, select: ROW });
    // Somebody else's, or another office's, is simply not there.
    if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
    const itemIds = requisition.lines.flatMap((line) => (line.item ? [line.item.id] : []));
    const [companies, rules, levels, audits, orders, files, attached, office] = await Promise.all([
      this.companies(organizationId),
      this.rules(this.prisma, user),
      itemIds.length ? this.prisma.stockLevel.groupBy({ by: ['itemId'], where: { organizationId, itemId: { in: itemIds } }, _sum: { quantity: true } }) : [],
      this.prisma.auditLog.findMany({
        where: { organizationId, entityType: ENTITY, entityId: requisitionId },
        select: { action: true, actorUserId: true, metadata: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      // The orders made from it, one a vendor (2026-11-20): a cancelled one frees its vendor for another.
      this.prisma.purchaseOrder.findMany({
        where: { organizationId, requisitionId, status: { not: 'CANCELLED' } },
        select: { id: true, number: true, status: true, vendorId: true, vendor: { select: { id: true, number: true, name: true } } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      requisitionFiles(this.prisma, user, requisition),
      requisitionNotesAndLinks(this.prisma, user, requisitionId),
      // Who it is from, for its PDF: the office's address on its invoices.
      this.prisma.invoiceSettings.findUnique({ where: { organizationId }, select: { companyName: true, addressLine1: true, addressLine2: true, phone: true, email: true } }),
    ]);
    const actorIds = [...new Set(audits.flatMap((audit) => (audit.actorUserId ? [audit.actorUserId] : [])))];
    const actors = actorIds.length ? await this.prisma.userProfile.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const nameOf = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    const onHand = new Map(levels.map((level) => [level.itemId, level._sum.quantity ?? 0]));
    const history: RequisitionHistoryEntry[] = audits.map((audit) => {
      const note = (audit.metadata as { note?: string | null } | null)?.note;
      return { at: audit.createdAt.toISOString(), by: (audit.actorUserId && nameOf.get(audit.actorUserId)) || 'Somebody', what: `${STEP[audit.action] ?? 'changed it'}${note ? `: ${note}` : ''}` };
    });
    const summary = row(requisition, companies.names);
    return {
      ...summary,
      reason: requisition.reason,
      deliverTo: requisition.deliverTo,
      requestCode: requisition.requestCode,
      costCenter: requisition.costCenter,
      requisitionDate: businessDate(requisition.createdAt),
      // One made blank (2026-11-20 only) reads as the day it was made.
      documentDate: dayOf(requisition.documentDate) ?? businessDate(requisition.createdAt),
      lines: requisition.lines.map((line) => ({
        id: line.id,
        item: line.item ? { id: line.item.id, code: line.item.code, name: line.item.name, unit: line.item.unit } : null,
        description: line.description ?? line.item?.name ?? null,
        quantity: line.quantity,
        estimatedUnitCostCents: line.estimatedUnitCostCents,
        lineType: line.item?.lineType ?? null,
        place: line.place,
        expectedOn: dayOf(line.expectedOn),
        vendor: line.vendor,
        department: line.department,
        notes: line.notes,
        onHand: line.item ? (onHand.get(line.item.id) ?? 0) : null,
        reorderLevel: line.item?.reorderLevel ?? null,
      })),
      quotes: requisition.quotes,
      decidedBy: requisition.decidedBy?.displayName ?? null,
      decidedAt: requisition.decidedAt?.toISOString() ?? null,
      history,
      orders: orders.map((order) => ({ id: order.id, number: order.number, status: order.status, vendor: order.vendor })),
      from: {
        // The company the stock is for, as its books name it; else the office's own name on its invoices.
        name: summary.company?.name ?? office?.companyName ?? 'TexasRenters.com',
        addressLine1: office?.addressLine1 ?? null,
        addressLine2: office?.addressLine2 ?? null,
        phone: office?.phone ?? null,
        email: office?.email ?? null,
      },
      files,
      ...attached,
      can: this.actions(user, requisition, summary.estimatedTotalCents, rules, vendorsUnordered(requisition, orders)),
      settings: rules.settings,
    };
  }

  /**
   * What the form chooses from: nine reads, whatever the number of items --
   * the items with what is on hand where, what is still to come on open
   * orders and the order that last asked for each, and the codes in use.
   */
  async choices(user: AuthenticatedUser): Promise<RequisitionChoices> {
    const organizationId = user.organizationId;
    const [items, levels, places, companies, vendors, settings, codes, categories, ordered, standing, vendorOrders] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: { organizationId, active: true },
        select: { id: true, code: true, name: true, unit: true, xeroTenantId: true, reorderLevel: true, reorderQuantity: true, priceCents: true, lineTypeId: true, categoryId: true, usualVendorId: true },
        orderBy: { codeKey: 'asc' },
      }),
      this.prisma.stockLevel.findMany({ where: { organizationId, quantity: { not: 0 } }, select: { itemId: true, placeId: true, quantity: true, valueCents: true } }),
      this.prisma.stockPlace.findMany({ where: { organizationId, active: true }, select: { id: true, name: true, code: true }, orderBy: [{ kind: 'asc' }, { nameKey: 'asc' }] }),
      this.companies(organizationId),
      this.prisma.vendor.findMany({ where: { organizationId, active: true }, select: { id: true, name: true, number: true }, orderBy: { nameKey: 'asc' } }),
      this.settings(this.prisma, organizationId),
      this.prisma.purchasingCode.findMany({ where: { organizationId, active: true }, select: { id: true, kind: true, code: true, name: true, keepsStock: true }, orderBy: { code: 'asc' } }),
      this.prisma.stockCategory.findMany({ where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: { nameKey: 'asc' } }),
      // Every line of an order still open, newest first: what is to come, and which order last asked.
      this.prisma.purchaseOrderLine.findMany({
        where: { organizationId, order: { status: { notIn: ['CANCELLED', 'DRAFT'] } } },
        select: { itemId: true, quantity: true, receivedQuantity: true, order: { select: { number: true, status: true, createdAt: true } } },
        orderBy: { order: { createdAt: 'desc' } },
        take: 5000,
      }),
      readStanding(this.prisma, user),
      // Vendor Statistics (2026-11-21): this year's orders and every one still open, newest first.
      this.prisma.purchaseOrder.findMany({
        where: {
          organizationId,
          vendorId: { not: null },
          status: { notIn: ['DRAFT', 'CANCELLED'] },
          OR: [{ createdAt: { gte: dateOf(`${businessDate().slice(0, 4)}-01-01`) } }, { status: { in: [...OPEN_ORDER] } }],
        },
        select: { vendorId: true, number: true, status: true, createdAt: true, taxBasisPoints: true, lines: { select: { quantity: true, unitPriceCents: true } } },
        orderBy: { createdAt: 'desc' },
        take: 3000,
      }),
    ]);
    const held = new Map<string, { quantity: number; valueCents: number; places: { placeId: string; quantity: number }[] }>();
    for (const level of levels) {
      const kept = held.get(level.itemId) ?? { quantity: 0, valueCents: 0, places: [] };
      kept.quantity += level.quantity;
      kept.valueCents += level.valueCents;
      kept.places.push({ placeId: level.placeId, quantity: level.quantity });
      held.set(level.itemId, kept);
    }
    const onOrder = new Map<string, number>();
    const lastOrdered = new Map<string, string>();
    for (const line of ordered) {
      if (line.order.number && !lastOrdered.has(line.itemId)) lastOrdered.set(line.itemId, line.order.number);
      if (!['RECEIVED', 'CLOSED'].includes(line.order.status)) onOrder.set(line.itemId, (onOrder.get(line.itemId) ?? 0) + Math.max(0, line.quantity - line.receivedQuantity));
    }
    const ofKind = (kind: string) => codes.filter((code) => code.kind === kind).map(({ id, code, name }) => ({ id, code, name }));
    return {
      items: items.map((item) => {
        const level = held.get(item.id) ?? { quantity: 0, valueCents: 0, places: [] };
        return {
          id: item.id,
          code: item.code,
          name: item.name,
          unit: item.unit,
          companyTenantId: item.xeroTenantId,
          onHand: level.quantity,
          reorderLevel: item.reorderLevel,
          reorderQuantity: item.reorderQuantity,
          averageCostCents: averageCostCents(level.valueCents, level.quantity),
          priceCents: item.priceCents,
          lineTypeId: item.lineTypeId,
          categoryId: item.categoryId,
          usualVendorId: item.usualVendorId,
          held: level.places,
          onOrder: onOrder.get(item.id) ?? 0,
          lastOrdered: lastOrdered.get(item.id) ?? null,
        };
      }),
      places,
      // A person limited to some companies asks only for theirs (Purchasing Setup, 2026-11-21).
      companies: companies.connected.filter((company) => actsForCompany(standing, company.tenantId)),
      vendors,
      vendorStats: vendorStatsOf(vendorOrders),
      settings,
      lineTypes: codes.filter((code) => code.kind === 'LINE_TYPE').map(({ id, code, name, keepsStock }) => ({ id, code, name, keepsStock })),
      requestCodes: ofKind('REQUEST'),
      departments: ofKind('DEPARTMENT'),
      costCenters: ofKind('COST_CENTER'),
      categories,
      me: { id: user.id, name: user.displayName, code: requisitionerCode(user.displayName) },
      canMakeItemCodes: may(user, MAKE_ITEM_CODES),
    };
  }

  // ── Writing a requisition ───────────────────────────────────────────────

  /**
   * What a requisition names is this office's own, every line asks for an
   * item by its code, and its items are its company's. The database's keys refuse another office's too; this says so
   * plainly, and holds the rules the keys cannot.
   */
  private async checked(db: Db, user: AuthenticatedUser, input: SaveRequisitionInput) {
    const organizationId = user.organizationId;
    // A draft may wait for its company (2026-11-21: New makes and numbers it at once, every field blank); it is sent only for one of the person's own.
    const refused = input.xeroTenantId ? companyRefusal(await readStanding(db, user), input.xeroTenantId, 'ask for stock') : null;
    if (refused) throw new ApplicationError(403, 'REQUISITION_COMPANY_NOT_YOURS', refused);
    if (input.xeroTenantId && !(await db.xeroOrganisation.findFirst({ where: { organizationId, xeroTenantId: input.xeroTenantId, status: 'CONNECTED' }, select: { id: true } })))
      throw new ApplicationError(400, 'REQUISITION_COMPANY_NOT_FOUND', 'That company is not connected to this office.');
    if (input.deliverToPlaceId && !(await db.stockPlace.findFirst({ where: { organizationId, id: input.deliverToPlaceId, active: true }, select: { id: true } })))
      throw new ApplicationError(400, 'REQUISITION_PLACE_NOT_FOUND', 'That place is not in use.');

    const itemIds = input.lines.map((line) => line.itemId);
    if (new Set(itemIds).size !== itemIds.length) throw new ApplicationError(400, 'REQUISITION_ITEM_TWICE', 'An item is on the requisition twice. Put it on one line.');
    const items = itemIds.length ? await db.stockItem.findMany({ where: { organizationId, id: { in: itemIds } }, select: { id: true, code: true, active: true, xeroTenantId: true } }) : [];
    const itemOf = new Map(items.map((item) => [item.id, item]));
    for (const line of input.lines) {
      const item = itemOf.get(line.itemId);
      if (!item || !item.active) throw new ApplicationError(400, 'REQUISITION_ITEM_NOT_FOUND', 'One of the items is not in the inventory, or is switched off.');
      if (item.xeroTenantId !== (input.xeroTenantId ?? null))
        throw new ApplicationError(400, 'REQUISITION_ITEM_OTHER_COMPANY', `${item.code} belongs to another company than this requisition is for.`);
    }

    const vendorIds = [...new Set(input.quotes.map((quote) => quote.vendorId))];
    if (vendorIds.length && (await db.vendor.count({ where: { organizationId, id: { in: vendorIds } } })) !== vendorIds.length)
      throw new ApplicationError(400, 'VENDOR_NOT_FOUND', 'One of the quotes names a vendor that is not on the list.');

    // The codes and places it names (2026-11-20): each this office's own, in use, and on its own list.
    const code = async (id: string | null | undefined, kind: 'REQUEST' | 'COST_CENTER' | 'DEPARTMENT', words: string) => {
      if (id && !(await db.purchasingCode.findFirst({ where: { organizationId, id, kind, active: true }, select: { id: true } })))
        throw new ApplicationError(400, 'REQUISITION_CODE_NOT_FOUND', `That ${words} is not on the list, or is switched off.`);
    };
    await code(input.requestCodeId, 'REQUEST', 'request code');
    await code(input.costCenterId, 'COST_CENTER', 'cost center code');
    await code(input.departmentId, 'DEPARTMENT', 'department code');
    for (const id of new Set(input.lines.flatMap((line) => (line.departmentId ? [line.departmentId] : [])))) await code(id, 'DEPARTMENT', 'department code');
    const linePlaces = [...new Set(input.lines.flatMap((line) => (line.placeId ? [line.placeId] : [])))];
    if (linePlaces.length && (await db.stockPlace.count({ where: { organizationId, id: { in: linePlaces }, active: true } })) !== linePlaces.length)
      throw new ApplicationError(400, 'REQUISITION_PLACE_NOT_FOUND', 'A line goes to a place that is not in use.');
    const lineVendors = [...new Set(input.lines.flatMap((line) => (line.vendorId ? [line.vendorId] : [])))];
    if (lineVendors.length && (await db.vendor.count({ where: { organizationId, id: { in: lineVendors }, active: true } })) !== lineVendors.length)
      throw new ApplicationError(400, 'VENDOR_NOT_FOUND', 'A line names a vendor that is not on the list, or is switched off.');
    if (input.quotes.filter((quote) => quote.chosen).length > 1) throw new ApplicationError(400, 'REQUISITION_QUOTES_CHOSEN', 'Only one quote can be the chosen one.');
  }

  /** `made` is the Texas day the requisition was made: its Document Date unless another is given (2026-11-21). */
  private fields(input: SaveRequisitionInput, made: string) {
    return {
      xeroTenantId: input.xeroTenantId ?? null,
      neededBy: input.neededBy ? dateOf(input.neededBy) : null,
      deliverToPlaceId: input.deliverToPlaceId ?? null,
      requestCodeId: input.requestCodeId ?? null,
      departmentId: input.departmentId ?? null,
      costCenterId: input.costCenterId ?? null,
      // The day on the paper: the day it was made, unless another is given.
      documentDate: dateOf(input.documentDate || made),
      reason: input.reason.trim(),
    };
  }

  private async writeLinesAndQuotes(db: Db, organizationId: string, requisitionId: string, input: SaveRequisitionInput) {
    if (input.lines.length)
      await db.purchaseRequisitionLine.createMany({
        data: input.lines.map((line, position) => ({
          organizationId,
          requisitionId,
          position,
          itemId: line.itemId,
          quantity: line.quantity,
          estimatedUnitCostCents: line.estimatedUnitCostCents,
          description: text(line.description),
          placeId: line.placeId ?? null,
          expectedOn: line.expectedOn ? dateOf(line.expectedOn) : null,
          vendorId: line.vendorId ?? null,
          departmentId: line.departmentId ?? null,
          notes: line.notes?.trim() || null,
        })),
      });
    if (input.quotes.length)
      await db.purchaseRequisitionQuote.createMany({
        data: input.quotes.map((quote) => ({ organizationId, requisitionId, vendorId: quote.vendorId, totalCents: quote.totalCents, delivery: text(quote.delivery), chosen: quote.chosen })),
      });
  }

  private audit(db: Db, user: AuthenticatedUser, action: string, requisitionId: string, metadata: Prisma.InputJsonObject) {
    return db.auditLog.create({ data: { organizationId: user.organizationId, ...auditActor(user), action, entityType: ENTITY, entityId: requisitionId, metadata } });
  }

  /**
   * A draft, the caller's own. It takes its number now, as in NAV (2026-11-20),
   * so a draft can be found and talked about by it; a draft that is deleted
   * leaves a gap in the numbers.
   */
  async create(user: AuthenticatedUser, input: SaveRequisitionInput): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    const created = await this.prisma.$transaction(async (tx) => {
      await this.checked(tx, user, input);
      const number = await nextDocumentCode(tx, organizationId, 'PR');
      const requisition = await tx.purchaseRequisition.create({ data: { organizationId, requestedById: user.id, number, ...this.fields(input, businessDate()) }, select: { id: true } });
      await this.writeLinesAndQuotes(tx, organizationId, requisition.id, input);
      await this.audit(tx, user, 'PURCHASE_REQUISITION_CREATED', requisition.id, { number, lines: input.lines.length, totalCents: requisitionTotalCents(input.lines) });
      return requisition;
    });
    return this.detail(user, created.id);
  }

  /** The caller's own, found for a step they alone may take; anybody else's is not there. */
  private async own(db: Db, user: AuthenticatedUser, requisitionId: string) {
    const requisition = await db.purchaseRequisition.findFirst({
      where: { id: requisitionId, organizationId: user.organizationId, requestedById: user.id },
      select: {
        id: true,
        number: true,
        status: true,
        reason: true,
        submittedAt: true,
        // The fields the office may require (Purchasing Setup, 2026-11-21).
        requestCodeId: true,
        costCenterId: true,
        departmentId: true,
        documentDate: true,
        createdAt: true,
        neededBy: true,
        deliverToPlaceId: true,
        xeroTenantId: true,
        lines: { select: { quantity: true, estimatedUnitCostCents: true, departmentId: true, notes: true } },
        quotes: { select: { chosen: true } },
        // Above the office's amount, a file -- the quote -- must be attached before it is sent.
        files: { select: { id: true } },
      },
    });
    if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
    return requisition;
  }

  /**
   * One status change, made only if the requisition is still where the caller
   * saw it: of two people acting at once, the second is told it has moved on.
   */
  private async move(db: Db, organizationId: string, requisitionId: string, from: readonly Status[], data: Prisma.PurchaseRequisitionUncheckedUpdateManyInput) {
    const moved = await db.purchaseRequisition.updateMany({ where: { id: requisitionId, organizationId, status: { in: [...from] } }, data });
    if (moved.count !== 1) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'This requisition has changed since you opened it. Open it again.');
  }

  /** Replaces what the requisition asks for. Only its author, and only before it is submitted or after it is sent back. */
  async update(user: AuthenticatedUser, requisitionId: string, input: SaveRequisitionInput): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const requisition = await this.own(tx, user, requisitionId);
      if (!EDITABLE.includes(requisition.status)) throw new ApplicationError(409, 'REQUISITION_FIXED', 'A requisition cannot be changed once it is submitted, unless it is sent back.');
      await this.checked(tx, user, input);
      await this.move(tx, organizationId, requisitionId, EDITABLE, this.fields(input, businessDate(requisition.createdAt)));
      await tx.purchaseRequisitionLine.deleteMany({ where: { organizationId, requisitionId } });
      await tx.purchaseRequisitionQuote.deleteMany({ where: { organizationId, requisitionId } });
      await this.writeLinesAndQuotes(tx, organizationId, requisitionId, input);
      await this.audit(tx, user, 'PURCHASE_REQUISITION_CHANGED', requisitionId, { lines: input.lines.length, totalCents: requisitionTotalCents(input.lines) });
    });
    return this.detail(user, requisitionId);
  }

  /** Hands it to the approvers. A draft from before numbers were given at saving takes its number now; one comes back and goes again with the same. */
  async submit(user: AuthenticatedUser, requisitionId: string): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const requisition = await this.own(tx, user, requisitionId);
      if (!EDITABLE.includes(requisition.status)) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'This requisition has already been submitted.');
      const problem = requisitionSubmitProblem({ ...requisition, documentDate: dayOf(requisition.documentDate) ?? businessDate(requisition.createdAt), neededBy: dayOf(requisition.neededBy) }, await this.settings(tx, organizationId));
      if (problem) throw new ApplicationError(409, 'REQUISITION_NOT_READY', problem);
      // Saved as a draft without a company, it is sent only for one of the person's own.
      const refused = companyRefusal(await readStanding(tx, user), requisition.xeroTenantId, 'ask for stock');
      if (refused) throw new ApplicationError(403, 'REQUISITION_COMPANY_NOT_YOURS', refused);
      const number = requisition.number ?? (await nextDocumentCode(tx, organizationId, 'PR'));
      await this.move(tx, organizationId, requisitionId, EDITABLE, {
        status: Status.SUBMITTED,
        number,
        submittedAt: requisition.submittedAt ?? new Date(),
        // Asked now; reminded once if it waits past its step's days (Purchasing Setup, 2026-11-20).
        approvalRequestedAt: new Date(),
        approvalRemindedAt: null,
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
      });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_SUBMITTED', requisitionId, { number, totalCents: requisitionTotalCents(requisition.lines) });
    });
    // After it is sent, never inside: an email that fails does not take the requisition back.
    await this.approvers.ask(organizationId, requisitionId);
    return this.detail(user, requisitionId);
  }

  async cancel(user: AuthenticatedUser, requisitionId: string): Promise<RequisitionDetail> {
    await this.prisma.$transaction(async (tx) => {
      const requisition = await this.own(tx, user, requisitionId);
      if (!CANCELLABLE.includes(requisition.status)) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'This requisition has been decided, so it cannot be cancelled.');
      await this.move(tx, user.organizationId, requisitionId, CANCELLABLE, { status: Status.CANCELLED });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_CANCELLED', requisitionId, { number: requisition.number });
    });
    return this.detail(user, requisitionId);
  }

  /**
   * "Cancel Approval Request" (2026-11-20): its requester takes a submitted
   * requisition back to a draft while nobody has decided it. It keeps its
   * number; sending it again asks the approvers again.
   */
  async recall(user: AuthenticatedUser, requisitionId: string): Promise<RequisitionDetail> {
    await this.prisma.$transaction(async (tx) => {
      const requisition = await this.own(tx, user, requisitionId);
      if (requisition.status !== Status.SUBMITTED) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'Only a requisition waiting for approval can be taken back.');
      await this.move(tx, user.organizationId, requisitionId, [Status.SUBMITTED], { status: Status.DRAFT });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_RECALLED', requisitionId, { number: requisition.number });
    });
    return this.detail(user, requisitionId);
  }

  /**
   * "Reopen" (2026-11-20, NAV's step): an approved requisition with no order
   * yet goes back to being changed by its requester, and must be approved
   * again. Its requester or an approver; the approval it had is cleared.
   */
  async reopen(user: AuthenticatedUser, requisitionId: string, input: RequisitionDecisionInput): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    const note = text(input.note);
    await this.prisma.$transaction(async (tx) => {
      const requisition = await tx.purchaseRequisition.findFirst({ where: { id: requisitionId, organizationId, AND: [this.visible(user)] }, select: { number: true, status: true, requestedById: true } });
      if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
      if (requisition.requestedById !== user.id && !may(user, APPROVE)) throw new ApplicationError(403, 'REQUISITION_NOT_YOURS', 'Its requester or an approver reopens it.');
      if (requisition.status !== Status.APPROVED) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'Only an approved requisition with no order yet can be reopened.');
      if (await tx.purchaseOrder.count({ where: { organizationId, requisitionId, status: { not: 'CANCELLED' } } }))
        throw new ApplicationError(409, 'REQUISITION_ORDERED', 'An order has been made from it. Cancel the order first.');
      await this.move(tx, organizationId, requisitionId, [Status.APPROVED], { status: Status.SENT_BACK, decidedById: null, decidedAt: null, decisionNote: note ? `Reopened: ${note}` : 'Reopened' });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_REOPENED', requisitionId, { number: requisition.number, note });
    });
    return this.detail(user, requisitionId);
  }

  // ── Deciding ────────────────────────────────────────────────────────────

  /**
   * Approve, send back or reject a requisition that is waiting, by an approver.
   * Their own is only approved (2026-11-21); approving above the office's limit needs
   * `purchasing:approve-any`; sending back and rejecting need a note, which
   * the requester reads.
   */
  async decide(user: AuthenticatedUser, requisitionId: string, decision: 'APPROVED' | 'SENT_BACK' | 'REJECTED', input: RequisitionDecisionInput): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    const note = text(input.note);
    // The route asks for it too; here it does not rest on the route, now that an approver's own is theirs to approve.
    if (!may(user, APPROVE)) throw new ApplicationError(403, 'REQUISITION_NOT_APPROVER', 'Only an approver decides a requisition.');
    if (decision !== 'APPROVED' && !note) throw new ApplicationError(400, 'REQUISITION_NOTE_NEEDED', 'Say why, so whoever asked knows what to do next.');
    await this.prisma.$transaction(async (tx) => {
      const requisition = await tx.purchaseRequisition.findFirst({
        where: { id: requisitionId, organizationId, status: { not: Status.DRAFT } },
        select: { number: true, status: true, requestedById: true, xeroTenantId: true, departmentId: true, lines: { select: { quantity: true, estimatedUnitCostCents: true } } },
      });
      if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
      if (requisition.status !== Status.SUBMITTED) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'This requisition is no longer waiting for a decision.');
      const own = requisition.requestedById === user.id;
      // Their own is approved, or taken back with Cancel Approval Request: never sent back or rejected by them.
      if (own && decision !== 'APPROVED') throw new ApplicationError(403, 'REQUISITION_OWN', 'You asked for this: take it back with Cancel Approval Request instead.');
      const totalCents = requisitionTotalCents(requisition.lines);
      const rules = await this.rules(tx, user);
      if (rules.ownCompaniesOnly) {
        const refused = companyRefusal(rules.standing, requisition.xeroTenantId, 'decide requisitions');
        if (refused) throw new ApplicationError(403, 'REQUISITION_COMPANY_NOT_YOURS', refused);
      }
      const otherDepartment = departmentRefusal(rules.standing, requisition.departmentId);
      if (otherDepartment) throw new ApplicationError(403, 'REQUISITION_DEPARTMENT_NOT_YOURS', otherDepartment);
      if (decision === 'APPROVED') {
        const { approveBlocked } = this.actions(user, requisition, totalCents, rules);
        if (approveBlocked) throw new ApplicationError(403, 'REQUISITION_OVER_LIMIT', approveBlocked);
      }
      await this.move(tx, organizationId, requisitionId, [Status.SUBMITTED], { status: decision, decidedById: user.id, decidedAt: new Date(), decisionNote: note });
      await this.audit(tx, user, `PURCHASE_REQUISITION_${decision}`, requisitionId, { number: requisition.number, totalCents, note, ownRequest: own });
    });
    return this.detail(user, requisitionId);
  }
}

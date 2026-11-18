import { Inject, Injectable } from '@nestjs/common';
import { PurchaseRequisitionStatus as Status, type Prisma } from '@prisma/client';
import {
  DEFAULT_APPROVAL_LIMIT_CENTS,
  DEFAULT_QUOTES_ABOVE_LIMIT,
  EDITABLE_REQUISITION_STATUSES,
  OPEN_REQUISITION_STATUSES,
  averageCostCents,
  formatMoney,
  requisitionNumber,
  requisitionSubmitProblem,
  requisitionTotalCents,
  type PurchasingSettings,
  type RequisitionActions,
  type RequisitionChoices,
  type RequisitionDecisionInput,
  type RequisitionDetail,
  type RequisitionHistoryEntry,
  type RequisitionList,
  type RequisitionRow,
  type SavePurchasingSettingsInput,
  type SaveRequisitionInput,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';

/**
 * Purchase requisitions (2026-11-19, phase 2 of the inventory and purchasing
 * plan): asking for stock to be bought, and deciding what is.
 *
 * Who may do what is decided here, not by the page:
 * - whoever asked changes, submits and cancels their own, and nobody else's;
 * - a holder of `purchasing:approve` sees everyone's once submitted (a draft
 *   is its author's alone) and approves, sends back or rejects -- never their
 *   own, and above the office's limit only with `purchasing:approve-any`.
 * The database refuses a decision by the requester too (a check).
 *
 * Every step is one guarded status change, so two people deciding at once
 * cannot both succeed, and every step is audited: the audit log is the
 * requisition's history. A requisition moves no stock and spends nothing,
 * and nothing here calls anything billed.
 */

const APPROVE = 'purchasing:approve';
const ORDER = 'purchasing:order';
const APPROVE_ANY = 'purchasing:approve-any';
const ENTITY = 'PurchaseRequisition';
/** The requisitions that are finished with, newest first: enough to look back, and no more. */
const CLOSED_SHOWN = 200;
const CANCELLABLE: Status[] = [Status.DRAFT, Status.SUBMITTED, Status.SENT_BACK];
const EDITABLE = EDITABLE_REQUISITION_STATUSES as readonly Status[];

type Db = Prisma.TransactionClient;
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
  requestedBy: { select: { displayName: true } },
  decidedBy: { select: { displayName: true } },
  deliverTo: { select: { id: true, name: true } },
  lines: {
    orderBy: { position: 'asc' },
    select: { id: true, description: true, quantity: true, estimatedUnitCostCents: true, item: { select: { id: true, code: true, name: true, unit: true, reorderLevel: true } } },
  },
  quotes: { orderBy: { totalCents: 'asc' }, select: { id: true, totalCents: true, delivery: true, chosen: true, vendor: { select: { id: true, name: true } } } },
} satisfies Prisma.PurchaseRequisitionSelect;
type Requisition = Prisma.PurchaseRequisitionGetPayload<{ select: typeof ROW }>;

function row(requisition: Requisition, companies: ReadonlyMap<string, string>): RequisitionRow {
  return {
    id: requisition.id,
    number: requisition.number,
    status: requisition.status,
    requestedBy: { id: requisition.requestedById, name: requisition.requestedBy.displayName },
    submittedAt: requisition.submittedAt?.toISOString() ?? null,
    createdAt: requisition.createdAt.toISOString(),
    company: requisition.xeroTenantId ? { tenantId: requisition.xeroTenantId, name: companies.get(requisition.xeroTenantId) ?? 'A company' } : null,
    neededBy: dayOf(requisition.neededBy),
    summary: requisition.lines.map((line) => `${line.item?.name ?? line.description ?? ''} × ${line.quantity}`).join(', '),
    lineCount: requisition.lines.length,
    quoteCount: requisition.quotes.length,
    estimatedTotalCents: requisitionTotalCents(requisition.lines),
    decisionNote: requisition.decisionNote,
  };
}

/** Who may approve how much: the office's own, or what it starts with. Orders share it (phase 3). */
export async function readPurchasingSettings(db: Pick<Db, 'purchasingSettings'>, organizationId: string): Promise<PurchasingSettings> {
  const saved = await db.purchasingSettings.findUnique({ where: { organizationId }, select: { approvalLimitCents: true, quotesAboveLimit: true } });
  return saved ?? { approvalLimitCents: DEFAULT_APPROVAL_LIMIT_CENTS, quotesAboveLimit: DEFAULT_QUOTES_ABOVE_LIMIT };
}

/**
 * The office's next number of a kind of document -- "PR" requisitions, "PO"
 * orders, "RCV" receipts -- taken under the series row's lock: two submitted at once never
 * share one.
 */
export async function nextDocumentNumber(db: Pick<Db, '$queryRaw'>, organizationId: string, kind: 'PR' | 'PO' | 'RCV'): Promise<number> {
  const [taken] = await db.$queryRaw<{ taken: number }[]>`
    INSERT INTO "DocumentSeries" ("organizationId", "kind", "next")
    VALUES (${organizationId}::uuid, ${kind}, 2)
    ON CONFLICT ("organizationId", "kind") DO UPDATE SET "next" = "DocumentSeries"."next" + 1
    RETURNING "next" - 1 AS taken`;
  return Number(taken!.taken);
}

/** The history's words for each audited step. */
const STEP: Record<string, string> = {
  PURCHASE_REQUISITION_ORDERED: 'made a purchase order from it',
  PURCHASE_REQUISITION_ORDER_CANCELLED: 'cancelled its purchase order',
  PURCHASE_REQUISITION_CREATED: 'started it',
  PURCHASE_REQUISITION_CHANGED: 'changed it',
  PURCHASE_REQUISITION_SUBMITTED: 'submitted it',
  PURCHASE_REQUISITION_APPROVED: 'approved it',
  PURCHASE_REQUISITION_SENT_BACK: 'sent it back',
  PURCHASE_REQUISITION_REJECTED: 'rejected it',
  PURCHASE_REQUISITION_CANCELLED: 'cancelled it',
};

@Injectable()
export class PurchasingService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  private settings(db: Pick<Db, 'purchasingSettings'>, organizationId: string): Promise<PurchasingSettings> {
    return readPurchasingSettings(db, organizationId);
  }

  private async companies(organizationId: string) {
    const rows = await this.prisma.xeroOrganisation.findMany({ where: { organizationId }, select: { xeroTenantId: true, name: true, status: true }, orderBy: { name: 'asc' } });
    return { names: new Map(rows.map((entry) => [entry.xeroTenantId, entry.name])), connected: rows.filter((entry) => entry.status === 'CONNECTED').map((entry) => ({ tenantId: entry.xeroTenantId, name: entry.name })) };
  }

  /** The caller's own, and -- for somebody who decides them or makes orders from them -- everyone's that has been submitted. A draft is its author's alone. */
  private visible(user: AuthenticatedUser): Prisma.PurchaseRequisitionWhereInput {
    return may(user, APPROVE) || may(user, ORDER) ? { OR: [{ requestedById: user.id }, { status: { not: Status.DRAFT } }] } : { requestedById: user.id };
  }

  /** What the caller may do with it now. The page draws its buttons from this, and each action checks the same again. */
  private actions(user: AuthenticatedUser, requisition: Pick<Requisition, 'status' | 'requestedById'>, totalCents: number, settings: PurchasingSettings): RequisitionActions {
    const mine = requisition.requestedById === user.id;
    const waiting = requisition.status === Status.SUBMITTED && may(user, APPROVE);
    const approveBlocked = !waiting
      ? null
      : mine
        ? 'You asked for this, so somebody else approves it.'
        : totalCents > settings.approvalLimitCents && !may(user, APPROVE_ANY)
          ? `It is above the ${formatMoney(settings.approvalLimitCents)} approval limit, so it needs somebody who may approve any amount.`
          : null;
    return {
      edit: mine && EDITABLE.includes(requisition.status),
      submit: mine && EDITABLE.includes(requisition.status),
      cancel: mine && CANCELLABLE.includes(requisition.status),
      approve: waiting && !approveBlocked,
      sendBack: waiting && !mine,
      reject: waiting && !mine,
      order: requisition.status === Status.APPROVED && may(user, ORDER),
      approveBlocked,
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

  async detail(user: AuthenticatedUser, requisitionId: string): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    const requisition = await this.prisma.purchaseRequisition.findFirst({ where: { id: requisitionId, organizationId, AND: [this.visible(user)] }, select: ROW });
    // Somebody else's, or another office's, is simply not there.
    if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
    const itemIds = requisition.lines.flatMap((line) => (line.item ? [line.item.id] : []));
    const [companies, settings, levels, audits, order] = await Promise.all([
      this.companies(organizationId),
      this.settings(this.prisma, organizationId),
      itemIds.length ? this.prisma.stockLevel.groupBy({ by: ['itemId'], where: { organizationId, itemId: { in: itemIds } }, _sum: { quantity: true } }) : [],
      this.prisma.auditLog.findMany({
        where: { organizationId, entityType: ENTITY, entityId: requisitionId },
        select: { action: true, actorUserId: true, metadata: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      }),
      // The order made from it, if one stands: a cancelled order frees the requisition for another.
      this.prisma.purchaseOrder.findFirst({ where: { organizationId, requisitionId, status: { not: 'CANCELLED' } }, select: { id: true, number: true } }),
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
      lines: requisition.lines.map((line) => ({
        id: line.id,
        item: line.item ? { id: line.item.id, code: line.item.code, name: line.item.name, unit: line.item.unit } : null,
        description: line.description,
        quantity: line.quantity,
        estimatedUnitCostCents: line.estimatedUnitCostCents,
        onHand: line.item ? (onHand.get(line.item.id) ?? 0) : null,
        reorderLevel: line.item?.reorderLevel ?? null,
      })),
      quotes: requisition.quotes,
      decidedBy: requisition.decidedBy?.displayName ?? null,
      decidedAt: requisition.decidedAt?.toISOString() ?? null,
      history,
      order,
      can: this.actions(user, requisition, summary.estimatedTotalCents, settings),
      settings,
    };
  }

  /** What the form chooses from: four reads, whatever the number of items. */
  async choices(user: AuthenticatedUser): Promise<RequisitionChoices> {
    const organizationId = user.organizationId;
    const [items, levels, places, companies, vendors, settings] = await Promise.all([
      this.prisma.stockItem.findMany({
        where: { organizationId, active: true },
        select: { id: true, code: true, name: true, unit: true, xeroTenantId: true, reorderLevel: true, reorderQuantity: true },
        orderBy: { codeKey: 'asc' },
      }),
      this.prisma.stockLevel.groupBy({ by: ['itemId'], where: { organizationId }, _sum: { quantity: true, valueCents: true } }),
      this.prisma.stockPlace.findMany({ where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: [{ kind: 'asc' }, { nameKey: 'asc' }] }),
      this.companies(organizationId),
      this.prisma.vendor.findMany({ where: { organizationId, active: true }, select: { id: true, name: true }, orderBy: { nameKey: 'asc' } }),
      this.settings(this.prisma, organizationId),
    ]);
    const held = new Map(levels.map((level) => [level.itemId, { quantity: level._sum.quantity ?? 0, valueCents: level._sum.valueCents ?? 0 }]));
    return {
      items: items.map((item) => {
        const level = held.get(item.id) ?? { quantity: 0, valueCents: 0 };
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
        };
      }),
      places,
      companies: companies.connected,
      vendors,
      settings,
    };
  }

  // ── Writing a requisition ───────────────────────────────────────────────

  /**
   * What a requisition names is this office's own, every line asks for an
   * item by its code, and its items are its company's. The database's keys refuse another office's too; this says so
   * plainly, and holds the rules the keys cannot.
   */
  private async checked(db: Db, organizationId: string, input: SaveRequisitionInput) {
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
    if (input.quotes.filter((quote) => quote.chosen).length > 1) throw new ApplicationError(400, 'REQUISITION_QUOTES_CHOSEN', 'Only one quote can be the chosen one.');
  }

  private fields(input: SaveRequisitionInput) {
    return {
      xeroTenantId: input.xeroTenantId ?? null,
      neededBy: input.neededBy ? dateOf(input.neededBy) : null,
      deliverToPlaceId: input.deliverToPlaceId ?? null,
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

  /** A draft, the caller's own. */
  async create(user: AuthenticatedUser, input: SaveRequisitionInput): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    const created = await this.prisma.$transaction(async (tx) => {
      await this.checked(tx, organizationId, input);
      const requisition = await tx.purchaseRequisition.create({ data: { organizationId, requestedById: user.id, ...this.fields(input) }, select: { id: true } });
      await this.writeLinesAndQuotes(tx, organizationId, requisition.id, input);
      await this.audit(tx, user, 'PURCHASE_REQUISITION_CREATED', requisition.id, { lines: input.lines.length, totalCents: requisitionTotalCents(input.lines) });
      return requisition;
    });
    return this.detail(user, created.id);
  }

  /** The caller's own, found for a step they alone may take; anybody else's is not there. */
  private async own(db: Db, user: AuthenticatedUser, requisitionId: string) {
    const requisition = await db.purchaseRequisition.findFirst({
      where: { id: requisitionId, organizationId: user.organizationId, requestedById: user.id },
      select: { id: true, number: true, status: true, reason: true, submittedAt: true, lines: { select: { quantity: true, estimatedUnitCostCents: true } }, quotes: { select: { chosen: true } } },
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
      await this.checked(tx, organizationId, input);
      await this.move(tx, organizationId, requisitionId, EDITABLE, this.fields(input));
      await tx.purchaseRequisitionLine.deleteMany({ where: { organizationId, requisitionId } });
      await tx.purchaseRequisitionQuote.deleteMany({ where: { organizationId, requisitionId } });
      await this.writeLinesAndQuotes(tx, organizationId, requisitionId, input);
      await this.audit(tx, user, 'PURCHASE_REQUISITION_CHANGED', requisitionId, { lines: input.lines.length, totalCents: requisitionTotalCents(input.lines) });
    });
    return this.detail(user, requisitionId);
  }

  /** Hands it to the approvers. It takes its number the first time, and keeps it if it comes back and goes again. */
  async submit(user: AuthenticatedUser, requisitionId: string): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const requisition = await this.own(tx, user, requisitionId);
      if (!EDITABLE.includes(requisition.status)) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'This requisition has already been submitted.');
      const problem = requisitionSubmitProblem(requisition, await this.settings(tx, organizationId));
      if (problem) throw new ApplicationError(409, 'REQUISITION_NOT_READY', problem);
      const number = requisition.number ?? requisitionNumber(await nextDocumentNumber(tx, organizationId, 'PR'));
      await this.move(tx, organizationId, requisitionId, EDITABLE, {
        status: Status.SUBMITTED,
        number,
        submittedAt: requisition.submittedAt ?? new Date(),
        decidedById: null,
        decidedAt: null,
        decisionNote: null,
      });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_SUBMITTED', requisitionId, { number, totalCents: requisitionTotalCents(requisition.lines) });
    });
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

  // ── Deciding ────────────────────────────────────────────────────────────

  /**
   * Approve, send back or reject a requisition that is waiting. Never the
   * caller's own; approving above the office's limit needs
   * `purchasing:approve-any`; sending back and rejecting need a note, which
   * the requester reads.
   */
  async decide(user: AuthenticatedUser, requisitionId: string, decision: 'APPROVED' | 'SENT_BACK' | 'REJECTED', input: RequisitionDecisionInput): Promise<RequisitionDetail> {
    const organizationId = user.organizationId;
    const note = text(input.note);
    if (decision !== 'APPROVED' && !note) throw new ApplicationError(400, 'REQUISITION_NOTE_NEEDED', 'Say why, so whoever asked knows what to do next.');
    await this.prisma.$transaction(async (tx) => {
      const requisition = await tx.purchaseRequisition.findFirst({
        where: { id: requisitionId, organizationId, status: { not: Status.DRAFT } },
        select: { number: true, status: true, requestedById: true, lines: { select: { quantity: true, estimatedUnitCostCents: true } } },
      });
      if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
      if (requisition.status !== Status.SUBMITTED) throw new ApplicationError(409, 'REQUISITION_MOVED_ON', 'This requisition is no longer waiting for a decision.');
      if (requisition.requestedById === user.id) throw new ApplicationError(403, 'REQUISITION_OWN', 'You asked for this, so somebody else decides it.');
      const totalCents = requisitionTotalCents(requisition.lines);
      if (decision === 'APPROVED') {
        const { approveBlocked } = this.actions(user, requisition, totalCents, await this.settings(tx, organizationId));
        if (approveBlocked) throw new ApplicationError(403, 'REQUISITION_OVER_LIMIT', approveBlocked);
      }
      await this.move(tx, organizationId, requisitionId, [Status.SUBMITTED], { status: decision, decidedById: user.id, decidedAt: new Date(), decisionNote: note });
      await this.audit(tx, user, `PURCHASE_REQUISITION_${decision}`, requisitionId, { number: requisition.number, totalCents, note });
    });
    return this.detail(user, requisitionId);
  }

  // ── Settings ────────────────────────────────────────────────────────────

  async saveSettings(user: AuthenticatedUser, input: SavePurchasingSettingsInput): Promise<PurchasingSettings> {
    const organizationId = user.organizationId;
    return this.prisma.$transaction(async (tx) => {
      const before = await this.settings(tx, organizationId);
      const data = { approvalLimitCents: input.approvalLimitCents, quotesAboveLimit: input.quotesAboveLimit };
      if (before.approvalLimitCents === data.approvalLimitCents && before.quotesAboveLimit === data.quotesAboveLimit) return before;
      await tx.purchasingSettings.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
      await tx.auditLog.create({
        data: { organizationId, ...auditActor(user), action: 'PURCHASING_SETTINGS_CHANGED', entityType: 'PurchasingSettings', entityId: organizationId, metadata: { from: { ...before }, to: data } },
      });
      return data;
    });
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus as Status, PurchaseRequisitionStatus } from '@prisma/client';
import {
  DEFAULT_PURCHASE_ORDER_EMAIL_CEILING,
  MOST_ORDER_PDF_BYTES,
  OPEN_PURCHASE_ORDER_STATUSES,
  VENDOR_FILES_MAX_BYTES,
  formatFileSize,
  formatMoney,
  billProblems,
  orderGroups,
  formatTaxRate,
  orderSubmitProblem,
  orderTotals,
  purchaseOrderNumber,
  type CancelPurchaseOrderInput,
  type PurchaseOrderActions,
  type PurchaseOrderDecisionInput,
  type PurchaseOrderDetail,
  type PurchaseOrderFrom,
  type PurchaseOrderList,
  type PurchaseOrdersMade,
  type PurchaseOrderRow,
  type SavePurchaseOrderInput,
  type SendPurchaseOrderInput,
  type VendorBillView,
  type VendorPaymentMethod,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDayBounds } from '../common/business-day';
import { ceilingFrom } from '../common/daily-allowance';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { PurchasingFileStorageService } from '../common/purchasing-file-storage.service';
import { MailService } from '../mail/mail.service';
import { nextDocumentNumber, readPurchasingSettings } from './purchasing.service';
import { vendorFilesOf } from './requisition-files';

/**
 * Purchase orders (2026-11-19, phase 3 of the inventory and purchasing plan).
 *
 * Who may do what is decided here, not by the page:
 * - a holder of `purchasing:order` makes an order from an approved
 *   requisition, changes it while it is a draft, submits it, sends it to the
 *   vendor once approved, and cancels it;
 * - a holder of `purchasing:approve` approves it or sends it back -- never
 *   one they made, and above the office's limit only with
 *   `purchasing:approve-any`. The database refuses the maker's approval too;
 * - whoever asked for the requisition may look at the order made from it.
 *
 * Every step is one guarded status change and is audited; the audit log is
 * the order's history. An order moves no stock.
 *
 * The one billed call is the email to the vendor. One a press, to one
 * address, never from a page load or a loop: written down first under the
 * page's key, so the same press never sends twice, and counted against the
 * office's ceiling for the Texas day (PURCHASE_ORDER_EMAIL_DAILY_CEILING, 50).
 */

const ORDER = 'purchasing:order';
const APPROVE = 'purchasing:approve';
const APPROVE_ANY = 'purchasing:approve-any';
const RECEIVE = 'purchasing:receive';
const BILLS = 'purchasing:bills';
const ENTITY = 'PurchaseOrder';
const CLOSED_SHOWN = 200;
const CANCELLABLE: Status[] = [Status.DRAFT, Status.AWAITING_APPROVAL, Status.APPROVED, Status.SENT];
const SENDABLE: Status[] = [Status.APPROVED, Status.SENT];
/** Goods can still arrive for it (phase 4). */
const RECEIVABLE: Status[] = [Status.APPROVED, Status.SENT, Status.PARTLY_RECEIVED];
/** Its bill can be entered: from approval until it is closed. */
const BILLABLE: Status[] = [...RECEIVABLE, Status.RECEIVED];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Db = Prisma.TransactionClient;
const may = (user: AuthenticatedUser, permission: string) => (user.permissions as readonly string[]).includes(permission);
const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const dayOf = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
const taken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ROW = {
  id: true,
  number: true,
  status: true,
  xeroTenantId: true,
  expectedOn: true,
  terms: true,
  taxBasisPoints: true,
  notes: true,
  createdById: true,
  createdAt: true,
  approvedAt: true,
  decisionNote: true,
  sentAt: true,
  cancelReason: true,
  shortCloseReason: true,
  bill: {
    select: {
      billNumber: true,
      billDate: true,
      totalCents: true,
      status: true,
      enteredById: true,
      approvedAt: true,
      overrideReason: true,
      paidOn: true,
      paymentMethod: true,
      paymentReference: true,
      enteredBy: { select: { displayName: true } },
      approvedBy: { select: { displayName: true } },
      paidBy: { select: { displayName: true } },
      lines: { select: { orderLineId: true, quantity: true, unitPriceCents: true } },
    },
  },
  createdBy: { select: { displayName: true } },
  approvedBy: { select: { displayName: true } },
  vendor: { select: { id: true, name: true, number: true, contactName: true, email: true, phone: true } },
  deliverTo: { select: { id: true, name: true, code: true } },
  requisition: { select: { id: true, number: true, requestedById: true, lines: { select: { itemId: true, quantity: true } } } },
  lines: { orderBy: { position: 'asc' }, select: { id: true, quantity: true, unitPriceCents: true, receivedQuantity: true, item: { select: { id: true, code: true, name: true, unit: true } } } },
} satisfies Prisma.PurchaseOrderSelect;
type Order = Prisma.PurchaseOrderGetPayload<{ select: typeof ROW }>;

/** A company's name and purchaser code, by its Xero tenant. */
type Companies = ReadonlyMap<string, { name: string; purchaserCode: string | null }>;

function row(order: Order, companies: Companies): PurchaseOrderRow {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    vendor: order.vendor ? { id: order.vendor.id, name: order.vendor.name, number: order.vendor.number } : null,
    requisition: { id: order.requisition.id, number: order.requisition.number },
    company: order.xeroTenantId ? { tenantId: order.xeroTenantId, name: companies.get(order.xeroTenantId)?.name ?? 'A company', purchaserCode: companies.get(order.xeroTenantId)?.purchaserCode ?? null } : null,
    expectedOn: dayOf(order.expectedOn),
    lineCount: order.lines.length,
    totalCents: orderTotals(order.lines, order.taxBasisPoints).totalCents,
    madeBy: { id: order.createdById, name: order.createdBy.displayName },
    createdAt: order.createdAt.toISOString(),
    sentAt: order.sentAt?.toISOString() ?? null,
  };
}

/** The history's words for each audited step. */
const STEP: Record<string, string> = {
  PURCHASE_ORDER_CREATED: 'made it from the requisition',
  PURCHASE_ORDER_CHANGED: 'changed it',
  PURCHASE_ORDER_SUBMITTED: 'submitted it for approval',
  PURCHASE_ORDER_APPROVED: 'approved it',
  PURCHASE_ORDER_SENT_BACK: 'sent it back',
  PURCHASE_ORDER_SENT: 'emailed it to the vendor',
  PURCHASE_ORDER_SEND_FAILED: 'tried to email it, and it was not sent',
  PURCHASE_ORDER_CANCELLED: 'cancelled it',
  GOODS_RECEIVED: 'received goods',
  GOODS_RECEIPT_REVERSED: 'reversed a receipt',
  PURCHASE_ORDER_CLOSED_SHORT: 'finished it with what has arrived',
  VENDOR_BILL_ENTERED: "entered the vendor's bill",
  VENDOR_BILL_APPROVED: 'approved the bill for payment',
  VENDOR_BILL_APPROVED_DESPITE_MISMATCH: 'approved the bill although it does not match',
  VENDOR_BILL_PAID: 'recorded the payment',
  VENDOR_BILL_SENT_TO_XERO: 'sent the bill to Xero as a draft',
  VENDOR_BILL_PAYMENT_SENT_TO_XERO: 'sent the payment to Xero',
  PURCHASE_ORDER_CLOSED: 'closed it: received and paid',
};

/** The order's PDF as the browser made it: checked to be a PDF, and small, before it rides on the email. */
export function orderPdf(input: SendPurchaseOrderInput['attachment']) {
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.length > MOST_ORDER_PDF_BYTES) throw new ApplicationError(422, 'PURCHASE_ORDER_SEND_INVALID', 'The PDF is too large to attach.');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ApplicationError(422, 'PURCHASE_ORDER_SEND_INVALID', 'The attachment is not a PDF.');
  const stem =
    input.fileName
      .replace(/\.pdf$/i, '')
      .replace(/[^\w .,()#&'-]+/g, ' ')
      .replace(/\.{2,}/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+/, '')
      .trim()
      .slice(0, 100) || 'Purchase order';
  return { name: `${stem}.pdf`, contentType: 'application/pdf', contentBase64: bytes.toString('base64') };
}

@Injectable()
export class PurchaseOrdersService {
  private readonly logger = new Logger(PurchaseOrdersService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(MailService) private readonly mail: MailService,
    @Inject(PurchasingFileStorageService) private readonly files: PurchasingFileStorageService,
  ) {}

  /** Everybody's, for whoever makes, approves, receives or bills orders; for anybody else, the orders made from their own requisitions. */
  private visible(user: AuthenticatedUser): Prisma.PurchaseOrderWhereInput {
    return [ORDER, APPROVE, RECEIVE, BILLS].some((permission) => may(user, permission)) ? {} : { requisition: { requestedById: user.id } };
  }

  private async companyNames(organizationId: string): Promise<Companies> {
    const rows = await this.prisma.xeroOrganisation.findMany({ where: { organizationId }, select: { xeroTenantId: true, name: true, purchaserCode: true } });
    return new Map(rows.map((entry) => [entry.xeroTenantId, { name: entry.name, purchaserCode: entry.purchaserCode }]));
  }

  /** What the caller may do with it now. The page draws its buttons from this, and each action checks the same again. */
  private actions(
    user: AuthenticatedUser,
    order: Pick<Order, 'status' | 'createdById'>,
    totalCents: number,
    approvalLimitCents: number,
    bill: { status: string; enteredById: string } | null = null,
  ): PurchaseOrderActions {
    const purchaser = may(user, ORDER);
    const mine = order.createdById === user.id;
    const waiting = order.status === Status.AWAITING_APPROVAL && may(user, APPROVE);
    const approveBlocked = !waiting
      ? null
      : mine
        ? 'You made this order, so somebody else approves it.'
        : totalCents > approvalLimitCents && !may(user, APPROVE_ANY)
          ? `It is above the ${formatMoney(approvalLimitCents)} approval limit, so it needs somebody who may approve any amount.`
          : null;
    return {
      edit: purchaser && order.status === Status.DRAFT,
      submit: purchaser && order.status === Status.DRAFT,
      approve: waiting && !approveBlocked,
      sendBack: waiting && !mine,
      send: purchaser && SENDABLE.includes(order.status),
      cancel: purchaser && CANCELLABLE.includes(order.status),
      receive: may(user, RECEIVE) && RECEIVABLE.includes(order.status),
      reverseReceipt: may(user, RECEIVE) && (order.status === Status.PARTLY_RECEIVED || order.status === Status.RECEIVED) && (!bill || bill.status === 'HELD' || bill.status === 'MATCHED'),
      bill: may(user, BILLS) && BILLABLE.includes(order.status) && (!bill || bill.status === 'HELD' || bill.status === 'MATCHED'),
      approveBill: may(user, BILLS) && bill?.status === 'MATCHED',
      // Never whoever entered it: a second person looks at a bill that does not match.
      overrideBill: may(user, APPROVE) && may(user, APPROVE_ANY) && bill?.status === 'HELD' && bill.enteredById !== user.id,
      pay: may(user, BILLS) && bill?.status === 'APPROVED',
      closeShort: purchaser && order.status === Status.PARTLY_RECEIVED,
      approveBlocked,
    };
  }

  // ── Reading ─────────────────────────────────────────────────────────────

  async list(user: AuthenticatedUser, show: 'open' | 'closed' = 'open'): Promise<PurchaseOrderList> {
    const organizationId = user.organizationId;
    const open = OPEN_PURCHASE_ORDER_STATUSES as readonly Status[];
    const [orders, companies] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where: { organizationId, status: show === 'open' ? { in: [...open] } : { notIn: [...open] }, AND: [this.visible(user)] },
        select: ROW,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(show === 'closed' ? { take: CLOSED_SHOWN } : {}),
      }),
      this.companyNames(organizationId),
    ]);
    return { orders: orders.map((order) => row(order, companies)) };
  }

  async detail(user: AuthenticatedUser, orderId: string): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id: orderId, organizationId, AND: [this.visible(user)] }, select: ROW });
    if (!order) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
    const [companies, settings, office, deliveries, audits, receipts, vendorFiles] = await Promise.all([
      this.companyNames(organizationId),
      readPurchasingSettings(this.prisma, organizationId),
      this.prisma.invoiceSettings.findUnique({ where: { organizationId }, select: { companyName: true, addressLine1: true, addressLine2: true, phone: true, email: true } }),
      this.prisma.purchaseOrderDelivery.findMany({
        where: { organizationId, orderId },
        select: { id: true, recipient: true, status: true, failure: true, createdAt: true, sentByName: true },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.auditLog.findMany({ where: { organizationId, entityType: ENTITY, entityId: orderId }, select: { action: true, actorUserId: true, metadata: true, createdAt: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.goodsReceipt.findMany({
        where: { organizationId, orderId },
        select: {
          id: true,
          number: true,
          receivedOn: true,
          packingSlip: true,
          note: true,
          createdByName: true,
          createdAt: true,
          reversedAt: true,
          reversedByName: true,
          reverseReason: true,
          lines: { select: { quantity: true, item: { select: { code: true, name: true } }, place: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      vendorFilesOf(this.prisma, organizationId, order.requisition.id),
    ]);
    const actorIds = [...new Set(audits.flatMap((audit) => (audit.actorUserId ? [audit.actorUserId] : [])))];
    const actors = actorIds.length ? await this.prisma.userProfile.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const nameOf = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    const summary = row(order, companies);
    const totals = orderTotals(order.lines, order.taxBasisPoints);
    const requested = new Map(order.requisition.lines.flatMap((line) => (line.itemId ? [[line.itemId, line.quantity] as const] : [])));
    const billed = new Map(order.bill?.lines.map((line) => [line.orderLineId, line]));
    const bill: VendorBillView | null = order.bill
      ? {
          billNumber: order.bill.billNumber,
          billDate: dayOf(order.bill.billDate)!,
          totalCents: order.bill.totalCents,
          status: order.bill.status,
          lines: order.bill.lines,
          // Worked out as it is read, from the order and its receipts as they are now.
          problems: billProblems(
            order.lines.map((line) => ({
              name: line.item.name,
              ordered: line.quantity,
              received: line.receivedQuantity,
              unitPriceCents: line.unitPriceCents,
              billedQuantity: billed.get(line.id)?.quantity ?? 0,
              billedUnitPriceCents: billed.get(line.id)?.unitPriceCents ?? null,
            })),
            order.bill.totalCents,
            order.taxBasisPoints,
          ),
          enteredBy: order.bill.enteredBy.displayName,
          approvedBy: order.bill.approvedBy?.displayName ?? null,
          approvedAt: order.bill.approvedAt?.toISOString() ?? null,
          overrideReason: order.bill.overrideReason,
          paidOn: dayOf(order.bill.paidOn),
          method: order.bill.paymentMethod as VendorPaymentMethod | null,
          reference: order.bill.paymentReference,
          paidBy: order.bill.paidBy?.displayName ?? null,
        }
      : null;
    const from: PurchaseOrderFrom = {
      // The company the stock is for, as its books name it; else the office's own name on its invoices.
      name: summary.company?.name ?? office?.companyName ?? 'TexasRenters.com',
      addressLine1: office?.addressLine1 ?? null,
      addressLine2: office?.addressLine2 ?? null,
      phone: office?.phone ?? null,
      email: office?.email ?? null,
    };
    return {
      ...summary,
      vendorContact: order.vendor ? { contactName: order.vendor.contactName, email: order.vendor.email, phone: order.vendor.phone } : null,
      deliverTo: order.deliverTo,
      terms: order.terms,
      taxBasisPoints: order.taxBasisPoints,
      notes: order.notes,
      lines: order.lines.map((line) => ({ id: line.id, item: line.item, quantity: line.quantity, unitPriceCents: line.unitPriceCents, requestedQuantity: requested.get(line.item.id) ?? 0, receivedQuantity: line.receivedQuantity })),
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      approvedBy: order.approvedBy?.displayName ?? null,
      approvedAt: order.approvedAt?.toISOString() ?? null,
      decisionNote: order.decisionNote,
      cancelReason: order.cancelReason,
      from,
      vendorFiles: vendorFiles.map((file) => ({ id: file.id, fileName: file.fileName, sizeBytes: file.sizeBytes })),
      deliveries: deliveries.map((delivery) => ({
        id: delivery.id,
        recipient: delivery.recipient,
        status: delivery.status as 'PENDING' | 'SENT' | 'FAILED',
        failure: delivery.failure,
        at: delivery.createdAt.toISOString(),
        by: delivery.sentByName,
      })),
      receipts: receipts.map((receipt) => ({
        id: receipt.id,
        number: receipt.number,
        receivedOn: dayOf(receipt.receivedOn)!,
        packingSlip: receipt.packingSlip,
        note: receipt.note,
        by: receipt.createdByName,
        at: receipt.createdAt.toISOString(),
        reversed: receipt.reversedAt ? { by: receipt.reversedByName ?? 'Somebody', at: receipt.reversedAt.toISOString(), reason: receipt.reverseReason ?? '' } : null,
        lines: receipt.lines.map((line) => ({ itemCode: line.item.code, itemName: line.item.name, placeName: line.place.name, quantity: line.quantity })),
      })),
      bill,
      shortCloseReason: order.shortCloseReason,
      history: audits.map((audit) => {
        const note = (audit.metadata as { note?: string | null } | null)?.note;
        return { at: audit.createdAt.toISOString(), by: (audit.actorUserId && nameOf.get(audit.actorUserId)) || 'Somebody', what: `${STEP[audit.action] ?? 'changed it'}${note ? `: ${note}` : ''}` };
      }),
      can: this.actions(user, order, totals.totalCents, settings.approvalLimitCents, order.bill),
      approvalLimitCents: settings.approvalLimitCents,
    };
  }

  // ── Making and changing an order ────────────────────────────────────────

  private audit(db: Db, user: AuthenticatedUser, action: string, entityType: string, entityId: string, metadata: Prisma.InputJsonObject) {
    return db.auditLog.create({ data: { organizationId: user.organizationId, ...auditActor(user), action, entityType, entityId, metadata } });
  }

  /**
   * Draft orders from an approved requisition, one a vendor, as NAV makes them
   * (2026-11-20, part 4): each line goes to its own vendor, else to the chosen
   * quote's, at its estimated price; lines with neither go on one order with
   * no vendor yet, for the purchaser to choose. A vendor no longer in use is
   * treated as none.
   *
   * Made again on a requisition already Ordered, it makes only the orders still
   * missing -- a vendor whose order was cancelled -- and never a second one for
   * a vendor that has one: the database holds that too (one live order a
   * requisition and vendor), so two purchasers pressing at once cannot both.
   */
  async createFromRequisition(user: AuthenticatedUser, requisitionId: string): Promise<PurchaseOrdersMade> {
    const organizationId = user.organizationId;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const requisition = await tx.purchaseRequisition.findFirst({
          where: { id: requisitionId, organizationId, status: { not: PurchaseRequisitionStatus.DRAFT } },
          select: {
            number: true,
            status: true,
            xeroTenantId: true,
            deliverToPlaceId: true,
            lines: { orderBy: { position: 'asc' }, select: { itemId: true, quantity: true, estimatedUnitCostCents: true, vendor: { select: { id: true, number: true, name: true, terms: true, active: true } } } },
            quotes: { where: { chosen: true }, select: { vendor: { select: { id: true, number: true, name: true, terms: true, active: true } } } },
            orders: { where: { status: { not: Status.CANCELLED } }, select: { vendorId: true } },
          },
        });
        if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
        if (requisition.status !== PurchaseRequisitionStatus.APPROVED && requisition.status !== PurchaseRequisitionStatus.ORDERED)
          throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', 'Orders are made from an approved requisition.');
        const quoteVendor = requisition.quotes[0]?.vendor;
        const usable = (vendor: typeof quoteVendor | null) => (vendor?.active ? vendor : null);
        const vendors = new Map(requisition.lines.flatMap((line) => (usable(line.vendor) ? [[line.vendor!.id, line.vendor!] as const] : [])));
        if (usable(quoteVendor)) vendors.set(quoteVendor!.id, quoteVendor!);
        const groups = orderGroups(
          requisition.lines.map((line) => ({ ...line, vendorId: usable(line.vendor)?.id ?? null })),
          usable(quoteVendor)?.id ?? null,
        );
        if (!groups.length) throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', 'This requisition has no line with an item code, so there is nothing to order.');
        const ordered = new Set(requisition.orders.map((order) => order.vendorId));
        const missing = groups.filter((group) => !ordered.has(group.vendorId));
        if (!missing.length) throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', 'Every vendor on this requisition has its order already.');
        if (requisition.status === PurchaseRequisitionStatus.APPROVED) {
          const claimed = await tx.purchaseRequisition.updateMany({ where: { id: requisitionId, organizationId, status: PurchaseRequisitionStatus.APPROVED }, data: { status: PurchaseRequisitionStatus.ORDERED } });
          if (claimed.count !== 1) throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', 'Somebody has just made the orders for this requisition.');
        }

        const made: PurchaseOrdersMade['orders'] = [];
        for (const group of missing) {
          const vendor = group.vendorId ? vendors.get(group.vendorId)! : null;
          const order = await tx.purchaseOrder.create({
            data: {
              organizationId,
              requisitionId,
              vendorId: vendor?.id ?? null,
              terms: vendor?.terms ?? null,
              xeroTenantId: requisition.xeroTenantId,
              deliverToPlaceId: requisition.deliverToPlaceId,
              createdById: user.id,
            },
            select: { id: true },
          });
          await tx.purchaseOrderLine.createMany({
            data: group.lines.map((line, position) => ({ organizationId, orderId: order.id, position, itemId: line.itemId!, quantity: line.quantity, unitPriceCents: line.estimatedUnitCostCents })),
          });
          await this.audit(tx, user, 'PURCHASE_ORDER_CREATED', ENTITY, order.id, { requisition: requisition.number, lines: group.lines.length, vendor: vendor?.name ?? null });
          made.push({ id: order.id, vendor: vendor ? { id: vendor.id, number: vendor.number, name: vendor.name } : null });
        }
        await this.audit(tx, user, 'PURCHASE_REQUISITION_ORDERED', 'PurchaseRequisition', requisitionId, {
          number: requisition.number,
          orders: made.length,
          note: made.map((order) => order.vendor?.name ?? 'no vendor yet').join(', '),
        });
        return { orders: made };
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', 'Somebody has just made these orders. Open the requisition again.');
      throw error;
    }
  }

  private async found(db: Db, user: AuthenticatedUser, orderId: string) {
    const order = await db.purchaseOrder.findFirst({
      where: { id: orderId, organizationId: user.organizationId },
      select: {
        id: true,
        number: true,
        status: true,
        vendorId: true,
        requisitionId: true,
        createdById: true,
        submittedAt: true,
        taxBasisPoints: true,
        vendor: { select: { name: true } },
        lines: { select: { quantity: true, unitPriceCents: true } },
        requisition: { select: { number: true, lines: { select: { itemId: true } } } },
      },
    });
    if (!order) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
    return order;
  }

  /** One status change, made only if the order is still where the caller saw it. */
  private async move(db: Db, organizationId: string, orderId: string, from: readonly Status[], data: Prisma.PurchaseOrderUncheckedUpdateManyInput) {
    const moved = await db.purchaseOrder.updateMany({ where: { id: orderId, organizationId, status: { in: [...from] } }, data });
    if (moved.count !== 1) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order has changed since you opened it. Open it again.');
  }

  /** Replaces the draft's vendor, terms and lines. Its items are its requisition's: nothing is ordered that nobody approved asking for. */
  async update(user: AuthenticatedUser, orderId: string, input: SavePurchaseOrderInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const order = await this.found(tx, user, orderId);
      if (order.status !== Status.DRAFT) throw new ApplicationError(409, 'PURCHASE_ORDER_FIXED', 'An order cannot be changed once it is submitted, unless it is sent back.');
      // An item already on another live order from the same requisition would be bought twice (2026-11-20, one order a vendor).
      const elsewhere = await tx.purchaseOrderLine.findMany({
        where: { organizationId, itemId: { in: input.lines.map((line) => line.itemId) }, order: { requisitionId: order.requisitionId, id: { not: orderId }, status: { not: Status.CANCELLED } } },
        select: { item: { select: { code: true } }, order: { select: { number: true, vendor: { select: { name: true } } } } },
      });
      if (elsewhere.length) {
        const [first] = elsewhere;
        throw new ApplicationError(
          400,
          'PURCHASE_ORDER_ITEM_ON_ANOTHER',
          `${first!.item.code} is already on ${first!.order.number ?? 'another order'}${first!.order.vendor ? ` to ${first!.order.vendor.name}` : ''}, made from the same requisition.`,
        );
      }
      await this.write(tx, user, order, orderId, input);
    }).catch((error: unknown) => {
      if (taken(error)) throw new ApplicationError(409, 'PURCHASE_ORDER_VENDOR_TAKEN', 'Another order from this requisition already goes to that vendor.');
      throw error;
    });
    return this.detail(user, orderId);
  }

  private async write(tx: Db, user: AuthenticatedUser, order: Awaited<ReturnType<PurchaseOrdersService['found']>>, orderId: string, input: SavePurchaseOrderInput) {
    const organizationId = user.organizationId;
    {
      if (input.vendorId && !(await tx.vendor.findFirst({ where: { organizationId, id: input.vendorId, active: true }, select: { id: true } })))
        throw new ApplicationError(400, 'VENDOR_NOT_FOUND', 'That vendor is not in use.');
      if (input.deliverToPlaceId && !(await tx.stockPlace.findFirst({ where: { organizationId, id: input.deliverToPlaceId, active: true }, select: { id: true } })))
        throw new ApplicationError(400, 'PURCHASE_ORDER_PLACE_NOT_FOUND', 'That place is not in use.');
      const asked = new Set(order.requisition.lines.flatMap((line) => (line.itemId ? [line.itemId] : [])));
      const itemIds = input.lines.map((line) => line.itemId);
      if (new Set(itemIds).size !== itemIds.length) throw new ApplicationError(400, 'PURCHASE_ORDER_ITEM_TWICE', 'An item is on the order twice. Put it on one line.');
      if (itemIds.some((itemId) => !asked.has(itemId)))
        throw new ApplicationError(400, 'PURCHASE_ORDER_ITEM_NOT_REQUESTED', `An order holds only the items its requisition asked for${order.requisition.number ? ` (${order.requisition.number})` : ''}.`);
      await this.move(tx, organizationId, orderId, [Status.DRAFT], {
        vendorId: input.vendorId ?? null,
        deliverToPlaceId: input.deliverToPlaceId ?? null,
        expectedOn: input.expectedOn ? dateOf(input.expectedOn) : null,
        terms: text(input.terms),
        taxBasisPoints: input.taxBasisPoints,
        notes: input.notes?.trim() || null,
      });
      await tx.purchaseOrderLine.deleteMany({ where: { organizationId, orderId } });
      if (input.lines.length)
        await tx.purchaseOrderLine.createMany({ data: input.lines.map((line, position) => ({ organizationId, orderId, position, itemId: line.itemId, quantity: line.quantity, unitPriceCents: line.unitPriceCents })) });
      await this.audit(tx, user, 'PURCHASE_ORDER_CHANGED', ENTITY, orderId, { lines: input.lines.length, totalCents: orderTotals(input.lines, input.taxBasisPoints).totalCents });
    }
  }

  /** Hands it to the approvers. It takes its number the first time, and keeps it if it comes back and goes again. */
  async submit(user: AuthenticatedUser, orderId: string): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const order = await this.found(tx, user, orderId);
      if (order.status !== Status.DRAFT) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order has already been submitted.');
      const problem = orderSubmitProblem(order);
      if (problem) throw new ApplicationError(409, 'PURCHASE_ORDER_NOT_READY', problem);
      const number = order.number ?? purchaseOrderNumber(await nextDocumentNumber(tx, organizationId, 'PO'));
      await this.move(tx, organizationId, orderId, [Status.DRAFT], { status: Status.AWAITING_APPROVAL, number, submittedAt: order.submittedAt ?? new Date(), decisionNote: null });
      await this.audit(tx, user, 'PURCHASE_ORDER_SUBMITTED', ENTITY, orderId, { number, totalCents: orderTotals(order.lines, order.taxBasisPoints).totalCents });
    });
    return this.detail(user, orderId);
  }

  // ── Deciding ────────────────────────────────────────────────────────────

  /** Approve an order that is waiting, or send it back to its purchaser with a note. Never one the caller made. */
  async decide(user: AuthenticatedUser, orderId: string, decision: 'APPROVED' | 'SENT_BACK', input: PurchaseOrderDecisionInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    const note = text(input.note);
    if (decision === 'SENT_BACK' && !note) throw new ApplicationError(400, 'PURCHASE_ORDER_NOTE_NEEDED', 'Say what to change, so the purchaser knows.');
    await this.prisma.$transaction(async (tx) => {
      const order = await this.found(tx, user, orderId);
      if (order.status !== Status.AWAITING_APPROVAL) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order is no longer waiting for a decision.');
      if (order.createdById === user.id) throw new ApplicationError(403, 'PURCHASE_ORDER_OWN', 'You made this order, so somebody else decides it.');
      const totalCents = orderTotals(order.lines, order.taxBasisPoints).totalCents;
      if (decision === 'APPROVED') {
        const settings = await readPurchasingSettings(tx, organizationId);
        const { approveBlocked } = this.actions(user, order, totalCents, settings.approvalLimitCents);
        if (approveBlocked) throw new ApplicationError(403, 'PURCHASE_ORDER_OVER_LIMIT', approveBlocked);
        await this.move(tx, organizationId, orderId, [Status.AWAITING_APPROVAL], { status: Status.APPROVED, approvedById: user.id, approvedAt: new Date(), decisionNote: note });
      } else {
        await this.move(tx, organizationId, orderId, [Status.AWAITING_APPROVAL], { status: Status.DRAFT, decisionNote: note });
      }
      await this.audit(tx, user, `PURCHASE_ORDER_${decision}`, ENTITY, orderId, { number: order.number, totalCents, note });
    });
    return this.detail(user, orderId);
  }

  /**
   * Cancels an order, with why. Its requisition is approved again, so another
   * order can be made from it. One already with the vendor is cancelled here
   * only in the console: telling the vendor is the purchaser's to do.
   */
  async cancel(user: AuthenticatedUser, orderId: string, input: CancelPurchaseOrderInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    const reason = text(input.reason);
    if (!reason) throw new ApplicationError(400, 'PURCHASE_ORDER_REASON_NEEDED', 'Say why it is cancelled.');
    await this.prisma.$transaction(async (tx) => {
      const order = await this.found(tx, user, orderId);
      if (!CANCELLABLE.includes(order.status)) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order is already cancelled.');
      await this.move(tx, organizationId, orderId, CANCELLABLE, { status: Status.CANCELLED, cancelledById: user.id, cancelledAt: new Date(), cancelReason: reason });
      // One order a vendor (2026-11-20): the requisition is approved again only once none of its orders is left;
      // while others stand it stays Ordered, and the purchaser can make this vendor's order again.
      const others = await tx.purchaseOrder.count({ where: { organizationId, requisitionId: order.requisitionId, id: { not: orderId }, status: { not: Status.CANCELLED } } });
      if (!others)
        await tx.purchaseRequisition.updateMany({ where: { id: order.requisitionId, organizationId, status: PurchaseRequisitionStatus.ORDERED }, data: { status: PurchaseRequisitionStatus.APPROVED } });
      await this.audit(tx, user, 'PURCHASE_ORDER_CANCELLED', ENTITY, orderId, { number: order.number, note: reason });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_ORDER_CANCELLED', 'PurchaseRequisition', order.requisitionId, { order: order.number, note: reason });
    });
    return this.detail(user, orderId);
  }

  // ── Sending to the vendor ───────────────────────────────────────────────

  /**
   * Emails the approved order to the vendor, with the PDF the browser made.
   * One billed call: one address, one press. Sent again with the same key it
   * sends nothing; past the day's ceiling it is refused before anything goes.
   */
  async send(user: AuthenticatedUser, orderId: string, input: SendPurchaseOrderInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    const to = input.to.trim();
    if (!EMAIL.test(to)) throw new ApplicationError(422, 'PURCHASE_ORDER_SEND_INVALID', 'That is not an email address.');
    const attachment = orderPdf(input.attachment);
    const message = input.message?.trim() || null;

    const prior = await this.prisma.purchaseOrderDelivery.findFirst({ where: { organizationId, clientRequestId: input.clientRequestId }, select: { orderId: true } });
    if (prior) {
      if (prior.orderId !== orderId) throw new ApplicationError(409, 'PURCHASE_ORDER_SEND_REUSED', 'That send was already made for another order.');
      return this.detail(user, orderId);
    }
    const order = await this.found(this.prisma, user, orderId);
    if (!SENDABLE.includes(order.status)) throw new ApplicationError(409, 'PURCHASE_ORDER_NOT_SENDABLE', 'An order is sent to the vendor once it is approved.');

    // The requisition's files ticked for the vendor go too (2026-11-20). Read
    // before the email is claimed, so too many, or one that cannot be read,
    // costs nothing and uses none of the day's emails. One storage read a file.
    const ticked = await vendorFilesOf(this.prisma, organizationId, order.requisitionId);
    const tickedBytes = ticked.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (tickedBytes > VENDOR_FILES_MAX_BYTES)
      throw new ApplicationError(
        422,
        'PURCHASE_ORDER_FILES_TOO_BIG',
        `The files ticked for the vendor come to ${formatFileSize(tickedBytes)}, and one email carries at most ${formatFileSize(VENDOR_FILES_MAX_BYTES)} beside the PDF. Untick some on the requisition, or send them on their own.`,
      );
    const extra = await Promise.all(
      ticked.map(async (file) => {
        const bytes = await this.files.get(file.storageKey).catch(() => {
          throw new ApplicationError(502, 'PURCHASE_ORDER_FILE_UNREADABLE', `${file.fileName}, ticked for the vendor, could not be read just now. Try again, or untick it.`);
        });
        return { name: file.fileName, contentType: file.contentType, contentBase64: bytes.toString('base64') };
      }),
    );

    const deliveryId = await this.claimEmail(user, orderId, to, message, input.clientRequestId);
    // The same press, sent twice at once: the other request is sending it.
    if (!deliveryId) return this.detail(user, orderId);

    const detail = await this.detail(user, orderId);
    // Outside any transaction, so nothing waits on a lock while the provider answers.
    const result = await this.mail.sendPurchaseOrder({
      to,
      subject: `Purchase order ${order.number} from ${detail.from.name}`,
      title: `Purchase order ${order.number}`,
      html: [
        `<p>${escape(detail.from.name)} has sent you purchase order <strong>${escape(order.number ?? '')}</strong>, attached as a PDF${extra.length ? `, with ${extra.length === 1 ? 'one more file' : `${extra.length} more files`}` : ''}.</p>`,
        `<p>Total ${escape(formatMoney(detail.totalCents))}${detail.taxBasisPoints ? `, including ${escape(formatTaxRate(detail.taxBasisPoints))} sales tax` : ''}.${detail.expectedOn ? ` Expected by ${escape(detail.expectedOn)}.` : ''}</p>`,
        message ? `<p>${escape(message).replace(/\n/g, '<br>')}</p>` : '',
      ].join(''),
      replyTo: detail.from.email,
      attachments: [attachment, ...extra],
    });
    const sent = result.status === 'SENT';
    const failure = sent ? null : result.status === 'NOT_CONFIGURED' ? 'Email is not set up for the console yet.' : 'The mail provider did not take it.';
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrderDelivery.update({ where: { id: deliveryId }, data: { status: sent ? 'SENT' : 'FAILED', failure, sentAt: sent ? new Date() : null } });
      // The first email that goes is what makes it Sent; one sent again stays as it is.
      if (sent) await tx.purchaseOrder.updateMany({ where: { id: orderId, organizationId, status: Status.APPROVED }, data: { status: Status.SENT, sentAt: new Date() } });
      await this.audit(tx, user, sent ? 'PURCHASE_ORDER_SENT' : 'PURCHASE_ORDER_SEND_FAILED', ENTITY, orderId, { number: order.number, deliveryId, to, files: ticked.map((file) => file.fileName) });
    });
    if (!sent) {
      this.logger.warn({ event: 'purchase_order_email_not_sent', orderId });
      throw new ApplicationError(502, 'PURCHASE_ORDER_EMAIL_FAILED', `${failure} The order was not sent.`);
    }
    return this.detail(user, orderId);
  }

  /**
   * Writes the email down if the day has room for it, and answers its id;
   * null when the key was already used. Counted and claimed under one lock, so
   * two sends at once cannot both fit under the ceiling, and counted from what
   * was sent rather than held in memory, so a restart does not reset it.
   */
  private async claimEmail(user: AuthenticatedUser, orderId: string, recipient: string, message: string | null, clientRequestId: string): Promise<string | null> {
    const organizationId = user.organizationId;
    const ceiling = ceilingFrom('PURCHASE_ORDER_EMAIL_DAILY_CEILING', DEFAULT_PURCHASE_ORDER_EMAIL_CEILING);
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`purchase-order-email:${organizationId}`}, 0))::text AS locked`;
        const used = await tx.purchaseOrderDelivery.count({ where: { organizationId, createdAt: { gte: businessDayBounds().start }, status: { in: ['PENDING', 'SENT'] } } });
        if (used + 1 > ceiling)
          throw new ApplicationError(429, 'PURCHASE_ORDER_EMAIL_CEILING', `The office has sent ${used} of its ${ceiling} purchase order emails today. More can go tomorrow.`);
        const delivery = await tx.purchaseOrderDelivery.create({
          data: { organizationId, orderId, recipient, message, clientRequestId, sentById: user.principalType === 'API_KEY' ? null : user.id, sentByName: user.displayName },
          select: { id: true },
        });
        return delivery.id;
      });
    } catch (error) {
      if (taken(error)) return null;
      throw error;
    }
  }
}

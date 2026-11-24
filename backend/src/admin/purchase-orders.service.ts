import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus as Status, PurchaseRequisitionStatus } from '@prisma/client';
import {
  DEFAULT_PURCHASE_ORDER_EMAIL_CEILING,
  MOST_ORDER_PDF_BYTES,
  MOST_PENDING_LINES_ORDERED,
  allocateReceived,
  requisitionStage,
  OPEN_PURCHASE_ORDER_STATUSES,
  VENDOR_FILES_MAX_BYTES,
  formatFileSize,
  actsForCompany,
  approvalRefusal,
  companyRefusal,
  formatMoney,
  orderChangeNeedsApproval,
  billProblems,
  formatTaxRate,
  orderSubmitProblem,
  orderTotals,
  type CancelPurchaseOrderInput,
  type MakePurchaseOrdersInput,
  type PendingOrderLines,
  type PurchaseOrderRequisition,
  type PurchaseOrderShare,
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
  type ApprovalStep,
  type PurchasingStanding,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDayBounds } from '../common/business-day';
import { ceilingFrom } from '../common/daily-allowance';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { shownItem } from './deleted-items';
import { PurchasingFileStorageService } from '../common/purchasing-file-storage.service';
import { MailService } from '../mail/mail.service';
import { nextDocumentCode, readPurchasingSetup, readStanding } from './purchasing-settings';
import { vendorFilesOf } from './requisition-files';

/**
 * Purchase orders (2026-11-19, phase 3 of the inventory and purchasing plan).
 *
 * Who may do what is decided here, not by the page:
 * - a holder of `purchasing:order` makes an order from an approved
 *   requisition, changes it while it is a draft, submits it, sends it to the
 *   vendor once approved, and cancels it;
 * - a holder of `purchasing:approve` approves it or sends it back, within
 *   their limit and the office's approval steps. An approver may approve one
 *   they made (the office, 2026-11-21), audited as their own; they send back
 *   only somebody else's;
 * - whoever asked for a requisition may look at an order made from it.
 *
 * An order may carry the lines of several requisitions (the office,
 * 2026-11-23): the purchaser ticks approved lines on Pending Processing and
 * each vendor and company gets one order. Which requisition lines it carries,
 * and how many of each, are its sources (PurchaseOrderSource), matched to its
 * lines by item and place; a requisition line is on one live order at most
 * (the database holds that). What arrives goes to the shares oldest
 * requisition first. `requisitionId` is the oldest requisition on it.
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
/** The purchasing manager's (the office, 2026-11-21): approving orders, apart from approving requisitions. */
const APPROVE_ORDERS = 'purchasing:approve-orders';
const APPROVE_ANY = 'purchasing:approve-any';
const RECEIVE = 'purchasing:receive';
const BILLS = 'purchasing:bills';
const ENTITY = 'PurchaseOrder';
const CLOSED_SHOWN = 200;
const CANCELLABLE: Status[] = [Status.DRAFT, Status.AWAITING_APPROVAL, Status.APPROVED, Status.SENT];
const SENDABLE: Status[] = [Status.APPROVED, Status.SENT];
/** An approved order is changed before anything arrives for it (Purchasing Setup, 2026-11-20). */
const CHANGEABLE: Status[] = [Status.APPROVED, Status.SENT];
/** Goods can still arrive for it (phase 4). */
const RECEIVABLE: Status[] = [Status.APPROVED, Status.SENT, Status.PARTLY_RECEIVED];
/** Its bill can be entered: from approval until it is closed. */
const BILLABLE: Status[] = [...RECEIVABLE, Status.RECEIVED];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Db = Prisma.TransactionClient;
/** What an order's buttons and approval are held to (Purchasing Setup): the steps, whether approvers decide only for their own companies, and the caller's standing. */
type OrderRules = { steps: readonly ApprovalStep[]; ownCompaniesOnly: boolean; standing: PurchasingStanding };
const may = (user: AuthenticatedUser, permission: string) => (user.permissions as readonly string[]).includes(permission);

/** Everybody's, for whoever makes, approves, receives or bills orders; for anybody else, the orders made from their own requisitions. */
export function visiblePurchaseOrders(user: AuthenticatedUser): Prisma.PurchaseOrderWhereInput {
  return [ORDER, APPROVE, APPROVE_ORDERS, RECEIVE, BILLS].some((permission) => may(user, permission))
    ? {}
    : { OR: [{ requisition: { requestedById: user.id } }, { sources: { some: { requisition: { requestedById: user.id } } } }] };
}
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
  requisition: { select: { id: true, number: true, requestedById: true } },
  lines: {
    orderBy: { position: 'asc' },
    select: { id: true, quantity: true, unitPriceCents: true, receivedQuantity: true, placeId: true, place: { select: { id: true, name: true, code: true } }, item: { select: { id: true, code: true, name: true, unit: true, deletedAt: true } } },
  },
  // The requisition lines it carries (2026-11-23), oldest requisition first: what arrives goes to them in that order.
  sources: {
    orderBy: [{ requisition: { createdAt: 'asc' } }, { createdAt: 'asc' }, { id: 'asc' }],
    select: {
      requisitionId: true,
      itemId: true,
      placeId: true,
      quantity: true,
      releasedAt: true,
      requisition: { select: { id: true, number: true } },
      requisitionLine: { select: { department: { select: { code: true } } } },
    },
  },
} satisfies Prisma.PurchaseOrderSelect;
type Order = Prisma.PurchaseOrderGetPayload<{ select: typeof ROW }>;

/** A company's name and purchaser code, by its Xero tenant. */
type Companies = ReadonlyMap<string, { name: string; purchaserCode: string | null }>;

/** The shares it carries now: a cancelled order still shows what it carried. */
const sharesOf = (order: Pick<Order, 'status' | 'sources'>) => (order.status === Status.CANCELLED ? order.sources : order.sources.filter((source) => !source.releasedAt));

/** Every requisition it carries lines of, oldest first; an order made before 2026-11-23 with none written, its own. */
function requisitionsOf(order: Pick<Order, 'status' | 'sources' | 'requisition'>): { id: string; number: string | null }[] {
  const seen = new Map<string, { id: string; number: string | null }>();
  for (const source of sharesOf(order)) if (!seen.has(source.requisitionId)) seen.set(source.requisitionId, source.requisition);
  return seen.size ? [...seen.values()] : [{ id: order.requisition.id, number: order.requisition.number }];
}

function row(order: Order, companies: Companies): PurchaseOrderRow {
  return {
    id: order.id,
    number: order.number,
    status: order.status,
    vendor: order.vendor ? { id: order.vendor.id, name: order.vendor.name, number: order.vendor.number } : null,
    requisition: { id: order.requisition.id, number: order.requisition.number },
    requisitions: requisitionsOf(order),
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
  PURCHASE_ORDER_CHANGED_AFTER_APPROVAL: 'changed it after it was approved',
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

  private visible(user: AuthenticatedUser): Prisma.PurchaseOrderWhereInput {
    return visiblePurchaseOrders(user);
  }

  private async companyNames(organizationId: string): Promise<Companies> {
    const rows = await this.prisma.xeroOrganisation.findMany({ where: { organizationId }, select: { xeroTenantId: true, name: true, purchaserCode: true } });
    return new Map(rows.map((entry) => [entry.xeroTenantId, { name: entry.name, purchaserCode: entry.purchaserCode }]));
  }

  /** What the caller may do with it now. The page draws its buttons from this, and each action checks the same again. */
  private actions(
    user: AuthenticatedUser,
    order: Pick<Order, 'status' | 'createdById' | 'xeroTenantId'>,
    totalCents: number,
    rules: OrderRules,
    bill: { status: string; enteredById: string } | null = null,
  ): PurchaseOrderActions {
    // Only for the companies Setup gives the caller (Purchasing Setup, 2026-11-21): ordering, receiving, bills.
    const acts = actsForCompany(rules.standing, order.xeroTenantId);
    const decides = !rules.ownCompaniesOnly || acts;
    const purchaser = may(user, ORDER) && acts;
    const mine = order.createdById === user.id;
    // The purchasing manager approves an order before the purchaser sends it (the office, 2026-11-21).
    const waiting = order.status === Status.AWAITING_APPROVAL && may(user, APPROVE_ORDERS);
    // An approver approves one they made or changed as anybody else's (the office, 2026-11-21): within their limit, the step and their companies.
    const approveBlocked = !waiting ? null : approvalRefusal(rules.standing, rules.steps, totalCents, order.xeroTenantId, rules.ownCompaniesOnly);
    return {
      edit: purchaser && order.status === Status.DRAFT,
      // An approved order nothing has arrived for, and no bill is entered against (Purchasing Setup, 2026-11-20).
      change: purchaser && CHANGEABLE.includes(order.status) && !bill,
      submit: purchaser && order.status === Status.DRAFT,
      approve: waiting && !approveBlocked,
      sendBack: waiting && !mine && decides,
      send: purchaser && SENDABLE.includes(order.status),
      cancel: purchaser && CANCELLABLE.includes(order.status),
      receive: may(user, RECEIVE) && acts && RECEIVABLE.includes(order.status),
      reverseReceipt: may(user, RECEIVE) && acts && (order.status === Status.PARTLY_RECEIVED || order.status === Status.RECEIVED) && (!bill || bill.status === 'HELD' || bill.status === 'MATCHED'),
      bill: may(user, BILLS) && acts && BILLABLE.includes(order.status) && (!bill || bill.status === 'HELD' || bill.status === 'MATCHED'),
      approveBill: may(user, BILLS) && acts && bill?.status === 'MATCHED',
      // Somebody who may approve any amount, whoever entered it (the office, 2026-11-21): audited as their own when it is.
      overrideBill: may(user, APPROVE_ORDERS) && may(user, APPROVE_ANY) && acts && bill?.status === 'HELD',
      pay: may(user, BILLS) && acts && bill?.status === 'APPROVED',
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

  /** Requests to Approve (the office, 2026-11-21): the orders waiting that the caller, a purchasing manager, may approve now, the longest waiting first. */
  async toApprove(user: AuthenticatedUser): Promise<PurchaseOrderRow[]> {
    if (!may(user, APPROVE_ORDERS)) return [];
    const organizationId = user.organizationId;
    const [orders, companies, setup, standing] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { organizationId, status: Status.AWAITING_APPROVAL }, select: ROW, orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }], take: CLOSED_SHOWN }),
      this.companyNames(organizationId),
      readPurchasingSetup(this.prisma, organizationId),
      readStanding(this.prisma, user),
    ]);
    const rules = { steps: setup.settings.steps, ownCompaniesOnly: setup.approvals.approverOwnCompaniesOnly, standing };
    return orders.filter((order) => this.actions(user, order, orderTotals(order.lines, order.taxBasisPoints).totalCents, rules).approve).map((order) => row(order, companies));
  }

  async detail(user: AuthenticatedUser, orderId: string): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id: orderId, organizationId, AND: [this.visible(user)] }, select: ROW });
    if (!order) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
    const [companies, setup, standing, office, deliveries, audits, receipts, vendorFiles] = await Promise.all([
      this.companyNames(organizationId),
      readPurchasingSetup(this.prisma, organizationId),
      readStanding(this.prisma, user),
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
          lines: { select: { quantity: true, item: { select: { code: true, name: true, deletedAt: true } }, place: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      vendorFilesOf(
        this.prisma,
        organizationId,
        requisitionsOf(order).map((requisition) => requisition.id),
      ),
    ]);
    // Each requisition on it (2026-11-23): who asked, its lines here of all, and where it is.
    const onIt = requisitionsOf(order);
    const requisitions = await this.prisma.purchaseRequisition.findMany({
      where: { organizationId, id: { in: onIt.map((requisition) => requisition.id) } },
      select: {
        id: true,
        number: true,
        status: true,
        requestedBy: { select: { displayName: true } },
        department: { select: { code: true } },
        _count: { select: { lines: true } },
        orderSources: { where: { releasedAt: null }, select: { order: { select: { status: true } } } },
      },
    });
    const requisitionOf = new Map(requisitions.map((requisition) => [requisition.id, requisition]));
    const actorIds = [...new Set(audits.flatMap((audit) => (audit.actorUserId ? [audit.actorUserId] : [])))];
    const actors = actorIds.length ? await this.prisma.userProfile.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } }) : [];
    const nameOf = new Map(actors.map((actor) => [actor.id, actor.displayName]));
    const summary = row(order, companies);
    const totals = orderTotals(order.lines, order.taxBasisPoints);
    const shares = sharesOf(order);
    const sharesFor = (line: Order['lines'][number]) => shares.filter((share) => share.itemId === line.item.id && share.placeId === line.placeId);
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
      lines: order.lines.map((line) => {
        const its = sharesFor(line);
        const arrived = allocateReceived(line.receivedQuantity, its);
        const lineShares: PurchaseOrderShare[] = its.map((share, index) => ({
          requisition: share.requisition,
          department: share.requisitionLine.department?.code ?? requisitionOf.get(share.requisitionId)?.department?.code ?? null,
          quantity: share.quantity,
          receivedQuantity: arrived[index]!,
        }));
        return {
          id: line.id,
          item: shownItem(line.item),
          place: line.place,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          requestedQuantity: its.reduce((sum, share) => sum + share.quantity, 0),
          receivedQuantity: line.receivedQuantity,
          shares: lineShares,
        };
      }),
      requisitionsOn: onIt.flatMap((one): PurchaseOrderRequisition[] => {
        const requisition = requisitionOf.get(one.id);
        if (!requisition) return [];
        return [
          {
            id: requisition.id,
            number: requisition.number,
            requestedBy: requisition.requestedBy.displayName,
            department: requisition.department?.code ?? null,
            linesHere: shares.filter((share) => share.requisitionId === requisition.id).length,
            lineCount: requisition._count.lines,
            stage: requisitionStage(
              requisition.status,
              requisition.orderSources.map((source) => source.order.status),
            ),
          },
        ];
      }),
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
        lines: receipt.lines.map((line) => ({ itemCode: line.item.code, itemName: shownItem(line.item).name, placeName: line.place.name, quantity: line.quantity })),
      })),
      bill,
      shortCloseReason: order.shortCloseReason,
      history: audits.map((audit) => {
        const { note, requisitions: from } = (audit.metadata ?? {}) as { note?: string | null; requisitions?: string[] };
        // Made on Pending Processing (2026-11-23): which requisitions it was made from.
        const what = audit.action === 'PURCHASE_ORDER_CREATED' && from?.length ? `made it from ${from.length === 1 ? from[0] : `${from.slice(0, -1).join(', ')} and ${from.at(-1)}`}` : (STEP[audit.action] ?? 'changed it');
        return { at: audit.createdAt.toISOString(), by: (audit.actorUserId && nameOf.get(audit.actorUserId)) || 'Somebody', what: `${what}${note ? `: ${note}` : ''}` };
      }),
      can: this.actions(user, order, totals.totalCents, { steps: setup.settings.steps, ownCompaniesOnly: setup.approvals.approverOwnCompaniesOnly, standing }, order.bill),
      approvalSteps: setup.settings.steps,
      reapproveChangedOrders: setup.approvals.reapproveChangedOrders,
    };
  }

  // ── Making and changing an order ────────────────────────────────────────

  private audit(db: Db, user: AuthenticatedUser, action: string, entityType: string, entityId: string, metadata: Prisma.InputJsonObject) {
    return db.auditLog.create({ data: { organizationId: user.organizationId, ...auditActor(user), action, entityType, entityId, metadata } });
  }

  /**
   * Pending Processing (the office, 2026-11-23): every approved requisition
   * line not on a live order yet, oldest requisition first, for the companies
   * the purchaser acts for. Each says the vendor it would go to -- its own,
   * else its requisition's chosen quote's -- and the place it goes.
   */
  async pendingLines(user: AuthenticatedUser): Promise<PendingOrderLines> {
    const organizationId = user.organizationId;
    const vendorSelect = { select: { id: true, number: true, name: true, active: true } } as const;
    const [lines, vendors, companies, standing] = await Promise.all([
      this.prisma.purchaseRequisitionLine.findMany({
        where: {
          organizationId,
          itemId: { not: null },
          requisition: { status: { in: [PurchaseRequisitionStatus.APPROVED, PurchaseRequisitionStatus.ORDERED] } },
          orderSources: { none: { releasedAt: null } },
        },
        select: {
          id: true,
          quantity: true,
          estimatedUnitCostCents: true,
          expectedOn: true,
          notes: true,
          item: { select: { id: true, code: true, name: true, unit: true } },
          place: { select: { id: true, name: true, code: true } },
          vendor: vendorSelect,
          department: { select: { code: true } },
          requisition: {
            select: {
              id: true,
              number: true,
              createdAt: true,
              xeroTenantId: true,
              requestedBy: { select: { displayName: true } },
              deliverTo: { select: { id: true, name: true, code: true } },
              quotes: { where: { chosen: true }, select: { vendor: vendorSelect } },
            },
          },
        },
        orderBy: [{ requisition: { createdAt: 'asc' } }, { position: 'asc' }],
        take: 2000,
      }),
      this.prisma.vendor.findMany({ where: { organizationId, active: true }, select: { id: true, number: true, name: true }, orderBy: { name: 'asc' } }),
      this.companyNames(organizationId),
      readStanding(this.prisma, user),
    ]);
    const usable = (vendor: { id: string; number: string | null; name: string; active: boolean } | null | undefined) =>
      vendor?.active ? { id: vendor.id, number: vendor.number, name: vendor.name } : null;
    return {
      lines: lines
        .filter((line) => line.item && actsForCompany(standing, line.requisition.xeroTenantId))
        .map((line) => {
          const company = line.requisition.xeroTenantId ? companies.get(line.requisition.xeroTenantId) : undefined;
          return {
            requisitionLineId: line.id,
            requisition: { id: line.requisition.id, number: line.requisition.number, createdAt: line.requisition.createdAt.toISOString(), requestedBy: line.requisition.requestedBy.displayName },
            company: line.requisition.xeroTenantId ? { tenantId: line.requisition.xeroTenantId, name: company?.name ?? 'A company', purchaserCode: company?.purchaserCode ?? null } : null,
            item: line.item!,
            place: line.place ?? line.requisition.deliverTo,
            quantity: line.quantity,
            estimatedUnitCostCents: line.estimatedUnitCostCents,
            vendor: usable(line.vendor) ?? usable(line.requisition.quotes[0]?.vendor),
            expectedOn: dayOf(line.expectedOn),
            department: line.department?.code ?? null,
            notes: line.notes,
          };
        }),
      vendors,
    };
  }

  /** Make Purchase Orders on Pending Processing (2026-11-23): one draft order for each vendor and company of the lines ticked. */
  async makeOrders(user: AuthenticatedUser, input: MakePurchaseOrdersInput): Promise<PurchaseOrdersMade> {
    const picks = [...new Map(input.lines.map((line) => [line.requisitionLineId, line])).values()];
    if (!picks.length) throw new ApplicationError(400, 'PURCHASE_ORDER_NO_LINES', 'Tick the lines to order.');
    if (picks.length > MOST_PENDING_LINES_ORDERED) throw new ApplicationError(400, 'PURCHASE_ORDER_TOO_MANY_LINES', `One press orders at most ${MOST_PENDING_LINES_ORDERED} lines.`);
    return this.makeAll(user, picks);
  }

  /**
   * Draft orders from an approved requisition, one a vendor, as NAV makes them
   * (2026-11-20, part 4): each of its lines not on a live order goes to its own
   * vendor, else to the chosen quote's, at its estimated price; lines with
   * neither go on one order with no vendor yet. Since 2026-11-23 the same
   * maker as Pending Processing, with this requisition's lines.
   */
  async createFromRequisition(user: AuthenticatedUser, requisitionId: string): Promise<PurchaseOrdersMade> {
    const organizationId = user.organizationId;
    const vendorSelect = { select: { id: true, active: true } } as const;
    const requisition = await this.prisma.purchaseRequisition.findFirst({
      where: { id: requisitionId, organizationId, status: { not: PurchaseRequisitionStatus.DRAFT } },
      select: {
        status: true,
        lines: {
          where: { itemId: { not: null }, orderSources: { none: { releasedAt: null } } },
          orderBy: { position: 'asc' },
          select: { id: true, vendor: vendorSelect },
        },
        quotes: { where: { chosen: true }, select: { vendor: vendorSelect } },
      },
    });
    if (!requisition) throw new ApplicationError(404, 'REQUISITION_NOT_FOUND', 'That requisition is not on the list.');
    if (requisition.status !== PurchaseRequisitionStatus.APPROVED && requisition.status !== PurchaseRequisitionStatus.ORDERED)
      throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', 'Orders are made from an approved requisition.');
    if (!requisition.lines.length) throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', 'Every line of this requisition is on an order already.');
    const quote = requisition.quotes[0]?.vendor;
    return this.makeAll(
      user,
      requisition.lines.map((line) => ({ requisitionLineId: line.id, vendorId: line.vendor?.active ? line.vendor.id : quote?.active ? quote.id : null })),
    );
  }

  /**
   * The orders for the lines picked, each with its vendor: one order a vendor
   * and company, the same item to the same place one line (quantities added,
   * at the oldest requisition's estimate), each line where it goes. Every
   * requisition all of whose lines are now on orders is Ordered. The database
   * holds a requisition line to one live order, so two purchasers pressing at
   * once cannot both order it.
   */
  private async makeAll(user: AuthenticatedUser, picks: readonly { requisitionLineId: string; vendorId: string | null }[]): Promise<PurchaseOrdersMade> {
    const organizationId = user.organizationId;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const lines = await tx.purchaseRequisitionLine.findMany({
          where: { organizationId, id: { in: picks.map((pick) => pick.requisitionLineId) } },
          select: {
            id: true,
            position: true,
            itemId: true,
            quantity: true,
            estimatedUnitCostCents: true,
            placeId: true,
            orderSources: { where: { releasedAt: null }, select: { id: true } },
            requisition: { select: { id: true, number: true, status: true, xeroTenantId: true, deliverToPlaceId: true, createdAt: true } },
          },
        });
        if (lines.length !== picks.length) throw new ApplicationError(404, 'REQUISITION_LINE_NOT_FOUND', 'A line ticked is not on the list any more. Open Pending Processing again.');
        for (const line of lines) {
          const named = line.requisition.number ?? 'A requisition';
          if (line.requisition.status !== PurchaseRequisitionStatus.APPROVED && line.requisition.status !== PurchaseRequisitionStatus.ORDERED)
            throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', `${named} is not approved, so nothing of it is ordered.`);
          if (!line.itemId) throw new ApplicationError(409, 'REQUISITION_NOT_ORDERABLE', `A line of ${named} has no item code, so it is not ordered.`);
          if (line.orderSources.length) throw new ApplicationError(409, 'REQUISITION_LINE_ORDERED', `A line of ${named} is on an order already. Open Pending Processing again.`);
        }
        for (const company of new Set(lines.map((line) => line.requisition.xeroTenantId))) await this.assertActs(tx, user, company);
        const vendorIds = [...new Set(picks.flatMap((pick) => (pick.vendorId ? [pick.vendorId] : [])))];
        const vendors = vendorIds.length
          ? await tx.vendor.findMany({ where: { organizationId, id: { in: vendorIds }, active: true }, select: { id: true, number: true, name: true, terms: true } })
          : [];
        if (vendors.length !== vendorIds.length) throw new ApplicationError(400, 'VENDOR_NOT_FOUND', 'A vendor chosen is not in use.');
        const vendorOf = new Map(vendors.map((vendor) => [vendor.id, vendor]));
        const vendorFor = new Map(picks.map((pick) => [pick.requisitionLineId, pick.vendorId]));
        const placeOf = (line: (typeof lines)[number]) => line.placeId ?? line.requisition.deliverToPlaceId ?? null;

        // One order a vendor and company, its lines oldest requisition first.
        const groups = new Map<string, (typeof lines)[number][]>();
        for (const line of [...lines].sort((a, b) => a.requisition.createdAt.getTime() - b.requisition.createdAt.getTime() || a.position - b.position)) {
          const key = `${line.requisition.xeroTenantId ?? ''}|${vendorFor.get(line.id) ?? ''}`;
          groups.set(key, [...(groups.get(key) ?? []), line]);
        }
        const made: PurchaseOrdersMade['orders'] = [];
        /** The requisitions each order made carries lines of. */
        const carries: Set<string>[] = [];
        for (const group of groups.values()) {
          const vendor = vendorFor.get(group[0]!.id) ? vendorOf.get(vendorFor.get(group[0]!.id)!)! : null;
          const places = new Set(group.map(placeOf));
          const order = await tx.purchaseOrder.create({
            data: {
              organizationId,
              requisitionId: group[0]!.requisition.id,
              vendorId: vendor?.id ?? null,
              terms: vendor?.terms ?? null,
              xeroTenantId: group[0]!.requisition.xeroTenantId,
              // One place for every line, else each line's own.
              deliverToPlaceId: places.size === 1 ? [...places][0]! : null,
              createdById: user.id,
            },
            select: { id: true },
          });
          const merged = new Map<string, { itemId: string; placeId: string | null; quantity: number; unitPriceCents: number }>();
          for (const line of group) {
            const key = `${line.itemId}|${placeOf(line) ?? ''}`;
            const one = merged.get(key);
            if (one) one.quantity += line.quantity;
            else merged.set(key, { itemId: line.itemId!, placeId: placeOf(line), quantity: line.quantity, unitPriceCents: line.estimatedUnitCostCents });
          }
          await tx.purchaseOrderLine.createMany({ data: [...merged.values()].map((line, position) => ({ organizationId, orderId: order.id, position, ...line })) });
          await tx.purchaseOrderSource.createMany({
            data: group.map((line) => ({
              organizationId,
              orderId: order.id,
              requisitionId: line.requisition.id,
              requisitionLineId: line.id,
              itemId: line.itemId!,
              placeId: placeOf(line),
              quantity: line.quantity,
            })),
          });
          const numbers = [...new Set(group.map((line) => line.requisition.number ?? 'a requisition'))];
          await this.audit(tx, user, 'PURCHASE_ORDER_CREATED', ENTITY, order.id, { requisition: numbers.join(', '), requisitions: numbers, lines: merged.size, vendor: vendor?.name ?? null });
          made.push({ id: order.id, vendor: vendor ? { id: vendor.id, number: vendor.number, name: vendor.name } : null });
          carries.push(new Set(group.map((line) => line.requisition.id)));
        }

        // Ordered once none of its lines waits; else it stays approved, Pending Processing.
        for (const requisition of new Map(lines.map((line) => [line.requisition.id, line.requisition])).values()) {
          const waiting = await tx.purchaseRequisitionLine.count({ where: { organizationId, requisitionId: requisition.id, itemId: { not: null }, orderSources: { none: { releasedAt: null } } } });
          if (!waiting && requisition.status === PurchaseRequisitionStatus.APPROVED)
            await tx.purchaseRequisition.updateMany({ where: { id: requisition.id, organizationId, status: PurchaseRequisitionStatus.APPROVED }, data: { status: PurchaseRequisitionStatus.ORDERED } });
          const its = made.filter((_, index) => carries[index]!.has(requisition.id));
          await this.audit(tx, user, 'PURCHASE_REQUISITION_ORDERED', 'PurchaseRequisition', requisition.id, {
            number: requisition.number,
            orders: its.length,
            note: its.map((order) => order.vendor?.name ?? 'no vendor yet').join(', ') + (waiting ? '; some of its lines are still to order' : ''),
          });
        }
        return { orders: made };
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'REQUISITION_LINE_ORDERED', 'Somebody has just ordered some of these lines. Open Pending Processing again.');
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
        deliverToPlaceId: true,
        createdById: true,
        submittedAt: true,
        taxBasisPoints: true,
        xeroTenantId: true,
        vendor: { select: { name: true } },
        lines: { select: { itemId: true, placeId: true, quantity: true, unitPriceCents: true } },
        requisition: { select: { number: true } },
        // The requisition lines it carries now (2026-11-23).
        sources: { where: { releasedAt: null }, select: { id: true, requisitionId: true, itemId: true, placeId: true } },
        bill: { select: { id: true } },
      },
    });
    if (!order) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
    return order;
  }

  /** A purchaser, receiver or bill keeper limited to some companies acts only on theirs (Purchasing Setup, 2026-11-21). */
  private async assertActs(db: Pick<Db, 'purchasingPerson'>, user: AuthenticatedUser, companyTenantId: string | null, what = 'order') {
    const refused = companyRefusal(await readStanding(db, user), companyTenantId, what);
    if (refused) throw new ApplicationError(403, 'PURCHASE_ORDER_COMPANY_NOT_YOURS', refused);
  }

  /** One status change, made only if the order is still where the caller saw it. */
  private async move(db: Db, organizationId: string, orderId: string, from: readonly Status[], data: Prisma.PurchaseOrderUncheckedUpdateManyInput) {
    const moved = await db.purchaseOrder.updateMany({ where: { id: orderId, organizationId, status: { in: [...from] } }, data });
    if (moved.count !== 1) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order has changed since you opened it. Open it again.');
  }

  /**
   * Replaces the order's vendor, terms and lines. Its items are its
   * requisition's: nothing is ordered that nobody approved asking for.
   *
   * A draft is changed freely. An approved order may be changed too, before
   * anything arrives or a bill is entered (Purchasing Setup, 2026-11-20): it
   * goes back for approval when the office says every change does, or when the
   * change raises it, adds an item or changes the vendor. Otherwise it stays
   * approved -- and one already sent is to be sent again.
   */
  async update(user: AuthenticatedUser, orderId: string, input: SavePurchaseOrderInput): Promise<PurchaseOrderDetail> {
    await this.prisma.$transaction(async (tx) => {
      const order = await this.found(tx, user, orderId);
      await this.assertActs(tx, user, order.xeroTenantId);
      const changing = CHANGEABLE.includes(order.status);
      if (order.status !== Status.DRAFT && !changing)
        throw new ApplicationError(409, 'PURCHASE_ORDER_FIXED', 'An order cannot be changed while it waits for approval, or once goods have arrived.');
      if (changing && order.bill) throw new ApplicationError(409, 'PURCHASE_ORDER_FIXED', "The vendor's bill is entered against this order, so it stays as it is.");
      // A requisition line is on this order or none (2026-11-23): an order holds only the lines it carries.
      await this.write(tx, user, order, orderId, input, changing);
    });
    return this.detail(user, orderId);
  }

  /** Writes the order's vendor, terms and lines; `changing` an approved one decides whether it goes back for approval. */
  private async write(tx: Db, user: AuthenticatedUser, order: Awaited<ReturnType<PurchaseOrdersService['found']>>, orderId: string, input: SavePurchaseOrderInput, changing = false) {
    const organizationId = user.organizationId;
    {
      if (input.vendorId && !(await tx.vendor.findFirst({ where: { organizationId, id: input.vendorId, active: true }, select: { id: true } })))
        throw new ApplicationError(400, 'VENDOR_NOT_FOUND', 'That vendor is not in use.');
      if (input.deliverToPlaceId && !(await tx.stockPlace.findFirst({ where: { organizationId, id: input.deliverToPlaceId, active: true }, select: { id: true } })))
        throw new ApplicationError(400, 'PURCHASE_ORDER_PLACE_NOT_FOUND', 'That place is not in use.');
      // Its lines are the requisition lines it carries, by item and place (2026-11-23); one sent without its place is the item's only one.
      // An order going to one place goes, all of it, where Deliver to is changed to; one going to several keeps each line's.
      const from = order.deliverToPlaceId;
      const to = input.deliverToPlaceId ?? null;
      const moved = Boolean(to && from && to !== from && order.sources.length && order.sources.every((source) => source.placeId === from));
      const sources = moved ? order.sources.map((source) => ({ ...source, placeId: to })) : order.sources;
      const key = (itemId: string, placeId: string | null) => `${itemId}|${placeId ?? ''}`;
      const asked = new Set(sources.map((source) => key(source.itemId, source.placeId)));
      const placesOf = (itemId: string) => [...new Set(sources.filter((source) => source.itemId === itemId).map((source) => source.placeId))];
      const lines = input.lines.map((line) => {
        const given = line.placeId === undefined ? undefined : (line.placeId ?? null);
        const placeId = given === undefined ? (placesOf(line.itemId).length === 1 ? placesOf(line.itemId)[0]! : null) : moved && given === from ? to : given;
        return { ...line, placeId };
      });
      const keys = lines.map((line) => key(line.itemId, line.placeId));
      const itemIds = lines.map((line) => line.itemId);
      if (new Set(keys).size !== keys.length) throw new ApplicationError(400, 'PURCHASE_ORDER_ITEM_TWICE', 'An item is on the order twice for the same place. Put it on one line.');
      if (keys.some((one) => !asked.has(one)))
        throw new ApplicationError(400, 'PURCHASE_ORDER_ITEM_NOT_REQUESTED', 'An order holds only the items its requisitions asked for, where they asked for them.');
      // A line taken off gives its requisition lines back to Pending Processing.
      const dropped = sources.filter((source) => !keys.includes(key(source.itemId, source.placeId)));
      const totalCents = orderTotals(input.lines, input.taxBasisPoints).totalCents;
      let again = false;
      if (changing) {
        const problem = orderSubmitProblem({ vendorId: input.vendorId ?? null, lines: input.lines });
        if (problem) throw new ApplicationError(400, 'PURCHASE_ORDER_NOT_READY', problem);
        const { approvals } = await readPurchasingSetup(tx, organizationId);
        again = orderChangeNeedsApproval(
          { totalCents: orderTotals(order.lines, order.taxBasisPoints).totalCents, itemIds: order.lines.map((line) => line.itemId), vendorId: order.vendorId },
          { totalCents, itemIds: itemIds, vendorId: input.vendorId ?? null },
          approvals.reapproveChangedOrders,
        );
      }
      await this.move(tx, organizationId, orderId, changing ? [order.status] : [Status.DRAFT], {
        ...(changing ? (again ? { status: Status.AWAITING_APPROVAL, approvedById: null, approvedAt: null, decisionNote: null } : { status: Status.APPROVED }) : {}),
        vendorId: input.vendorId ?? null,
        deliverToPlaceId: input.deliverToPlaceId ?? null,
        expectedOn: input.expectedOn ? dateOf(input.expectedOn) : null,
        terms: text(input.terms),
        taxBasisPoints: input.taxBasisPoints,
        notes: input.notes?.trim() || null,
      });
      if (moved) await tx.purchaseOrderSource.updateMany({ where: { organizationId, orderId, releasedAt: null }, data: { placeId: to } });
      await tx.purchaseOrderLine.deleteMany({ where: { organizationId, orderId } });
      if (lines.length)
        await tx.purchaseOrderLine.createMany({
          data: lines.map((line, position) => ({ organizationId, orderId, position, itemId: line.itemId, placeId: line.placeId, quantity: line.quantity, unitPriceCents: line.unitPriceCents })),
        });
      if (dropped.length) await this.release(tx, user, dropped, order.number, 'taken off the order');
      if (changing)
        await this.audit(tx, user, 'PURCHASE_ORDER_CHANGED_AFTER_APPROVAL', ENTITY, orderId, {
          number: order.number,
          fromTotalCents: orderTotals(order.lines, order.taxBasisPoints).totalCents,
          totalCents,
          again,
          note: again ? 'it goes back for approval' : order.status === Status.SENT ? 'it stays approved, to be sent again' : 'it stays approved',
        });
      else await this.audit(tx, user, 'PURCHASE_ORDER_CHANGED', ENTITY, orderId, { lines: input.lines.length, totalCents });
    }
  }

  /** Hands it to the approvers. It takes its number the first time, and keeps it if it comes back and goes again. */
  async submit(user: AuthenticatedUser, orderId: string): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const order = await this.found(tx, user, orderId);
      await this.assertActs(tx, user, order.xeroTenantId);
      if (order.status !== Status.DRAFT) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order has already been submitted.');
      const problem = orderSubmitProblem(order);
      if (problem) throw new ApplicationError(409, 'PURCHASE_ORDER_NOT_READY', problem);
      const number = order.number ?? (await nextDocumentCode(tx, organizationId, 'PO'));
      await this.move(tx, organizationId, orderId, [Status.DRAFT], { status: Status.AWAITING_APPROVAL, number, submittedAt: order.submittedAt ?? new Date(), decisionNote: null });
      await this.audit(tx, user, 'PURCHASE_ORDER_SUBMITTED', ENTITY, orderId, { number, totalCents: orderTotals(order.lines, order.taxBasisPoints).totalCents });
    });
    return this.detail(user, orderId);
  }

  // ── Deciding ────────────────────────────────────────────────────────────

  /** Approve an order that is waiting, or send it back to its purchaser with a note, by an approver. One they made is only approved (2026-11-21). */
  async decide(user: AuthenticatedUser, orderId: string, decision: 'APPROVED' | 'SENT_BACK', input: PurchaseOrderDecisionInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    const note = text(input.note);
    // The route asks for it too; here it does not rest on the route, now that an approver's own is theirs to approve.
    if (!may(user, APPROVE_ORDERS)) throw new ApplicationError(403, 'PURCHASE_ORDER_NOT_APPROVER', 'Only a purchasing manager decides an order.');
    if (decision === 'SENT_BACK' && !note) throw new ApplicationError(400, 'PURCHASE_ORDER_NOTE_NEEDED', 'Say what to change, so the purchaser knows.');
    await this.prisma.$transaction(async (tx) => {
      const order = await this.found(tx, user, orderId);
      if (order.status !== Status.AWAITING_APPROVAL) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order is no longer waiting for a decision.');
      const own = order.createdById === user.id;
      // One they made is approved, or changed as a draft once somebody else sends it back: never sent back by them.
      if (own && decision !== 'APPROVED') throw new ApplicationError(403, 'PURCHASE_ORDER_OWN', 'You made this order, so somebody else sends it back.');
      const totalCents = orderTotals(order.lines, order.taxBasisPoints).totalCents;
      const [setup, standing] = await Promise.all([readPurchasingSetup(tx, organizationId), readStanding(tx, user)]);
      if (setup.approvals.approverOwnCompaniesOnly) {
        const refused = companyRefusal(standing, order.xeroTenantId, 'decide orders');
        if (refused) throw new ApplicationError(403, 'PURCHASE_ORDER_COMPANY_NOT_YOURS', refused);
      }
      if (decision === 'APPROVED') {
        const rules = { steps: setup.settings.steps, ownCompaniesOnly: setup.approvals.approverOwnCompaniesOnly, standing };
        const { approveBlocked } = this.actions(user, order, totalCents, rules, null);
        if (approveBlocked) throw new ApplicationError(403, 'PURCHASE_ORDER_OVER_LIMIT', approveBlocked);
        await this.move(tx, organizationId, orderId, [Status.AWAITING_APPROVAL], { status: Status.APPROVED, approvedById: user.id, approvedAt: new Date(), decisionNote: note });
      } else {
        await this.move(tx, organizationId, orderId, [Status.AWAITING_APPROVAL], { status: Status.DRAFT, decisionNote: note });
      }
      await this.audit(tx, user, `PURCHASE_ORDER_${decision}`, ENTITY, orderId, { number: order.number, totalCents, note, ownOrder: own });
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
      await this.assertActs(tx, user, order.xeroTenantId);
      if (!CANCELLABLE.includes(order.status)) throw new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order is already cancelled.');
      await this.move(tx, organizationId, orderId, CANCELLABLE, { status: Status.CANCELLED, cancelledById: user.id, cancelledAt: new Date(), cancelReason: reason });
      await this.audit(tx, user, 'PURCHASE_ORDER_CANCELLED', ENTITY, orderId, { number: order.number, note: reason });
      // Its requisition lines wait on Pending Processing again (2026-11-23), and each requisition is approved again.
      await this.release(tx, user, order.sources, order.number, reason);
    });
    return this.detail(user, orderId);
  }

  /**
   * Gives requisition lines back to Pending Processing: their share of the
   * order is released, and each requisition with a line now waiting is
   * approved again (Pending Processing), and audited so.
   */
  private async release(tx: Db, user: AuthenticatedUser, sources: readonly { id: string; requisitionId: string }[], orderNumber: string | null, note: string) {
    const organizationId = user.organizationId;
    if (!sources.length) return;
    await tx.purchaseOrderSource.updateMany({ where: { organizationId, id: { in: sources.map((source) => source.id) }, releasedAt: null }, data: { releasedAt: new Date() } });
    for (const requisitionId of new Set(sources.map((source) => source.requisitionId))) {
      await tx.purchaseRequisition.updateMany({ where: { id: requisitionId, organizationId, status: PurchaseRequisitionStatus.ORDERED }, data: { status: PurchaseRequisitionStatus.APPROVED } });
      await this.audit(tx, user, 'PURCHASE_REQUISITION_ORDER_CANCELLED', 'PurchaseRequisition', requisitionId, { order: orderNumber, note });
    }
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
    await this.assertActs(this.prisma, user, order.xeroTenantId);
    if (!SENDABLE.includes(order.status)) throw new ApplicationError(409, 'PURCHASE_ORDER_NOT_SENDABLE', 'An order is sent to the vendor once it is approved.');

    // The requisition's files ticked for the vendor go too (2026-11-20). Read
    // before the email is claimed, so too many, or one that cannot be read,
    // costs nothing and uses none of the day's emails. One storage read a file.
    const ticked = await vendorFilesOf(this.prisma, organizationId, [...new Set([order.requisitionId, ...order.sources.map((source) => source.requisitionId)])]);
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

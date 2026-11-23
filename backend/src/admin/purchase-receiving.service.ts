import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PurchaseOrderStatus as Status, PurchaseRequisitionStatus, StockMovementKind, VendorBillStatus } from '@prisma/client';
import {
  billProblems,
  companyRefusal,
  type ApproveVendorBillInput,
  type CloseShortInput,
  type PayVendorBillInput,
  type PurchaseOrderDetail,
  type ReceiveGoodsInput,
  type ReverseReceiptInput,
  type SaveVendorBillInput,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate, dayWords } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { assertStockNotFrozen } from './stock-freeze';
import { PurchaseOrdersService } from './purchase-orders.service';
import { nextDocumentCode, readStanding } from './purchasing-settings';

/**
 * Receiving and the vendor's bill (2026-11-19, phase 4 of the inventory and
 * purchasing plan).
 *
 * A receipt is the only thing in purchasing that moves stock. Posting one
 * writes a RECEIPT movement a line -- at the order's price, into the place the
 * goods were put -- and the ledger's own trigger adds them to what is on hand.
 * It is posted whole or not at all, once a press (its request key), and is
 * never edited: a wrong one is reversed, which takes its stock back out with
 * REVERSAL movements, provided the stock is still there.
 *
 * Nobody receives more than was ordered: checked here in the office's words,
 * and held by the database on each order line.
 *
 * The vendor's bill is matched three ways each time anything it depends on
 * changes -- ordered, received, billed -- and is HELD, saying why, or MATCHED.
 * A matched bill is approved for payment by whoever keeps the bills. A held
 * one is approved only by somebody who may approve any amount, who is not the
 * person who entered it, with a reason (the database holds that too).
 * Recording a payment moves no money. An order closes itself once it is
 * received and paid.
 *
 * Every step is audited on the order, so the order's history shows it.
 * Nothing here calls anything billed.
 */

const ORDER_ENTITY = 'PurchaseOrder';
const APPROVE_ANY = 'purchasing:approve-any';
/** An order goods can still arrive for. Approved counts: the vendor may have been told by phone. */
const RECEIVABLE: Status[] = [Status.APPROVED, Status.SENT, Status.PARTLY_RECEIVED];
/** An order whose goods are still being counted in: its status follows its receipts. */
const IN_RECEIVING: Status[] = [...RECEIVABLE, Status.RECEIVED];
const BILL_OPEN: VendorBillStatus[] = [VendorBillStatus.HELD, VendorBillStatus.MATCHED];

type Db = Prisma.TransactionClient;
const may = (user: AuthenticatedUser, permission: string) => (user.permissions as readonly string[]).includes(permission);
const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const taken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const moved = () => new ApplicationError(409, 'PURCHASE_ORDER_MOVED_ON', 'This order has changed since you opened it. Open it again.');

@Injectable()
export class PurchaseReceivingService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(PurchaseOrdersService) private readonly orders: PurchaseOrdersService,
  ) {}

  private audit(db: Db, user: AuthenticatedUser, action: string, orderId: string, metadata: Prisma.InputJsonObject) {
    return db.auditLog.create({ data: { organizationId: user.organizationId, ...auditActor(user), action, entityType: ORDER_ENTITY, entityId: orderId, metadata } });
  }

  /**
   * Brings the order into line with its receipts and its bill, after either
   * changed: where its goods stand, whether its bill matches, and -- received
   * and paid -- that it is closed.
   */
  private async settle(db: Db, user: AuthenticatedUser, orderId: string) {
    const organizationId = user.organizationId;
    const order = await db.purchaseOrder.findFirst({
      where: { id: orderId, organizationId },
      select: {
        number: true,
        status: true,
        sentAt: true,
        shortClosedAt: true,
        requisitionId: true,
        // The requisitions it carries lines of (2026-11-23).
        sources: { where: { releasedAt: null }, select: { requisitionId: true } },
        taxBasisPoints: true,
        lines: { select: { id: true, quantity: true, receivedQuantity: true, unitPriceCents: true, item: { select: { name: true } } } },
        bill: { select: { id: true, status: true, totalCents: true, lines: { select: { orderLineId: true, quantity: true, unitPriceCents: true } } } },
      },
    });
    if (!order) return;

    let status = order.status;
    if (IN_RECEIVING.includes(status)) {
      const received = order.lines.reduce((sum, line) => sum + line.receivedQuantity, 0);
      const all = order.lines.every((line) => line.receivedQuantity >= line.quantity);
      // Finished short counts as received, while anything of it has arrived.
      const next = all || (order.shortClosedAt && received > 0) ? Status.RECEIVED : received > 0 ? Status.PARTLY_RECEIVED : order.sentAt ? Status.SENT : Status.APPROVED;
      if (next !== status) {
        const changed = await db.purchaseOrder.updateMany({ where: { id: orderId, organizationId, status }, data: { status: next } });
        if (changed.count !== 1) throw moved();
        status = next;
      }
    }

    let billStatus = order.bill?.status ?? null;
    if (order.bill && BILL_OPEN.includes(order.bill.status)) {
      const billed = new Map(order.bill.lines.map((line) => [line.orderLineId, line]));
      const problems = billProblems(
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
      );
      const next = problems.length ? VendorBillStatus.HELD : VendorBillStatus.MATCHED;
      if (next !== order.bill.status) await db.vendorBill.updateMany({ where: { id: order.bill.id, organizationId, status: { in: BILL_OPEN } }, data: { status: next } });
      billStatus = next;
    }

    if (status === Status.RECEIVED && billStatus === VendorBillStatus.PAID) {
      const closed = await db.purchaseOrder.updateMany({ where: { id: orderId, organizationId, status: Status.RECEIVED }, data: { status: Status.CLOSED, closedAt: new Date() } });
      if (closed.count === 1) {
        // Each requisition on it closes with the last of the orders carrying its lines, not the first (2026-11-20; 2026-11-23,
        // an order may carry several). One with lines still to order is not Ordered, so it stays open.
        const requisitionIds = order.sources.length ? [...new Set(order.sources.map((source) => source.requisitionId))] : [order.requisitionId];
        for (const requisitionId of requisitionIds) {
          const open = await db.purchaseOrderSource.count({ where: { organizationId, requisitionId, releasedAt: null, orderId: { not: orderId }, order: { status: { notIn: [Status.CLOSED, Status.CANCELLED] } } } });
          if (!open)
            await db.purchaseRequisition.updateMany({ where: { id: requisitionId, organizationId, status: PurchaseRequisitionStatus.ORDERED }, data: { status: PurchaseRequisitionStatus.CLOSED } });
        }
        await this.audit(db, user, 'PURCHASE_ORDER_CLOSED', orderId, { number: order.number });
      }
    }
  }

  // ── Receiving ───────────────────────────────────────────────────────────

  /** Posts what arrived: stock in, a line at a time, all of it or none. Sent twice with the same key it posts once. */
  /**
   * A receiver or bill keeper limited to some companies acts only on their
   * orders (Purchasing Setup, 2026-11-21). An order not on the list is left
   * to the action itself to say so.
   */
  private async assertActs(user: AuthenticatedUser, orderId: string, what: string) {
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id: orderId, organizationId: user.organizationId }, select: { xeroTenantId: true } });
    if (!order) return;
    const refused = companyRefusal(await readStanding(this.prisma, user), order.xeroTenantId, what);
    if (refused) throw new ApplicationError(403, 'PURCHASE_ORDER_COMPANY_NOT_YOURS', refused);
  }

  async receive(user: AuthenticatedUser, orderId: string, input: ReceiveGoodsInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.assertActs(user, orderId, 'receive goods');
    const today = businessDate();
    const day = input.receivedOn ?? today;
    if (day > today) throw new ApplicationError(400, 'RECEIPT_DAY_AHEAD', `Goods cannot be received on a day after today. It is ${dayWords(today)} in Texas.`);
    if (!input.lines.length) throw new ApplicationError(400, 'RECEIPT_EMPTY', 'Say what arrived: at least one line.');
    const lineIds = input.lines.map((line) => line.orderLineId);
    if (new Set(lineIds).size !== lineIds.length) throw new ApplicationError(400, 'RECEIPT_LINE_TWICE', 'An order line is on the receipt twice. Put it on one line.');

    try {
      await this.prisma.$transaction(async (tx) => {
        const prior = await tx.goodsReceipt.findFirst({ where: { organizationId, requestKey: input.requestKey }, select: { orderId: true } });
        if (prior) {
          if (prior.orderId !== orderId) throw new ApplicationError(409, 'RECEIPT_REQUEST_REUSED', 'That receipt was already posted for another order.');
          return;
        }
        await assertStockNotFrozen(tx, organizationId);
        const order = await tx.purchaseOrder.findFirst({
          where: { id: orderId, organizationId },
          select: { number: true, status: true, lines: { select: { id: true, itemId: true, quantity: true, receivedQuantity: true, unitPriceCents: true, item: { select: { code: true } } } } },
        });
        if (!order) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
        if (!RECEIVABLE.includes(order.status)) throw new ApplicationError(409, 'PURCHASE_ORDER_NOT_RECEIVABLE', 'Goods are received against an order that is approved or with the vendor, and not yet finished.');
        const lineOf = new Map(order.lines.map((line) => [line.id, line]));
        for (const arrived of input.lines) {
          const line = lineOf.get(arrived.orderLineId);
          if (!line) throw new ApplicationError(400, 'RECEIPT_LINE_NOT_ON_ORDER', 'One of the lines is not on this order.');
          const remaining = line.quantity - line.receivedQuantity;
          if (arrived.quantity > remaining)
            throw new ApplicationError(409, 'RECEIPT_MORE_THAN_ORDERED', remaining ? `Only ${remaining} of ${line.item.code} ${remaining === 1 ? 'is' : 'are'} still to come.` : `All of ${line.item.code} has already arrived.`);
        }
        const placeIds = [...new Set(input.lines.map((line) => line.placeId))];
        if ((await tx.stockPlace.count({ where: { organizationId, id: { in: placeIds }, active: true } })) !== placeIds.length)
          throw new ApplicationError(400, 'STOCK_PLACE_NOT_FOUND', 'One of the places is not in use.');

        const number = await nextDocumentCode(tx, organizationId, 'RCV');
        const who = { createdById: user.principalType === 'API_KEY' ? null : user.id, createdByName: user.displayName };
        const receipt = await tx.goodsReceipt.create({
          data: { organizationId, number, orderId, receivedOn: dateOf(day), packingSlip: text(input.packingSlip), note: text(input.note), requestKey: input.requestKey, ...who },
          select: { id: true },
        });
        let units = 0;
        for (const arrived of input.lines) {
          const line = lineOf.get(arrived.orderLineId)!;
          // What it cost is what was agreed on the order, before tax.
          const movement = await tx.stockMovement.create({
            data: { organizationId, itemId: line.itemId, placeId: arrived.placeId, kind: StockMovementKind.RECEIPT, quantity: arrived.quantity, unitCostCents: line.unitPriceCents, day: dateOf(day), note: `${number} on ${order.number}`, ...who },
            select: { id: true },
          });
          await tx.goodsReceiptLine.create({ data: { organizationId, receiptId: receipt.id, orderLineId: line.id, itemId: line.itemId, placeId: arrived.placeId, quantity: arrived.quantity, movementId: movement.id } });
          // Only while it still fits: of two receipts posted at once, the second is refused rather than taking the line past what was ordered.
          const counted = await tx.purchaseOrderLine.updateMany({
            where: { id: line.id, organizationId, receivedQuantity: { lte: line.quantity - arrived.quantity } },
            data: { receivedQuantity: { increment: arrived.quantity } },
          });
          if (counted.count !== 1) throw moved();
          units += arrived.quantity;
        }
        await this.audit(tx, user, 'GOODS_RECEIVED', orderId, { receipt: number, units, note: `${number}, ${units} unit${units === 1 ? '' : 's'}` });
        await this.settle(tx, user, orderId);
      });
    } catch (error) {
      // The same receipt, sent at the same moment by a retry: the other one posted it.
      if (!taken(error)) throw error;
    }
    return this.orders.detail(user, orderId);
  }

  /**
   * Takes a wrong receipt back out: a REVERSAL movement a line, at the same
   * cost. Only while the stock is still where it was put, and while the
   * order's bill has not been approved against it.
   */
  async reverseReceipt(user: AuthenticatedUser, receiptId: string, input: ReverseReceiptInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    const receipt = await this.prisma.goodsReceipt.findFirst({ where: { id: receiptId, organizationId }, select: { orderId: true } });
    if (receipt) await this.assertActs(user, receipt.orderId, 'receive goods');
    const reason = text(input.reason);
    if (!reason) throw new ApplicationError(400, 'RECEIPT_REVERSAL_NEEDS_REASON', 'Say why it is being reversed.');
    let orderId = '';
    try {
      await this.prisma.$transaction(async (tx) => {
        const receipt = await tx.goodsReceipt.findFirst({
          where: { id: receiptId, organizationId },
          select: {
            number: true,
            orderId: true,
            reversedAt: true,
            order: { select: { status: true, bill: { select: { status: true } } } },
            lines: { select: { orderLineId: true, itemId: true, placeId: true, quantity: true, movementId: true, item: { select: { code: true } }, place: { select: { name: true } }, movement: { select: { unitCostCents: true } } } },
          },
        });
        if (!receipt) throw new ApplicationError(404, 'RECEIPT_NOT_FOUND', 'That receipt is not on the list.');
        orderId = receipt.orderId;
        if (receipt.reversedAt) throw new ApplicationError(409, 'RECEIPT_ALREADY_REVERSED', 'That receipt has already been reversed.');
        await assertStockNotFrozen(tx, organizationId);
        if (receipt.order.status === Status.CLOSED) throw new ApplicationError(409, 'RECEIPT_FIXED', 'The order is closed, so its receipts stay.');
        if (receipt.order.bill && !BILL_OPEN.includes(receipt.order.bill.status)) throw new ApplicationError(409, 'RECEIPT_FIXED', "The vendor's bill has been approved against it, so the receipt stays.");

        const who = { createdById: user.principalType === 'API_KEY' ? null : user.id, createdByName: user.displayName };
        for (const line of receipt.lines) {
          const level = await tx.stockLevel.findUnique({ where: { itemId_placeId: { itemId: line.itemId, placeId: line.placeId } }, select: { quantity: true } });
          const there = level?.quantity ?? 0;
          if (there < line.quantity)
            throw new ApplicationError(409, 'STOCK_NOT_ENOUGH', `Only ${there} of ${line.item.code} ${there === 1 ? 'is' : 'are'} still in ${line.place.name}, so the ${line.quantity} received cannot be taken back out.`);
          await tx.stockMovement.create({
            data: { organizationId, itemId: line.itemId, placeId: line.placeId, kind: StockMovementKind.REVERSAL, quantity: -line.quantity, unitCostCents: line.movement.unitCostCents, day: dateOf(businessDate()), note: `${receipt.number} reversed: ${reason}`, reversesId: line.movementId, ...who },
          });
          const counted = await tx.purchaseOrderLine.updateMany({ where: { id: line.orderLineId, organizationId, receivedQuantity: { gte: line.quantity } }, data: { receivedQuantity: { decrement: line.quantity } } });
          if (counted.count !== 1) throw moved();
        }
        const marked = await tx.goodsReceipt.updateMany({
          where: { id: receiptId, organizationId, reversedAt: null },
          data: { reversedAt: new Date(), reversedById: who.createdById, reversedByName: user.displayName, reverseReason: reason },
        });
        if (marked.count !== 1) throw new ApplicationError(409, 'RECEIPT_ALREADY_REVERSED', 'That receipt has already been reversed.');
        await this.audit(tx, user, 'GOODS_RECEIPT_REVERSED', orderId, { receipt: receipt.number, note: `${receipt.number}: ${reason}` });
        await this.settle(tx, user, orderId);
      });
    } catch (error) {
      // Two reversals at once: the ledger lets a movement be reversed once.
      if (taken(error)) throw new ApplicationError(409, 'RECEIPT_ALREADY_REVERSED', 'That receipt has already been reversed.');
      throw error;
    }
    return this.orders.detail(user, orderId);
  }

  /** The rest will not arrive: the order is finished with what has, and can be billed and closed on that. */
  async closeShort(user: AuthenticatedUser, orderId: string, input: CloseShortInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.assertActs(user, orderId, 'order');
    const reason = text(input.reason);
    if (!reason) throw new ApplicationError(400, 'PURCHASE_ORDER_REASON_NEEDED', 'Say why the rest will not arrive.');
    await this.prisma.$transaction(async (tx) => {
      const finished = await tx.purchaseOrder.updateMany({
        where: { id: orderId, organizationId, status: Status.PARTLY_RECEIVED },
        data: { status: Status.RECEIVED, shortClosedAt: new Date(), shortClosedById: user.id, shortCloseReason: reason },
      });
      if (finished.count !== 1) {
        if (!(await tx.purchaseOrder.findFirst({ where: { id: orderId, organizationId }, select: { id: true } }))) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
        throw new ApplicationError(409, 'PURCHASE_ORDER_NOT_PARTLY_RECEIVED', 'Only an order that has partly arrived is finished short. One with nothing received is cancelled instead.');
      }
      await this.audit(tx, user, 'PURCHASE_ORDER_CLOSED_SHORT', orderId, { note: reason });
      await this.settle(tx, user, orderId);
    });
    return this.orders.detail(user, orderId);
  }

  // ── The vendor's bill ───────────────────────────────────────────────────

  /** Enters the bill, or changes it while it is not approved. It is matched as it is saved. */
  async saveBill(user: AuthenticatedUser, orderId: string, input: SaveVendorBillInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.assertActs(user, orderId, 'keep bills');
    const billNumber = text(input.billNumber);
    if (!billNumber) throw new ApplicationError(400, 'VENDOR_BILL_INCOMPLETE', "Enter the bill's number.");
    if (input.billDate > businessDate()) throw new ApplicationError(400, 'VENDOR_BILL_DAY_AHEAD', `A bill cannot be dated after today. It is ${dayWords(businessDate())} in Texas.`);
    const lineIds = input.lines.map((line) => line.orderLineId);
    if (new Set(lineIds).size !== lineIds.length) throw new ApplicationError(400, 'VENDOR_BILL_LINE_TWICE', 'An order line is on the bill twice. Put it on one line.');
    try {
      await this.prisma.$transaction(async (tx) => {
        const order = await tx.purchaseOrder.findFirst({ where: { id: orderId, organizationId }, select: { status: true, lines: { select: { id: true } }, bill: { select: { id: true, status: true } } } });
        if (!order) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
        if (!IN_RECEIVING.includes(order.status)) throw new ApplicationError(409, 'VENDOR_BILL_NOT_YET', 'A bill is entered for an order that is approved or with the vendor, and not closed.');
        if (order.bill && !BILL_OPEN.includes(order.bill.status)) throw new ApplicationError(409, 'VENDOR_BILL_FIXED', 'The bill has been approved, so it cannot be changed.');
        const onOrder = new Set(order.lines.map((line) => line.id));
        if (lineIds.some((lineId) => !onOrder.has(lineId))) throw new ApplicationError(400, 'VENDOR_BILL_LINE_NOT_ON_ORDER', 'One of the bill lines is not on this order.');

        const fields = { billNumber, billDate: dateOf(input.billDate), totalCents: input.totalCents };
        let billId = order.bill?.id;
        if (billId) {
          const changed = await tx.vendorBill.updateMany({ where: { id: billId, organizationId, status: { in: BILL_OPEN } }, data: fields });
          if (changed.count !== 1) throw moved();
          await tx.vendorBillLine.deleteMany({ where: { organizationId, billId } });
        } else {
          billId = (await tx.vendorBill.create({ data: { organizationId, orderId, enteredById: user.id, ...fields }, select: { id: true } })).id;
        }
        if (input.lines.length)
          await tx.vendorBillLine.createMany({ data: input.lines.map((line) => ({ organizationId, billId: billId!, orderLineId: line.orderLineId, quantity: line.quantity, unitPriceCents: line.unitPriceCents })) });
        await this.audit(tx, user, 'VENDOR_BILL_ENTERED', orderId, { bill: billNumber, totalCents: input.totalCents, note: billNumber });
        await this.settle(tx, user, orderId);
      });
    } catch (error) {
      if (taken(error)) throw new ApplicationError(409, 'VENDOR_BILL_EXISTS', 'Somebody has just entered the bill for this order. Open the order again.');
      throw error;
    }
    return this.orders.detail(user, orderId);
  }

  private async billOf(db: Db, organizationId: string, orderId: string) {
    const bill = await db.vendorBill.findFirst({ where: { organizationId, orderId }, select: { id: true, billNumber: true, status: true, enteredById: true } });
    if (!bill) throw new ApplicationError(404, 'VENDOR_BILL_NOT_FOUND', 'No bill has been entered for this order.');
    return bill;
  }

  /** Approves for payment a bill that matches its order and its receipts. */
  async approveBill(user: AuthenticatedUser, orderId: string): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.assertActs(user, orderId, 'keep bills');
    await this.prisma.$transaction(async (tx) => {
      const bill = await this.billOf(tx, organizationId, orderId);
      if (bill.status === VendorBillStatus.HELD) throw new ApplicationError(409, 'VENDOR_BILL_HELD', 'This bill does not match the order and what was received. It needs somebody who may approve any amount, with a reason.');
      const approved = await tx.vendorBill.updateMany({ where: { id: bill.id, organizationId, status: VendorBillStatus.MATCHED }, data: { status: VendorBillStatus.APPROVED, approvedById: user.id, approvedAt: new Date() } });
      if (approved.count !== 1) throw new ApplicationError(409, 'VENDOR_BILL_MOVED_ON', 'This bill has already been approved.');
      await this.audit(tx, user, 'VENDOR_BILL_APPROVED', orderId, { bill: bill.billNumber });
    });
    return this.orders.detail(user, orderId);
  }

  /**
   * Approves a bill although it does not match -- the vendor will credit the
   * difference, say. Only somebody who may approve any amount -- whoever
   * entered the bill too (the office, 2026-11-21), audited as their own --
   * and always with their reason, which is kept.
   */
  async approveBillAnyway(user: AuthenticatedUser, orderId: string, input: ApproveVendorBillInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.assertActs(user, orderId, 'keep bills');
    const reason = text(input.reason);
    if (!may(user, APPROVE_ANY)) throw new ApplicationError(403, 'VENDOR_BILL_OVERRIDE_FORBIDDEN', 'A bill that does not match needs somebody who may approve any amount.');
    if (!reason) throw new ApplicationError(400, 'VENDOR_BILL_REASON_NEEDED', 'Say why it is approved although it does not match.');
    await this.prisma.$transaction(async (tx) => {
      const bill = await this.billOf(tx, organizationId, orderId);
      if (bill.status !== VendorBillStatus.HELD) throw new ApplicationError(409, 'VENDOR_BILL_MOVED_ON', 'This bill is not held any more.');
      const approved = await tx.vendorBill.updateMany({ where: { id: bill.id, organizationId, status: VendorBillStatus.HELD }, data: { status: VendorBillStatus.APPROVED, approvedById: user.id, approvedAt: new Date(), overrideReason: reason } });
      if (approved.count !== 1) throw new ApplicationError(409, 'VENDOR_BILL_MOVED_ON', 'This bill is not held any more.');
      await this.audit(tx, user, 'VENDOR_BILL_APPROVED_DESPITE_MISMATCH', orderId, { bill: bill.billNumber, note: reason, ownBill: bill.enteredById === user.id });
    });
    return this.orders.detail(user, orderId);
  }

  /** Writes down that the office paid an approved bill: when, how, and its reference. No money moves here. */
  async payBill(user: AuthenticatedUser, orderId: string, input: PayVendorBillInput): Promise<PurchaseOrderDetail> {
    const organizationId = user.organizationId;
    await this.assertActs(user, orderId, 'keep bills');
    if (input.paidOn > businessDate()) throw new ApplicationError(400, 'VENDOR_BILL_DAY_AHEAD', `A payment cannot be dated after today. It is ${dayWords(businessDate())} in Texas.`);
    await this.prisma.$transaction(async (tx) => {
      const bill = await this.billOf(tx, organizationId, orderId);
      if (bill.status !== VendorBillStatus.APPROVED) throw new ApplicationError(409, 'VENDOR_BILL_NOT_APPROVED', bill.status === VendorBillStatus.PAID ? 'This bill is already paid.' : 'A bill is paid once it is approved.');
      const paid = await tx.vendorBill.updateMany({
        where: { id: bill.id, organizationId, status: VendorBillStatus.APPROVED },
        data: { status: VendorBillStatus.PAID, paidOn: dateOf(input.paidOn), paymentMethod: input.method, paymentReference: text(input.reference), paidById: user.id, paidAt: new Date() },
      });
      if (paid.count !== 1) throw new ApplicationError(409, 'VENDOR_BILL_MOVED_ON', 'This bill is already paid.');
      await this.audit(tx, user, 'VENDOR_BILL_PAID', orderId, { bill: bill.billNumber, method: input.method, note: text(input.reference) });
      await this.settle(tx, user, orderId);
    });
    return this.orders.detail(user, orderId);
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, VendorBillStatus } from '@prisma/client';
import {
  VENDOR_PAYMENT_METHODS,
  VENDOR_PAYMENT_METHOD_LABEL,
  billPurchaseAccounts,
  formatMoney,
  paymentAccounts,
  xeroBillUrl,
  xeroCanWrite,
  type SaveXeroBillSettingsInput,
  type VendorBillInXero,
  type VendorPaymentMethod,
  type XeroAccount,
  type XeroBillSendStatus,
  type XeroBillSettings,
  type XeroBillSettingsView,
} from '@texasrenters/shared';
import { z } from 'zod';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { billIdempotencyKey, consoleOrderUrl, xeroBillFrom, xeroBillPaymentFrom, xeroDateFilter } from '../integrations/xero/xero-bill';
import { refused, said, xeroContacts, type XeroAnswer } from '../integrations/xero/xero-contacts';
import { XeroClient } from '../integrations/xero/xero.client';

/**
 * Vendor bills to Xero (2026-11-19, phase 7 of the inventory and purchasing
 * plan). An approved bill goes to its company's books once, as a draft bill,
 * when somebody presses "Send to Xero"; once the office has approved it
 * there, the payment recorded here can be sent against it, by a second press.
 *
 * What it costs: each press is a person's, and makes a counted handful of
 * calls under the organisation's daily ceiling (the client counts each one).
 * - Sending a bill: one PUT. The first bill of a vendor adds one or two
 *   calls to make or find its contact; a press after a lost answer adds one
 *   read, to look for the bill before making it.
 * - Sending a payment: one read of the bill, and one PUT.
 * Nothing goes by itself, on a timer, or when a page opens.
 *
 * What it never does: change, approve or void anything already in Xero. A
 * bill is made by PUT, which only ever creates; its row is written PENDING
 * first, and a lost answer is looked for by the link the bill carries, so it
 * is never made twice. Only a bill somebody approved here is sent, to the
 * books of the company its order names. Every send is audited.
 */

const BILLS = 'purchasing:bills';
/** A press whose answer never came is given this long before another may try. */
const STALE_MS = 2 * 60_000;

const validation = z.array(z.object({ Message: z.string() })).nullish();
const billsSchema = z.object({
  Invoices: z.array(
    z.object({
      InvoiceID: z.string().nullish(),
      Type: z.string().nullish(),
      Status: z.string().nullish(),
      Url: z.string().nullish(),
      AmountDue: z.number().nullish(),
      Payments: z.array(z.object({ PaymentID: z.string().nullish(), Amount: z.number().nullish() })).nullish(),
      StatusAttributeString: z.string().nullish(),
      ValidationErrors: validation,
    }),
  ),
});
const paymentsSchema = z.object({ Payments: z.array(z.object({ PaymentID: z.string().nullish(), StatusAttributeString: z.string().nullish(), ValidationErrors: validation })) });

const may = (user: AuthenticatedUser, permission: string) => (user.permissions as readonly string[]).includes(permission);
const taken = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const settingsFrom = (row: { purchasesAccountId: string | null; paymentAccounts: unknown } | null): XeroBillSettings => {
  const kept = (row?.paymentAccounts ?? {}) as Record<string, unknown>;
  const accounts: Partial<Record<VendorPaymentMethod, string>> = {};
  for (const method of VENDOR_PAYMENT_METHODS) if (typeof kept[method] === 'string' && kept[method]) accounts[method] = kept[method] as string;
  return { purchasesAccountId: row?.purchasesAccountId ?? null, paymentAccounts: accounts };
};

const ORDER = {
  id: true,
  number: true,
  xeroTenantId: true,
  vendor: { select: { id: true, name: true } },
  xeroOrganisation: { select: { name: true, status: true, organisation: true, accounts: true, billSettings: { select: { purchasesAccountId: true, paymentAccounts: true } } } },
  bill: {
    select: {
      id: true,
      billNumber: true,
      billDate: true,
      totalCents: true,
      status: true,
      paidOn: true,
      paymentMethod: true,
      paymentReference: true,
      lines: { select: { quantity: true, unitPriceCents: true, orderLine: { select: { position: true, item: { select: { code: true, name: true } } } } } },
      inXero: true,
    },
  },
} satisfies Prisma.PurchaseOrderSelect;
type Order = Prisma.PurchaseOrderGetPayload<{ select: typeof ORDER }>;

@Injectable()
export class VendorBillsXeroService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(XeroClient) private readonly client: XeroClient,
  ) {}

  // ── A company's choices ─────────────────────────────────────────────────

  /** The choices and what they are chosen from, as the console last read Xero: no call to Xero. */
  async settings(user: AuthenticatedUser, tenantId: string): Promise<XeroBillSettingsView> {
    const organisation = await this.organisation(user.organizationId, tenantId);
    const option = (account: XeroAccount) => ({ accountId: account.accountId, code: account.code, name: account.name });
    return {
      tenantId,
      settings: settingsFrom(organisation.billSettings),
      purchaseAccounts: billPurchaseAccounts(organisation.accounts).map(option),
      bankAccounts: paymentAccounts(organisation.accounts).map(option),
    };
  }

  async saveSettings(user: AuthenticatedUser, tenantId: string, input: SaveXeroBillSettingsInput): Promise<XeroBillSettingsView> {
    const { organizationId } = user;
    const organisation = await this.organisation(organizationId, tenantId);
    if (input.purchasesAccountId && !billPurchaseAccounts(organisation.accounts).some((account) => account.accountId === input.purchasesAccountId))
      throw new ApplicationError(422, 'XERO_BILL_ACCOUNT_UNKNOWN', 'That account is not one a bill can be booked to in Xero. Read the organisation again, or choose another.');
    const banks = paymentAccounts(organisation.accounts);
    const chosen: Partial<Record<VendorPaymentMethod, string>> = {};
    for (const method of VENDOR_PAYMENT_METHODS) {
      const accountId = input.paymentAccounts[method];
      if (!accountId) continue;
      if (!banks.some((account) => account.accountId === accountId))
        throw new ApplicationError(422, 'XERO_BILL_ACCOUNT_UNKNOWN', `The account chosen for ${VENDOR_PAYMENT_METHOD_LABEL[method].toLowerCase()} payments does not take payments in Xero. Choose another.`);
      chosen[method] = accountId;
    }
    const before = settingsFrom(organisation.billSettings);
    const data = { purchasesAccountId: input.purchasesAccountId ?? null, paymentAccounts: chosen, updatedByName: user.displayName };
    await this.prisma.$transaction([
      this.prisma.xeroBillSettings.upsert({ where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } }, create: { organizationId, xeroTenantId: tenantId, ...data }, update: data }),
      this.prisma.auditLog.create({
        data: { organizationId, ...auditActor(user), action: 'XERO_BILL_SETTINGS_CHANGED', entityType: 'XeroSettings', entityId: organizationId, metadata: { tenantId, before, after: { purchasesAccountId: data.purchasesAccountId, paymentAccounts: chosen } } as never },
      }),
    ]);
    return this.settings(user, tenantId);
  }

  private async organisation(organizationId: string, tenantId: string) {
    const row = await this.prisma.xeroOrganisation.findUnique({
      where: { organizationId_xeroTenantId: { organizationId, xeroTenantId: tenantId } },
      select: { accounts: true, billSettings: { select: { purchasesAccountId: true, paymentAccounts: true } } },
    });
    if (!row) throw new ApplicationError(404, 'XERO_ORGANISATION_UNKNOWN', 'That is not one of the office’s Xero organisations.');
    return { accounts: (row.accounts as XeroAccount[] | null) ?? [], billSettings: row.billSettings };
  }

  // ── A bill's standing ───────────────────────────────────────────────────

  /** Where the order's bill stands with Xero, and what this person may press: two reads, no call to Xero. */
  async standing(user: AuthenticatedUser, orderId: string): Promise<VendorBillInXero> {
    const { order, connection } = await this.read(user.organizationId, orderId);
    return this.view(user, order, connection);
  }

  private async read(organizationId: string, orderId: string) {
    const [order, connection] = await Promise.all([
      this.prisma.purchaseOrder.findFirst({ where: { id: orderId, organizationId }, select: ORDER }),
      this.prisma.xeroConnection.findUnique({ where: { organizationId }, select: { status: true, scopes: true } }),
    ]);
    if (!order) throw new ApplicationError(404, 'PURCHASE_ORDER_NOT_FOUND', 'That purchase order is not on the list.');
    if (!order.bill) throw new ApplicationError(404, 'VENDOR_BILL_NOT_FOUND', 'No bill has been entered for that order.');
    return { order: order as Order & { bill: NonNullable<Order['bill']> }, connection };
  }

  /** The account a bill is booked to, when one is chosen and Xero still has it. */
  private purchasesAccount(order: Order) {
    const chosen = settingsFrom(order.xeroOrganisation?.billSettings ?? null).purchasesAccountId;
    return billPurchaseAccounts((order.xeroOrganisation?.accounts as XeroAccount[] | null) ?? []).find((account) => account.accountId === chosen) ?? null;
  }

  /** The account the bill's payment comes out of, by how it was paid. */
  private paymentAccount(order: Order) {
    const method = order.bill?.paymentMethod as VendorPaymentMethod | null | undefined;
    const chosen = method ? settingsFrom(order.xeroOrganisation?.billSettings ?? null).paymentAccounts[method] : undefined;
    return paymentAccounts((order.xeroOrganisation?.accounts as XeroAccount[] | null) ?? []).find((account) => account.accountId === chosen) ?? null;
  }

  /** Why the bill cannot be sent, in the office's words; null when it can. */
  private waitsOn(order: Order, connection: { status: string; scopes: string[] } | null): string | null {
    const bill = order.bill!;
    if (bill.status !== VendorBillStatus.APPROVED && bill.status !== VendorBillStatus.PAID) return 'Approve the bill first. Only an approved bill goes to Xero.';
    if (!order.xeroTenantId || !order.xeroOrganisation) return 'This order names no company, so there are no books for the bill to go to.';
    if (connection?.status !== 'CONNECTED' || order.xeroOrganisation.status !== 'CONNECTED') return `${order.xeroOrganisation.name} is not connected to Xero. Connect it again on the Xero page.`;
    if (!xeroCanWrite(connection.scopes)) return 'The Xero connection may only read. Allow sending on the Xero page.';
    if (!order.vendor) return 'The order names no vendor.';
    if (bill.totalCents <= 0) return 'A bill of nothing is not sent.';
    if (!this.purchasesAccount(order)) return `Choose the account ${order.xeroOrganisation.name}'s bills are booked to, on the Xero page.`;
    return null;
  }

  private paymentWaitsOn(order: Order): string | null {
    const bill = order.bill!;
    if (bill.inXero?.status !== 'SENT') return 'Send the bill to Xero first.';
    if (bill.status !== VendorBillStatus.PAID || !bill.paidOn || !bill.paymentMethod) return 'Record the payment here first.';
    if (!this.paymentAccount(order)) return `Choose the account ${VENDOR_PAYMENT_METHOD_LABEL[bill.paymentMethod as VendorPaymentMethod].toLowerCase()} payments come out of, on the Xero page.`;
    return null;
  }

  private view(user: AuthenticatedUser, order: Order, connection: { status: string; scopes: string[] } | null): VendorBillInXero {
    const sync = order.bill!.inXero;
    const status: XeroBillSendStatus = (sync?.status as XeroBillSendStatus | undefined) ?? 'NOT_SENT';
    const paymentStatus: XeroBillSendStatus = (sync?.paymentStatus as XeroBillSendStatus | null | undefined) ?? 'NOT_SENT';
    const sent = status === 'SENT';
    const waitsOn = sent ? null : this.waitsOn(order, connection);
    const paymentWaitsOn = paymentStatus === 'SENT' ? null : this.paymentWaitsOn(order);
    const person = may(user, BILLS) && user.principalType !== 'API_KEY';
    const shortCode = (order.xeroOrganisation?.organisation as { shortCode?: string | null } | null)?.shortCode ?? null;
    return {
      company: order.xeroTenantId && order.xeroOrganisation ? { tenantId: order.xeroTenantId, name: order.xeroOrganisation.name } : null,
      status,
      url: sync?.xeroInvoiceId ? xeroBillUrl(sync.xeroInvoiceId, shortCode) : null,
      problem: sent ? null : (sync?.problem ?? null),
      sentBy: sync?.sentByName ?? null,
      sentAt: sync?.sentAt?.toISOString() ?? null,
      payment: { status: paymentStatus, problem: paymentStatus === 'SENT' ? null : (sync?.paymentProblem ?? null), sentBy: sync?.paymentSentByName ?? null, sentAt: sync?.paymentSentAt?.toISOString() ?? null },
      waitsOn,
      paymentWaitsOn: sent ? paymentWaitsOn : null,
      can: { send: person && !sent && !waitsOn, sendPayment: person && sent && paymentStatus !== 'SENT' && !paymentWaitsOn },
    };
  }

  // ── Sending the bill ────────────────────────────────────────────────────

  /** Makes the bill in Xero as a draft, once. Pressed again after it has gone, it answers with where it stands. */
  async send(user: AuthenticatedUser, orderId: string): Promise<VendorBillInXero> {
    const { organizationId } = user;
    if (user.principalType === 'API_KEY') throw new ApplicationError(403, 'XERO_BILL_NEEDS_A_PERSON', 'A bill is sent to Xero by a person at the screen.');
    const { order, connection } = await this.read(organizationId, orderId);
    const bill = order.bill;
    if (bill.inXero?.status === 'SENT') return this.view(user, order, connection);
    const waitsOn = this.waitsOn(order, connection);
    if (waitsOn) throw new ApplicationError(409, 'XERO_BILL_NOT_READY', waitsOn);
    const tenantId = order.xeroTenantId!;
    const account = this.purchasesAccount(order)!;

    // Ours for this press, or somebody else's: a row is written before Xero is asked.
    const tried = Boolean(bill.inXero);
    await this.claim(bill.id, organizationId, tenantId, tried);

    try {
      const contactKey = `vendor:${order.vendor!.id}`;
      const contact = (await xeroContacts(this.prisma, this.client, organizationId, tenantId, new Map([[contactKey, order.vendor!.name]]))).get(contactKey);
      if (!contact || 'problem' in contact) throw new ApplicationError(422, 'XERO_BILL_CONTACT', contact?.problem ?? 'The vendor could not be made a contact in Xero.');

      const url = consoleOrderUrl(order.id);
      const body = xeroBillFrom(
        {
          billNumber: bill.billNumber,
          billDate: bill.billDate,
          totalCents: bill.totalCents,
          lines: [...bill.lines].sort((left, right) => left.orderLine.position - right.orderLine.position).map((line) => ({ code: line.orderLine.item.code, name: line.orderLine.item.name, quantity: line.quantity, unitPriceCents: line.unitPriceCents })),
        },
        { contactId: contact.id, accountCode: account.code!, url },
      );

      // Tried before, and Xero's answer not kept: it may be there already. Looked for by the link it carries, never made twice.
      let xeroInvoiceId: string | null = null;
      if (tried) {
        const where = encodeURIComponent(`Date==${xeroDateFilter(body.Date)}`);
        const theirs = await this.client.get(organizationId, tenantId, `/Invoices?ContactIDs=${encodeURIComponent(contact.id)}&where=${where}&Statuses=DRAFT,SUBMITTED,AUTHORISED,PAID`, billsSchema);
        xeroInvoiceId = theirs.Invoices.find((invoice) => invoice.Type === 'ACCPAY' && invoice.Url === url && invoice.InvoiceID)?.InvoiceID ?? null;
      }
      if (!xeroInvoiceId) {
        const path = '/Invoices?summarizeErrors=false';
        const sent = { Invoices: [body] };
        const answer: XeroAnswer | undefined = (await this.client.put(organizationId, tenantId, path, sent, billsSchema, billIdempotencyKey(`${organizationId}:${tenantId}:${bill.id}`, path, sent))).Invoices[0];
        if (!answer?.InvoiceID || refused(answer)) throw new ApplicationError(422, 'XERO_VALIDATION', `Xero refused it: ${answer ? said(answer) : 'it did not answer for the bill.'}`);
        xeroInvoiceId = answer.InvoiceID;
      }

      await this.prisma.$transaction([
        this.prisma.vendorBillXero.update({ where: { billId: bill.id }, data: { status: 'SENT', xeroInvoiceId, problem: null, sentById: user.id, sentByName: user.displayName, sentAt: new Date() } }),
        this.prisma.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'VENDOR_BILL_SENT_TO_XERO', entityType: 'PurchaseOrder', entityId: order.id, metadata: { number: order.number, billNumber: bill.billNumber, tenantId, xeroInvoiceId, totalCents: bill.totalCents, account: account.code } },
        }),
      ]);
    } catch (error) {
      await this.prisma.vendorBillXero.updateMany({ where: { billId: bill.id, organizationId, status: 'PENDING' }, data: { status: 'FAILED', problem: this.words(error) } });
      throw error;
    }
    return this.standing(user, orderId);
  }

  /** Takes the bill for this press: a new row, or one whose last try failed or went quiet. */
  private async claim(billId: string, organizationId: string, tenantId: string, tried: boolean): Promise<void> {
    const busy = new ApplicationError(409, 'XERO_BILL_BEING_SENT', 'This bill is being sent to Xero now. Give it a couple of minutes.');
    if (!tried) {
      try {
        await this.prisma.vendorBillXero.create({ data: { billId, organizationId, xeroTenantId: tenantId, status: 'PENDING' } });
        return;
      } catch (error) {
        if (taken(error)) throw busy;
        throw error;
      }
    }
    const mine = await this.prisma.vendorBillXero.updateMany({
      where: { billId, organizationId, OR: [{ status: 'FAILED' }, { status: 'PENDING', attemptedAt: { lt: new Date(Date.now() - STALE_MS) } }] },
      data: { status: 'PENDING', attemptedAt: new Date(), problem: null },
    });
    if (mine.count !== 1) throw busy;
  }

  // ── Sending the payment ─────────────────────────────────────────────────

  /**
   * Records the payment against the bill in Xero, once the office has
   * approved the bill there: Xero takes no payment on a draft. The bill is
   * read first, so a payment already on it is kept and not made again.
   */
  async sendPayment(user: AuthenticatedUser, orderId: string): Promise<VendorBillInXero> {
    const { organizationId } = user;
    if (user.principalType === 'API_KEY') throw new ApplicationError(403, 'XERO_BILL_NEEDS_A_PERSON', 'A payment is sent to Xero by a person at the screen.');
    const { order, connection } = await this.read(organizationId, orderId);
    const bill = order.bill;
    const sync = bill.inXero;
    if (sync?.paymentStatus === 'SENT') return this.view(user, order, connection);
    const waitsOn = this.paymentWaitsOn(order) ?? (connection?.status !== 'CONNECTED' ? 'Xero is not connected. Connect it again on the Xero page.' : null);
    if (waitsOn) throw new ApplicationError(409, 'XERO_BILL_PAYMENT_NOT_READY', waitsOn);
    const tenantId = sync!.xeroTenantId;
    const xeroInvoiceId = sync!.xeroInvoiceId!;
    const account = this.paymentAccount(order)!;

    const mine = await this.prisma.vendorBillXero.updateMany({
      where: { billId: bill.id, organizationId, status: 'SENT', OR: [{ paymentStatus: null }, { paymentStatus: 'FAILED' }, { paymentStatus: 'PENDING', paymentAttemptedAt: { lt: new Date(Date.now() - STALE_MS) } }] },
      data: { paymentStatus: 'PENDING', paymentAttemptedAt: new Date(), paymentProblem: null },
    });
    if (mine.count !== 1) throw new ApplicationError(409, 'XERO_BILL_BEING_SENT', 'This payment is being sent to Xero now. Give it a couple of minutes.');

    try {
      const theirs = (await this.client.get(organizationId, tenantId, `/Invoices/${encodeURIComponent(xeroInvoiceId)}`, billsSchema)).Invoices[0];
      if (!theirs) throw new ApplicationError(409, 'XERO_BILL_GONE', 'Xero no longer has this bill.');
      const amount = Number((bill.totalCents / 100).toFixed(2));
      // Tried before: a payment of the same amount on the bill is the one, and is kept.
      let xeroPaymentId = sync!.paymentStatus ? ((theirs.Payments ?? []).find((payment) => payment.PaymentID && payment.Amount === amount)?.PaymentID ?? null) : null;
      if (!xeroPaymentId) {
        if (theirs.Status === 'DRAFT' || theirs.Status === 'SUBMITTED') throw new ApplicationError(409, 'XERO_BILL_STILL_A_DRAFT', 'The bill is still a draft in Xero. Approve it there first: Xero takes no payment on a draft.');
        if (theirs.Status === 'VOIDED' || theirs.Status === 'DELETED') throw new ApplicationError(409, 'XERO_BILL_GONE', 'The bill was voided or deleted in Xero, so there is nothing to pay there.');
        if (theirs.Status === 'PAID') throw new ApplicationError(409, 'XERO_BILL_ALREADY_PAID', 'Xero already has this bill as paid. Nothing was sent.');
        const due = Math.round((theirs.AmountDue ?? 0) * 100);
        if (due < bill.totalCents) throw new ApplicationError(409, 'XERO_BILL_AMOUNT_DIFFERS', `Xero has ${formatMoney(due)} still to pay on this bill, less than the ${formatMoney(bill.totalCents)} recorded here. Nothing was sent.`);

        const path = '/Payments?summarizeErrors=false';
        const reference = bill.paymentReference?.trim() || VENDOR_PAYMENT_METHOD_LABEL[bill.paymentMethod as VendorPaymentMethod];
        const sent = { Payments: [xeroBillPaymentFrom({ paidOn: bill.paidOn!, amountCents: bill.totalCents, reference }, { xeroInvoiceId, accountId: account.accountId })] };
        const answer: XeroAnswer | undefined = (await this.client.put(organizationId, tenantId, path, sent, paymentsSchema, billIdempotencyKey(`${organizationId}:${tenantId}:${bill.id}:payment`, path, sent))).Payments[0];
        if (!answer?.PaymentID || refused(answer)) throw new ApplicationError(422, 'XERO_VALIDATION', `Xero refused it: ${answer ? said(answer) : 'it did not answer for the payment.'}`);
        xeroPaymentId = answer.PaymentID;
      }
      await this.prisma.$transaction([
        this.prisma.vendorBillXero.update({ where: { billId: bill.id }, data: { paymentStatus: 'SENT', xeroPaymentId, paymentProblem: null, paymentSentByName: user.displayName, paymentSentAt: new Date() } }),
        this.prisma.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'VENDOR_BILL_PAYMENT_SENT_TO_XERO', entityType: 'PurchaseOrder', entityId: order.id, metadata: { number: order.number, billNumber: bill.billNumber, tenantId, xeroInvoiceId, xeroPaymentId, amountCents: bill.totalCents, method: bill.paymentMethod } },
        }),
      ]);
    } catch (error) {
      await this.prisma.vendorBillXero.updateMany({ where: { billId: bill.id, organizationId, paymentStatus: 'PENDING' }, data: { paymentStatus: 'FAILED', paymentProblem: this.words(error) } });
      throw error;
    }
    return this.standing(user, orderId);
  }

  /** What went wrong, as the page may show it: our own sentences and Xero's validation words, never a raw error. */
  private words(error: unknown): string {
    return error instanceof ApplicationError ? error.message.slice(0, 500) : 'Xero could not be reached. Press again in a moment: the console looks for it there first.';
  }
}

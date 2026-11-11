import { Inject, Injectable } from '@nestjs/common';
import {
  INVOICE_STATUS_ACTION_LABEL,
  INVOICE_STATUS_LABEL,
  PAYMENT_METHOD_LABEL,
  canDeleteInvoice,
  formatMoney,
  invoiceAmounts,
  invoiceCompany,
  invoiceEditProblem,
  invoiceStatusActionProblem,
  invoiceStatusOn,
  isEditableInvoiceStatus,
  lineTotalCents,
  type EditInvoiceInput,
  type EditInvoiceLineInput,
  type InvoiceDetail,
  type InvoiceDiscountInput,
  type InvoiceHistory,
  type InvoiceHistoryEvent,
  type InvoiceStatusAction,
  type InvoiceStatusChangeInput,
  type InvoiceTaxInput,
  type PaymentMethod,
  CLIENT_VIEW_LABEL,
  type InvoiceClientView,
} from '@texasrenters/shared';
import { InvoiceOrigin, InvoiceStatus, type Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { nextInvoiceNumber } from './invoice-numbers';
import { InvoicesService } from './invoices.service';
import { invoiceWritesOff, invoiceWritesOn, officeOrganisations, organisationName, productCompanies } from './invoice-settings';
import { SHOWN_INVOICE } from './shown-invoices';

/**
 * Editing an invoice in the console (2026-11-06, phase 3 of taking invoicing
 * over from Jobber): its details and lines, the discount and tax, the client
 * message and the contract text; marking a draft sent, voiding, closing as bad
 * debt and reopening; deleting a draft; and the invoice's history.
 *
 * Off until the cutover, as making an invoice and recording a payment are
 * (`JOBBER_INVOICE_WRITES_ENABLED`): until then Jobber holds the invoices, and
 * an edit here would be undone by the next read of Jobber's copy.
 *
 * Every write is the office's, under `invoices:manage`, against the invoice as
 * it was read (`expectedUpdatedAt`), so two people editing at once cannot both
 * win; and every one is written to the audit log in words the History shows.
 * The totals are worked out here from the lines, never taken from the browser,
 * and never below what the invoice's payments come to.
 */

const DAY_MS = 86_400_000;
const HISTORY_LIMIT = 100;

const day = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);
const dateOf = (value: string) => new Date(`${value}T00:00:00.000Z`);

/** "Nov 1, 2026": a day as the History prints it. */
const DAY_WORDS = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const dayWords = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? DAY_WORDS.format(new Date(`${value}T12:00:00.000Z`)) : 'none';

const editSelect = {
  id: true,
  origin: true,
  status: true,
  number: true,
  subject: true,
  issuedOn: true,
  dueOn: true,
  paidOn: true,
  totalCents: true,
  balanceCents: true,
  discountCents: true,
  discountRate: true,
  discountKind: true,
  taxRateName: true,
  taxRatePercent: true,
  clientMessage: true,
  contractDisclaimer: true,
  showQuantities: true,
  showUnitPrices: true,
  showLineTotals: true,
  showAccountBalance: true,
  showLateStamp: true,
  updatedAt: true,
  // The company's books it goes to, and whether it reached them (2026-11-10).
  xeroTenantId: true,
  xeroSync: { select: { xeroInvoiceId: true } },
  lines: {
    orderBy: { position: 'asc' },
    select: { name: true, quantity: true, unitPriceCents: true, description: true, serviceOn: true, taxable: true },
  },
} satisfies Prisma.InvoiceSelect;

type EditRow = Prisma.InvoiceGetPayload<{ select: typeof editSelect }>;

/** One change, in the History's words. */
export interface InvoiceChange {
  field: string;
  from: string;
  to: string;
}

const text = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);
const shown = (value: string | null) => value ?? 'none';

export function discountWords(discount: InvoiceDiscountInput | null, cents: number) {
  if (!discount || !cents) return 'none';
  return discount.kind === 'PERCENT' ? `${discount.percent}% (${formatMoney(cents)})` : formatMoney(cents);
}

export function taxWords(tax: InvoiceTaxInput | null) {
  return tax ? `${tax.name} ${tax.percent}%` : 'none';
}

const lineWords = (line: Pick<EditInvoiceLineInput, 'name' | 'quantity' | 'unitPriceCents'>) =>
  `${line.name} × ${line.quantity} at ${formatMoney(line.unitPriceCents)}`;

/** The stored discount as an input, to compare an edit with. */
function storedDiscount(row: EditRow): InvoiceDiscountInput | null {
  if (!row.discountCents) return null;
  return row.discountKind === 'PERCENT' && row.discountRate !== null
    ? { kind: 'PERCENT', percent: row.discountRate }
    : { kind: 'AMOUNT', amountCents: row.discountCents };
}

function storedTax(row: EditRow): InvoiceTaxInput | null {
  return row.taxRateName && row.taxRatePercent ? { name: row.taxRateName, percent: row.taxRatePercent } : null;
}

/** What an edit changed, field by field, in words; lines by what was added and taken off. */
export function invoiceChanges(
  before: EditRow,
  after: Omit<EditInvoiceInput, 'expectedUpdatedAt'>,
  amounts: { discountCents: number; totalCents: number },
): InvoiceChange[] {
  const changes: InvoiceChange[] = [];
  const compare = (field: string, from: string, to: string) => {
    if (from !== to) changes.push({ field, from, to });
  };
  compare('Subject', before.subject, after.subject);
  compare('Invoice #', shown(before.number), shown(after.number));
  compare('Issued', dayWords(day(before.issuedOn)), dayWords(after.issuedOn));
  compare('Due', dayWords(day(before.dueOn)), dayWords(after.dueOn));

  const was = before.lines.map(lineWords);
  const now = after.lineItems.map(lineWords);
  const removed = was.filter((line) => !now.includes(line));
  const added = now.filter((line) => !was.includes(line));
  if (removed.length || added.length)
    changes.push({ field: 'Lines', from: removed.join('; ') || 'nothing taken off', to: added.join('; ') || 'nothing added' });
  else if (
    JSON.stringify(before.lines.map((line) => [line.description ?? null, day(line.serviceOn), line.taxable !== false])) !==
    JSON.stringify(after.lineItems.map((line) => [line.description ?? null, line.serviceOn ?? null, line.taxable !== false]))
  )
    changes.push({ field: 'Lines', from: 'as they were', to: 'descriptions, service days or tax changed' });

  compare('Discount', discountWords(storedDiscount(before), before.discountCents), discountWords(after.discount, amounts.discountCents));
  compare('Tax', taxWords(storedTax(before)), taxWords(after.tax));
  compare('Total', formatMoney(before.totalCents), formatMoney(amounts.totalCents));
  compare('Client message', shown(before.clientMessage), shown(after.clientMessage ?? null));
  compare('Contract / disclaimer', shown(before.contractDisclaimer), shown(after.contractDisclaimer ?? null));
  if (after.clientView)
    for (const key of Object.keys(CLIENT_VIEW_LABEL) as (keyof InvoiceClientView)[])
      compare(`Client view: ${CLIENT_VIEW_LABEL[key]}`, before[key] ? 'shown' : 'hidden', after.clientView[key] ? 'shown' : 'hidden');
  return changes;
}

/** An audit entry as the History shows it: what happened, and what changed, in words. */
export function historyEvent(
  row: { id: string; action: string; createdAt: Date; metadata: Prisma.JsonValue | null },
  actor: { id: string; displayName: string } | null,
): InvoiceHistoryEvent {
  const meta = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {}) as Record<
    string,
    unknown
  >;
  const cents = (value: unknown) => (typeof value === 'number' ? formatMoney(value) : '');
  const method = (value: unknown) => PAYMENT_METHOD_LABEL[value as PaymentMethod] ?? 'another way';
  const status = (value: unknown) => INVOICE_STATUS_LABEL[value as keyof typeof INVOICE_STATUS_LABEL] ?? String(value ?? '');
  const record = (value: unknown) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : {});
  const base = { id: row.id, at: row.createdAt.toISOString(), actor };
  switch (row.action) {
    case 'INVOICE_CREATED':
      return {
        ...base,
        title: 'Invoice created',
        lines: [`${cents(meta.totalCents)}, ${String(meta.lineCount ?? '')} lines`, `Issued ${dayWords(meta.issuedOn as string)}`],
      };
    case 'INVOICE_EDITED':
      return {
        ...base,
        title: 'Invoice edited',
        lines: (Array.isArray(meta.changes) ? meta.changes : []).map((change) => {
          const { field, from, to } = record(change);
          return `${String(field)}: ${String(from)} → ${String(to)}`;
        }),
      };
    case 'INVOICE_STATUS_CHANGED':
      return {
        ...base,
        title: INVOICE_STATUS_ACTION_LABEL[meta.action as InvoiceStatusAction] ?? 'Status changed',
        lines: [`${status(meta.from)} → ${status(meta.to)}`, ...(typeof meta.balanceCents === 'number' ? [`Balance ${cents(meta.balanceCents)}`] : [])],
      };
    case 'INVOICE_PAYMENT_RECORDED':
      return {
        ...base,
        title: 'Payment recorded',
        lines: [`${cents(meta.amountCents)} by ${method(meta.method)}, paid ${dayWords(meta.paidOn as string)}`, `Balance ${cents(meta.balanceCents)}`],
      };
    case 'INVOICE_PAYMENT_CHANGED': {
      const was = record(meta.before);
      const now = record(meta.after);
      const lines = [
        was.amountCents !== now.amountCents ? `Amount: ${cents(was.amountCents)} → ${cents(now.amountCents)}` : null,
        was.paidOn !== now.paidOn ? `Paid on: ${dayWords(was.paidOn as string)} → ${dayWords(now.paidOn as string)}` : null,
        was.method !== now.method ? `Method: ${method(was.method)} → ${method(now.method)}` : null,
        was.reference !== now.reference ? `Reference: ${String(was.reference ?? 'none')} → ${String(now.reference ?? 'none')}` : null,
        `Balance ${cents(meta.balanceCents)}`,
      ];
      return { ...base, title: 'Payment changed', lines: lines.filter((line): line is string => Boolean(line)) };
    }
    case 'INVOICE_PAYMENT_REMOVED': {
      const removed = record(meta.removed);
      return {
        ...base,
        title: 'Payment removed',
        lines: [`${cents(removed.amountCents)} by ${method(removed.method)}, paid ${dayWords(removed.paidOn as string)}`, `Balance ${cents(meta.balanceCents)}`],
      };
    }
    // Sent from the console by email (2026-11-06, phase 5).
    case 'INVOICE_SENT': {
      const to = Array.isArray(meta.to) ? meta.to.map(String) : [];
      return {
        ...base,
        title: meta.status === 'FAILED' ? 'Email not sent' : 'Emailed',
        lines: [`To ${to.join(', ') || 'nobody'}`, ...(typeof meta.failure === 'string' ? [meta.failure] : [])],
      };
    }
    default:
      return { ...base, title: row.action.toLowerCase().replaceAll('_', ' ').replace(/^\w/, (letter) => letter.toUpperCase()), lines: [] };
  }
}

@Injectable()
export class InvoiceEditsService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(InvoicesService) private readonly invoices: InvoicesService,
  ) {}

  /** The invoice's details, lines, discount, tax and messages, replaced by what was saved. */
  async edit(user: AuthenticatedUser, id: string, input: EditInvoiceInput): Promise<InvoiceDetail> {
    await this.requireWrites(user);
    const today = businessDate();
    const clean: Omit<EditInvoiceInput, 'expectedUpdatedAt'> = {
      subject: input.subject.trim(),
      number: input.number === null ? null : input.number.trim(),
      issuedOn: input.issuedOn,
      dueOn: input.dueOn,
      lineItems: input.lineItems.map((line) => ({
        name: line.name.trim(),
        description: text(line.description),
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        serviceOn: line.serviceOn || null,
        taxable: line.taxable !== false,
      })),
      discount: input.discount,
      tax: input.tax ? { name: input.tax.name.trim(), percent: input.tax.percent } : null,
      clientMessage: text(input.clientMessage),
      contractDisclaimer: text(input.contractDisclaimer),
      ...(input.clientView ? { clientView: input.clientView } : {}),
    };

    await this.prisma.$transaction(async (tx) => {
      const before = await this.invoiceAsRead(tx, user, id, input.expectedUpdatedAt);
      const status = invoiceStatusOn(before.status, day(before.dueOn), today);
      if (!isEditableInvoiceStatus(status))
        throw new ApplicationError(409, 'INVOICE_LOCKED', `A ${INVOICE_STATUS_LABEL[status].toLowerCase()} invoice is reopened before it is edited.`);
      if (clean.number === null && before.number !== null) throw new ApplicationError(422, 'INVOICE_INVALID', 'Give the invoice a number.');
      const paidCents = await this.paidCents(tx, id);
      const problem = invoiceEditProblem(clean, paidCents);
      if (problem) throw new ApplicationError(422, 'INVOICE_INVALID', problem);
      if (clean.number && clean.number !== before.number) {
        const taken = await tx.invoice.findFirst({
          where: { organizationId: user.organizationId, ...SHOWN_INVOICE, number: clean.number, id: { not: id } },
          select: { id: true },
        });
        if (taken) throw new ApplicationError(409, 'INVOICE_NUMBER_TAKEN', `Invoice #${clean.number} is another invoice already.`);
      }
      const company = await this.companyAfterEdit(tx, user, before, clean.lineItems);

      const amounts = invoiceAmounts(clean.lineItems, clean.discount, clean.tax);
      const balanceCents = amounts.totalCents - paidCents;
      const draft = before.status === InvoiceStatus.DRAFT;
      const paid = !draft && balanceCents === 0;
      const { count } = await tx.invoice.updateMany({
        where: { id, organizationId: user.organizationId, updatedAt: before.updatedAt },
        data: {
          subject: clean.subject,
          number: clean.number,
          issuedOn: dateOf(clean.issuedOn),
          dueOn: dateOf(clean.dueOn),
          paymentTermsDays: Math.round((dateOf(clean.dueOn).getTime() - dateOf(clean.issuedOn).getTime()) / DAY_MS),
          subtotalCents: amounts.subtotalCents,
          discountCents: amounts.discountCents,
          discountKind: clean.discount ? clean.discount.kind : null,
          discountRate: clean.discount?.kind === 'PERCENT' ? clean.discount.percent : null,
          taxCents: amounts.taxCents,
          taxRateName: clean.tax?.name ?? null,
          taxRatePercent: clean.tax?.percent ?? null,
          taxInclusive: clean.tax ? false : null,
          totalCents: amounts.totalCents,
          balanceCents,
          status: draft ? InvoiceStatus.DRAFT : paid ? InvoiceStatus.PAID : InvoiceStatus.AWAITING_PAYMENT,
          paidOn: paid ? (before.paidOn ?? (await this.latestPaymentDay(tx, id))) : null,
          clientMessage: clean.clientMessage,
          contractDisclaimer: clean.contractDisclaimer,
          ...(clean.clientView ?? {}),
          xeroTenantId: company.xeroTenantId,
        },
      });
      if (!count) throw this.invoiceChanged();
      await tx.invoiceLine.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceLine.createMany({
        data: clean.lineItems.map((line, position) => ({
          organizationId: user.organizationId,
          invoiceId: id,
          position,
          name: line.name,
          description: line.description ?? null,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          totalCents: lineTotalCents(line),
          serviceOn: line.serviceOn ? dateOf(line.serviceOn) : null,
          taxable: line.taxable !== false,
        })),
      });
      await this.audit(tx, user, id, 'INVOICE_EDITED', {
        changes: [...invoiceChanges(before, clean, amounts), ...company.changes] as unknown as Prisma.InputJsonValue,
        totalCents: amounts.totalCents,
        balanceCents,
      });
    });
    return this.invoices.one(user, id);
  }

  /** Marking a draft sent, voiding, closing as bad debt, or reopening. */
  async changeStatus(user: AuthenticatedUser, id: string, input: InvoiceStatusChangeInput): Promise<InvoiceDetail> {
    await this.requireWrites(user);
    const today = businessDate();
    await this.prisma.$transaction(async (tx) => {
      const before = await this.invoiceAsRead(tx, user, id, input.expectedUpdatedAt);
      const paidCents = await this.paidCents(tx, id);
      const shownStatus = invoiceStatusOn(before.status, day(before.dueOn), today);
      const refused = invoiceStatusActionProblem(input.action, {
        status: shownStatus,
        balanceCents: before.balanceCents,
        paidCents,
      });
      if (refused) throw new ApplicationError(409, 'INVOICE_ACTION_REFUSED', refused);

      // What it owes once it is owed again: its total less what has been paid.
      const owed = before.totalCents - paidCents;
      const owing = async () =>
        owed === 0
          ? { status: InvoiceStatus.PAID, balanceCents: 0, paidOn: await this.latestPaymentDay(tx, id) }
          : { status: InvoiceStatus.AWAITING_PAYMENT, balanceCents: owed, paidOn: null };
      const data =
        input.action === 'VOID'
          ? { status: InvoiceStatus.VOIDED, balanceCents: 0 }
          : input.action === 'BAD_DEBT'
            ? { status: InvoiceStatus.BAD_DEBT }
            : await owing();
      // A draft sent with no number takes the office's next one (2026-11-06, phase 4).
      const number = input.action === 'MARK_SENT' && before.number === null ? await nextInvoiceNumber(tx, user.organizationId) : null;
      const { count } = await tx.invoice.updateMany({
        where: { id, organizationId: user.organizationId, updatedAt: before.updatedAt },
        data: { ...data, ...(number ? { number } : {}) },
      });
      if (!count) throw this.invoiceChanged();
      await this.audit(tx, user, id, 'INVOICE_STATUS_CHANGED', {
        action: input.action,
        from: before.status,
        to: data.status,
        balanceCents: data.balanceCents ?? before.balanceCents,
        ...(number ? { number } : {}),
      });
    });
    return this.invoices.one(user, id);
  }

  /** A draft nobody paid anything on, deleted; the record keeps what it was. Anything sent is voided instead. */
  async remove(user: AuthenticatedUser, id: string, expectedUpdatedAt: string): Promise<{ id: string }> {
    await this.requireWrites(user);
    await this.prisma.$transaction(async (tx) => {
      const before = await this.invoiceAsRead(tx, user, id, expectedUpdatedAt);
      const paidCents = await this.paidCents(tx, id);
      if (!canDeleteInvoice({ status: before.status, paidCents }))
        throw new ApplicationError(409, 'INVOICE_NOT_DELETABLE', 'Only a draft nobody has paid anything on is deleted. Void a sent invoice instead.');
      await this.audit(tx, user, id, 'INVOICE_DELETED', {
        number: before.number,
        subject: before.subject,
        totalCents: before.totalCents,
        issuedOn: day(before.issuedOn),
      });
      const { count } = await tx.invoice.deleteMany({
        where: { id, organizationId: user.organizationId, updatedAt: before.updatedAt },
      });
      if (!count) throw this.invoiceChanged();
    });
    return { id };
  }

  /**
   * What happened to the invoice in the console, newest first: made, edited,
   * its state changed, its payments recorded, changed or removed, and by whom.
   * Jobber keeps no history the console can read, so it starts here.
   */
  async history(user: AuthenticatedUser, id: string): Promise<InvoiceHistory> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id, organizationId: user.organizationId, ...SHOWN_INVOICE },
      select: { id: true },
    });
    if (!invoice) throw new ApplicationError(404, 'INVOICE_NOT_FOUND', 'That invoice was not found.');
    const rows = await this.prisma.auditLog.findMany({
      where: { organizationId: user.organizationId, entityType: 'Invoice', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT + 1,
      select: { id: true, action: true, createdAt: true, metadata: true, actorUserId: true },
    });
    const listed = rows.slice(0, HISTORY_LIMIT);
    const actorIds = [...new Set(listed.map((row) => row.actorUserId).filter((actor): actor is string => Boolean(actor)))];
    const actors = actorIds.length
      ? await this.prisma.userProfile.findMany({ where: { id: { in: actorIds } }, select: { id: true, displayName: true } })
      : [];
    const byId = new Map(actors.map((actor) => [actor.id, actor]));
    return {
      items: listed.map((row) => historyEvent(row, row.actorUserId ? (byId.get(row.actorUserId) ?? null) : null)),
      truncated: rows.length > HISTORY_LIMIT,
    };
  }

  /** The invoice as it was read, or a refusal: not found in this office, or changed since. */
  private async invoiceAsRead(tx: Prisma.TransactionClient, user: AuthenticatedUser, id: string, expectedUpdatedAt: string) {
    // One read from Xero (2026-11-12) is changed there, never here.
    const row = await tx.invoice.findFirst({ where: { id, organizationId: user.organizationId, ...SHOWN_INVOICE }, select: editSelect });
    if (!row) throw new ApplicationError(404, 'INVOICE_NOT_FOUND', 'That invoice was not found.');
    if (row.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()) throw this.invoiceChanged();
    return row;
  }

  /**
   * The company's books an edited invoice goes to (2026-11-10): its lines' one
   * company, or where it was when no line says. Two companies' lines are
   * refused, and so is moving one already in a company's books in Xero to
   * another's. One read from Jobber stays with no company: Jobber's invoices
   * are not sent. So does one made before invoices had a company whose lines
   * already went to two: it can still be corrected, and is never sent.
   */
  private async companyAfterEdit(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    before: EditRow,
    lines: readonly { name: string }[],
  ): Promise<{ xeroTenantId: string | null; changes: InvoiceChange[] }> {
    if (before.origin !== InvoiceOrigin.CONSOLE) return { xeroTenantId: before.xeroTenantId, changes: [] };
    const products = await productCompanies(tx, user.organizationId);
    const nameOf = organisationName(await officeOrganisations(tx, user.organizationId));
    const said = invoiceCompany(lines, products, undefined, nameOf);
    if (said.problem) {
      const mixedAlready = before.xeroTenantId === null && invoiceCompany(before.lines, products, undefined, nameOf).problem !== null;
      if (mixedAlready) return { xeroTenantId: null, changes: [] };
      throw new ApplicationError(422, 'INVOICE_INVALID', said.problem);
    }
    const xeroTenantId = said.xeroTenantId ?? before.xeroTenantId;
    if (xeroTenantId === before.xeroTenantId) return { xeroTenantId, changes: [] };
    const words = (tenantId: string | null) => (tenantId ? nameOf(tenantId) : 'none');
    if (before.xeroSync?.xeroInvoiceId)
      throw new ApplicationError(
        409,
        'INVOICE_IN_XERO',
        `This invoice is in ${words(before.xeroTenantId)}’s books in Xero already, so its lines cannot go to ${words(xeroTenantId)}: make an invoice of their own for them.`,
      );
    return { xeroTenantId, changes: [{ field: 'Company', from: words(before.xeroTenantId), to: words(xeroTenantId) }] };
  }

  private async paidCents(tx: Prisma.TransactionClient, invoiceId: string) {
    const paid = await tx.invoicePayment.aggregate({ where: { invoiceId }, _sum: { amountCents: true } });
    return paid._sum.amountCents ?? 0;
  }

  private async latestPaymentDay(tx: Prisma.TransactionClient, invoiceId: string) {
    const latest = await tx.invoicePayment.aggregate({ where: { invoiceId }, _max: { paidOn: true } });
    return latest._max.paidOn ?? null;
  }

  private audit(tx: Prisma.TransactionClient, user: AuthenticatedUser, invoiceId: string, action: string, metadata: Prisma.InputJsonObject) {
    return tx.auditLog.create({
      data: { organizationId: user.organizationId, actorUserId: user.id, action, entityType: 'Invoice', entityId: invoiceId, metadata },
    });
  }

  /** Refused while Jobber holds the invoices: until the console takes invoicing over (phase 8), or the server says so. */
  private async requireWrites(user: AuthenticatedUser) {
    if (!(await invoiceWritesOn(this.prisma, user.organizationId))) throw invoiceWritesOff();
  }

  private invoiceChanged() {
    return new ApplicationError(409, 'INVOICE_CHANGED', 'This invoice changed since it was opened. Look at it again, then make the change.');
  }
}

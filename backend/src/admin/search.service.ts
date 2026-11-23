import { Inject, Injectable } from '@nestjs/common';
import { UserRole, type Prisma } from '@prisma/client';
import { SEARCH_HITS_PER_KIND, SEARCH_KINDS, formatMoney, type SearchHit, type SearchKind, type SearchResults } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../common/auth';
import { PrismaService } from '../common/prisma.service';
import { searchTerms } from '../common/search-terms';
import { CONSOLE_ROLES } from './access.service';
import { inspectionSearchWhere } from './inspection-list-where';
import { PORTFOLIO_VISIBLE } from './inspection-creation';
import { visiblePurchaseOrders } from './purchase-orders.service';
import { visibleRequisitions } from './purchasing.service';
import { readCompanies, shownInvoices, shownPayments } from './shown-invoices';

/**
 * The console's search for everything (the office, 2026-11-24): a few records
 * of every kind, found by what was typed -- an invoice by its number, a
 * requisition, a purchase order, a vendor's bill, a stock item by its code.
 *
 * One request a search, where the header used to send one a kind. It reads the
 * console's own database and nothing else: no Jobber, Xero, Propertyware or
 * map call is on this path, and none may be added to it -- it runs on every
 * pause in somebody's typing.
 *
 * Each kind is read only for an account holding the permission its own list
 * asks for, and within what that list would show the caller: the companies'
 * books that are shown, the requisitions and orders that are theirs to see.
 */

/** What each kind's own list asks for. */
export const SEARCH_PERMISSIONS: Record<SearchKind, string> = {
  inspection: 'inspections:read',
  job: 'inspections:read',
  property: 'properties:read',
  tenant: 'properties:read',
  invoice: 'invoices:read',
  payment: 'invoices:read',
  requisition: 'purchasing:request',
  purchaseOrder: 'purchasing:request',
  stockItem: 'inventory:read',
  vendor: 'inventory:read',
  technician: 'technicians:read',
  user: 'users:read',
};

/**
 * Read before ranking, for a kind found by its number: "8439" is in "18439"
 * and "28439" too, and the one typed whole must not be left out of five.
 */
const RANKED = 20;

const contains = (word: string) => ({ contains: word, mode: 'insensitive' as const });
const may = (user: AuthenticatedUser, permission: string) => (user.permissions as readonly string[]).includes(permission);

/** Every word found somewhere: one AND a word, each an OR of the fields and of the word's spellings. */
function everyWord<Where>(terms: string[][], fields: (word: string) => Where[]): { OR: Where[] }[] {
  return terms.map((spellings) => ({ OR: spellings.flatMap(fields) }));
}

/** The number typed whole first, then the numbers starting with it; otherwise as read. */
function byNumber<Row>(rows: Row[], typed: string, numbers: (row: Row) => (string | null | undefined)[]): Row[] {
  const rank = (row: Row) => {
    const held = numbers(row).flatMap((number) => (number ? [number.toLowerCase()] : []));
    return held.includes(typed) ? 0 : held.some((number) => number.startsWith(typed)) ? 1 : 2;
  };
  return rows
    .map((row, index) => ({ row, index, rank: rank(row) }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, SEARCH_HITS_PER_KIND)
    .map((entry) => entry.row);
}

const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
/** A day held as its UTC midnight, as the office reads it: "Nov 24, 2026". */
const dayWords = (value: Date | null) => (value ? DAY.format(value) : null);
/** "MOVE_OUT" as "Move out". */
const words = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/^./, (letter) => letter.toUpperCase());
const joined = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
const hit = (id: string, title: string, detail: string, targetId: string | null = id): SearchHit => ({ id, targetId, title, detail });

@Injectable()
export class SearchService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async search(user: AuthenticatedUser, raw: string): Promise<SearchResults> {
    const terms = searchTerms(raw);
    if (!terms.length) return { groups: [] };
    // As a number is typed: "#8439" is 8439.
    const typed = raw.trim().replace(/^#/, '').toLowerCase();
    // Which companies' books are shown: read once, for the invoices and the payments both.
    let read: Promise<string[]> | undefined;
    const companies = () => (read ??= readCompanies(this.prisma, user.organizationId));
    const finders: Record<SearchKind, () => Promise<SearchHit[]>> = {
      inspection: () => this.inspections(user, raw),
      job: () => this.jobs(user, terms, typed),
      property: () => this.properties(user, terms),
      tenant: () => this.tenants(user, terms),
      invoice: async () => this.invoices(user, terms, typed, await companies()),
      payment: async () => this.payments(user, terms, typed, await companies()),
      requisition: () => this.requisitions(user, terms, typed),
      purchaseOrder: () => this.purchaseOrders(user, terms, typed),
      stockItem: () => this.stockItems(user, terms, typed),
      vendor: () => this.vendors(user, terms, typed),
      technician: () => this.technicians(user, terms),
      user: () => this.users(user, terms),
    };
    const allowed = SEARCH_KINDS.filter((kind) => may(user, SEARCH_PERMISSIONS[kind]));
    const groups = await Promise.all(allowed.map(async (kind) => ({ kind, hits: await finders[kind]() })));
    return { groups: groups.filter((group) => group.hits.length) };
  }

  /** As the inspections list finds them (`inspectionSearchWhere`), the latest first. */
  private async inspections(user: AuthenticatedUser, raw: string): Promise<SearchHit[]> {
    const rows = await this.prisma.inspection.findMany({
      where: { organizationId: user.organizationId, AND: inspectionSearchWhere(raw) },
      select: {
        id: true,
        inspectionType: true,
        scheduledAt: true,
        propertywareBuilding: { select: { name: true } },
        propertywareUnit: { select: { name: true } },
        property: { select: { name: true } },
        assignments: { where: { isCurrent: true }, select: { technician: { select: { displayName: true } } }, take: 1 },
      },
      orderBy: [{ scheduledAt: 'desc' }, { id: 'desc' }],
      take: SEARCH_HITS_PER_KIND,
    });
    return rows.map((row) =>
      hit(
        row.id,
        joined(row.propertywareBuilding?.name ?? row.property?.name ?? 'Property snapshot', row.propertywareUnit?.name),
        joined(words(row.inspectionType), dayWords(row.scheduledAt), row.assignments[0]?.technician.displayName ?? 'Unassigned'),
      ),
    );
  }

  /** The console's own jobs, by number ("J-00042"), title or property. */
  private async jobs(user: AuthenticatedUser, terms: string[][], typed: string): Promise<SearchHit[]> {
    const rows = await this.prisma.job.findMany({
      where: {
        organizationId: user.organizationId,
        AND: everyWord<Prisma.JobWhereInput>(terms, (word) => [
          { number: contains(word) },
          { title: contains(word) },
          { propertywareBuilding: { name: contains(word) } },
          { propertywareBuilding: { addressLine1: contains(word) } },
        ]),
      },
      select: { id: true, number: true, title: true, propertywareBuilding: { select: { name: true } }, propertywareUnit: { select: { name: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RANKED,
    });
    return byNumber(rows, typed, (row) => [row.number]).map((row) =>
      hit(row.id, joined(row.number, row.title), joined(row.propertywareBuilding.name, row.propertywareUnit?.name)),
    );
  }

  /** The properties under management, as the Properties list shows them. */
  private async properties(user: AuthenticatedUser, terms: string[][]): Promise<SearchHit[]> {
    const rows = await this.prisma.propertywareBuilding.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        AND: [
          ...PORTFOLIO_VISIBLE.AND,
          ...everyWord<Prisma.PropertywareBuildingWhereInput>(terms, (word) => [
            { name: contains(word) },
            { addressLine1: contains(word) },
            { addressLine2: contains(word) },
            { city: contains(word) },
            { postalCode: contains(word) },
          ]),
        ],
      },
      select: { id: true, name: true, addressLine1: true, city: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: SEARCH_HITS_PER_KIND,
    });
    return rows.map((row) => hit(row.id, row.name, joined(row.addressLine1, row.city)));
  }

  /** Who lives where now. A tenant has no page of their own: the hit opens their property. */
  private async tenants(user: AuthenticatedUser, terms: string[][]): Promise<SearchHit[]> {
    const rows = await this.prisma.propertywareTenant.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        AND: everyWord<Prisma.PropertywareTenantWhereInput>(terms, (word) => [
          { leaseName: contains(word) },
          { addressLine1: contains(word) },
          { city: contains(word) },
          { postalCode: contains(word) },
        ]),
      },
      select: { id: true, leaseName: true, addressLine1: true, city: true, building: { select: { id: true } } },
      orderBy: [{ leaseName: 'asc' }, { id: 'asc' }],
      take: SEARCH_HITS_PER_KIND,
    });
    return rows.map((row) => hit(row.id, row.leaseName, joined(row.addressLine1, row.city), row.building?.id ?? null));
  }

  /**
   * By its number, wherever in it the digits fall and in any capitals
   * ("8439", "#8439", "inv-0042"), its job number, who it is made out to, its
   * subject or its property's street. Only the books the Invoices page shows.
   */
  private async invoices(user: AuthenticatedUser, terms: string[][], typed: string, read: readonly string[]): Promise<SearchHit[]> {
    const rows = await this.prisma.invoice.findMany({
      where: {
        organizationId: user.organizationId,
        AND: [
          shownInvoices(read),
          ...everyWord<Prisma.InvoiceWhereInput>(terms, (word) => [
            { number: contains(word) },
            { jobNumber: contains(word) },
            { clientName: contains(word) },
            { subject: contains(word) },
            { propertywareBuilding: { addressLine1: contains(word) } },
          ]),
        ],
      },
      select: { id: true, number: true, jobNumber: true, clientName: true, totalCents: true, issuedOn: true },
      orderBy: [{ issuedOn: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }, { id: 'desc' }],
      take: RANKED,
    });
    return byNumber(rows, typed, (row) => [row.number, row.jobNumber]).map((row) =>
      hit(
        row.id,
        joined(row.number ? `Invoice #${row.number}` : 'Invoice not numbered yet', row.clientName),
        joined(formatMoney(row.totalCents), dayWords(row.issuedOn) ?? 'Not issued', row.jobNumber ? `Job #${row.jobNumber}` : null),
      ),
    );
  }

  /** By its reference -- a check number, a receipt -- or by its invoice's number or client. */
  private async payments(user: AuthenticatedUser, terms: string[][], typed: string, read: readonly string[]): Promise<SearchHit[]> {
    const rows = await this.prisma.invoicePayment.findMany({
      where: {
        organizationId: user.organizationId,
        AND: [
          shownPayments(read),
          ...everyWord<Prisma.InvoicePaymentWhereInput>(terms, (word) => [
            { reference: contains(word) },
            { invoice: { is: { number: contains(word) } } },
            { invoice: { is: { clientName: contains(word) } } },
          ]),
        ],
      },
      select: { id: true, reference: true, amountCents: true, paidOn: true, method: true, invoice: { select: { number: true, clientName: true } } },
      orderBy: [{ paidOn: 'desc' }, { id: 'desc' }],
      take: RANKED,
    });
    return byNumber(rows, typed, (row) => [row.reference, row.invoice.number]).map((row) =>
      hit(
        row.id,
        joined(`Payment ${formatMoney(row.amountCents)}`, row.invoice.clientName),
        joined(dayWords(row.paidOn), words(row.method), row.reference, row.invoice.number ? `Invoice #${row.invoice.number}` : null),
      ),
    );
  }

  /** By its number ("PR-00043"), what it is for, or who asked. Only those the Purchasing page would show the caller. */
  private async requisitions(user: AuthenticatedUser, terms: string[][], typed: string): Promise<SearchHit[]> {
    const rows = await this.prisma.purchaseRequisition.findMany({
      where: {
        organizationId: user.organizationId,
        AND: [
          visibleRequisitions(user),
          ...everyWord<Prisma.PurchaseRequisitionWhereInput>(terms, (word) => [
            { number: contains(word) },
            { reason: contains(word) },
            { requestedBy: { displayName: contains(word) } },
          ]),
        ],
      },
      select: { id: true, number: true, status: true, reason: true, requestedBy: { select: { displayName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RANKED,
    });
    return byNumber(rows, typed, (row) => [row.number]).map((row) =>
      hit(row.id, joined(row.number ?? 'Draft requisition', row.reason), joined(words(row.status), row.requestedBy.displayName)),
    );
  }

  /**
   * By its number ("PO-0009"), its vendor, the requisition it was made from,
   * or the number on the vendor's bill -- a bill is kept on its order's page.
   * Only those the Purchasing page would show the caller.
   */
  private async purchaseOrders(user: AuthenticatedUser, terms: string[][], typed: string): Promise<SearchHit[]> {
    const rows = await this.prisma.purchaseOrder.findMany({
      where: {
        organizationId: user.organizationId,
        AND: [
          visiblePurchaseOrders(user),
          ...everyWord<Prisma.PurchaseOrderWhereInput>(terms, (word) => [
            { number: contains(word) },
            { vendor: { is: { name: contains(word) } } },
            { bill: { is: { billNumber: contains(word) } } },
            { requisition: { number: contains(word) } },
          ]),
        ],
      },
      select: {
        id: true,
        number: true,
        status: true,
        vendor: { select: { name: true } },
        bill: { select: { billNumber: true } },
        requisition: { select: { number: true } },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: RANKED,
    });
    return byNumber(rows, typed, (row) => [row.number, row.bill?.billNumber, row.requisition.number]).map((row) =>
      hit(
        row.id,
        joined(row.number ?? 'Draft purchase order', row.vendor?.name),
        joined(words(row.status), row.bill ? `Bill ${row.bill.billNumber}` : null, row.requisition.number ? `From ${row.requisition.number}` : null),
      ),
    );
  }

  /** By its code ("FLT-0012") or name; what is in use first. */
  private async stockItems(user: AuthenticatedUser, terms: string[][], typed: string): Promise<SearchHit[]> {
    const rows = await this.prisma.stockItem.findMany({
      where: {
        organizationId: user.organizationId,
        AND: everyWord<Prisma.StockItemWhereInput>(terms, (word) => [{ code: contains(word) }, { name: contains(word) }]),
      },
      select: { id: true, code: true, name: true, unit: true, active: true },
      orderBy: [{ active: 'desc' }, { codeKey: 'asc' }],
      take: RANKED,
    });
    return byNumber(rows, typed, (row) => [row.code]).map((row) =>
      hit(row.id, joined(row.code, row.name), joined(`Counted by the ${row.unit}`, row.active ? null : 'No longer in use')),
    );
  }

  /** By its number ("V-00003"), name or contact. A vendor has no page of its own: the hit opens the vendors list. */
  private async vendors(user: AuthenticatedUser, terms: string[][], typed: string): Promise<SearchHit[]> {
    const rows = await this.prisma.vendor.findMany({
      where: {
        organizationId: user.organizationId,
        AND: everyWord<Prisma.VendorWhereInput>(terms, (word) => [
          { number: contains(word) },
          { name: contains(word) },
          { contactName: contains(word) },
        ]),
      },
      select: { id: true, number: true, name: true, contactName: true, active: true },
      orderBy: [{ active: 'desc' }, { nameKey: 'asc' }],
      take: RANKED,
    });
    return byNumber(rows, typed, (row) => [row.number]).map((row) =>
      hit(row.id, row.name, joined(row.number, row.contactName, row.active ? null : 'No longer used'), null),
    );
  }

  private async technicians(user: AuthenticatedUser, terms: string[][]): Promise<SearchHit[]> {
    const rows = await this.prisma.userProfile.findMany({
      where: {
        memberships: { some: { organizationId: user.organizationId, role: UserRole.INSPECTION_TECHNICIAN } },
        AND: everyWord<Prisma.UserProfileWhereInput>(terms, (word) => [{ displayName: contains(word) }, { email: contains(word) }]),
      },
      select: { id: true, displayName: true, email: true },
      orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
      take: SEARCH_HITS_PER_KIND,
    });
    return rows.map((row) => hit(row.id, row.displayName, row.email));
  }

  /** The console's own users, as the Users list has them: never somebody who is only a technician. */
  private async users(user: AuthenticatedUser, terms: string[][]): Promise<SearchHit[]> {
    const organizationId = user.organizationId;
    const rows = await this.prisma.userProfile.findMany({
      where: {
        OR: [{ memberships: { some: { organizationId, role: { in: CONSOLE_ROLES } } } }, { roleAssignments: { some: { organizationId } } }],
        AND: everyWord<Prisma.UserProfileWhereInput>(terms, (word) => [{ displayName: contains(word) }, { email: contains(word) }]),
      },
      select: { id: true, displayName: true, email: true },
      orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }],
      take: SEARCH_HITS_PER_KIND,
    });
    return rows.map((row) => hit(row.id, row.displayName, row.email));
  }
}

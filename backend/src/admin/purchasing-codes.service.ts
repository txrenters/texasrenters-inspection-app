import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PurchasingCodeKind } from '@prisma/client';
import {
  CODE_LIST_OF_KIND,
  MOST_PURCHASING_CODE_NAME,
  TRACKED_CODE_KINDS,
  listsKept,
  normalizePurchasingCode,
  purchasingCodeProblem,
  type PurchasingCodeRow,
  type PurchasingCodes,
  type PurchasingCompanyRow,
  type SavePurchaserCodeInput,
  type SavePurchasingCodeInput,
  type XeroOptionMatch,
  type XeroTrackingCategory,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { assertKeeps, readPurchasingSetup } from './purchasing-settings';

/**
 * The codes a NAV-style purchase requisition picks from (2026-11-20, part 1).
 *
 * Line types, request codes, department codes and cost center codes are short
 * lists the office makes, with `purchasing:codes`. A code is unique in its
 * list and kept in capitals (the database holds both). A code is switched
 * off, never removed: a requisition that named it must still read.
 *
 * Department and cost center codes can each be matched to a tracking option
 * in each company's Xero. The options come from the catalog the console
 * already keeps for invoicing (XeroOrganisation.trackingCategories): nothing
 * here calls Xero. A match is checked against that catalog when it is saved.
 *
 * Every change is audited. Three reads to list; nothing is polled.
 */

const ENTITY = 'PurchasingCode';
type Db = Prisma.TransactionClient | PrismaService;
const text = (value: string | null | undefined) => value?.trim().replace(/\s+/g, ' ') || null;
const takenOn = (error: unknown, column: string) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && JSON.stringify(error.meta?.target ?? '').includes(column);

/** The two line types every office starts with: Item keeps stock, Service does not. */
export const DEFAULT_LINE_TYPES = [
  { code: 'ITEM', name: 'Item', keepsStock: true },
  { code: 'SERVICE', name: 'Service', keepsStock: false },
] as const;

/**
 * The office's line types, made the first time they are needed. The
 * migration made them for every office there was; an office made since gets
 * them here. Sent twice at once, the unique index lets one in.
 */
export async function ensureLineTypes(db: Db, organizationId: string): Promise<void> {
  const any = await db.purchasingCode.findFirst({ where: { organizationId, kind: PurchasingCodeKind.LINE_TYPE }, select: { id: true } });
  if (any) return;
  await db.purchasingCode.createMany({ data: DEFAULT_LINE_TYPES.map((type) => ({ organizationId, kind: PurchasingCodeKind.LINE_TYPE, ...type })), skipDuplicates: true });
}

/** The line type a new item gets when none is chosen: Item, or the first in use that keeps stock. */
export async function defaultLineTypeId(db: Db, organizationId: string): Promise<string> {
  await ensureLineTypes(db, organizationId);
  const types = await db.purchasingCode.findMany({ where: { organizationId, kind: PurchasingCodeKind.LINE_TYPE, active: true }, select: { id: true, code: true, keepsStock: true }, orderBy: { code: 'asc' } });
  const chosen = types.find((type) => type.code === 'ITEM') ?? types.find((type) => type.keepsStock) ?? types[0];
  if (!chosen) throw new ApplicationError(409, 'LINE_TYPE_NONE', 'No line type is in use. Switch one on under Purchasing > Codes.');
  return chosen.id;
}

/** A line type of this office that is in use, or the reason it will not do. */
export async function lineTypeOf(db: Db, organizationId: string, lineTypeId: string): Promise<{ id: string; code: string; keepsStock: boolean }> {
  const type = await db.purchasingCode.findFirst({ where: { id: lineTypeId, organizationId, kind: PurchasingCodeKind.LINE_TYPE }, select: { id: true, code: true, keepsStock: true, active: true } });
  if (!type) throw new ApplicationError(400, 'LINE_TYPE_NOT_FOUND', 'That line type is not on the list.');
  if (!type.active) throw new ApplicationError(409, 'LINE_TYPE_SWITCHED_OFF', `${type.code} is switched off. Choose another line type.`);
  return type;
}

/** The categories a company's catalog holds, in use, as plain rows. */
function trackingOf(catalog: unknown): PurchasingCompanyRow['trackingCategories'] {
  const categories = Array.isArray(catalog) ? (catalog as XeroTrackingCategory[]) : [];
  return categories
    .filter((category) => category && category.status !== 'ARCHIVED' && Array.isArray(category.options))
    .map((category) => ({
      id: category.trackingCategoryId,
      name: category.name,
      options: category.options.filter((option) => option.status !== 'ARCHIVED').map((option) => ({ id: option.optionId, name: option.name })),
    }));
}

@Injectable()
export class PurchasingCodesService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** Every code and every company: three reads. */
  async list(user: AuthenticatedUser): Promise<PurchasingCodes> {
    const organizationId = user.organizationId;
    await ensureLineTypes(this.prisma, organizationId);
    const [codes, companies, typed, units, setup] = await Promise.all([
      this.prisma.purchasingCode.findMany({
        where: { organizationId },
        select: { id: true, kind: true, code: true, name: true, keepsStock: true, active: true, xeroOptions: { select: { xeroTenantId: true, trackingCategoryId: true, trackingOptionId: true } } },
        orderBy: [{ kind: 'asc' }, { active: 'desc' }, { code: 'asc' }],
      }),
      this.prisma.xeroOrganisation.findMany({
        where: { organizationId, removedAt: null },
        select: { xeroTenantId: true, name: true, purchaserCode: true, trackingCategories: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.stockItem.groupBy({ by: ['lineTypeId'], where: { organizationId, lineTypeId: { not: null } }, _count: { _all: true } }),
      // Units are named by items (Purchasing Setup, 2026-11-21): counted by name, whatever its case.
      this.prisma.stockItem.groupBy({ by: ['unit'], where: { organizationId }, _count: { _all: true } }),
      readPurchasingSetup(this.prisma, organizationId),
    ]);
    const used = new Map(typed.map((row) => [row.lineTypeId, row._count._all]));
    const unitUse = new Map<string, number>();
    for (const row of units) unitUse.set(row.unit.toLowerCase(), (unitUse.get(row.unit.toLowerCase()) ?? 0) + row._count._all);
    const kept = listsKept(user.permissions, setup.keepers);
    const rows: PurchasingCompanyRow[] = companies.map((company) => ({ xeroTenantId: company.xeroTenantId, name: company.name, purchaserCode: company.purchaserCode, trackingCategories: trackingOf(company.trackingCategories) }));
    const label = (match: XeroOptionMatch) => {
      const company = rows.find((row) => row.xeroTenantId === match.xeroTenantId);
      const category = company?.trackingCategories.find((each) => each.id === match.trackingCategoryId);
      const option = category?.options.find((each) => each.id === match.trackingOptionId);
      return category && option ? `${category.name}: ${option.name}` : 'An option Xero no longer has';
    };
    return {
      codes: codes.map((code): PurchasingCodeRow => ({
        id: code.id,
        kind: code.kind,
        code: code.code,
        name: code.name,
        keepsStock: code.keepsStock,
        active: code.active,
        xero: code.xeroOptions.map((match) => ({ xeroTenantId: match.xeroTenantId, trackingCategoryId: match.trackingCategoryId, trackingOptionId: match.trackingOptionId, label: label(match) })),
        used: code.kind === PurchasingCodeKind.UNIT ? (unitUse.get(code.name.toLowerCase()) ?? 0) : (used.get(code.id) ?? 0),
      })),
      companies: rows,
      keeps: {
        LINE_TYPE: kept.LINE_TYPES,
        UNIT: kept.UNITS,
        REQUEST: kept.REQUEST,
        DEPARTMENT: kept.DEPARTMENT,
        COST_CENTER: kept.COST_CENTER,
        PURCHASER_CODES: kept.PURCHASER_CODES,
      },
    };
  }

  async create(user: AuthenticatedUser, input: SavePurchasingCodeInput): Promise<PurchasingCodes> {
    const organizationId = user.organizationId;
    const kind = input.kind;
    if (!kind) throw new ApplicationError(400, 'PURCHASING_CODE_INCOMPLETE', 'Say which list it goes on.');
    await assertKeeps(this.prisma, user, CODE_LIST_OF_KIND[kind]);
    const code = this.code(input.code);
    const name = this.name(input.name);
    const xero = input.xero ? await this.matches(organizationId, kind, input.xero) : [];
    try {
      await this.prisma.$transaction(async (tx) => {
        const made = await tx.purchasingCode.create({
          data: { organizationId, kind, code, name, keepsStock: kind === PurchasingCodeKind.LINE_TYPE ? (input.keepsStock ?? true) : true },
          select: { id: true },
        });
        if (xero.length) await tx.purchasingCodeXeroOption.createMany({ data: xero.map((match) => ({ organizationId, codeId: made.id, ...match })) });
        await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'PURCHASING_CODE_CREATED', entityType: ENTITY, entityId: made.id, metadata: { kind, code, name, xero: xero.length } } });
      });
    } catch (error) {
      if (takenOn(error, 'code')) throw new ApplicationError(409, 'PURCHASING_CODE_TAKEN', `${code} is already on that list.`);
      throw error;
    }
    return this.list(user);
  }

  async update(user: AuthenticatedUser, codeId: string, input: SavePurchasingCodeInput): Promise<PurchasingCodes> {
    const organizationId = user.organizationId;
    const existing = await this.prisma.purchasingCode.findFirst({ where: { id: codeId, organizationId }, select: { kind: true, code: true, name: true, keepsStock: true, active: true } });
    if (!existing) throw new ApplicationError(404, 'PURCHASING_CODE_NOT_FOUND', 'That code is not on the list.');
    await assertKeeps(this.prisma, user, CODE_LIST_OF_KIND[existing.kind]);
    if (input.kind !== undefined && input.kind !== existing.kind) throw new ApplicationError(409, 'PURCHASING_CODE_KIND_FIXED', `${existing.code} stays on its list. Make it again on the other one.`);
    const data: Prisma.PurchasingCodeUncheckedUpdateInput = {};
    const changes: string[] = [];
    if (input.code !== undefined) {
      const code = this.code(input.code);
      if (code !== existing.code) {
        data.code = code;
        changes.push(`code ${existing.code} -> ${code}`);
      }
    }
    if (input.name !== undefined) {
      data.name = this.name(input.name);
      changes.push('name');
    }
    if (input.keepsStock !== undefined && existing.kind === PurchasingCodeKind.LINE_TYPE && input.keepsStock !== existing.keepsStock) {
      // An item of this type already in stock would be left on a shelf the console no longer counts.
      if (!input.keepsStock) {
        const stocked = await this.prisma.stockLevel.findFirst({ where: { organizationId, quantity: { not: 0 }, item: { lineTypeId: codeId } }, select: { item: { select: { code: true } } } });
        if (stocked) throw new ApplicationError(409, 'LINE_TYPE_HAS_STOCK', `${stocked.item.code} is ${existing.code} and has stock. A type with stock on hand keeps stock.`);
      }
      data.keepsStock = input.keepsStock;
      changes.push(input.keepsStock ? 'keeps stock' : 'keeps no stock');
    }
    if (input.active !== undefined && input.active !== existing.active) {
      if (!input.active && existing.kind === PurchasingCodeKind.LINE_TYPE) {
        const others = await this.prisma.purchasingCode.count({ where: { organizationId, kind: PurchasingCodeKind.LINE_TYPE, active: true, id: { not: codeId } } });
        if (!others) throw new ApplicationError(409, 'LINE_TYPE_LAST', 'At least one line type stays in use.');
      }
      data.active = input.active;
      changes.push(input.active ? 'switched on' : 'switched off');
    }
    const xero = input.xero !== undefined ? await this.matches(organizationId, existing.kind, input.xero) : null;
    if (xero) changes.push(`Xero tracking (${xero.length})`);
    if (!changes.length) return this.list(user);
    // A unit is named by its items (Purchasing Setup, 2026-11-21): renamed, they follow it. Its old name, taken before it changes.
    const renamedUnit = existing.kind === PurchasingCodeKind.UNIT && typeof data.name === 'string' && data.name !== existing.name ? { from: existing.name, to: data.name } : null;
    try {
      await this.prisma.$transaction(async (tx) => {
        if (Object.keys(data).length) await tx.purchasingCode.update({ where: { id: codeId }, data });
        if (renamedUnit) await tx.stockItem.updateMany({ where: { organizationId, unit: { equals: renamedUnit.from, mode: 'insensitive' } }, data: { unit: renamedUnit.to } });
        if (xero) {
          await tx.purchasingCodeXeroOption.deleteMany({ where: { organizationId, codeId } });
          if (xero.length) await tx.purchasingCodeXeroOption.createMany({ data: xero.map((match) => ({ organizationId, codeId, ...match })) });
        }
        await tx.auditLog.create({ data: { organizationId, ...auditActor(user), action: 'PURCHASING_CODE_CHANGED', entityType: ENTITY, entityId: codeId, metadata: { kind: existing.kind, code: existing.code, changes } } });
      });
    } catch (error) {
      if (takenOn(error, 'code')) throw new ApplicationError(409, 'PURCHASING_CODE_TAKEN', `${String(data.code)} is already on that list.`);
      throw error;
    }
    return this.list(user);
  }

  /** A company's purchaser code: set, changed or taken away. */
  async setPurchaserCode(user: AuthenticatedUser, xeroTenantId: string, input: SavePurchaserCodeInput): Promise<PurchasingCodes> {
    const organizationId = user.organizationId;
    const company = await this.prisma.xeroOrganisation.findFirst({ where: { organizationId, xeroTenantId, removedAt: null }, select: { id: true, name: true, purchaserCode: true } });
    if (!company) throw new ApplicationError(404, 'COMPANY_NOT_FOUND', 'That company is not connected to this office.');
    await assertKeeps(this.prisma, user, 'PURCHASER_CODES');
    const code = input.purchaserCode === null || !input.purchaserCode.trim() ? null : this.code(input.purchaserCode);
    const before = company.purchaserCode;
    if (code === before) return this.list(user);
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.xeroOrganisation.update({ where: { id: company.id }, data: { purchaserCode: code } });
        await tx.auditLog.create({
          data: { organizationId, ...auditActor(user), action: 'PURCHASER_CODE_CHANGED', entityType: 'XeroOrganisation', entityId: company.id, metadata: { company: company.name, from: before, to: code } },
        });
      });
    } catch (error) {
      if (takenOn(error, 'purchaserCode')) throw new ApplicationError(409, 'PURCHASER_CODE_TAKEN', `${code} is already another company's purchaser code.`);
      throw error;
    }
    return this.list(user);
  }

  private code(typed: string | undefined): string {
    const problem = purchasingCodeProblem(typed ?? '');
    if (problem) throw new ApplicationError(400, 'PURCHASING_CODE_INVALID', problem);
    return normalizePurchasingCode(typed ?? '');
  }

  private name(typed: string | undefined): string {
    const name = text(typed);
    if (!name) throw new ApplicationError(400, 'PURCHASING_CODE_INCOMPLETE', 'Give it a name.');
    if (name.length > MOST_PURCHASING_CODE_NAME) throw new ApplicationError(400, 'PURCHASING_CODE_INVALID', `A name is at most ${MOST_PURCHASING_CODE_NAME} characters.`);
    return name;
  }

  /** Each match is one of this office's companies and an option its Xero catalog holds; one a company. */
  private async matches(organizationId: string, kind: PurchasingCodeKind, sent: readonly XeroOptionMatch[]): Promise<XeroOptionMatch[]> {
    if (!sent.length) return [];
    if (!TRACKED_CODE_KINDS.includes(kind)) throw new ApplicationError(400, 'PURCHASING_CODE_NOT_TRACKED', 'Only department and cost center codes are matched to Xero tracking.');
    if (new Set(sent.map((match) => match.xeroTenantId)).size !== sent.length) throw new ApplicationError(400, 'PURCHASING_CODE_XERO_TWICE', 'A code has one tracking option a company.');
    const companies = await this.prisma.xeroOrganisation.findMany({ where: { organizationId, removedAt: null, xeroTenantId: { in: sent.map((match) => match.xeroTenantId) } }, select: { xeroTenantId: true, name: true, trackingCategories: true } });
    return sent.map((match) => {
      const company = companies.find((each) => each.xeroTenantId === match.xeroTenantId);
      if (!company) throw new ApplicationError(400, 'COMPANY_NOT_FOUND', 'That company is not connected to this office.');
      const category = trackingOf(company.trackingCategories).find((each) => each.id === match.trackingCategoryId);
      if (!category?.options.some((option) => option.id === match.trackingOptionId))
        throw new ApplicationError(400, 'XERO_TRACKING_NOT_FOUND', `${company.name}'s Xero has no such tracking option in use. Read its settings again from Xero if it was just added.`);
      return { xeroTenantId: match.xeroTenantId, trackingCategoryId: match.trackingCategoryId, trackingOptionId: match.trackingOptionId };
    });
  }
}

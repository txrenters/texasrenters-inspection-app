import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, StockMovementKind } from '@prisma/client';
import {
  MOST_IMPORT_ROWS,
  STOCK_CODE,
  importCents,
  importWhole,
  normalizeStockCode,
  stockKey,
  type StockImportCheck,
  type StockImportDone,
  type StockImportInput,
  type StockImportRow,
  type StockImportRowCheck,
} from '@texasrenters/shared';

import { auditActor, type AuthenticatedUser } from '../common/auth';
import { businessDate, dayWords } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { defaultLineTypeId } from './purchasing-codes.service';
import { assertKeeps } from './purchasing-settings';
import { assertStockNotFrozen } from './stock-freeze';

/**
 * The office's stock from a spreadsheet (2026-11-23): each row an item at a
 * place, with how many are there and what one cost. A new item code is made
 * from its row; every row sets an opening balance, the same as entering one
 * by hand -- one an item and place, dated today or before, never while a
 * yearly count is open.
 *
 * Check reads and changes nothing. Import checks again inside one
 * transaction and writes everything or nothing: the items, one OPENING_BALANCE
 * movement a row (the database adds each to StockLevel), and one audit entry.
 * A second press with the same request key writes nothing more. Nothing here
 * calls anything billed.
 */

type Db = Prisma.TransactionClient | PrismaService;

/** Same as a hand-entered opening balance (OpeningBalanceDto). */
const MOST_QUANTITY = 1_000_000;
const MOST_UNIT_COST_CENTS = 100_000_000;
/** The audit keeps the first codes made, not a thousand of them. */
const CODES_AUDITED = 50;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const text = (value: string) => value.trim().replace(/\s+/g, ' ');
const dateOf = (day: string) => new Date(`${day}T00:00:00.000Z`);

/** A new item, as its first row with a description gives it. */
interface NewItem {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  unit: string;
  xeroTenantId: string | null;
  priceCents: number | null;
  reorderLevel: number;
  reorderQuantity: number;
  usualVendorId: string | null;
}

interface Plan {
  check: StockImportCheck;
  day: string;
  items: NewItem[];
  /** One opening balance a row. */
  balances: { line: number; itemId: string; placeId: string; quantity: number; unitCostCents: number }[];
}

@Injectable()
export class InventoryImportService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /** What the file would do, row by row, and what is wrong with it. Nothing is written. */
  async check(user: AuthenticatedUser, input: StockImportInput): Promise<StockImportCheck> {
    return (await this.plan(this.prisma, user, input)).check;
  }

  /** Everything the file holds, or nothing: refused while anything in it is wrong. */
  async import(user: AuthenticatedUser, input: StockImportInput): Promise<StockImportDone> {
    const organizationId = user.organizationId;
    const key = input.requestKey;
    if (!key) throw new ApplicationError(400, 'STOCK_IMPORT_KEY_NEEDED', 'An import needs its request key.');
    const done = () => this.done(organizationId, key);
    // Pressed twice: the first press wrote it.
    if (await this.written(this.prisma, organizationId, key)) return done();
    try {
      await this.prisma.$transaction(
        async (tx) => {
          // One import at a time in an office, so two never make the same code or the same opening balance.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`stock-import:${organizationId}`}, 0))::text AS locked`;
          if (await this.written(tx, organizationId, key)) return;
          await assertStockNotFrozen(tx, organizationId);
          const plan = await this.plan(tx, user, input);
          if (!plan.check.ready) {
            const first = [...plan.check.problems, ...plan.check.rows.flatMap((row) => row.problems.map((problem) => `Row ${row.line}: ${problem}`))];
            throw new ApplicationError(409, 'STOCK_IMPORT_NOT_READY', `The file has things to fix before it is imported. ${first.slice(0, 3).join(' ')}`);
          }
          // An existing item and place entered by hand at this moment: the same lock the single entry takes.
          const pairs = [...new Set(plan.balances.map((balance) => `stock-opening:${balance.itemId}:${balance.placeId}`))].sort();
          for (const pair of pairs) await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${pair}, 0))::text AS locked`;
          const lineTypeId = plan.items.length ? await defaultLineTypeId(tx, organizationId) : null;
          if (plan.items.length)
            await tx.stockItem.createMany({
              data: plan.items.map((item) => ({
                id: item.id,
                organizationId,
                code: item.code,
                codeKey: stockKey(item.code),
                name: item.name,
                unit: item.unit,
                categoryId: item.categoryId,
                xeroTenantId: item.xeroTenantId,
                reorderLevel: item.reorderLevel,
                reorderQuantity: item.reorderQuantity,
                usualVendorId: item.usualVendorId,
                priceCents: item.priceCents,
                lineTypeId: lineTypeId!,
              })),
            });
          const fileName = input.fileName?.trim().slice(0, 200) || null;
          await tx.stockMovement.createMany({
            data: plan.balances.map((balance) => ({
              organizationId,
              itemId: balance.itemId,
              placeId: balance.placeId,
              kind: StockMovementKind.OPENING_BALANCE,
              quantity: balance.quantity,
              unitCostCents: balance.unitCostCents,
              day: dateOf(plan.day),
              note: fileName ? `Imported from ${fileName}, row ${balance.line}` : `Imported, row ${balance.line}`,
              requestKey: `${key}:${balance.line}`,
              createdById: user.principalType === 'API_KEY' ? null : user.id,
              createdByName: user.displayName,
            })),
          });
          await tx.auditLog.create({
            data: {
              organizationId,
              ...auditActor(user),
              action: 'STOCK_IMPORTED',
              // The import is known by its request key: the page made it, the movements carry it.
              entityType: 'StockImport',
              entityId: key,
              metadata: {
                file: fileName,
                day: plan.day,
                rows: plan.balances.length,
                newItems: plan.items.length,
                codesMade: plan.items.slice(0, CODES_AUDITED).map((item) => item.code),
                totalValueCents: plan.check.totalValueCents,
              },
            },
          });
        },
        // A thousand rows is a long transaction on the remote pooler.
        { maxWait: 10_000, timeout: 120_000 },
      );
    } catch (error) {
      // A code taken, or an opening balance entered, by somebody else in the same moment.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        if (await this.written(this.prisma, organizationId, key)) return done();
        throw new ApplicationError(409, 'STOCK_IMPORT_TAKEN', 'Something in the file was just entered by somebody else. Check the file again.');
      }
      throw error;
    }
    return done();
  }

  private written(db: Db, organizationId: string, key: string) {
    return db.stockMovement.findFirst({ where: { organizationId, requestKey: { startsWith: `${key}:` } }, select: { id: true } });
  }

  /** What an import wrote, read back by its key. */
  private async done(organizationId: string, key: string): Promise<StockImportDone> {
    const audit = await this.prisma.auditLog.findFirst({
      where: { organizationId, action: 'STOCK_IMPORTED', entityId: key },
      select: { metadata: true },
    });
    const metadata = (audit?.metadata ?? {}) as { rows?: number; newItems?: number; totalValueCents?: number };
    return { rows: metadata.rows ?? 0, newItems: metadata.newItems ?? 0, totalValueCents: metadata.totalValueCents ?? 0 };
  }

  /** Each row read against the office's own lists. Reads only. */
  private async plan(db: Db, user: AuthenticatedUser, input: StockImportInput): Promise<Plan> {
    const organizationId = user.organizationId;
    const today = businessDate();
    const day = input.day ?? today;
    const problems: string[] = [];
    if (day > today) problems.push(`The stock cannot be as of a day after today. It is ${dayWords(today)} in Texas.`);
    const rows: readonly StockImportRow[] = input.rows;
    if (!rows.length) problems.push('The file has no rows.');
    if (rows.length > MOST_IMPORT_ROWS) problems.push(`One import takes ${MOST_IMPORT_ROWS} rows. Split the file in two.`);

    const codes = [...new Set(rows.map((row) => normalizeStockCode(row.code)).filter((code) => STOCK_CODE.test(code)))];
    const [items, places, categories, units, companies, vendors, frozen] = await Promise.all([
      codes.length
        ? db.stockItem.findMany({ where: { organizationId, codeKey: { in: codes.map(stockKey) } }, select: { id: true, code: true, codeKey: true, name: true, active: true } })
        : Promise.resolve([]),
      db.stockPlace.findMany({ where: { organizationId }, select: { id: true, code: true, name: true, active: true } }),
      db.stockCategory.findMany({ where: { organizationId, active: true }, select: { id: true, name: true, prefix: true } }),
      db.purchasingCode.findMany({ where: { organizationId, kind: 'UNIT', active: true }, select: { name: true } }),
      db.xeroOrganisation.findMany({ where: { organizationId, status: 'CONNECTED' }, select: { xeroTenantId: true, name: true, purchaserCode: true } }),
      db.vendor.findMany({ where: { organizationId, active: true }, select: { id: true, number: true, name: true } }),
      // A yearly count open: the same sentence as everywhere stock moves.
      assertStockNotFrozen(db, organizationId).then(
        () => null,
        (error: unknown) => {
          if (error instanceof ApplicationError) return error.message;
          throw error;
        },
      ),
    ]);
    if (frozen) problems.push(frozen);
    const itemOf = new Map(items.map((item) => [item.codeKey, item]));
    const standing = items.length
      ? await db.stockMovement.findMany({
          where: { organizationId, itemId: { in: items.map((item) => item.id) }, kind: StockMovementKind.OPENING_BALANCE, reversedBy: null },
          select: { itemId: true, placeId: true },
        })
      : [];
    const hasBalance = new Set(standing.map((one) => `${one.itemId}:${one.placeId}`));

    const placeOf = (said: string) => places.find((place) => (place.code && same(place.code, said)) || same(place.name, said));
    const categoryOf = (said: string) => categories.find((category) => same(category.name, said) || same(category.prefix, said));
    const unitOf = (said: string) => (units.length ? units.find((unit) => same(unit.name, said))?.name : text(said) || 'each');
    const companyOf = (said: string) => companies.find((company) => (company.purchaserCode && same(company.purchaserCode, said)) || same(company.name, said));
    const vendorOf = (said: string) => vendors.find((vendor) => (vendor.number && same(vendor.number, said)) || same(vendor.name, said));

    const made = new Map<string, NewItem>();
    const seen = new Set<string>();
    const balances: Plan['balances'] = [];
    const checked: StockImportRowCheck[] = rows.map((row) => {
      const wrong: string[] = [];
      const code = normalizeStockCode(row.code);
      const quantity = importWhole(row.quantity);
      const unitCostCents = importCents(row.unitCost);
      if (!code) wrong.push('Give its item code.');
      else if (!STOCK_CODE.test(code)) wrong.push(`"${row.code}" is not an item code: 2 to 24 capitals, digits and dashes, like FLT-16251.`);
      if (quantity === null || quantity < 1 || quantity > MOST_QUANTITY) wrong.push('The quantity is a whole number above 0.');
      if (unitCostCents === null || unitCostCents > MOST_UNIT_COST_CENTS) wrong.push('The unit cost is an amount of dollars, like 3.90.');
      const place = row.place.trim() ? placeOf(row.place) : undefined;
      if (!row.place.trim()) wrong.push('Give its location code.');
      else if (!place) wrong.push(`"${row.place}" is not one of the places.`);
      else if (!place.active) wrong.push(`${place.name} is switched off.`);

      const existing = code ? itemOf.get(stockKey(code)) : undefined;
      let itemId: string | null = existing?.id ?? null;
      if (existing && !existing.active) wrong.push(`${existing.code} is switched off.`);
      if (!existing && code && STOCK_CODE.test(code)) {
        const already = made.get(stockKey(code));
        if (already) {
          itemId = already.id;
          if (row.description.trim() && !same(text(row.description), already.name)) wrong.push(`${code} is described differently on an earlier row.`);
        } else {
          const name = text(row.description);
          const category = row.category.trim() ? categoryOf(row.category) : undefined;
          const unit = row.unit.trim() ? unitOf(row.unit) : units.length ? undefined : 'each';
          const company = row.company.trim() ? companyOf(row.company) : undefined;
          const vendor = row.vendor.trim() ? vendorOf(row.vendor) : undefined;
          const priceCents = row.price.trim() ? importCents(row.price) : null;
          const reorderLevel = row.reorderLevel.trim() ? importWhole(row.reorderLevel) : 0;
          const reorderQuantity = row.reorderQuantity.trim() ? importWhole(row.reorderQuantity) : 0;
          if (!name) wrong.push(`${code} is new: give its description.`);
          if (!row.category.trim()) wrong.push(`${code} is new: give its category.`);
          else if (!category) wrong.push(`"${row.category}" is not one of the categories.`);
          if (!row.unit.trim() && units.length) wrong.push(`${code} is new: give its unit of measure.`);
          else if (row.unit.trim() && !unit) wrong.push(`"${row.unit}" is not one of the units of measure: ${units.map((one) => one.name).join(', ')}.`);
          if (!row.company.trim() && companies.length) wrong.push(`${code} is new: give the company it is bought for.`);
          else if (row.company.trim() && !company) wrong.push(`"${row.company}" is not one of the companies.`);
          if (row.vendor.trim() && !vendor) wrong.push(`"${row.vendor}" is not one of the vendors.`);
          if (row.price.trim() && (priceCents === null || priceCents > MOST_UNIT_COST_CENTS)) wrong.push('The usual price is an amount of dollars.');
          if (reorderLevel === null || reorderQuantity === null) wrong.push('The reorder level and quantity are whole numbers.');
          if (name && category && unit && (company || !companies.length)) {
            const item: NewItem = {
              id: randomUUID(),
              code,
              name,
              categoryId: category.id,
              unit,
              xeroTenantId: company?.xeroTenantId ?? null,
              priceCents,
              reorderLevel: reorderLevel ?? 0,
              reorderQuantity: reorderQuantity ?? 0,
              usualVendorId: vendor?.id ?? null,
            };
            made.set(stockKey(code), item);
            itemId = item.id;
          }
        }
      }
      if (itemId && place) {
        const pair = `${itemId}:${place.id}`;
        if (seen.has(pair)) wrong.push(`${code} at ${place.name} is on an earlier row too.`);
        else if (hasBalance.has(pair)) wrong.push(`${code} already has an opening balance in ${place.name}. Reverse that one first to enter another.`);
        seen.add(pair);
      }
      if (!wrong.length && itemId && place && quantity !== null && unitCostCents !== null) balances.push({ line: row.line, itemId, placeId: place.id, quantity, unitCostCents });
      return { line: row.line, code: code || row.code, item: existing ? 'EXISTING' : 'NEW', place: place?.name ?? row.place, quantity, unitCostCents, problems: wrong };
    });

    // New codes are made by whoever keeps the item codes, as by hand.
    if (made.size) {
      try {
        await assertKeeps(db, user, 'ITEMS');
      } catch (error) {
        if (error instanceof ApplicationError) problems.push(`${error.message} The file makes ${made.size} new item code${made.size === 1 ? '' : 's'}.`);
        else throw error;
      }
    }

    const right = checked.every((row) => !row.problems.length);
    return {
      day,
      items: [...made.values()],
      balances,
      check: {
        rows: checked,
        problems,
        newItems: made.size,
        existingItems: new Set(checked.filter((row) => row.item === 'EXISTING').map((row) => row.code)).size,
        totalQuantity: balances.reduce((sum, one) => sum + one.quantity, 0),
        totalValueCents: balances.reduce((sum, one) => sum + one.quantity * one.unitCostCents, 0),
        ready: right && !problems.length && balances.length === rows.length,
      },
    };
  }
}

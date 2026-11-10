import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_INVOICE_PRODUCTS,
  PAYMENT_TERMS,
  formatMoney,
  invoiceProductProblem,
  invoiceSettingsProblem,
  productNameKey,
  settingText,
  type AddInvoiceProductsInput,
  type ChangeInvoiceProductInput,
  type InvoiceProductView,
  type InvoiceSettingsValues,
  type InvoiceSettingsView,
  type SaveInvoiceSettingsInput,
} from '@texasrenters/shared';
import { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { fileCopyStatus } from './invoice-files.service';
import {
  billedPrices,
  brandFrom,
  defaultsFrom,
  fallbackDefaults,
  listedProducts,
  officeOrganisations,
  readInvoiceSettings,
  reassignJobberInvoiceCompanies,
  receiptBrand,
} from './invoice-settings';

/**
 * The invoice settings page (2026-11-06, phase 6 of taking invoicing over from
 * Jobber): the company details, what a new invoice starts with, and the
 * products and services at the office's prices.
 *
 * Not held back by `JOBBER_INVOICE_WRITES_ENABLED`, as editing invoices is:
 * nothing here reaches Jobber, nor is undone by the next read of it, and the
 * company details already print on today's PDFs and receipts. So the office
 * can have them right before the cutover. Each save is checked against what
 * was read, so two people cannot both win, and each is on the record.
 */

const LABEL: Record<keyof InvoiceSettingsValues, string> = {
  companyName: 'Company name',
  addressLine1: 'Address',
  addressLine2: 'Address, second line',
  phone: 'Phone',
  email: 'Email',
  defaultSubject: 'Subject',
  defaultTermsDays: 'Payment terms',
  defaultClientMessage: 'Client message',
  defaultContractDisclaimer: 'Contract / disclaimer',
};

const termsLabel = (days: number | null) => (days === null ? null : (PAYMENT_TERMS.find((option) => option.days === days)?.label ?? `${days} days`));

/** A value as the record shows it: long text cut short. */
const shown = (value: string | null) => (value === null ? '(blank)' : value.length > 80 ? `${value.slice(0, 77)}…` : value);

const view = (row: Awaited<ReturnType<typeof listedProducts>>[number]): InvoiceProductView => ({
  id: row.id,
  name: row.name,
  description: row.description,
  unitPriceCents: row.unitPriceCents,
  active: row.active,
  xeroTenantId: row.xeroTenantId,
  updatedAt: row.updatedAt.toISOString(),
});

const isUniqueViolation = (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

@Injectable()
export class InvoiceSettingsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async read(user: AuthenticatedUser): Promise<InvoiceSettingsView> {
    const org = user.organizationId;
    const [settings, fallback, products, billed, files, organisations] = await Promise.all([
      readInvoiceSettings(this.prisma, org),
      fallbackDefaults(this.prisma, org),
      listedProducts(this.prisma, org),
      billedPrices(this.prisma, org, businessDate()),
      // Before the cutover every file must be kept (phase 7).
      fileCopyStatus(this.prisma, org),
      // The companies' books a product or service can go to.
      officeOrganisations(this.prisma, org),
    ]);
    const listed = new Set(products.map((product) => product.nameKey));
    const serverBrand = receiptBrand();
    return {
      values: settings.values,
      fallback: { brand: serverBrand, ...fallback },
      brand: brandFrom(settings.values, serverBrand),
      defaults: defaultsFrom(settings.values, fallback),
      updatedAt: settings.updatedAt?.toISOString() ?? null,
      products: products.map(view),
      billed: billed.filter((price) => !listed.has(productNameKey(price.name))),
      organisations,
      files,
    };
  }

  async save(user: AuthenticatedUser, input: SaveInvoiceSettingsInput): Promise<InvoiceSettingsView> {
    const values: InvoiceSettingsValues = {
      companyName: settingText(input.companyName),
      addressLine1: settingText(input.addressLine1),
      addressLine2: settingText(input.addressLine2),
      phone: settingText(input.phone),
      email: settingText(input.email),
      defaultSubject: settingText(input.defaultSubject),
      defaultTermsDays: input.defaultTermsDays ?? null,
      defaultClientMessage: settingText(input.defaultClientMessage),
      defaultContractDisclaimer: settingText(input.defaultContractDisclaimer),
    };
    const problem = invoiceSettingsProblem(values);
    if (problem) throw new ApplicationError(422, 'INVOICE_SETTINGS_INVALID', problem);
    const org = user.organizationId;

    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await readInvoiceSettings(tx, org);
        const expected = input.expectedUpdatedAt ? new Date(input.expectedUpdatedAt).toISOString() : null;
        if ((before.updatedAt?.toISOString() ?? null) !== expected) throw this.changed();
        const changes = (Object.keys(LABEL) as (keyof InvoiceSettingsValues)[]).flatMap((key) => {
          const was = key === 'defaultTermsDays' ? termsLabel(before.values[key]) : (before.values[key] as string | null);
          const now = key === 'defaultTermsDays' ? termsLabel(values[key]) : (values[key] as string | null);
          return was === now ? [] : [`${LABEL[key]}: ${shown(was)} → ${shown(now)}`];
        });
        if (!changes.length) return;
        if (before.updatedAt) {
          // Only over the row as it was read: a save in between makes this one change nothing.
          const { count } = await tx.invoiceSettings.updateMany({ where: { organizationId: org, updatedAt: before.updatedAt }, data: values });
          if (count !== 1) throw this.changed();
        } else await tx.invoiceSettings.create({ data: { organizationId: org, ...values } });
        await this.audit(tx, user, 'INVOICE_SETTINGS_CHANGED', 'InvoiceSettings', org, { changes });
      });
    } catch (error) {
      // Two first saves at once: the other one made the row.
      if (isUniqueViolation(error)) throw this.changed();
      throw error;
    }
    return this.read(user);
  }

  async addProducts(user: AuthenticatedUser, input: AddInvoiceProductsInput): Promise<InvoiceSettingsView> {
    const products = input.products.map((product) => ({
      name: product.name.trim(),
      nameKey: productNameKey(product.name),
      description: settingText(product.description),
      unitPriceCents: product.unitPriceCents,
    }));
    for (const product of products) {
      const problem = invoiceProductProblem(product);
      if (problem) throw new ApplicationError(422, 'INVOICE_PRODUCT_INVALID', problem);
    }
    if (new Set(products.map((product) => product.nameKey)).size !== products.length)
      throw new ApplicationError(422, 'INVOICE_PRODUCT_INVALID', 'A product is listed twice.');
    const org = user.organizationId;

    try {
      await this.prisma.$transaction(async (tx) => {
        const existing = await tx.invoiceProduct.findMany({
          where: { organizationId: org },
          select: { name: true, nameKey: true, active: true },
        });
        const clash = existing.find((row) => products.some((product) => product.nameKey === row.nameKey));
        if (clash) throw this.exists(clash.name, clash.active);
        if (existing.length + products.length > MAX_INVOICE_PRODUCTS)
          throw new ApplicationError(
            422,
            'INVOICE_PRODUCT_INVALID',
            `The list holds ${MAX_INVOICE_PRODUCTS} products and services at most. Set aside the ones no longer sold.`,
          );
        await tx.invoiceProduct.createMany({ data: products.map((product) => ({ organizationId: org, ...product })) });
        await this.audit(tx, user, 'INVOICE_PRODUCTS_ADDED', 'InvoiceSettings', org, {
          products: products.map((product) => `${product.name}: ${formatMoney(product.unitPriceCents)}`),
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw this.exists(null, true);
      throw error;
    }
    return this.read(user);
  }

  async changeProduct(user: AuthenticatedUser, id: string, input: ChangeInvoiceProductInput): Promise<InvoiceSettingsView> {
    const org = user.organizationId;
    // Its company or its name changed: Jobber's invoices that bill it may now go to another company's books.
    let regroup = false;
    try {
      await this.prisma.$transaction(async (tx) => {
        const before = await tx.invoiceProduct.findFirst({ where: { id, organizationId: org } });
        if (!before) throw new ApplicationError(404, 'INVOICE_PRODUCT_NOT_FOUND', 'That product or service was not found.');
        if (before.updatedAt.toISOString() !== new Date(input.expectedUpdatedAt).toISOString()) throw this.changed();
        const after = {
          name: input.name !== undefined ? input.name.trim() : before.name,
          description: input.description !== undefined ? settingText(input.description) : before.description,
          unitPriceCents: input.unitPriceCents ?? before.unitPriceCents,
          active: input.active ?? before.active,
          xeroTenantId: input.xeroTenantId !== undefined ? input.xeroTenantId || null : before.xeroTenantId,
        };
        const problem = invoiceProductProblem(after);
        if (problem) throw new ApplicationError(422, 'INVOICE_PRODUCT_INVALID', problem);
        // Which company's books it goes to: one of the office's organisations, connected now -- or none.
        const organisations = await this.organisationNames(tx, org, [before.xeroTenantId, after.xeroTenantId]);
        if (after.xeroTenantId !== before.xeroTenantId && after.xeroTenantId && !organisations.get(after.xeroTenantId)?.connected)
          throw new ApplicationError(422, 'INVOICE_PRODUCT_INVALID', 'That Xero organisation is not connected. Choose one that is.');
        const orgName = (tenantId: string | null) => (tenantId ? (organisations.get(tenantId)?.name ?? 'an organisation no longer known') : 'none');
        const changes = [
          after.name !== before.name ? `Name: ${before.name} → ${after.name}` : null,
          after.description !== before.description ? `Description: ${shown(before.description)} → ${shown(after.description)}` : null,
          after.unitPriceCents !== before.unitPriceCents
            ? `Price: ${formatMoney(before.unitPriceCents)} → ${formatMoney(after.unitPriceCents)}`
            : null,
          after.active !== before.active ? (after.active ? 'Offered again' : 'Set aside') : null,
          after.xeroTenantId !== before.xeroTenantId ? `Xero organisation: ${orgName(before.xeroTenantId)} → ${orgName(after.xeroTenantId)}` : null,
        ].filter((change): change is string => change !== null);
        if (!changes.length) return;
        const { count } = await tx.invoiceProduct.updateMany({
          where: { id, organizationId: org, updatedAt: before.updatedAt },
          data: { ...after, nameKey: productNameKey(after.name) },
        });
        if (count !== 1) throw this.changed();
        await this.audit(tx, user, 'INVOICE_PRODUCT_CHANGED', 'InvoiceProduct', id, { name: after.name, changes });
        regroup = after.xeroTenantId !== before.xeroTenantId || productNameKey(after.name) !== productNameKey(before.name);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw this.exists(input.name?.trim() ?? null, true);
      throw error;
    }
    if (regroup) await reassignJobberInvoiceCompanies(this.prisma, org);
    return this.read(user);
  }

  private changed() {
    return new ApplicationError(409, 'INVOICE_SETTINGS_CHANGED', 'Somebody changed these settings since they were opened. Look again, then save.');
  }

  /** The office's organisations among these ids: their names, and whether each is connected. */
  private async organisationNames(tx: Prisma.TransactionClient, organizationId: string, tenantIds: (string | null)[]) {
    const wanted = [...new Set(tenantIds.filter((id): id is string => Boolean(id)))];
    const rows = wanted.length
      ? await tx.xeroOrganisation.findMany({ where: { organizationId, xeroTenantId: { in: wanted } }, select: { xeroTenantId: true, name: true, status: true } })
      : [];
    return new Map(rows.map((row) => [row.xeroTenantId, { name: row.name, connected: row.status === 'CONNECTED' }]));
  }

  private exists(name: string | null, active: boolean) {
    const which = name ? `${name} is` : 'That name is';
    return new ApplicationError(
      409,
      'INVOICE_PRODUCT_EXISTS',
      active ? `${which} already on the list.` : `${which} on the list, set aside. Offer it again instead.`,
    );
  }

  private audit(tx: Prisma.TransactionClient, user: AuthenticatedUser, action: string, entityType: string, entityId: string, metadata: Prisma.InputJsonObject) {
    return tx.auditLog.create({
      data: { organizationId: user.organizationId, actorUserId: user.id, action, entityType, entityId, metadata },
    });
  }
}

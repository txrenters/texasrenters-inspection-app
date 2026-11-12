import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_BILLING_RULES,
  MAX_INVOICE_PRODUCTS,
  PAYMENT_TERMS,
  billingRuleProblem,
  billingRuleWhen,
  formatMoney,
  invoiceProductProblem,
  invoiceSettingsProblem,
  productNameKey,
  settingText,
  type AddBillingRulesInput,
  type AddInvoiceProductsInput,
  type ChangeInvoiceProductInput,
  type InvoiceProductView,
  type InvoiceSettingsValues,
  type InvoiceSettingsView,
  type ReportableVisitService,
  type SaveInvoiceSettingsInput,
} from '@texasrenters/shared';
import { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../common/auth';
import { businessDate } from '../common/business-day';
import { ApplicationError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { billingBasis, suggestedBillingRules } from './invoice-billing-rules';
import { fileCopyStatus } from './invoice-files.service';
import {
  billedPrices,
  brandFrom,
  defaultsFrom,
  fallbackDefaults,
  invoicingTakenOverAt,
  listedProducts,
  officeOrganisations,
  readInvoiceSettings,
  reassignJobberInvoiceCompanies,
  receiptBrand,
} from './invoice-settings';

/**
 * The invoice settings page (2026-11-06, phase 6 of taking invoicing over from
 * Jobber): the company details, what a new invoice starts with, the
 * products and services at the office's prices, and what a finished visit
 * bills of them (2026-11-12).
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
    // Once the console makes the invoices (2026-11-12), the list is the office's own: what Jobber billed is no longer
    // offered to add to it.
    const switchedAt = await invoicingTakenOverAt(this.prisma, org);
    const [settings, fallback, products, billed, files, organisations, basis] = await Promise.all([
      readInvoiceSettings(this.prisma, org),
      fallbackDefaults(this.prisma, org),
      listedProducts(this.prisma, org),
      switchedAt ? [] : billedPrices(this.prisma, org, businessDate()),
      // Before the cutover every file must be kept (phase 7).
      fileCopyStatus(this.prisma, org),
      // The companies' books a product or service can go to.
      officeOrganisations(this.prisma, org),
      // What a finished visit bills (2026-11-12).
      billingBasis(this.prisma, org),
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
      billingRules: basis.rules,
      suggestedRules: await suggestedBillingRules(this.prisma, org, businessDate(), basis),
      organisations,
      files,
      madeInConsole: Boolean(switchedAt),
    };
  }

  /**
   * Rules for what a finished visit bills (2026-11-12): the suggested ones
   * confirmed, or one the office wrote. Each names an offered product of its
   * own office. One already kept is not added twice, so confirming twice adds
   * nothing.
   */
  async addBillingRules(user: AuthenticatedUser, input: AddBillingRulesInput): Promise<InvoiceSettingsView> {
    const org = user.organizationId;
    const rules = input.rules.map((rule) => ({ inspectionType: rule.inspectionType ?? null, service: rule.service ?? null, productId: rule.productId }));
    for (const rule of rules) {
      const problem = billingRuleProblem(rule);
      if (problem) throw new ApplicationError(422, 'INVOICE_BILLING_RULE_INVALID', problem);
    }
    const keyOf = (rule: { inspectionType: string | null; service: string | null; productId: string }) => `${rule.inspectionType}|${rule.service}|${rule.productId}`;
    await this.prisma.$transaction(async (tx) => {
      const [products, existing] = await Promise.all([
        tx.invoiceProduct.findMany({ where: { organizationId: org, id: { in: [...new Set(rules.map((rule) => rule.productId))] } }, select: { id: true, name: true, unitPriceCents: true, active: true } }),
        tx.invoiceBillingRule.findMany({ where: { organizationId: org }, select: { inspectionType: true, service: true, productId: true } }),
      ]);
      for (const rule of rules) {
        const product = products.find((each) => each.id === rule.productId);
        if (!product) throw new ApplicationError(404, 'INVOICE_PRODUCT_NOT_FOUND', 'That product or service was not found.');
        if (!product.active) throw new ApplicationError(422, 'INVOICE_BILLING_RULE_INVALID', `${product.name} is set aside. Offer it again first.`);
      }
      const kept = new Set(existing.map(keyOf));
      const fresh = [...new Map(rules.filter((rule) => !kept.has(keyOf(rule))).map((rule) => [keyOf(rule), rule])).values()];
      if (!fresh.length) return;
      if (existing.length + fresh.length > MAX_BILLING_RULES)
        throw new ApplicationError(422, 'INVOICE_BILLING_RULE_INVALID', `The office keeps ${MAX_BILLING_RULES} rules at most. Remove the ones no longer needed.`);
      // Another confirm a moment ago: the unique index keeps one of each.
      await tx.invoiceBillingRule.createMany({ data: fresh.map((rule) => ({ organizationId: org, ...rule })), skipDuplicates: true });
      await this.audit(tx, user, 'INVOICE_BILLING_RULES_ADDED', 'InvoiceSettings', org, {
        rules: fresh.map((rule) => {
          const product = products.find((each) => each.id === rule.productId)!;
          return `${billingRuleWhen(rule)} → ${product.name} (${formatMoney(product.unitPriceCents)})`;
        }),
      });
    });
    return this.read(user);
  }

  /** A rule taken away: the visits it covered bill what the others say, or are listed as needing one. */
  async removeBillingRule(user: AuthenticatedUser, id: string): Promise<InvoiceSettingsView> {
    const org = user.organizationId;
    await this.prisma.$transaction(async (tx) => {
      const rule = await tx.invoiceBillingRule.findFirst({
        where: { id, organizationId: org },
        select: { id: true, inspectionType: true, service: true, product: { select: { name: true } } },
      });
      if (!rule) throw new ApplicationError(404, 'INVOICE_BILLING_RULE_NOT_FOUND', 'That rule was not found. It may have been removed already.');
      await tx.invoiceBillingRule.delete({ where: { id: rule.id } });
      await this.audit(tx, user, 'INVOICE_BILLING_RULE_REMOVED', 'InvoiceSettings', org, {
        rule: `${billingRuleWhen({ inspectionType: rule.inspectionType, service: rule.service as ReportableVisitService | null })} → ${rule.product.name}`,
      });
    });
    return this.read(user);
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
        // Its Xero choices are kept on it (2026-11-13), so a new name keeps them; another company's books have other
        // accounts, items and tracking, so a move leaves them to be chosen there.
        const moved = after.xeroTenantId !== before.xeroTenantId;
        if (moved && (before.xeroAccountId || before.xeroItemCode || before.xeroTrackingGroup))
          changes.push('Its account, item and tracking in Xero: cleared, to be chosen for its new company');
        const { count } = await tx.invoiceProduct.updateMany({
          where: { id, organizationId: org, updatedAt: before.updatedAt },
          data: {
            ...after,
            nameKey: productNameKey(after.name),
            ...(moved ? { xeroAccountId: null, xeroItemCode: null, xeroTrackingGroup: null } : {}),
          },
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

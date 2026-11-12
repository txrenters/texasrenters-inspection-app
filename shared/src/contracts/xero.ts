import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from './invoices.js';

/**
 * The office's Xero organisations (2026-11-10). The companies -- THMP, Crystal
 * Creek Pest, Crystal Creek Air and the like -- each keep their own books in
 * Xero; one sign-in by somebody who runs the integrations reaches all of them,
 * and each is read -- its details, chart of accounts and tax rates -- so its
 * own choices can be made against it. Nothing is written to Xero yet.
 */

export type XeroConnectionStatus = 'DISCONNECTED' | 'CONNECTED' | 'REAUTHORIZATION_REQUIRED';

/** CONNECTED, or REMOVED once the sign-in no longer reaches it, or it was disconnected. */
export type XeroOrganisationStatus = 'CONNECTED' | 'REMOVED';

export interface XeroOrganisation {
  name: string;
  legalName: string | null;
  /** "USD". */
  baseCurrency: string | null;
  /** "US". */
  countryCode: string | null;
  organisationType: string | null;
  /** How Xero works out sales tax for the organisation, e.g. "NONE". */
  salesTaxBasis: string | null;
  /** Xero's short code, part of its own links ("!abC1d"). */
  shortCode: string | null;
}

export interface XeroAccount {
  accountId: string;
  /** Null for a bank account, which Xero lets go without one. */
  code: string | null;
  name: string;
  /** REVENUE, SALES, BANK, CURRLIAB, ... */
  type: string;
  /** ASSET, EQUITY, EXPENSE, LIABILITY, REVENUE. */
  class: string | null;
  status: string;
  /** Payments can be recorded to it: a bank account, or one marked so. */
  takesPayments: boolean;
}

export interface XeroTaxRate {
  name: string;
  /** What a line names: "NONE", "OUTPUT", "TAX001". */
  taxType: string;
  status: string;
  /** Percent. */
  effectiveRate: number | null;
  appliesToRevenue: boolean;
}

/**
 * One of an organisation's tracking categories, with its options (2026-11-11).
 * THMP's "Income by Employee" holds an option for each kind of work and each
 * technician: "Air Filter Income: Amy", "HVAC Inspection Income: Moses".
 */
export interface XeroTrackingCategory {
  trackingCategoryId: string;
  name: string;
  /** ACTIVE or ARCHIVED. */
  status: string;
  options: { optionId: string; name: string; status: string }[];
}

/** One of an organisation's products and services in Xero (2026-11-11): what a line's "Item" names. */
export interface XeroItem {
  itemId: string;
  /** What a line names: "Filter Change", "HVAC". */
  code: string;
  name: string | null;
  /** Xero sells it: it can go on a sales invoice. */
  isSold: boolean;
}

/** One of an organisation's Xero users who can log time on projects (2026-11-11). */
export interface XeroProjectUser {
  /** Xero's projects user id: what a time entry names. */
  userId: string;
  name: string;
}

/** One organisation the sign-in reaches, as last read. */
export interface XeroOrganisationView {
  /** Xero's id for the organisation: what every call to it names. */
  tenantId: string;
  name: string;
  status: XeroOrganisationStatus;
  connectedAt: string | null;
  removedAt: string | null;
  organisation: XeroOrganisation | null;
  accounts: XeroAccount[];
  taxRates: XeroTaxRate[];
  /** As last read (2026-11-11); empty when it has none, or Xero did not say. */
  trackingCategories: XeroTrackingCategory[];
  items: XeroItem[];
  /** Its users who can log time on projects, as last read (2026-11-11); empty before the connection may read projects. */
  projectUsers: XeroProjectUser[];
  readAt: string | null;
  readProblem: string | null;
  /** Calls to this organisation today (Texas): Xero limits each organisation on its own. */
  callsToday: number;
  /** Whether Xero's own invoice reminders are on in this organisation, as last read; null when Xero did not say. */
  invoiceRemindersOn: boolean | null;
}

export interface XeroConnectionView {
  /** Whether this server has a Xero app's credentials at all. */
  configured: boolean;
  status: XeroConnectionStatus;
  connectedAt: string | null;
  disconnectedAt: string | null;
  /** Why it needs connecting again, in words. */
  problem: string | null;
  scopes: string[];
  /** Connected ones first, by name; then any the sign-in no longer reaches. */
  organisations: XeroOrganisationView[];
  /** The console's own ceiling on calls a Texas day, for each organisation. */
  dailyCeiling: number;
}

/** The organisations the console can work with now. */
export const connectedOrganisations = (view: Pick<XeroConnectionView, 'status' | 'organisations'>) =>
  view.status === 'CONNECTED' ? view.organisations.filter((organisation) => organisation.status === 'CONNECTED') : [];

/** What sending invoices needs Xero to allow (phase 3). Payments are asked for at the same time, for phase 4. */
export const XERO_WRITE_SCOPES = ['accounting.contacts', 'accounting.invoices'] as const;

/** Whether a connection may write invoices: made with the scopes phase 3 asks for. */
export const xeroCanWrite = (scopes: readonly string[]) => XERO_WRITE_SCOPES.every((scope) => scopes.includes(scope));

/** What making a project for each visit needs Xero to allow (2026-11-11). */
export const XERO_PROJECTS_SCOPE = 'projects';

/** Whether a connection may make projects and log time on them. */
export const xeroCanMakeProjects = (scopes: readonly string[]) => scopes.includes(XERO_PROJECTS_SCOPE);

/** The accounts a sale is posted to: active revenue accounts with a code. */
export const revenueAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter((account) => account.status === 'ACTIVE' && account.code && (account.class === 'REVENUE' || account.type === 'REVENUE' || account.type === 'SALES'));

/** The accounts a payment can be recorded to: active, and taking payments. */
export const paymentAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter((account) => account.status === 'ACTIVE' && account.takesPayments);

/** The accounts a bad debt can be written off to (2026-11-10): active expense accounts with a code. */
export const badDebtAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter(
    (account) =>
      account.status === 'ACTIVE' &&
      account.code &&
      (account.class === 'EXPENSE' || account.type === 'EXPENSE' || account.type === 'OVERHEADS' || account.type === 'DIRECTCOSTS'),
  );

/**
 * The office's choices for sending to Xero (2026-11-10, phase 2 of the Xero
 * plan). The contact on a Xero invoice is the invoice's client -- for the
 * office, the property, as in Jobber -- so there is nothing to choose there.
 * Nothing is sent to Xero yet.
 */
export interface XeroSettingsValues {
  /** Invoices issued on or after this day (YYYY-MM-DD, Texas) are the ones sent. */
  sendFrom: string | null;
  /** The account a line goes to when its name has none of its own. */
  salesAccountId: string | null;
  /** Xero's tax type on every line, e.g. "NONE". */
  salesTaxType: string | null;
  /** Product or service name key (`productNameKey`) to Xero account id. */
  salesAccounts: Record<string, string>;
  paymentAccounts: Partial<Record<PaymentMethod, string>>;
  /**
   * The expense account an invoice closed as bad debt is written off to, with
   * a credit note (2026-11-10); null or left out for none chosen yet.
   */
  badDebtAccountId?: string | null;
  /**
   * Whether payments go to Xero (2026-11-11). Off, the office records them in
   * Xero itself: none is sent, and no payment method needs an account. Left
   * out reads as on.
   */
  paymentsToXero?: boolean;
  /**
   * The tracking category each line is tagged in for the technician who did
   * the visit (2026-11-11), e.g. THMP's "Income by Employee"; null for none.
   */
  trackingCategoryId?: string | null;
  /**
   * Product or service name key to the start of its option in that category,
   * the part before the technician's first name: "HVAC Inspection Income"
   * makes "HVAC Inspection Income: Moses". A product left out is not tagged.
   */
  trackingGroups?: Record<string, string>;
  /** Product or service name key to the code of its item in Xero: "Filter Change", "HVAC". */
  itemCodes?: Record<string, string>;
  /**
   * A Xero project for each visit (2026-11-11), as the office keeps one, with
   * the technician's labour logged as time on it. On, the invoices go to Xero
   * as drafts -- Xero's API cannot put a line on a project, so the office does,
   * then approves -- and payments must stay out of Xero. Left out reads as off.
   */
  projectsEnabled?: boolean;
  /** The Xero user the labour is logged under (`XeroProjectUser.userId`); null for none chosen yet. */
  projectUserId?: string | null;
  /** The labour's rate, in cents an hour; left out reads as $35.00. 0 logs none. */
  labourRateCents?: number;
  /** The labour's minutes on each visit; left out reads as 6. 0 logs none. */
  labourMinutes?: number;
  /**
   * Its prices include its sales tax (2026-11-12): lines go to Xero
   * tax-inclusive, at the tax type above, so Xero's total is the console's.
   * Crystal Creek Pest's $39.00 is $36.03 and $2.97 of tax at 8.25%. Left out
   * reads as off: tax, if any, is added on top.
   */
  pricesIncludeTax?: boolean;
}

/** The labour the office has been adding to each project by hand: $35.00 an hour, a tenth of an hour. */
export const DEFAULT_LABOUR_RATE_CENTS = 3500;
export const DEFAULT_LABOUR_MINUTES = 6;
export const MAX_LABOUR_RATE_CENTS = 100_000;
export const MAX_LABOUR_MINUTES = 600;

/** Projects are made for each visit: invoices then go as drafts. */
export const projectsAreOn = (values: Pick<XeroSettingsValues, 'projectsEnabled'>) => values.projectsEnabled === true;

/** The labour logged on each project the console makes; null when projects are off, or either part is 0. */
export function labourOf(values: Pick<XeroSettingsValues, 'projectsEnabled' | 'labourRateCents' | 'labourMinutes'>): { rateCents: number; minutes: number } | null {
  if (!projectsAreOn(values)) return null;
  const rateCents = values.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS;
  const minutes = values.labourMinutes ?? DEFAULT_LABOUR_MINUTES;
  return rateCents > 0 && minutes > 0 ? { rateCents, minutes } : null;
}

/** What a visit's project is named after (2026-11-11). */
export interface XeroProjectVisit {
  /** The visit's day, `YYYY-MM-DD`. */
  day: string;
  technicianName: string | null;
  /** The benefit-package quarter the visit belongs to -- its plan's, never its day's; null for any other visit. */
  packageQuarter: { year: number; quarter: number } | null;
  /** What any other visit was, as its invoice's first line names it: "Move Out Inspection". */
  kind: string;
}

const QUARTER_WORDS = ['1st', '2nd', '3rd', '4th'] as const;

/**
 * A visit's project, named as the office names them: the technician's first
 * name, then "Tenant Benefit Package - 4th Qtr - 2026" for a package visit, or
 * what any other visit was, then the visit's day as 11.10.2026. Null when the
 * visit has no technician: the office's names always start with one.
 */
export function xeroProjectName(visit: XeroProjectVisit): string | null {
  const first = visit.technicianName?.trim().split(/\s+/)[0] ?? '';
  if (!first) return null;
  const [year, month, day] = visit.day.split('-');
  const dated = `${month}.${day}.${year}`;
  const what = visit.packageQuarter
    ? `Tenant Benefit Package - ${QUARTER_WORDS[visit.packageQuarter.quarter - 1] ?? `${visit.packageQuarter.quarter}th`} Qtr - ${visit.packageQuarter.year}`
    : visit.kind.trim() || 'Visit';
  return `${first}: ${what} - ${dated}`.slice(0, 100);
}

/** A name a line can carry: on the office's products list, or billed in the past six months. */
export interface XeroSalesItem {
  nameKey: string;
  name: string;
  /** On the products list; otherwise only billed. */
  listed: boolean;
  /** False when set aside on the list. */
  active: boolean;
  accountId: string | null;
  /** The start of its tracking option (see `XeroSettingsValues.trackingGroups`); null for none. */
  trackingGroup?: string | null;
  /** Its item's code in Xero; null for none. */
  itemCode?: string | null;
}

export interface XeroPaymentItem {
  method: PaymentMethod;
  accountId: string | null;
  /** Payments on the invoices that would be sent (see `XeroSettingsView.invoicesToSend`). */
  payments: number;
}

export type XeroCheckKey = 'connected' | 'sendFrom' | 'salesAccount' | 'taxType' | 'payments' | 'stillInXero' | 'projects';

export interface XeroCheck {
  key: XeroCheckKey;
  label: string;
  ok: boolean;
  /** What is missing, in words; null when nothing is. */
  detail: string | null;
}

export interface XeroSettingsView {
  /** The organisation these choices are for. */
  tenantId: string;
  values: XeroSettingsValues;
  /** The products and services the office sends to this organisation, from its products list. */
  products: XeroSalesItem[];
  /** Products and services offered that go to no organisation yet: chosen on the products list. */
  withoutOrganisation: number;
  /** Every payment method, in the console's order. */
  payments: XeroPaymentItem[];
  /** Invoices issued on or after the start date, not drafts or voided; with no start date, the past year's. */
  invoicesToSend: number;
  checks: XeroCheck[];
  /** Every check passes: phase 3 may send. */
  ready: boolean;
  /** When the choices were last saved (2026-11-11): what a save names as `expectedUpdatedAt`. Sending runs do not move it. */
  updatedAt: string | null;
}

export interface SaveXeroSettingsInput extends XeroSettingsValues {
  expectedUpdatedAt: string | null;
}

/** The products list holds 200 and the billed names 50: room to spare, and a bound on the row. */
export const MAX_XERO_SALES_ACCOUNTS = 300;

const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

type XeroCatalog = {
  accounts: readonly XeroAccount[];
  taxRates: readonly XeroTaxRate[];
  trackingCategories?: readonly XeroTrackingCategory[];
  items?: readonly XeroItem[];
  projectUsers?: readonly XeroProjectUser[];
};

/** Payments go to Xero unless the office said they stay out. */
export const paymentsGoToXero = (values: Pick<XeroSettingsValues, 'paymentsToXero'>) => values.paymentsToXero !== false;

/** Tracking categories a line can be tagged in: active, with an active option. */
export const activeTrackingCategories = (categories: readonly XeroTrackingCategory[]) =>
  categories.filter((category) => category.status === 'ACTIVE' && category.options.some((option) => option.status === 'ACTIVE'));

/** Items a sales line can name: sold, with a code. */
export const soldItems = (items: readonly XeroItem[]) => items.filter((item) => item.isSold && item.code.trim() !== '');

/** Words for matching an option's name: lower case, colons and runs of spaces as one space. */
const optionWords = (value: string) => value.toLowerCase().replace(/:/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The starts of a category's options -- the part before the colon, "Air Filter
 * Income" in "Air Filter Income: Amy" -- each once, in order. An option with no
 * colon starts none.
 */
export function trackingGroups(category: XeroTrackingCategory | null | undefined): string[] {
  if (!category) return [];
  const groups = new Map<string, string>();
  for (const option of category.options) {
    if (option.status !== 'ACTIVE') continue;
    const at = option.name.lastIndexOf(':');
    if (at <= 0) continue;
    const group = option.name.slice(0, at).trim();
    if (group && !groups.has(optionWords(group))) groups.set(optionWords(group), group);
  }
  return [...groups.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * A technician's option in a group: "HVAC Inspection Income" and "Moses
 * Rodriguez" find "HVAC Inspection Income: Moses" -- by first name, else by
 * the whole name -- however its colon and spaces are written. Null when the
 * category has no active one.
 */
export function trackingOptionFor(
  category: XeroTrackingCategory,
  group: string,
  technicianName: string,
): { optionId: string; name: string } | null {
  const whole = technicianName.trim();
  const first = whole.split(/\s+/)[0] ?? '';
  if (!first) return null;
  const active = category.options.filter((option) => option.status === 'ACTIVE');
  for (const name of [first, whole]) {
    const wanted = optionWords(`${group} ${name}`);
    const found = active.find((option) => optionWords(option.name) === wanted);
    if (found) return { optionId: found.optionId, name: found.name };
  }
  return null;
}

/** The tax types a sale can carry: active, and allowed on revenue. */
export const revenueTaxRates = (taxRates: readonly XeroTaxRate[]) => taxRates.filter((rate) => rate.status === 'ACTIVE' && rate.appliesToRevenue);

/** "400 Sales", or a bank account's name alone. */
export const xeroAccountLabel = (account: XeroAccount) => (account.code ? `${account.code} ${account.name}` : account.name);

/**
 * Why these choices cannot be saved against Xero's accounts and tax rates, in
 * words, or null. Each account must be one Xero would take for what it is
 * chosen for; a choice left empty is fine here (the checks say what is still
 * missing).
 */
export function xeroSettingsProblem(values: XeroSettingsValues, catalog: XeroCatalog, today: string): string | null {
  const sales = new Set(revenueAccounts(catalog.accounts).map((account) => account.accountId));
  const payments = new Set(paymentAccounts(catalog.accounts).map((account) => account.accountId));
  const taxTypes = new Set(revenueTaxRates(catalog.taxRates).map((rate) => rate.taxType));
  if (values.sendFrom !== null) {
    if (!isDay(values.sendFrom)) return 'The start date is not a date.';
    if (values.sendFrom < '2000-01-01') return 'The start date is too long ago.';
    const latest = new Date(Date.parse(`${today}T00:00:00.000Z`) + 366 * 86_400_000).toISOString().slice(0, 10);
    if (values.sendFrom > latest) return 'The start date is more than a year away.';
  }
  if (values.salesAccountId !== null && !sales.has(values.salesAccountId))
    return 'The default sales account is not an active revenue account with a code in Xero.';
  if (values.salesTaxType !== null && !taxTypes.has(values.salesTaxType)) return 'That tax type is not an active one Xero allows on sales.';
  const named = Object.entries(values.salesAccounts);
  if (named.length > MAX_XERO_SALES_ACCOUNTS) return `At most ${MAX_XERO_SALES_ACCOUNTS} products and services can have an account of their own.`;
  for (const [nameKey, accountId] of named) {
    if (!nameKey || nameKey.length > 200 || nameKey !== nameKey.trim().toLowerCase()) return 'A product or service is not named as the list names it.';
    if (typeof accountId !== 'string' || !sales.has(accountId))
      return 'A product or service is given an account that is not an active revenue account with a code in Xero.';
  }
  for (const [method, accountId] of Object.entries(values.paymentAccounts)) {
    if (!(PAYMENT_METHODS as readonly string[]).includes(method)) return 'That is not a payment method the console knows.';
    if (typeof accountId !== 'string' || !payments.has(accountId))
      return `${PAYMENT_METHOD_LABEL[method as PaymentMethod]} is given an account that does not take payments in Xero.`;
  }
  if (values.badDebtAccountId && !badDebtAccounts(catalog.accounts).some((account) => account.accountId === values.badDebtAccountId))
    return 'Bad debts are given an account that is not an active expense account with a code in Xero.';
  if (values.paymentsToXero !== undefined && typeof values.paymentsToXero !== 'boolean') return 'Say whether payments go to Xero.';
  const category = values.trackingCategoryId
    ? activeTrackingCategories(catalog.trackingCategories ?? []).find((each) => each.trackingCategoryId === values.trackingCategoryId)
    : null;
  if (values.trackingCategoryId && !category) return 'That tracking category is not an active one in Xero.';
  const groups = Object.entries(values.trackingGroups ?? {});
  if (groups.length > MAX_XERO_SALES_ACCOUNTS) return `At most ${MAX_XERO_SALES_ACCOUNTS} products and services can be tracked.`;
  if (groups.length && !category) return 'Choose the tracking category before what each product or service is tracked as.';
  const known = new Set(trackingGroups(category).map(optionWords));
  for (const [nameKey, group] of groups) {
    if (!nameKey || nameKey.length > 200 || nameKey !== nameKey.trim().toLowerCase()) return 'A product or service is not named as the list names it.';
    if (typeof group !== 'string' || !known.has(optionWords(group))) return `“${group}” does not start any option of ${category!.name} in Xero.`;
  }
  const items = new Set(soldItems(catalog.items ?? []).map((item) => item.code));
  const coded = Object.entries(values.itemCodes ?? {});
  if (coded.length > MAX_XERO_SALES_ACCOUNTS) return `At most ${MAX_XERO_SALES_ACCOUNTS} products and services can have an item.`;
  for (const [nameKey, code] of coded) {
    if (!nameKey || nameKey.length > 200 || nameKey !== nameKey.trim().toLowerCase()) return 'A product or service is not named as the list names it.';
    if (typeof code !== 'string' || !items.has(code)) return `“${code}” is not an item Xero sells.`;
  }
  // A project for each visit (2026-11-11).
  if (values.projectsEnabled !== undefined && typeof values.projectsEnabled !== 'boolean') return 'Say whether each visit gets a project.';
  const whole = (value: unknown, max: number) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
  if (values.labourRateCents !== undefined && !whole(values.labourRateCents, MAX_LABOUR_RATE_CENTS))
    return `The labour’s rate is from $0 to $${MAX_LABOUR_RATE_CENTS / 100} an hour, in whole cents.`;
  if (values.labourMinutes !== undefined && !whole(values.labourMinutes, MAX_LABOUR_MINUTES)) return `The labour is from 0 to ${MAX_LABOUR_MINUTES} whole minutes.`;
  if (values.projectUserId && !(catalog.projectUsers ?? []).some((user) => user.userId === values.projectUserId))
    return 'That Xero user cannot log time on projects. Read from Xero again, then choose.';
  // Prices that include tax (2026-11-12): the tax type must be a rate, or there is nothing in them to take out.
  if (values.pricesIncludeTax !== undefined && typeof values.pricesIncludeTax !== 'boolean') return 'Say whether prices include sales tax.';
  if (values.pricesIncludeTax && values.salesTaxType !== null) {
    const rate = revenueTaxRates(catalog.taxRates).find((each) => each.taxType === values.salesTaxType)?.effectiveRate ?? 0;
    if (!(rate > 0)) return 'Prices include sales tax, so choose the tax type with the rate they include, such as 8.25%.';
  }
  if (projectsAreOn(values) && paymentsGoToXero(values))
    return 'Payments must stay out of Xero while each visit gets a project: its invoices go as drafts, and Xero takes no payment on a draft.';
  return null;
}

/**
 * What must be true before phase 3 sends anything, each with what is missing.
 * `paymentsByMethod` counts payments on the invoices that would be sent.
 */
export function xeroChecks(input: {
  connected: boolean;
  readAt: string | null;
  values: XeroSettingsValues;
  catalog: XeroCatalog;
  paymentsByMethod: Partial<Record<PaymentMethod, number>>;
}): XeroCheck[] {
  const { values, catalog } = input;
  const byId = new Map(catalog.accounts.map((account) => [account.accountId, account]));
  const sales = new Set(revenueAccounts(catalog.accounts).map((account) => account.accountId));
  const takes = new Set(paymentAccounts(catalog.accounts).map((account) => account.accountId));
  const taxTypes = new Set(revenueTaxRates(catalog.taxRates).map((rate) => rate.taxType));
  const payments = paymentsGoToXero(values);
  const unmapped = payments ? PAYMENT_METHODS.filter((method) => (input.paymentsByMethod[method] ?? 0) > 0 && !values.paymentAccounts[method]) : [];
  // A choice Xero no longer has, or no longer takes for that use: archived, deleted, or another organisation's.
  const gone = new Set<string>();
  for (const id of [values.salesAccountId, ...Object.values(values.salesAccounts)]) if (id && !sales.has(id)) gone.add(id);
  if (payments) for (const id of Object.values(values.paymentAccounts)) if (id && !takes.has(id)) gone.add(id);
  const goneNames = [...gone].map((id) => {
    const account = byId.get(id);
    return account ? xeroAccountLabel(account) : 'an account Xero no longer lists';
  });
  // And the tracking category and items (2026-11-11): archived or deleted in Xero since they were chosen.
  const category = values.trackingCategoryId
    ? activeTrackingCategories(catalog.trackingCategories ?? []).find((each) => each.trackingCategoryId === values.trackingCategoryId)
    : undefined;
  if (values.trackingCategoryId && !category) goneNames.push('the tracking category');
  const groups = new Set(trackingGroups(category).map(optionWords));
  for (const group of new Set(Object.values(values.trackingGroups ?? {}))) if (category && !groups.has(optionWords(group))) goneNames.push(`“${group}”`);
  const items = new Set(soldItems(catalog.items ?? []).map((item) => item.code));
  for (const code of new Set(Object.values(values.itemCodes ?? {}))) if (!items.has(code)) goneNames.push(`the item “${code}”`);
  // Projects (2026-11-11): the labour needs a Xero user to log it under, one Xero still has.
  const labour = labourOf(values);
  const user = values.projectUserId ? (catalog.projectUsers ?? []).find((each) => each.userId === values.projectUserId) : undefined;
  const projects: XeroCheck[] = projectsAreOn(values)
    ? [
        {
          key: 'projects',
          label: labour ? 'A Xero user to log each visit’s labour under' : 'Projects log no labour',
          ok: !labour || Boolean(user),
          detail: !labour || user ? null : values.projectUserId ? 'That Xero user is no longer listed: choose again.' : 'Choose the Xero user the labour is logged under.',
        },
      ]
    : [];
  return [
    {
      key: 'connected',
      label: 'Xero is connected and read',
      ok: input.connected && input.readAt !== null,
      detail: input.connected ? (input.readAt ? null : 'Read from Xero first.') : 'Connect Xero first.',
    },
    { key: 'sendFrom', label: 'A start date', ok: values.sendFrom !== null, detail: values.sendFrom ? null : 'Choose the first day whose invoices go to Xero.' },
    {
      key: 'salesAccount',
      label: 'A default sales account',
      ok: values.salesAccountId !== null && sales.has(values.salesAccountId),
      detail: values.salesAccountId ? null : 'Choose where a line with no account of its own goes.',
    },
    {
      key: 'taxType',
      label: 'A tax type for lines',
      ok: values.salesTaxType !== null && taxTypes.has(values.salesTaxType),
      detail: values.salesTaxType ? null : 'Choose the tax type every line carries.',
    },
    payments
      ? {
          key: 'payments',
          label: 'An account for every payment method in use',
          ok: unmapped.length === 0,
          detail: unmapped.length ? `None yet for ${unmapped.map((method) => PAYMENT_METHOD_LABEL[method]).join(', ')}.` : null,
        }
      : { key: 'payments', label: 'Payments stay out of Xero', ok: true, detail: null },
    {
      key: 'stillInXero',
      label: 'Every chosen account is still active in Xero',
      ok: goneNames.length === 0,
      detail: goneNames.length ? `Choose again for ${goneNames.join(', ')}.` : null,
    },
    ...projects,
  ];
}

/**
 * Sending invoices to Xero (2026-11-10, phase 3 of the Xero plan): approved,
 * under each client's contact, only what changed, only while it is turned on.
 * Xero emails nobody: the console sends the office's emails.
 */
export interface XeroSendingFailure {
  invoiceId: string;
  number: string | null;
  clientName: string;
  problem: string;
  attempts: number;
  lastAttemptAt: string | null;
  /** When it is tried again on its own; null until the invoice changes or somebody presses "Try again". */
  nextAttemptAt: string | null;
}

/** A payment Xero refused, or the console held back (2026-11-10, phase 4). */
export interface XeroPaymentFailure {
  /** Null for one removed here that Xero has not deleted yet. */
  paymentId: string | null;
  invoiceId: string;
  number: string | null;
  clientName: string;
  amountCents: number | null;
  /** `YYYY-MM-DD`; null for one removed here. */
  paidOn: string | null;
  problem: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}

/** A bad debt Xero refused to write off, or take back, or the console held back (2026-11-10). */
export interface XeroWriteOffFailure {
  invoiceId: string;
  number: string | null;
  clientName: string;
  amountCents: number;
  /** Taking a write-off back, for an invoice reopened here; otherwise writing one off. */
  reversing: boolean;
  problem: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}

/** A visit's project Xero refused, or the console could not make (2026-11-11). */
export interface XeroProjectFailure {
  inspectionId: string;
  /** The project's name, as made or looked for. */
  name: string;
  problem: string;
  attempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
}

export interface XeroSendingView {
  /** The organisation sending is for: each has its own switch. */
  tenantId: string;
  enabled: boolean;
  changedAt: string | null;
  /** The connection was made with the scopes sending needs. */
  canWrite: boolean;
  /**
   * Each visit gets a project (2026-11-11): invoices go as drafts, for the
   * office to put each line on its project and approve in Xero.
   */
  projectsEnabled: boolean;
  /** Why it cannot run now, in words; empty when it can. */
  blockers: string[];
  counts: {
    /** In Xero, as the console last sent them. */
    sent: number;
    /** Refused by Xero, or held back by the console, with a reason. */
    failed: number;
    /** This organisation's, from the start date, not drafts or voided, never sent yet. */
    notYet: number;
    /** The office's invoices from the start date that belong to no company (2026-11-10): never sent anywhere. */
    noCompany: number;
    /** Payments against this organisation's invoices (2026-11-10, phase 4): in Xero, and refused or held back. */
    payments: { sent: number; failed: number };
    /** Bad debts written off in Xero, and refused or held back (2026-11-10). */
    writeOffs: { sent: number; failed: number };
    /** Visits' projects in Xero -- made here or found -- and those refused (2026-11-11). */
    projects: { done: number; failed: number };
    /** In Xero, and changed here since it went (2026-11-12): never sent again, the office's to change in Xero. */
    changedHere: number;
  };
  lastRunAt: string | null;
  lastRunProblem: string | null;
  /** The latest refusals, newest first; at most 50. */
  failures: XeroSendingFailure[];
  /** The latest payments refused or held back, newest first; at most 50. */
  paymentFailures: XeroPaymentFailure[];
  /** The latest bad debts refused or held back, newest first; at most 50. */
  writeOffFailures: XeroWriteOffFailure[];
  /** The latest visits' projects refused, newest first; at most 50 (2026-11-11). */
  projectFailures: XeroProjectFailure[];
  /** The invoices changed here since they went, newest first; at most 50 (2026-11-12). */
  changedHere: XeroChangedHere[];
}

/**
 * An invoice changed here after it went to Xero (2026-11-12). Each goes once:
 * once it is in Xero it is the office's there, and the console never
 * overwrites it -- the office makes the same change in Xero.
 */
export interface XeroChangedHere {
  invoiceId: string;
  number: string | null;
  clientName: string;
  /** Voided here: void it in Xero too. */
  voided: boolean;
  /** When it was first seen changed. */
  changedAt: string;
}

/** Why sending cannot run, in the order to fix them. */
export function xeroSendingBlockers(input: {
  connected: boolean;
  scopes: readonly string[];
  settingsReady: boolean;
  invoiceRemindersOn: boolean | null;
  /** Each visit gets a project (2026-11-11). */
  projectsEnabled?: boolean;
}): string[] {
  if (!input.connected) return ['Connect Xero.'];
  // Each organisation is sent only the invoices that go to it (2026-11-10), so several can send at once.
  const blockers: string[] = [];
  if (!xeroCanWrite(input.scopes)) blockers.push('Connect again, so Xero lets the console write contacts and invoices.');
  if (input.projectsEnabled && !xeroCanMakeProjects(input.scopes)) blockers.push('Connect again, so Xero lets the console make projects.');
  if (!input.settingsReady) blockers.push('Finish “Before anything is sent”.');
  if (input.invoiceRemindersOn === true)
    blockers.push('Turn off Xero’s own invoice reminders, then read from Xero again: the console already sends follow-ups, and clients would get both.');
  return blockers;
}

/**
 * A company's books read back from Xero (2026-11-12, PR 2 of the plan to make
 * invoices in the console with Xero as the record): its invoices and payments
 * as Xero has them, read every hour and on "Read invoices from Xero now". Kept
 * out of the invoice pages until they show Xero's books in place of Jobber's.
 */
export interface XeroBooksView {
  tenantId: string;
  /** When its invoices had first all been read; null while that first read goes on. */
  readAt: string | null;
  lastRunAt: string | null;
  lastRunProblem: string | null;
  counts: {
    /** Its invoices read from Xero, voided ones included. */
    invoices: number;
    /** Of those, on a property: through the visit, the Jobber invoice, the contact or the address. */
    placed: number;
    /** On no property yet. */
    unplaced: number;
    /** What its approved invoices still owe, as Xero says: to set beside Xero's aged receivables. */
    owedCents: number;
    /** Payments read from Xero. */
    payments: number;
    /** The console's own invoices that Xero has, kept as they are there. */
    consoleInvoices: number;
  };
  /** The latest invoices on no property, newest first; at most 50. */
  unplaced: XeroUnplacedInvoice[];
}

/** An invoice read from Xero that no visit, Jobber invoice, contact or address puts on a property. */
export interface XeroUnplacedInvoice {
  number: string | null;
  clientName: string;
  /** `YYYY-MM-DD`. */
  issuedOn: string | null;
  totalCents: number;
  /** Xero's status: DRAFT, AUTHORISED, PAID. */
  xeroStatus: string | null;
}

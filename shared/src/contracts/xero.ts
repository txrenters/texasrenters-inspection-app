import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod } from './invoices.js';

/**
 * The office's Xero organisation (2026-11-10, phase 1 of the Xero plan):
 * connected once by somebody who runs the integrations, then read -- its
 * details, its chart of accounts and its tax rates -- so the next phases can
 * map the console's products and payment methods onto it. Nothing is written
 * to Xero yet.
 */

export type XeroConnectionStatus = 'DISCONNECTED' | 'CONNECTED' | 'REAUTHORIZATION_REQUIRED';

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

export interface XeroConnectionView {
  /** Whether this server has a Xero app's credentials at all. */
  configured: boolean;
  status: XeroConnectionStatus;
  tenantName: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  /** Why it needs connecting again, in words. */
  problem: string | null;
  scopes: string[];
  organisation: XeroOrganisation | null;
  accounts: XeroAccount[];
  taxRates: XeroTaxRate[];
  readAt: string | null;
  readProblem: string | null;
  /** Calls to Xero today (Texas), and the console's own ceiling on them. */
  callsToday: number;
  dailyCeiling: number;
  /** Whether Xero's own invoice reminders are on, as last read (phase 3); null when Xero did not say. */
  invoiceRemindersOn: boolean | null;
}

/** What sending invoices needs Xero to allow (phase 3). Payments are asked for at the same time, for phase 4. */
export const XERO_WRITE_SCOPES = ['accounting.contacts', 'accounting.invoices'] as const;

/** Whether a connection may write invoices: made with the scopes phase 3 asks for. */
export const xeroCanWrite = (scopes: readonly string[]) => XERO_WRITE_SCOPES.every((scope) => scopes.includes(scope));

/** The accounts a sale is posted to: active revenue accounts with a code. */
export const revenueAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter((account) => account.status === 'ACTIVE' && account.code && (account.class === 'REVENUE' || account.type === 'REVENUE' || account.type === 'SALES'));

/** The accounts a payment can be recorded to: active, and taking payments. */
export const paymentAccounts = (accounts: readonly XeroAccount[]) =>
  accounts.filter((account) => account.status === 'ACTIVE' && account.takesPayments);

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
}

export interface XeroPaymentItem {
  method: PaymentMethod;
  accountId: string | null;
  /** Payments on the invoices that would be sent (see `XeroSettingsView.invoicesToSend`). */
  payments: number;
}

export type XeroCheckKey = 'connected' | 'sendFrom' | 'salesAccount' | 'taxType' | 'payments' | 'stillInXero';

export interface XeroCheck {
  key: XeroCheckKey;
  label: string;
  ok: boolean;
  /** What is missing, in words; null when nothing is. */
  detail: string | null;
}

export interface XeroSettingsView {
  values: XeroSettingsValues;
  products: XeroSalesItem[];
  /** Every payment method, in the console's order. */
  payments: XeroPaymentItem[];
  /** Invoices issued on or after the start date, not drafts or voided; with no start date, the past year's. */
  invoicesToSend: number;
  checks: XeroCheck[];
  /** Every check passes: phase 3 may send. */
  ready: boolean;
  updatedAt: string | null;
}

export interface SaveXeroSettingsInput extends XeroSettingsValues {
  expectedUpdatedAt: string | null;
}

/** The products list holds 200 and the billed names 50: room to spare, and a bound on the row. */
export const MAX_XERO_SALES_ACCOUNTS = 300;

const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

type XeroCatalog = { accounts: readonly XeroAccount[]; taxRates: readonly XeroTaxRate[] };

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
  const unmapped = PAYMENT_METHODS.filter((method) => (input.paymentsByMethod[method] ?? 0) > 0 && !values.paymentAccounts[method]);
  // A choice Xero no longer has, or no longer takes for that use: archived, deleted, or another organisation's.
  const gone = new Set<string>();
  for (const id of [values.salesAccountId, ...Object.values(values.salesAccounts)]) if (id && !sales.has(id)) gone.add(id);
  for (const id of Object.values(values.paymentAccounts)) if (id && !takes.has(id)) gone.add(id);
  const goneNames = [...gone].map((id) => {
    const account = byId.get(id);
    return account ? xeroAccountLabel(account) : 'an account Xero no longer lists';
  });
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
    {
      key: 'payments',
      label: 'An account for every payment method in use',
      ok: unmapped.length === 0,
      detail: unmapped.length ? `None yet for ${unmapped.map((method) => PAYMENT_METHOD_LABEL[method]).join(', ')}.` : null,
    },
    {
      key: 'stillInXero',
      label: 'Every chosen account is still active in Xero',
      ok: gone.size === 0,
      detail: gone.size ? `Choose again for ${goneNames.join(', ')}.` : null,
    },
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

export interface XeroSendingView {
  enabled: boolean;
  changedAt: string | null;
  /** The connection was made with the scopes sending needs. */
  canWrite: boolean;
  /** Why it cannot run now, in words; empty when it can. */
  blockers: string[];
  counts: {
    /** In Xero, as the console last sent them. */
    sent: number;
    /** Refused by Xero, or held back by the console, with a reason. */
    failed: number;
    /** From the start date, not drafts or voided, never sent yet. */
    notYet: number;
  };
  lastRunAt: string | null;
  lastRunProblem: string | null;
  /** The latest refusals, newest first; at most 50. */
  failures: XeroSendingFailure[];
}

/** Why sending cannot run, in the order to fix them. */
export function xeroSendingBlockers(input: {
  connected: boolean;
  scopes: readonly string[];
  settingsReady: boolean;
  invoiceRemindersOn: boolean | null;
}): string[] {
  if (!input.connected) return ['Connect Xero.'];
  const blockers: string[] = [];
  if (!xeroCanWrite(input.scopes)) blockers.push('Connect again, so Xero lets the console write contacts and invoices.');
  if (!input.settingsReady) blockers.push('Finish “Before anything is sent”.');
  if (input.invoiceRemindersOn === true)
    blockers.push('Turn off Xero’s own invoice reminders, then read from Xero again: the console already sends follow-ups, and clients would get both.');
  return blockers;
}

'use client';

import {
  DEFAULT_LABOUR_MINUTES,
  DEFAULT_LABOUR_RATE_CENTS,
  MAX_LABOUR_MINUTES,
  MAX_LABOUR_RATE_CENTS,
  PAYMENT_METHOD_LABEL,
  activeTrackingCategories,
  badDebtAccounts,
  formatMoney,
  labourOf,
  paymentAccounts,
  paymentsGoToXero,
  projectsAreOn,
  revenueAccounts,
  revenueTaxRates,
  soldItems,
  trackingGroups,
  xeroAccountLabel,
  type XeroAccount,
  type XeroCheck,
  type XeroItem,
  type XeroProjectUser,
  type XeroSettingsValues,
  type XeroSettingsView,
  type XeroTaxRate,
  type XeroTrackingCategory,
} from '@texasrenters/shared';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Panel } from '@/components/panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDay } from '@/lib/format';
import { useSaveXeroSettings } from '@/lib/xero-queries';

/** A Select cannot hold an empty value: these stand for "nothing chosen". */
const DEFAULT = '__default';
const NONE = '__none';

type Option = { value: string; label: string };

/** Key order does not matter: two sets of choices are the same when every choice is. */
const sameValues = (a: XeroSettingsValues, b: XeroSettingsValues) => {
  const sorted = (map: Record<string, string | undefined>) =>
    Object.entries(map)
      .filter(([, value]) => value)
      .sort(([x], [y]) => x.localeCompare(y));
  return (
    a.sendFrom === b.sendFrom &&
    a.salesAccountId === b.salesAccountId &&
    a.salesTaxType === b.salesTaxType &&
    JSON.stringify(sorted(a.salesAccounts)) === JSON.stringify(sorted(b.salesAccounts)) &&
    JSON.stringify(sorted(a.paymentAccounts)) === JSON.stringify(sorted(b.paymentAccounts)) &&
    (a.badDebtAccountId ?? null) === (b.badDebtAccountId ?? null) &&
    paymentsGoToXero(a) === paymentsGoToXero(b) &&
    (a.trackingCategoryId ?? null) === (b.trackingCategoryId ?? null) &&
    JSON.stringify(sorted(a.trackingGroups ?? {})) === JSON.stringify(sorted(b.trackingGroups ?? {})) &&
    JSON.stringify(sorted(a.itemCodes ?? {})) === JSON.stringify(sorted(b.itemCodes ?? {})) &&
    projectsAreOn(a) === projectsAreOn(b) &&
    (a.projectUserId ?? null) === (b.projectUserId ?? null) &&
    (a.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS) === (b.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS) &&
    (a.labourMinutes ?? DEFAULT_LABOUR_MINUTES) === (b.labourMinutes ?? DEFAULT_LABOUR_MINUTES) &&
    (a.pricesIncludeTax ?? false) === (b.pricesIncludeTax ?? false)
  );
};

/** Dollars typed, cents kept: blank or not a number reads as none; never past what the server takes. */
const centsOf = (text: string) => {
  const dollars = Number(text);
  return text.trim() === '' || !Number.isFinite(dollars) ? 0 : Math.min(Math.max(Math.round(dollars * 100), 0), MAX_LABOUR_RATE_CENTS);
};
const minutesOf = (text: string) => {
  const minutes = Number(text);
  return text.trim() === '' || !Number.isFinite(minutes) ? 0 : Math.min(Math.max(Math.round(minutes), 0), MAX_LABOUR_MINUTES);
};

/** A map with one key set to a value, or taken out for "none". */
const withKey = (map: Record<string, string> | undefined, key: string, value: string) => {
  const next = { ...(map ?? {}) };
  if (value === NONE) delete next[key];
  else next[key] = value;
  return next;
};

/**
 * What goes where in Xero (2026-11-10, phase 2 of the Xero plan): from which
 * day invoices go, the account each product or service's sales are posted to,
 * the account each payment method lands in, and the tax type on a line. The
 * contact is each invoice's client -- the property, as in Jobber. Checked
 * against the console's last read of Xero; nothing is sent to Xero yet.
 */
export function XeroSettingsForm({
  view,
  accounts,
  taxRates,
  trackingCategories = [],
  items = [],
  projectUsers = [],
  canManage,
}: {
  view: XeroSettingsView;
  accounts: readonly XeroAccount[];
  taxRates: readonly XeroTaxRate[];
  /** As last read (2026-11-11): what lines are tagged and itemed with. */
  trackingCategories?: readonly XeroTrackingCategory[];
  items?: readonly XeroItem[];
  /** As last read (2026-11-11): who a visit's labour can be logged under. */
  projectUsers?: readonly XeroProjectUser[];
  canManage: boolean;
}) {
  const id = useId();
  const save = useSaveXeroSettings(view.tenantId);
  const [values, setValues] = useState<XeroSettingsValues>(view.values);
  const dirty = !sameValues(values, view.values);
  const locked = !canManage || save.isPending;

  const byId = new Map(accounts.map((account) => [account.accountId, account]));
  // A choice Xero no longer offers still shows, named, so it can be seen and changed.
  const withChosen = (offered: readonly XeroAccount[], chosen: readonly (string | null | undefined)[]): Option[] => {
    const options = offered.map((account) => ({ value: account.accountId, label: xeroAccountLabel(account) }));
    const known = new Set(options.map((option) => option.value));
    for (const value of new Set(chosen))
      if (value && !known.has(value)) {
        const account = byId.get(value);
        options.push({ value, label: account ? `${xeroAccountLabel(account)} (not active in Xero)` : 'An account Xero no longer lists' });
      }
    return options;
  };
  const salesOptions = withChosen(revenueAccounts(accounts), [values.salesAccountId, ...Object.values(values.salesAccounts)]);
  const paymentOptions = withChosen(paymentAccounts(accounts), Object.values(values.paymentAccounts));
  // Where a bad debt is written off (2026-11-10): an expense account.
  const badDebtOptions = withChosen(badDebtAccounts(accounts), [values.badDebtAccountId ?? null]);
  const taxOptions: Option[] = revenueTaxRates(taxRates).map((rate) => ({ value: rate.taxType, label: `${rate.name} (${rate.taxType})` }));
  if (values.salesTaxType && !taxOptions.some((option) => option.value === values.salesTaxType))
    taxOptions.push({ value: values.salesTaxType, label: `${values.salesTaxType} (not active in Xero)` });
  const defaultLabel = values.salesAccountId ? (salesOptions.find((option) => option.value === values.salesAccountId)?.label ?? null) : null;
  // The tracking category lines are tagged in for the visit's technician, and the Xero items they name (2026-11-11).
  const categories = activeTrackingCategories(trackingCategories);
  const categoryOptions: Option[] = categories.map((category) => ({ value: category.trackingCategoryId, label: category.name }));
  if (values.trackingCategoryId && !categoryOptions.some((option) => option.value === values.trackingCategoryId))
    categoryOptions.push({ value: values.trackingCategoryId, label: 'A category Xero no longer lists' });
  const category = categories.find((each) => each.trackingCategoryId === values.trackingCategoryId) ?? null;
  const groupOptions = trackingGroups(category);
  const itemOptions = soldItems(items).map((item) => item.code);
  for (const code of new Set(Object.values(values.itemCodes ?? {}))) if (!itemOptions.includes(code)) itemOptions.push(code);
  const payments = paymentsGoToXero(values);
  // A project for each visit (2026-11-11): its invoices go as drafts, so payments stay out of Xero while it is on.
  const projects = projectsAreOn(values);
  const labour = labourOf(values);
  const userOptions: Option[] = projectUsers.map((user) => ({ value: user.userId, label: user.name }));
  if (values.projectUserId && !userOptions.some((option) => option.value === values.projectUserId))
    userOptions.push({ value: values.projectUserId, label: 'A user Xero no longer lists' });
  const [rateText, setRateText] = useState(((values.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS) / 100).toFixed(2));
  const [minutesText, setMinutesText] = useState(String(values.labourMinutes ?? DEFAULT_LABOUR_MINUTES));

  const setSalesAccount = (nameKey: string, value: string) =>
    setValues((current) => {
      const salesAccounts = { ...current.salesAccounts };
      if (value === DEFAULT) delete salesAccounts[nameKey];
      else salesAccounts[nameKey] = value;
      return { ...current, salesAccounts };
    });
  const setPaymentAccount = (method: keyof XeroSettingsValues['paymentAccounts'], value: string) =>
    setValues((current) => {
      const paymentAccounts = { ...current.paymentAccounts };
      if (value === NONE) delete paymentAccounts[method];
      else paymentAccounts[method] = value;
      return { ...current, paymentAccounts };
    });

  const submit = () =>
    save.mutate(
      { ...values, expectedUpdatedAt: view.updatedAt },
      {
        onSuccess: () => toast.success('Saved'),
        onError: (error) => toast.error('Not saved', { description: error.message }),
      },
    );

  const span = view.values.sendFrom ? `issued since ${formatDay(view.values.sendFrom, 'long')}` : 'issued in the past year';

  return (
    <>
      <Panel bodyClassName="p-4" title="Before anything is sent">
        <ul className="space-y-2 text-sm">
          {view.checks.map((check) => (
            <CheckRow check={check} key={check.key} />
          ))}
        </ul>
        <p className="text-muted-foreground mt-3 text-sm">
          {view.invoicesToSend === 1 ? '1 invoice' : `${view.invoicesToSend.toLocaleString('en-US')} invoices`} {span}.{' '}
          {dirty ? 'Save to check your changes.' : 'Checked as saved.'}
        </p>
      </Panel>

      <Panel bodyClassName="p-4" title="Sending">
        <div className="grid gap-4 md:grid-cols-3">
          <Field>
            <FieldLabel htmlFor={`${id}-from`}>Start date</FieldLabel>
            <Input
              disabled={locked}
              id={`${id}-from`}
              onChange={(event) => setValues((current) => ({ ...current, sendFrom: event.target.value || null }))}
              type="date"
              value={values.sendFrom ?? ''}
            />
            <FieldDescription>
              {view.madeInConsole
                ? 'Invoices made in the console on or after it go to Xero, whatever day each is dated; one made before it never does.'
                : 'Invoices issued on or after it go to Xero. One Xero already has under the same number, made through Zapier or by hand, is linked rather than made twice. Turn the Zap off before sending is turned on.'}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-sales`}>Default sales account</FieldLabel>
            <Select
              disabled={locked}
              onValueChange={(value) => setValues((current) => ({ ...current, salesAccountId: value === NONE ? null : value }))}
              value={values.salesAccountId ?? NONE}
            >
              <SelectTrigger className="w-full" id={`${id}-sales`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not chosen</SelectItem>
                {salesOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Where a line goes when its product or service has no account of its own.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-tax`}>Tax type on lines</FieldLabel>
            <Select
              disabled={locked}
              onValueChange={(value) => setValues((current) => ({ ...current, salesTaxType: value === NONE ? null : value }))}
              value={values.salesTaxType ?? NONE}
            >
              <SelectTrigger className="w-full" id={`${id}-tax`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not chosen</SelectItem>
                {taxOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Every line carries it. With no sales tax on the invoices, that is the exempt one.</FieldDescription>
          </Field>
          {/* Prices that include the tax (2026-11-12): Crystal Creek Pest's $39.00 is $36.03 and $2.97 of tax. */}
          <div className="flex items-start gap-3 md:col-span-2">
            <Switch
              checked={values.pricesIncludeTax === true}
              disabled={locked}
              id={`${id}-inclusive`}
              onCheckedChange={(checked) => setValues((current) => ({ ...current, pricesIncludeTax: checked }))}
            />
            <div className="grid gap-0.5">
              <label className="text-sm font-medium" htmlFor={`${id}-inclusive`}>
                Prices include sales tax
              </label>
              <p className="text-muted-foreground text-sm">
                {values.pricesIncludeTax
                  ? 'Each line’s price already has the tax in it: Xero takes it out at the tax type above, and its total is the invoice’s.'
                  : 'Tax at the tax type above is added on top of each line’s price.'}
              </p>
            </div>
          </div>
        </div>
        <p className="text-muted-foreground mt-4 text-sm">
          Each invoice goes to Xero under its client, which is the property, with the property as its reference. It is dated on the day of
          its visit and falls due on the last day of that month.
        </p>
      </Panel>

      <Panel bodyClassName="p-4" title="Tracking">
        <div className="grid gap-2 sm:max-w-md">
          <Field>
            <FieldLabel htmlFor={`${id}-tracking`}>Tag lines in</FieldLabel>
            <Select
              disabled={locked}
              onValueChange={(value) =>
                // Another category, or none: what each product was tracked as no longer fits.
                setValues((current) => ({ ...current, trackingCategoryId: value === NONE ? null : value, trackingGroups: {} }))
              }
              value={values.trackingCategoryId ?? NONE}
            >
              <SelectTrigger className="w-full" id={`${id}-tracking`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No tracking</SelectItem>
                {categoryOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Each line is tagged with the option for the technician who did the visit, by first name: “Air Filter Income: Amy” for a filter
              change Amy did. Choose what each product or service is tracked as under Where sales go.
            </FieldDescription>
          </Field>
        </div>
      </Panel>

      <Panel title="Projects">
        <div className="flex items-start gap-3 border-b px-4 py-3">
          <Switch
            checked={projects}
            disabled={locked}
            id={`${id}-projects`}
            onCheckedChange={(checked) =>
              // On, payments stay out: Xero takes none on a draft.
              setValues((current) => ({ ...current, projectsEnabled: checked, ...(checked ? { paymentsToXero: false } : {}) }))
            }
          />
          <div className="grid gap-0.5">
            <label className="text-sm font-medium" htmlFor={`${id}-projects`}>
              Make a Xero project for each visit
            </label>
            <p className="text-muted-foreground text-sm">
              {projects
                ? 'Each visit gets a project under its property, named as the office names them (“Moses: Tenant Benefit Package - 4th Qtr - 2026 - 11.10.2026”) and due on the visit’s day, with the labour below on it. Xero cannot be told which project an invoice line is on, so invoices go as drafts: in Xero, put each line on its project, then approve it.'
                : view.madeInConsole
                  ? 'No projects are made. Invoices still go as drafts, for the office to approve in Xero.'
                  : 'No projects are made, and invoices go to Xero approved.'}
            </p>
          </div>
        </div>
        {projects ? (
          <div className="grid gap-4 p-4 md:grid-cols-3">
            <Field>
              <FieldLabel htmlFor={`${id}-project-user`}>Labour logged as</FieldLabel>
              <Select
                disabled={locked}
                onValueChange={(value) => setValues((current) => ({ ...current, projectUserId: value === NONE ? null : value }))}
                value={values.projectUserId ?? NONE}
              >
                <SelectTrigger className="w-full" id={`${id}-project-user`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not chosen</SelectItem>
                  {userOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {projectUsers.length
                  ? 'The Xero user the time is logged under.'
                  : 'Connect again so Xero lets the console make projects, then read from Xero to list who can log time.'}
              </FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-labour-rate`}>Rate an hour ($)</FieldLabel>
              <Input
                disabled={locked}
                id={`${id}-labour-rate`}
                inputMode="decimal"
                min={0}
                onChange={(event) => {
                  setRateText(event.target.value);
                  setValues((current) => ({ ...current, labourRateCents: centsOf(event.target.value) }));
                }}
                step="0.01"
                type="number"
                value={rateText}
              />
              <FieldDescription>An “Hourly Labor Charge” task on each project the console makes.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-labour-minutes`}>Minutes a visit</FieldLabel>
              <Input
                disabled={locked}
                id={`${id}-labour-minutes`}
                inputMode="numeric"
                min={0}
                onChange={(event) => {
                  setMinutesText(event.target.value);
                  setValues((current) => ({ ...current, labourMinutes: minutesOf(event.target.value) }));
                }}
                step="1"
                type="number"
                value={minutesText}
              />
              <FieldDescription>
                {labour ? `Logged on the visit’s day: ${formatMoney(Math.round((labour.rateCents * labour.minutes) / 60))} a visit.` : 'No labour is logged.'}{' '}
                A project the office made by hand under the same name is used as it is, with no labour added.
              </FieldDescription>
            </Field>
          </div>
        ) : null}
      </Panel>

      <Panel count={view.products.length} title="Where sales go">
        {view.products.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product or service</TableHead>
                <TableHead className="w-[32%]">Account</TableHead>
                <TableHead className="w-[18%]">Xero item</TableHead>
                {category ? <TableHead className="w-[24%]">Tracked as</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.products.map((item) => (
                <TableRow key={item.nameKey}>
                  <TableCell>
                    <span>{item.name}</span>
                    {!item.listed ? (
                      <Badge className="ml-2" variant="outline">
                        {item.active ? 'billed, not on the list' : 'not billed lately'}
                      </Badge>
                    ) : !item.active ? (
                      <Badge className="ml-2" variant="outline">
                        set aside
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Select
                      disabled={locked}
                      onValueChange={(value) => setSalesAccount(item.nameKey, value)}
                      value={values.salesAccounts[item.nameKey] ?? DEFAULT}
                    >
                      <SelectTrigger aria-label={`Account for ${item.name}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT}>{defaultLabel ? `The default (${defaultLabel})` : 'The default'}</SelectItem>
                        {salesOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      disabled={locked}
                      onValueChange={(value) => setValues((current) => ({ ...current, itemCodes: withKey(current.itemCodes, item.nameKey, value) }))}
                      value={values.itemCodes?.[item.nameKey] ?? NONE}
                    >
                      <SelectTrigger aria-label={`Xero item for ${item.name}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>None</SelectItem>
                        {itemOptions.map((code) => (
                          <SelectItem key={code} value={code}>
                            {code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  {category ? (
                    <TableCell>
                      <Select
                        disabled={locked}
                        onValueChange={(value) =>
                          setValues((current) => ({ ...current, trackingGroups: withKey(current.trackingGroups, item.nameKey, value) }))
                        }
                        value={values.trackingGroups?.[item.nameKey] ?? NONE}
                      >
                        <SelectTrigger aria-label={`Tracked as for ${item.name}`} className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Not tracked</SelectItem>
                          {[...new Set([...groupOptions, ...(values.trackingGroups?.[item.nameKey] ? [values.trackingGroups[item.nameKey]!] : [])])].map(
                            (group) => (
                              <SelectItem key={group} value={group}>
                                {group}
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-muted-foreground px-4 py-3 text-sm">
            No product or service goes to this organisation yet. Choose each one&apos;s organisation on{' '}
            <Link className="underline underline-offset-2" href="/invoices/settings">
              Invoices → Settings
            </Link>
            .
          </p>
        )}
        {view.withoutOrganisation ? (
          <p className="text-muted-foreground border-t px-4 py-3 text-sm">
            {view.withoutOrganisation === 1 ? '1 product or service goes' : `${view.withoutOrganisation} products and services go`} to no
            organisation yet. Choose on{' '}
            <Link className="underline underline-offset-2" href="/invoices/settings">
              Invoices → Settings
            </Link>
            .
          </p>
        ) : null}
      </Panel>

      {/* Its books read back from Xero (2026-11-13): payments and bad debts are the office's to record there, and are read back. */}
      {view.booksRead ? (
        <Panel bodyClassName="p-4" title="Payments and bad debts">
          <p className="text-muted-foreground text-sm">
            Recorded in Xero. This company&apos;s books are read back from there every hour, its payments and credit notes with them, so
            nothing here sends them and no account is asked for.
          </p>
        </Panel>
      ) : (
        <>
      <Panel title="Where payments land">
        <div className="flex items-start gap-3 border-b px-4 py-3">
          <Switch
            checked={payments}
            disabled={locked || projects}
            id={`${id}-payments`}
            onCheckedChange={(checked) => setValues((current) => ({ ...current, paymentsToXero: checked }))}
          />
          <div className="grid gap-0.5">
            <label className="text-sm font-medium" htmlFor={`${id}-payments`}>
              Send payments to Xero
            </label>
            <p className="text-muted-foreground text-sm">
              {projects
                ? 'Payments stay out of Xero while each visit gets a project: its invoices go as drafts, and Xero takes no payment on a draft.'
                : payments
                  ? 'Each payment recorded here goes to the account chosen for how it was paid.'
                  : 'Payments stay out of Xero: the office records them there itself, and no account is needed for them.'}
            </p>
          </div>
        </div>
        {payments ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>How it was paid</TableHead>
                <TableHead className="text-right">Payments</TableHead>
                <TableHead className="w-[45%]">Account</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.payments.map((item) => (
                <TableRow key={item.method}>
                  <TableCell>{PAYMENT_METHOD_LABEL[item.method]}</TableCell>
                  <TableCell className="text-muted-foreground text-right tabular-nums">{item.payments.toLocaleString('en-US')}</TableCell>
                  <TableCell>
                    <Select
                      disabled={locked}
                      onValueChange={(value) => setPaymentAccount(item.method, value)}
                      value={values.paymentAccounts[item.method] ?? NONE}
                    >
                      <SelectTrigger aria-label={`Account for ${PAYMENT_METHOD_LABEL[item.method]}`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not chosen</SelectItem>
                        {paymentOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </Panel>

      <Panel title="Bad debts">
        <div className="grid gap-2 p-4 sm:max-w-md">
          <Field>
            <FieldLabel htmlFor={`${id}-bad-debts`}>Written off to</FieldLabel>
            <Select
              disabled={locked}
              onValueChange={(value) => setValues((current) => ({ ...current, badDebtAccountId: value === NONE ? null : value }))}
              value={values.badDebtAccountId ?? NONE}
            >
              <SelectTrigger className="w-full" id={`${id}-bad-debts`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not chosen</SelectItem>
                {badDebtOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              An invoice closed as bad debt is written off in Xero with a credit note to this expense account, for what it still owed. Reopening it
              takes the credit note back.
            </FieldDescription>
          </Field>
        </div>
      </Panel>
        </>
      )}

      {canManage ? (
        // Kept in view only while there is something to save; otherwise it would sit over the fields for nothing.
        <div className={`flex items-center justify-end gap-3 py-3 ${dirty ? 'bg-background sticky bottom-0 z-10 border-t' : ''}`}>
          {dirty ? <span className="text-muted-foreground text-sm">Not saved yet</span> : null}
          {dirty ? (
            <Button
              disabled={save.isPending}
              onClick={() => {
                setValues(view.values);
                setRateText(((view.values.labourRateCents ?? DEFAULT_LABOUR_RATE_CENTS) / 100).toFixed(2));
                setMinutesText(String(view.values.labourMinutes ?? DEFAULT_LABOUR_MINUTES));
              }}
              variant="outline"
            >
              Undo changes
            </Button>
          ) : null}
          <Button disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      ) : null}
    </>
  );
}

function CheckRow({ check }: { check: XeroCheck }) {
  const Icon = check.ok ? CircleCheckIcon : CircleAlertIcon;
  return (
    <li className="flex items-start gap-2">
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${check.ok ? 'text-success' : 'text-warning'}`} />
      <span>
        <span className={check.ok ? undefined : 'font-semibold'}>{check.label}</span>
        <span className="sr-only">{check.ok ? ' (done)' : ' (not yet)'}</span>
        {check.detail ? <span className="text-muted-foreground block text-xs">{check.detail}</span> : null}
      </span>
    </li>
  );
}

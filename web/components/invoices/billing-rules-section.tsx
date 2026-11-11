'use client';

import {
  InspectionType,
  REPORTABLE_VISIT_SERVICES,
  VISIT_SERVICE_LABEL,
  billingRuleProblem,
  billingRuleWhen,
  formatMoney,
  inspectionWords,
  type InvoiceSettingsView,
  type NewBillingRule,
  type ReportableVisitService,
} from '@texasrenters/shared';
import { useId, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useInvoiceSettingsEdits } from '@/lib/invoice-settings-queries';

/** "Any visit" and "whatever was done": a Select item cannot have an empty value. */
const ANY = 'any';

/**
 * What a finished visit bills (2026-11-12, PR 1 of making invoices in the
 * console): the office's rules, and the ones its past six months of invoices
 * suggest, for it to confirm. Each rule bills one product on the list, at its
 * price, to the company it goes to. A visit no rule covers is not invoiced in
 * a batch: it is listed with the reason. Database reads and writes only.
 */
export function BillingRulesSection({ view, mayChange }: { view: InvoiceSettingsView; mayChange: boolean }) {
  const id = useId();
  const edits = useInvoiceSettingsEdits();
  const [type, setType] = useState<string>(ANY);
  const [service, setService] = useState<string>(ANY);
  const [productId, setProductId] = useState<string>('');

  const product = (wanted: string) => view.products.find((each) => each.id === wanted);
  const company = (tenantId: string | null) => (tenantId ? (view.organisations.find((each) => each.tenantId === tenantId)?.name ?? 'Unknown') : null);
  const offered = view.products.filter((each) => each.active);
  const busy = edits.addBillingRules.isPending || edits.removeBillingRule.isPending;
  const rule: NewBillingRule = {
    inspectionType: type === ANY ? null : (type as InspectionType),
    service: service === ANY ? null : (service as ReportableVisitService),
    productId,
  };
  const problem = type === ANY && service === ANY ? billingRuleProblem(rule) : null;

  const add = (rules: NewBillingRule[], done: string, after?: () => void) =>
    edits.addBillingRules.mutate(
      { rules },
      {
        onSuccess: () => {
          toast.success(done);
          after?.();
        },
        onError: (error) => toast.error('No rule was added', { description: error.message }),
      },
    );
  const remove = (ruleId: string) =>
    edits.removeBillingRule.mutate(ruleId, {
      onSuccess: () => toast.success('Rule removed'),
      onError: (error) => toast.error('The rule was not removed', { description: error.message }),
    });

  const bills = (wanted: string) => {
    const billed = product(wanted);
    if (!billed) return { name: 'A product no longer on the list', price: '—', company: null, aside: true };
    return { name: billed.name, price: formatMoney(billed.unitPriceCents), company: company(billed.xeroTenantId), aside: !billed.active };
  };

  return (
    <section aria-label="What a visit bills" className="bg-card mt-6 rounded-lg border p-4">
      <h2 className="text-heading text-lg font-bold">What a visit bills</h2>
      <p className="text-muted-foreground mt-1 text-sm">
        A finished visit bills each product its rules name, at the price on the list, to the company that product goes to. A visit no rule covers is not invoiced
        with the others: it is listed with the reason.
      </p>

      {view.suggestedRules.length ? (
        <div aria-label="Suggested rules" className="mt-3 rounded-md border border-dashed p-3" role="group">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-heading text-base font-bold">Suggested from the past six months of invoices</h3>
            {mayChange ? (
              <Button
                disabled={busy}
                onClick={() =>
                  add(
                    view.suggestedRules.map((each) => ({ inspectionType: each.inspectionType, service: null, productId: each.productId })),
                    view.suggestedRules.length === 1 ? 'Rule confirmed' : `${view.suggestedRules.length} rules confirmed`,
                  )
                }
                size="sm"
              >
                Confirm {view.suggestedRules.length === 1 ? 'the rule' : `${view.suggestedRules.length} rules`}
              </Button>
            ) : null}
          </div>
          <ul className="mt-2 divide-y text-sm">
            {view.suggestedRules.map((each) => {
              const billed = bills(each.productId);
              return (
                <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2" key={`${each.inspectionType}-${each.productId}`}>
                  <span>
                    {billingRuleWhen({ inspectionType: each.inspectionType, service: null })} → <span className="font-medium">{billed.name}</span>{' '}
                    <span className="tabular-nums">{billed.price}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    Billed on {each.seen.toLocaleString('en-US')} of {each.of.toLocaleString('en-US')} visits
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {view.billingRules.length ? (
        <Table aria-label="Rules" className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead>Visits</TableHead>
              <TableHead>Bill</TableHead>
              <TableHead className="text-right">Price</TableHead>
              {view.organisations.length ? <TableHead>Xero organisation</TableHead> : null}
              {mayChange ? <TableHead className="w-0" /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.billingRules.map((each) => {
              const billed = bills(each.productId);
              return (
                <TableRow key={each.id}>
                  <TableCell>{billingRuleWhen(each)}</TableCell>
                  <TableCell className="font-medium">
                    {billed.name}
                    {billed.aside ? <span className="text-warning block text-xs font-normal">Set aside: it bills nothing until offered again.</span> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{billed.price}</TableCell>
                  {view.organisations.length ? (
                    <TableCell className={billed.company ? undefined : 'text-muted-foreground'}>{billed.company ?? 'Not chosen'}</TableCell>
                  ) : null}
                  {mayChange ? (
                    <TableCell className="text-right">
                      <Button aria-label={`Remove the rule: ${billingRuleWhen(each)} bill ${billed.name}`} disabled={busy} onClick={() => remove(each.id)} size="sm" variant="ghost">
                        Remove
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <p className="text-muted-foreground mt-3 text-sm">No rules yet: a finished visit bills nothing until one covers it.</p>
      )}

      {mayChange ? (
        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_1fr_1.5fr_auto] md:items-end">
          <Field>
            <FieldLabel htmlFor={`${id}-type`}>Visit type</FieldLabel>
            <Select onValueChange={setType} value={type}>
              <SelectTrigger className="w-full" id={`${id}-type`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any visit</SelectItem>
                {Object.values(InspectionType).map((each) => (
                  <SelectItem key={each} value={each}>
                    {inspectionWords(each)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-service`}>Service done</FieldLabel>
            <Select onValueChange={setService} value={service}>
              <SelectTrigger className="w-full" id={`${id}-service`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Whatever was done</SelectItem>
                {REPORTABLE_VISIT_SERVICES.map((each) => (
                  <SelectItem key={each} value={each}>
                    {VISIT_SERVICE_LABEL[each]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-product`}>Bills</FieldLabel>
            <Select disabled={!offered.length} onValueChange={setProductId} value={productId}>
              <SelectTrigger className="w-full" id={`${id}-product`}>
                <SelectValue placeholder={offered.length ? 'A product on the list' : 'Add a product to the list first'} />
              </SelectTrigger>
              <SelectContent>
                {offered.map((each) => (
                  <SelectItem key={each.id} value={each.id}>
                    {each.name} · {formatMoney(each.unitPriceCents)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Button
            disabled={!productId || Boolean(problem) || busy}
            onClick={() =>
              add([rule], 'Rule added', () => {
                setType(ANY);
                setService(ANY);
                setProductId('');
              })
            }
          >
            Add rule
          </Button>
          {problem ? (
            <FieldDescription aria-live="polite" className="text-destructive md:col-span-4">
              {problem}
            </FieldDescription>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

'use client';

import {
  MOST_REQUISITION_LINES,
  MOST_REQUISITION_QUOTES,
  formatMoney,
  parseMoney,
  requisitionSubmitProblem,
  requisitionTotalCents,
  stockStatus,
  type RequisitionChoices,
  type RequisitionDetail,
  type SaveRequisitionInput,
} from '@texasrenters/shared';
import { useState } from 'react';

import { approverFor } from '@/components/purchasing/requisition-parts';
import { AsideCard, FactTable } from '@/components/record/record-kit';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { formatCount } from '@/lib/format';

/**
 * The purchase requisition as its author fills it in (2026-11-19, phase 2):
 * who it is for, why, what is asked for with what is on hand beside it, and
 * the quotes. Saved whole -- a save replaces its lines and quotes -- as a
 * draft, or saved and handed to the approvers in one press.
 *
 * It only prepares the request. What may be submitted, and who may approve
 * it, the server decides again.
 */

const NONE = 'none';
const chosen = (value: string) => (value === NONE ? null : value);
const whole = (value: string) => (/^\d+$/.test(value.trim()) && Number(value) > 0 ? Number(value.trim()) : null);
const money = (value: string) => (value.trim() ? parseMoney(value) : null);
const dollars = (cents: number) => (cents / 100).toFixed(2);

interface LineDraft {
  key: string;
  /** An item's id; NONE while none is picked; null for something not on the list. */
  itemId: string | null;
  description: string;
  quantity: string;
  cost: string;
}
interface QuoteDraft {
  key: string;
  vendorId: string;
  total: string;
  delivery: string;
  chosen: boolean;
}

let made = 0;
const key = () => `row-${(made += 1)}`;

export function RequisitionForm({
  choices,
  requisition,
  onSave,
  pending,
  error,
  onDiscard,
  discardLabel,
}: {
  choices: RequisitionChoices;
  /** The requisition being changed; none for a new one. */
  requisition?: RequisitionDetail;
  /** Saves it, and submits it when asked. Resolves once done; a refusal is shown from `error`. */
  onSave: (input: SaveRequisitionInput, submit: boolean) => Promise<unknown>;
  pending: boolean;
  error: Error | null;
  onDiscard: () => void;
  discardLabel: string;
}) {
  const [company, setCompany] = useState(requisition?.company?.tenantId ?? (requisition ? NONE : (choices.companies[0]?.tenantId ?? NONE)));
  const [neededBy, setNeededBy] = useState(requisition?.neededBy ?? '');
  const [place, setPlace] = useState(requisition?.deliverTo?.id ?? (requisition ? NONE : (choices.places[0]?.id ?? NONE)));
  const [reason, setReason] = useState(requisition?.reason ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    () => requisition?.lines.map((line) => ({ key: key(), itemId: line.item?.id ?? null, description: line.description ?? '', quantity: String(line.quantity), cost: dollars(line.estimatedUnitCostCents) })) ?? [],
  );
  const [quotes, setQuotes] = useState<QuoteDraft[]>(
    () => requisition?.quotes.map((quote) => ({ key: key(), vendorId: quote.vendor.id, total: dollars(quote.totalCents), delivery: quote.delivery ?? '', chosen: quote.chosen })) ?? [],
  );

  const companyId = chosen(company);
  const offered = choices.items.filter((item) => item.companyTenantId === companyId);
  const itemOf = new Map(choices.items.map((item) => [item.id, item]));
  const used = new Set(lines.flatMap((line) => (line.itemId && line.itemId !== NONE ? [line.itemId] : [])));
  const setLine = (lineKey: string, change: Partial<LineDraft>) => setLines((rows) => rows.map((row) => (row.key === lineKey ? { ...row, ...change } : row)));
  const setQuote = (quoteKey: string, change: Partial<QuoteDraft>) => setQuotes((rows) => rows.map((row) => (row.key === quoteKey ? { ...row, ...change } : row)));

  /** A line for an item starts from what the office usually orders, at what one last cost on average. */
  const lineFor = (itemId: string): LineDraft => {
    const item = itemOf.get(itemId);
    return { key: key(), itemId, description: '', quantity: item?.reorderQuantity ? String(item.reorderQuantity) : '', cost: item?.averageCostCents != null ? dollars(item.averageCostCents) : '' };
  };
  const low = offered.filter((item) => !used.has(item.id) && stockStatus(item.onHand, item.reorderLevel) !== 'ENOUGH');

  function changeCompany(next: string) {
    setCompany(next);
    // Its items are its own company's: lines for another company's items would be refused.
    setLines((rows) => rows.filter((row) => row.itemId === null || row.itemId === NONE || itemOf.get(row.itemId)?.companyTenantId === chosen(next)));
  }

  // What the form holds, as the request; null while any row is unfinished.
  const parsedLines = lines.map((line) => {
    const quantity = whole(line.quantity);
    const cost = money(line.cost);
    const named = line.itemId === null ? line.description.trim().length > 0 : line.itemId !== NONE;
    return named && quantity !== null && cost !== null && cost >= 0
      ? { itemId: line.itemId, description: line.itemId === null ? line.description.trim() : null, quantity, estimatedUnitCostCents: cost }
      : null;
  });
  const parsedQuotes = quotes.map((quote) => {
    const total = money(quote.total);
    return quote.vendorId !== NONE && total !== null && total >= 0 ? { vendorId: quote.vendorId, totalCents: total, delivery: quote.delivery.trim() || null, chosen: quote.chosen } : null;
  });
  const complete = parsedLines.every(Boolean) && parsedQuotes.every(Boolean);
  const input: SaveRequisitionInput = {
    xeroTenantId: companyId,
    neededBy: neededBy || null,
    deliverToPlaceId: chosen(place),
    reason: reason.trim(),
    lines: parsedLines.flatMap((line) => (line ? [line] : [])),
    quotes: parsedQuotes.flatMap((quote) => (quote ? [quote] : [])),
  };
  const totalCents = requisitionTotalCents(input.lines);
  const problem = complete ? requisitionSubmitProblem(input, choices.settings) : 'Finish or remove the rows that are not filled in.';
  const overLimit = totalCents > choices.settings.approvalLimitCents;

  const save = (submit: boolean) => {
    if (pending || !complete || (submit && problem)) return;
    void onSave(input, submit).catch(() => undefined);
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="grid min-w-0 gap-6">
        <section className="bg-card grid gap-4 rounded-lg border p-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="requisition-company">Company it is for</FieldLabel>
              <Select onValueChange={changeCompany} value={company}>
                <SelectTrigger className="w-full" id="requisition-company">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>No company</SelectItem>
                  {choices.companies.map((option) => (
                    <SelectItem key={option.tenantId} value={option.tenantId}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="requisition-needed">Needed by</FieldLabel>
              <Input id="requisition-needed" onChange={(event) => setNeededBy(event.target.value)} type="date" value={neededBy} />
            </Field>
            <Field>
              <FieldLabel htmlFor="requisition-place">Deliver to</FieldLabel>
              <Select onValueChange={setPlace} value={place}>
                <SelectTrigger className="w-full" id="requisition-place">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Not decided</SelectItem>
                  {choices.places.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="requisition-reason">Why it is needed</FieldLabel>
            <Textarea id="requisition-reason" maxLength={2000} onChange={(event) => setReason(event.target.value)} rows={2} value={reason} />
          </Field>
        </section>

        <section className="grid gap-3">
          <h2 className="text-heading text-base font-bold">What you are asking for</h2>
          {lines.length ? (
            <div className="bg-card overflow-clip rounded-xl border">
              <Table aria-label="What is asked for">
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">On hand</TableHead>
                    <TableHead className="text-right">Reorder at</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Est. each</TableHead>
                    <TableHead className="text-right">Est. total</TableHead>
                    <TableHead>
                      <span className="sr-only">Remove</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line, index) => {
                    const item = line.itemId && line.itemId !== NONE ? itemOf.get(line.itemId) : undefined;
                    const parsed = parsedLines[index];
                    const name = item?.name ?? (line.description.trim() || `line ${index + 1}`);
                    return (
                      <TableRow key={line.key}>
                        <TableCell className="min-w-56">
                          {line.itemId === null ? (
                            <Input
                              aria-label={`What is asked for on line ${index + 1}`}
                              maxLength={200}
                              onChange={(event) => setLine(line.key, { description: event.target.value })}
                              placeholder="What it is, and which model"
                              value={line.description}
                            />
                          ) : (
                            <Select onValueChange={(itemId) => setLine(line.key, { ...lineFor(itemId), key: line.key })} value={line.itemId}>
                              <SelectTrigger aria-label={`Item on line ${index + 1}`} className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value={NONE}>Choose an item</SelectItem>
                                {offered
                                  .filter((option) => option.id === line.itemId || !used.has(option.id))
                                  .map((option) => (
                                    <SelectItem key={option.id} value={option.id}>
                                      {option.code} · {option.name}
                                    </SelectItem>
                                  ))}
                              </SelectContent>
                            </Select>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {item ? <StockFigure onHand={item.onHand} reorderLevel={item.reorderLevel} /> : ''}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{item?.reorderLevel ? formatCount(item.reorderLevel) : ''}</TableCell>
                        <TableCell className="text-right">
                          <Input
                            aria-label={`Quantity of ${name}`}
                            className="ml-auto w-20 text-right"
                            inputMode="numeric"
                            onChange={(event) => setLine(line.key, { quantity: event.target.value })}
                            value={line.quantity}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <Input
                            aria-label={`Estimated cost of one ${name}`}
                            className="ml-auto w-24 text-right"
                            inputMode="decimal"
                            onChange={(event) => setLine(line.key, { cost: event.target.value })}
                            placeholder="0.00"
                            value={line.cost}
                          />
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{parsed ? formatMoney(parsed.quantity * parsed.estimatedUnitCostCents) : ''}</TableCell>
                        <TableCell className="text-right">
                          <Button aria-label={`Remove ${name}`} onClick={() => setLines((rows) => rows.filter((row) => row.key !== line.key))} size="sm" type="button" variant="outline">
                            Remove
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow>
                    <TableCell className="text-right font-semibold" colSpan={5}>
                      Estimated total
                    </TableCell>
                    <TableCell className="text-right font-mono font-semibold tabular-nums">{formatMoney(totalCents)}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">Nothing yet. Add what is needed below.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={lines.length >= MOST_REQUISITION_LINES || offered.every((item) => used.has(item.id))}
              onClick={() => setLines((rows) => [...rows, { key: key(), itemId: NONE, description: '', quantity: '', cost: '' }])}
              type="button"
              variant="outline"
            >
              Add an item
            </Button>
            <Button
              disabled={lines.length >= MOST_REQUISITION_LINES}
              onClick={() => setLines((rows) => [...rows, { key: key(), itemId: null, description: '', quantity: '1', cost: '' }])}
              type="button"
              variant="outline"
            >
              Ask for something not in the list
            </Button>
            <Button disabled={!low.length} onClick={() => setLines((rows) => [...rows, ...low.map((item) => lineFor(item.id))].slice(0, MOST_REQUISITION_LINES))} type="button" variant="outline">
              Add everything that is low
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            The cost starts from what one cost on average and can be changed. Only the chosen company&apos;s items are offered.
          </p>
        </section>

        <section className="bg-card grid gap-3 rounded-lg border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-heading text-base font-bold">Quotes</h2>
            <p className="text-muted-foreground text-xs">
              Optional up to {formatMoney(choices.settings.approvalLimitCents)}. Above it, {choices.settings.quotesAboveLimit} are needed.
            </p>
          </div>
          {quotes.map((quote, index) => (
            <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto]" key={quote.key}>
              <Field>
                <FieldLabel htmlFor={`${quote.key}-vendor`}>Vendor</FieldLabel>
                <Select onValueChange={(vendorId) => setQuote(quote.key, { vendorId })} value={quote.vendorId}>
                  <SelectTrigger className="w-full" id={`${quote.key}-vendor`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Choose a vendor</SelectItem>
                    {choices.vendors.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${quote.key}-total`}>Total</FieldLabel>
                <Input id={`${quote.key}-total`} inputMode="decimal" onChange={(event) => setQuote(quote.key, { total: event.target.value })} placeholder="0.00" value={quote.total} />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${quote.key}-delivery`}>Delivery</FieldLabel>
                <Input id={`${quote.key}-delivery`} maxLength={80} onChange={(event) => setQuote(quote.key, { delivery: event.target.value })} placeholder="3 days" value={quote.delivery} />
              </Field>
              {quote.chosen ? (
                <Badge className="mb-2" variant="success">
                  Chosen
                </Badge>
              ) : (
                <Button aria-label={`Choose quote ${index + 1}`} onClick={() => setQuotes((rows) => rows.map((row) => ({ ...row, chosen: row.key === quote.key })))} type="button" variant="outline">
                  Choose
                </Button>
              )}
              <Button aria-label={`Remove quote ${index + 1}`} onClick={() => setQuotes((rows) => rows.filter((row) => row.key !== quote.key))} type="button" variant="outline">
                Remove
              </Button>
            </div>
          ))}
          {choices.vendors.length ? (
            <Button
              className="justify-self-start"
              disabled={quotes.length >= MOST_REQUISITION_QUOTES}
              onClick={() => setQuotes((rows) => [...rows, { key: key(), vendorId: NONE, total: '', delivery: '', chosen: rows.length === 0 }])}
              type="button"
              variant="outline"
            >
              Add a quote
            </Button>
          ) : (
            <FieldDescription>Add the vendor on Inventory, under Vendors, to record its quote.</FieldDescription>
          )}
        </section>
      </div>

      <aside className="grid gap-4">
        <AsideCard title="Before you submit">
          <FactTable
            facts={[
              { label: 'Estimated total', value: formatMoney(totalCents) },
              { label: 'Approval limit', value: formatMoney(choices.settings.approvalLimitCents) },
              { label: 'Who approves', value: approverFor(totalCents, choices.settings) },
              { label: 'Quotes needed', value: overLimit ? String(choices.settings.quotesAboveLimit) : 'None' },
            ]}
            label="Before you submit"
          />
          <p className="text-muted-foreground mt-3 text-xs">You asked for it, so you cannot approve it yourself.</p>
          {problem ? (
            <p className="text-warning mt-3 text-xs font-medium" role="status">
              {problem}
            </p>
          ) : null}
          {error ? (
            <Alert className="mt-3" variant="destructive">
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          ) : null}
          <div className="mt-4 grid gap-2">
            <Button disabled={pending || Boolean(problem)} onClick={() => save(true)} type="button">
              {pending ? <Spinner /> : null}
              Submit for approval
            </Button>
            <Button disabled={pending || !complete} onClick={() => save(false)} type="button" variant="outline">
              Save as a draft
            </Button>
            <Button disabled={pending} onClick={onDiscard} type="button" variant="ghost">
              {discardLabel}
            </Button>
          </div>
        </AsideCard>
        <AsideCard title="After you submit">
          <p className="text-muted-foreground">It gets its number and its lines are fixed. If the approver sends it back with a note, it opens for you again.</p>
        </AsideCard>
      </aside>
    </div>
  );
}

/** On hand, marked when it is at or below the item's reorder level. */
export function StockFigure({ onHand, reorderLevel }: { onHand: number; reorderLevel: number }) {
  const status = stockStatus(onHand, reorderLevel);
  if (status === 'ENOUGH') return <>{formatCount(onHand)}</>;
  return <Badge variant={status === 'OUT' ? 'destructive' : 'warning'}>{formatCount(onHand)}</Badge>;
}

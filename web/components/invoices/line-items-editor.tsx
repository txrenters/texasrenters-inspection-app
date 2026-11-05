'use client';

import { formatMoney, lineTotalCents, parseMoney, type EditInvoiceLineInput } from '@texasrenters/shared';
import { PlusIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * An invoice's Product / Service lines as they are typed: for a new invoice
 * and for an edit (2026-11-06). Each line's name and description, how many, at
 * what; on an edit, the day the work was done and whether the invoice's tax
 * applies. The totals are the caller's: this holds the lines, not the money.
 */

/** A line as it is being typed: the quantity and price are text until they are saved. */
export interface EditLine {
  key: string;
  name: string;
  description: string;
  quantity: string;
  price: string;
  /** `YYYY-MM-DD`, or empty. */
  serviceOn: string;
  taxable: boolean;
}

/** A stored or drafted line, to edit. A line Jobber said nothing about is taxed, as Jobber taxes it. */
export const toEditLine = (
  line: Omit<EditInvoiceLineInput, 'taxable'> & { taxable?: boolean | null },
  index: number,
): EditLine => ({
  key: `line-${index}`,
  name: line.name,
  description: line.description ?? '',
  quantity: String(line.quantity),
  price: (line.unitPriceCents / 100).toFixed(2),
  serviceOn: line.serviceOn ?? '',
  taxable: line.taxable !== false,
});

/** The line as it is sent; null while its quantity or price is not a number yet. */
export function toLineInput(line: EditLine): EditInvoiceLineInput | null {
  const quantity = Number(line.quantity);
  const unitPriceCents = parseMoney(line.price);
  if (!Number.isFinite(quantity) || unitPriceCents === null) return null;
  return {
    name: line.name.trim(),
    description: line.description.trim() || null,
    quantity,
    unitPriceCents,
    serviceOn: line.serviceOn || null,
    taxable: line.taxable,
  };
}

/** The lines that can be sent, and the first that cannot, in words. */
export function readLines(lines: readonly EditLine[]) {
  const inputs = lines.map(toLineInput);
  const typo = inputs.findIndex((line) => line === null);
  return {
    inputs,
    ready: inputs.filter((line): line is EditInvoiceLineInput => line !== null),
    problem:
      typo >= 0 ? `${lines[typo]!.name || 'A line'}: give the quantity as a number and the price in dollars and cents.` : null,
  };
}

export function LineItemsEditor({
  lines,
  onChange,
  products = [],
  showServiceDay = false,
  showTaxable = false,
}: {
  lines: EditLine[];
  onChange: (lines: EditLine[]) => void;
  /** The office's prices, to add a line from. */
  products?: readonly { name: string; unitPriceCents: number; description?: string | null }[];
  showServiceDay?: boolean;
  /** Whether each line says if the tax applies: only when the invoice has a tax. */
  showTaxable?: boolean;
}) {
  const { inputs } = readLines(lines);
  const update = (key: string, patch: Partial<EditLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const add = (product?: { name: string; unitPriceCents: number; description?: string | null }) => {
    const used = new Set(lines.map((line) => line.key));
    let next = lines.length;
    while (used.has(`line-${next}`)) next += 1;
    onChange([
      ...lines,
      {
        key: `line-${next}`,
        name: product?.name ?? '',
        description: product?.description ?? '',
        quantity: '1',
        price: product ? (product.unitPriceCents / 100).toFixed(2) : '',
        serviceOn: '',
        taxable: true,
      },
    ]);
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <h2 className="text-heading text-lg font-bold">Product / Service</h2>
        <div className="flex flex-wrap gap-2">
          {products.length ? (
            <Select onValueChange={(name) => add(products.find((product) => product.name === name))} value="">
              <SelectTrigger aria-label="Add a product" className="h-8 w-auto gap-2">
                <SelectValue placeholder="Add a product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((product) => (
                  <SelectItem key={product.name} value={product.name}>
                    {product.name} · {formatMoney(product.unitPriceCents)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Button onClick={() => add()} size="sm" variant="outline">
            <PlusIcon />
            Add a line
          </Button>
        </div>
      </div>
      <ul className="divide-y">
        {lines.map((line, index) => {
          const input = inputs[index];
          return (
            <li className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_5rem_7rem_6.5rem_2rem] sm:items-start" key={line.key}>
              <div className="grid gap-1.5">
                <Input
                  aria-label={`Line ${index + 1}: name`}
                  maxLength={120}
                  onChange={(event) => update(line.key, { name: event.target.value })}
                  placeholder="Product or service"
                  value={line.name}
                />
                <Input
                  aria-label={`Line ${index + 1}: description`}
                  className="h-8 text-xs"
                  maxLength={300}
                  onChange={(event) => update(line.key, { description: event.target.value })}
                  placeholder="Description (optional)"
                  value={line.description}
                />
                {showServiceDay || showTaxable ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
                    {showServiceDay ? (
                      <label className="text-muted-foreground flex items-center gap-2">
                        Done on
                        <Input
                          aria-label={`Line ${index + 1}: service day`}
                          className="h-8 w-auto text-xs"
                          onChange={(event) => update(line.key, { serviceOn: event.target.value })}
                          type="date"
                          value={line.serviceOn}
                        />
                      </label>
                    ) : null}
                    {showTaxable ? (
                      <label className="text-muted-foreground flex items-center gap-2">
                        <Checkbox
                          aria-label={`Line ${index + 1}: taxed`}
                          checked={line.taxable}
                          onCheckedChange={(checked) => update(line.key, { taxable: checked === true })}
                        />
                        Taxed
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </div>
              <Input
                aria-label={`Line ${index + 1}: quantity`}
                className="tabular-nums"
                inputMode="decimal"
                onChange={(event) => update(line.key, { quantity: event.target.value })}
                value={line.quantity}
              />
              <Input
                aria-label={`Line ${index + 1}: unit price`}
                className="tabular-nums"
                inputMode="decimal"
                onChange={(event) => update(line.key, { price: event.target.value })}
                placeholder="0.00"
                value={line.price}
              />
              <span className="text-heading self-center text-right font-semibold tabular-nums">
                {input ? formatMoney(lineTotalCents(input)) : '—'}
              </span>
              <Button
                aria-label={`Remove line ${index + 1}`}
                onClick={() => onChange(lines.filter((entry) => entry.key !== line.key))}
                size="icon-sm"
                variant="ghost"
              >
                <Trash2Icon />
              </Button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

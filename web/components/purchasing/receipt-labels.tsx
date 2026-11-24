'use client';

import type { GoodsReceiptRow } from '@texasrenters/shared';
import { useState } from 'react';

import { LabelPreview } from '@/components/inventory/print-labels';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCount } from '@/lib/format';
import { downloadLabels } from '@/lib/item-labels/download-labels';
import { LABEL_PAPERS, MOST_COPIES, labelsProblem, labelsSummary, readCopies, type LabelPaper, type LabelPick } from '@/lib/item-labels/label-sheets';

/**
 * Label what arrived (the office, 2026-11-24): items come with no label, and
 * nothing can be scanned until it carries one. Once a receipt is posted, its
 * items are ticked with one label a piece received (a bin of small parts may
 * need only one), on the same paper as Item codes' Print labels. It writes
 * nothing: a label is only the item code.
 */

export interface ReceiptLabelLine {
  code: string;
  name: string;
  unit: string;
  received: number;
}

/** A receipt's lines, one an item code (the same item into two places is one), with its unit from the order. */
export function receiptLabelLines(receipt: Pick<GoodsReceiptRow, 'lines'>, units: ReadonlyMap<string, string>): ReceiptLabelLine[] {
  const lines = new Map<string, ReceiptLabelLine>();
  for (const line of receipt.lines) {
    // A deleted code gets no label: the code may be given to another item.
    if (line.deleted) continue;
    const one = lines.get(line.itemCode);
    if (one) one.received += line.quantity;
    else lines.set(line.itemCode, { code: line.itemCode, name: line.itemName, unit: units.get(line.itemCode) ?? '', received: line.quantity });
  }
  return [...lines.values()];
}

export function ReceiptLabelsDialog({ receipt, units, onClose }: { receipt: GoodsReceiptRow; units: ReadonlyMap<string, string>; onClose: () => void }) {
  const lines = receiptLabelLines(receipt, units);
  // One a piece received, up to what one line of labels holds; an item not here is not ticked.
  const [copies, setCopies] = useState<Record<string, string>>(() => Object.fromEntries(lines.map((line) => [line.code, String(Math.min(line.received, MOST_COPIES))])));
  const [paper, setPaper] = useState<LabelPaper>('SHEET');
  const [startAt, setStartAt] = useState('1');
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const ticked = lines.filter((line) => line.code in copies);
  const badCopies = ticked.find((line) => !readCopies(copies[line.code]!));
  const picks: LabelPick[] = ticked.map((line) => ({ code: line.code, name: line.name, unit: line.unit, copies: readCopies(copies[line.code]!) ?? 0 }));
  const places = LABEL_PAPERS.SHEET.across * LABEL_PAPERS.SHEET.down;
  const start = /^\d{1,2}$/.test(startAt.trim()) ? Number(startAt.trim()) : 0;
  const problem = badCopies
    ? `Say how many labels of ${badCopies.code}: 1 to ${MOST_COPIES}.`
    : paper === 'SHEET' && (start < 1 || start > places)
      ? `Start at a label from 1 to ${places}.`
      : labelsProblem(picks);
  const count = picks.reduce((sum, pick) => sum + pick.copies, 0);
  const first = ticked[0] ?? lines[0];

  const tick = (code: string, on: boolean, received: number) =>
    setCopies((now) => {
      const next = { ...now };
      if (on) next[code] = now[code] ?? String(Math.min(received, MOST_COPIES));
      else delete next[code];
      return next;
    });

  async function make() {
    if (problem || making) return;
    setMaking(true);
    setFailed(null);
    try {
      await downloadLabels(picks, paper, paper === 'SHEET' ? start : 1);
    } catch {
      setFailed('The labels could not be made. Try again.');
    } finally {
      setMaking(false);
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Label what arrived</DialogTitle>
          <DialogDescription>
            {receipt.number}: before it goes on a shelf or into a truck. Each label is the item code, as stripes for a scanner and a square for the phone.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="min-w-0 overflow-x-auto rounded-xl border">
            <Table aria-label="Labels for what arrived">
              <TableHeader className="lg:static">
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Print</span>
                  </TableHead>
                  <TableHead>Item code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Labels</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => {
                  const on = line.code in copies;
                  return (
                    <TableRow key={line.code}>
                      <TableCell>
                        <Checkbox aria-label={`Labels for ${line.code}`} checked={on} onCheckedChange={(checked) => tick(line.code, checked === true, line.received)} />
                      </TableCell>
                      <TableCell className="font-mono font-semibold whitespace-nowrap tabular-nums">{line.code}</TableCell>
                      <TableCell>{line.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCount(line.received)}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          aria-label={`Labels of ${line.code}`}
                          className="ml-auto h-8 w-16 text-right tabular-nums"
                          disabled={!on}
                          inputMode="numeric"
                          maxLength={2}
                          onChange={(event) => setCopies((now) => ({ ...now, [line.code]: event.target.value }))}
                          value={on ? copies[line.code] : ''}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <p className="text-muted-foreground text-xs">
            One a piece received to start. Kept in a box or bin, one label on it may be enough; untick what arrived labelled already.
          </p>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="grid gap-3">
              <SegmentedControl
                aria-label="Paper"
                onChange={setPaper}
                options={[
                  { value: 'SHEET', label: 'Sheet of 30' },
                  { value: 'ROLL', label: 'Label roll' },
                ]}
                value={paper}
              />
              {paper === 'SHEET' ? (
                <Field>
                  <FieldLabel htmlFor="receipt-labels-start">Start at label</FieldLabel>
                  <Input className="w-24 tabular-nums" id="receipt-labels-start" inputMode="numeric" maxLength={2} onChange={(event) => setStartAt(event.target.value)} value={startAt} />
                  <FieldDescription>For a sheet that is partly used: counted across, then down.</FieldDescription>
                </Field>
              ) : null}
            </div>
            {first ? <LabelPreview code={first.code} name={first.name} unit={first.unit} /> : null}
          </div>
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {problem ?? `${labelsSummary(picks)}. Print it at actual size, not “fit to page”, so the labels meet the cuts.`}
          </p>
          {failed ? (
            <Alert variant="destructive">
              <AlertDescription>{failed}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Close
          </Button>
          <Button disabled={Boolean(problem) || making} onClick={() => void make()} type="button">
            {making ? <Spinner /> : null}
            Print {count} {count === 1 ? 'label' : 'labels'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

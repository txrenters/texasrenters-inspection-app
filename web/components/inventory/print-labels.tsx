'use client';

import type { StockItemRow } from '@texasrenters/shared';
import { useMemo, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { downloadLabels } from '@/lib/item-labels/download-labels';
import { qrPath, stripeRuns, QUIET_MODULES } from '@/lib/item-labels/label-codes';
import { LABEL_PAPERS, MOST_COPIES, labelsProblem, labelsSummary, readCopies, type LabelPaper, type LabelPick } from '@/lib/item-labels/label-sheets';

/**
 * Printing item labels (2026-11-19): tick the item codes, say how many labels
 * of each, choose the paper, and the console makes a PDF. Each label carries
 * the code in letters, its description, stripes for a scanner device and a QR
 * square for a phone camera.
 *
 * Made in the browser from the rows the tab already holds: nothing is asked
 * of the server and nothing billed is called. Anybody who can see the item
 * codes may print them; a label changes nothing.
 */

/** One label on the screen, drawn from the same bars the PDF prints. */
export function LabelPreview({ code, name, unit }: { code: string; name: string; unit: string }) {
  const drawn = useMemo(() => {
    try {
      return { stripes: stripeRuns(code), square: qrPath(code) };
    } catch {
      return null;
    }
  }, [code]);
  if (!drawn) return null;
  const whole = drawn.stripes.modules + QUIET_MODULES * 2;
  return (
    <div className="flex items-center gap-3 rounded-md border border-dashed bg-white p-3 text-black">
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="font-mono text-sm font-bold">{code}</span>
        <span className="truncate text-xs">
          {name} · {unit}
        </span>
        <svg aria-label={`Striped bar code for ${code}`} className="h-8 w-full" preserveAspectRatio="none" role="img" viewBox={`0 0 ${whole} 10`}>
          {drawn.stripes.runs.map((run) => (
            <rect fill="#000" height="10" key={run.at} width={run.width} x={run.at + QUIET_MODULES} y="0" />
          ))}
        </svg>
      </div>
      <svg aria-label={`QR code for ${code}`} className="size-16 shrink-0" role="img" shapeRendering="crispEdges" viewBox={`-2 -2 ${drawn.square.size + 4} ${drawn.square.size + 4}`}>
        <path d={drawn.square.path} fill="#000" />
      </svg>
    </div>
  );
}

export function PrintLabels({ items, onBack }: { items: readonly StockItemRow[]; onBack: () => void }) {
  // Only codes in use get a label: one switched off is not put on a shelf.
  const rows = useMemo(() => items.filter((item) => item.active), [items]);
  /** The copies typed for each ticked item, by id; an item not here is not ticked. */
  const [copies, setCopies] = useState<Record<string, string>>({});
  const [paper, setPaper] = useState<LabelPaper>('SHEET');
  const [startAt, setStartAt] = useState('1');
  const [making, setMaking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const ticked = rows.filter((row) => row.id in copies);
  const badCopies = ticked.find((row) => readCopies(copies[row.id]!) === null || readCopies(copies[row.id]!) === 0);
  const picks: LabelPick[] = ticked.map((row) => ({ code: row.code, name: row.name, unit: row.unit, copies: readCopies(copies[row.id]!) ?? 0 }));
  const places = LABEL_PAPERS.SHEET.across * LABEL_PAPERS.SHEET.down;
  const start = /^\d{1,2}$/.test(startAt.trim()) ? Number(startAt.trim()) : 0;
  const problem = badCopies
    ? `Say how many labels of ${badCopies.code}: 1 to ${MOST_COPIES}.`
    : paper === 'SHEET' && (start < 1 || start > places)
      ? `Start at a label from 1 to ${places}.`
      : labelsProblem(picks);
  const first = ticked[0] ?? rows[0];

  const tick = (row: StockItemRow, on: boolean) =>
    setCopies((now) => {
      const next = { ...now };
      if (on) next[row.id] = now[row.id] ?? '1';
      else delete next[row.id];
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
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_24rem]">
      <section aria-labelledby="print-labels-heading" className="grid min-w-0 gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold" id="print-labels-heading">
            Print labels
          </h2>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!rows.length} onClick={() => setCopies((now) => Object.fromEntries(rows.map((row) => [row.id, now[row.id] ?? '1'])))} size="sm" type="button" variant="outline">
              Tick all
            </Button>
            <Button onClick={onBack} size="sm" type="button" variant="outline">
              Back to item codes
            </Button>
          </div>
        </div>
        {rows.length ? (
          <div className="min-w-0 overflow-clip rounded-xl border">
            <Table aria-label="Item codes to print">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <span className="sr-only">Print</span>
                  </TableHead>
                  <TableHead>Item code</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Unit</TableHead>
                  <TableHead className="text-right">Labels</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const on = row.id in copies;
                  return (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Checkbox aria-label={`Print ${row.code}`} checked={on} onCheckedChange={(checked) => tick(row, checked === true)} />
                      </TableCell>
                      <TableCell className="font-mono font-semibold whitespace-nowrap tabular-nums">{row.code}</TableCell>
                      <TableCell>{row.name}</TableCell>
                      <TableCell>{row.unit}</TableCell>
                      <TableCell className="text-right">
                        <Input
                          aria-label={`Labels for ${row.code}`}
                          className="ml-auto h-8 w-16 text-right tabular-nums"
                          disabled={!on}
                          inputMode="numeric"
                          maxLength={2}
                          onChange={(event) => setCopies((now) => ({ ...now, [row.id]: event.target.value }))}
                          value={on ? copies[row.id] : ''}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">There is no item code in use to print a label for.</p>
        )}
        <p className="text-muted-foreground text-xs">
          The bar code is the item code itself, so a label stays right for as long as the code does. A code that has been requested, ordered or stocked cannot be changed. A code longer than about 14 characters
          makes stripes too fine for some scanner devices; the square still reads.
        </p>
      </section>

      <aside className="grid min-w-0 gap-4">
        <div className="grid gap-4 rounded-md border p-4">
          <h3 className="text-sm font-semibold">Paper</h3>
          <Field>
            <FieldLabel htmlFor="labels-paper">Print on</FieldLabel>
            <Select onValueChange={(value) => setPaper(value as LabelPaper)} value={paper}>
              <SelectTrigger id="labels-paper">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SHEET">{LABEL_PAPERS.SHEET.name}</SelectItem>
                <SelectItem value="ROLL">{LABEL_PAPERS.ROLL.name}</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>The sheet is for the office printer. The roll is for a label printer.</FieldDescription>
          </Field>
          {paper === 'SHEET' ? (
            <Field>
              <FieldLabel htmlFor="labels-start">Start at label</FieldLabel>
              <Input className="w-24 tabular-nums" id="labels-start" inputMode="numeric" maxLength={2} onChange={(event) => setStartAt(event.target.value)} value={startAt} />
              <FieldDescription>For a sheet that is partly used: counted across, then down. 1 is the top left.</FieldDescription>
            </Field>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={Boolean(problem) || making} onClick={() => void make()} type="button">
              {making ? <Spinner /> : null}
              Make the PDF
            </Button>
            <span className="text-muted-foreground text-sm">{labelsSummary(picks)}</span>
          </div>
          <p aria-live="polite" className="text-muted-foreground text-sm">
            {problem ?? 'Print it at actual size, not “fit to page”, so the labels meet the cuts.'}
          </p>
          {failed ? (
            <Alert variant="destructive">
              <AlertDescription>{failed}</AlertDescription>
            </Alert>
          ) : null}
        </div>
        {first ? (
          <div className="bg-muted/40 grid gap-3 rounded-md border p-4">
            <h3 className="text-sm font-semibold">What one label looks like</h3>
            <LabelPreview code={first.code} name={first.name} unit={first.unit} />
            <p className="text-muted-foreground text-xs">Stripes for a scanner device, a square for a phone camera. Both hold {first.code}.</p>
          </div>
        ) : null}
      </aside>
    </div>
  );
}

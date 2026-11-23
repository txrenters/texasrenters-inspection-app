'use client';

import { formatMoney, type StockImportCheck, type StockImportDone, type StockImportRow, type StockList } from '@texasrenters/shared';
import { CheckCircle2Icon, DownloadIcon, FileSpreadsheetIcon } from 'lucide-react';
import { useId, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { businessToday } from '@/lib/clock';
import { formatCount } from '@/lib/format';
import { useStockImport } from '@/lib/inventory-queries';
import { downloadImportTemplate, readImportFile } from '@/lib/stock-import/stock-import-file';

/**
 * Import stock (2026-11-23): the office's stock from a spreadsheet, filled in
 * from the template. The file is read here and checked by the server against
 * the office's codes, places and opening balances; what is wrong is listed
 * row by row, and Import is pressed only once every row is right. Then it is
 * saved all at once, or not at all.
 */
export function StockImportDialog({ stock, onClose }: { stock: Pick<StockList, 'places' | 'categories' | 'units' | 'companies' | 'vendors'>; onClose: () => void }) {
  const ids = useId();
  const imports = useStockImport();
  const today = businessToday();
  const [day, setDay] = useState(today);
  const [file, setFile] = useState<{ name: string; rows: StockImportRow[]; key: string } | null>(null);
  const [unread, setUnread] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [done, setDone] = useState<StockImportDone | null>(null);
  const check: StockImportCheck | undefined = imports.check.data;

  const send = (rows: StockImportRow[], name: string, asOf: string) => imports.check.mutate({ rows, day: asOf, fileName: name });

  const choose = async (chosen: File | undefined) => {
    imports.check.reset();
    imports.run.reset();
    setFile(null);
    setUnread(null);
    if (!chosen) return;
    setReading(true);
    const read = await readImportFile(chosen);
    setReading(false);
    if (read.problem) return setUnread(read.problem);
    // One key a file as chosen: Import pressed twice saves it once.
    setFile({ name: chosen.name, rows: read.rows, key: crypto.randomUUID() });
    send(read.rows, chosen.name, day);
  };
  const changeDay = (next: string) => {
    setDay(next);
    if (file && next) send(file.rows, file.name, next);
  };
  const run = () => {
    if (!file || !check?.ready) return;
    imports.run.mutate({ rows: file.rows, day, fileName: file.name, requestKey: file.key }, { onSuccess: setDone });
  };

  const wrongRows = check?.rows.filter((row) => row.problems.length) ?? [];
  const busy = reading || imports.check.isPending || imports.run.isPending;

  return (
    <Dialog onOpenChange={(open) => (open || imports.run.isPending ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import stock</DialogTitle>
          <DialogDescription>
            One row an item at a place, with how many are there and what one cost. A new item code is made from its row; every row sets that item&apos;s opening stock at that place.
          </DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="grid justify-items-center gap-2 py-6 text-center" role="status">
            <CheckCircle2Icon aria-hidden="true" className="text-success size-8" />
            <p className="text-heading font-medium">
              Imported {formatCount(done.rows)} {done.rows === 1 ? 'row' : 'rows'}: {formatMoney(done.totalValueCents)} of stock.
            </p>
            <p className="text-muted-foreground text-sm">
              {done.newItems ? `${formatCount(done.newItems)} new item ${done.newItems === 1 ? 'code was' : 'codes were'} made. ` : ''}A wrong entry is reversed on its item&apos;s page.
            </p>
          </div>
        ) : (
          <div className="grid gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm">The template:</span>
              <Button onClick={() => void downloadImportTemplate('xlsx', stock)} size="sm" type="button" variant="outline">
                <DownloadIcon /> Excel
              </Button>
              <Button onClick={() => void downloadImportTemplate('csv', stock)} size="sm" type="button" variant="outline">
                <DownloadIcon /> CSV
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-file`}>The file, filled in</Label>
                <Input accept=".xlsx,.csv,text/csv" disabled={busy} id={`${ids}-file`} onChange={(event) => void choose(event.target.files?.[0])} type="file" />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor={`${ids}-day`}>Stock as of</Label>
                <Input disabled={busy} id={`${ids}-day`} max={today} onChange={(event) => changeDay(event.target.value)} type="date" value={day} />
              </div>
            </div>

            {unread ? (
              <Alert variant="destructive">
                <AlertDescription>{unread}</AlertDescription>
              </Alert>
            ) : null}
            {imports.check.error || imports.run.error ? (
              <Alert variant="destructive">
                <AlertDescription>{(imports.run.error ?? imports.check.error)!.message}</AlertDescription>
              </Alert>
            ) : null}
            {reading || imports.check.isPending ? (
              <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
                <Spinner /> Checking the file…
              </p>
            ) : null}

            {check && file && !imports.check.isPending ? (
              <section aria-label="What the file holds" className="grid gap-3">
                <p className="text-sm">
                  <FileSpreadsheetIcon aria-hidden="true" className="text-muted-foreground mr-1.5 inline size-4" />
                  <span className="font-medium">{file.name}</span>: {formatCount(check.rows.length)} {check.rows.length === 1 ? 'row' : 'rows'}: {formatCount(check.newItems)} new item{' '}
                  {check.newItems === 1 ? 'code' : 'codes'}, {formatCount(check.existingItems)} already made
                  {check.ready ? `, ${formatCount(check.totalQuantity)} on hand worth ${formatMoney(check.totalValueCents)}.` : '.'}
                </p>
                {check.ready ? (
                  <p className="text-success text-sm font-medium" role="status">
                    Every row is right.
                  </p>
                ) : (
                  <div className="grid gap-2" role="status">
                    <p className="text-sm font-medium">
                      Fix {wrongRows.length ? `${formatCount(wrongRows.length)} ${wrongRows.length === 1 ? 'row' : 'rows'}` : 'the file'} and choose it again. Nothing is saved until every row is right.
                    </p>
                    {check.problems.map((problem) => (
                      <p className="text-destructive text-sm" key={problem}>
                        {problem}
                      </p>
                    ))}
                    {wrongRows.length ? (
                      <div className="max-h-72 overflow-auto rounded-md border">
                        <Table aria-label="Rows to fix">
                          <TableHeader className="bg-muted/50 sticky top-0">
                            <TableRow>
                              <TableHead>Row</TableHead>
                              <TableHead>Item Code</TableHead>
                              <TableHead>Location</TableHead>
                              <TableHead>What to fix</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {wrongRows.map((row) => (
                              <TableRow className="align-top" key={row.line}>
                                <TableCell className="tabular-nums">{row.line}</TableCell>
                                <TableCell className="whitespace-nowrap">{row.code || '—'}</TableCell>
                                <TableCell>{row.place || '—'}</TableCell>
                                <TableCell className="whitespace-normal">
                                  {row.problems.map((problem) => (
                                    <p key={problem}>{problem}</p>
                                  ))}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    ) : null}
                  </div>
                )}
              </section>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {done ? (
            <Button onClick={onClose} type="button">
              Done
            </Button>
          ) : (
            <>
              <Button disabled={imports.run.isPending} onClick={onClose} type="button" variant="outline">
                Cancel
              </Button>
              <Button disabled={!check?.ready || !file || busy} onClick={run} type="button">
                {imports.run.isPending ? <Spinner /> : null}
                Import {check?.ready ? `${formatCount(check.rows.length)} ${check.rows.length === 1 ? 'row' : 'rows'}` : ''}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { MOST_KEEP_AT_LEAST, type TruckKeepLevel } from '@texasrenters/shared';
import { useState } from 'react';

import { ErrorState } from '@/components/states';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCount } from '@/lib/format';
import { useTruckKeepEdits, useTruckKeepLevels } from '@/lib/inventory-queries';

/**
 * Keep at least (the office, 2026-11-24): what the office keeps on a truck of
 * each item. Below it, the phone says the item is running low and puts it on
 * the technician's ask for more. Empty keeps none of it there. Read when it
 * opens; one save sends only what changed.
 */

const readKeep = (typed: string): number | null | 'bad' => {
  const text = typed.trim();
  if (text === '' || text === '0') return null;
  if (!/^\d{1,5}$/.test(text) || Number(text) > MOST_KEEP_AT_LEAST) return 'bad';
  return Number(text);
};

export function KeepLevelsDialog({ placeId, onClose }: { placeId: string; onClose: () => void }) {
  const levels = useTruckKeepLevels(placeId);
  const { save } = useTruckKeepEdits();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState('');

  const rows: TruckKeepLevel[] = levels.data?.levels ?? [];
  const words = filter.trim().toLowerCase();
  const shown = rows.filter((row) => !words || `${row.code} ${row.name}`.toLowerCase().includes(words));
  const changed = rows.flatMap((row) => {
    if (!(row.itemId in typed)) return [];
    const keep = readKeep(typed[row.itemId]!);
    return keep === 'bad' || keep === row.keepAtLeast ? [] : [{ itemId: row.itemId, keepAtLeast: keep }];
  });
  const bad = rows.find((row) => row.itemId in typed && readKeep(typed[row.itemId]!) === 'bad');

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{levels.data ? `${levels.data.place.name} · keep at least` : 'Keep at least'}</DialogTitle>
          <DialogDescription>Below it, the technician&apos;s phone shows the item as running low and puts it on their ask for more. Empty keeps none of it on the truck.</DialogDescription>
        </DialogHeader>
        {levels.isError ? (
          <ErrorState error={levels.error} retry={() => void levels.refetch()} />
        ) : !levels.data ? (
          <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
            <Spinner /> Loading
          </div>
        ) : (
          <div className="grid gap-3">
            <Input aria-label="Find an item" onChange={(event) => setFilter(event.target.value)} placeholder="Item code or name" type="search" value={filter} />
            <div className="max-h-[55vh] min-w-0 overflow-auto rounded-xl border">
              <Table aria-label="What is kept on the truck">
                <TableHeader className="lg:static">
                  <TableRow>
                    <TableHead>Item code</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">On it</TableHead>
                    <TableHead className="text-right">Keep at least</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((row) => {
                    const value = typed[row.itemId] ?? (row.keepAtLeast === null ? '' : String(row.keepAtLeast));
                    const keep = readKeep(value);
                    const low = keep !== 'bad' && keep !== null && row.onHand < keep;
                    return (
                      <TableRow key={row.itemId}>
                        <TableCell className="font-mono font-semibold whitespace-nowrap tabular-nums">{row.code}</TableCell>
                        <TableCell>
                          {row.name}
                          {low ? (
                            <Badge className="ml-2" variant="warning">
                              Running low
                            </Badge>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatCount(row.onHand)}</TableCell>
                        <TableCell className="text-right">
                          <Input
                            aria-invalid={keep === 'bad' || undefined}
                            aria-label={`Keep at least of ${row.code}`}
                            className="ml-auto h-8 w-20 text-right tabular-nums"
                            inputMode="numeric"
                            maxLength={5}
                            onChange={(event) => setTyped((now) => ({ ...now, [row.itemId]: event.target.value }))}
                            value={value}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {bad ? <p className="text-destructive text-sm">{`Keep at least of ${bad.code} is a whole number up to ${formatCount(MOST_KEEP_AT_LEAST)}, or empty for none.`}</p> : null}
            {save.error ? (
              <Alert variant="destructive">
                <AlertDescription>{save.error.message}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose} type="button" variant="outline">
            Close
          </Button>
          <Button
            disabled={!changed.length || Boolean(bad) || save.isPending}
            onClick={() => void save.mutateAsync({ placeId, input: { levels: changed } }).then(() => setTyped({})).catch(() => undefined)}
            type="button"
          >
            {save.isPending ? <Spinner /> : null}
            Save {changed.length ? `${changed.length} ${changed.length === 1 ? 'change' : 'changes'}` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

'use client';

import { secondsAsHours, sheetDate, sheetMoney, type RevenueClearedCell } from '@texasrenters/shared';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { LOG_COLUMNS } from '@/lib/actual-vs-budget-cells';
import { useClearedCells, useRestoreClearedCells } from '@/lib/actual-vs-budget-queries';
import { formatDateTime } from '@/lib/format';

/** The cell's name, as its sheet heads it. */
const FIELD_LABEL: Record<string, string> = {
  ...Object.fromEntries(LOG_COLUMNS.map((column) => [column.field, column.header])),
  budgetCents: 'Budgeted Daily Revenue',
  workSeconds: "Tech's Work Time",
  projectionRemarks: 'Projection remarks',
  dailyRemarks: 'Daily remarks',
  trackerRemarks: 'Tracker remarks',
  targetCents: 'Target revenue',
  actualCents: 'Actual revenue',
  remarks: 'Remarks',
};
const CENTS = new Set(['estimatedBudgetCents', 'laborCents', 'serviceCallFeeCents', 'materialsCents', 'budgetCents', 'targetCents', 'actualCents']);

/** A value as the record keeps it, as the sheet shows it. */
export function shownValue(field: string, value: string): string {
  if (CENTS.has(field)) return sheetMoney(Number(value));
  if (field === 'workSeconds') return secondsAsHours(Number(value));
  if (field === 'workComplete' || field === 'rescheduleRequired') return value === 'true' ? 'Yes' : 'No';
  if (field === 'rescheduleOn' || /^\d{4}-\d{2}-\d{2}$/.test(value)) return sheetDate(value);
  return value;
}

/**
 * The cells a save cleared by mistake (v2.5.242 to v2.5.248) and still empty,
 * from the database's own history, to put back (2026-11-17, the office: "fix
 * it from the history"). Each shows what it held; those the one-cell-save
 * fault certainly cleared are ticked, the others (cleared from Excel, or where
 * the cell meant cannot be told) are left for the office to choose.
 */
export function ClearedCellsDialog({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const cleared = useClearedCells(true);
  const restore = useRestoreClearedCells();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  // Ticked once the list comes: those certainly cleared by mistake. Keyed on the cells' ids, so the list read
  // again does not untick what the office chose, and nothing re-renders over and over.
  const ticked = cleared.data ? JSON.stringify(cleared.data.cells.filter((cell) => cell.certain).map((cell) => cell.id)) : undefined;
  useEffect(() => {
    if (ticked !== undefined) setChosen(new Set(JSON.parse(ticked) as string[]));
  }, [ticked]);
  const toggle = (cell: RevenueClearedCell, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(cell.id);
      else next.delete(cell.id);
      return next;
    });
  const put = () =>
    restore.mutate([...chosen], {
      onSuccess: (result) => toast.success(`Put back ${result.restored} ${result.restored === 1 ? 'cell' : 'cells'}`),
      onError: (error) => toast.error('Not put back', { description: error.message }),
    });

  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Cleared cells</DialogTitle>
          <DialogDescription>Cleared by mistake when another cell was saved, and still empty. Ticked ones go back as they were.</DialogDescription>
        </DialogHeader>
        {cleared.isPending ? (
          <PageSkeleton cards={0} />
        ) : cleared.isError ? (
          <ErrorState error={cleared.error} retry={() => void cleared.refetch()} />
        ) : cleared.data.cells.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing to put back.</p>
        ) : (
          <>
            <Table className="text-sm">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Where</TableHead>
                  <TableHead>Cell</TableHead>
                  <TableHead>Was</TableHead>
                  <TableHead>Cleared</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cleared.data.cells.map((cell) => (
                  <TableRow key={cell.id}>
                    <TableCell className="align-top">
                      <Checkbox
                        aria-label={`Put back ${FIELD_LABEL[cell.field] ?? cell.field} for ${cell.where}`}
                        checked={chosen.has(cell.id)}
                        disabled={!canManage}
                        onCheckedChange={(on) => toggle(cell, on === true)}
                      />
                    </TableCell>
                    <TableCell className="align-top whitespace-normal">{cell.where}</TableCell>
                    <TableCell className="align-top">{FIELD_LABEL[cell.field] ?? cell.field}</TableCell>
                    <TableCell className="align-top font-medium">{shownValue(cell.field, cell.lost)}</TableCell>
                    <TableCell className="text-muted-foreground align-top text-xs whitespace-normal">
                      {formatDateTime(cell.at)} · {cell.by}
                      {cell.certain ? null : <div>{cell.by === 'Excel' ? 'Emptied in Excel' : 'Which cell was meant is not known'}</div>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {canManage ? (
              <div className="flex justify-end">
                <Button disabled={!chosen.size || restore.isPending} onClick={put}>
                  {restore.isPending ? 'Putting back…' : `Put back ${chosen.size} ${chosen.size === 1 ? 'cell' : 'cells'}`}
                </Button>
              </div>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

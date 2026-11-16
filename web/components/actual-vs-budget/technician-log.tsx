'use client';

import { logRangeProblem, secondsAsHours, type RevenueLogField, type RevenueLogRow, type RevenueLogSource } from '@texasrenters/shared';
import { Trash2Icon } from 'lucide-react';
import { Fragment, useState, type FocusEvent } from 'react';
import { toast } from 'sonner';

import { GridCell, Sheet, SheetHead, TotalCell } from '@/components/actual-vs-budget/grid';
import { SelectFilter } from '@/components/list-toolbar';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import {
  LOG_COLUMNS,
  cellText,
  changes,
  readCell,
  readRow,
  sheetDate,
  sheetMoney,
  sheetWholeDollars,
  type LogColumnField,
} from '@/lib/actual-vs-budget-cells';
import { useRevenueLog, useRevenueLogEdits } from '@/lib/actual-vs-budget-queries';

/**
 * The technician log (2026-11-17, PR 1): one technician's visits day by day in
 * the workbook's 19 columns, a Total row closing each day. The cells the
 * console knows come filled; the rest are typed into where they are.
 */

const SOURCE: Record<RevenueLogSource, string> = {
  VISIT: 'From the Jobber visit',
  TIMESHEET: 'From the timesheet',
  INVOICE: "From the visit's invoice",
};

/** Worked out from the row, never typed: Actual Time, and a visit's day, which is the visit's. */
const readOnlyFor = (row: RevenueLogRow, field: LogColumnField) => field === 'actualSeconds' || (field === 'date' && Boolean(row.inspectionId));

export function TechnicianLog({
  canEdit,
  technicians,
  technicianId,
  from,
  to,
  onChange,
}: {
  canEdit: boolean;
  technicians: { id: string; name: string }[];
  technicianId: string;
  from: string;
  to: string;
  onChange: (patch: { technician?: string; from?: string; to?: string }) => void;
}) {
  const rangeProblem = logRangeProblem(from, to);
  const log = useRevenueLog(technicianId, rangeProblem ? '' : from, rangeProblem ? '' : to);
  const width = LOG_COLUMNS.length + (canEdit ? 1 : 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SelectFilter
          allLabel="Choose a technician"
          label="Technician"
          onChange={(next) => onChange({ technician: next })}
          options={technicians.map((technician) => ({ value: technician.id, label: technician.name }))}
          value={technicianId}
        />
        <DatePicker aria-label="First day" className="w-56" max={to} onChange={(next) => onChange({ from: next })} value={from} />
        <span className="text-muted-foreground text-sm">to</span>
        <DatePicker aria-label="Last day" className="w-56" min={from} onChange={(next) => onChange({ to: next })} value={to} />
      </div>
      {rangeProblem ? <p className="text-destructive text-sm">{rangeProblem}</p> : null}
      {!technicianId ? (
        <EmptyState title="No technicians" description="The office has no technicians to keep a log for." />
      ) : log.isPending ? (
        <PageSkeleton cards={0} />
      ) : log.isError ? (
        <ErrorState error={log.error} retry={() => void log.refetch()} />
      ) : (
        <Sheet>
          <TableHeader className="text-muted-foreground lg:static">
            <TableRow>
              {LOG_COLUMNS.map((column) => (
                <SheetHead key={column.field} numeric={column.numeric}>
                  {column.header}
                </SheetHead>
              ))}
              {canEdit ? <SheetHead className="w-8 px-0"><span className="sr-only">Remove</span></SheetHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {log.data.days.map((day) => (
              <Fragment key={day.date}>
                {day.rows.map((row) => (
                  <LogRow canEdit={canEdit} key={row.key} row={row} />
                ))}
                <TableRow className="bg-muted hover:bg-muted font-semibold">
                  <TotalCell>Total</TotalCell>
                  <TotalCell span={3} />
                  <TotalCell>{day.totals.driveTime}</TotalCell>
                  <TotalCell>{day.totals.timeBudgeted}</TotalCell>
                  <TotalCell numeric>{sheetWholeDollars(day.totals.estimatedBudgetCents)}</TotalCell>
                  <TotalCell span={2} />
                  <TotalCell numeric>{secondsAsHours(day.totals.actualSeconds)}</TotalCell>
                  <TotalCell span={3} />
                  <TotalCell numeric>{sheetMoney(day.totals.laborCents)}</TotalCell>
                  <TotalCell numeric>{sheetMoney(day.totals.serviceCallFeeCents)}</TotalCell>
                  <TotalCell numeric>{sheetMoney(day.totals.materialsCents)}</TotalCell>
                  <TotalCell span={width - 16} />
                </TableRow>
              </Fragment>
            ))}
            {canEdit ? <NewRow date={to} key={`${technicianId}:${to}`} technicianId={technicianId} /> : null}
            {!canEdit && log.data.days.length === 0 ? (
              <TableRow>
                <TableCell className="text-muted-foreground px-2 py-6 text-center" colSpan={width}>
                  Nothing on these days.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Sheet>
      )}
    </div>
  );
}

// ── A row ───────────────────────────────────────────────────────────────────

function LogRow({ row, canEdit }: { row: RevenueLogRow; canEdit: boolean }) {
  const edits = useRevenueLogEdits();
  const commit = (field: RevenueLogField) => async (typed: string) => {
    const read = readCell(field, typed);
    if ('problem' in read) {
      toast.error(read.problem);
      return false;
    }
    if (!changes(row, field, read.value)) return true;
    const target = row.inspectionId ? { inspectionId: row.inspectionId } : { entryId: row.entryId! };
    try {
      await edits.save.mutateAsync({ target, input: { [field]: read.value } });
      return true;
    } catch (error) {
      toast.error('Not saved', { description: error instanceof Error ? error.message : undefined });
      return false;
    }
  };
  const remove = () =>
    edits.remove.mutate(row.entryId!, { onError: (error) => toast.error('The row was not removed', { description: error.message }) });

  return (
    <TableRow className="group hover:bg-transparent">
      {LOG_COLUMNS.map((column) => {
        const field = column.field;
        const source = field === 'actualSeconds' ? undefined : row.filled[field];
        const readOnly = !canEdit || readOnlyFor(row, field);
        return (
          <GridCell
            key={field}
            label={`${column.header}, ${sheetDate(row.date)}, ${row.address ?? 'row'}`}
            numeric={column.numeric}
            onCommit={readOnly || field === 'actualSeconds' ? undefined : commit(field)}
            readOnly={readOnly}
            text={cellText(row, field)}
            title={source ? SOURCE[source] : undefined}
            wide={column.wide}
          />
        );
      })}
      {canEdit ? (
        <TableCell className="w-8 p-0 align-top">
          {row.inspectionId ? null : (
            <Button
              aria-label={`Remove the row for ${row.address ?? sheetDate(row.date)}`}
              className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
              disabled={edits.remove.isPending}
              onClick={remove}
              size="icon"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          )}
        </TableCell>
      ) : null}
    </TableRow>
  );
}

/** The blank row at the foot: typing into it adds a row of the office's own, saved when the row is left. */
function NewRow({ technicianId, date }: { technicianId: string; date: string }) {
  const edits = useRevenueLogEdits();
  const blank = () => ({ date: sheetDate(date) }) as Partial<Record<RevenueLogField, string>>;
  const [texts, setTexts] = useState(blank);
  const [round, setRound] = useState(0);

  const leaveRow = (event: FocusEvent<HTMLTableRowElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    const typed = Object.entries(texts).some(([field, text]) => field !== 'date' && text?.trim());
    if (!typed) return;
    const read = readRow(texts);
    if ('problem' in read) {
      toast.error(read.problem);
      return;
    }
    edits.save.mutate(
      { target: { add: true }, input: { ...read.input, date: read.input.date ?? date, technicianId } },
      {
        onSuccess: () => {
          setTexts(blank());
          setRound((count) => count + 1);
        },
        onError: (error) => toast.error('The row was not added', { description: error.message }),
      },
    );
  };

  return (
    <TableRow className="hover:bg-transparent" key={round} onBlur={leaveRow}>
      {LOG_COLUMNS.map((column) => (
        <GridCell
          key={column.field}
          label={`New row, ${column.header}`}
          numeric={column.numeric}
          onChange={(typed) => setTexts((current) => ({ ...current, [column.field]: typed }))}
          readOnly={column.field === 'actualSeconds'}
          text={column.field === 'date' ? sheetDate(date) : ''}
          wide={column.wide}
        />
      ))}
      <TableCell className="w-8 p-0" />
    </TableRow>
  );
}

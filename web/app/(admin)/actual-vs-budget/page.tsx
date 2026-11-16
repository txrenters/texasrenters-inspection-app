'use client';

import {
  REVENUE_COLUMNS,
  REVENUE_COLUMN_LABEL,
  logRangeProblem,
  secondsAsHours,
  type RevenueColumn,
  type RevenueLogField,
  type RevenueLogRow,
  type RevenueLogSource,
} from '@texasrenters/shared';
import { Trash2Icon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { toast } from 'sonner';

import { SelectFilter } from '@/components/list-toolbar';
import { PageHeader } from '@/components/page-header';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { usePermissions } from '@/lib/auth';
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
import { useRevenueLog, useRevenueLogEdits, useRevenueProducts, useRevenueTechnicians } from '@/lib/actual-vs-budget-queries';
import { businessToday, shiftDay } from '@/lib/clock';
import { useUrlState } from '@/lib/url-state';
import { cn } from '@/lib/utils';

/**
 * Actual vs Budget (2026-11-17, PR 1 of rebuilding the office's "THMP
 * Scheduling Actual Vs Budget 2026.xlsx" in the console): the technician log,
 * in the workbook's 19 columns with a Total row closing each day.
 *
 * A spreadsheet, as the office asked ("design it like a csv that there's an
 * actual cell we can add entry on"): every cell is typed into where it is. The
 * cells the console knows come filled; the rest are blank to be filled. A cell
 * saves when it is left, and the row at the foot adds a row of the office's own.
 */

const SOURCE: Record<RevenueLogSource, string> = {
  VISIT: 'From the Jobber visit',
  TIMESHEET: 'From the timesheet',
  INVOICE: "From the visit's invoice",
};

/** Worked out from the row, never typed: Actual Time, and a visit's day, which is the visit's. */
const readOnlyFor = (row: RevenueLogRow, field: LogColumnField) => field === 'actualSeconds' || (field === 'date' && Boolean(row.inspectionId));

export default function ActualVsBudgetPage() {
  const { has } = usePermissions();
  const canEdit = has('invoices:manage');
  const today = businessToday();
  const [query, setQuery] = useUrlState({ technician: '', from: shiftDay(today, -6), to: today });
  const technicians = useRevenueTechnicians();
  const technicianId = query.technician || technicians.data?.technicians[0]?.id || '';
  const rangeProblem = logRangeProblem(query.from, query.to);
  const log = useRevenueLog(technicianId, rangeProblem ? '' : query.from, rangeProblem ? '' : query.to);
  const [columnsOpen, setColumnsOpen] = useState(false);

  if (technicians.isPending) return <PageSkeleton />;
  if (technicians.isError) return <ErrorState error={technicians.error} retry={() => void technicians.refetch()} />;

  const width = LOG_COLUMNS.length + (canEdit ? 1 : 0);
  return (
    <div className="space-y-4">
      <PageHeader
        title="Actual vs Budget"
        actions={
          canEdit ? (
            <Button onClick={() => setColumnsOpen(true)} size="sm" variant="outline">
              Money columns
            </Button>
          ) : null
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <SelectFilter
          allLabel="Choose a technician"
          label="Technician"
          onChange={(next) => setQuery({ technician: next })}
          options={(technicians.data?.technicians ?? []).map((technician) => ({ value: technician.id, label: technician.name }))}
          value={technicianId}
        />
        <DatePicker aria-label="First day" className="w-56" max={query.to} onChange={(from) => setQuery({ from })} value={query.from} />
        <span className="text-muted-foreground text-sm">to</span>
        <DatePicker aria-label="Last day" className="w-56" min={query.from} onChange={(to) => setQuery({ to })} value={query.to} />
      </div>
      {rangeProblem ? <p className="text-destructive text-sm">{rangeProblem}</p> : null}
      {!technicianId ? (
        <EmptyState title="No technicians" description="The office has no technicians to keep a log for." />
      ) : log.isPending ? (
        <PageSkeleton cards={0} />
      ) : log.isError ? (
        <ErrorState error={log.error} retry={() => void log.refetch()} />
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table className="w-max min-w-full border-collapse text-xs">
            <TableHeader className="text-muted-foreground lg:static">
              <TableRow>
                {LOG_COLUMNS.map((column) => (
                  <TableHead
                    className={cn('h-auto border-r px-2 py-2 align-bottom text-xs leading-tight font-semibold whitespace-normal', column.numeric && 'text-right')}
                    key={column.field}
                    scope="col"
                  >
                    {/* Headers wrap, so a column is as wide as what is typed in it, not as its name. */}
                    <div className={cn('max-w-[7.5rem]', column.numeric && 'ml-auto')}>{column.header}</div>
                  </TableHead>
                ))}
                {canEdit ? <TableHead className="w-8 px-0" scope="col"><span className="sr-only">Remove</span></TableHead> : null}
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
              {canEdit ? <NewRow date={query.to} key={`${technicianId}:${query.to}`} technicianId={technicianId} /> : null}
              {!canEdit && log.data.days.length === 0 ? (
                <TableRow>
                  <TableCell className="text-muted-foreground px-2 py-6 text-center" colSpan={width}>
                    Nothing on these days.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      )}
      {columnsOpen ? <MoneyColumnsDialog onClose={() => setColumnsOpen(false)} /> : null}
    </div>
  );
}

function TotalCell({ children, numeric, span }: { children?: string; numeric?: boolean; span?: number }) {
  return (
    <TableCell className={cn('border-r px-2 py-1.5 whitespace-nowrap', numeric && 'text-right font-mono tabular-nums')} colSpan={span}>
      {children}
    </TableCell>
  );
}

// ── A cell ──────────────────────────────────────────────────────────────────

/**
 * A spreadsheet cell: it grows with what is in it, saves when it is left or on
 * Enter, and goes back to what it was on Escape.
 */
function GridCell({
  text,
  label,
  title,
  numeric,
  wide,
  readOnly,
  onCommit,
  onChange,
}: {
  text: string;
  label: string;
  title?: string;
  numeric?: boolean;
  wide?: boolean;
  readOnly?: boolean;
  /** Saves; false keeps what was typed out of the cell. Absent for a cell whose row saves it. */
  onCommit?: (typed: string) => Promise<boolean> | boolean;
  onChange?: (typed: string) => void;
}) {
  const [draft, setDraft] = useState(text);
  const [focused, setFocused] = useState(false);
  const [settled, setSettled] = useState(0);
  // What the cell shows follows the row whenever nobody is typing in it.
  useEffect(() => {
    if (!focused) setDraft(text);
  }, [text, focused, settled]);
  const ref = useRef<HTMLTextAreaElement>(null);

  const leave = async () => {
    setFocused(false);
    if (!onCommit || draft === text) return;
    const kept = await onCommit(draft);
    if (!kept) setDraft(text);
    setSettled((count) => count + 1);
  };
  const key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      ref.current?.blur();
    }
    if (event.key === 'Escape') {
      setDraft(text);
      setTimeout(() => ref.current?.blur());
    }
  };
  return (
    <TableCell className="border-r p-0 align-top" title={title}>
      <textarea
        aria-label={label}
        className={cn(
          'block min-h-8 min-w-[max(100%,5.5rem)] resize-none bg-transparent px-2 py-1.5 leading-snug outline-none [field-sizing:content]',
          'focus:bg-background focus:ring-ring focus:ring-2 focus:ring-inset',
          numeric && 'text-right font-mono tabular-nums',
          wide ? 'min-w-56 max-w-[22rem]' : 'max-w-[14rem]',
          readOnly && 'text-muted-foreground cursor-default',
        )}
        onBlur={() => void leave()}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange?.(event.target.value);
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={key}
        readOnly={readOnly}
        ref={ref}
        rows={1}
        spellCheck={false}
        value={draft}
      />
    </TableCell>
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

// ── Which column a product's lines go in ────────────────────────────────────

function MoneyColumnsDialog({ onClose }: { onClose: () => void }) {
  const products = useRevenueProducts(true);
  const edits = useRevenueLogEdits();
  const [pending, setPending] = useState<string | null>(null);
  const change = (productId: string, column: RevenueColumn) => {
    setPending(productId);
    edits.saveProductColumn.mutate(
      { productId, column },
      {
        onError: (error) => toast.error('The column was not changed', { description: error.message }),
        onSettled: () => setPending(null),
      },
    );
  };
  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Money columns</DialogTitle>
          <DialogDescription>Where each product&apos;s invoice lines go. Unset is Labor Hours Income.</DialogDescription>
        </DialogHeader>
        {products.isPending ? (
          <PageSkeleton cards={0} />
        ) : products.isError ? (
          <ErrorState error={products.error} retry={() => void products.refetch()} />
        ) : (
          <ul className="divide-y">
            {products.data.products.map((product) => (
              <li className="flex items-center justify-between gap-3 py-2" key={product.productId}>
                <span className="min-w-0 text-sm">{product.name}</span>
                <Select disabled={pending === product.productId} onValueChange={(value) => change(product.productId, value as RevenueColumn)} value={product.column}>
                  <SelectTrigger aria-label={`Column for ${product.name}`} className="w-48 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {REVENUE_COLUMNS.map((column) => (
                      <SelectItem key={column} value={column}>
                        {REVENUE_COLUMN_LABEL[column]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

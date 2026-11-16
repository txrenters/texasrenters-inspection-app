'use client';

import { monthWords, percentText, weekOf, weekWords, type RevenueLogTechnician, type RevenueMonthReport, type SaveRevenueWeekInput } from '@texasrenters/shared';
import type { ReactNode } from 'react';
import { toast } from 'sonner';

import { GridCell, Sheet, SheetHead, TotalCell } from '@/components/actual-vs-budget/grid';
import { ErrorState, PageSkeleton } from '@/components/states';
import { DatePicker } from '@/components/ui/date-picker';
import { TableBody, TableHeader, TableRow } from '@/components/ui/table';
import { accounting, readCents } from '@/lib/actual-vs-budget-cells';
import { useRevenueMonth, useRevenuePeriodEdits } from '@/lib/actual-vs-budget-queries';

/**
 * Actual vs Budget's weekly and monthly reports (2026-11-17, PR 3), as the
 * workbook's weekly tabs ("Nov. 2-6") and its "Month of" tabs: TARGET REVENUE,
 * ACTUAL REVENUE, the difference, the percent and REMARKS, a TOTAL row at the
 * foot. A week's target and actual are worked out from the daily budgets and
 * the technician log, and typed over in the cell when they are not the week's.
 */

const HEADERS = [
  'TARGET REVENUE',
  'ACTUAL REVENUE',
  'DIFFERENCE (ACTUAL REVENUE - TARGET)',
  '% (ACTUAL REVENUE / TARGET REVENUE)',
] as const;

interface PeriodRow {
  technician: RevenueLogTechnician;
  targetCents: number;
  actualCents: number;
  remarks: string | null;
  typed?: { target: boolean; actual: boolean };
}

type Field = 'targetCents' | 'actualCents' | 'remarks';

function PeriodTable({
  title,
  rows,
  canEdit,
  editable,
  onSave,
}: {
  title: string;
  rows: PeriodRow[];
  canEdit: boolean;
  /** Which cells the office types into on this report. */
  editable: readonly Field[];
  onSave: (row: PeriodRow, input: Partial<Record<Field, number | string | null>>) => Promise<unknown>;
}) {
  const commit = (row: PeriodRow, field: Field, current: string) => async (typed: string) => {
    const text = typed.trim();
    if (text === current.trim()) return true;
    let value: number | string | null = text || null;
    if (text && field !== 'remarks') {
      value = readCents(text);
      if (value === null) {
        toast.error('Type an amount, like 3,550.00.');
        return false;
      }
    }
    try {
      await onSave(row, { [field]: value });
      return true;
    } catch (error) {
      toast.error('Not saved', { description: error instanceof Error ? error.message : undefined });
      return false;
    }
  };
  const can = (field: Field) => canEdit && editable.includes(field);
  const target = rows.reduce((sum, row) => sum + row.targetCents, 0);
  const actual = rows.reduce((sum, row) => sum + row.actualCents, 0);
  const label = (row: PeriodRow, header: string) => `${header}, ${row.technician.name}`;

  return (
    <Sheet>
      <TableHeader className="text-muted-foreground lg:static">
        <TableRow>
          <SheetHead span={6}>PERIOD COVERED: {title}</SheetHead>
        </TableRow>
        <TableRow>
          <SheetHead>TECHNICIAN</SheetHead>
          {HEADERS.map((header) => (
            <SheetHead key={header} numeric>
              {header}
            </SheetHead>
          ))}
          <SheetHead>REMARKS</SheetHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const targetText = accounting(row.targetCents);
          const actualText = accounting(row.actualCents);
          return (
            <TableRow className="hover:bg-transparent" key={row.technician.id}>
              <GridCell label={label(row, 'Technician')} readOnly text={row.technician.name.toUpperCase()} />
              <GridCell
                label={label(row, 'Target revenue')}
                numeric
                onCommit={can('targetCents') ? commit(row, 'targetCents', targetText) : undefined}
                readOnly={!can('targetCents')}
                text={targetText}
                title={row.typed?.target ? 'Typed by the office' : "The daily budget for each day worked"}
              />
              <GridCell
                label={label(row, 'Actual revenue')}
                numeric
                onCommit={can('actualCents') ? commit(row, 'actualCents', actualText) : undefined}
                readOnly={!can('actualCents')}
                text={actualText}
                title={row.typed?.actual ? 'Typed by the office' : "The log's labor income and service call fees"}
              />
              <GridCell label={label(row, 'Difference')} numeric readOnly text={accounting(row.actualCents - row.targetCents)} />
              <GridCell label={label(row, 'Percent of target')} numeric readOnly text={percentText(row.targetCents ? row.actualCents / row.targetCents : null)} />
              <GridCell
                label={label(row, 'Remarks')}
                onCommit={can('remarks') ? commit(row, 'remarks', row.remarks ?? '') : undefined}
                readOnly={!can('remarks')}
                text={row.remarks ?? ''}
                wide
              />
            </TableRow>
          );
        })}
        <TableRow className="bg-muted hover:bg-muted font-semibold">
          <TotalCell>TOTAL</TotalCell>
          <TotalCell numeric>{accounting(target)}</TotalCell>
          <TotalCell numeric>{accounting(actual)}</TotalCell>
          <TotalCell numeric>{accounting(actual - target)}</TotalCell>
          <TotalCell numeric>{percentText(target ? actual / target : null)}</TotalCell>
          <TotalCell />
        </TableRow>
      </TableBody>
    </Sheet>
  );
}

function MonthData({ date, children }: { date: string; children: (report: RevenueMonthReport) => ReactNode }) {
  const report = useRevenueMonth(date.slice(0, 7));
  if (report.isPending) return <PageSkeleton cards={0} />;
  if (report.isError) return <ErrorState error={report.error} retry={() => void report.refetch()} />;
  if (!report.data.technicians.length) return <p className="text-muted-foreground text-sm">No technician has a daily budget yet.</p>;
  return <>{children(report.data)}</>;
}

export function WeeklySheet({ canEdit, date, onDate }: { canEdit: boolean; date: string; onDate: (date: string) => void }) {
  const edits = useRevenuePeriodEdits();
  const week = weekOf(date);
  return (
    <div className="space-y-4">
      <DatePicker aria-label="A day in the week" className="w-56" onChange={onDate} value={date} />
      <MonthData date={date}>
        {(report) => {
          const shown = report.weeks.find((candidate) => candidate.from === week.from);
          return (
            <PeriodTable
              canEdit={canEdit}
              editable={['targetCents', 'actualCents', 'remarks']}
              onSave={(row, input) => edits.saveWeek.mutateAsync({ technicianId: row.technician.id, weekStart: week.from, input: input as SaveRevenueWeekInput })}
              rows={shown?.technicians ?? []}
              title={weekWords(week)}
            />
          );
        }}
      </MonthData>
    </div>
  );
}

export function MonthlySheet({ canEdit, date, onDate }: { canEdit: boolean; date: string; onDate: (date: string) => void }) {
  const edits = useRevenuePeriodEdits();
  const month = date.slice(0, 7);
  return (
    <div className="space-y-4">
      <DatePicker aria-label="A day in the month" className="w-56" onChange={onDate} value={date} />
      <MonthData date={date}>
        {(report) => (
          <PeriodTable
            canEdit={canEdit}
            editable={['remarks']}
            onSave={(row, input) => edits.saveMonth.mutateAsync({ technicianId: row.technician.id, month, input: { remarks: input.remarks as string | null } })}
            rows={report.technicians}
            title={monthWords(month)}
          />
        )}
      </MonthData>
    </div>
  );
}

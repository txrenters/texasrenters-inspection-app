'use client';

import {
  driveTimeTotal,
  hoursAndMinutes,
  hoursAndMinutesValue,
  payrollPeriodWords,
  percentText,
  secondsAsHours,
  trackerFigures,
  type RevenueDayTechnician,
  type SaveRevenueDayInput,
} from '@texasrenters/shared';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';

import { GridCell, Sheet, SheetHead, TotalCell } from '@/components/actual-vs-budget/grid';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TableBody, TableCell, TableHeader, TableRow } from '@/components/ui/table';
import { dollars, firstName, readCents, readWorkTime, sheetDate } from '@/lib/actual-vs-budget-cells';
import { useRevenueBudgets, useRevenueDay, useRevenueDayEdits } from '@/lib/actual-vs-budget-queries';

/**
 * Actual vs Budget's daily sheets (2026-11-17, PR 2): the workbook's "Next
 * Day's Projected Productivity", the daily "ACTUAL VS PROJECTED REVENUE" and
 * the "REVENUE TRACKER", one day across the technicians who have a budget.
 * Their figures come from each technician's log and the timesheet; the budget,
 * the hours worked and the remarks are typed into the cell, like the log.
 */

type DayField = keyof SaveRevenueDayInput;

/** Saves one typed cell of a technician's day; false keeps a mistyped cell out. */
function useDayCommit(date: string) {
  const edits = useRevenueDayEdits();
  return (row: RevenueDayTechnician, field: DayField, current: string) => async (typed: string) => {
    const text = typed.trim();
    let value: number | string | null = text || null;
    if (text && field === 'budgetCents') {
      value = readCents(text);
      if (value === null) return refuse('Budget: type an amount, like 610.00.');
    }
    if (text && field === 'workSeconds') {
      value = readWorkTime(text);
      if (value === null) return refuse("Work time: type hours and minutes, like 8h 25m.");
    }
    if (text === current.trim()) return true;
    try {
      await edits.saveDay.mutateAsync({ technicianId: row.technician.id, date, input: { [field]: value } });
      return true;
    } catch (error) {
      toast.error('Not saved', { description: error instanceof Error ? error.message : undefined });
      return false;
    }
  };
}

function refuse(problem: string) {
  toast.error(problem);
  return false;
}

/** The day's sheet, or its loading and error states, and the line saying nobody has a budget yet. */
function DayData({ date, children }: { date: string; children: (rows: RevenueDayTechnician[], period: { from: string; to: string }) => ReactNode }) {
  const day = useRevenueDay(date);
  if (day.isPending) return <PageSkeleton cards={0} />;
  if (day.isError) return <ErrorState error={day.error} retry={() => void day.refetch()} />;
  if (!day.data.technicians.length) return <p className="text-muted-foreground text-sm">No technician has a daily budget yet.</p>;
  return <>{children(day.data.technicians, day.data.payrollPeriod)}</>;
}

function DayPicker({ label, date, onDate }: { label: string; date: string; onDate: (date: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DatePicker aria-label={label} className="w-56" onChange={onDate} value={date} />
    </div>
  );
}

const cell = (row: RevenueDayTechnician, header: string) => `${header}, ${row.technician.name}`;

// ── Next Day's Projected Productivity ───────────────────────────────────────

export function ProjectionSheet({ canEdit, date, onDate }: { canEdit: boolean; date: string; onDate: (date: string) => void }) {
  const commit = useDayCommit(date);
  return (
    <div className="space-y-4">
      <DayPicker date={date} label="The day projected" onDate={onDate} />
      <DayData date={date}>
        {(rows) => (
          <Sheet>
            <TableHeader className="text-muted-foreground lg:static">
              <TableRow>
                <SheetHead span={5}>Next Day&apos;s Projected Productivity · Date: {sheetDate(date)}</SheetHead>
              </TableRow>
              <TableRow>
                <SheetHead>Technician</SheetHead>
                <SheetHead>Drive time</SheetHead>
                <SheetHead>Billable hours</SheetHead>
                <SheetHead numeric>Projected revenue</SheetHead>
                <SheetHead>Remarks</SheetHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow className="hover:bg-transparent" key={row.technician.id}>
                  <GridCell label={cell(row, 'Technician')} readOnly text={firstName(row.technician.name)} />
                  <GridCell label={cell(row, 'Drive time')} readOnly text={row.driveTime} />
                  <GridCell label={cell(row, 'Billable hours')} readOnly text={row.billableTime} />
                  <GridCell label={cell(row, 'Projected revenue')} numeric readOnly text={dollars(row.projectedCents)} />
                  <GridCell
                    label={cell(row, 'Remarks')}
                    onCommit={canEdit ? commit(row, 'projectionRemarks', row.projectionRemarks ?? '') : undefined}
                    readOnly={!canEdit}
                    text={row.projectionRemarks ?? ''}
                    wide
                  />
                </TableRow>
              ))}
              <TableRow className="bg-muted hover:bg-muted font-semibold">
                <TotalCell>Total</TotalCell>
                <TotalCell>{driveTimeTotal(rows.map((row) => row.driveTime))}</TotalCell>
                <TotalCell>{hoursAndMinutes(rows.reduce((sum, row) => sum + hoursAndMinutesValue(row.billableTime), 0))}</TotalCell>
                <TotalCell numeric>{dollars(sum(rows, (row) => row.projectedCents), { decimals: 0, negative: 'brackets' })}</TotalCell>
                <TotalCell />
              </TableRow>
            </TableBody>
          </Sheet>
        )}
      </DayData>
    </div>
  );
}

// ── ACTUAL VS PROJECTED REVENUE ─────────────────────────────────────────────

export function DailySheet({ canEdit, date, onDate }: { canEdit: boolean; date: string; onDate: (date: string) => void }) {
  const commit = useDayCommit(date);
  return (
    <div className="space-y-4">
      <DayPicker date={date} label="The day" onDate={onDate} />
      <DayData date={date}>
        {(rows) => {
          const budget = sum(rows, (row) => row.budgetCents);
          const actual = sum(rows, (row) => row.actualCents);
          return (
            <Sheet>
              <TableHeader className="text-muted-foreground lg:static">
                <TableRow>
                  <SheetHead span={8}>ACTUAL VS PROJECTED REVENUE · Date: {sheetDate(date)}</SheetHead>
                </TableRow>
                <TableRow>
                  <SheetHead>TECHNICIAN</SheetHead>
                  <SheetHead numeric>BUDGETED REVENUE</SheetHead>
                  <SheetHead numeric>PROJECTED REVENUE</SheetHead>
                  <SheetHead numeric>ACTUAL REVENUE</SheetHead>
                  <SheetHead numeric>DIFFERENCE (ACTUAL REVENUE - PROJECTED REVENUE)</SheetHead>
                  <SheetHead numeric>% (ACTUAL REVENUE / BUDGETED REVENUE)</SheetHead>
                  <SheetHead numeric>NO. OF WORK HOURS</SheetHead>
                  <SheetHead>REMARKS</SheetHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const budgetText = dollars(row.budgetCents, { decimals: 0 });
                  const workText = row.workSeconds === null ? '' : secondsAsHours(row.workSeconds);
                  return (
                    <TableRow className="hover:bg-transparent" key={row.technician.id}>
                      <GridCell label={cell(row, 'Technician')} readOnly text={row.technician.name.toUpperCase()} />
                      <GridCell
                        label={cell(row, 'Budgeted revenue')}
                        numeric
                        onCommit={canEdit ? commit(row, 'budgetCents', budgetText) : undefined}
                        readOnly={!canEdit}
                        text={budgetText}
                      />
                      <GridCell label={cell(row, 'Projected revenue')} numeric readOnly text={dollars(row.projectedCents, { decimals: 0 })} />
                      <GridCell label={cell(row, 'Actual revenue')} numeric readOnly text={dollars(row.actualCents)} />
                      <GridCell label={cell(row, 'Difference')} numeric readOnly text={dollars(row.actualCents - row.projectedCents)} />
                      <GridCell label={cell(row, 'Percent of budget')} numeric readOnly text={percentText(row.budgetCents ? row.actualCents / row.budgetCents : null)} />
                      <GridCell
                        label={cell(row, 'Work hours')}
                        numeric
                        onCommit={canEdit ? commit(row, 'workSeconds', workText) : undefined}
                        readOnly={!canEdit}
                        text={workText}
                        title={row.typed.work ? undefined : 'From the timesheet'}
                      />
                      <GridCell
                        label={cell(row, 'Remarks')}
                        onCommit={canEdit ? commit(row, 'dailyRemarks', row.dailyRemarks ?? '') : undefined}
                        readOnly={!canEdit}
                        text={row.dailyRemarks ?? ''}
                        wide
                      />
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted hover:bg-muted font-semibold">
                  <TotalCell>TOTAL</TotalCell>
                  <TotalCell numeric>{dollars(budget, { decimals: 0, negative: 'brackets' })}</TotalCell>
                  <TotalCell numeric>{dollars(sum(rows, (row) => row.projectedCents), { decimals: 0, negative: 'brackets' })}</TotalCell>
                  <TotalCell numeric>{dollars(actual, { negative: 'brackets' })}</TotalCell>
                  <TotalCell numeric>{dollars(sum(rows, (row) => row.actualCents - row.projectedCents), { negative: 'brackets' })}</TotalCell>
                  <TotalCell numeric>{percentText(budget ? actual / budget : null)}</TotalCell>
                  <TotalCell numeric>{secondsAsHours(sum(rows, (row) => row.workSeconds ?? 0))}</TotalCell>
                  <TotalCell />
                </TableRow>
              </TableBody>
            </Sheet>
          );
        }}
      </DayData>
    </div>
  );
}

// ── REVENUE TRACKER ─────────────────────────────────────────────────────────

export function TrackerSheet({ canEdit, date, onDate }: { canEdit: boolean; date: string; onDate: (date: string) => void }) {
  const commit = useDayCommit(date);
  return (
    <div className="space-y-4">
      <DayPicker date={date} label="The day" onDate={onDate} />
      <DayData date={date}>
        {(rows, period) => {
          const figures = rows.map((row) => trackerFigures(row));
          const total = (pick: (row: RevenueDayTechnician, index: number) => number) => rows.reduce((sum, row, index) => sum + pick(row, index), 0);
          const actual = total((row) => row.actualCents);
          const final = total((_, index) => figures[index]!.finalBudgetCents);
          const periodBudget = total((row) => row.period.budgetedCents);
          const periodActual = total((row) => row.period.actualCents);
          const money = (cents: number) => dollars(cents, { negative: 'brackets' });
          return (
            <Sheet>
              <TableHeader className="text-muted-foreground lg:static">
                <TableRow>
                  <SheetHead span={18}>REVENUE TRACKER · DATE: {sheetDate(date)}</SheetHead>
                </TableRow>
                <TableRow>
                  <SheetHead span={2} />
                  <SheetHead span={3}>DAILY PROJECTED REVENUE</SheetHead>
                  <SheetHead span={7}>DAILY ACTUAL REVENUE: {sheetDate(date)}</SheetHead>
                  <SheetHead span={6}>
                    As of {sheetDate(date)} for Payroll Period to Date ({payrollPeriodWords(period)})
                  </SheetHead>
                </TableRow>
                <TableRow>
                  <SheetHead>Technician</SheetHead>
                  <SheetHead numeric>Budgeted Daily Revenue (Regular 8 hour-work)</SheetHead>
                  <SheetHead>Drive Time</SheetHead>
                  <SheetHead>Billable Hours</SheetHead>
                  <SheetHead numeric>Projected Revenue</SheetHead>
                  <SheetHead numeric>Actual Revenue</SheetHead>
                  <SheetHead numeric>Tech&apos;s Work Time</SheetHead>
                  <SheetHead numeric>Tech&apos;s OT Hour</SheetHead>
                  <SheetHead numeric>OT Budget Add-On</SheetHead>
                  <SheetHead numeric>Adjusted Budget due to Tech&apos;s OT (Final Budget)</SheetHead>
                  <SheetHead numeric>Actual − Final Budget</SheetHead>
                  <SheetHead numeric>% of Budget</SheetHead>
                  <SheetHead numeric>UP-TO-DATE NO. OF REGULAR WORK HOURS</SheetHead>
                  <SheetHead numeric>UP-TO-DATE NO. OF OT HOURS</SheetHead>
                  <SheetHead numeric>UP-TO DATE BUDGETED REVENUE</SheetHead>
                  <SheetHead numeric>UP-TO DATE ACTUAL REVENUE</SheetHead>
                  <SheetHead numeric>% of Budget</SheetHead>
                  <SheetHead>Remarks</SheetHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => {
                  const day = figures[index]!;
                  const budgetText = money(row.budgetCents);
                  const workText = row.workSeconds === null ? '' : secondsAsHours(row.workSeconds);
                  return (
                    <TableRow className="hover:bg-transparent" key={row.technician.id}>
                      <GridCell label={cell(row, 'Technician')} readOnly text={row.technician.name} />
                      <GridCell
                        label={cell(row, 'Budgeted daily revenue')}
                        numeric
                        onCommit={canEdit ? commit(row, 'budgetCents', budgetText) : undefined}
                        readOnly={!canEdit}
                        text={budgetText}
                      />
                      <GridCell label={cell(row, 'Drive time')} readOnly text={row.driveTime} />
                      <GridCell label={cell(row, 'Billable hours')} readOnly text={row.billableTime} />
                      <GridCell label={cell(row, 'Projected revenue')} numeric readOnly text={money(row.projectedCents)} />
                      <GridCell label={cell(row, 'Actual revenue')} numeric readOnly text={money(row.actualCents)} />
                      <GridCell
                        label={cell(row, "Tech's work time")}
                        numeric
                        onCommit={canEdit ? commit(row, 'workSeconds', workText) : undefined}
                        readOnly={!canEdit}
                        text={workText}
                        title={row.typed.work ? undefined : 'From the timesheet'}
                      />
                      <GridCell label={cell(row, "Tech's OT hour")} numeric readOnly text={secondsAsHours(day.overtimeSeconds)} />
                      <GridCell label={cell(row, 'OT budget add-on')} numeric readOnly text={money(day.addOnCents)} />
                      <GridCell label={cell(row, 'Final budget')} numeric readOnly text={money(day.finalBudgetCents)} />
                      <GridCell label={cell(row, 'Actual minus final budget')} numeric readOnly text={money(day.overCents)} />
                      <GridCell label={cell(row, 'Percent of budget')} numeric readOnly text={percentText(day.share)} />
                      <GridCell label={cell(row, 'Regular hours to date')} numeric readOnly text={secondsAsHours(row.period.regularSeconds)} />
                      <GridCell label={cell(row, 'OT hours to date')} numeric readOnly text={secondsAsHours(row.period.overtimeSeconds)} />
                      <GridCell label={cell(row, 'Budgeted revenue to date')} numeric readOnly text={money(row.period.budgetedCents)} />
                      <GridCell label={cell(row, 'Actual revenue to date')} numeric readOnly text={money(row.period.actualCents)} />
                      <GridCell
                        label={cell(row, 'Percent of budget to date')}
                        numeric
                        readOnly
                        text={percentText(row.period.budgetedCents ? row.period.actualCents / row.period.budgetedCents : null)}
                      />
                      <GridCell
                        label={cell(row, 'Remarks')}
                        onCommit={canEdit ? commit(row, 'trackerRemarks', row.trackerRemarks ?? '') : undefined}
                        readOnly={!canEdit}
                        text={row.trackerRemarks ?? ''}
                        wide
                      />
                    </TableRow>
                  );
                })}
                <TableRow className="bg-muted hover:bg-muted font-semibold">
                  <TotalCell>Total</TotalCell>
                  <TotalCell numeric>{money(total((row) => row.budgetCents))}</TotalCell>
                  <TotalCell>{driveTimeTotal(rows.map((row) => row.driveTime))}</TotalCell>
                  <TotalCell>{hoursAndMinutes(total((row) => hoursAndMinutesValue(row.billableTime)))}</TotalCell>
                  <TotalCell numeric>{money(total((row) => row.projectedCents))}</TotalCell>
                  <TotalCell numeric>{money(actual)}</TotalCell>
                  <TotalCell numeric>{secondsAsHours(total((row) => row.workSeconds ?? 0))}</TotalCell>
                  <TotalCell numeric>{secondsAsHours(total((_, index) => figures[index]!.overtimeSeconds))}</TotalCell>
                  <TotalCell numeric>{money(total((_, index) => figures[index]!.addOnCents))}</TotalCell>
                  <TotalCell numeric>{money(final)}</TotalCell>
                  <TotalCell numeric>{money(total((_, index) => figures[index]!.overCents))}</TotalCell>
                  <TotalCell numeric>{percentText(final ? actual / final : null)}</TotalCell>
                  <TotalCell numeric>{secondsAsHours(total((row) => row.period.regularSeconds))}</TotalCell>
                  <TotalCell numeric>{secondsAsHours(total((row) => row.period.overtimeSeconds))}</TotalCell>
                  <TotalCell numeric>{money(periodBudget)}</TotalCell>
                  <TotalCell numeric>{money(periodActual)}</TotalCell>
                  <TotalCell numeric>{percentText(periodBudget ? periodActual / periodBudget : null)}</TotalCell>
                  <TotalCell />
                </TableRow>
              </TableBody>
            </Sheet>
          );
        }}
      </DayData>
    </div>
  );
}

const sum = <T,>(rows: readonly T[], pick: (row: T) => number) => rows.reduce((total, row) => total + pick(row), 0);

// ── Each technician's budget ────────────────────────────────────────────────

/** Each technician's daily budget and overtime rate, and the payroll periods. A blank budget leaves them off the daily sheets. */
export function BudgetsDialog({ onClose }: { onClose: () => void }) {
  const budgets = useRevenueBudgets(true);
  const edits = useRevenueDayEdits();
  const [draft, setDraft] = useState<Record<string, { budget: string; rate: string }> | null>(null);
  const [period, setPeriod] = useState<{ start: string; days: string } | null>(null);
  const loaded = budgets.data;
  const rows =
    draft ??
    Object.fromEntries(
      (loaded?.technicians ?? []).map((technician) => [
        technician.id,
        {
          budget: technician.dailyBudgetCents === null ? '' : (technician.dailyBudgetCents / 100).toFixed(2),
          rate: technician.otRateCents === null ? '' : (technician.otRateCents / 100).toFixed(2),
        },
      ]),
    );
  const periodDraft = period ?? { start: loaded?.payrollPeriodStart ?? '', days: String(loaded?.payrollPeriodDays ?? 14) };
  const set = (id: string, key: 'budget' | 'rate', value: string) => setDraft({ ...rows, [id]: { ...rows[id]!, [key]: value } });

  const save = () => {
    const technicians = [];
    for (const technician of loaded?.technicians ?? []) {
      const row = rows[technician.id]!;
      const budget = row.budget.trim() ? readCents(row.budget) : null;
      const rate = row.rate.trim() ? readCents(row.rate) : 0;
      if ((row.budget.trim() && budget === null) || rate === null) return void toast.error(`${technician.name}: type amounts, like 610.00.`);
      if (budget !== technician.dailyBudgetCents || (budget !== null && rate !== technician.otRateCents))
        technicians.push({ technicianId: technician.id, dailyBudgetCents: budget, otRateCents: budget === null ? null : rate });
    }
    const days = Number(periodDraft.days);
    if (!Number.isInteger(days) || days < 1 || days > 31) return void toast.error('Payroll period: 1 to 31 days.');
    edits.saveBudgets.mutate(
      { payrollPeriodStart: periodDraft.start, payrollPeriodDays: days, technicians },
      {
        onSuccess: () => {
          toast.success('Budgets saved');
          onClose();
        },
        onError: (error) => toast.error('Not saved', { description: error.message }),
      },
    );
  };

  return (
    <Dialog onOpenChange={(open) => (open ? null : onClose())} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Budgets</DialogTitle>
        </DialogHeader>
        {budgets.isPending ? (
          <PageSkeleton cards={0} />
        ) : budgets.isError ? (
          <ErrorState error={budgets.error} retry={() => void budgets.refetch()} />
        ) : (
          <div className="space-y-4">
            <Sheet>
              <TableHeader className="text-muted-foreground lg:static">
                <TableRow>
                  <SheetHead>Technician</SheetHead>
                  <SheetHead numeric>Budgeted Daily Revenue</SheetHead>
                  <SheetHead numeric>OT rate per hour</SheetHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loaded!.technicians.map((technician) => (
                  <TableRow className="hover:bg-transparent" key={technician.id}>
                    <TableCell className="border-r px-2 py-1.5">{technician.name}</TableCell>
                    <TableCell className="border-r p-0">
                      <Input aria-label={`Budgeted daily revenue, ${technician.name}`} className="h-8 rounded-none border-0 text-right font-mono shadow-none" onChange={(event) => set(technician.id, 'budget', event.target.value)} value={rows[technician.id]?.budget ?? ''} />
                    </TableCell>
                    <TableCell className="p-0">
                      <Input aria-label={`OT rate, ${technician.name}`} className="h-8 rounded-none border-0 text-right font-mono shadow-none" onChange={(event) => set(technician.id, 'rate', event.target.value)} value={rows[technician.id]?.rate ?? ''} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Sheet>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span>Payroll periods from</span>
              <DatePicker aria-label="First day of a payroll period" className="w-56" onChange={(start) => setPeriod({ ...periodDraft, start })} value={periodDraft.start} />
              <span>every</span>
              <Input aria-label="Days in a payroll period" className="h-9 w-16 text-right" onChange={(event) => setPeriod({ ...periodDraft, days: event.target.value })} value={periodDraft.days} />
              <span>days</span>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose} variant="outline">
            Cancel
          </Button>
          <Button disabled={!loaded || edits.saveBudgets.isPending} onClick={save}>
            {edits.saveBudgets.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

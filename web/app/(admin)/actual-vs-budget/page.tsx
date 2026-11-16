'use client';

import { useState } from 'react';

import { BudgetsDialog, DailySheet, ProjectionSheet, TrackerSheet } from '@/components/actual-vs-budget/daily-sheets';
import { MoneyColumnsDialog } from '@/components/actual-vs-budget/money-columns-dialog';
import { MonthlySheet, WeeklySheet } from '@/components/actual-vs-budget/period-sheets';
import { TechnicianLog } from '@/components/actual-vs-budget/technician-log';
import { PageHeader } from '@/components/page-header';
import { ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePermissions } from '@/lib/auth';
import { useRevenueTechnicians } from '@/lib/actual-vs-budget-queries';
import { businessToday, shiftDay } from '@/lib/clock';
import { useUrlState } from '@/lib/url-state';

/**
 * Actual vs Budget (2026-11-17): the office's "THMP Scheduling Actual Vs
 * Budget 2026.xlsx" in the console, one tab for each kind of sheet in it. PR 1
 * brought the technician log; PR 2 the three daily sheets -- next day's
 * projection, the daily actual vs projected report and the revenue tracker;
 * PR 3 the weekly and monthly reports.
 * Every sheet is a spreadsheet: the cells the console knows come filled, the
 * rest are typed into where they are.
 */

const VIEWS = [
  { key: 'log', label: 'Technician log' },
  { key: 'projection', label: "Next day's projection" },
  { key: 'daily', label: 'Actual vs projected' },
  { key: 'tracker', label: 'Revenue tracker' },
  { key: 'weekly', label: 'Weekly' },
  { key: 'monthly', label: 'Monthly' },
] as const;
type View = (typeof VIEWS)[number]['key'];

export default function ActualVsBudgetPage() {
  const { has } = usePermissions();
  const canEdit = has('invoices:manage');
  const today = businessToday();
  const [query, setQuery] = useUrlState({
    view: 'log',
    technician: '',
    from: shiftDay(today, -6),
    to: today,
    date: today,
    next: shiftDay(today, 1),
  });
  const technicians = useRevenueTechnicians();
  const [dialog, setDialog] = useState<'columns' | 'budgets' | null>(null);
  const view: View = VIEWS.some((entry) => entry.key === query.view) ? (query.view as View) : 'log';

  if (technicians.isPending) return <PageSkeleton />;
  if (technicians.isError) return <ErrorState error={technicians.error} retry={() => void technicians.refetch()} />;
  const list = technicians.data.technicians;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Actual vs Budget"
        actions={
          canEdit ? (
            <>
              <Button onClick={() => setDialog('budgets')} size="sm" variant="outline">
                Budgets
              </Button>
              <Button onClick={() => setDialog('columns')} size="sm" variant="outline">
                Money columns
              </Button>
            </>
          ) : null
        }
      />
      <Tabs onValueChange={(next) => setQuery({ view: next })} value={view}>
        <TabsList>
          {VIEWS.map((entry) => (
            <TabsTrigger key={entry.key} value={entry.key}>
              {entry.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {view === 'log' ? (
        <TechnicianLog
          canEdit={canEdit}
          from={query.from}
          onChange={(patch) => setQuery(patch)}
          technicianId={query.technician || list[0]?.id || ''}
          technicians={list}
          to={query.to}
        />
      ) : view === 'projection' ? (
        <ProjectionSheet canEdit={canEdit} date={query.next} onDate={(next) => setQuery({ next })} />
      ) : view === 'daily' ? (
        <DailySheet canEdit={canEdit} date={query.date} onDate={(date) => setQuery({ date })} />
      ) : view === 'tracker' ? (
        <TrackerSheet canEdit={canEdit} date={query.date} onDate={(date) => setQuery({ date })} />
      ) : view === 'weekly' ? (
        <WeeklySheet canEdit={canEdit} date={query.date} onDate={(date) => setQuery({ date })} />
      ) : (
        <MonthlySheet canEdit={canEdit} date={query.date} onDate={(date) => setQuery({ date })} />
      )}
      {dialog === 'columns' ? <MoneyColumnsDialog onClose={() => setDialog(null)} /> : null}
      {dialog === 'budgets' ? <BudgetsDialog onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

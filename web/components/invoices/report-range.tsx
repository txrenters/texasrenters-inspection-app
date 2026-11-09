'use client';

import {
  REPORT_RANGE_LABEL,
  REPORT_RANGE_PRESETS,
  reportRange,
  reportRangeProblem,
  type ReportRange,
  type ReportRangePreset,
} from '@texasrenters/shared';
import { useId } from 'react';

import { SelectFilter } from '@/components/list-toolbar';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { businessToday } from '@/lib/clock';

/**
 * A span of days, chosen as Jobber's reports choose one (2026-11-09): this
 * week, this month, the last 30 or 90 days, the last 12 months, this calendar
 * year, or a custom range -- and, on a list, every date.
 *
 * Held in the page's address as three words: the choice (`''` for every date,
 * a preset, or `custom`) and, for a custom range, its first and last day.
 */

export const ALL_DATES = '';
export const CUSTOM = 'custom';

const OPTIONS = [
  ...REPORT_RANGE_PRESETS.map((preset) => ({ value: preset as string, label: REPORT_RANGE_LABEL[preset] })),
  { value: CUSTOM, label: 'A custom range' },
];

export interface RangeChoice {
  range: string;
  from: string;
  to: string;
}

/** The days a choice covers, in Texas; null for every date, or a custom range not finished. */
export function chosenRange(choice: RangeChoice, today = businessToday()): ReportRange | null {
  if ((REPORT_RANGE_PRESETS as readonly string[]).includes(choice.range)) return reportRange(choice.range as ReportRangePreset, today);
  if (choice.range === CUSTOM && !reportRangeProblem({ from: choice.from, to: choice.to })) return { from: choice.from, to: choice.to };
  return null;
}

export function RangePicker({
  label,
  choice,
  onChange,
  allowAllDates = false,
}: {
  label: string;
  choice: RangeChoice;
  onChange: (next: RangeChoice) => void;
  /** On a list, where every date is the usual answer; never on a report. */
  allowAllDates?: boolean;
}) {
  const id = useId();
  const today = businessToday();
  const custom = choice.range === CUSTOM;
  const problem = custom && (choice.from || choice.to) ? reportRangeProblem({ from: choice.from, to: choice.to }) : null;
  // Picking custom starts from the days the earlier choice covered.
  const pick = (range: string) => {
    if (range !== CUSTOM) return onChange({ range, from: '', to: '' });
    const before = chosenRange(choice, today) ?? reportRange('last_30_days', today);
    onChange({ range, from: before.from, to: before.to });
  };
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      {allowAllDates ? (
        // On a list, it sits with the list's other filters and looks like them.
        <SelectFilter allLabel="All dates" label={label} onChange={pick} options={OPTIONS} value={choice.range} />
      ) : (
        <Select onValueChange={pick} value={choice.range}>
          <SelectTrigger aria-label={label} className="w-auto min-w-48">
            <span className="text-muted-foreground">{label}</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {custom ? (
        <>
          <Input
            aria-label={`${label}: first day`}
            className="h-9 w-auto"
            id={`${id}-from`}
            max={choice.to || today}
            onChange={(event) => onChange({ ...choice, from: event.target.value })}
            type="date"
            value={choice.from}
          />
          <span className="text-muted-foreground pb-1.5 text-sm">to</span>
          <Input
            aria-label={`${label}: last day`}
            className="h-9 w-auto"
            id={`${id}-to`}
            min={choice.from || undefined}
            onChange={(event) => onChange({ ...choice, to: event.target.value })}
            type="date"
            value={choice.to}
          />
          {problem ? (
            <p aria-live="polite" className="text-destructive w-full text-xs">
              {problem}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

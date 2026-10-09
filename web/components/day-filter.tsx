'use client';

import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { businessToday, shiftDay } from '@/lib/clock';

/**
 * One day of a list, picked as the timesheet picks it: the day before, the
 * picker, the day after, and Today -- plus All dates, which no day is.
 *
 * The office (2026-10-07): the inspections list had a "from" and a "to"
 * picker, and what it is read for is one day's visits -- "it's not a range we
 * want, but the date of the day ... a single picker" with "a today".
 *
 * `value` is a Texas day as `yyyy-MM-dd`, or null for every date.
 */
export function DayFilter({
  value,
  onChange,
  label = 'Scheduled on',
  max,
  allowAllDates = true,
}: {
  value: string | null;
  onChange: (day: string | null) => void;
  label?: string;
  /** The latest day that can be chosen (`yyyy-MM-dd`), e.g. today for the timesheet. */
  max?: string;
  /** False where "every date" means nothing, e.g. the timesheet. */
  allowAllDates?: boolean;
}) {
  const today = businessToday();
  // The arrows step from the day shown; from All dates, they step from today.
  const from = value ?? today;
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      <Button
        aria-label="The day before"
        onClick={() => onChange(shiftDay(from, -1))}
        size="icon"
        variant="outline"
      >
        <ChevronLeftIcon />
      </Button>
      <DatePicker
        aria-label={label}
        className="w-auto min-w-48"
        max={max}
        // Clearing the picker is All dates, not a day.
        onChange={(next) => onChange(next || (allowAllDates ? null : today))}
        placeholder={allowAllDates ? 'All dates' : 'Pick a day'}
        value={value ?? ''}
      />
      <Button
        aria-label="The day after"
        disabled={Boolean(max) && from >= max!}
        onClick={() => onChange(shiftDay(from, 1))}
        size="icon"
        variant="outline"
      >
        <ChevronRightIcon />
      </Button>
      {value !== today ? (
        <Button onClick={() => onChange(today)} size="sm" variant="secondary">
          Today
        </Button>
      ) : null}
      {allowAllDates && value !== null ? (
        <Button onClick={() => onChange(null)} size="sm" variant="ghost">
          All dates
        </Button>
      ) : null}
    </div>
  );
}

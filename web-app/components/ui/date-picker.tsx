'use client';

import { useState } from 'react';
import { CalendarIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/**
 * Formats a Date as the `yyyy-MM-dd` string the form and API exchange.
 *
 * Built from local parts rather than `toISOString`, which converts to UTC and
 * would hand back the previous day for anyone west of Greenwich after their
 * local midnight — booking an inspection a day earlier than the one clicked.
 */
export function toDateValue(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Parses `yyyy-MM-dd` as a local date, for the same reason. */
export function fromDateValue(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return undefined;
  const parsed = new Date(year, month - 1, day);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Calendar date field.
 *
 * Replaces the browser's date input, whose appearance and behaviour differ per
 * browser and which offered a time alongside the date that nothing used.
 */
export function DatePicker({
  id,
  value,
  onChange,
  placeholder = 'Select a date',
  disabled,
  'aria-describedby': describedBy,
}: {
  id?: string;
  /** `yyyy-MM-dd`, or empty when nothing is chosen. */
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  'aria-describedby'?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = fromDateValue(value);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-describedby={describedBy}
          className={cn(
            'w-full justify-start gap-2 font-normal',
            !selected && 'text-muted-foreground',
          )}
          disabled={disabled}
          id={id}
          type="button"
          variant="secondary"
        >
          <CalendarIcon className="size-4 shrink-0" aria-hidden />
          <span className="truncate">
            {selected
              ? selected.toLocaleDateString(undefined, {
                  weekday: 'short',
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })
              : placeholder}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          autoFocus
          mode="single"
          onSelect={(date) => {
            // Clearing is deliberate: selecting the same day again deselects,
            // and the form should record that rather than silently keep it.
            onChange(date ? toDateValue(date) : '');
            if (date) setOpen(false);
          }}
          selected={selected}
        />
      </PopoverContent>
    </Popover>
  );
}

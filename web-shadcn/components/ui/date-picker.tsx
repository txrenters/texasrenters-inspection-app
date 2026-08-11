'use client';

import { useState } from 'react';
import { CalendarIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { fromDateValue, toDateValue } from '@/lib/date-range';

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
  className,
  min,
  max,
  'aria-label': label,
  'aria-describedby': describedBy,
}: {
  id?: string;
  /** `yyyy-MM-dd`, or empty when nothing is chosen. */
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** `yyyy-MM-dd`. Earlier days are greyed out in the calendar. */
  min?: string;
  /** `yyyy-MM-dd`. Later days are greyed out in the calendar. */
  max?: string;
  /**
   * Needed wherever the trigger has no visible label of its own — once a date
   * is picked the button reads "Wed, 3 September 2026", which does not say
   * which end of a range it is.
   */
  'aria-label'?: string;
  'aria-describedby'?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = fromDateValue(value);
  const lowerBound = fromDateValue(min);
  const upperBound = fromDateValue(max);
  /**
   * An array of two matchers, not one `{ before, after }` object — that shape is
   * react-day-picker's *interval* matcher and would disable the days between the
   * bounds instead of the ones outside them.
   */
  const outOfBounds = [
    lowerBound ? { before: lowerBound } : undefined,
    upperBound ? { after: upperBound } : undefined,
  ].filter((matcher) => matcher !== undefined);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-describedby={describedBy}
          aria-label={label}
          className={cn(
            'w-full justify-start gap-2 font-normal',
            !selected && 'text-muted-foreground',
            className,
          )}
          disabled={disabled}
          id={id}
          type="button"
          variant="outline"
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
          // Greyed out rather than merely rejected, so an inverted range — a
          // "to" before its "from" — cannot be entered and then silently return
          // nothing.
          disabled={outOfBounds.length ? outOfBounds : undefined}
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

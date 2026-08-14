'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DayPicker } from 'react-day-picker';

import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

export type CalendarProps = React.ComponentProps<typeof DayPicker>;

/**
 * Month calendar used by the date picker.
 *
 * Styled against the app's own tokens rather than react-day-picker's defaults,
 * which assume a light theme and would render nearly invisible on this one.
 */
export function Calendar({ className, classNames, showOutsideDays = true, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row gap-4',
        month: 'flex flex-col gap-4',
        month_caption: 'flex justify-center pt-1 relative items-center',
        caption_label: 'text-sm font-medium',
        nav: 'flex items-center gap-1',
        button_previous: cn(
          buttonVariants({ variant: 'outline', size: 'icon-sm' }),
          'absolute left-1 top-1 size-7 p-0 opacity-70 hover:opacity-100',
        ),
        button_next: cn(
          buttonVariants({ variant: 'outline', size: 'icon-sm' }),
          'absolute right-1 top-1 size-7 p-0 opacity-70 hover:opacity-100',
        ),
        month_grid: 'w-full border-collapse space-y-1',
        weekdays: 'flex',
        weekday: 'text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]',
        week: 'flex w-full mt-2',
        day: 'size-9 text-center text-sm p-0 relative',
        day_button: cn(
          'size-9 p-0 font-normal rounded-md hover:bg-accent hover:text-accent-foreground',
          'aria-selected:bg-primary aria-selected:text-primary-foreground',
        ),
        selected: 'bg-primary text-primary-foreground rounded-md',
        // Ringed rather than filled, so today never looks like the selection.
        today: 'ring-1 ring-primary/50 rounded-md',
        outside: 'text-muted-foreground/50',
        disabled: 'text-muted-foreground/40 cursor-not-allowed',
        hidden: 'invisible',
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...rest }) =>
          orientation === 'left' ? (
            <ChevronLeft className="size-4" {...rest} />
          ) : (
            <ChevronRight className="size-4" {...rest} />
          ),
      }}
      {...props}
    />
  );
}

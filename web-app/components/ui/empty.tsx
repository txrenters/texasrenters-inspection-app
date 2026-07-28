import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * One empty-state system for "no records", "no results after filtering" and
 * "nothing captured yet". Previously each screen invented its own centred div.
 */
export function Empty({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty"
      className={cn(
        'flex min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-border p-8 text-center text-balance',
        className,
      )}
      {...props}
    />
  );
}

export function EmptyHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-header"
      className={cn('flex max-w-sm flex-col items-center gap-2 text-center', className)}
      {...props}
    />
  );
}

export function EmptyMedia({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-media"
      className={cn(
        'mb-2 flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-5',
        className,
      )}
      {...props}
    />
  );
}

export function EmptyTitle({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-title"
      className={cn('text-base font-medium tracking-tight', className)}
      {...props}
    />
  );
}

export function EmptyDescription({ className, ...props }: ComponentProps<'p'>) {
  return (
    <p
      data-slot="empty-description"
      className={cn('text-sm/relaxed text-muted-foreground', className)}
      {...props}
    />
  );
}

export function EmptyContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="empty-content"
      className={cn('flex w-full max-w-sm flex-col items-center gap-2 text-sm', className)}
      {...props}
    />
  );
}

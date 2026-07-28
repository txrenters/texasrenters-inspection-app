import { Slot } from '@radix-ui/react-slot';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Equivalent of the legacy `.panel` block.
 *
 * `asChild` matters for this migration: most panels are `<section>` or
 * `<article>` elements, and silently demoting them to `<div>` would strip
 * landmark semantics that screen-reader users navigate by.
 */
export function Card({
  className,
  asChild = false,
  ...props
}: ComponentProps<'div'> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'div';
  return (
    <Comp
      className={cn(
        'rounded-xl border border-border bg-card text-foreground shadow-[var(--shadow-sm)]',
        className,
      )}
      {...props}
    />
  );
}

/** Equivalent of `.panel-header`. */
export function CardHeader({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-start justify-between gap-4 px-5 pt-5 pb-3', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-base font-bold leading-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('text-[13px] text-muted-foreground', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('flex items-center gap-3 border-t border-border px-5 py-3', className)}
      {...props}
    />
  );
}

import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

/**
 * Loading placeholder. `motion-safe` so the pulse respects a reduced-motion
 * preference rather than animating regardless.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn('motion-safe:animate-pulse rounded-md bg-muted', className)}
      aria-hidden
      {...props}
    />
  );
}

import type { ComponentType, ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * A single number, with what it counts and what to do about it.
 *
 * The old `MetricCard` carried a coloured left rail whose tone was passed in per
 * call site, so the same figure was blue on one screen and amber on another and
 * neither meant anything. Tone here is reserved for the two cases where a number
 * is genuinely actionable — a queue that needs attention, a failure count — and
 * is expressed on the value, not as a decorative stripe.
 */
export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = 'default',
  action,
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: string;
  icon?: ComponentType<{ className?: string }>;
  tone?: 'default' | 'warning' | 'destructive' | 'success';
  action?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn('gap-0 p-5', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-muted-foreground text-sm font-medium">{label}</p>
        {Icon ? <Icon className="text-muted-foreground size-4 shrink-0" /> : null}
      </div>
      <p
        className={cn(
          'mt-2 text-2xl font-semibold tracking-tight tabular-nums',
          tone === 'warning' && 'text-warning',
          tone === 'destructive' && 'text-destructive',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </p>
      {detail ? <p className="text-muted-foreground mt-1 text-xs">{detail}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </Card>
  );
}

export function StatCardSkeleton() {
  return (
    <Card className="gap-0 p-5">
      <Skeleton className="h-4 w-24" />
      <Skeleton className="mt-3 h-7 w-16" />
      <Skeleton className="mt-2 h-3 w-32" />
    </Card>
  );
}

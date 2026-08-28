'use client';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Whether an account has the application open right now.
 *
 * Says "app open", not "at work". Presence comes from a live websocket, so a
 * technician whose phone has backgrounded the app reads as offline while they
 * are still on shift — and a dot that implied otherwise would be read as an
 * attendance signal it cannot support.
 *
 * That is also why "offline" and "never connected" are drawn apart: a hollow
 * dot with a last-seen time means they were here and left, while one with no
 * time means this account has never opened the app at all, which is usually a
 * provisioning problem rather than an absence.
 */
export function PresenceIndicator({
  isOnline,
  lastSeenAt,
  className,
}: {
  isOnline?: boolean;
  lastSeenAt?: string | null;
  className?: string;
}) {
  const label = isOnline
    ? 'App open now'
    : lastSeenAt
      ? `Last open ${formatRelative(lastSeenAt)}`
      : 'Has never opened the app';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn('inline-flex items-center gap-1.5', className)}>
          <span
            aria-hidden
            className={cn(
              'size-2 shrink-0 rounded-full',
              isOnline ? 'bg-success' : lastSeenAt ? 'border-muted-foreground/50 border' : 'bg-muted-foreground/30',
            )}
          />
          <span className="sr-only">{label}</span>
          <span className="text-muted-foreground text-xs" aria-hidden>
            {isOnline ? 'Online' : lastSeenAt ? formatRelative(lastSeenAt) : '—'}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

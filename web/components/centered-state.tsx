import type { ReactNode } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

/**
 * Full-viewport state for the moments before the shell exists — restoring a
 * session, a profile that failed to load, an access refusal.
 *
 * Deliberately not a Card: there is no page around it yet, and a card floating
 * in an otherwise empty viewport reads as a broken layout rather than a state.
 */
export function CenteredState({
  title,
  description,
  busy,
  tone = 'default',
  children,
}: {
  title: string;
  description?: string;
  busy?: boolean;
  tone?: 'default' | 'destructive';
  children?: ReactNode;
}) {
  return (
    <div
      className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center"
      role={tone === 'destructive' ? 'alert' : 'status'}
      aria-busy={busy}
    >
      {busy ? <Spinner className="text-muted-foreground size-6" /> : null}
      <div className="space-y-1.5">
        <h1
          className={cn(
            'text-lg font-semibold tracking-tight',
            tone === 'destructive' && 'text-destructive',
          )}
        >
          {title}
        </h1>
        {description ? (
          <p className="text-muted-foreground max-w-md text-sm">{description}</p>
        ) : null}
      </div>
      {children ? <div className="flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}

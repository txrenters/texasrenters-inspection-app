'use client';

import { AlertTriangleIcon, InboxIcon, RotateCcwIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api';

/**
 * The wait on a detail screen.
 *
 * Shaped like the page it replaces — a title, then cards — rather than the old
 * app's single centred spinner, which gave no hint of what was about to appear
 * and made every detail page look identical while loading.
 */
export function PageSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-4">
      <div className="space-y-2 pb-1">
        <Skeleton className="h-7 w-64" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      {Array.from({ length: cards }, (_, index) => (
        <Skeleton className="h-44 rounded-xl" key={index} />
      ))}
    </div>
  );
}

/**
 * The three states every data surface has, shaped identically.
 *
 * All three are the same height and the same shape, so a list that loads, finds
 * nothing, then fails does not resize the page under the reader each time.
 */
export function EmptyState({
  title,
  description,
  icon: Icon = InboxIcon,
  children,
}: {
  title: string;
  description?: string;
  icon?: ComponentType<{ className?: string }>;
  children?: ReactNode;
}) {
  return (
    <Empty className="bg-card rounded-xl border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  );
}

/**
 * A failed request.
 *
 * Shows the request id when the API supplied one. The old app dropped it, so a
 * report of "it said the request could not be completed" carried nothing that
 * could be found in a log.
 */
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const message =
    error instanceof Error ? error.message : 'An unexpected error occurred loading this data.';
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  return (
    <Empty className="bg-card rounded-xl border" role="alert">
      <EmptyHeader>
        <EmptyMedia variant="icon" className="bg-destructive/10 text-destructive">
          <AlertTriangleIcon />
        </EmptyMedia>
        <EmptyTitle>This data could not be loaded</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        {retry ? (
          <Button variant="outline" onClick={retry}>
            <RotateCcwIcon />
            Try again
          </Button>
        ) : null}
        {requestId ? (
          <p className="text-muted-foreground w-full font-mono text-xs">Request {requestId}</p>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}

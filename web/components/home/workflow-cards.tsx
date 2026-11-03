'use client';

import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';

import { Skeleton } from '@/components/ui/skeleton';
import { formatCount } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface WorkflowCard {
  key: string;
  title: string;
  icon: LucideIcon;
  /** The card's top edge and its icon, as Jobber colours each stage. Whole class names. */
  edge: string;
  iconTone: string;
  href: string;
  /** Null while it is still being read. */
  value: number | null;
  /** The read failed: a dash, rather than a figure that is loading for ever. */
  unavailable?: boolean;
  /** What the figure is: "To answer", "Need a technician". */
  word: string;
  /** Warns when the figure is somebody's work. */
  urgent?: boolean;
  rows: { label: string; value: number | null }[];
}

/**
 * Jobber's "Workflow": a card per stage of the work, each with a coloured top
 * edge, the figure that needs somebody, what it is, and two counts under it.
 * Jobber's stages are requests, quotes, jobs and invoices; the console's are a
 * visit asked to be booked again, a visit with nobody on it, today's work, and
 * work that needs a follow-up. Each card is a link to the list behind it.
 */
export function WorkflowCards({ cards }: { cards: readonly WorkflowCard[] }) {
  return (
    <section aria-labelledby="workflow-heading" className="flex flex-col gap-3">
      <h2 className="text-heading text-xl font-bold" id="workflow-heading">
        Workflow
      </h2>
      <div
        className={cn(
          'grid gap-3 sm:grid-cols-2',
          cards.length === 4 ? 'xl:grid-cols-4' : cards.length === 3 ? 'xl:grid-cols-3' : undefined,
        )}
      >
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Link
              className={cn(
                'bg-card hover:bg-accent/40 focus-visible:ring-ring/50 flex min-w-0 flex-col rounded-lg border border-t-4 p-4 outline-none focus-visible:ring-[3px]',
                card.edge,
              )}
              href={card.href}
              key={card.key}
            >
              <span className="text-muted-foreground flex items-center gap-2 text-sm">
                <Icon aria-hidden className={cn('size-4 shrink-0', card.iconTone)} />
                {card.title}
              </span>
              {card.unavailable ? (
                <span className="font-display text-muted-foreground mt-2 text-4xl leading-tight font-extrabold" title="Could not be read just now">
                  —
                </span>
              ) : card.value === null ? (
                <Skeleton className="mt-3 h-9 w-16" />
              ) : (
                <span
                  className={cn(
                    'font-display mt-2 text-4xl leading-tight font-extrabold tabular-nums',
                    card.urgent && card.value ? 'text-warning' : 'text-heading',
                  )}
                >
                  {formatCount(card.value)}
                </span>
              )}
              <span className="text-heading text-base font-bold">{card.word}</span>
              <dl className="mt-3 flex flex-col gap-1 text-sm">
                {card.rows.map((row) => (
                  <div className="flex items-baseline justify-between gap-3" key={row.label}>
                    <dt className="text-muted-foreground min-w-0 truncate">{row.label}</dt>
                    <dd className="text-foreground shrink-0 font-mono tabular-nums">
                      {card.unavailable ? '—' : row.value === null ? '…' : formatCount(row.value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

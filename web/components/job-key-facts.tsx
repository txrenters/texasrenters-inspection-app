import Link from 'next/link';

import type { JobFact } from '@/lib/job-facts';
import { cn } from '@/lib/utils';

/**
 * The job's key facts, in one strip under its title.
 *
 * One bordered surface cut by hairlines, whatever the number of facts: each
 * cell draws its own right and bottom edge and the strip clips the outer ones,
 * so a last row that is not full leaves card, not a block of border colour.
 */
export function JobKeyFacts({ facts, className }: { facts: JobFact[]; className?: string }) {
  if (!facts.length) return null;
  return (
    <section aria-label="Key information" className={cn('bg-card overflow-hidden rounded-xl border', className)}>
      <dl className="-mr-px -mb-px grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        {facts.map((fact) => (
          <div className="min-w-0 border-r border-b px-4 py-3" key={fact.key}>
            <dt className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
              {fact.tone === 'warning' ? (
                <span aria-hidden className="bg-warning size-1.5 shrink-0 rounded-full" />
              ) : null}
              {fact.label}
            </dt>
            <dd className="mt-0.5 min-w-0">
              {/* Wrapped, never cut short: an access note or an alert is read whole or not at all. */}
              <span className="text-heading block text-[15px] leading-snug font-semibold wrap-anywhere">
                {fact.href ? (
                  <Link className="underline underline-offset-4" href={fact.href}>
                    {fact.value}
                  </Link>
                ) : (
                  fact.value
                )}
              </span>
              {fact.meter ? (
                <span aria-hidden className="mt-1.5 flex gap-0.5">
                  {fact.meter.map((mark, index) => (
                    <span
                      className={cn('h-1.5 flex-1 rounded-full', mark === 'done' ? 'bg-plan-done' : 'bg-warning')}
                      key={index}
                    />
                  ))}
                </span>
              ) : null}
              {fact.detail ? (
                <span className="text-muted-foreground mt-0.5 block text-xs wrap-anywhere">{fact.detail}</span>
              ) : null}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

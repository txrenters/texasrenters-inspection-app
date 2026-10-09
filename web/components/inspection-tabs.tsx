'use client';

import Link from 'next/link';

import { cn } from '@/lib/utils';

/**
 * Navigation between an inspection's sub-pages.
 *
 * Exists because two of them were unreachable. `/charge-report` and the
 * move-in vs move-out comparison were both fully built, but nothing linked to
 * either: the comparison was rendered inline near the bottom of a 490-line
 * detail page and only for MOVE_OUT, and the charge report had a route and no
 * entry point at all. A reviewer had to know the URL.
 */
export type InspectionTabKey = 'overview' | 'comparison' | 'summaries' | 'charges';

/**
 * The inspections walked room by room on video, whose recordings are
 * summarized: a move-in and a move-out. The others record nothing to
 * summarize, and an always-empty tab would teach reviewers to ignore the row.
 */
const SUMMARIZED_TYPES = new Set(['MOVE_IN', 'MOVE_OUT']);

/**
 * The comparison tab is offered only on a move-out.
 *
 * Not a discoverability compromise — a move-in *is* the baseline, so there is
 * nothing for it to be compared against. Showing an always-empty tab on every
 * other inspection would teach reviewers to ignore the row.
 */
export function InspectionTabs({
  inspectionId,
  inspectionType,
  active,
}: {
  inspectionId: string;
  inspectionType: string;
  active: InspectionTabKey;
}) {
  const base = `/inspections/${inspectionId}`;
  /**
   * Charges is hidden for now (the office, 2026-10-05): not one charge had been
   * recorded on any inspection. Its page is still there at `/charge-report`,
   * and shows itself as the tab it is while open, so the way back is the tab.
   */
  const tabs: { key: InspectionTabKey; label: string; href: string }[] = [
    { key: 'overview', label: 'Overview', href: base },
    ...(inspectionType === 'MOVE_OUT'
      ? [{ key: 'comparison' as const, label: 'Move-in comparison', href: `${base}/comparison` }]
      : []),
    // Every area's summary on one page (the maintenance team, 2026-10-07).
    ...(SUMMARIZED_TYPES.has(inspectionType)
      ? [{ key: 'summaries' as const, label: 'Summaries of all areas', href: `${base}/summaries` }]
      : []),
    ...(active === 'charges'
      ? [{ key: 'charges' as const, label: 'Charges', href: `${base}/charge-report` }]
      : []),
  ];
  // A bar holding only the page you are on says nothing: an occupied or an
  // HVAC inspection has just its overview now.
  if (tabs.length < 2) return null;

  return (
    <nav aria-label="Inspection sections" className="border-border border-b">
      {/* Scrolls sideways on a phone rather than pushing the page wider: three
          tabs of plain links overflowed 375px (console-development). */}
      <ul className="-mb-px flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {tabs.map((tab) => {
          /**
           * Driven by `active` alone, which each page states for itself.
           *
           * Deriving it from the pathname as well seemed helpful and was not:
           * the overview lives at the base route, so any comparison against it
           * lights the overview up on every sub-page too, and two tabs claim
           * aria-current="page" at once.
           */
          const isActive = tab.key === active;
          return (
            <li className="shrink-0" key={tab.key}>
              <Link
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'inline-block border-b-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors',
                  // The accent for "you are here"; primary is ink now
                  // (console-development).
                  isActive
                    ? 'border-highlight text-foreground'
                    : 'text-muted-foreground hover:text-foreground border-transparent',
                )}
                href={tab.href}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

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
export type InspectionTabKey = 'overview' | 'comparison' | 'charges';

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
  const tabs: { key: InspectionTabKey; label: string; href: string }[] = [
    { key: 'overview', label: 'Overview', href: base },
    ...(inspectionType === 'MOVE_OUT'
      ? [{ key: 'comparison' as const, label: 'Move-in comparison', href: `${base}/comparison` }]
      : []),
    { key: 'charges', label: 'Charges', href: `${base}/charge-report` },
  ];

  return (
    <nav aria-label="Inspection sections" className="border-border border-b">
      <ul className="-mb-px flex gap-1">
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
            <li key={tab.key}>
              <Link
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'inline-block border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-primary text-foreground'
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

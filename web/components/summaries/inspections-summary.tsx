'use client';

import { ListSummary } from '@/components/list-summary';
import { businessToday } from '@/lib/clock';
import { dayWindow, figureOf, listHref, trendOf } from '@/lib/list-summary';
import { useInspections } from '@/lib/queries';

/**
 * The Inspections list's strip in the Jobber-style shell, as Jobber's Jobs
 * list has one: what needs somebody, and how the work is moving.
 *
 * For the type being looked at -- a move-out list counts move-outs -- and not
 * narrowed by the list's own search or filters, so it stays put while somebody
 * works the list below it, as Jobber's does.
 *
 * Reads: seven one-row pages of the inspection list (only `total` is used),
 * once per type, never polled. Nothing billed.
 */
export function InspectionsSummary({ type }: { type: string }) {
  const today = businessToday();
  const base = { page: 1, pageSize: 1, inspectionType: type || undefined };

  const unassigned = figureOf(useInspections({ ...base, unassignedOnly: true }));
  const inProgress = figureOf(useInspections({ ...base, status: 'IN_PROGRESS' }));
  const followUp = figureOf(useInspections({ ...base, status: 'FOLLOW_UP' }));
  const noAccess = figureOf(useInspections({ ...base, status: 'COULD_NOT_GET_IN' }));
  const donePast = figureOf(useInspections({ ...base, status: 'DONE', ...dayWindow(today, -30, -1) }));
  const donePrior = figureOf(useInspections({ ...base, status: 'DONE', ...dayWindow(today, -60, -31) }));
  const bookedNext = figureOf(useInspections({ ...base, status: 'SCHEDULED', ...dayWindow(today, 0, 29) }));

  const href = (params: Record<string, string>) => listHref('/inspections', { ...params, day: 'all', type: type || undefined });

  return (
    <ListSummary
      label="Inspections at a glance"
      metrics={[
        {
          title: 'Visits done',
          caption: 'Past 30 days',
          value: donePast,
          trend: trendOf(donePast, donePrior),
          moreIsBetter: true,
          comparedWith: 'on the 30 days before',
          href: href({ status: 'DONE' }),
        },
        {
          title: 'Visits booked',
          caption: 'Next 30 days, not started',
          value: bookedNext,
          href: href({ status: 'SCHEDULED' }),
        },
      ]}
      overview={[
        { label: 'Need a technician', value: unassigned, dot: 'bg-warning', href: href({ tech: 'unassigned' }) },
        { label: 'In progress', value: inProgress, dot: 'bg-info', href: href({ status: 'IN_PROGRESS' }) },
        { label: 'Follow-up required', value: followUp, dot: 'bg-destructive', href: href({ status: 'FOLLOW_UP' }) },
        { label: 'Could not get in', value: noAccess, dot: 'bg-muted-foreground', href: href({ status: 'COULD_NOT_GET_IN' }) },
      ]}
    />
  );
}

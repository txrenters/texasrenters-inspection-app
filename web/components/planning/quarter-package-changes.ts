import type { QuarterPackageChanges, QuarterPackageEvent, QuarterVisitPlace } from '@texasrenters/shared';

import { formatShortDay } from '@/lib/planning';

import { leftReasonText } from './package-changes';

/**
 * The words for the benefit package's changes as a quarter sees them (the
 * office, 2026-10-15): who left since last quarter and where they were
 * visited, who is new and where this quarter put them.
 */

/** "Nov 4 · Sam Tech", "taken out of the plan", "in Jobber with no day"; the group is drawn beside it. */
export function placeText(place: QuarterVisitPlace): string {
  if (place.status === 'EXCLUDED') return 'taken out of the plan';
  if (!place.scheduledOn) return place.status === 'UNSCHEDULED' ? 'in Jobber with no day' : 'no day yet';
  return [formatShortDay(place.scheduledOn), place.technician].filter(Boolean).join(' · ');
}

/**
 * A leaver whose visit this quarter is still going ahead: published, so in
 * Jobber or on somebody's day, which no switch cancels by itself.
 */
export const stillVisitedThisQuarter = (place: QuarterVisitPlace | null) =>
  Boolean(place && place.status !== 'EXCLUDED');

/** "2 left the package · 3 new since Q3 2026", or null when nothing moved. */
export function quarterChangesSummary(changes: Pick<QuarterPackageChanges, 'left' | 'joined'>, since: string | null): string | null {
  const parts = [
    changes.left.length ? `${changes.left.length.toLocaleString()} left the package` : null,
    changes.joined.length ? `${changes.joined.length.toLocaleString()} new` : null,
  ].filter((part): part is string => part !== null);
  if (!parts.length) return null;
  return since ? `${parts.join(' · ')} since ${since}` : parts.join(' · ');
}

/** "Left: not enrolled on the tenant report: it says No", or "Joined". */
export function eventText(event: Pick<QuarterPackageEvent, 'kind' | 'reason' | 'detail'>): string {
  if (event.kind === 'JOINED') return 'Joined';
  if (!event.reason) return 'Left: no tenancy is placed there any more';
  const why = leftReasonText({ code: event.reason, since: null, by: null, detail: event.detail });
  return `Left: ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
}

/** "Tenant report", or "Office, Erika" for a switch on the property's page. */
export const eventSource = (event: Pick<QuarterPackageEvent, 'source' | 'by'>) =>
  event.source === 'TENANT_REPORT' ? 'Tenant report' : event.by ? `Office, ${event.by}` : 'Office';

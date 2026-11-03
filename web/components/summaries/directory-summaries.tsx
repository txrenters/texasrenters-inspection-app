'use client';

import { ListSummary } from '@/components/list-summary';
import { rescheduleBreakdown } from '@/lib/home-workflow';
import { figureOf } from '@/lib/list-summary';
import { useProperties, useTenants } from '@/lib/queries';
import { useRescheduleRequests } from '@/lib/reschedule-queries';

/**
 * The Properties, Tenants and Reschedules strips in the Jobber-style shell, as
 * Jobber's Clients and Requests lists have one. Each asks for the same counts
 * its page's tabs already ask for, with the same keys, so most of them are
 * read once for both. None is narrowed by the list's search, so the strip stays
 * put while somebody works the list.
 */

/** Properties: one-row pages, three of them the tabs' own with no search in force. */
export function PropertiesSummary() {
  const base = { search: '', portfolioId: '', active: true, pageSize: 1 };
  const all = figureOf(useProperties(base));
  const occupied = figureOf(useProperties({ ...base, occupancy: 'OCCUPIED' }));
  const vacant = figureOf(useProperties({ ...base, occupancy: 'VACANT' }));
  const movingOut = figureOf(useProperties({ ...base, hasUpcomingMoveOut: 'true' }));

  return (
    <ListSummary
      label="Properties at a glance"
      metrics={[{ title: 'Active properties', caption: 'Under management, from Propertyware', value: all }]}
      overview={[
        { label: 'Occupied', value: occupied, dot: 'bg-success', href: '/properties?occupancy=OCCUPIED' },
        { label: 'Vacant', value: vacant, dot: 'bg-warning', href: '/properties?occupancy=VACANT' },
        { label: 'Move-out coming up', value: movingOut, dot: 'bg-info', href: '/lease-schedule' },
      ]}
    />
  );
}

/** Tenants: the tabs' own three counts, with no search in force. */
export function TenantsSummary() {
  const base = { search: '', active: true, pageSize: 1 };
  const all = figureOf(useTenants(base));
  const enrolled = figureOf(useTenants({ ...base, enrollment: 'TBP' }));
  const notEnrolled = figureOf(useTenants({ ...base, enrollment: 'NOT_TBP' }));

  return (
    <ListSummary
      label="Tenants at a glance"
      metrics={[{ title: 'Active tenants', caption: 'From the office’s Propertyware report', value: all }]}
      overview={[
        { label: 'In the benefit package', value: enrolled, dot: 'bg-success', href: '/tenants?enrollment=TBP' },
        { label: 'Not enrolled', value: notEnrolled, dot: 'bg-muted-foreground', href: '/tenants?enrollment=NOT_TBP' },
      ]}
    />
  );
}

/** Reschedules: the open queue the page itself reads, by why each was asked. */
export function ReschedulesSummary() {
  const requests = useRescheduleRequests('open');
  const open = requests.data;
  const asked = open ? rescheduleBreakdown(open.items) : null;
  // A dash for each figure once the read has failed, as for the other strips.
  const failed = requests.isError ? null : undefined;

  return (
    <ListSummary
      label="Reschedules at a glance"
      metrics={[
        { title: 'To answer', caption: 'Open requests', value: open?.counts.open ?? failed },
        { title: 'Sending to Jobber', caption: 'Answered, Jobber not told yet', value: open?.counts.sending ?? failed },
      ]}
      overview={[
        { label: 'Could not get in', value: asked?.NO_ACCESS ?? failed, dot: 'bg-warning' },
        { label: 'Asked before the visit', value: asked?.BEFORE_VISIT ?? failed, dot: 'bg-info' },
        { label: 'Not done on the visit', value: asked?.SERVICES_NOT_DONE ?? failed, dot: 'bg-destructive' },
      ]}
    />
  );
}

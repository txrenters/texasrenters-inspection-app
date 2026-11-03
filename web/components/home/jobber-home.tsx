'use client';

import type { AdminDashboard, JobberDayComparison } from '@texasrenters/shared';
import type { UseQueryResult } from '@tanstack/react-query';
import { CalendarSyncIcon, ClipboardCheckIcon, FlagIcon, UserRoundXIcon } from 'lucide-react';
import { useSyncExternalStore, type ReactNode } from 'react';

import { ErrorState } from '@/components/states';
import { useAuth, usePermissions } from '@/lib/auth';
import { businessToday } from '@/lib/clock';
import {
  FOLLOW_UP_QUERY,
  firstName,
  greetingFor,
  overdueQuery,
  rescheduleBreakdown,
  texasDayLabel,
  todayBuckets,
} from '@/lib/home-workflow';
import { useInspections } from '@/lib/queries';
import { useRescheduleRequests } from '@/lib/reschedule-queries';

import { TodaysVisits } from './todays-visits';
import { WorkflowCards, type WorkflowCard } from './workflow-cards';

const NEVER_CHANGES = () => () => {};

/**
 * The greeting, by the reader's clock. The server cannot know the reader's
 * hour, so it and the first paint say "Welcome back" and the browser corrects
 * it once hydrated, without a mismatch.
 */
function useGreeting() {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => greetingFor(new Date().getHours()),
    () => 'Welcome back',
  );
}

/**
 * Home in the Jobber-style shell, laid out as Jobber's (the office,
 * 2026-11-04: "we want the features for familiarity"): the day and a greeting,
 * the Workflow cards, and today's visits. The classic dashboard's panels --
 * today against Jobber, what needs a person, the systems, the portfolio --
 * follow underneath as `children`, so nothing the dashboard offered is lost.
 *
 * Beyond what the dashboard already reads, this asks for three things, once
 * each and never polled: the open reschedule requests (only for an account
 * that may answer them), the follow-up count (a one-row page), and the eight
 * most recent overdue visits. None calls Jobber or a billed provider.
 */
export function JobberHome({
  canReadInspections,
  children,
  dashboard,
  jobberDay,
}: {
  canReadInspections: boolean;
  children?: ReactNode;
  dashboard: UseQueryResult<AdminDashboard>;
  jobberDay: UseQueryResult<JobberDayComparison>;
}) {
  const today = businessToday();
  const auth = useAuth();
  const { has } = usePermissions();
  const greeting = useGreeting();
  const name = firstName(auth.profile?.displayName);

  const canAnswerReschedules = has('inspections:manage') || has('planning:publish');
  const reschedules = useRescheduleRequests('open', canAnswerReschedules);
  const followUp = useInspections(FOLLOW_UP_QUERY, canReadInspections);
  const overdue = useInspections(overdueQuery(today), canReadInspections);

  const metrics = dashboard.data?.metrics;
  const dayLoaded = Boolean(jobberDay.data);
  const buckets = todayBuckets(jobberDay.data?.rows ?? []);
  const bookedToday = buckets.active.length + buckets.remaining.length + buckets.done.length;
  const asked = reschedules.data ? rescheduleBreakdown(reschedules.data.items) : null;

  const cards: WorkflowCard[] = [
    ...(canAnswerReschedules
      ? [
          {
            key: 'reschedules',
            title: 'Reschedules',
            icon: CalendarSyncIcon,
            edge: 'border-t-chart-4',
            iconTone: 'text-chart-4',
            href: '/reschedules',
            value: reschedules.data?.counts.open ?? null,
            unavailable: reschedules.isError,
            word: 'To answer',
            urgent: true,
            rows: [
              { label: 'Could not get in', value: asked?.NO_ACCESS ?? null },
              { label: 'Asked before the visit', value: asked?.BEFORE_VISIT ?? null },
              { label: 'Not done on the visit', value: asked?.SERVICES_NOT_DONE ?? null },
            ],
          },
        ]
      : []),
    {
      key: 'upcoming',
      title: 'Upcoming',
      icon: UserRoundXIcon,
      edge: 'border-t-chart-3',
      iconTone: 'text-chart-3',
      // Every date: the count is every upcoming visit with nobody on it.
      href: '/inspections?tech=unassigned&day=all',
      value: metrics?.unassigned ?? null,
      word: 'Need a technician',
      urgent: true,
      rows: [
        { label: 'Assigned', value: metrics?.assigned ?? null },
        ...(canReadInspections ? [{ label: 'Booked today', value: dayLoaded ? bookedToday : null }] : []),
      ],
    },
    ...(canReadInspections
      ? [
          {
            key: 'today',
            title: 'Today',
            icon: ClipboardCheckIcon,
            edge: 'border-t-chart-5',
            iconTone: 'text-chart-5',
            href: '/schedule?view=day',
            value: dayLoaded ? buckets.remaining.length : null,
            unavailable: jobberDay.isError,
            word: 'Still to do today',
            rows: [
              { label: 'In progress now', value: metrics?.inProgress ?? null },
              { label: 'Done today', value: dayLoaded ? buckets.done.length : null },
            ],
          },
          {
            key: 'follow-up',
            title: 'Follow-up',
            icon: FlagIcon,
            edge: 'border-t-chart-1',
            iconTone: 'text-chart-1',
            href: '/inspections?status=FOLLOW_UP&day=all',
            value: followUp.data?.total ?? null,
            unavailable: followUp.isError,
            word: 'Follow-up required',
            urgent: true,
            rows: [{ label: 'Done, all time', value: metrics?.completed ?? null }],
          },
        ]
      : []),
  ];

  return (
    <>
      <header className="flex flex-col gap-1 pb-6">
        <p className="text-heading text-base font-semibold">
          {texasDayLabel(today)}
          <span className="text-muted-foreground font-normal"> · Texas</span>
        </p>
        <h1 className="font-display text-heading text-[2rem] leading-tight font-extrabold sm:text-4xl">
          {greeting}
          {name ? `, ${name}` : ''}
        </h1>
      </header>

      <div className="flex flex-col gap-8">
        {dashboard.isError ? (
          <ErrorState error={dashboard.error} retry={() => void dashboard.refetch()} />
        ) : (
          <WorkflowCards cards={cards} />
        )}
        {canReadInspections ? (
          <TodaysVisits
            date={today}
            day={jobberDay.data}
            loading={jobberDay.isLoading}
            overdue={overdue.data?.items ?? []}
            overdueTotal={overdue.data?.total ?? null}
          />
        ) : null}
        {children}
      </div>
    </>
  );
}

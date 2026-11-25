import type { WorkOrderJobberSchedule } from '@texasrenters/shared';

import { businessDate } from '../common/business-day';
import { jobberVisitSchema } from '../integrations/jobber/jobber.schemas';

/**
 * Whether a work order is already booked in Jobber, from the visits the sync
 * stored for its Jobber job (2026-11-26: "a checker whether the app is already
 * scheduled in jobber").
 *
 * The visit shown is the next one still to do, from today on; with none, the
 * latest. A job with no visit the sync holds is not scheduled -- the sync keeps
 * visits from 7 days back to 60 ahead, so "not scheduled" means none in that
 * window. Reads stored payloads only: no call to Jobber.
 */
export function jobberScheduleOf(payloads: readonly unknown[], today: string): WorkOrderJobberSchedule {
  const visits = payloads
    .map((payload) => jobberVisitSchema.safeParse(payload))
    .flatMap((parsed) => (parsed.success && parsed.data.startAt ? [parsed.data] : []))
    .map((visit) => ({ visit, date: businessDate(new Date(visit.startAt!)) }))
    .sort((a, b) => a.visit.startAt!.localeCompare(b.visit.startAt!));
  if (!visits.length) return { scheduled: false, date: null, startAt: null, team: [], completed: false };

  const shown =
    visits.find(({ visit, date }) => !visit.completedAt && date >= today) ?? visits[visits.length - 1]!;
  return {
    scheduled: true,
    date: shown.date,
    startAt: shown.visit.allDay ? null : new Date(shown.visit.startAt!).toISOString(),
    team: (shown.visit.assignedUsers?.nodes ?? []).map((user) => user.name?.full?.trim() ?? '').filter(Boolean),
    completed: Boolean(shown.visit.completedAt),
  };
}

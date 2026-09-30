import type { Prisma } from '@prisma/client';

/**
 * A stop moved with its visit, for the audit entry of the reschedule that moved it.
 *
 * A type, not an interface: it is written into an audit row's JSON, and Prisma's
 * JSON input accepts only types it can index.
 */
export type MovedPlanStop = {
  stopId: string;
  planId: string;
  /** `YYYY-MM-DD`; null for a stop that had no day. */
  from: string | null;
  to: string;
};

/** The day a DATE column keeps of an instant: its UTC date. */
const dateOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Moves the quarter plan's stop to the day its visit was just rescheduled to.
 *
 * The planner reads a booked visit's day from its stop, not its inspection:
 * `bookedVisitDays` before a rebuild, and the pins a route lays days around.
 * When only the inspection moved, a rebuild that laid the visit back on the old
 * day found nothing to send, and the plan said the 5th while Jobber said the 9th.
 * Both ways a visit is rescheduled call this: the Jobber sync, for a move made
 * in Jobber, and the console's own date change, which Jobber then agrees with,
 * so the sync never sees it as a change.
 *
 * `day` is the value just written to `Inspection.scheduledAt`, in the same
 * transaction, never worked out again, because the rebuild compares the two.
 * Both columns are DATEs, so the comparison is of the dates they keep. A stop
 * already on the day is not written; an inspection with no stop has nothing to
 * move.
 *
 * It leaves the old day's order and its drive forecast from its old neighbour,
 * a route it is no longer on. The day rows are not measured again: that needs
 * road times, which is the planner's work and not a reschedule's, once per
 * visit; and `measureDays` counts only unpublished stops, so on a published
 * quarter it would shrink a booked day to those. Until the next route rewrites
 * every day row, the old day's row still counts the visit, and the Days view
 * (which lists stops by their own day) shows it on the new day only if that
 * technician already has a row there.
 */
export async function moveStopWithVisit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  inspectionId: string,
  day: Date,
): Promise<MovedPlanStop | null> {
  const stop = await tx.tbpQuarterPlanStop.findFirst({
    where: { organizationId, inspectionId },
    select: { id: true, planId: true, scheduledOn: true, assignedTechnicianId: true },
  });
  if (!stop || (stop.scheduledOn && dateOf(stop.scheduledOn) === dateOf(day))) return null;
  const now = new Date();
  await tx.tbpQuarterPlanStop.update({
    where: { id: stop.id },
    data: {
      scheduledOn: day,
      positionInDay: null,
      driveSecondsForecast: null,
      /**
       * A day a person chose, in Jobber or in the console: a rebuild must not
       * move it back by sending Jobber the reverse.
       *
       * The technician's mark goes with the day's, as a coordinator's own move
       * records both (`TbpStopEditService.edit`), because a rebuild reads them
       * together. The day's mark alone keeps the stop out of `bookedVisitDays`,
       * so nothing is sent for it; but only both pin it. With one, a rebuild
       * would lay the visit on another day and tell neither the inspection nor
       * Jobber, which is the disagreement this function exists to prevent. The
       * cost is the rule for a day placed by hand: a rebuild gives it none of
       * the planner's other visits.
       */
      scheduleOverriddenAt: now,
      ...(stop.assignedTechnicianId ? { technicianOverriddenAt: now } : {}),
    },
  });
  return {
    stopId: stop.id,
    planId: stop.planId,
    from: stop.scheduledOn ? dateOf(stop.scheduledOn) : null,
    to: dateOf(day),
  };
}

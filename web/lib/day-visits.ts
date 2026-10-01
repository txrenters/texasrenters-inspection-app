import { isFinishedStatus, type TechnicianAssignments } from '@texasrenters/shared';

/** One of the day's inspections at a property, as the technician map's window lists it. */
export interface PropertyVisit {
  inspectionId: string;
  inspectionType: string;
  status: string;
  /** Submitted or further along: `isFinishedStatus`, the roster's own rule. */
  finished: boolean;
  /** When a finished one was submitted or completed. */
  finishedAt: string | null;
  technicianName: string;
}

/**
 * The day's inspections, by the property they are at.
 *
 * Everybody's, not only the technicians shown. Whether a property's inspection
 * is in is a fact about the property, and narrowing the crew to who is online
 * should not take the tick off a house somebody now offline finished this
 * morning. A stop with no building cannot be pointed at on a map, and is left to
 * the roster, which says so.
 */
export function visitsByProperty(
  assignments: readonly TechnicianAssignments[] | undefined,
): Map<string, PropertyVisit[]> {
  const byProperty = new Map<string, PropertyVisit[]>();
  for (const entry of assignments ?? [])
    for (const stop of entry.stops) {
      if (!stop.buildingId) continue;
      const visits = byProperty.get(stop.buildingId) ?? [];
      visits.push({
        inspectionId: stop.inspectionId,
        inspectionType: stop.inspectionType,
        status: stop.status,
        finished: isFinishedStatus(stop.status),
        finishedAt: stop.finishedAt,
        technicianName: entry.displayName,
      });
      byProperty.set(stop.buildingId, visits);
    }
  return byProperty;
}

/**
 * Whether the tick goes on a property's disc: it had inspections on the day,
 * and every one of them is in. A house with one of two still to do is still
 * work, and its window says which.
 */
export function allSubmitted(visits: readonly PropertyVisit[] | undefined): boolean {
  return Boolean(visits?.length) && visits!.every((visit) => visit.finished);
}

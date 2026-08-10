/**
 * Whether this technician has ever been given work.
 *
 * The home screen needs to tell two empty states apart. Somebody who cleared
 * their queue should read "All caught up"; somebody on their first day should
 * not, because it credits them with finishing work they were never assigned and
 * says nothing about whether the app is set up correctly.
 *
 * Every count has to be checked, and the totals matter more than the lists.
 * `recent` holds only the last few completed inspections and the queue arrays
 * only hold open work, so a technician with two years of history and an empty
 * queue looks identical to a new one unless the dashboard's own totals are
 * consulted. Getting that wrong shows a veteran the welcome screen.
 */
export function hasNeverBeenAssigned(input: {
  assignedCount: number;
  inProgressCount: number;
  /** Dashboard total, not the length of `recent`. */
  completedTotal: number;
  /** Dashboard total, not the length of the queue. */
  inProgressTotal: number;
  recentCount: number;
}): boolean {
  return (
    input.assignedCount === 0 &&
    input.inProgressCount === 0 &&
    input.inProgressTotal === 0 &&
    input.completedTotal === 0 &&
    input.recentCount === 0
  );
}

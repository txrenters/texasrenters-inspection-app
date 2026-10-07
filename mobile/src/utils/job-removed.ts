/**
 * A job taken off this technician's phone, and what the phone does about it.
 *
 * The office asked for it to go at once (2026-10-07): "if those are canceled or
 * deleted from the jobber... the mobile app will be freed on that schedules".
 * It used to wait for the next refresh of the list -- a minute with the app
 * open -- and a job screen already showing it never let go: its refresh was
 * refused, and the screen went on drawing the last copy it had, Start job and
 * all.
 */

/**
 * The events after which the job is no longer this technician's.
 *
 * CANCELLED: by the office, a lease call-off, or Jobber cancelling or deleting
 * the visit (the server deletes an untouched one outright). UNASSIGNED and
 * REASSIGNED reach the technician who lost it.
 */
export const JOB_LEAVES_THE_PHONE: ReadonlySet<string> = new Set(['CANCELLED', 'UNASSIGNED', 'REASSIGNED']);

/**
 * Whether a refused request means the job is no longer this technician's.
 *
 * Read by shape rather than `instanceof ApiRefusalError`, so this file needs no
 * storage module to be tested. The server answers every job read and every job
 * action the same way for a job cancelled, deleted or assigned to someone else.
 */
export function isJobRemoved(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, code } = error as Error & { status?: unknown; code?: unknown };
  return status === 404 && code === 'ASSIGNED_INSPECTION_NOT_FOUND';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * One cached answer with the job taken out: a list of jobs, a page of them, the
 * pages of an infinite list, or the home screen's summary.
 *
 * The same object back when it never held the job, so react-query sees no
 * change and redraws nothing. A page's `total` drops with it; the summary's
 * counts are left to the refetch that follows, which is a second away.
 */
export function withoutJob<T>(data: T, inspectionId: string): T {
  return strip(data, inspectionId) as T;
}

function strip(value: unknown, inspectionId: string): unknown {
  const drop = (items: unknown[]) => items.filter((item) => !(isRecord(item) && item.id === inspectionId));

  if (Array.isArray(value)) {
    const kept = drop(value);
    return kept.length === value.length ? value : kept;
  }
  if (!isRecord(value)) return value;

  if (Array.isArray(value.pages)) {
    const pages = value.pages.map((page) => strip(page, inspectionId));
    return pages.every((page, index) => page === (value.pages as unknown[])[index]) ? value : { ...value, pages };
  }

  let next: Record<string, unknown> | null = null;
  for (const key of ['items', 'assignments', 'recent']) {
    const list = value[key];
    if (!Array.isArray(list)) continue;
    const kept = drop(list);
    if (kept.length === list.length) continue;
    next ??= { ...value };
    next[key] = kept;
    if (key === 'items' && typeof value.total === 'number')
      next.total = Math.max(0, value.total - (list.length - kept.length));
  }
  return next ?? value;
}

/**
 * Where a tapped notification opens.
 *
 * The job itself, except for one that took the job away: that job is deleted or
 * someone else's, and opening it could only say so. The list shows what is left.
 */
export function notificationTarget(data: unknown): string | null {
  if (!isRecord(data) || typeof data.inspectionId !== 'string') return null;
  if (typeof data.kind === 'string' && JOB_LEAVES_THE_PHONE.has(data.kind)) return '/(app)/(tabs)/(jobs)/inspections';
  return `/(app)/inspections/${data.inspectionId}`;
}

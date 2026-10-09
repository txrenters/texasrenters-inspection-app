import type {
  JobberDayComparison,
  JobberDayOtherWork,
  JobberDayRow,
  JobberDayState,
  JobberDayTechnician,
} from '@texasrenters/shared';

import { BUSINESS_TIME_ZONE, businessDate } from '../../common/business-day';
import type { JobberVisit } from './jobber.schemas';

/**
 * One Texas day: the console's inspections beside the Jobber visits the sync
 * last saved. Pure, so the rules are tested without a database; the service
 * only loads the rows.
 *
 * It reads stored payloads, never Jobber itself. The sync refreshes every
 * linked visit's row each run, so "as of the last sync" is what this means by
 * Jobber, and the screen says when that was.
 */

export interface DayInspection {
  id: string;
  status: string;
  inspectionType: string;
  scheduledStartAt: Date | null;
  jobberVisitId: string | null;
  property: string;
  technician: { id: string; displayName: string; email: string | null } | null;
  /** Outbound kinds of ours still PENDING or FAILED. */
  waitingKinds: string[];
}

export interface StoredJobberVisit {
  jobberVisitId: string;
  status: string;
  failureMessage: string | null;
  inspectionId: string | null;
  lastAttemptAt: Date | null;
  payload: JobberVisit | null;
}

export interface DayTechnician {
  id: string;
  displayName: string;
  email: string | null;
}

export interface DayInput {
  date: string;
  inspections: DayInspection[];
  /** Stored visits that start on the day, and every visit linked to an inspection of the day. */
  visits: StoredJobberVisit[];
  /** Inspections elsewhere that a visit of the day is linked to: id -> its day and status. */
  linkedElsewhere: Map<string, { date: string; status: string; property: string; technicianId: string | null }>;
  technicians: DayTechnician[];
  connection: {
    connected: boolean;
    lastSyncStartedAt: Date | null;
    lastSyncCompletedAt: Date | null;
  } | null;
  pushesEnabled: boolean;
  /** JOBBER_DAY_ACTIONS_ENABLED: whether the buttons that send to Jobber are offered. */
  actionsEnabled?: boolean;
}

const OPEN = new Set(['SCHEDULED', 'IN_PROGRESS']);
const CANCELLED = 'CANCELLED';
const isDone = (status: string) => !OPEN.has(status) && status !== CANCELLED;

/** Import outcomes that mean "not an inspection, by rule or by a person". */
const OTHER_WORK = new Set(['SKIPPED_NOT_SYNCED', 'SKIPPED_COMPLETE', 'IGNORED']);

const ORDER: JobberDayState[] = [
  'CANCELLED_HERE',
  'DONE_HERE',
  'DONE_IN_JOBBER',
  'UNSEEN',
  'DAY_DIFFERS',
  'TIME_DIFFERS',
  'TECHNICIAN_DIFFERS',
  'NOT_IN_JOBBER',
  'ONLY_IN_JOBBER',
  'MATCHES',
];

const clock = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  hour: 'numeric',
  minute: '2-digit',
});
const longDay = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
});
const timeOf = (instant: Date) => clock.format(instant);
const dayWords = (date: string) => longDay.format(new Date(`${date}T12:00:00.000Z`));

function assignees(payload: JobberVisit | null) {
  return (payload?.assignedUsers?.nodes ?? []).map((node) => ({
    email: node.email?.raw?.trim().toLowerCase() || null,
    name: node.name?.full?.trim() || null,
  }));
}

/** A Jobber start time, or null when the visit is whole-day (Jobber still sends a startAt). */
function timedStart(payload: JobberVisit | null): Date | null {
  if (!payload?.startAt || payload.allDay) return null;
  return new Date(payload.startAt);
}

function streetOf(payload: JobberVisit | null) {
  return payload?.property?.address?.street1?.trim() || payload?.client?.name?.trim() || 'Jobber visit';
}

export function compareJobberDay(input: DayInput): JobberDayComparison {
  const byEmail = new Map(
    input.technicians
      .filter((person) => person.email)
      .map((person) => [person.email!.trim().toLowerCase(), person] as const),
  );
  const visitById = new Map(input.visits.map((visit) => [visit.jobberVisitId, visit]));
  const linkedHere = new Set(input.inspections.map((row) => row.jobberVisitId).filter(Boolean));

  /**
   * A full run of the sync touches every visit in its window. One the last
   * completed run did not touch has gone from Jobber's day: deleted, or moved
   * to Unscheduled. Without a completed run there is no basis to say so.
   */
  const lastRun = input.connection?.lastSyncCompletedAt && input.connection.lastSyncStartedAt;
  const unseen = (visit: StoredJobberVisit) =>
    Boolean(
      lastRun &&
        input.connection!.lastSyncCompletedAt! >= input.connection!.lastSyncStartedAt! &&
        (!visit.lastAttemptAt || visit.lastAttemptAt < input.connection!.lastSyncStartedAt!),
    );

  const rows: JobberDayRow[] = [];
  const otherWork: JobberDayOtherWork[] = [];
  /** Jobber's own count per technician id ('' = nobody here). */
  const inJobber = new Map<string, number>();
  const countJobber = (payload: JobberVisit | null) => {
    const person = assignees(payload)
      .map((entry) => (entry.email ? byEmail.get(entry.email) : undefined))
      .find(Boolean);
    const key = person?.id ?? '';
    inJobber.set(key, (inJobber.get(key) ?? 0) + 1);
  };
  const jobberName = (payload: JobberVisit | null) =>
    assignees(payload)
      .map((entry) => (entry.email ? byEmail.get(entry.email)?.displayName : undefined) ?? entry.name)
      .filter(Boolean)
      .join(', ') || null;

  for (const inspection of input.inspections) {
    const visit = inspection.jobberVisitId ? visitById.get(inspection.jobberVisitId) : undefined;
    const payload = visit?.payload ?? null;
    const cancelled = inspection.status === CANCELLED;

    // A cancelled inspection with nothing open in Jobber is simply over.
    if (cancelled && (!payload?.startAt || payload.completedAt || visit?.status === 'IGNORED' || (visit && unseen(visit))))
      continue;

    const states: Array<[JobberDayState, string]> = [];
    if (!inspection.jobberVisitId) {
      states.push(['NOT_IN_JOBBER', 'Not booked in Jobber']);
    } else if (!payload) {
      states.push(['UNSEEN', 'Linked to a Jobber visit the sync has not read yet']);
    } else {
      const jobberDone = Boolean(payload.completedAt);
      if (cancelled) states.push(['CANCELLED_HERE', 'Cancelled here, still open in Jobber']);
      if (!cancelled && isDone(inspection.status) && !jobberDone)
        states.push(['DONE_HERE', 'Done here, still open in Jobber']);
      if (jobberDone && OPEN.has(inspection.status))
        states.push(['DONE_IN_JOBBER', 'Completed in Jobber, still open here']);
      if (visit && unseen(visit))
        states.push(['UNSEEN', 'Not seen in Jobber at the last sync: deleted there, or moved to Unscheduled']);
      else if (payload.startAt) {
        const jobberDay = businessDate(new Date(payload.startAt));
        if (jobberDay !== input.date) {
          states.push(['DAY_DIFFERS', `Jobber has it on ${dayWords(jobberDay)}`]);
        } else {
          const jobberStart = timedStart(payload);
          if (
            inspection.scheduledStartAt &&
            jobberStart &&
            Math.abs(inspection.scheduledStartAt.getTime() - jobberStart.getTime()) >= 60_000
          )
            states.push([
              'TIME_DIFFERS',
              `Here ${timeOf(inspection.scheduledStartAt)}, Jobber ${timeOf(jobberStart)}`,
            ]);
        }
      }
      // Jobber returns an empty list without its Users scope, so nobody named
      // there proves nothing; only a different named person is a difference.
      const named = assignees(payload);
      const here = inspection.technician?.email?.trim().toLowerCase() ?? null;
      if (named.length && !named.some((entry) => entry.email && entry.email === here))
        states.push([
          'TECHNICIAN_DIFFERS',
          `Jobber has ${jobberName(payload)}${inspection.technician ? `, here ${inspection.technician.displayName}` : ', nobody here'}`,
        ]);
    }
    if (payload?.startAt && businessDate(new Date(payload.startAt)) === input.date && !cancelled) countJobber(payload);

    states.sort((a, b) => ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
    rows.push({
      key: inspection.id,
      inspectionId: inspection.id,
      jobberVisitId: inspection.jobberVisitId,
      property: inspection.property,
      inspectionType: inspection.inspectionType,
      status: inspection.status,
      technicianId: inspection.technician?.id ?? null,
      here: {
        startAt: inspection.scheduledStartAt?.toISOString() ?? null,
        technician: inspection.technician?.displayName ?? null,
      },
      jobber: payload
        ? {
            startAt: timedStart(payload)?.toISOString() ?? null,
            technician: jobberName(payload),
            title: payload.title ?? null,
            completed: Boolean(payload.completedAt),
          }
        : null,
      state: states[0]?.[0] ?? 'MATCHES',
      differences: states.map(([, words]) => words),
      waitingToSend: inspection.waitingKinds.length > 0,
      importNote: null,
    });
  }

  // Jobber visits on the day that no inspection of the day carries.
  for (const visit of input.visits) {
    if (linkedHere.has(visit.jobberVisitId)) continue;
    const payload = visit.payload;
    if (!payload?.startAt || businessDate(new Date(payload.startAt)) !== input.date) continue;
    if (visit.status !== 'IMPORTED' && unseen(visit)) continue;

    if (OTHER_WORK.has(visit.status)) {
      otherWork.push({
        jobberVisitId: visit.jobberVisitId,
        title: payload.title ?? null,
        property: streetOf(payload),
        technician: jobberName(payload),
        startAt: timedStart(payload)?.toISOString() ?? null,
        reason:
          visit.status === 'IGNORED'
            ? 'Ignored by the office'
            : visit.status === 'SKIPPED_COMPLETE'
              ? 'Already completed in Jobber'
              : (visit.failureMessage ?? 'Not named as an inspection'),
      });
      continue;
    }
    countJobber(payload);

    const elsewhere = visit.inspectionId ? input.linkedElsewhere.get(visit.inspectionId) : undefined;
    const person = assignees(payload)
      .map((entry) => (entry.email ? byEmail.get(entry.email) : undefined))
      .find(Boolean);
    const state: JobberDayState = elsewhere ? 'DAY_DIFFERS' : 'ONLY_IN_JOBBER';
    rows.push({
      key: visit.inspectionId ?? `jobber:${visit.jobberVisitId}`,
      inspectionId: visit.inspectionId,
      jobberVisitId: visit.jobberVisitId,
      property: elsewhere?.property ?? streetOf(payload),
      inspectionType: null,
      status: elsewhere?.status ?? null,
      technicianId: elsewhere?.technicianId ?? person?.id ?? null,
      here: null,
      jobber: {
        startAt: timedStart(payload)?.toISOString() ?? null,
        technician: jobberName(payload),
        title: payload.title ?? null,
        completed: Boolean(payload.completedAt),
      },
      state,
      differences: [
        elsewhere
          ? elsewhere.status === CANCELLED
            ? 'Cancelled here, still open in Jobber on this day'
            : `Here on ${dayWords(elsewhere.date)}, Jobber on this day`
          : 'In Jobber, no inspection here',
      ],
      waitingToSend: false,
      importNote: elsewhere ? null : (visit.failureMessage ?? humanStatus(visit.status)),
    });
  }

  rows.sort(
    (a, b) =>
      ORDER.indexOf(a.state) - ORDER.indexOf(b.state) ||
      (a.here?.startAt ?? a.jobber?.startAt ?? '').localeCompare(b.here?.startAt ?? b.jobber?.startAt ?? '') ||
      a.property.localeCompare(b.property),
  );

  const technicians = summarise(rows, input.technicians, inJobber);
  return {
    date: input.date,
    syncedAt: input.connection?.lastSyncCompletedAt?.toISOString() ?? null,
    pushesEnabled: input.pushesEnabled,
    actionsEnabled: input.actionsEnabled ?? false,
    connected: Boolean(input.connection?.connected),
    technicians,
    rows,
    otherWork,
  };
}

function humanStatus(status: string) {
  switch (status) {
    case 'UNMATCHED_PROPERTY':
      return 'Its Jobber property is not linked to a property here yet';
    case 'REJECTED':
      return 'The sync refused it';
    case 'PENDING':
      return 'Waiting for the sync';
    default:
      return status.replaceAll('_', ' ').toLowerCase();
  }
}

function summarise(
  rows: JobberDayRow[],
  people: DayTechnician[],
  inJobber: Map<string, number>,
): JobberDayTechnician[] {
  const names = new Map(people.map((person) => [person.id, person.displayName]));
  const groups = new Map<string, JobberDayTechnician>();
  const group = (id: string | null) => {
    const key = id ?? '';
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        technicianId: id,
        name: id ? (names.get(id) ?? 'Technician') : 'Nobody here',
        here: 0,
        inJobber: inJobber.get(key) ?? 0,
        done: 0,
        differences: 0,
      };
      groups.set(key, entry);
    }
    return entry;
  };
  for (const row of rows) {
    const entry = group(row.technicianId);
    if (row.here && row.status !== CANCELLED) {
      entry.here += 1;
      if (row.status && isDone(row.status)) entry.done += 1;
    }
    if (row.state !== 'MATCHES') entry.differences += 1;
  }
  for (const key of inJobber.keys()) group(key || null);
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.technicianId === null) - Number(b.technicianId === null) ||
      b.here + b.inJobber - (a.here + a.inJobber) ||
      a.name.localeCompare(b.name),
  );
}

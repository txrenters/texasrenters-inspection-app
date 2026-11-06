import { COULD_NOT_GET_IN_PREFIX } from './visit-state.js';
import {
  REPORTABLE_VISIT_SERVICES,
  VISIT_SERVICE_LABEL,
  filterLabel,
  type VisitServicesReport,
} from './visit-services.js';

/**
 * Everything written on a job, in one place (the office, 2026-11-06: "it should
 * show the notes the technician submitted").
 *
 * A technician writes in five places -- why nobody got in, why a service was
 * not done, a filter's reason or comment, a room's note, why a room was skipped
 * -- and the job page showed each beside its own thing, or not at all: a room's
 * note was only inside that room's review. Each note here keeps the name of
 * where it was written, so the office can go and find it.
 *
 * A reschedule request's reason is not here: it is made from these same
 * answers, so it would only say them twice.
 */

/** A room's note and why it was skipped, as the job serves them. */
export interface JobAreaNote {
  id: string;
  name: string;
  floorName: string | null;
  note: string | null;
  skipReason: string | null;
}

/** A row of an inspection's areas that has something written on it. */
export interface JobAreaNoteRow {
  id: string;
  completionStatus: string;
  technicianNote: string | null;
  skipReason: string | null;
  propertyArea: { name: string; inspectionOrder: number; floor: { name: string } | null };
}

/**
 * Rooms in walk order, as the Areas section lists them. A skip reason counts
 * only on a room still skipped: one resumed afterwards can keep the old reason.
 */
export function jobAreaNotes(rows: readonly JobAreaNoteRow[]): JobAreaNote[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.propertyArea.inspectionOrder - b.propertyArea.inspectionOrder ||
        a.propertyArea.name.localeCompare(b.propertyArea.name) ||
        a.id.localeCompare(b.id),
    )
    .map((row) => ({
      id: row.id,
      name: row.propertyArea.name,
      floorName: row.propertyArea.floor?.name ?? null,
      note: row.technicianNote,
      skipReason: row.completionStatus === 'SKIPPED' ? row.skipReason : null,
    }));
}

export interface JobNote {
  key: string;
  /** Where it was written: "Pest control", "Kitchen · Upstairs". */
  source: string;
  text: string;
}

export interface JobNotesSource {
  completionBlockedReason?: string | null;
  servicesReport?: VisitServicesReport | null;
  areaNotes?: readonly JobAreaNote[];
  nextInspectionAlert?: string | null;
  maintenanceComments?: string | null;
  generalComments?: string | null;
}

/**
 * What the technician wrote: the visit first, then its services, its filters
 * and its rooms in the order they were walked.
 *
 * `completionBlockedReason` counts only as a "could not get in": the office
 * writes that column too, when it holds a job back.
 */
export function technicianNotes(job: JobNotesSource): JobNote[] {
  const notes: JobNote[] = [];
  const add = (key: string, source: string, ...parts: (string | null | undefined)[]) => {
    const text = parts
      .map((part) => part?.trim())
      .filter(Boolean)
      .join(' — ');
    if (text) notes.push({ key, source, text });
  };

  const blocked = job.completionBlockedReason?.trim();
  if (blocked?.startsWith(COULD_NOT_GET_IN_PREFIX))
    add(
      'could-not-get-in',
      COULD_NOT_GET_IN_PREFIX,
      blocked.slice(COULD_NOT_GET_IN_PREFIX.length).replace(/^[:\s]+/, ''),
    );

  const report = job.servicesReport;
  add('for-the-office', 'Note for the office', report?.notes);
  for (const service of REPORTABLE_VISIT_SERVICES)
    add(`service-${service}`, VISIT_SERVICE_LABEL[service], report?.services[service]?.reason);
  report?.filters?.forEach((filter, index) =>
    add(`filter-${index}`, `Filter ${filterLabel(filter)}`, filter.reason, filter.comment),
  );

  for (const area of job.areaNotes ?? []) {
    const room = area.floorName ? `${area.name} · ${area.floorName}` : area.name;
    if (area.skipReason?.trim()) add(`area-${area.id}-skipped`, room, `Skipped: ${area.skipReason.trim()}`);
    add(`area-${area.id}`, room, area.note);
  }
  return notes;
}

/**
 * The report's closing comments. Kept apart from the technician's notes for two
 * reasons: a tenant and an owner read these, and the office can write them too.
 */
export function reportComments(job: JobNotesSource): JobNote[] {
  const comments = [
    { key: 'next-inspection-alert', source: 'Next inspection alert', text: job.nextInspectionAlert },
    { key: 'maintenance-comments', source: 'Maintenance comments', text: job.maintenanceComments },
    { key: 'general-comments', source: 'General comments', text: job.generalComments },
  ];
  return comments.flatMap(({ key, source, text }) =>
    text?.trim() ? [{ key, source, text: text.trim() }] : [],
  );
}

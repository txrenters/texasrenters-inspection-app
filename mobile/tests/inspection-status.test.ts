import type { InspectionStatus } from '../src/domain/models';
import {
  FIELD_ACTIVE_STATUSES,
  INSPECTION_STATUS_TONE_CLASS,
  INSPECTION_STATUSES,
  inspectionStatusLabel,
  inspectionStatusPresentation,
  isFieldActive,
  isSubmittedToOffice,
  statusesForFilter,
} from '../src/utils/inspection-status';

const ALL_STATUSES: InspectionStatus[] = [
  'SCHEDULED',
  'IN_PROGRESS',
  'TECHNICIAN_SUBMITTED',
  'PROCESSING',
  'REVIEW_REQUIRED',
  'UNDER_REVIEW',
  'TBD',
  'FOLLOW_UP_REQUIRED',
  'COMPLETED',
  'CANCELLED',
];

describe('inspection status presentation', () => {
  // Pins every status by name. Asserting only "not the raw enum" passed just
  // as happily for an implementation that answered "Unknown" ten times — and
  // COMPLETED could have regressed to a red "Unknown" with the suite green,
  // which is the exact class of bug this module exists to prevent.
  it.each([
    ['SCHEDULED', 'Assigned', 'assigned'],
    ['IN_PROGRESS', 'In Progress', 'active'],
    ['TECHNICIAN_SUBMITTED', 'Submitted', 'submitted'],
    ['PROCESSING', 'With Office', 'review'],
    ['REVIEW_REQUIRED', 'With Office', 'review'],
    ['UNDER_REVIEW', 'With Office', 'review'],
    ['TBD', 'With Office', 'review'],
    ['FOLLOW_UP_REQUIRED', 'Follow-up Needed', 'attention'],
    ['COMPLETED', 'Completed', 'done'],
    ['CANCELLED', 'Cancelled', 'closed'],
  ] as const)('presents %s as "%s"', (status, label, tone) => {
    expect(inspectionStatusPresentation(status)).toEqual({ label, tone });
  });

  it('covers every status in the union, so none can be added without a decision', () => {
    // Guards the map against drift when a status is added to models.ts.
    for (const status of ALL_STATUSES) {
      expect(inspectionStatusPresentation(status).label).not.toBe('Unknown');
    }
  });

  it('gives every tone a class pair in both slots', () => {
    // A typo'd class string compiles and renders as nothing, so the shape is
    // asserted here rather than discovered on a handset.
    for (const status of ALL_STATUSES) {
      const style = INSPECTION_STATUS_TONE_CLASS[inspectionStatusPresentation(status).tone];
      expect(style.bg).toMatch(/^bg-/);
      expect(style.text).toMatch(/^text-/);
    }
  });

  it('tells the technician their submitted work landed', () => {
    expect(inspectionStatusLabel('TECHNICIAN_SUBMITTED')).toBe('Submitted');
    expect(inspectionStatusPresentation('TECHNICIAN_SUBMITTED').tone).toBe('submitted');
  });

  it('collapses the office review states the field cannot act on', () => {
    for (const status of ['PROCESSING', 'REVIEW_REQUIRED', 'UNDER_REVIEW', 'TBD'] as const) {
      expect(inspectionStatusLabel(status)).toBe('With Office');
    }
  });

  it('keeps follow-up distinct, because it can come back to the technician', () => {
    expect(inspectionStatusLabel('FOLLOW_UP_REQUIRED')).toBe('Follow-up Needed');
    expect(inspectionStatusPresentation('FOLLOW_UP_REQUIRED').tone).toBe('attention');
  });

  it('describes an unrecognised status without claiming it is finished', () => {
    const { label, tone } = inspectionStatusPresentation('SOME_FUTURE_STATE');
    expect(label).toBe('Unknown');
    expect(tone).not.toBe('done');
  });

  it('treats only scheduled and in-progress as the technician’s to act on', () => {
    // Mirrors the backend queue; drifting from it strands work on the handset.
    expect(ALL_STATUSES.filter(isFieldActive)).toEqual(['SCHEDULED', 'IN_PROGRESS']);
  });

  it('counts every handed-over status as submitted except cancelled', () => {
    expect(ALL_STATUSES.filter(isSubmittedToOffice)).toEqual([
      'TECHNICIAN_SUBMITTED',
      'PROCESSING',
      'REVIEW_REQUIRED',
      'UNDER_REVIEW',
      'TBD',
      'FOLLOW_UP_REQUIRED',
      'COMPLETED',
    ]);
    // A cancelled inspection was never submitted; showing it as handed over
    // would credit work that did not happen.
    expect(isSubmittedToOffice('CANCELLED')).toBe(false);
  });
});

/**
 * The chips are what the server gets asked to filter by. They used to be
 * applied on-device over a fixed 25-record page, so every chip shared one
 * window of the *oldest* work — and "Submitted", covering seven statuses,
 * crowded the Assigned and In Progress chips a technician works from.
 */
describe('statusesForFilter', () => {
  it('asks the server for nothing on All, so the server applies its own visibility rule', () => {
    // Not "every status": the list must keep hiding CANCELLED, and that
    // decision belongs to the server rather than a list the client maintains.
    expect(statusesForFilter('ALL')).toBeUndefined();
  });

  it('expands Submitted to every handed-over status', () => {
    expect(statusesForFilter('SUBMITTED')).toEqual(ALL_STATUSES.filter(isSubmittedToOffice));
    // The chip's whole purpose: a walkthrough that has just gone to the office.
    expect(statusesForFilter('SUBMITTED')).toContain('TECHNICIAN_SUBMITTED');
  });

  it('passes a single-status chip through unchanged', () => {
    expect(statusesForFilter('SCHEDULED')).toEqual(['SCHEDULED']);
    expect(statusesForFilter('IN_PROGRESS')).toEqual(['IN_PROGRESS']);
    expect(statusesForFilter('COMPLETED')).toEqual(['COMPLETED']);
  });

  it('never asks for CANCELLED, which the server refuses', () => {
    const chips = ['ALL', 'SCHEDULED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETED'] as const;
    for (const chip of chips) expect(statusesForFilter(chip) ?? []).not.toContain('CANCELLED');
  });

  it('covers the whole enum across Assigned, In Progress and Submitted', () => {
    // Nothing except CANCELLED may be unreachable: a status no chip can show is
    // work that exists on the server and cannot be found on the handset.
    const reachable = new Set([
      ...statusesForFilter('SCHEDULED')!,
      ...statusesForFilter('IN_PROGRESS')!,
      ...statusesForFilter('SUBMITTED')!,
    ]);
    expect(ALL_STATUSES.filter((status) => !reachable.has(status))).toEqual(['CANCELLED']);
  });
});

describe('status groups sent to the server', () => {
  it('derives the field-active set from the same predicate the badges use', () => {
    expect(FIELD_ACTIVE_STATUSES).toEqual(ALL_STATUSES.filter(isFieldActive));
  });

  it('lists every status the app knows, so a new one cannot be silently unroutable', () => {
    expect([...INSPECTION_STATUSES].sort()).toEqual([...ALL_STATUSES].sort());
  });
});

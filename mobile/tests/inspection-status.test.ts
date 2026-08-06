import type { InspectionStatus } from '../src/domain/models';
import {
  INSPECTION_STATUS_TONE_CLASS,
  inspectionStatusLabel,
  inspectionStatusPresentation,
  isFieldActive,
  isSubmittedToOffice,
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

import type { InspectionStatus } from '../src/domain/models';
import {
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
  it('never falls back to the raw enum for a known status', () => {
    // The bug this replaces: a three-entry map whose fallback printed
    // "TECHNICIAN SUBMITTED" at the exact moment the technician needed to see
    // that their walkthrough had landed.
    for (const status of ALL_STATUSES) {
      const { label } = inspectionStatusPresentation(status);
      expect(label).not.toContain('_');
      expect(label).not.toBe(status);
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

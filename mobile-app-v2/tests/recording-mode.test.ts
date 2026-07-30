import {
  ADDITIONAL_PURPOSES,
  isPrimaryWalkthrough,
  purposeByValue,
  RECORDING_TYPE_BY_MODE,
  resolveRecordingMode,
} from '../src/capture/recording-mode';

describe('resolveRecordingMode', () => {
  it('uses the primary walkthrough for the first recording in an area', () => {
    expect(resolveRecordingMode({ existingMedia: [] })).toBe('PRIMARY_AREA_WALKTHROUGH');
  });

  it('switches to additional evidence once a primary walkthrough exists', () => {
    expect(
      resolveRecordingMode({ existingMedia: [{ recordingType: 'PRIMARY_AREA' }] }),
    ).toBe('ADDITIONAL_EVIDENCE_RECORDING');
  });

  it('still offers a primary walkthrough when only additional clips exist', () => {
    // Supplemental clips do not satisfy the area's walkthrough requirement.
    expect(
      resolveRecordingMode({ existingMedia: [{ recordingType: 'ADDITIONAL_ISSUE' }] }),
    ).toBe('PRIMARY_AREA_WALKTHROUGH');
  });

  it('treats media with no recordingType as a primary walkthrough', () => {
    // Older drafts predate the field; assuming "additional" would let an area
    // finish without a walkthrough on file.
    expect(resolveRecordingMode({ existingMedia: [{}] })).toBe('ADDITIONAL_EVIDENCE_RECORDING');
  });

  it('honours an explicit route parameter over inferred state', () => {
    expect(
      resolveRecordingMode({
        routeRecordingType: 'ADDITIONAL_ISSUE',
        existingMedia: [],
      }),
    ).toBe('ADDITIONAL_EVIDENCE_RECORDING');

    expect(
      resolveRecordingMode({
        routeRecordingType: 'PRIMARY_AREA',
        existingMedia: [{ recordingType: 'PRIMARY_AREA' }],
      }),
    ).toBe('PRIMARY_AREA_WALKTHROUGH');
  });

  it('ignores an unrecognised route value rather than trusting it', () => {
    // A typo or stale deep link must not silently downgrade a walkthrough.
    expect(
      resolveRecordingMode({ routeRecordingType: 'ADDITIONAL', existingMedia: [] }),
    ).toBe('PRIMARY_AREA_WALKTHROUGH');
    expect(
      resolveRecordingMode({ routeRecordingType: 'Window damage', existingMedia: [] }),
    ).toBe('PRIMARY_AREA_WALKTHROUGH');
  });

  it('handles absent media without throwing', () => {
    expect(resolveRecordingMode({})).toBe('PRIMARY_AREA_WALKTHROUGH');
  });
});

describe('mode mapping', () => {
  it('maps each mode onto the persisted recordingType the API already uses', () => {
    // Changing these strings would break the upload contract.
    expect(RECORDING_TYPE_BY_MODE.PRIMARY_AREA_WALKTHROUGH).toBe('PRIMARY_AREA');
    expect(RECORDING_TYPE_BY_MODE.ADDITIONAL_EVIDENCE_RECORDING).toBe('ADDITIONAL_ISSUE');
  });

  it('identifies the primary mode', () => {
    expect(isPrimaryWalkthrough('PRIMARY_AREA_WALKTHROUGH')).toBe(true);
    expect(isPrimaryWalkthrough('ADDITIONAL_EVIDENCE_RECORDING')).toBe(false);
  });
});

describe('additional purposes', () => {
  it('gives every purpose a label and capture guidance', () => {
    for (const purpose of ADDITIONAL_PURPOSES) {
      expect(purpose.label).toBeTruthy();
      expect(purpose.guidance.length).toBeGreaterThan(10);
      // Raw enum values must never reach a technician.
      expect(purpose.label).not.toMatch(/_/);
    }
  });

  it('looks a purpose up by its persisted value', () => {
    expect(purposeByValue('PLUMBING')?.label).toBe('Plumbing');
    expect(purposeByValue(undefined)).toBeUndefined();
  });

  it('keeps pet evidence about the evidence, not the animal', () => {
    // Technicians should not be directed to film someone's pet.
    expect(purposeByValue('PET_EVIDENCE')?.guidance).toMatch(/not any animal/i);
  });
});

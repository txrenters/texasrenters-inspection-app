import { areaCameraLabel, areaStage } from '../src/utils/area-status';

/**
 * Three stages rather than ten statuses: this is the question the area screen
 * asks — what should the technician be reading — not what is happening to the
 * area, which `deriveAreaStatus` already answers.
 */
describe('how much of an area’s story there is to tell', () => {
  it('is not filmed when there is no recording', () => {
    expect(areaStage('NOT_STARTED', false)).toBe('NOT_FILMED');
    expect(areaStage('UPLOAD_FAILED', false)).toBe('NOT_FILMED');
  });

  it('is filmed once media exists, even mid-upload', () => {
    // The evidence is worth showing before the upload settles; a technician
    // walking out of a property wants to see what was captured, not wait.
    expect(areaStage('UPLOADING', true)).toBe('FILMED');
    expect(areaStage('PENDING_UPLOAD', true)).toBe('FILMED');
    expect(areaStage('UPLOAD_FAILED', true)).toBe('FILMED');
  });

  it('treats a terminal area as finished whatever its media says', () => {
    expect(areaStage('COMPLETED', true)).toBe('FINISHED');
    expect(areaStage('COMPLETED', false)).toBe('FINISHED');
  });

  it('never offers filming guidance for a skipped area', () => {
    // A skipped area has no recording, so a recording-only rule would put it
    // back in the stage that says "here is how to film this room" — for a room
    // the technician has just declared uninspectable.
    expect(areaStage('SKIPPED', false)).toBe('FINISHED');
  });
});

/**
 * The office, 2026-09-30: after submitting an area, "it just say continue
 * walkthrough instead of change evidence".
 */
describe('what the camera button says', () => {
  const base = { skipped: false, finished: false, hasRecording: false, hasEvidence: false };

  it('offers to change the evidence of a submitted area, photographed or filmed', () => {
    expect(areaCameraLabel({ ...base, finished: true, hasEvidence: true })).toBe('Change Evidence');
    expect(areaCameraLabel({ ...base, finished: true, hasEvidence: true, hasRecording: true })).toBe('Change Evidence');
  });

  it('still begins, continues and films again before the area is submitted', () => {
    expect(areaCameraLabel(base)).toBe('Begin Walkthrough');
    expect(areaCameraLabel({ ...base, hasEvidence: true })).toBe('Continue Walkthrough');
    expect(areaCameraLabel({ ...base, hasEvidence: true, hasRecording: true })).toBe('Record Additional Video');
  });

  it('inspects a skipped area anyway, finished or not', () => {
    expect(areaCameraLabel({ ...base, skipped: true, finished: true })).toBe('Inspect Anyway');
  });
});

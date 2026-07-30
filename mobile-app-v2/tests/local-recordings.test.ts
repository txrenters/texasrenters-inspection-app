import { buildRecordingDraft } from '../src/media/local-recordings';

describe('mobile v2 evidence ownership', () => {
  it('binds each video to exactly one inspection and room', () => {
    const draft = buildRecordingDraft({
      ownerUserId: 'technician-1',
      inspectionId: 'inspection-1',
      roomId: 'room-2',
      uri: 'file:///recordings/inspection-1/room-2/video.mov',
      durationSeconds: 9,
      sizeBytes: 5 * 1024 * 1024,
    });

    expect(draft.ownerUserId).toBe('technician-1');
    expect(draft.inspectionId).toBe('inspection-1');
    expect(draft.roomId).toBe('room-2');
    expect(draft.estimatedSizeMb).toBe(5);
    expect(draft.recordingType).toBe('PRIMARY_AREA');
  });

  it('persists guided coverage only for the primary walkthrough', () => {
    const captureSummary = {
      sessionId: 'capture-1',
      policyVersion: 'guided-area-v1',
      startedAt: '2026-07-31T00:00:00.000Z',
      completedAt: '2026-07-31T00:00:20.000Z',
      durationSeconds: 20,
      clockwiseRotationDegrees: 360,
      counterClockwiseRotationDegrees: 0,
      startHeadingDegrees: 0,
      endHeadingDegrees: 0,
      returnedToStart: true,
      sensorSupported: true,
      sensorConfidence: 'HIGH' as const,
      coverageStatus: 'COMPLETE' as const,
      manualConfirmation: false,
      evidenceComplete: true,
      snapshotCount: 2,
      findingMarkerCount: 0,
    };
    const base = {
      inspectionId: 'inspection-1',
      roomId: 'room-1',
      uri: 'file:///recording.mp4',
      durationSeconds: 20,
      captureSummary,
    };

    const primary = buildRecordingDraft(base);
    const additional = buildRecordingDraft({
      ...base,
      recordingType: 'ADDITIONAL_ISSUE',
    });

    expect(primary.captureSummary).toEqual(captureSummary);
    expect(additional.recordingType).toBe('ADDITIONAL_ISSUE');
    expect(additional.captureSummary).toBeUndefined();
  });
});

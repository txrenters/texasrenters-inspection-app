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
  });
});

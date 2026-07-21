import { buildRecordingDraft } from '../src/media/local-recordings';

describe('local recording metadata', () => {
  it('binds a captured video to exactly one inspection room and uses the real file size', () => {
    const draft = buildRecordingDraft({
      inspectionId: 'inspection-oak',
      roomId: 'room-oak-9',
      uri: 'file:///documents/inspection-recordings/inspection-oak/room-oak-9/video.mov',
      durationSeconds: 8.6,
      sizeBytes: 5 * 1024 * 1024,
    });

    expect(draft.inspectionId).toBe('inspection-oak');
    expect(draft.roomId).toBe('room-oak-9');
    expect(draft.durationSeconds).toBe(9);
    expect(draft.estimatedSizeMb).toBe(5);
    expect(draft.uri).toContain('/room-oak-9/');
  });

  it('keeps short recordings valid and estimates size when metadata is unavailable', () => {
    const draft = buildRecordingDraft({
      inspectionId: 'inspection-oak',
      roomId: 'room-oak-1',
      uri: 'blob:local-video',
      durationSeconds: 0,
    });

    expect(draft.durationSeconds).toBe(1);
    expect(draft.estimatedSizeMb).toBe(0.66);
  });
});

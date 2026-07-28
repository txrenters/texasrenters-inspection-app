import { buildRoomSnapshot } from '../src/media/local-snapshots';

describe('local room snapshot metadata', () => {
  it('binds a snapshot to exactly one inspection room', () => {
    const snapshot = buildRoomSnapshot({
      inspectionId: 'inspection-oak',
      roomId: 'room-oak-9',
      uri: 'file:///documents/inspection-snapshots/inspection-oak/room-oak-9/photo.jpg',
      width: 1920.4,
      height: 1080.2,
      sizeBytes: 2 * 1024 * 1024,
    });

    expect(snapshot.inspectionId).toBe('inspection-oak');
    expect(snapshot.roomId).toBe('room-oak-9');
    expect(snapshot.width).toBe(1920);
    expect(snapshot.height).toBe(1080);
    expect(snapshot.sizeBytes).toBe(2 * 1024 * 1024);
    expect(snapshot.uri).toContain('/room-oak-9/');
  });

  it('normalizes invalid dimensions and omits an unavailable size', () => {
    const snapshot = buildRoomSnapshot({
      inspectionId: 'inspection-oak',
      roomId: 'room-oak-1',
      uri: 'data:image/jpeg;base64,photo',
      width: 0,
      height: -1,
    });

    expect(snapshot.width).toBe(1);
    expect(snapshot.height).toBe(1);
    expect(snapshot.sizeBytes).toBeUndefined();
  });

  it('preserves capture-session provenance without changing room ownership', () => {
    const snapshot = buildRoomSnapshot({
      inspectionId: 'inspection-oak',
      roomId: 'room-oak-1',
      uri: 'file:///snapshot.jpg',
      width: 1280,
      height: 720,
      captureType: 'FINDING_CONTEXT',
      recordingSessionId: 'capture-session-1',
      videoTimestampMs: 12_000,
      captureSource: 'VIDEO_FRAME_EXTRACTION',
      sequenceNumber: 2,
      findingId: 'finding-1',
    });

    expect(snapshot.recordingSessionId).toBe('capture-session-1');
    expect(snapshot.videoTimestampMs).toBe(12_000);
    expect(snapshot.captureSource).toBe('VIDEO_FRAME_EXTRACTION');
    expect(snapshot.sequenceNumber).toBe(2);
    expect(snapshot.findingId).toBe('finding-1');
  });
});

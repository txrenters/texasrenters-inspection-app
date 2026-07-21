import {
  ApiMediaRepository,
  ApiUploadRepository,
} from '../src/repositories/api/repositories';
import { useDemoStore } from '../src/stores/demo.store';

describe('live-data local recording save', () => {
  beforeEach(() => useDemoStore.getState().resetDemoData());

  it('saves and queues a room video without waiting for a cloud provider', async () => {
    const mediaRepository = new ApiMediaRepository();
    const uploadRepository = new ApiUploadRepository();
    const media = await mediaRepository.save({
      inspectionId: 'inspection-live',
      roomId: 'room-live',
      propertyAddress: '100 Main St',
      roomName: 'Living room',
      uri: 'file:///documents/inspection-recordings/inspection-live/room-live/video.mp4',
      durationSeconds: 12,
      estimatedSizeMb: 4.2,
      note: 'Window wall documented',
    });
    const upload = await uploadRepository.enqueue(media);

    expect(media.id).toMatch(/^local-media-/);
    expect(upload.id).toMatch(/^local-upload-/);
    expect(upload.status).toBe('PENDING');
    expect(upload.roomName).toBe('Living room');
    expect(useDemoStore.getState().draftRecording).toBeNull();
    expect(useDemoStore.getState().media).toContainEqual(media);
    expect(useDemoStore.getState().uploads).toContainEqual(upload);
  });

  it('does not create duplicate queue entries for the same saved video', async () => {
    const mediaRepository = new ApiMediaRepository();
    const uploadRepository = new ApiUploadRepository();
    const media = await mediaRepository.save({
      inspectionId: 'inspection-live',
      roomId: 'room-live',
      uri: 'file:///video.mp4',
      durationSeconds: 5,
      estimatedSizeMb: 2,
      note: '',
    });

    const first = await uploadRepository.enqueue(media);
    const second = await uploadRepository.enqueue(media);

    expect(second.id).toBe(first.id);
    expect(
      useDemoStore.getState().uploads.filter((item) => item.mediaId === media.id),
    ).toHaveLength(1);
  });
});
